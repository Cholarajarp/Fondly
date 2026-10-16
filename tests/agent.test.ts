// Agent and pipeline tests with in-memory fakes. Fakes exist only in tests; the app has no mock mode.
import { describe, expect, it, vi } from "vitest";
import type { AgentEvent, PlanRequest, QlooClient, QlooEntity } from "../shared/types.ts";
import { PlanRequestSchema, runFondlyAgent, type GeminiClient } from "../server/agent/run.ts";
import { applyEdits } from "../server/agent/structured.ts";
import { createState, resolveResidents } from "../server/engine/pipeline.ts";
import { MAX_REVISIONS, createToolCtx, executeTool, type ToolCtx } from "../server/agent/tools.ts";
import { Tracer } from "../server/engine/trace.ts";

// A tiny "taste world": three music clusters, two film clusters.
const ARTISTS: Record<string, QlooEntity> = {
  cline: { entity_id: "A-cline", name: "Patsy Cline" },
  cash: { entity_id: "A-cash", name: "Johnny Cash" },
  sinatra: { entity_id: "A-sinatra", name: "Frank Sinatra" },
  bennett: { entity_id: "A-bennett", name: "Tony Bennett" },
  beatles: { entity_id: "A-beatles", name: "The Beatles" },
  kinks: { entity_id: "A-kinks", name: "The Kinks" },
  lynn: { entity_id: "A-lynn", name: "Loretta Lynn" },
  crosby: { entity_id: "A-crosby", name: "Bing Crosby" },
};
const FILMS: Record<string, QlooEntity> = {
  casablanca: { entity_id: "M-casa", name: "Casablanca" },
  singin: { entity_id: "M-singin", name: "Singin' in the Rain" },
  bullitt: { entity_id: "M-bullitt", name: "Bullitt" },
  greatescape: { entity_id: "M-escape", name: "The Great Escape" },
};
const CLUSTER: Record<string, string> = {
  "A-cline": "country", "A-cash": "country", "A-lynn": "country",
  "A-sinatra": "crooner", "A-bennett": "crooner", "A-crosby": "crooner",
  "A-beatles": "rock", "A-kinks": "rock",
  "M-casa": "classic", "M-singin": "classic", "M-bullitt": "action", "M-escape": "action",
};
const byName = new Map([...Object.values(ARTISTS), ...Object.values(FILMS)].map((e) => [e.name.toLowerCase(), e]));

function fakeQloo(): QlooClient & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  const pool = (type: unknown) => (type === "urn:entity:movie" ? Object.values(FILMS) : Object.values(ARTISTS));
  return {
    calls,
    async searchEntities(query) {
      calls.push({ search: query });
      const e = byName.get(query.toLowerCase());
      return e ? [e] : [];
    },
    async searchTags(query) {
      calls.push({ tags: query });
      return query.toLowerCase().includes("italian") ? [{ id: "urn:tag:genre:place:restaurant:italian", name: "Italian", type: "urn:tag:genre:place" }] : [];
    },
    async insights(params) {
      calls.push(params);
      const type = params["filter.type"];
      if (type === "urn:entity:place") {
        const places = [
          { entity_id: "P1", name: "Luigi's", affinity: 0.9 },
          { entity_id: "P2", name: "Garden Cafe", affinity: 0.6 },
        ];
        const only = params["filter.results.entities"];
        return only ? places.filter((p) => String(only).split(",").includes(p.entity_id)) : places;
      }
      const signals = String(params["signal.interests.entities"] ?? "").split(",").filter(Boolean);
      const sigClusters = new Set(signals.map((s) => CLUSTER[s]));
      const only = params["filter.results.entities"] ? new Set(String(params["filter.results.entities"]).split(",")) : null;
      const exclude = new Set(String(params["filter.exclude.entities"] ?? "").split(","));
      const list = pool(type)
        .filter((e) => (!only || only.has(e.entity_id)) && !exclude.has(e.entity_id))
        .map((e) => ({
          ...e,
          affinity: params["signal.demographics.age"] ? 0.5 : sigClusters.has(CLUSTER[e.entity_id]) ? 0.9 : 0.2 + (e.entity_id.length % 5) / 100,
          explainability: signals.filter((s) => CLUSTER[s] === CLUSTER[e.entity_id]).map((s) => ({ entity_id: s, score: 0.8 })),
        }))
        .sort((a, b) => b.affinity - a.affinity);
      // The 55+ baseline is crooner-heavy and ignores the residents.
      if (params["signal.demographics.age"]) return [ARTISTS.crosby!, ARTISTS.bennett!, ARTISTS.sinatra!, FILMS.singin!, FILMS.casablanca!].filter((e) => pool(type).includes(e));
      return list.slice(0, Number(params.take ?? 20));
    },
    async heatmap() {
      return [];
    },
    async demographics() {
      return [];
    },
    callCount: () => calls.length,
  };
}

