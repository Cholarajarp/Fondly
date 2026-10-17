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
  type YearRange,
  youthYears,
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
  OUTING_TAKE,
  RELATED_TAKE,
  SCORE_TAKE,
  baselineParams,
  kindToDomain,
  outingParams,
  outingScoreParams,
  rankFits,
  recommendParams,
  resolveEntity,
  resolveFavorite,
  resolveFoodTag,
  scoreParams,
  suitableForGroup,
  ERA_DOMAINS,
  inYears,
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
  /** Genre tag ids per domain from favorites like "big band" or "westerns" (taste signal). */
  genreTags: Map<MediaDomain, string[]>;
  /** All genre tag ids across domains (cross-domain fallback). */
  allGenreTags: string[];
  /** Release years of their teens and twenties, from their own or the home's birth year. */
  youth?: YearRange;
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
  /** Session types whose group pool was fetched, with the pool size used. */
  fetched: Map<Domain, number>;
  /** Agent revisions (revise_plan). Pins never bypass availability, opt-outs or declines. */
  pins: Map<string, string>;
  /** Candidate ids the agent removed from the whole week. */
  weekBans: Set<string>;
  /** slotId -> candidate ids the agent removed from that slot. */
  slotBans: Map<string, Set<string>>;
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
    fetched: new Map(),
    pins: new Map(),
    weekBans: new Set(),
    slotBans: new Map(),
  };
}

