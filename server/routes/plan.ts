// SECURITY NOTE: these endpoints are intentionally public. Hackathon judges must be able to use
// the app without logging in. Abuse is bounded by the per-IP hourly rate limit, the concurrent-run
// cap and the global daily cap, which together protect the Qloo quota and LLM spend.
// No resident names reach the server: the browser sends only aliases (r1, r2…).

import { Router, type Request, type Response, type NextFunction } from "express";
import { rateLimit } from "express-rate-limit";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  QlooError,
  type AgentEvent,
  type PlanDiff,
  type PlanRequest,
  type QlooClient,
  type ReplanRequest,
  type WeekPlan,
} from "../../shared/types.ts";
import { AgentError, PlanRequestSchema, runFondlyAgent as defaultRun, type GeminiClient, type RunDeps } from "../agent/run.ts";
import { applyEdits, parseInstruction, parseIntake } from "../agent/structured.ts";
import { isValidPlanId, type PlansStore } from "../plans-store.ts";

export type RunAgent = (req: PlanRequest, deps: RunDeps) => Promise<WeekPlan>;

export interface PlanRouteDeps {
  store: PlansStore;
  missingKeys: () => string[];
  getQloo: () => QlooClient;
  getGemini: () => GeminiClient;
  runAgent?: RunAgent;
  perHourLimit: number;
  dailyCap: number;
  maxConcurrent: number;
  heartbeatMs?: number;
}

function createDailyCounter(cap: number) {
  let day = "";
  let count = 0;
  return {
    tryTake(): boolean {
      const d = new Date().toISOString().slice(0, 10);
      if (d !== day) {
        day = d;
        count = 0;
      }
      if (count >= cap) return false;
      count++;
      return true;
    },
  };
}

const statusOf = (err: unknown) => {
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === "number" ? s : undefined;
};

/** User-safe error text. Never includes keys, stacks or raw upstream bodies. */
export function friendlyError(err: unknown): string {
  if (err instanceof AgentError) {
    const m = err.message;
    if (/key|token|Bearer|\n\s+at /i.test(m) && !/GEMINI_API_KEY/.test(m)) return "Something went wrong while building the plan. Please try again.";
    return m.length > 400 ? `${m.slice(0, 400)}…` : m;
  }
  if (err instanceof QlooError) {
    if (err.status === 401 || err.status === 403) return "The Qloo API rejected the server's credentials. Please contact the site owner.";
    if (err.status === 429) return "The Qloo API rate limit was reached. Please try again in a minute.";
    if (err.status === 0) return "Could not reach the Qloo API. Please try again.";
    if (err.status >= 500) return "The Qloo API is having trouble right now. Please try again shortly.";
    return "A Qloo API request failed. Please check the favorites and try again.";
  }
  const status = statusOf(err);
  const isLlm = (err as { name?: unknown } | null)?.name === "ApiError";
  if (isLlm || status !== undefined) {
    if (status === 401 || status === 403) return "The language model rejected the server's credentials. Please contact the site owner.";
    if (status === 429) return "The language model is rate limited right now. Please try again in a minute.";
    if (status !== undefined && status >= 500) return "The language model is overloaded right now. Please try again shortly.";
    return "The language model request failed. Please try again.";
  }
  return "Something went wrong while building the plan. Please try again.";
}

const ReplanSchema = z
  .object({
    mode: z.enum(["edit", "next_week"]),
    instruction: z.string().trim().max(1000).optional(),
    reactions: z
      .array(
        z
          .object({
            slotId: z.string().regex(/^s\d{1,3}$/),
            residentId: z.string().regex(/^r\d{1,3}$/),
            reaction: z.enum(["loved", "declined"]),
          })
          .strict(),
      )
      // 21 slots x 60 residents: every cell of the reaction table.
      .max(21 * 60)
      .optional(),
    request: z.unknown().optional(),
  })
  .strict();

const IntakeSchema = z.object({ notes: z.string().trim().min(3).max(2000) }).strict();