let fcId = 0;
// Every agent tool requires a reason; tests supply a default unless they pass their own.
const call = (name: string, args: Record<string, unknown> = {}) => ({ functionCall: { id: `fc${++fcId}`, name, args: { reason: `testing ${name}`, ...args } } });
const selfEval = (reached: number, min_fit?: number) => ({ reached, ...(min_fit !== undefined ? { min_fit } : {}), tried: "nothing extra", remaining: "nothing" });
const turn = (parts: unknown[], finishReason = "STOP") => ({ candidates: [{ content: { role: "model", parts }, finishReason }] });
const jsonText = (obj: unknown) => ({ text: JSON.stringify(obj), candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify(obj) }] }, finishReason: "STOP" }] });

/** Fake Gemini: the agent loop gets scripted turns; structured (JSON) calls get `json`. */
function fakeGemini(script: unknown[], json: unknown = { sessions: [] }) {
  const turns = [...script];
  const generateContent = vi.fn(async (body: { config?: Record<string, unknown> }) => {
    if (body.config?.responseMimeType === "application/json") return jsonText(json);
    const next = turns.shift();
    if (!next) return turn([{ text: "done" }]);
    if (next instanceof Error) throw next;
    return next;
  });
  return { gemini: { models: { generateContent } } as unknown as GeminiClient, generateContent };
}

const REQUEST: PlanRequest = {
  rosterId: "roster_test1",
  homeCity: "Springfield",
  residents: [
    { id: "r1", favorites: [{ kind: "music", text: "Patsy Cline" }, { kind: "film", text: "Casablanca" }] },
    { id: "r2", favorites: [{ kind: "music", text: "Johnny Cash" }] },
    { id: "r3", favorites: [{ kind: "music", text: "Frank Sinatra" }] },
    { id: "r4", favorites: [{ kind: "music", text: "The Beatles" }, { kind: "film", text: "Bullitt" }], unavailableDays: ["Tue"] },
    { id: "r5", favorites: [{ kind: "music", text: "Nobody Real" }] },
  ],
  slots: [
    { id: "s1", day: "Mon", time: "afternoon", domain: "music" },
    { id: "s2", day: "Tue", time: "afternoon", domain: "music" },
    { id: "s3", day: "Wed", time: "afternoon", domain: "film" },
    { id: "s4", day: "Thu", time: "morning", domain: "music" },
  ],
};

const collect = () => {
  const events: AgentEvent[] = [];
  return { events, emit: (e: AgentEvent) => events.push(e) };
};

