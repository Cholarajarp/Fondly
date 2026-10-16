// Agent tools: validated wrappers around the pipeline. The model only sees compact JSON with
// resident aliases; full Qloo entities stay in PipelineState, so the plan can only contain data
// that Qloo actually returned.
import { z } from "zod";
import { DOMAINS, type Domain, type QlooClient } from "../../shared/types.ts";
import {
  buildCandidates,
  buildOneToOnes,
  buildPopularBaseline,
  expandForResidents,
  fetchRelated,
  resolveResidents,
  runOptimizer,
  scoreAll,
  snapshot,
  type PipelineState,
} from "../engine/pipeline.ts";
import { clip, type Tracer } from "../engine/trace.ts";

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required });
const none = obj({}, []);

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  { name: "resolve_favorites", description: "Match every resident's favorites to Qloo entities and tags.", parameters: none },
  { name: "build_candidates", description: "Fetch the group's candidate pool from Qloo for every session type in the week.", parameters: none },
  { name: "score_residents", description: "Score every candidate for every resident with Qloo affinity (only unscored pairs are fetched).", parameters: none },
  { name: "build_baseline", description: "Build the generic 'most popular titles' comparison calendar from Qloo.", parameters: none },
  {
    name: "optimize",
    description: "Run the max-min scheduler. Returns metrics, slot picks, unreached residents and baseline metrics.",
    parameters: none,
  },
  {
    name: "expand_for_residents",
    description: "Fetch extra Qloo candidates of one session type aimed at specific residents' own taste. Follow with score_residents and optimize.",
    parameters: obj(
      {
        resident_ids: { type: "array", items: { type: "string" }, description: "Resident ids, e.g. [\"r3\",\"r7\"]" },
        session_type: { type: "string", enum: DOMAINS },
      },
      ["resident_ids", "session_type"],
    ),
  },
  {
    name: "plan_one_to_ones",
    description: "Build 1:1 visit plans for residents still unreached after optimizing.",
    parameters: obj({ resident_ids: { type: "array", items: { type: "string" }, description: "Omit for all unreached." } }, []),
  },
  {
    name: "record_sessions",
    description: "Submit a title and staff brief for every scheduled slot (replaces earlier submissions for those slots).",
    parameters: obj(
      {
        sessions: {
          type: "array",
          items: obj({ slot_id: { type: "string" }, title: { type: "string" }, brief: { type: "string" } }, ["slot_id", "title", "brief"]),
        },
      },
      ["sessions"],
    ),
  },
  {
    name: "finish",
    description: "Call last with the staff summary and the family newsletter.",
    parameters: obj({ summary: { type: "string" }, newsletter: { type: "string" } }, ["summary", "newsletter"]),
  },
];

const residentId = z.string().trim().regex(/^r\d{1,3}$/);

const inputSchemas = {
  resolve_favorites: z.object({}).passthrough(),
  build_candidates: z.object({}).passthrough(),
  score_residents: z.object({}).passthrough(),
  build_baseline: z.object({}).passthrough(),
  optimize: z.object({}).passthrough(),
  expand_for_residents: z.object({
    resident_ids: z.array(residentId).min(1).max(30),
    session_type: z.enum(DOMAINS as [Domain, ...Domain[]]),
  }),
  plan_one_to_ones: z.object({ resident_ids: z.array(residentId).max(60).nullish() }),
  record_sessions: z.object({
    sessions: z
      .array(z.object({ slot_id: z.string().trim().min(1).max(20), title: z.string().trim().min(1).max(80), brief: z.string().trim().min(1).max(1200) }))
      .min(1)
      .max(40),
  }),
  finish: z.object({ summary: z.string().trim().min(1).max(2500), newsletter: z.string().trim().min(1).max(2500) }),
} as const;

export type ToolName = keyof typeof inputSchemas;

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
  /** Tracks which steps have run (for ordering guards and the final safety net). */
  done: Set<ToolName>;
  finished: boolean;
}

const json = (v: unknown) => JSON.stringify(v);

