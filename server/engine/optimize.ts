// Deterministic scheduler. Given per-resident fits from Qloo, assign one candidate per slot so the
// least-served resident is as well served as possible (max-min), then improve the average.
// No language model is involved in any number produced here.
import { REACH_THRESHOLD, type Domain, type Metrics } from "../../shared/types.ts";

export interface EngineSlot {
  id: string;
  domain: Domain;
  /** Resident ids who can attend this slot (available and not opted out). */
  attendees: string[];
}

export interface EngineCandidate {
  id: string;
  domain: Domain;
  /** fit[residentId] in 0..1. Missing = 0. */
  fit: Map<string, number>;
  /** Residents for whom this candidate is a declined item (fit forced to 0). */
  blocked?: Set<string>;
}

export interface Assignment {
  /** slotId -> candidateId */
  bySlot: Map<string, string>;
  metrics: Metrics;
}

export interface OptimizeInput {
  slots: EngineSlot[];
  candidates: EngineCandidate[];
  /** Residents that can be scored (others are excluded from metrics). */
  residents: string[];
  /** Pinned assignments that must not change (slotId -> candidateId). */
  locked?: Map<string, string>;
  /** Candidate ids that may not be used (e.g. shown last week). */
  exclude?: Set<string>;
  /** Optional starting assignment (local search may change it, unlike `locked`). */
  initial?: Map<string, string>;
  maxPasses?: number;
}

const EPS = 1e-9;

export function fitOf(c: EngineCandidate, residentId: string): number {
  if (c.blocked?.has(residentId)) return 0;
  return c.fit.get(residentId) ?? 0;
}

/** Each resident's attendable fits, sorted descending. */
function residentFits(
  bySlot: Map<string, string>,
  slots: EngineSlot[],
  cands: Map<string, EngineCandidate>,
  residents: string[],
): Map<string, number[]> {
  const out = new Map<string, number[]>(residents.map((r) => [r, []]));
  for (const s of slots) {
    const cid = bySlot.get(s.id);
    const c = cid ? cands.get(cid) : undefined;
    if (!c) continue;
    for (const r of s.attendees) out.get(r)?.push(fitOf(c, r));
  }
  for (const v of out.values()) v.sort((a, b) => b - a);
  return out;
}

