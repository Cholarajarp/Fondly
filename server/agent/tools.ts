// Agent tools: validated wrappers around the pipeline. The model only sees compact JSON with
// resident aliases; full Qloo entities stay in PipelineState, so the plan can only contain data
// that Qloo actually returned. The model chooses which tools to call, in what order and with what
// inputs; code enforces prerequisites, budgets and every constraint.
import { z } from "zod";
import { DOMAINS, type Domain, type QlooClient } from "../../shared/types.ts";
import {
  POOL_TAKE_MAX,
  POOL_TAKE_MIN,
  buildCandidates,
  buildOneToOnes,
  buildPopularBaseline,
  expandForResidents,
  fetchRelated,
  inspectPlan,
  resolveResidents,
  revisePlan,
  runOptimizer,
  scoreAll,
  snapshot,
  unfetchedDomains,
  type PipelineState,
} from "../engine/pipeline.ts";
import { clip, type Tracer } from "../engine/trace.ts";
import { scheduleOlderAdults } from "../engine/enrich.ts";

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** Budgets that protect Qloo quota and run time. */
export const MAX_EXPANSIONS = 4;
export const MAX_REVISIONS = 4;
/** Reasons are shown in the UI timeline; keep them short. */
export const REASON_MAX = 200;
/** Within this much of the deadline, finish is never gated (the agent must wrap up). */
const FINISH_GATE_MIN_MS = 40_000;

const REASON = {
  type: "string",
  description: "One short sentence (under 25 words) on why you are making this call now. Shown to the coordinator.",
};
const obj = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object",
  properties: { reason: REASON, ...properties },
  required: ["reason", ...required],
});
const none = obj({}, []);
const poolSize = { type: "integer", minimum: POOL_TAKE_MIN, maximum: POOL_TAKE_MAX, description: `Candidates to fetch per session type (${POOL_TAKE_MIN}-${POOL_TAKE_MAX}).` };

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  { name: "resolve_favorites", description: "Match every resident's favorites to Qloo entities and tags. No prerequisites.", parameters: none },
  {
    name: "build_candidates",
    description: "Fetch the group's candidate pool from Qloo. Requires resolve_favorites. Choose which session types to fetch and how many per type; call again later for types you skipped or to fetch a larger pool. Every session type in the week needs a pool before its slots can be filled well.",
    parameters: obj(
      {
        session_types: { type: "array", items: { type: "string", enum: DOMAINS }, description: "Omit for every session type in the week." },
        pool_size: poolSize,
      },
      [],
    ),
  },
  { name: "score_residents", description: "Score every candidate for every resident with Qloo affinity (only unscored pairs are fetched). Requires build_candidates.", parameters: none },
  { name: "build_baseline", description: "Build the generic 'most popular titles' comparison calendar from Qloo. Requires resolve_favorites. Its titles also join the pool and seed the optimizer.", parameters: none },
  {
    name: "optimize",
    description: "Run the max-min scheduler (scores any unscored pairs first). Requires score_residents. Returns metrics, slot picks with candidate ids, unreached residents and baseline metrics.",
    parameters: none,
  },
  {
    name: "inspect_plan",
    description: "Diagnose the current schedule: each resident's best fit, the weakest-served residents with unused strong options, low-fit slots, near-duplicate titles, over-represented types or sources, unfetched session types and the baseline comparison. Requires optimize. No Qloo calls.",
    parameters: none,
  },
  {
    name: "revise_plan",
    description: `Change the schedule, then re-run the optimizer and return old and new metrics. Requires optimize. Exclude a candidate from one slot or from the whole week, and/or pin a pool candidate (by candidate_id from optimize or inspect_plan) to a slot of the same type. Availability, opt-outs and declines are still enforced. At most ${MAX_REVISIONS} revisions per run; a revision that lowers reach is kept, so undo it with unpin or another revision if needed.`,
    parameters: obj(
      {
        exclude: {
          type: "array",
          items: { type: "object", properties: { candidate_id: { type: "string" }, slot_id: { type: "string", description: "Omit to exclude from the whole week." } }, required: ["candidate_id"] },
        },
        pin: { type: "array", items: { type: "object", properties: { slot_id: { type: "string" }, candidate_id: { type: "string" } }, required: ["slot_id", "candidate_id"] } },
        unpin: { type: "array", items: { type: "string" }, description: "Slot ids whose earlier pin should be released." },
      },
      [],
    ),
  },
  {
    name: "expand_for_residents",
    description: `Fetch extra Qloo candidates of one session type aimed at specific residents' own taste. Requires optimize. Follow with optimize. At most ${MAX_EXPANSIONS} expansions per run.`,
    parameters: obj(
      {
        resident_ids: { type: "array", items: { type: "string" }, description: "Resident ids, e.g. [\"r3\",\"r7\"]" },
        session_type: { type: "string", enum: DOMAINS },
        pool_size: poolSize,
      },
      ["resident_ids", "session_type"],
    ),
  },
  {
    name: "plan_one_to_ones",
    description: "Build 1:1 visit plans for residents still unreached after optimizing. Requires optimize.",
    parameters: obj({ resident_ids: { type: "array", items: { type: "string" }, description: "Omit for all unreached." } }, []),
  },
  {
    name: "record_sessions",
    description: "Submit a title and staff brief for every scheduled slot (replaces earlier submissions for those slots). Requires optimize. Re-record slots whose pick changed after a revision.",
    parameters: obj(
      {
        sessions: {
          type: "array",
          items: { type: "object", properties: { slot_id: { type: "string" }, title: { type: "string" }, brief: { type: "string" } }, required: ["slot_id", "title", "brief"] },
        },
      },
      ["sessions"],
    ),
  },
  {
    name: "finish",
    description: "Call last with the staff summary, the family newsletter and an honest self-evaluation. Requires record_sessions. May be refused once if clear improvements remain.",
    parameters: obj(
      {
        summary: { type: "string" },
        newsletter: { type: "string" },
        self_evaluation: {
          type: "object",
          properties: {
            reached: { type: "integer", description: "Residents reached, exactly as in the last optimizer result." },
            min_fit: { type: "number", description: "Least-served resident's fit, exactly as in the last optimizer result." },
            tried: { type: "string", description: "What you tried to improve the plan (expansions, revisions) and what happened." },
            remaining: { type: "string", description: "What is still weak and why it could not be fixed." },
          },
          required: ["reached", "tried", "remaining"],
        },
      },
      ["summary", "newsletter", "self_evaluation"],
    ),
  },
];