export const domainsInWeek = (state: PipelineState): Set<Domain> => new Set(state.request.slots.map((s) => s.domain));

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
      // Genres ("big band", "westerns") resolve to Qloo genre tags, titles and names to entities.
      const hit = await tracer.tryCall(
        "resolve_entity",
        { query: f.text, kind: f.kind },
        () => counted(state, resolveFavorite(qloo, f.kind as Exclude<typeof f.kind, "food">, f.text)),
        (h) => (h?.entity ? `"${f.text}" → ${h.entity.name}` : h?.tag ? `"${f.text}" → genre ${h.tag.name}` : `"${f.text}" not found`),
      );
      looked.set(key, hit ?? {});
    }
  });
  const defaultYouth = state.request.defaultBirthYear ? youthYears(state.request.defaultBirthYear) : undefined;

  let matched = 0;
  let missing = 0;
  for (const r of state.request.residents) {
    const signals = new Map<MediaDomain, string[]>();
    const favorites: ResolvedFavorite[] = [];
    const foodTags: string[] = [];
    const genreTags = new Map<MediaDomain, string[]>();
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
        const d = kindToDomain(f.kind) as MediaDomain | undefined;
        const list = d ? (genreTags.get(d) ?? []) : foodTags;
        if (!list.includes(hit.tag.id)) list.push(hit.tag.id);
        if (d) genreTags.set(d, list);
        // Explainability can cite a genre signal by tag id ("their love of Westerns").
        if (d) state.names.set(hit.tag.id, hit.tag.name);
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
    const allGenreTags = [...new Set([...genreTags.values()].flat())];
    const scorable = allSignals.length > 0 || foodTags.length > 0 || allGenreTags.length > 0;
    if (!scorable) warnings.push("None of this resident's favorites matched on Qloo, so they could not be scored. Add a few more.");
    const youth = r.birthYear ? youthYears(r.birthYear) : defaultYouth;
    state.residents.set(r.id, {
      id: r.id,
      favorites,
      signals,
      allSignals,
      foodTags,
      genreTags,
      allGenreTags,
      ...(youth ? { youth } : {}),
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

/** Genre tag ids for a domain across the group, most-shared first. */
function groupGenreTags(state: PipelineState, domain: MediaDomain): string[] {
  const counts = new Map<string, number>();
  for (const r of state.residents.values()) for (const id of r.genreTags.get(domain) ?? []) counts.set(id, (counts.get(id) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

function crossGenreTags(state: PipelineState): string[] {
  const counts = new Map<string, number>();
  for (const r of state.residents.values()) for (const id of r.allGenreTags) counts.set(id, (counts.get(id) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

/**
 * The group's shared youth window: the median resident's teens-and-twenties years. A median keeps
 * one much older or younger resident from shifting the window for everyone.
 */
export function groupYouth(rs: Iterable<ResidentState>): YearRange | undefined {
  const ranges = [...rs].map((r) => r.youth).filter((y): y is YearRange => !!y).sort((a, b) => a.from - b.from);
  return ranges[Math.floor((ranges.length - 1) / 2)];
}

/**
 * Reminiscence bump: an extra, era-filtered query for film and TV, added alongside the taste query
 * (never replacing it) so the pool keeps its breadth. If Qloo rejects or ignores the filter, the
 * regular pool still stands and a note says so.
 */
async function eraCandidates(
  state: PipelineState,
  qloo: QlooClient,
  tracer: Tracer,
  domain: MediaDomain,
  signals: string[],
  tags: string[],
  take: number,
  residents: Iterable<ResidentState> = state.residents.values(),
  source: CandidateSource = "group",
): Promise<number> {
  const years = ERA_DOMAINS.has(domain) ? groupYouth(residents) : undefined;
  if (!years) return 0;
  const exclude = [...new Set([...state.exclude, ...state.candidates.keys()])].slice(0, 50);
  const res = await tracer.tryCall(
    "get_era_recommendations",
    { domain, years: `${years.from}-${years.to}`, signals: signals.length, take },
    () => counted(state, qloo.insights(recommendParams(domain, signals, { take, exclude, tags, years }))),
    (r) => `${r.length} ${domain} titles from ${years.from}-${years.to}${r[0] ? `, top: ${r[0].name}` : ""}`,
  );
  if (!res) {
    state.notes.push(`Qloo did not return ${domain} titles for the residents' youth (${years.from}-${years.to}); the pool uses taste alone.`);
    return 0;
  }
  let added = 0;
  // Only keep titles Qloo dates inside the window, in case the filter is ever silently ignored.
  for (const e of res) {
    if (!inYears(e, years) || state.candidates.has(e.entity_id) || state.exclude.has(e.entity_id) || !suitableForGroup(e)) continue;
    addCandidate(state, e, domain, source);
    added++;
  }
  return added;
}

/** Bounds for agent-chosen pool sizes (Qloo budget and optimizer time). */
export const POOL_TAKE_MIN = 5;
export const POOL_TAKE_MAX = 40;

export interface CandidateOptions {
  /** Session types to fetch (default: every type in the week). Types already fetched at this size or larger are skipped. */
  domains?: Domain[];
  /** Pool size per session type (default GROUP_TAKE, OUTING_TAKE for outings). */
  take?: number;
}

/** Session types in the week whose group pool has not been fetched yet. */
export const unfetchedDomains = (state: PipelineState): Domain[] => [...domainsInWeek(state)].filter((d) => !state.fetched.has(d));

export async function buildCandidates(state: PipelineState, qloo: QlooClient, tracer: Tracer, opts: CandidateOptions = {}): Promise<string> {
  const week = domainsInWeek(state);
  const asked = opts.domains?.length ? [...new Set(opts.domains)] : [...week];
  const notInWeek = asked.filter((d) => !week.has(d));
  const take = (d: Domain) => Math.max(POOL_TAKE_MIN, Math.min(POOL_TAKE_MAX, opts.take ?? (d === "outing" ? OUTING_TAKE : GROUP_TAKE)));
  const domains = asked.filter((d) => week.has(d) && (state.fetched.get(d) ?? -1) < take(d));
  const skipped = asked.filter((d) => week.has(d) && !domains.includes(d));
  await mapLimit(domains, CONCURRENCY, async (domain) => {
    state.fetched.set(domain, take(domain));
    if (domain === "outing") {
      await outingCandidates(state, qloo, tracer, take(domain));
      return;
    }
    // Same-domain signals when we have them, otherwise cross-domain taste (e.g. music fans -> films).
    const sameIds = groupSignals(state, domain);
    const sameTags = groupGenreTags(state, domain);
    const same = sameIds.length || sameTags.length;
    const signals = same ? sameIds : crossSignals(state);
    const tags = same ? sameTags : crossGenreTags(state);
    if (!signals.length && !tags.length) {
      state.notes.push(`No ${domain} signals for this group; only the baseline list can fill ${domain} slots.`);
      return;
    }
    const exclude = [...state.exclude];
    const res = await tracer.tryCall(
      "get_recommendations",
      { domain, signals: signals.length, ...(tags.length ? { genres: tags.length } : {}), take: take(domain) },
      () => counted(state, qloo.insights(recommendParams(domain, signals, { take: take(domain), exclude, city: state.request.homeCity, tags }))),
      (r) => `${r.length} ${domain} candidates${r[0] ? `, top: ${r[0].name}` : ""}`,
    );
    for (const e of res ?? []) if (suitableForGroup(e)) addCandidate(state, e, domain, "group");
    await eraCandidates(state, qloo, tracer, domain, signals, tags, Math.max(POOL_TAKE_MIN, Math.ceil(take(domain) / 2)));
  });
  const pool = [...state.candidates.values()];
  const byDomain = [...week].map((d) => `${d} ${pool.filter((c) => c.domain === d).length}`).join(", ");
  const extra = [
    skipped.length ? `already fetched: ${skipped.join(", ")}` : "",
    notInWeek.length ? `not in this week: ${notInWeek.join(", ")}` : "",
    unfetchedDomains(state).length ? `still unfetched: ${unfetchedDomains(state).join(", ")}` : "",
  ].filter(Boolean);
  return `Candidate pool: ${byDomain}${extra.length ? ` (${extra.join("; ")})` : ""}`;
}

async function outingCandidates(state: PipelineState, qloo: QlooClient, tracer: Tracer, take = OUTING_TAKE): Promise<string> {
  const signals = crossSignals(state);
  const tags = [...new Set([...state.residents.values()].flatMap((r) => r.foodTags))];
  if (!signals.length && !tags.length) {
    state.notes.push("No taste signals for outings.");
    return "outing: 0";
  }
  const res = await tracer.tryCall(
    "get_outing_venues",
    { city: state.request.homeCity, signals: signals.length, tags: tags.length, take },
    () => counted(state, qloo.insights({ ...outingParams(state.request.homeCity, signals, tags), take })),
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
  take = 15,
): Promise<string> {
  take = Math.max(POOL_TAKE_MIN, Math.min(POOL_TAKE_MAX, take));
  const ids = residentIds.filter((id) => state.residents.get(id)?.scorable);
  if (!ids.length) return "No scorable residents in that list.";
  if (!domainsInWeek(state).has(domain)) return `This week has no ${domain} sessions.`;
  if (domain === "outing") {
    const rs = ids.map((id) => state.residents.get(id)!);
    const sig = [...new Set(rs.flatMap((r) => r.allSignals))];
    const tags = [...new Set(rs.flatMap((r) => r.foodTags))];
    const res = await tracer.tryCall(
      "get_outing_venues",
      { city: state.request.homeCity, residents: ids.length, take },
      () => counted(state, qloo.insights({ ...outingParams(state.request.homeCity, sig, tags), take })),
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
  const sameIds = [...new Set(rs.flatMap((r) => r.signals.get(domain) ?? []))];
  const sameTags = [...new Set(rs.flatMap((r) => r.genreTags.get(domain) ?? []))];
  const same = sameIds.length || sameTags.length;
  const signals = same ? sameIds : [...new Set(rs.flatMap((r) => r.allSignals))];
  const tags = same ? sameTags : [...new Set(rs.flatMap((r) => r.allGenreTags))];
  if (!signals.length && !tags.length) return "Those residents have no entity or genre favorites to use as a signal.";
  const exclude = [...new Set([...state.exclude, ...state.candidates.keys()])].slice(0, 50);
  const res = await tracer.tryCall(
    "get_recommendations",
    { domain, residents: ids, signals: signals.length, ...(tags.length ? { genres: tags.length } : {}), take },
    () => counted(state, qloo.insights(recommendParams(domain, signals, { take, exclude, city: state.request.homeCity, tags }))),
    (r) => `${r.length} ${domain} candidates for ${ids.join(", ")}`,
  );
  let added = 0;
  for (const e of res ?? []) {
    if (state.candidates.has(e.entity_id) || state.exclude.has(e.entity_id) || !suitableForGroup(e)) continue;
    addCandidate(state, e, domain, "expanded");
    added++;
  }
  // Titles from these residents' youth, for film and TV.
  const era = await eraCandidates(state, qloo, tracer, domain, signals, tags, Math.max(POOL_TAKE_MIN, Math.ceil(take / 2)), rs, "expanded");
  return `${added + era} new ${domain} candidates aimed at ${ids.join(", ")}${era ? ` (${era} from their youth)` : ""}`;
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

/** Affinity added to titles from a resident's youth before ranking: enough to break near-ties, not to outrank clear taste. */
export const YOUTH_BOOST = 0.03;

/**
 * Soft reminiscence bump for film and TV: titles released in the resident's teens and twenties
 * rank a little higher among this week's options. Titles Qloo gives no year are left as they are.
 */
function eraBoosted(state: PipelineState, r: ResidentState, domain: Domain, scored: QlooEntity[]): QlooEntity[] {
  if (!r.youth || domain === "outing" || !ERA_DOMAINS.has(domain)) return scored;
  return scored.map((e) => {
    const year = state.candidates.get(e.entity_id)?.entity ?? e;
    return typeof e.affinity === "number" && (inYears(year, r.youth) || inYears(e, r.youth)) ? { ...e, affinity: e.affinity + YOUTH_BOOST } : e;
  });
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
    const sameIds = r.signals.get(domain) ?? [];
    const sameTags = r.genreTags.get(domain) ?? [];
    const sameDomain = sameIds.length > 0 || sameTags.length > 0;
    const signals = sameDomain ? sameIds : r.allSignals;
    const tags = sameDomain ? sameTags : r.allGenreTags;
    if (!signals.length && !tags.length) return false;
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
        { resident: r.id, domain, candidates: chunk.length, crossDomain: !sameDomain, ...(tags.length ? { genres: tags.length } : {}) },
        () => counted(state, qloo.insights(scoreParams(domain, signals, chunk, tags))),
        (x) => `${r.id}: ${x.length} ${domain} candidates scored${sameDomain ? "" : " (cross-domain)"}`,
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
  const fits = rankFits(eraBoosted(state, r, domain, res));
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
  // Agent pins act like locks (edit-mode locks win); agent week bans act like exclusions.
  const locked = new Map([...state.pins, ...state.locked]);
  const exclude = new Set([...state.exclude, ...state.weekBans]);
  const input = { slots: state.slots, candidates, residents, locked, exclude, slotBans: state.slotBans };
  // Seeding with the baselines guarantees the result is never worse than a baseline on the same pool.
  // The current schedule wins ties, so re-runs keep picks (and the briefs written for them) unless the
  // objective improves.
  const seeds = [...state.baselineAssignments.values()];
  const res = optimizeBest(input, seeds, state.assignment ?? undefined);
  state.assignment = res.bySlot;
  state.metrics = metricsWithDiscovery(state, res.bySlot);
  state.optimizerRuns++;
  return { metrics: state.metrics, unreached: unreached(res, input) };
}

// ---------------------------------------------------------------------------
// Step 5b: self-critique (inspect) and agent revisions
// ---------------------------------------------------------------------------

/** Fit below this for every attendee marks a slot as weak. */
const LOW_SLOT_FIT = 0.5;
const normTitle = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\(.*?\)/g, " ")
    .replace(/^the\s+/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * Compact diagnostics of the current schedule for the agent's self-critique. Every number comes
 * from Qloo fits and the optimizer; candidate ids are the only handles revise_plan accepts.
 */
export function inspectPlan(state: PipelineState) {
  if (!state.assignment || !state.metrics) throw new Error("Run the optimizer first.");
  const assignment = state.assignment;
  const cands = engineCandidates(state);
  const candMap = new Map(cands.map((c) => [c.id, c]));
  const residents = scoredResidents(state);
  const slotReq = new Map(state.request.slots.map((s) => [s.id, s]));
  const used = new Set(assignment.values());
  const blockedWeek = new Set([...state.exclude, ...state.weekBans]);

  const best = residents
    .map((r) => ({ resident: r, ...bestFor(r, assignment, state.slots, candMap) }))
    .sort((a, b) => a.fit - b.fit);
  // For the weakest residents: unused pool items they would love, and which slots could take them.
  const weakest = best.slice(0, 5).map((b) => {
    const options = cands
      .filter((c) => !used.has(c.id) && !blockedWeek.has(c.id) && fitOf(c, b.resident) >= REACH_THRESHOLD)
      .map((c) => ({
        c,
        fit: fitOf(c, b.resident),
        slots: state.slots
          .filter((s) => s.domain === c.domain && s.attendees.includes(b.resident) && !state.locked.has(s.id) && !state.slotBans.get(s.id)?.has(c.id))
          .map((s) => s.id),
      }))
      .filter((o) => o.slots.length)
      .sort((x, y) => y.fit - x.fit)
      .slice(0, 3)
      .map((o) => ({ candidate_id: o.c.id, name: clip(state.names.get(o.c.id) ?? o.c.id, 60), type: o.c.domain, fit: o.fit, fits_slots: o.slots }));
    return { resident: b.resident, best_fit: b.fit, best_slot: b.slotId ?? null, unused_strong_options: options };
  });

  const slots = state.slots.map((s) => {
    const cid = assignment.get(s.id);
    const ec = cid ? candMap.get(cid) : undefined;
    const fits = ec ? s.attendees.filter((r) => residents.includes(r)).map((r) => fitOf(ec, r)) : [];
    const mean = fits.length ? round3(fits.reduce((a, b) => a + b, 0) / fits.length) : 0;
    return {
      slot: s.id,
      type: s.domain,
      candidate_id: cid ?? null,
      pick: cid ? clip(state.names.get(cid) ?? cid, 60) : null,
      strong_matches: fits.filter((f) => f >= REACH_THRESHOLD - 1e-9).length,
      mean_fit: mean,
      max_fit: fits.length ? Math.max(...fits) : 0,
      pinned: state.pins.has(s.id) || state.locked.has(s.id),
    };
  });
  const lowFit = slots.filter((s) => !s.pick || s.strong_matches === 0 || s.max_fit < LOW_SLOT_FIT).map((s) => s.slot);

  // Near-duplicates: titles that normalize to the same words, or one contains the other.
  const picked = slots.filter((s) => s.candidate_id).map((s) => ({ slot: s.slot, n: normTitle(state.names.get(s.candidate_id!) ?? "") }));
  const duplicates: string[][] = [];
  for (let i = 0; i < picked.length; i++) {
    for (let j = i + 1; j < picked.length; j++) {
      const a = picked[i]!.n;
      const b = picked[j]!.n;
      if (a && b && (a === b || (Math.min(a.length, b.length) >= 4 && (a.includes(b) || b.includes(a))))) duplicates.push([picked[i]!.slot, picked[j]!.slot]);
    }
  }
  // Over-representation: one origin dominating (e.g. half the week is residents' own favorites), or
  // one session type taking more than half the week.
  const bySource = new Map<string, number>();
  const byType = new Map<string, number>();
  for (const cid of assignment.values()) {
    const c = state.candidates.get(cid);
    if (!c) continue;
    bySource.set(c.source, (bySource.get(c.source) ?? 0) + 1);
    byType.set(c.domain, (byType.get(c.domain) ?? 0) + 1);
  }
  const half = Math.max(2, Math.ceil(assignment.size / 2));
  const overRepresented = [
    ...[...byType.entries()].filter(([, n]) => n > half).map(([t, n]) => `type ${t}: ${n} of ${assignment.size} sessions`),
    ...[...bySource.entries()].filter(([, n]) => n > half).map(([s, n]) => `source ${s}: ${n} of ${assignment.size} sessions`),
  ];

  const baselines = baselineMetrics(state)
    .filter((b) => b.metrics)
    .map((b) => ({ key: b.key, reached: b.metrics!.reached, min_fit: b.metrics!.minBest, reach_gain: state.metrics!.reached - b.metrics!.reached }));

  return {
    metrics: state.metrics,
    resident_best_fit: Object.fromEntries(best.map((b) => [b.resident, b.fit])),
    weakest,
    low_fit_slots: lowFit,
    slots,
    near_duplicates: duplicates,
    over_represented: overRepresented,
    unfetched_types: unfetchedDomains(state),
    baselines,
    revisions: { pins: Object.fromEntries(state.pins), week_excluded: [...state.weekBans], slot_excluded: Object.fromEntries([...state.slotBans].map(([k, v]) => [k, [...v]])) },
  };
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export interface Revision {
  exclude?: { candidate_id: string; slot_id?: string | null }[];
  pin?: { slot_id: string; candidate_id: string }[];
  unpin?: string[];
}

/**
 * Applies an agent revision and re-runs the optimizer. Only candidates Qloo returned (already in the
 * pool) can be referenced; attendance, opt-outs, declines and edit-mode locks stay enforced by the
 * optimizer. Validates everything before changing state, so a rejected revision changes nothing.
 */
export function revisePlan(state: PipelineState, rev: Revision): { before: Metrics; metrics: Metrics; unreached: string[]; changed: string[] } {
  if (!state.assignment || !state.metrics) throw new Error("Run the optimizer first.");
  const slotById = new Map(state.slots.map((s) => [s.id, s]));
  const problems: string[] = [];
  const known = (id: string) => state.candidates.has(id);
  for (const x of rev.exclude ?? []) {
    if (!known(x.candidate_id)) problems.push(`${x.candidate_id} is not in the candidate pool`);
    if (x.slot_id && !slotById.has(x.slot_id)) problems.push(`slot ${x.slot_id} does not exist`);
    const lockedHere = [...state.locked.entries()].some(([s, c]) => c === x.candidate_id && (!x.slot_id || s === x.slot_id));
    if (lockedHere) problems.push(`${x.candidate_id} is kept by the coordinator and cannot be excluded`);
  }
  const pinIds = new Set<string>();
  for (const p of rev.pin ?? []) {
    const slot = slotById.get(p.slot_id);
    const c = state.candidates.get(p.candidate_id);
    if (!slot) problems.push(`slot ${p.slot_id} does not exist`);
    if (!c) problems.push(`${p.candidate_id} is not in the candidate pool`);
    if (!slot || !c) continue;
    if (c.domain !== slot.domain) problems.push(`${p.candidate_id} is ${c.domain}, slot ${p.slot_id} is ${slot.domain}`);
    if (state.locked.has(p.slot_id)) problems.push(`slot ${p.slot_id} is kept by the coordinator`);
    if (state.exclude.has(p.candidate_id)) problems.push(`${p.candidate_id} was shown last week and is excluded`);
    const excludedNow = (rev.exclude ?? []).some((x) => x.candidate_id === p.candidate_id && (!x.slot_id || x.slot_id === p.slot_id));
    if (state.weekBans.has(p.candidate_id) || state.slotBans.get(p.slot_id)?.has(p.candidate_id) || excludedNow) problems.push(`${p.candidate_id} is excluded from ${p.slot_id}`);
    if (pinIds.has(p.candidate_id)) problems.push(`${p.candidate_id} is pinned twice`);
    pinIds.add(p.candidate_id);
  }
  const pinSlots = (rev.pin ?? []).map((p) => p.slot_id);
  if (new Set(pinSlots).size !== pinSlots.length) problems.push("a slot is pinned twice");
  if (problems.length) throw new Error(`Revision rejected, nothing changed: ${[...new Set(problems)].join("; ")}.`);

  const before = state.metrics;
  const prev = new Map(state.assignment);
  for (const s of rev.unpin ?? []) state.pins.delete(s);
  for (const x of rev.exclude ?? []) {
    if (x.slot_id) {
      const set = state.slotBans.get(x.slot_id) ?? new Set<string>();
      set.add(x.candidate_id);
      state.slotBans.set(x.slot_id, set);
      if (state.pins.get(x.slot_id) === x.candidate_id) state.pins.delete(x.slot_id);
    } else {
      state.weekBans.add(x.candidate_id);
      for (const [s, c] of state.pins) if (c === x.candidate_id) state.pins.delete(s);
    }
  }
  for (const p of rev.pin ?? []) {
    // A candidate can only be in one slot: move an earlier pin of it.
    for (const [s, c] of state.pins) if (c === p.candidate_id) state.pins.delete(s);
    state.pins.set(p.slot_id, p.candidate_id);
  }
  // The old assignment still seeds the search; the optimizer drops seeded picks that are now banned.
  const { metrics, unreached } = runOptimizer(state);
  const changed = state.slots.filter((s) => prev.get(s.id) !== state.assignment!.get(s.id)).map((s) => s.id);
  return { before, metrics, unreached, changed };
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
      const tags = r.genreTags.get(d) ?? [];
      if (!sig.length && !tags.length) continue;
      // A genre alone ("westerns") gives Qloo little to go on and returns recent titles (checked
      // live); their youth years anchor it to the films they grew up with (film and TV only).
      const years = sig.length || !r.youth ? undefined : r.youth;
      const res = await tracer.tryCall(
        "get_one_to_one",
        { resident: id, domain: d },
        () => counted(state, qloo.insights(recommendParams(d, sig, { take: 4, exclude: sig, explain: true, tags, ...(years ? { years } : {}) }))),
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
  const why = ex.length ? `${rank}; Qloo links it to their love of ${ex.join(" and ")}.` : `${rank} on Qloo taste affinity.`;
  const era = youthNote(state, c, residentId);
  return era ? `${why} ${era}` : why;
}

/** "Released in 1958, from their teens." when a film or TV pick falls in the resident's youth window. */
export function youthNote(state: PipelineState, c: CandidateState, residentId: string): string | undefined {
  const r = state.residents.get(residentId);
  if (c.domain === "outing" || !ERA_DOMAINS.has(c.domain) || !inYears(c.entity, r?.youth)) return undefined;
  const year = c.entity.properties!.release_year!;
  const age = year - (r!.youth!.from - youthYears(0).from);
  return `Released in ${year}, from their ${age < 20 ? "teens" : age < 30 ? "twenties" : "youth"}.`;
}

/** True when the candidate is a film or TV title from the resident's youth window. */
const fromYouth = (state: PipelineState, c: CandidateState, residentId: string) => !!youthNote(state, c, residentId);

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
        candidate_id: cid ?? null,
        attendees: s.attendees.length,
        strong_matches: matches,
        // Attendees for whom the pick was released in their teens or twenties (film and TV).
        ...(() => {
          const ids = c ? s.attendees.filter((r) => fromYouth(state, c, r)) : [];
          return ids.length ? { year: c!.entity.properties?.release_year, from_youth_of: ids } : {};
        })(),
      };
    }),
    unreached: state.assignment && state.metrics
      ? unreached({ bySlot: state.assignment, metrics: state.metrics }, { slots: state.slots, candidates: cands, residents: scoredResidents(state) })
      : [],
    unscorable: [...state.residents.values()].filter((r) => !r.scorable).map((r) => r.id),
    pool: Object.fromEntries([...domainsInWeek(state)].map((d) => [d, cands.filter((c) => c.domain === d).length])),
    unfetched_types: unfetchedDomains(state),
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
      .map((r) => ({
        residentId: r,
        fit: fitOf(ec, r),
        ownFavorite: c.ownedBy.has(r),
        why: whyFor(state, c, r),
        ...(fromYouth(state, c, r) ? { fromYouth: true } : {}),
      }))
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
        return {
          slotId: s.id,
          fit: fitOf(ec, r.id),
          ownFavorite: c.ownedBy.has(r.id),
          why: whyFor(state, c, r.id),
          ...(fromYouth(state, c, r.id) ? { fromYouth: true } : {}),
        };
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
      ...(r.youth ? { youthYears: r.youth } : {}),
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
  const favs = o.favorites.filter((f) => f.status === "matched").map((f) => f.entity?.name ?? f.tag?.name)
    .filter((n): n is string => !!n);
  const top = o.sessions.filter((s) => s.ownFavorite || s.fit >= REACH_THRESHOLD).slice(0, 3);
  const when = top
    .map((s) => {
      const r = reqSlots.get(s.slotId);
      const c = state.candidates.get(state.assignment!.get(s.slotId)!);
      if (!r || !c?.entity.name) return "";
      return `${c.entity.name} (${DAY_NAMES[r.day]} ${r.time})`;
    })
    .filter(Boolean)
    .join("; ");
  const parts = [favs.length ? `Documented preferences: ${favs.slice(0, 5).join(", ")}.` : "Preferences matched on Qloo via related tastes."];
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