export function computeMetrics(
  bySlot: Map<string, string>,
  slots: EngineSlot[],
  candidates: EngineCandidate[] | Map<string, EngineCandidate>,
  residents: string[],
): Metrics {
  const cands = candidates instanceof Map ? candidates : new Map(candidates.map((c) => [c.id, c]));
  const fits = residentFits(bySlot, slots, cands, residents);
  let reached = 0;
  let minBest = residents.length ? 1 : 0;
  let sumBest = 0;
  let sumTop2 = 0;
  for (const r of residents) {
    const f = fits.get(r) ?? [];
    const best = f[0] ?? 0;
    const second = f[1] ?? 0;
    if (best >= REACH_THRESHOLD - EPS) reached++;
    minBest = Math.min(minBest, best);
    sumBest += best;
    sumTop2 += (best + second) / 2;
  }
  const n = residents.length || 1;
  return {
    reached,
    total: residents.length,
    minBest: round(minBest),
    meanBest: round(sumBest / n),
    meanTop2: round(sumTop2 / n),
  };
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** Lexicographic objective: reached, minBest, meanTop2, meanBest. Higher is better. */
function better(a: Metrics, b: Metrics): boolean {
  if (a.reached !== b.reached) return a.reached > b.reached;
  if (Math.abs(a.minBest - b.minBest) > EPS) return a.minBest > b.minBest;
  if (Math.abs(a.meanTop2 - b.meanTop2) > EPS) return a.meanTop2 > b.meanTop2;
  return a.meanBest > b.meanBest + EPS;
}

/**
 * Greedy construction followed by local search (single-slot replacement and pairwise swaps)
 * until no move improves the objective. Each candidate is used at most once per week.
 */
export function optimize(input: OptimizeInput): Assignment {
  const { slots, residents } = input;
  const exclude = input.exclude ?? new Set<string>();
  const locked = input.locked ?? new Map<string, string>();
  const cands = new Map(input.candidates.map((c) => [c.id, c]));
  const pool = (domain: Domain) =>
    input.candidates.filter((c) => c.domain === domain && !exclude.has(c.id));

  const bySlot = new Map<string, string>();
  const used = new Set<string>();
  const seed = (entries: Map<string, string>, allowExcluded: boolean) => {
    for (const [sid, cid] of entries) {
      const slot = slots.find((s) => s.id === sid);
      const c = cands.get(cid);
      if (!slot || !c || c.domain !== slot.domain || bySlot.has(sid) || used.has(cid)) continue;
      if (!allowExcluded && exclude.has(cid)) continue;
      bySlot.set(sid, cid);
      used.add(cid);
    }
  };
  seed(locked, true);
  if (input.initial) seed(input.initial, false);

  // Greedy: fill slots in order of how few options they have, maximizing marginal gain
  // for the residents who are currently worst served.
  const open = slots.filter((s) => !bySlot.has(s.id)).sort((a, b) => pool(a.domain).length - pool(b.domain).length);
  for (const s of open) {
    const current = residentFits(bySlot, slots, cands, residents);
    let bestId: string | undefined;
    let bestScore = -Infinity;
    for (const c of pool(s.domain)) {
      if (used.has(c.id)) continue;
      let score = 0;
      for (const r of s.attendees) {
        const have = current.get(r)?.[0] ?? 0;
        const f = fitOf(c, r);
        // Big weight for lifting someone below the threshold, small weight for general enjoyment.
        if (f > have) score += (f - have) * (have < REACH_THRESHOLD ? 3 : 1);
        score += f * 0.1;
      }
      if (score > bestScore + EPS) {
        bestScore = score;
        bestId = c.id;
      }
    }
    if (bestId) {
      bySlot.set(s.id, bestId);
      used.add(bestId);
    }
  }

  let metrics = computeMetrics(bySlot, slots, cands, residents);
  const maxPasses = input.maxPasses ?? 25;
  const free = slots.filter((s) => !locked.has(s.id));

  for (let pass = 0; pass < maxPasses; pass++) {
    let improved = false;

    // Move 1: replace one slot's candidate with an unused candidate of the same domain.
    for (const s of free) {
      for (const c of pool(s.domain)) {
        if (used.has(c.id)) continue;
        const prev = bySlot.get(s.id);
        bySlot.set(s.id, c.id);
        const m = computeMetrics(bySlot, slots, cands, residents);
        if (better(m, metrics)) {
          if (prev) used.delete(prev);
          used.add(c.id);
          metrics = m;
          improved = true;
        } else if (prev) bySlot.set(s.id, prev);
        else bySlot.delete(s.id);
      }
    }

    // Move 2: swap candidates between two slots of the same domain (attendees differ by slot).
    for (let i = 0; i < free.length; i++) {
      for (let j = i + 1; j < free.length; j++) {
        const a = free[i]!;
        const b = free[j]!;
        if (a.domain !== b.domain) continue;
        const ca = bySlot.get(a.id);
        const cb = bySlot.get(b.id);
        if (!ca || !cb) continue;
        bySlot.set(a.id, cb);
        bySlot.set(b.id, ca);
        const m = computeMetrics(bySlot, slots, cands, residents);
        if (better(m, metrics)) {
          metrics = m;
          improved = true;
        } else {
          bySlot.set(a.id, ca);
          bySlot.set(b.id, cb);
        }
      }
    }

    if (!improved) break;
  }

  return { bySlot, metrics };
}

/**
 * Runs the optimizer from a greedy start and from each seed assignment, returning the best result.
 * Seeding from the baselines guarantees the plan is never worse than a baseline built from the same pool.
 */
export function optimizeBest(input: OptimizeInput, seeds: Map<string, string>[] = []): Assignment {
  let best = optimize(input);
  for (const s of seeds) {
    const a = optimize({ ...input, initial: s });
    if (better(a.metrics, best.metrics)) best = a;
  }
  return best;
}

/** Fixed (non-optimized) assignment: fill each slot in order with the first unused candidate from a ranked list. */
export function fillInOrder(
  slots: EngineSlot[],
  ranked: EngineCandidate[],
  exclude: Set<string> = new Set(),
): Map<string, string> {
  const bySlot = new Map<string, string>();
  const used = new Set<string>();
  for (const s of slots) {
    const c = ranked.find((x) => x.domain === s.domain && !used.has(x.id) && !exclude.has(x.id));
    if (c) {
      bySlot.set(s.id, c.id);
      used.add(c.id);
    }
  }
  return bySlot;
}

/**
 * Residents not reached by the assignment, ordered worst-first.
 */
export function unreached(assign: Assignment, input: Pick<OptimizeInput, "slots" | "candidates" | "residents">): string[] {
  const cands = new Map(input.candidates.map((c) => [c.id, c]));
  const fits = residentFits(assign.bySlot, input.slots, cands, input.residents);
  return input.residents
    .map((r) => ({ r, best: fits.get(r)?.[0] ?? 0 }))
    .filter((x) => x.best < REACH_THRESHOLD - EPS)
    .sort((a, b) => a.best - b.best)
    .map((x) => x.r);
}

/** Best attendable fit for one resident under an assignment. */
export function bestFor(
  residentId: string,
  bySlot: Map<string, string>,
  slots: EngineSlot[],
  cands: Map<string, EngineCandidate>,
): { fit: number; slotId?: string } {
  let best = 0;
  let slotId: string | undefined;
  for (const s of slots) {
    if (!s.attendees.includes(residentId)) continue;
    const cid = bySlot.get(s.id);
    const c = cid ? cands.get(cid) : undefined;
    if (!c) continue;
    const f = fitOf(c, residentId);
    if (f > best) {
      best = f;
      slotId = s.id;
    }
  }
  return { fit: round(best), slotId };
}