const residentId = z.string().trim().regex(/^r\d{1,3}$/);
const slotId = z.string().trim().regex(/^s\d{1,3}$/);
// Candidate ids are only looked up in the pool, never sent anywhere; the pattern just bounds them.
const candidateId = z.string().trim().regex(/^[A-Za-z0-9_:-]{1,100}$/);
const domainEnum = z.enum(DOMAINS as [Domain, ...Domain[]]);
const pool = z.number().int().min(POOL_TAKE_MIN).max(POOL_TAKE_MAX).nullish();
// Required on every tool; clipped and cleaned before it is shown (see toolReason).
const reason = z.string().trim().min(1, "Give a short reason for this call").max(1000);
const withReason = <T extends z.ZodRawShape>(shape: T) => z.object({ reason, ...shape });

const inputSchemas = {
  resolve_favorites: withReason({}),
  build_candidates: withReason({ session_types: z.array(domainEnum).min(1).max(DOMAINS.length).nullish(), pool_size: pool }),
  score_residents: withReason({}),
  build_baseline: withReason({}),
  optimize: withReason({}),
  inspect_plan: withReason({}),
  revise_plan: withReason({
    exclude: z.array(z.object({ candidate_id: candidateId, slot_id: slotId.nullish() })).max(10).nullish(),
    pin: z.array(z.object({ slot_id: slotId, candidate_id: candidateId })).max(10).nullish(),
    unpin: z.array(slotId).max(21).nullish(),
  }).refine((r) => r.exclude?.length || r.pin?.length || r.unpin?.length, "Give at least one exclude, pin or unpin"),
  expand_for_residents: withReason({
    resident_ids: z.array(residentId).min(1).max(30),
    session_type: domainEnum,
    pool_size: pool,
  }),
  plan_one_to_ones: withReason({ resident_ids: z.array(residentId).max(60).nullish() }),
  record_sessions: withReason({
    sessions: z
      .array(z.object({ slot_id: z.string().trim().min(1).max(20), title: z.string().trim().min(1).max(80), brief: z.string().trim().min(1).max(1200) }))
      .min(1)
      .max(40),
  }),
  finish: withReason({
    summary: z.string().trim().min(1).max(2500),
    newsletter: z.string().trim().min(1).max(2500),
    self_evaluation: z.object({
      reached: z.number().int().min(0).max(1000),
      min_fit: z.number().min(0).max(1).nullish(),
      tried: z.string().trim().min(1).max(600),
      remaining: z.string().trim().min(1).max(600),
    }),
  }),
} as const;

export type ToolName = keyof typeof inputSchemas;