export function createPlanRouter(deps: PlanRouteDeps): Router {
  const router = Router();
  const run = deps.runAgent ?? defaultRun;
  const heartbeatMs = deps.heartbeatMs ?? 15_000;
  const daily = createDailyCounter(deps.dailyCap);
  // Intake is one small LLM call; cap it separately so it cannot drain the daily LLM budget.
  const dailyIntake = createDailyCounter(deps.dailyCap * 10);
  let running = 0;

  const limiter = (limit: number) =>
    rateLimit({
      windowMs: 60 * 60 * 1000,
      limit,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      handler: (_req, res) => {
        res.status(429).json({ error: "You've hit the hourly limit for this demo. Please try again later." });
      },
    });
  const planLimiter = limiter(deps.perHourLimit);
  const intakeLimiter = limiter(deps.perHourLimit * 5);
  // Reads are cheap (disk only) but still bounded, so plan ids cannot be scanned quickly.
  const readLimiter = limiter(Math.max(120, deps.perHourLimit * 30));

  const requireConfig = (_req: Request, res: Response, next: NextFunction) => {
    const missing = deps.missingKeys();
    if (missing.length > 0) {
      console.warn(`[plan] missing configuration: ${missing.join(", ")}`);
      res.status(503).json({ error: "The planner is not configured on this server yet." });
      return;
    }
    next();
  };

  const capacity = (_req: Request, res: Response, next: NextFunction) => {
    if (running >= deps.maxConcurrent) {
      res.status(503).json({ error: "The planner is busy, try again in a minute." });
      return;
    }
    if (!daily.tryTake()) {
      res.status(429).json({ error: "The demo has reached its daily plan limit. Please try again tomorrow." });
      return;
    }
    next();
  };

  const badRequest = (res: Response, error: z.ZodError) =>
    res.status(400).json({
      error: "Invalid request",
      issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });

  /** Streams an agent run as SSE and saves the plan. */
  async function stream(
    res: Response,
    initial: PlanRequest,
    extra: Pick<RunDeps, "exclude" | "locked" | "known">,
    /** Runs inside the stream before the agent; may return a modified request. */
    prelude: (emit: (e: AgentEvent) => void, request: PlanRequest) => Promise<PlanRequest>,
    decorate: (plan: WeekPlan) => void,
  ) {
    running++;
    const controller = new AbortController();
    let closed = false;
    res.on("close", () => {
      closed = true;
      if (!res.writableFinished) controller.abort();
    });
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    const write = (chunk: string) => {
      if (!closed && !res.writableEnded) res.write(chunk);
    };
    const emit = (e: AgentEvent) => write(`data: ${JSON.stringify(e)}\n\n`);
    const agentEmit = (e: AgentEvent) => {
      if (e.kind !== "done" && e.kind !== "error") emit(e);
    };
    const heartbeat = setInterval(() => write(": ping\n\n"), heartbeatMs);
    try {
      const request = await prelude(agentEmit, initial);
      const plan = await run(request, {
        qloo: deps.getQloo(),
        gemini: deps.getGemini(),
        emit: agentEmit,
        signal: controller.signal,
        ...extra,
      });
      if (controller.signal.aborted) return;
      if (!isValidPlanId(plan.id)) plan.id = randomUUID();
      decorate(plan);
      await deps.store.savePlan(plan);
      emit({ kind: "done", plan });
    } catch (err) {
      if (!controller.signal.aborted) {
        console.error(`[plan] failed: ${(err as Error)?.name ?? "Error"} status=${statusOf(err) ?? "-"}`);
        emit({ kind: "error", message: friendlyError(err) });
      }
    } finally {
      clearInterval(heartbeat);
      running--;
      if (!res.writableEnded) res.end();
    }
  }

  router.post("/plan", requireConfig, planLimiter, (req, res) => {
    const parsed = PlanRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      badRequest(res, parsed.error);
      return;
    }
    capacity(req, res, () => {
      void stream(res, parsed.data as PlanRequest, {}, async (_e, r) => r, () => {});
    });
  });

  router.post("/plans/:id/replan", requireConfig, planLimiter, async (req, res, next) => {
    try {
      const { id } = req.params;
      if (!isValidPlanId(id)) {
        res.status(400).json({ error: "Invalid plan id" });
        return;
      }
      const body = ReplanSchema.safeParse(req.body);
      if (!body.success) {
        badRequest(res, body.error);
        return;
      }
      const prev = await deps.store.getPlan(id);
      if (!prev) {
        res.status(404).json({ error: "Plan not found" });
        return;
      }
      let base: PlanRequest = prev.request;
      if (body.data.request !== undefined) {
        const r = PlanRequestSchema.safeParse(body.data.request);
        if (!r.success) {
          badRequest(res, r.error);
          return;
        }
          if (r.data.rosterId !== prev.request.rosterId) {
          res.status(400).json({ error: "The roster does not match this plan." });
          return;
        }
        base = r.data as PlanRequest;
      }
      // Capacity is taken only once the request is known to be valid.
      capacity(req, res, () => {
        void handleReplan(res, prev, base, body.data as ReplanRequest).catch(next);
      });
    } catch (err) {
      next(err);
    }
  });

  async function handleReplan(res: Response, prev: WeekPlan, base: PlanRequest, body: ReplanRequest) {
    const edits: string[] = [];
    // Reactions -> loved/declined ids per resident (by the entity shown in that slot).
    const entityBySlot = new Map(prev.sessions.map((s) => [s.slotId, s.entity]));
    const residents = base.residents.map((r) => ({ ...r, loved: [...(r.loved ?? [])], declined: [...(r.declined ?? [])] }));
    const byId = new Map(residents.map((r) => [r.id, r]));
    for (const x of body.reactions ?? []) {
      const e = entityBySlot.get(x.slotId);
      const r = byId.get(x.residentId);
      if (!e || !r) continue;
      const list = x.reaction === "loved" ? r.loved : r.declined;
      if (!list.includes(e.entity_id)) list.push(e.entity_id);
      const other = x.reaction === "loved" ? r.declined : r.loved;
      const i = other.indexOf(e.entity_id);
      if (i >= 0) other.splice(i, 1);
      edits.push(`${r.id} ${x.reaction} ${e.name}.`);
    }
    const exclude = new Set<string>();
    const locked = new Map<string, string>();
    if (body.mode === "next_week") {
      // Fresh week: nothing repeats from the week just run.
      for (const s of prev.sessions) exclude.add(s.entity.entity_id);
    }

    await stream(
      res,
      { ...base, residents },
      { exclude, locked, known: prev.sessions.map((s) => ({ entity: s.entity, domain: s.domain, source: s.source })) },
      async (emit, initial) => {
        let request = initial;
        if (body.instruction) {
          emit({ kind: "status", message: "Reading your instruction" });
          const t0 = Date.now();
          emit({ kind: "tool_call", id: "edit1", tool: "parse_instruction", input: { instruction: body.instruction.slice(0, 200) } });
          const parsed = await parseInstruction(deps.getGemini(), body.instruction, request.residents.map((r) => r.id));
          const applied = applyEdits(request, parsed);
          request = applied.request;
          edits.push(...applied.log);
          emit({
            kind: "tool_result",
            id: "edit1",
            tool: "parse_instruction",
            ok: true,
            summary: applied.log.length ? applied.log.join(" ") : "No changes found in the instruction",
            ms: Date.now() - t0,
          });
          const check = PlanRequestSchema.safeParse(request);
          if (!check.success) throw new AgentError("The instruction produced an invalid roster. Please rephrase it.");
        }
        if (body.mode === "edit") {
          // Keep sessions whose slot is unchanged and that still strongly match at least two residents
          // who can attend and have not declined it; re-plan the rest.
          for (const s of prev.sessions) {
            if (keepSession(s, request)) locked.set(s.slotId, s.entity.entity_id);
          }
          emit({ kind: "status", message: `Keeping ${locked.size} sessions that still work; re-planning the rest` });
        }
        return request;
      },
      (plan) => {
        plan.previousPlanId = prev.id;
        plan.diff = diffPlans(prev, plan, edits);
      },
    );
  }

  function keepSession(s: WeekPlan["sessions"][number], req: PlanRequest): boolean {
    const slot = req.slots.find((x) => x.id === s.slotId);
    if (!slot || slot.domain !== s.domain || slot.day !== s.day || slot.time !== s.time) return false;
    const byId = new Map(req.residents.map((r) => [r.id, r]));
    const stillMatched = s.matches.filter((m) => {
      const r = byId.get(m.residentId);
      return (
        r &&
        !r.declined?.includes(s.entity.entity_id) &&
        !r.unavailableDays?.includes(s.day) &&
        !r.unavailableTimes?.includes(s.time) &&
        !r.optOut?.includes(s.domain)
      );
    });
    return stillMatched.length >= 2;
  }

  router.post("/intake", requireConfig, intakeLimiter, async (req, res) => {
    const parsed = IntakeSchema.safeParse(req.body);
    if (!parsed.success) {
      badRequest(res, parsed.error);
      return;
    }
    if (!dailyIntake.tryTake()) {
      res.status(429).json({ error: "The demo has reached its daily limit for notes. Please add favorites by hand." });
      return;
    }
    try {
      res.json(await parseIntake(deps.getGemini(), parsed.data.notes));
    } catch (err) {
      res.status(502).json({ error: friendlyError(err) });
    }
  });

  router.get("/plans/:id", readLimiter, async (req, res, next) => {
    try {
      const { id } = req.params;
      if (!isValidPlanId(id)) {
        res.status(400).json({ error: "Invalid plan id" });
        return;
      }
      const plan = await deps.store.getPlan(id);
      if (!plan) {
        res.status(404).json({ error: "Plan not found" });
        return;
      }
      res.json(plan);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

export function diffPlans(prev: WeekPlan, next: WeekPlan, edits: string[]): PlanDiff {
  const before = new Map(prev.sessions.map((s) => [s.slotId, s]));
  const after = new Map(next.sessions.map((s) => [s.slotId, s]));
  const slotIds = [...new Set([...before.keys(), ...after.keys()])];
  const changedSlots = slotIds
    .map((id) => ({ id, a: before.get(id), b: after.get(id) }))
    .filter((x) => x.a?.entity.entity_id !== x.b?.entity.entity_id)
    .map((x) => ({
      slotId: x.id,
      day: (x.b ?? x.a)!.day,
      time: (x.b ?? x.a)!.time,
      ...(x.a ? { from: x.a.entity.name } : {}),
      ...(x.b ? { to: x.b.entity.name } : {}),
    }));
  const prevRes = new Map(prev.residents.map((r) => [r.residentId, r]));
  const residentChanges = next.residents
    .map((r) => ({ r, p: prevRes.get(r.residentId) }))
    .filter(({ r, p }) => !p || p.reached !== r.reached || Math.abs(p.bestFit - r.bestFit) >= 0.05)
    .map(({ r, p }) => ({
      residentId: r.residentId,
      fromBest: p?.bestFit ?? 0,
      toBest: r.bestFit,
      fromReached: p?.reached ?? false,
      toReached: r.reached,
    }));
  return { previousPlanId: prev.id, metricsBefore: prev.metrics, changedSlots, residentChanges, edits };
}