export async function executeTool(name: string, rawInput: unknown, ctx: ToolCtx): Promise<ToolOutcome> {
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

const requireStep = (ctx: ToolCtx, step: ToolName, hint: string) => {
  if (!ctx.done.has(step)) throw new ToolInputError(`Call ${step} first (${hint}).`);
};

type Handler<K extends ToolName> = (input: z.infer<(typeof inputSchemas)[K]>, ctx: ToolCtx) => Promise<ToolOutcome>;

const text = (summary: string, extra: Record<string, unknown> = {}): ToolOutcome => ({
  content: json({ result: summary, ...extra }),
  summary,
  isError: false,
});

const handlers: { [K in ToolName]: Handler<K> } = {
  async resolve_favorites(_i, { qloo, state, tracer }) {
    if (state.residents.size) return text("Already resolved.");
    const summary = await resolveResidents(state, qloo, tracer);
    const unscorable = [...state.residents.values()].filter((r) => !r.scorable).map((r) => r.id);
    return text(summary, { unscorable });
  },
  async build_candidates(_i, ctx) {
    requireStep(ctx, "resolve_favorites", "favorites must be matched first");
    return text(await buildCandidates(ctx.state, ctx.qloo, ctx.tracer));
  },
  async score_residents(_i, ctx) {
    requireStep(ctx, "build_candidates", "there is nothing to score yet");
    return text(await scoreAll(ctx.state, ctx.qloo, ctx.tracer));
  },
  async build_baseline(_i, ctx) {
    requireStep(ctx, "resolve_favorites", "favorites must be matched first");
    const s = await buildPopularBaseline(ctx.state, ctx.qloo, ctx.tracer);
    // Baseline items join the pool; make sure residents are scored on them.
    if (ctx.done.has("score_residents")) await scoreAll(ctx.state, ctx.qloo, ctx.tracer);
    return text(s);
  },
  async optimize(_i, ctx) {
    requireStep(ctx, "score_residents", "residents must be scored first");
    // Never optimize on unscored pairs (e.g. after an expansion the model forgot to score).
    await scoreAll(ctx.state, ctx.qloo, ctx.tracer);
    const { metrics, unreached } = runOptimizer(ctx.state);
    ctx.onMetrics(`Optimizer pass ${ctx.state.optimizerRuns}`);
    const snap = snapshot(ctx.state);
    return {
      content: json(snap),
      summary: `reached ${metrics.reached}/${metrics.total}, least-served fit ${metrics.minBest}, unreached: ${unreached.length ? unreached.join(", ") : "none"}`,
      isError: false,
    };
  },
  async expand_for_residents({ resident_ids, session_type }, ctx) {
    requireStep(ctx, "optimize", "optimize once before targeting residents");
    return text(await expandForResidents(ctx.state, ctx.qloo, ctx.tracer, resident_ids, session_type));
  },
  async plan_one_to_ones({ resident_ids }, ctx) {
    requireStep(ctx, "optimize", "optimize first");
    return text(await buildOneToOnes(ctx.state, ctx.qloo, ctx.tracer, resident_ids ?? undefined));
  },
  async record_sessions({ sessions }, ctx) {
    requireStep(ctx, "optimize", "there is no schedule yet");
    const assigned = ctx.state.assignment!;
    const unknown = sessions.filter((s) => !assigned.has(s.slot_id)).map((s) => s.slot_id);
    if (unknown.length) throw new ToolInputError(`Rejected: these slots have no scheduled session: ${unknown.join(", ")}. Nothing was recorded.`);
    await fetchRelated(ctx.state, ctx.qloo, ctx.tracer);
    for (const s of sessions) {
      ctx.state.titles.set(s.slot_id, s.title);
      ctx.state.briefs.set(s.slot_id, s.brief);
      ctx.state.writtenFor.set(s.slot_id, assigned.get(s.slot_id)!);
    }
    const missing = [...assigned.keys()].filter((id) => !ctx.state.titles.has(id));
    return text(`Recorded ${sessions.length} sessions`, { missing_slots: missing, related: relatedView(ctx.state) });
  },
  async finish({ summary, newsletter }, ctx) {
    requireStep(ctx, "optimize", "there is no schedule yet");
    ctx.state.summary = summary;
    ctx.state.newsletter = newsletter;
    ctx.finished = true;
    return text("finished");
  },
};

/** Related titles per scheduled slot, so briefs can name them. */
export function relatedView(state: PipelineState) {
  const out: Record<string, string[]> = {};
  for (const [slot, id] of state.assignment ?? []) {
    const c = state.candidates.get(id);
    if (c?.related.length) out[slot] = c.related.map((e) => clip(e.name, 60)!);
  }
  return out;
}