/** Steps that make up a complete plan; used to account for agent vs safety-net work. */
export const PLAN_STEPS = ["resolve_favorites", "build_candidates", "score_residents", "build_baseline", "optimize", "plan_one_to_ones", "record_sessions", "finish"] as const;
export type PlanStep = (typeof PLAN_STEPS)[number];

export interface ToolOutcome {
  content: string;
  summary: string;
  isError: boolean;
}

export class ToolInputError extends Error {}

export interface ToolCtx {
  qloo: QlooClient;
  state: PipelineState;
  tracer: Tracer;
  /** Called after each optimizer run so the UI can show progress. */
  onMetrics: (label: string) => void;
  /** Tracks which steps have run successfully, in first-success order (prerequisites and accounting). */
  done: Set<ToolName>;
  finished: boolean;
  /** Run deadline (ms since epoch); finish is not gated close to it. */
  deadline?: number;
  /** Set by the loop when the turn or time budget is nearly used; finish is then never gated. */
  wrapUp?: boolean;
  /** Agent tool calls so far (including rejected ones). */
  toolCalls: number;
  expansions: number;
  revisions: number;
  /** The one-time "you can still improve" refusal of finish has been used. */
  finishPushedBack: boolean;
  selfEvaluation?: { tried: string; remaining: string };
  /** Plan steps the safety net had to perform (filled in by ensureComplete). */
  fallback: PlanStep[];
}

export function createToolCtx(base: Pick<ToolCtx, "qloo" | "state" | "tracer" | "onMetrics"> & { deadline?: number }): ToolCtx {
  return { ...base, done: new Set(), finished: false, toolCalls: 0, expansions: 0, revisions: 0, finishPushedBack: false, fallback: [] };
}

const json = (v: unknown) => JSON.stringify(v);

/** The model's stated reason for a call, cleaned (control characters and runs of whitespace collapsed) and clipped for display. */
export function toolReason(rawInput: unknown): string | undefined {
  const r = (rawInput as { reason?: unknown } | null)?.reason;
  return typeof r === "string" && r.trim() ? clip(clip(r, 2000)!.replace(/\s+/g, " "), REASON_MAX) : undefined;
}

export async function executeTool(name: string, rawInput: unknown, ctx: ToolCtx): Promise<ToolOutcome> {
  ctx.toolCalls++;
  try {
    if (!(name in inputSchemas)) throw new ToolInputError(`Unknown tool "${name}".`);
    const parsed = inputSchemas[name as ToolName].safeParse(rawInput ?? {});
    if (!parsed.success) throw new ToolInputError(`Invalid input for ${name}: ${z.prettifyError(parsed.error)}`);
    const out = await handlers[name as ToolName](parsed.data as never, ctx);
    ctx.done.add(name as ToolName);
    return out;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: message, summary: `error: ${clip(message, 160)}`, isError: true };
  }
}

const requireStep = (ctx: ToolCtx, step: ToolName, tool: ToolName, hint: string) => {
  if (!ctx.done.has(step)) throw new ToolInputError(`Call ${step} first, then retry ${tool} (${hint}).`);
};

type Handler<K extends ToolName> = (input: z.infer<(typeof inputSchemas)[K]>, ctx: ToolCtx) => Promise<ToolOutcome>;

const text = (summary: string, extra: Record<string, unknown> = {}): ToolOutcome => ({
  content: json({ result: summary, ...extra }),
  summary,
  isError: false,
});

/** Slots whose current pick has no title/brief written for it. */
const staleSlots = (state: PipelineState) => [...(state.assignment ?? [])].filter(([s, c]) => state.writtenFor.get(s) !== c).map(([s]) => s);

