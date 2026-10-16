import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentEvent, PlanRequest, QlooClient, WeekPlan } from "../shared/types.ts";
import type { GeminiClient } from "../server/agent/gemini.ts";
import { createApp } from "../server/app.ts";
import { createPlansStore } from "../server/plans-store.ts";
import type { RunAgent } from "../server/routes/plan.ts";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "fondly-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const body: PlanRequest = {
  rosterId: "roster_abc123",
  homeCity: "Austin",
  residents: [
    { id: "r1", favorites: [{ kind: "music", text: "Patsy Cline" }] },
    { id: "r2", favorites: [{ kind: "film", text: "Casablanca" }] },
  ],
  slots: [{ id: "s1", day: "Mon", time: "afternoon", domain: "music" }],
};

const metrics = { reached: 1, total: 2, minBest: 0.5, meanBest: 0.75, meanTop2: 0.5 };
function makePlan(req: PlanRequest): WeekPlan {
  return {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    request: req,
    sessions: [
      {
        slotId: "s1",
        day: "Mon",
        time: "afternoon",
        domain: "music",
        entity: { entity_id: "A1", name: "Patsy Cline" },
        source: "favorite",
        related: [],
        attendees: ["r1", "r2"],
        matches: [
          { residentId: "r1", fit: 1, ownFavorite: true, why: "" },
          { residentId: "r2", fit: 0.9, ownFavorite: false, why: "" },
        ],
        meanFit: 0.9,
        title: "t",
        brief: "b",
      },
    ],
    residents: req.residents.map((r) => ({ residentId: r.id, scorable: true, reached: true, bestFit: 1, sessions: [], favorites: [], careNote: "", warnings: [] })),
    metrics,
    baselines: [],
    summary: "s",
    newsletter: "n",
    notes: [],
    qlooRequests: 3,
    optimizerRuns: 1,
  };
}

const seen: { req: PlanRequest; exclude?: Set<string>; locked?: Map<string, string> }[] = [];
const fakeRun: RunAgent = async (req, { emit, exclude, locked }) => {
  seen.push({ req, exclude, locked });
  emit({ kind: "status", message: "working" });
  return makePlan(req);
};

function app(overrides: Parameters<typeof createApp>[0] = {}) {
  return createApp({
    store: createPlansStore(dir),
    missingKeys: () => [],
    getQloo: () => ({}) as QlooClient,
    getGemini: () => ({}) as GeminiClient,
    runAgent: fakeRun,
    qlooConfigured: () => true,
    llmConfigured: () => true,
    model: "test-model",
    perHourLimit: 100,
    dailyCap: 100,
    maxConcurrent: 3,
    logRequests: false,
    serveStatic: false,
    ...overrides,
  });
}

function sseEvents(text: string): AgentEvent[] {
  return text
    .split("\n\n")
    .map((b) => b.split("\n").find((l) => l.startsWith("data:")))
    .filter((l): l is string => !!l)
    .map((l) => JSON.parse(l.slice(5)) as AgentEvent);
}

