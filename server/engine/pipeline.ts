// Fondly planning pipeline. Holds the plan state and performs every Qloo call. The agent (run.ts)
// decides when to call these steps and writes the prose; the numbers all come from here.
import { randomUUID } from "node:crypto";
import {
  DOMAINS,
  REACH_THRESHOLD,
  type BaselineComparison,
  type CandidateSource,
  type Domain,
  type Favorite,
  type Metrics,
  type OneToOnePlan,
  type PlanRequest,
  type QlooClient,
  type QlooEntity,
  type QlooTag,
  type ResidentOutcome,
  type ResolvedFavorite,
  type ScheduledSession,
  type SessionMatch,
  type WeekPlan,
} from "../../shared/types.ts";
import {
  bestFor,
  computeMetrics,
  fillInOrder,
  fitOf,
  optimizeBest,
  unreached,
  type EngineCandidate,
  type EngineSlot,
} from "./optimize.ts";
import {
  BASELINE_TAKE,
  GROUP_TAKE,
  ONE_TO_ONE_TAKE,
  RELATED_TAKE,
  SCORE_TAKE,
  baselineParams,
  kindToDomain,
  outingParams,
  outingScoreParams,
  rankFits,
  recommendParams,
  resolveEntity,
  resolveFoodTag,
  scoreParams,
  suitableForGroup,
} from "./qloo-ops.ts";
import { Tracer, clip, errMsg, mapLimit } from "./trace.ts";

type MediaDomain = Exclude<Domain, "outing">;
const CONCURRENCY = 4;

export interface ResidentState {
  id: string;
  favorites: ResolvedFavorite[];
  /** Entity ids per domain from favorites + loved items (taste signal). */
  signals: Map<MediaDomain, string[]>;
  /** All entity signal ids across domains (cross-domain taste signal). */
  allSignals: string[];
  foodTags: string[];
  declined: Set<string>;
  loved: Set<string>;
  scorable: boolean;
  warnings: string[];
}

export interface CandidateState {
  entity: QlooEntity;
  domain: Domain;
  source: CandidateSource;
  /** Residents whose own favorite this is (or who loved it before). */
  ownedBy: Set<string>;
  fit: Map<string, number>;
  /** residentId -> Qloo explainability: which of the resident's signals drove the score. */
  explain: Map<string, { entity_id: string; score: number }[]>;
  related: QlooEntity[];
}