const handlers: { [K in ToolName]: Handler<K> } = {
  async resolve_favorites(_i, { qloo, state, tracer }) {
    if (state.residents.size) return text("Already resolved.");
    const summary = await resolveResidents(state, qloo, tracer);
    const unscorable = [...state.residents.values()].filter((r) => !r.scorable).map((r) => r.id);
    return text(summary, { unscorable });
  },
  async build_candidates({ session_types, pool_size }, ctx) {
    requireStep(ctx, "resolve_favorites", "build_candidates", "favorites must be matched to Qloo first");
    return text(await buildCandidates(ctx.state, ctx.qloo, ctx.tracer, { domains: session_types ?? undefined, take: pool_size ?? undefined }), {
      unfetched_types: unfetchedDomains(ctx.state),
    });
  },
  async score_residents(_i, ctx) {
    requireStep(ctx, "build_candidates", "score_residents", "there is nothing to score yet");
    return text(await scoreAll(ctx.state, ctx.qloo, ctx.tracer));
  },
  async build_baseline(_i, ctx) {
    requireStep(ctx, "resolve_favorites", "build_baseline", "favorites must be matched to Qloo first");
    const s = await buildPopularBaseline(ctx.state, ctx.qloo, ctx.tracer);
    // Baseline items join the pool; make sure residents are scored on them.
    if (ctx.done.has("score_residents")) await scoreAll(ctx.state, ctx.qloo, ctx.tracer);
    return text(s);
  },
  async optimize(_i, ctx) {
    requireStep(ctx, "score_residents", "optimize", "residents must be scored first");
    // Never optimize on unscored pairs (e.g. after an expansion the model forgot to score).
    await scoreAll(ctx.state, ctx.qloo, ctx.tracer);
    const { metrics, unreached } = runOptimizer(ctx.state);
    ctx.onMetrics(`Optimizer pass ${ctx.state.optimizerRuns}`);
    const snap = snapshot(ctx.state);
    const warnings = [
      ...(ctx.done.has("build_baseline") ? [] : ["build_baseline has not run: the baseline comparison is missing and cannot seed the optimizer."]),
      ...(snap.unfetched_types.length ? [`No group pool fetched yet for: ${snap.unfetched_types.join(", ")}.`] : []),
    ];
    // Qloo audience data for briefs ("popular with people 55 and older"); best-effort, never fails the tool.
    const older = await scheduleOlderAdults(ctx.state, ctx.qloo, ctx.tracer);
    return {
      content: json({ ...snap, ...(older.length ? { loved_by_55_plus: older } : {}), ...(warnings.length ? { warnings } : {}) }),
      summary: `reached ${metrics.reached}/${metrics.total}, least-served fit ${metrics.minBest}, unreached: ${unreached.length ? unreached.join(", ") : "none"}`,
      isError: false,
    };
  },
  async inspect_plan(_i, ctx) {
    requireStep(ctx, "optimize", "inspect_plan", "there is no schedule to inspect yet");
    const d = inspectPlan(ctx.state);
    const budget = { expansions_left: MAX_EXPANSIONS - ctx.expansions, revisions_left: MAX_REVISIONS - ctx.revisions };
    return {
      content: json({ ...d, budget }),
      summary: `weakest: ${d.weakest.slice(0, 3).map((w) => `${w.resident} ${w.best_fit}`).join(", ") || "none"}; low-fit slots: ${d.low_fit_slots.join(", ") || "none"}${d.near_duplicates.length ? `; ${d.near_duplicates.length} near-duplicate pair(s)` : ""}`,
      isError: false,
    };
  },
  async revise_plan({ exclude, pin, unpin }, ctx) {
    requireStep(ctx, "optimize", "revise_plan", "there is no schedule to revise yet");
    if (ctx.revisions >= MAX_REVISIONS) throw new ToolInputError(`Revision budget used (${MAX_REVISIONS}). Record sessions and finish.`);
    const r = revisePlan(ctx.state, {
      exclude: exclude?.map((x) => ({ candidate_id: x.candidate_id, slot_id: x.slot_id ?? undefined })),
      pin: pin ?? undefined,
      unpin: unpin ?? undefined,
    });
    ctx.revisions++;
    ctx.onMetrics(`Revision ${ctx.revisions}`);
    const stale = staleSlots(ctx.state).filter((s) => ctx.state.titles.has(s));
    return {
      content: json({
        before: r.before,
        after: r.metrics,
        unreached: r.unreached,
        changed_slots: r.changed,
        ...(stale.length ? { rerecord_slots: stale } : {}),
        revisions_left: MAX_REVISIONS - ctx.revisions,
        slots: snapshot(ctx.state).slots,
      }),
      summary: `reached ${r.before.reached} → ${r.metrics.reached}/${r.metrics.total}, least-served fit ${r.before.minBest} → ${r.metrics.minBest}; changed: ${r.changed.join(", ") || "none"}`,
      isError: false,
    };
  },
  async expand_for_residents({ resident_ids, session_type, pool_size }, ctx) {
    requireStep(ctx, "optimize", "expand_for_residents", "optimize once so you know who is unreached");
    if (ctx.expansions >= MAX_EXPANSIONS) throw new ToolInputError(`Expansion budget used (${MAX_EXPANSIONS}). Use revise_plan or plan_one_to_ones instead.`);
    ctx.expansions++;
    const s = await expandForResidents(ctx.state, ctx.qloo, ctx.tracer, resident_ids, session_type, pool_size ?? undefined);
    return text(s, { expansions_left: MAX_EXPANSIONS - ctx.expansions });
  },
  async plan_one_to_ones({ resident_ids }, ctx) {
    requireStep(ctx, "optimize", "plan_one_to_ones", "optimize first so unreached residents are known");
    return text(await buildOneToOnes(ctx.state, ctx.qloo, ctx.tracer, resident_ids ?? undefined));
  },
  async record_sessions({ sessions }, ctx) {
    requireStep(ctx, "optimize", "record_sessions", "there is no schedule yet");
    const assigned = ctx.state.assignment!;
    const unknown = sessions.filter((s) => !assigned.has(s.slot_id)).map((s) => s.slot_id);
    if (unknown.length) throw new ToolInputError(`Rejected: these slots have no scheduled session: ${unknown.join(", ")}. Nothing was recorded.`);
    await fetchRelated(ctx.state, ctx.qloo, ctx.tracer);
    for (const s of sessions) {
      ctx.state.titles.set(s.slot_id, s.title);
      ctx.state.briefs.set(s.slot_id, s.brief);
      ctx.state.writtenFor.set(s.slot_id, assigned.get(s.slot_id)!);
    }
    const missing = staleSlots(ctx.state);
    return text(`Recorded ${sessions.length} sessions`, { missing_slots: missing, related: relatedView(ctx.state) });
  },
  async finish({ summary, newsletter, self_evaluation }, ctx) {
    requireStep(ctx, "record_sessions", "finish", "every scheduled slot needs a title and brief");
    const m = ctx.state.metrics!;
    // Refused at most once (then accepted), and never close to the deadline.
    const gateOpen = !ctx.wrapUp && (!ctx.deadline || ctx.deadline - Date.now() > FINISH_GATE_MIN_MS);
    if (gateOpen && !ctx.finishPushedBack) {
      // The self-evaluation is checked against the optimizer, never trusted.
      const minOff = self_evaluation.min_fit != null && Math.abs(self_evaluation.min_fit - m.minBest) > 0.005;
      const issues = [
        ...(self_evaluation.reached !== m.reached || minOff
          ? [`Your self-evaluation does not match the last optimizer result (reached ${m.reached} of ${m.total}, least-served fit ${m.minBest}); correct it and the summary.`]
          : []),
        ...improvements(ctx),
      ];
      if (issues.length) {
        ctx.finishPushedBack = true;
        throw new ToolInputError(`Not finished yet; this is still improvable:\n- ${issues.join("\n- ")}\nAct on these, or call finish again (it will be accepted) if you judge nothing more can help.`);
      }
    }
    ctx.state.summary = summary;
    ctx.state.newsletter = newsletter;
    ctx.selfEvaluation = { tried: clip(self_evaluation.tried, 600)!, remaining: clip(self_evaluation.remaining, 600)! };
    ctx.finished = true;
    return text("finished");
  },
};