describe("api", () => {
  it("reports health booleans only", async () => {
    const res = await request(app()).get("/api/health");
    expect(res.body).toEqual({ ok: true, qloo: true, llm: true, model: "test-model" });
  });

  it("returns 503 when keys are missing (no demo fallback)", async () => {
    const res = await request(app({ missingKeys: () => ["QLOO_API_KEY"] })).post("/api/plan").send(body);
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/not configured/);
    // Config details stay in the server log, not the public response.
    expect(res.body.error).not.toContain("QLOO_API_KEY");
  });

  it("validates the request", async () => {
    const res = await request(app()).post("/api/plan").send({ ...body, residents: [{ id: "Mae", favorites: [] }] });
    expect(res.status).toBe(400);
  });

  it("streams a plan, saves it and serves it back", async () => {
    const res = await request(app()).post("/api/plan").send(body);
    expect(res.status).toBe(200);
    const events = sseEvents(res.text);
    const done = events.find((e) => e.kind === "done");
    expect(done && done.kind === "done" && done.plan.metrics.reached).toBe(1);
    const id = done && done.kind === "done" ? done.plan.id : "";
    const got = await request(app()).get(`/api/plans/${id}`);
    expect(got.status).toBe(200);
    expect(got.body.id).toBe(id);
  });

  it("re-plans next week with reactions and exclusions, and diffs the plans", async () => {
    const first = sseEvents((await request(app()).post("/api/plan").send(body)).text).find((e) => e.kind === "done");
    const id = first && first.kind === "done" ? first.plan.id : "";
    seen.length = 0;
    const res = await request(app())
      .post(`/api/plans/${id}/replan`)
      .send({ mode: "next_week", reactions: [{ slotId: "s1", residentId: "r2", reaction: "declined" }] });
    const done = sseEvents(res.text).find((e) => e.kind === "done");
    expect(done?.kind).toBe("done");
    expect(seen[0]!.exclude?.has("A1")).toBe(true);
    expect(seen[0]!.req.residents.find((r) => r.id === "r2")?.declined).toEqual(["A1"]);
    if (done?.kind === "done") {
      expect(done.plan.previousPlanId).toBe(id);
      expect(done.plan.diff?.edits[0]).toContain("declined Patsy Cline");
    }
  });

  it("edit mode keeps sessions that still match at least two residents", async () => {
    const first = sseEvents((await request(app()).post("/api/plan").send(body)).text).find((e) => e.kind === "done");
    const id = first && first.kind === "done" ? first.plan.id : "";
    seen.length = 0;
    await request(app()).post(`/api/plans/${id}/replan`).send({ mode: "edit" });
    expect(seen[0]!.locked?.get("s1")).toBe("A1");
    seen.length = 0;
    // After r2 declines, only one strong match remains: the slot is re-planned.
    await request(app())
      .post(`/api/plans/${id}/replan`)
      .send({ mode: "edit", reactions: [{ slotId: "s1", residentId: "r2", reaction: "declined" }] });
    expect(seen[0]!.locked?.has("s1")).toBe(false);
  });

  it("rejects a replacement roster from a different roster id", async () => {
    const first = sseEvents((await request(app()).post("/api/plan").send(body)).text).find((e) => e.kind === "done");
    const id = first && first.kind === "done" ? first.plan.id : "";
    const res = await request(app()).post(`/api/plans/${id}/replan`).send({ mode: "edit", request: { ...body, rosterId: "other_roster1" } });
    expect(res.status).toBe(400);
  });

  it("enforces the daily cap", async () => {
    const a = app({ dailyCap: 1 });
    await request(a).post("/api/plan").send(body);
    const res = await request(a).post("/api/plan").send(body);
    expect(res.status).toBe(429);
  });

  it("caps intake calls per day, separately from plans", async () => {
    // dailyCap 1 -> intake cap 10. The stub Gemini client fails, which is fine: the cap is checked first.
    const a = app({ dailyCap: 1 });
    for (let i = 0; i < 10; i++) {
      const r = await request(a).post("/api/intake").send({ notes: "loves Sinatra" });
      expect(r.status).not.toBe(429);
    }
    const res = await request(a).post("/api/intake").send({ notes: "loves Sinatra" });
    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/daily limit/);
  });

  it("returns a friendly error event when the agent fails", async () => {
    const res = await request(app({ runAgent: async () => { throw Object.assign(new Error("secret Bearer abc"), { status: 429, name: "ApiError" }); } }))
      .post("/api/plan")
      .send(body);
    const err = sseEvents(res.text).find((e) => e.kind === "error");
    expect(err && err.kind === "error" && err.message).toMatch(/rate limited/);
    expect(res.text).not.toContain("Bearer");
  });

  it("rejects bad plan ids and unknown api routes", async () => {
    expect((await request(app()).get("/api/plans/../../etc")).status).toBe(404);
    expect((await request(app()).get("/api/plans/not-a-uuid")).status).toBe(400);
    expect((await request(app()).get("/api/nope")).status).toBe(404);
  });
});