describe("runFondlyAgent", () => {
  it("runs the tool plan and returns a plan built only from Qloo data", async () => {
    const qloo = fakeQloo();
    const { gemini } = fakeGemini(
      [
        turn([call("resolve_favorites")]),
        turn([call("build_candidates")]),
        turn([call("score_residents")]),
        turn([call("build_baseline")]),
        turn([call("optimize")]),
        turn([
          call("record_sessions", {
            sessions: ["s1", "s2", "s3", "s4"].map((id) => ({ slot_id: id, title: id === "s1" ? "Country hour: Patsy Cline" : "Session", brief: "Play some country." })),
          }),
        ]),
        turn([call("finish", { summary: "Everyone is reached.", newsletter: "A lovely week.", self_evaluation: selfEval(4) })]),
      ],
      { sessions: [{ slot_id: "s1", title: "Bing Crosby" }, { slot_id: "s3", title: "Singin' in the Rain" }] },
    );
    const { events, emit } = collect();
    const plan = await runFondlyAgent(REQUEST, { qloo, gemini, emit });

    // r5's favorite did not resolve -> unscorable, excluded from metrics.
    expect(plan.metrics.total).toBe(4);
    expect(plan.residents.find((r) => r.residentId === "r5")?.scorable).toBe(false);
    // Every scheduled entity came from Qloo.
    const known = new Set([...Object.values(ARTISTS), ...Object.values(FILMS)].map((e) => e.entity_id));
    for (const s of plan.sessions) expect(known.has(s.entity.entity_id)).toBe(true);
    // Max-min: each music cluster gets a session, so all four scorable residents are reached.
    expect(plan.metrics.reached).toBe(4);
    // r4 cannot attend Tuesday.
    expect(plan.sessions.find((s) => s.slotId === "s2")?.attendees).not.toContain("r4");
    // Baselines are measured with the same metric.
    const pop = plan.baselines.find((b) => b.key === "popular_55");
    expect(pop?.available).toBe(true);
    expect(pop!.metrics!.reached).toBeLessThan(plan.metrics.reached);
    expect(plan.baselines.find((b) => b.key === "llm_only")?.metrics).toBeDefined();
    // Agent text is used where valid.
    expect(plan.sessions.find((s) => s.slotId === "s1")?.title).toBe("Country hour: Patsy Cline");
    expect(plan.summary).toBe("Everyone is reached.");
    // Discovery reach excludes residents' own favorites, so it can never exceed overall reach.
    expect(plan.metrics.discoveryReached).toBeTypeOf("number");
    expect(plan.metrics.discoveryReached!).toBeLessThanOrEqual(plan.metrics.reached);
    for (const b of plan.baselines.filter((x) => x.metrics)) {
      expect(b.metrics!.discoveryReached!).toBeLessThanOrEqual(b.metrics!.reached);
    }
    // Privacy: Qloo never received resident ids.
    expect(JSON.stringify(qloo.calls)).not.toMatch(/\br[1-5]\b/);
    expect(events.some((e) => e.kind === "progress")).toBe(true);
  });

  it("finishes the plan from Qloo data when the model fails", async () => {
    const qloo = fakeQloo();
    const err = Object.assign(new Error("boom"), { status: 400 });
    const { gemini } = fakeGemini([err]);
    const plan = await runFondlyAgent(REQUEST, { qloo, gemini, emit: () => {} });
    expect(plan.sessions.length).toBe(4);
    expect(plan.metrics.reached).toBeGreaterThan(0);
    expect(plan.summary).toContain("residents");
  });

  it("rejects record_sessions for unknown slots and requires step order", async () => {
    const qloo = fakeQloo();
    const { gemini, generateContent } = fakeGemini([
      turn([call("optimize")]),
      turn([call("resolve_favorites"), call("build_candidates"), call("score_residents"), call("optimize")]),
      turn([call("record_sessions", { sessions: [{ slot_id: "s99", title: "x", brief: "y" }] })]),
      turn([call("finish", { summary: "s", newsletter: "n", self_evaluation: selfEval(0) })]),
    ]);
    await runFondlyAgent(REQUEST, { qloo, gemini, emit: () => {} });
    const agentCalls = generateContent.mock.calls.map((c) => c[0] as { contents?: { parts?: { functionResponse?: { response?: { error?: string } } }[] }[] });
    const errors = agentCalls.flatMap((b) => b.contents ?? []).flatMap((c) => c.parts ?? []).map((p) => p.functionResponse?.response?.error).filter(Boolean);
    expect(errors.some((e) => /Call score_residents first, then retry optimize/.test(e!))).toBe(true);
    expect(errors.some((e) => /s99/.test(e!))).toBe(true);
  });

  it("excludes last week's titles in next-week mode and treats loved items as favorites", async () => {
    const qloo = fakeQloo();
    const { gemini } = fakeGemini([]);
    const req: PlanRequest = {
      ...REQUEST,
      residents: REQUEST.residents.map((r) => (r.id === "r3" ? { ...r, declined: ["A-bennett"] } : r)),
    };
    const plan = await runFondlyAgent(req, { qloo, gemini, emit: () => {}, exclude: new Set(["A-cline", "A-sinatra"]) });
    const ids = plan.sessions.map((s) => s.entity.entity_id);
    expect(ids).not.toContain("A-cline");
    expect(ids).not.toContain("A-sinatra");
    const r3 = plan.residents.find((r) => r.residentId === "r3")!;
    const bennett = plan.sessions.find((s) => s.entity.entity_id === "A-bennett");
    if (bennett) expect(bennett.matches.map((m) => m.residentId)).not.toContain("r3");
    expect(r3.scorable).toBe(true);
  });

  it("uses a loved title from last week as a taste signal even when it is not a typed favorite", async () => {
    const req: PlanRequest = {
      ...REQUEST,
      residents: REQUEST.residents.map((r) => (r.id === "r2" ? { ...r, loved: ["M-singin"] } : r)),
    };
    const state = createState(req, {
      known: [{ entity: { ...FILMS.singin, type: "urn:entity:movie" }, domain: "film", source: "expanded" }],
    });
    await resolveResidents(state, fakeQloo(), new Tracer(() => {}));
    expect(state.residents.get("r2")!.signals.get("film")).toContain("M-singin");
    expect(state.candidates.get("M-singin")?.ownedBy.has("r2")).toBe(true);
  });
});