/** What the agent could still try before finishing (empty when the plan is as good as the budget allows). */
function improvements(ctx: ToolCtx): string[] {
  const snap = snapshot(ctx.state);
  const out: string[] = [];
  const reachable = snap.unreached.filter((id) => ctx.state.residents.get(id)?.scorable);
  if (reachable.length && (ctx.expansions < MAX_EXPANSIONS || ctx.revisions < MAX_REVISIONS)) {
    out.push(
      `${reachable.length} resident(s) unreached (${reachable.join(", ")}); ${MAX_EXPANSIONS - ctx.expansions} expansion(s) and ${MAX_REVISIONS - ctx.revisions} revision(s) left. inspect_plan lists unused strong options per resident.`,
    );
  }
  if (snap.unfetched_types.length) out.push(`No group pool was fetched for: ${snap.unfetched_types.join(", ")} (build_candidates).`);
  const needOneToOne = reachable.filter((id) => !ctx.state.oneToOne.has(id));
  if (needOneToOne.length) out.push(`Unreached residents without a 1:1 plan: ${needOneToOne.join(", ")} (plan_one_to_ones).`);
  const stale = staleSlots(ctx.state);
  if (stale.length) out.push(`Slots without a current title and brief: ${stale.join(", ")} (record_sessions).`);
  return out;
}

/** Related titles per scheduled slot, so briefs can name them. */
export function relatedView(state: PipelineState) {
  const out: Record<string, string[]> = {};
  for (const [slot, id] of state.assignment ?? []) {
    const c = state.candidates.get(id);
    if (c?.related.length) out[slot] = c.related.map((e) => clip(e.name, 60)!);
  }
  return out;
}