export interface PipelineState {
  /** Entities from the previous plan, carried into a replan. */
  known: KnownEntity[];
  request: PlanRequest;
  residents: Map<string, ResidentState>;
  slots: EngineSlot[];
  candidates: Map<string, CandidateState>;
  /** Candidate ids shown in the previous week (excluded in next-week mode). */
  exclude: Set<string>;
  /** Pinned slot -> candidate (edit mode keeps what still works). */
  locked: Map<string, string>;
  /** Entity names by id, for explanations. */
  names: Map<string, string>;
  assignment: Map<string, string> | null;
  metrics: Metrics | null;
  baselines: BaselineComparison[];
  baselineAssignments: Map<string, Map<string, string>>;
  oneToOne: Map<string, OneToOnePlan>;
  notes: string[];
  optimizerRuns: number;
  qlooRequests: number;
  /** Agent-written text, validated by the tools. */
  titles: Map<string, string>;
  briefs: Map<string, string>;
  /** Candidate id each title/brief was written for (stale text is dropped if the pick changes). */
  writtenFor: Map<string, string>;
  summary: string | null;
  newsletter: string | null;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export function attendeesFor(req: PlanRequest, slot: PlanRequest["slots"][number]): string[] {
  return req.residents
    .filter(
      (r) =>
        !r.unavailableDays?.includes(slot.day) &&
        !r.unavailableTimes?.includes(slot.time) &&
        !r.optOut?.includes(slot.domain),
    )
    .map((r) => r.id);
}

/** An entity a previous plan used, with the domain it was scheduled in. */
export interface KnownEntity {
  entity: QlooEntity;
  domain: Domain;
  source: CandidateSource;
}

export function createState(
  request: PlanRequest,
  opts: { exclude?: Set<string>; locked?: Map<string, string>; known?: KnownEntity[] } = {},
): PipelineState {
  return {
    known: opts.known ?? [],
    request,
    residents: new Map(),
    slots: request.slots.map((s) => ({ id: s.id, domain: s.domain, attendees: attendeesFor(request, s) })),
    candidates: new Map(),
    exclude: opts.exclude ?? new Set(),
    locked: opts.locked ?? new Map(),
    names: new Map(),
    assignment: null,
    metrics: null,
    baselines: [],
    baselineAssignments: new Map(),
    oneToOne: new Map(),
    notes: [],
    optimizerRuns: 0,
    qlooRequests: 0,
    titles: new Map(),
    briefs: new Map(),
    writtenFor: new Map(),
    summary: null,
    newsletter: null,
  };
}

const domainsInWeek = (state: PipelineState): Set<Domain> => new Set(state.request.slots.map((s) => s.domain));

/** Scorable residents who can attend at least one slot. */
export function scoredResidents(state: PipelineState): string[] {
  return [...state.residents.values()]
    .filter((r) => r.scorable && state.slots.some((s) => s.attendees.includes(r.id)))
    .map((r) => r.id);
}

function engineCandidates(state: PipelineState): EngineCandidate[] {
  return [...state.candidates.values()].map((c) => ({
    id: c.entity.entity_id,
    domain: c.domain,
    fit: effectiveFit(c),
    blocked: new Set([...state.residents.values()].filter((r) => r.declined.has(c.entity.entity_id)).map((r) => r.id)),
  }));
}

/** Own favorites count as a perfect fit for their owner. */
function effectiveFit(c: CandidateState): Map<string, number> {
  const m = new Map(c.fit);
  for (const r of c.ownedBy) m.set(r, 1);
  return m;
}

/** Same metrics, plus how many residents were reached by something other than their own favorites. */
function metricsWithDiscovery(state: PipelineState, bySlot: Map<string, string>): Metrics {
  const residents = scoredResidents(state);
  const base = computeMetrics(bySlot, state.slots, engineCandidates(state), residents);
  const discovered = new Set<string>();
  for (const s of state.slots) {
    const c = state.candidates.get(bySlot.get(s.id) ?? "");
    if (!c) continue;
    for (const r of s.attendees) {
      if (!c.ownedBy.has(r) && (c.fit.get(r) ?? 0) >= REACH_THRESHOLD - 1e-9) discovered.add(r);
    }
  }
  return { ...base, discoveryReached: residents.filter((r) => discovered.has(r)).length };
}

function addCandidate(state: PipelineState, e: QlooEntity, domain: Domain, source: CandidateSource): CandidateState {
  const existing = state.candidates.get(e.entity_id);
  if (existing) {
    if (!existing.entity.image_url && e.image_url) existing.entity = { ...existing.entity, image_url: e.image_url };
    return existing;
  }
  const c: CandidateState = {
    entity: e,
    domain,
    source,
    ownedBy: new Set(),
    fit: new Map(),
    explain: new Map(),
    related: [],
  };
  state.candidates.set(e.entity_id, c);
  state.names.set(e.entity_id, e.name);
  return c;
}

const counted = <T>(state: PipelineState, p: Promise<T>) => {
  state.qlooRequests++;
  return p;
};

// ---------------------------------------------------------------------------
// Step 1: resolve favorites
// ---------------------------------------------------------------------------

export async function resolveResidents(state: PipelineState, qloo: QlooClient, tracer: Tracer): Promise<string> {
  // De-duplicate lookups across residents (many residents share favorites).
  const keyOf = (f: Favorite) => `${f.kind}:${f.text.trim().toLowerCase()}`;
  const unique = new Map<string, Favorite>();
  for (const r of state.request.residents) for (const f of r.favorites) unique.set(keyOf(f), f);

  const looked = new Map<string, { entity?: QlooEntity; tag?: QlooTag }>();
  await mapLimit([...unique.entries()], CONCURRENCY, async ([key, f]) => {
    if (f.kind === "food") {
      const tag = await tracer.tryCall(
        "resolve_tag",
        { query: f.text },
        () => counted(state, resolveFoodTag(qloo, f.text)),
        (t) => (t ? `"${f.text}" → ${t.name}` : `"${f.text}" not found`),
      );
      looked.set(key, { tag });
    } else {
      const entity = await tracer.tryCall(
        "resolve_entity",
        { query: f.text, kind: f.kind },
        () => counted(state, resolveEntity(qloo, f.kind as Exclude<typeof f.kind, "food">, f.text)),
        (e) => (e ? `"${f.text}" → ${e.name}` : `"${f.text}" not found`),
      );
      looked.set(key, { entity });
    }
  });

  let matched = 0;
  let missing = 0;
  for (const r of state.request.residents) {
    const signals = new Map<MediaDomain, string[]>();
    const favorites: ResolvedFavorite[] = [];
    const foodTags: string[] = [];
    const warnings: string[] = [];
    for (const f of r.favorites) {
      const hit = looked.get(keyOf(f));
      if (hit?.entity) {
        matched++;
        const d = kindToDomain(f.kind) as MediaDomain;
        const list = signals.get(d) ?? [];
        if (!list.includes(hit.entity.entity_id)) list.push(hit.entity.entity_id);
        signals.set(d, list);
        state.names.set(hit.entity.entity_id, hit.entity.name);
        const { entity_id, name, type, image_url } = hit.entity;
        favorites.push({ kind: f.kind, text: f.text, status: "matched", entity: { entity_id, name, type, image_url } });
        // A resident's own favorite is always a candidate in its domain.
        if (domainsInWeek(state).has(d)) addCandidate(state, hit.entity, d, "favorite").ownedBy.add(r.id);
      } else if (hit?.tag) {
        matched++;
        if (!foodTags.includes(hit.tag.id)) foodTags.push(hit.tag.id);
        favorites.push({ kind: f.kind, text: f.text, status: "matched", tag: hit.tag });
      } else {
        missing++;
        favorites.push({ kind: f.kind, text: f.text, status: "not_found" });
        warnings.push(`Qloo could not find "${f.text}" (${f.kind}).`);
      }
    }
    // Previously loved items add to the taste signal for their domain.
    for (const id of r.loved ?? []) {
      const d = state.candidates.get(id)?.domain ?? state.known.find((k) => k.entity.entity_id === id)?.domain;
      if (d && d !== "outing") {
        const list = signals.get(d) ?? [];
        if (!list.includes(id)) list.push(id);
        signals.set(d, list);
      }
    }
    const allSignals = [...new Set([...signals.values()].flat())];
    const scorable = allSignals.length > 0 || foodTags.length > 0;
    if (!scorable) warnings.push("None of this resident's favorites matched on Qloo, so they could not be scored. Add a few more.");
    state.residents.set(r.id, {
      id: r.id,
      favorites,
      signals,
      allSignals,
      foodTags,
      declined: new Set(r.declined ?? []),
      loved: new Set(r.loved ?? []),
      scorable,
      warnings,
    });
  }
  // Entities from the previous plan (loved or kept sessions) must stay candidates, even when they
  // came from expansion, a baseline or the LLM and would not be rediscovered this run.
  for (const k of state.known) {
    if (!state.exclude.has(k.entity.entity_id) && domainsInWeek(state).has(k.domain)) addCandidate(state, k.entity, k.domain, k.source);
    state.names.set(k.entity.entity_id, k.entity.name);
  }
  // Loved items are the resident's own favorites from now on.
  for (const r of state.residents.values()) for (const id of r.loved) state.candidates.get(id)?.ownedBy.add(r.id);

  const unscorable = [...state.residents.values()].filter((r) => !r.scorable).length;
  return `${matched} favorites matched on Qloo, ${missing} not found, ${unscorable} residents unscorable`;
}

// ---------------------------------------------------------------------------
// Step 2: candidate pool
// ---------------------------------------------------------------------------

/** Signal ids for a domain across the whole group, most-shared first. */
function groupSignals(state: PipelineState, domain: MediaDomain): string[] {
  const counts = new Map<string, number>();
  for (const r of state.residents.values()) for (const id of r.signals.get(domain) ?? []) counts.set(id, (counts.get(id) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

function crossSignals(state: PipelineState): string[] {
  const counts = new Map<string, number>();
  for (const r of state.residents.values()) for (const id of r.allSignals) counts.set(id, (counts.get(id) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

export async function buildCandidates(state: PipelineState, qloo: QlooClient, tracer: Tracer): Promise<string> {
  const domains = [...domainsInWeek(state)];
  const lines: string[] = [];
  await mapLimit(domains, CONCURRENCY, async (domain) => {
    if (domain === "outing") {
      lines.push(await outingCandidates(state, qloo, tracer));
      return;
    }
    // Same-domain signals when we have them, otherwise cross-domain taste (e.g. music fans -> films).
    const same = groupSignals(state, domain);
    const signals = same.length ? same : crossSignals(state);
    if (!signals.length) {
      state.notes.push(`No ${domain} signals for this group; only the baseline list can fill ${domain} slots.`);
      return;
    }
    const exclude = [...state.exclude];
    const res = await tracer.tryCall(
      "get_recommendations",
      { domain, signals: signals.length, take: GROUP_TAKE },
      () => counted(state, qloo.insights(recommendParams(domain, signals, { exclude, city: state.request.homeCity }))),
      (r) => `${r.length} ${domain} candidates${r[0] ? `, top: ${r[0].name}` : ""}`,
    );
    for (const e of res ?? []) if (suitableForGroup(e)) addCandidate(state, e, domain, "group");
    lines.push(`${domain}: ${res?.length ?? 0}`);
  });
  const pool = [...state.candidates.values()];
  const byDomain = domains.map((d) => `${d} ${pool.filter((c) => c.domain === d).length}`).join(", ");
  return `Candidate pool: ${byDomain}`;
}

async function outingCandidates(state: PipelineState, qloo: QlooClient, tracer: Tracer): Promise<string> {
  const signals = crossSignals(state);
  const tags = [...new Set([...state.residents.values()].flatMap((r) => r.foodTags))];
  if (!signals.length && !tags.length) {
    state.notes.push("No taste signals for outings.");
    return "outing: 0";
  }
  const res = await tracer.tryCall(
    "get_outing_venues",
    { city: state.request.homeCity, signals: signals.length, tags: tags.length },
    () => counted(state, qloo.insights(outingParams(state.request.homeCity, signals, tags))),
    (r) => `${r.length} venues in ${state.request.homeCity}${r[0] ? `, top: ${r[0].name}` : ""}`,
  );
  if (!res?.length) state.notes.push(`Qloo returned no outing venues for ${state.request.homeCity}.`);
  for (const e of res ?? []) if (!state.exclude.has(e.entity_id) && suitableForGroup(e)) addCandidate(state, e, "outing", "group");
  return `outing: ${res?.length ?? 0}`;
}

/**
 * Agent tool: fetch candidates aimed at specific residents (usually the unreached ones),
 * using only their own taste signals.
 */
export async function expandForResidents(
  state: PipelineState,
  qloo: QlooClient,
  tracer: Tracer,
  residentIds: string[],
  domain: Domain,
): Promise<string> {
  const ids = residentIds.filter((id) => state.residents.get(id)?.scorable);
  if (!ids.length) return "No scorable residents in that list.";
  if (!domainsInWeek(state).has(domain)) return `This week has no ${domain} sessions.`;
  if (domain === "outing") {
    const rs = ids.map((id) => state.residents.get(id)!);
    const sig = [...new Set(rs.flatMap((r) => r.allSignals))];
    const tags = [...new Set(rs.flatMap((r) => r.foodTags))];
    const res = await tracer.tryCall(
      "get_outing_venues",
      { city: state.request.homeCity, residents: ids.length },
      () => counted(state, qloo.insights(outingParams(state.request.homeCity, sig, tags))),
      (r) => `${r.length} venues`,
    );
    let added = 0;
    for (const e of res ?? []) {
      if (state.exclude.has(e.entity_id) || state.candidates.has(e.entity_id) || !suitableForGroup(e)) continue;
      addCandidate(state, e, "outing", "expanded");
      added++;
    }
    return `${added} new outing venues added for ${ids.join(", ")}`;
  }
  const rs = ids.map((id) => state.residents.get(id)!);
  const same = [...new Set(rs.flatMap((r) => r.signals.get(domain) ?? []))];
  const signals = same.length ? same : [...new Set(rs.flatMap((r) => r.allSignals))];
  if (!signals.length) return "Those residents have no entity favorites to use as a signal.";
  const exclude = [...new Set([...state.exclude, ...state.candidates.keys()])].slice(0, 50);
  const res = await tracer.tryCall(
    "get_recommendations",
    { domain, residents: ids, signals: signals.length, take: 15 },
    () => counted(state, qloo.insights(recommendParams(domain, signals, { take: 15, exclude, city: state.request.homeCity }))),
    (r) => `${r.length} ${domain} candidates for ${ids.join(", ")}`,
  );
  let added = 0;
  for (const e of res ?? []) {
    if (state.candidates.has(e.entity_id) || state.exclude.has(e.entity_id) || !suitableForGroup(e)) continue;
    addCandidate(state, e, domain, "expanded");
    added++;
  }
  return `${added} new ${domain} candidates aimed at ${ids.join(", ")}`;
}

// ---------------------------------------------------------------------------
// Step 3: per-resident scoring (Qloo affinity, ranked)
// ---------------------------------------------------------------------------

export async function scoreAll(state: PipelineState, qloo: QlooClient, tracer: Tracer): Promise<string> {
  const jobs: { r: ResidentState; domain: Domain; ids: string[] }[] = [];
  for (const domain of domainsInWeek(state)) {
    const pool = [...state.candidates.values()].filter((c) => c.domain === domain);
    for (const r of state.residents.values()) {
      if (!r.scorable) continue;
      if (!state.slots.some((s) => s.domain === domain && s.attendees.includes(r.id))) continue;
      const todo = pool.filter((c) => !c.fit.has(r.id)).map((c) => c.entity.entity_id);
      if (!todo.length) continue;
      jobs.push({ r, domain, ids: pool.map((c) => c.entity.entity_id) });
    }
  }
  let ok = 0;
  await mapLimit(jobs, CONCURRENCY, async ({ r, domain, ids }) => {
    const done = await scoreResident(state, qloo, tracer, r, domain, ids);
    if (done) ok++;
  });
  return `Scored ${ok} of ${jobs.length} resident × session-type combinations on Qloo`;
}

async function scoreResident(
  state: PipelineState,
  qloo: QlooClient,
  tracer: Tracer,
  r: ResidentState,
  domain: Domain,
  ids: string[],
): Promise<boolean> {
  let res: QlooEntity[] | undefined;
  if (domain === "outing") {
    if (!r.allSignals.length && !r.foodTags.length) return false;
    // Same batching as media: the venue pool can exceed one call's filter.results.entities limit.
    const parts: QlooEntity[] = [];
    for (let i = 0; i < ids.length; i += SCORE_TAKE) {
      const chunk = ids.slice(i, i + SCORE_TAKE);
      const part = await tracer.tryCall(
        "score_resident",
        { resident: r.id, domain, candidates: chunk.length },
        () => counted(state, qloo.insights(outingScoreParams(state.request.homeCity, r.allSignals, r.foodTags, chunk))),
        (x) => `${r.id}: ${x.length} venues scored`,
      );
      if (!part) {
        parts.length = 0;
        res = undefined;
        break;
      }
      parts.push(...part);
      res = parts;
    }
  } else {
    const same = r.signals.get(domain) ?? [];
    const signals = same.length ? same : r.allSignals;
    if (!signals.length) return false;
    // Qloo will not score an entity against itself as a signal; owned favorites get fit 1 anyway.
    const targets = ids.filter((id) => !signals.includes(id));
    if (!targets.length) return true;
    // filter.results.entities accepts up to SCORE_TAKE ids per call; affinities share the same
    // signal set, so chunks are comparable and are ranked together below.
    const chunks: string[][] = [];
    for (let i = 0; i < targets.length; i += SCORE_TAKE) chunks.push(targets.slice(i, i + SCORE_TAKE));
    const parts: QlooEntity[] = [];
    for (const chunk of chunks) {
      const part = await tracer.tryCall(
        "score_resident",
        { resident: r.id, domain, candidates: chunk.length, crossDomain: !same.length },
        () => counted(state, qloo.insights(scoreParams(domain, signals, chunk))),
        (x) => `${r.id}: ${x.length} ${domain} candidates scored${same.length ? "" : " (cross-domain)"}`,
      );
      if (!part) {
        res = undefined;
        parts.length = 0;
        break;
      }
      parts.push(...part);
      res = parts;
    }
  }
  if (!res) {
    r.warnings.push(`Qloo scoring failed for ${domain}.`);
    return false;
  }
  const fits = rankFits(res);
  for (const e of res) {
    const c = state.candidates.get(e.entity_id);
    if (!c) continue;
    const f = fits.get(e.entity_id);
    if (f !== undefined) c.fit.set(r.id, f);
    if (e.explainability?.length) c.explain.set(r.id, e.explainability);
  }
  // Candidates Qloo did not return for this resident: no affinity -> fit 0.
  for (const id of ids) {
    const c = state.candidates.get(id);
    if (c && !c.fit.has(r.id)) c.fit.set(r.id, 0);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Step 4: baselines (same slots, same metric, no per-resident taste)
// ---------------------------------------------------------------------------

export async function buildPopularBaseline(state: PipelineState, qloo: QlooClient, tracer: Tracer): Promise<string> {
  const domains = [...domainsInWeek(state)].filter((d): d is MediaDomain => d !== "outing");
  const lists = new Map<Domain, QlooEntity[]>();
  await mapLimit(domains, CONCURRENCY, async (domain) => {
    const res = await tracer.tryCall(
      "get_baseline",
      { domain, signal: "popularity ≥ 0.5 (age 55+ hint)", take: BASELINE_TAKE },
      () => counted(state, qloo.insights(baselineParams(domain, state.request.homeCity))),
      (r) => `${r.length} popular ${domain} titles${r[0] ? `, top: ${r[0].name}` : ""}`,
    );
    // A coordinator would not schedule mature-rated titles either, so the baseline is held to the same bar.
    lists.set(domain, (res ?? []).filter((e) => !state.exclude.has(e.entity_id) && suitableForGroup(e)));
  });
  // Baseline outings: the city's top venues without any resident signal.
  if (domainsInWeek(state).has("outing")) {
    const res = await tracer.tryCall(
      "get_baseline",
      { domain: "outing", city: state.request.homeCity },
      () => counted(state, qloo.insights({ "filter.type": "urn:entity:place", "filter.location.query": state.request.homeCity, take: BASELINE_TAKE })),
      (r) => `${r.length} top venues in ${state.request.homeCity}`,
    );
    lists.set("outing", (res ?? []).filter((e) => !state.exclude.has(e.entity_id) && suitableForGroup(e)));
  }

  const missing = [...lists.entries()].filter(([, l]) => l.length === 0).map(([d]) => d);
  const all = [...lists.entries()].flatMap(([d, l]) => l.map((e) => ({ e, d })));
  if (all.length === 0) {
    state.baselines = state.baselines.filter((b) => b.key !== "popular_55");
    state.baselines.push({
      key: "popular_55",
      label: "Generic “most popular titles” calendar",
      method: "Qloo's most popular titles (popularity ≥ 0.5), with no resident data.",
      available: false,
      sessions: [],
      note: "Qloo returned no age-based results, so this comparison is unavailable.",
    });
    return "Baseline unavailable: Qloo returned no age-based results";
  }
  // Baseline items join the pool (so residents get scored on them), tagged as baseline.
  for (const { e, d } of all) addCandidate(state, e, d, state.candidates.has(e.entity_id) ? state.candidates.get(e.entity_id)!.source : "baseline");
  const ranked = all.map(({ e, d }) => ({ id: e.entity_id, domain: d, fit: new Map<string, number>() }));
  const assign = fillInOrder(state.slots, ranked, state.exclude);
  state.baselineAssignments.set("popular_55", assign);
  return `Baseline calendar: ${assign.size} of ${state.slots.length} slots filled from Qloo's most-popular lists${missing.length ? ` (none for ${missing.join(", ")})` : ""}`;
}

/** Records the LLM-only baseline: titles the model proposed without Qloo, resolved through Qloo search. */
export async function recordLlmBaseline(
  state: PipelineState,
  qloo: QlooClient,
  tracer: Tracer,
  proposals: { slotId: string; title: string }[],
): Promise<string> {
  const slotById = new Map(state.slots.map((s) => [s.id, s]));
  const assign = new Map<string, string>();
  const unresolved: string[] = [];
  await mapLimit(proposals, CONCURRENCY, async (p) => {
    const slot = slotById.get(p.slotId);
    if (!slot || slot.domain === "outing") return;
    const e = await tracer.tryCall(
      "resolve_entity",
      { query: p.title, kind: slot.domain, purpose: "llm baseline" },
      () => counted(state, resolveEntity(qloo, slot.domain as MediaDomain, p.title)),
      (x) => (x ? `"${p.title}" → ${x.name}` : `"${p.title}" not found`),
    );
    if (!e) {
      unresolved.push(p.title);
      return;
    }
    const c = addCandidate(state, e, slot.domain, state.candidates.get(e.entity_id)?.source ?? "llm_only");
    if (![...assign.values()].includes(c.entity.entity_id)) assign.set(p.slotId, c.entity.entity_id);
  });
  state.baselineAssignments.set("llm_only", assign);
  if (unresolved.length) state.notes.push(`LLM-only baseline: Qloo could not find ${unresolved.length} proposed title(s).`);
  return `LLM-only calendar: ${assign.size} slots resolved on Qloo`;
}

function baselineMetrics(state: PipelineState) {
  const residents = scoredResidents(state);
  const cands = engineCandidates(state);
  const out: BaselineComparison[] = [];
  const pop = state.baselineAssignments.get("popular_55");
  const prevPop = state.baselines.find((b) => b.key === "popular_55");
  if (pop) {
    out.push({
      key: "popular_55",
      label: "Generic “most popular titles” calendar",
      method: "Same slots, filled in order with Qloo's most popular titles (popularity ≥ 0.5) (and the city's top venues for outings). No resident data. Scored with the same per-resident Qloo fits.",
      available: true,
      metrics: metricsWithDiscovery(state, pop),
      sessions: [...pop.entries()].map(([slotId, id]) => ({ slotId, entityId: id, name: state.names.get(id) ?? id })),
    });
  } else if (prevPop) out.push(prevPop);
  const llm = state.baselineAssignments.get("llm_only");
  if (llm) {
    out.push({
      key: "llm_only",
      label: "Same AI, no Qloo",
      method: "The language model proposed a calendar from the residents' favorites without any Qloo data. Titles were then looked up on Qloo and scored with the same per-resident fits.",
      available: llm.size > 0,
      metrics: llm.size > 0 ? metricsWithDiscovery(state, llm) : undefined,
      sessions: [...llm.entries()].map(([slotId, id]) => ({ slotId, entityId: id, name: state.names.get(id) ?? id })),
      ...(llm.size === 0 ? { note: "None of the model's proposals could be found on Qloo." } : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Step 5: optimize
// ---------------------------------------------------------------------------

export function runOptimizer(state: PipelineState): { metrics: Metrics; unreached: string[] } {
  const residents = scoredResidents(state);
  const candidates = engineCandidates(state);
  const input = { slots: state.slots, candidates, residents, locked: state.locked, exclude: state.exclude };
  // Seeding with the baselines guarantees the result is never worse than a baseline on the same pool.
  const seeds = [...state.baselineAssignments.values()];
  if (state.assignment) seeds.push(state.assignment);
  const res = optimizeBest(input, seeds);
  state.assignment = res.bySlot;
  state.metrics = metricsWithDiscovery(state, res.bySlot);
  state.optimizerRuns++;
  return { metrics: state.metrics, unreached: unreached(res, input) };
}

// ---------------------------------------------------------------------------
// Step 6: details (related items, 1:1 plans)
// ---------------------------------------------------------------------------

export async function fetchRelated(state: PipelineState, qloo: QlooClient, tracer: Tracer): Promise<void> {
  if (!state.assignment) return;
  const jobs = [...state.assignment.entries()]
    .map(([, id]) => state.candidates.get(id))
    .filter((c): c is CandidateState => !!c && c.domain !== "outing" && c.related.length === 0);
  await mapLimit(jobs, CONCURRENCY, async (c) => {
    const res = await tracer.tryCall(
      "get_related",
      { entity: c.entity.name, domain: c.domain },
      () => counted(state, qloo.insights(recommendParams(c.domain as MediaDomain, [c.entity.entity_id], { take: RELATED_TAKE, exclude: [c.entity.entity_id] }))),
      (r) => `${r.length} related to ${c.entity.name}`,
    );
    c.related = (res ?? []).slice(0, RELATED_TAKE);
    for (const e of c.related) state.names.set(e.entity_id, e.name);
  });
}

/** 1:1 visit plan for each unreached resident: their own top Qloo matches across domains. */
export async function buildOneToOnes(state: PipelineState, qloo: QlooClient, tracer: Tracer, ids?: string[]): Promise<string> {
  if (!state.assignment) return "Run the optimizer first.";
  const residents = scoredResidents(state);
  const candidates = engineCandidates(state);
  const targets = ids ?? unreached({ bySlot: state.assignment, metrics: state.metrics! }, { slots: state.slots, candidates, residents });
  const unscored = [...state.residents.values()].filter((r) => !r.scorable).map((r) => r.id);
  await mapLimit(targets, CONCURRENCY, async (id) => {
    const r = state.residents.get(id);
    if (!r || !r.scorable) return;
    const picks: QlooEntity[] = [];
    // Their own favorites first (staff can play/show those directly), then Qloo recommendations.
    const domains = DOMAINS.filter((d): d is MediaDomain => d !== "outing");
    for (const d of domains) {
      const sig = r.signals.get(d) ?? [];
      if (!sig.length) continue;
      const res = await tracer.tryCall(
        "get_one_to_one",
        { resident: id, domain: d },
        () => counted(state, qloo.insights(recommendParams(d, sig, { take: 4, exclude: sig, explain: true }))),
        (x) => `${x.length} ${d} picks for ${id}`,
      );
      for (const e of (res ?? []).filter((e) => !r.declined.has(e.entity_id)).slice(0, 2)) {
        picks.push(e);
        state.names.set(e.entity_id, e.name);
      }
      if (picks.length >= ONE_TO_ONE_TAKE) break;
    }
    if (!picks.length) return;
    const favs = r.favorites.filter((f) => f.status === "matched").map((f) => f.entity?.name ?? f.tag?.name).filter(Boolean);
    state.oneToOne.set(id, {
      picks: picks.slice(0, ONE_TO_ONE_TAKE),
      note: `Group sessions this week don't reach this resident well. Suggested 1:1 visit built from their own favorites (${favs.slice(0, 3).join(", ")}).`,
    });
  });
  return `1:1 plans for ${state.oneToOne.size} residents${unscored.length ? `; ${unscored.length} unscorable residents need more favorites` : ""}`;
}

// ---------------------------------------------------------------------------
// Explanations (from Qloo explainability, never invented)
// ---------------------------------------------------------------------------

export function whyFor(state: PipelineState, c: CandidateState, residentId: string): string {
  if (c.ownedBy.has(residentId)) {
    const r = state.residents.get(residentId);
    return r?.loved.has(c.entity.entity_id) ? "Enjoyed this in a past session." : "One of their stated favorites.";
  }
  const ex = (c.explain.get(residentId) ?? [])
    .filter((x) => x.score >= 0.1 && state.names.has(x.entity_id))
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
    .map((x) => state.names.get(x.entity_id)!);
  const fit = c.fit.get(residentId) ?? 0;
  const rank = `Top ${Math.max(1, Math.round((1 - fit) * 100))}% of this week's options for them`;
  return ex.length ? `${rank}; Qloo links it to their love of ${ex.join(" and ")}.` : `${rank} on Qloo taste affinity.`;
}

// ---------------------------------------------------------------------------
// Snapshot for the agent (compact, ids are aliases)
// ---------------------------------------------------------------------------

export function snapshot(state: PipelineState) {
  const cands = engineCandidates(state);
  const candMap = new Map(cands.map((c) => [c.id, c]));
  const slotReq = new Map(state.request.slots.map((s) => [s.id, s]));
  return {
    metrics: state.metrics,
    slots: state.slots.map((s) => {
      const cid = state.assignment?.get(s.id);
      const c = cid ? state.candidates.get(cid) : undefined;
      const ec = cid ? candMap.get(cid) : undefined;
      const matches = ec ? s.attendees.filter((r) => fitOf(ec, r) >= REACH_THRESHOLD) : [];
      return {
        slot: s.id,
        when: `${slotReq.get(s.id)?.day} ${slotReq.get(s.id)?.time}`,
        type: s.domain,
        pick: c ? clip(c.entity.name, 60) : null,
        attendees: s.attendees.length,
        strong_matches: matches,
      };
    }),
    unreached: state.assignment && state.metrics
      ? unreached({ bySlot: state.assignment, metrics: state.metrics }, { slots: state.slots, candidates: cands, residents: scoredResidents(state) })
      : [],
    unscorable: [...state.residents.values()].filter((r) => !r.scorable).map((r) => r.id),
    pool: Object.fromEntries([...domainsInWeek(state)].map((d) => [d, cands.filter((c) => c.domain === d).length])),
    baselines: baselineMetrics(state).map((b) => ({ key: b.key, metrics: b.metrics ?? null })),
  };
}

// ---------------------------------------------------------------------------
// Finalize
// ---------------------------------------------------------------------------

const DAY_NAMES: Record<string, string> = { Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday", Sat: "Saturday", Sun: "Sunday" };
/**
 * True when a written title names the scheduled entity exactly (a leading "The" may be dropped),
 * e.g. "Beatles sing-along" for "The Beatles". Generic names like "Family" must not be folded into
 * prose ("Family Favorites"), so a one-word name must stand on its own.
 */
export function namesEntity(title: string, name: string): boolean {
  const core = name.trim().replace(/^the\s+/i, "");
  if (!core) return true;
  const esc = core.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const oneWord = !/\s/.test(core);
  // One-word names must not run on into another capitalized word ("Family Favorites").
  const after = oneWord ? "(?![\\p{L}\\p{N}]|\\s+\\p{Lu})" : "(?![\\p{L}\\p{N}])";
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])${esc}${after}`, "u");
  return re.test(title);
}

const DOMAIN_NOUN: Record<Domain, string> = {
  music: "Music hour",
  film: "Film afternoon",
  tv: "Classic TV",
  books: "Reading circle",
  gaming: "Games club",
  sports: "Sports social",
  outing: "Outing",
};

export function buildPlan(state: PipelineState, now: Date = new Date()): WeekPlan {
  if (!state.assignment || !state.metrics) throw new Error("Optimizer has not run");
  const cands = engineCandidates(state);
  const candMap = new Map(cands.map((c) => [c.id, c]));
  const reqSlots = new Map(state.request.slots.map((s) => [s.id, s]));

  const sessions: ScheduledSession[] = [];
  for (const s of state.slots) {
    const cid = state.assignment.get(s.id);
    const c = cid ? state.candidates.get(cid) : undefined;
    const rs = reqSlots.get(s.id)!;
    if (!c) {
      state.notes.push(`${DAY_NAMES[rs.day]} ${rs.time}: no ${s.domain} candidate was available, so this slot is open.`);
      continue;
    }
    const ec = candMap.get(c.entity.entity_id)!;
    const fits = s.attendees.map((r) => fitOf(ec, r));
    const matches: SessionMatch[] = s.attendees
      .map((r) => ({ residentId: r, fit: fitOf(ec, r), ownFavorite: c.ownedBy.has(r), why: whyFor(state, c, r) }))
      .filter((m) => m.ownFavorite || m.fit >= REACH_THRESHOLD)
      .sort((a, b) => b.fit - a.fit);
    sessions.push({
      slotId: s.id,
      day: rs.day,
      time: rs.time,
      domain: s.domain,
      entity: slimEntity(c.entity),
      source: c.source,
      related: c.related.map(slimEntity),
      attendees: s.attendees,
      matches,
      meanFit: fits.length ? Math.round((fits.reduce((a, b) => a + b, 0) / fits.length) * 1000) / 1000 : 0,
      ...(() => {
        const fresh = state.writtenFor.get(s.id) === c.entity.entity_id;
        const written = fresh ? state.titles.get(s.id) : undefined;
        return {
          // The written title must name what is actually scheduled; otherwise staff cannot tell what to play.
          title: (written && namesEntity(written, c.entity.name) && written) || `${DOMAIN_NOUN[s.domain]}: ${c.entity.name}`,
          brief: (fresh && state.briefs.get(s.id)) || templateBrief(state, c, matches.length, s.attendees.length),
        };
      })(),
    });
  }

  const residents: ResidentOutcome[] = [...state.residents.values()].map((r) => {
    const attend = state.slots.filter((s) => s.attendees.includes(r.id) && state.assignment!.has(s.id));
    const list = attend
      .map((s) => {
        const c = state.candidates.get(state.assignment!.get(s.id)!)!;
        const ec = candMap.get(c.entity.entity_id)!;
        return { slotId: s.id, fit: fitOf(ec, r.id), ownFavorite: c.ownedBy.has(r.id), why: whyFor(state, c, r.id) };
      })
      .sort((a, b) => b.fit - a.fit);
    const best = bestFor(r.id, state.assignment!, state.slots, candMap);
    const reached = r.scorable && best.fit >= REACH_THRESHOLD;
    const outcome: ResidentOutcome = {
      residentId: r.id,
      scorable: r.scorable,
      reached,
      bestFit: best.fit,
      ...(best.slotId ? { bestSlotId: best.slotId } : {}),
      sessions: list,
      favorites: r.favorites,
      careNote: "",
      warnings: [...r.warnings],
    };
    const oo = state.oneToOne.get(r.id);
    if (oo) outcome.oneToOne = oo;
    if (!attend.length) outcome.warnings.push("Not available for any scheduled session this week.");
    outcome.careNote = careNote(state, outcome, reqSlots);
    return outcome;
  });

  return {
    id: randomUUID(),
    createdAt: now.toISOString(),
    request: state.request,
    sessions,
    residents,
    metrics: state.metrics,
    baselines: baselineMetrics(state),
    summary: state.summary ?? templateSummary(state),
    newsletter: state.newsletter ?? templateNewsletter(sessions),
    notes: [...new Set(state.notes)],
    qlooRequests: state.qlooRequests,
    optimizerRuns: state.optimizerRuns,
  };
}

/** Qloo returns ~250 tags per entity; the plan only ever shows a handful, so keep saved plans small. */
const PLAN_TAGS = 8;
export function slimEntity(e: QlooEntity): QlooEntity {
  const { explainability: _x, tags, ...rest } = e;
  return tags ? { ...rest, tags: tags.slice(0, PLAN_TAGS) } : rest;
}

function templateBrief(state: PipelineState, c: CandidateState, strong: number, total: number): string {
  const lines = [`**${c.entity.name}**${strong ? ` is a strong match for ${strong} of ${total} residents who can attend.` : "."}`];
  if (c.related.length) lines.push(`- Fill the hour with: ${c.related.slice(0, 4).map((e) => e.name).join(", ")} (Qloo: related titles).`);
  const tags = c.entity.tags?.slice(0, 3).map((t) => t.name);
  if (tags?.length) lines.push(`- Qloo tags: ${tags.join(", ")}.`);
  return lines.join("\n");
}

function careNote(state: PipelineState, o: ResidentOutcome, reqSlots: Map<string, PlanRequest["slots"][number]>): string {
  if (!o.scorable) return "Preferences not yet matched on Qloo; record more specific favorites (artists, films, shows) at next review.";
  const favs = o.favorites.filter((f) => f.status === "matched").map((f) => f.entity?.name ?? f.tag?.name);
  const top = o.sessions.filter((s) => s.ownFavorite || s.fit >= REACH_THRESHOLD).slice(0, 3);
  const when = top
    .map((s) => {
      const r = reqSlots.get(s.slotId)!;
      const c = state.candidates.get(state.assignment!.get(s.slotId)!);
      return `${c?.entity.name} (${DAY_NAMES[r.day]} ${r.time})`;
    })
    .join("; ");
  const parts = [`Documented preferences: ${favs.slice(0, 5).join(", ")}.`];
  parts.push(when ? `Invited to sessions matched to these preferences: ${when}.` : "No group session this week closely matches these preferences.");
  if (o.oneToOne) parts.push(`1:1 visit planned with ${o.oneToOne.picks.slice(0, 3).map((p) => p.name).join(", ")}.`);
  return parts.join(" ");
}

function templateSummary(state: PipelineState): string {
  const m = state.metrics!;
  const lines = [`**${m.reached} of ${m.total} residents** have at least one strongly matched session this week.`];
  const pop = state.baselineAssignments.get("popular_55");
  if (pop) {
    const b = computeMetrics(pop, state.slots, engineCandidates(state), scoredResidents(state));
    lines.push(`- A generic popular-titles calendar would reach ${b.reached} of ${b.total}.`);
  }
  const un = m.total - m.reached;
  if (un > 0) lines.push(`- ${un} residents get a 1:1 visit plan built from their own favorites.`);
  return lines.join("\n");
}

function templateNewsletter(sessions: ScheduledSession[]): string {
  const lines = ["**This week at home**", ""];
  for (const s of sessions) lines.push(`- ${DAY_NAMES[s.day]} ${s.time}: ${s.title}`);
  return lines.join("\n");
}

export { errMsg };