describe("request validation and edits", () => {
  it("rejects names in resident ids and duplicate slots", () => {
    expect(PlanRequestSchema.safeParse({ ...REQUEST, residents: [{ id: "Mae Smith", favorites: [] }, ...REQUEST.residents] }).success).toBe(false);
    expect(PlanRequestSchema.safeParse({ ...REQUEST, slots: [...REQUEST.slots, { id: "s9", day: "Mon", time: "afternoon", domain: "film" }] }).success).toBe(false);
    expect(PlanRequestSchema.safeParse(REQUEST).success).toBe(true);
  });

  it("applies structured edits", () => {
    const { request, log } = applyEdits(REQUEST, [
      { action: "add_resident", resident_id: "r9", favorites: [{ kind: "music", text: "Loretta Lynn" }] },
      { action: "set_unavailable", resident_id: "r1", favorites: [], days: ["Mon"], times: ["evening"] },
      { action: "opt_out", resident_id: "r2", favorites: [], session_types: ["film"] },
      { action: "add_favorites", resident_id: "r77", favorites: [{ kind: "film", text: "Bullitt" }] },
    ]);
    expect(request.residents.find((r) => r.id === "r9")?.favorites[0]?.text).toBe("Loretta Lynn");
    expect(request.residents.find((r) => r.id === "r1")?.unavailableDays).toEqual(["Mon"]);
    expect(request.residents.find((r) => r.id === "r2")?.optOut).toEqual(["film"]);
    expect(log.some((l) => l.includes("unknown resident r77"))).toBe(true);
    // Original untouched.
    expect(REQUEST.residents.length).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Agent tools: prerequisites, self-critique, revisions, finish gating, accounting
// ---------------------------------------------------------------------------

const R = (reason = "test") => ({ reason });
function toolCtx(req: PlanRequest = REQUEST, opts: { locked?: Map<string, string> } = {}): ToolCtx {
  const state = createState(req, opts);
  return createToolCtx({ qloo: fakeQloo(), state, tracer: new Tracer(() => {}), onMetrics: () => {} });
}
async function optimized(ctx: ToolCtx) {
  for (const t of ["resolve_favorites", "build_candidates", "score_residents", "build_baseline", "optimize"]) {
    const out = await executeTool(t, R(), ctx);
    expect(out.isError, `${t}: ${out.content}`).toBe(false);
  }
  return ctx;
}
const pickOf = (ctx: ToolCtx, slot: string) => ctx.state.assignment!.get(slot)!;
const allSessions = ["s1", "s2", "s3", "s4"].map((id) => ({ slot_id: id, title: "x", brief: "y" }));

describe("agent tools", () => {
  it("rejects calls made before their prerequisites, naming what to run first", async () => {
    const ctx = toolCtx();
    const early = await executeTool("build_candidates", R(), ctx);
    expect(early.isError).toBe(true);
    expect(early.content).toMatch(/Call resolve_favorites first, then retry build_candidates/);
    expect((await executeTool("inspect_plan", R(), ctx)).content).toMatch(/Call optimize first/);
    expect((await executeTool("revise_plan", { ...R(), exclude: [{ candidate_id: "A-cline" }] }, ctx)).content).toMatch(/Call optimize first/);
    expect((await executeTool("finish", { ...R(), summary: "s", newsletter: "n", self_evaluation: selfEval(0) }, ctx)).content).toMatch(/Call record_sessions first/);
    // A reason is required on every tool, and pool sizes are bounded.
    expect((await executeTool("resolve_favorites", {}, ctx)).content).toMatch(/Invalid input/);
    await executeTool("resolve_favorites", R(), ctx);
    expect((await executeTool("build_candidates", { ...R(), pool_size: 500 }, ctx)).isError).toBe(true);
    expect(ctx.state.fetched.size).toBe(0);
  });

  it("lets the agent choose session types and pool size for build_candidates", async () => {
    const ctx = toolCtx();
    await executeTool("resolve_favorites", R(), ctx);
    const qloo = ctx.qloo as ReturnType<typeof fakeQloo>;
    const out = await executeTool("build_candidates", { ...R(), session_types: ["music"], pool_size: 5 }, ctx);
    expect(out.isError).toBe(false);
    expect(JSON.parse(out.content).unfetched_types).toEqual(["film"]);
    const rec = qloo.calls.filter((c) => c["filter.type"] === "urn:entity:artist");
    expect(rec.at(-1)?.take).toBe(5);
    expect(qloo.calls.some((c) => c["filter.type"] === "urn:entity:movie")).toBe(false);
    // Asking again at the same size is skipped; the remaining type can be fetched later.
    const n = qloo.calls.length;
    await executeTool("build_candidates", { ...R(), session_types: ["music"], pool_size: 5 }, ctx);
    expect(qloo.calls.length).toBe(n);
    await executeTool("build_candidates", { ...R(), session_types: ["film"] }, ctx);
    expect(ctx.state.fetched.has("film")).toBe(true);
  });

  it("inspect_plan reports per-resident fits, weakest residents, slots, duplicates and baselines", async () => {
    const ctx = await optimized(toolCtx());
    // Rename two scheduled music picks so they read as near-duplicates.
    ctx.state.names.set(pickOf(ctx, "s1"), "The Greatest Hits");
    ctx.state.names.set(pickOf(ctx, "s2"), "Greatest Hits (Live)");
    const out = await executeTool("inspect_plan", R(), ctx);
    expect(out.isError).toBe(false);
    const d = JSON.parse(out.content);
    expect(Object.keys(d.resident_best_fit).sort()).toEqual(["r1", "r2", "r3", "r4"]);
    const fits = d.weakest.map((w: { best_fit: number }) => w.best_fit);
    expect(fits).toEqual([...fits].sort((a: number, b: number) => a - b));
    expect(d.slots.map((x: { slot: string }) => x.slot)).toEqual(["s1", "s2", "s3", "s4"]);
    expect(d.slots.every((x: { candidate_id: string | null }) => x.candidate_id)).toBe(true);
    expect(d.near_duplicates).toContainEqual(["s1", "s2"]);
    expect(d.baselines.find((b: { key: string }) => b.key === "popular_55")).toBeDefined();
    expect(d.budget).toEqual({ expansions_left: 4, revisions_left: 4 });
  });

  it("revise_plan excludes and pins pool candidates while keeping availability, types and locks", async () => {
    const ctx = await optimized(toolCtx(REQUEST, { locked: new Map([["s4", "A-kinks"]]) }));
    const runs = ctx.state.optimizerRuns;
    const s1 = pickOf(ctx, "s1");
    // Exclude from the whole week.
    const ex = await executeTool("revise_plan", { ...R(), exclude: [{ candidate_id: s1 }] }, ctx);
    expect(ex.isError, ex.content).toBe(false);
    expect([...ctx.state.assignment!.values()]).not.toContain(s1);
    expect(ctx.state.optimizerRuns).toBe(runs + 1);
    expect(JSON.parse(ex.content)).toHaveProperty("after.reached");
    // Pin an unused music candidate to the Tuesday slot; r4 still cannot attend Tuesday.
    const used = new Set(ctx.state.assignment!.values());
    const free = [...ctx.state.candidates.values()].find((c) => c.domain === "music" && !used.has(c.entity.entity_id) && c.entity.entity_id !== s1)!;
    const pin = await executeTool("revise_plan", { ...R(), pin: [{ slot_id: "s2", candidate_id: free.entity.entity_id }] }, ctx);
    expect(pin.isError, pin.content).toBe(false);
    expect(pickOf(ctx, "s2")).toBe(free.entity.entity_id);
    expect(ctx.state.slots.find((x) => x.id === "s2")!.attendees).not.toContain("r4");
    // Invalid revisions change nothing: wrong type, unknown entity, excluded candidate, coordinator lock.
    const before = new Map(ctx.state.assignment!);
    for (const bad of [
      { pin: [{ slot_id: "s3", candidate_id: "A-cash" }] },
      { pin: [{ slot_id: "s1", candidate_id: "A-invented" }] },
      { pin: [{ slot_id: "s1", candidate_id: s1 }] },
      { pin: [{ slot_id: "s4", candidate_id: "A-cash" }] },
      { exclude: [{ candidate_id: "A-kinks" }] },
    ]) {
      const out = await executeTool("revise_plan", { ...R(), ...bad }, ctx);
      expect(out.isError, JSON.stringify(bad)).toBe(true);
      expect(out.content).toMatch(/nothing changed/);
    }
    expect(ctx.state.assignment).toEqual(before);
    expect(pickOf(ctx, "s4")).toBe("A-kinks");
    // Budget: at most MAX_REVISIONS successful revisions.
    for (let i = ctx.revisions; i < MAX_REVISIONS; i++) await executeTool("revise_plan", { ...R(), unpin: ["s2"] }, ctx);
    expect((await executeTool("revise_plan", { ...R(), unpin: ["s2"] }, ctx)).content).toMatch(/budget used/);
  });

  it("keeps the current picks on re-optimizing when nothing improves (so written briefs survive)", async () => {
    const ctx = await optimized(toolCtx());
    const before = new Map(ctx.state.assignment!);
    for (let i = 0; i < 3; i++) await executeTool("optimize", R(), ctx);
    expect(ctx.state.assignment).toEqual(before);
  });

  it("refuses finish once while things are improvable, then accepts it", async () => {
    const ctx = await optimized(toolCtx());
    await executeTool("record_sessions", { ...R(), sessions: [{ slot_id: "s1", title: "Music hour", brief: "Play it." }] }, ctx);
    const m = ctx.state.metrics!;
    const args = { ...R(), summary: "s", newsletter: "n", self_evaluation: selfEval(m.reached + 1) };
    const first = await executeTool("finish", args, ctx);
    expect(first.isError).toBe(true);
    expect(first.content).toMatch(/does not match the last optimizer result/);
    expect(first.content).toMatch(/s2/);
    expect(ctx.finished).toBe(false);
    const second = await executeTool("finish", args, ctx);
    expect(second.isError).toBe(false);
    expect(ctx.finished).toBe(true);
    expect(ctx.selfEvaluation?.tried).toBe("nothing extra");
  });

  it("does not gate finish when the plan is complete or the run is wrapping up", async () => {
    const ctx = await optimized(toolCtx());
    await executeTool("record_sessions", { ...R(), sessions: allSessions }, ctx);
    const m = ctx.state.metrics!;
    expect((await executeTool("finish", { ...R(), summary: "s", newsletter: "n", self_evaluation: selfEval(m.reached, m.minBest) }, ctx)).isError).toBe(false);
    const late = await optimized(toolCtx());
    await executeTool("record_sessions", { ...R(), sessions: [{ slot_id: "s1", title: "x", brief: "y" }] }, late);
    late.wrapUp = true;
    expect((await executeTool("finish", { ...R(), summary: "s", newsletter: "n", self_evaluation: selfEval(99) }, late)).isError).toBe(false);
  });

  it("sends a clipped, cleaned reason with each tool_call event and accounts for agent-only runs", async () => {
    const long = "Because\u0007 " + "x".repeat(400);
    const { gemini } = fakeGemini([
      turn([call("resolve_favorites", { reason: long })]),
      turn([call("build_candidates", { reason: "Fetch both pools", pool_size: 10 })]),
      turn([call("score_residents"), call("build_baseline")]),
      turn([call("optimize")]),
      turn([call("inspect_plan")]),
      turn([call("record_sessions", { sessions: allSessions })]),
      turn([call("finish", { summary: "s", newsletter: "n", self_evaluation: selfEval(4) })]),
    ]);
    const { events, emit } = collect();
    const plan = await runFondlyAgent(REQUEST, { qloo: fakeQloo(), gemini, emit });
    const calls = events.filter((e): e is Extract<AgentEvent, { kind: "tool_call" }> => e.kind === "tool_call");
    const first = calls.find((c) => c.tool === "resolve_favorites")!;
    expect(first.reason!.length).toBeLessThanOrEqual(200);
    // eslint-disable-next-line no-control-regex
    expect(first.reason).not.toMatch(/[\u0000-\u001f]/);
    expect(first.reason!.startsWith("Because x")).toBe(true);
    expect(first.input).not.toHaveProperty("reason");
    expect(calls.find((c) => c.tool === "build_candidates")).toMatchObject({ reason: "Fetch both pools", input: { pool_size: 10 } });
    // Code-driven Qloo calls carry no agent reason.
    expect(calls.filter((c) => c.tool === "get_recommendations").every((c) => c.reason === undefined)).toBe(true);
    expect(plan.agentRun?.steps, JSON.stringify(plan.agentRun)).toSatisfy((st: { by: string }[]) => st.every((s) => s.by === "agent"));
    expect(plan.agentRun?.steps.map((s) => s.step)).toContain("finish");
    expect(plan.agentRun?.toolCalls).toBe(8);
    expect(plan.agentRun?.selfEvaluation?.remaining).toBe("nothing");
  });

  it("records which steps the safety net filled in", async () => {
    // The agent fetches only music, then stops calling tools.
    const { gemini } = fakeGemini([turn([call("resolve_favorites")]), turn([call("build_candidates", { session_types: ["music"] })])]);
    const plan = await runFondlyAgent(REQUEST, { qloo: fakeQloo(), gemini, emit: () => {} });
    const by = Object.fromEntries(plan.agentRun!.steps.map((s) => [s.step, s.by]));
    expect(by.resolve_favorites).toBe("agent");
    expect(by.build_candidates).toBe("both");
    expect(by.optimize).toBe("safety_net");
    expect(by.finish).toBe("safety_net");
    expect(plan.sessions.some((s) => s.domain === "film")).toBe(true);
    expect(plan.agentRun!.selfEvaluation).toBeUndefined();

    const err = Object.assign(new Error("boom"), { status: 400 });
    const failed = await runFondlyAgent(REQUEST, { qloo: fakeQloo(), gemini: fakeGemini([err]).gemini, emit: () => {} });
    expect(failed.agentRun!.toolCalls).toBe(0);
    expect(failed.agentRun!.steps.every((s) => s.by === "safety_net")).toBe(true);
  });
});
