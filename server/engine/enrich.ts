// Plan enrichments from Qloo's non-entity insights:
// - "Loved by 55+": urn:demographics age affinities for scheduled picks and 1:1 picks.
// - Outing ideas: urn:heatmap areas near the home where the group's taste clusters, named from the
//   geocode Qloo returns for venues there (no outside geocoding).
// Both are best-effort: every failure is logged and skipped, never breaking the plan.
import type { OlderAdultSignal, OutingArea, QlooClient, QlooEntity, WeekPlan } from "../../shared/types.ts";
import type { PipelineState } from "./pipeline.ts";
import { MAX_SIGNAL_IDS, suitableForGroup } from "./qloo-ops.ts";
import { clip, mapLimit, safeReason, type Tracer } from "./trace.ts";

// ---------------------------------------------------------------------------
// Loved by 55+
// ---------------------------------------------------------------------------

/** Ids per demographics call (Qloo returned one row per id for 40 ids in a live check). */
export const DEMOGRAPHICS_BATCH = 40;
/** Qloo's 55_and_older affinity (-1..1, 0 = average) at or above this is a clear lean toward older adults. */
export const LOVED_55_MIN = 0.25;
/** 55+ must also be the title's strongest age group, within this margin. */
const TOP_BUCKET_MARGIN = 0.02;

/** Per-run cache: entity id -> signal (null = Qloo returned nothing for it). Kept off PipelineState. */
const signalsByState = new WeakMap<PipelineState, Map<string, OlderAdultSignal | null>>();

function cacheFor(state: PipelineState) {
  let m = signalsByState.get(state);
  if (!m) signalsByState.set(state, (m = new Map()));
  return m;
}

export function olderAdultSignal(age: Partial<Record<string, number>>): OlderAdultSignal | null {
  const a = age["55_and_older"];
  if (typeof a !== "number") return null;
  const others = Object.entries(age).filter(([k, v]) => k !== "55_and_older" && typeof v === "number").map(([, v]) => v as number);
  const top = others.every((v) => a >= v - TOP_BUCKET_MARGIN);
  return { affinity: Math.round(a * 1000) / 1000, loved: a >= LOVED_55_MIN && top };
}

/** Fetches 55+ signals for ids not yet looked up this run, in batches. Never throws. */
export async function fetchOlderAdultSignals(state: PipelineState, qloo: QlooClient, tracer: Tracer, ids: string[]): Promise<Map<string, OlderAdultSignal | null>> {
  const cache = cacheFor(state);
  const todo = [...new Set(ids)].filter((id) => id && !cache.has(id));
  const batches: string[][] = [];
  for (let i = 0; i < todo.length; i += DEMOGRAPHICS_BATCH) batches.push(todo.slice(i, i + DEMOGRAPHICS_BATCH));
  for (const batch of batches) {
    state.qlooRequests++;
    const rows = await tracer.tryCall(
      "get_age_affinity",
      { entities: batch.length },
      () => qloo.demographics({ "signal.interests.entities": batch.join(",") }),
      (r) => `${r.length} of ${batch.length} picks have age data; ${r.filter((x) => olderAdultSignal(x.age)?.loved).length} loved by 55+`,
    );
    if (!rows) continue; // failure: leave uncached so a later step may retry
    const got = new Map(rows.map((r) => [r.entity_id, olderAdultSignal(r.age)]));
    for (const id of batch) cache.set(id, got.get(id) ?? null);
  }
  return cache;
}

/** Signals for the current schedule, for the agent's context (slot -> signal of its pick). */
export async function scheduleOlderAdults(state: PipelineState, qloo: QlooClient, tracer: Tracer) {
  if (!state.assignment) return [];
  const pairs = [...state.assignment];
  try {
    const cache = await fetchOlderAdultSignals(state, qloo, tracer, pairs.map(([, id]) => id));
    return pairs
      .map(([slot, id]) => ({ slot, pick: clip(state.names.get(id) ?? id, 60), signal: cache.get(id) }))
      .filter((x): x is { slot: string; pick: string; signal: OlderAdultSignal } => !!x.signal?.loved)
      .map((x) => ({ slot: x.slot, pick: x.pick, affinity_55_plus: x.signal.affinity }));
  } catch (e) {
    safeReason(e, "older-adults");
    return [];
  }
}

/** Attaches 55+ signals to the finished plan's sessions and 1:1 picks. Never throws. */
export async function annotateOlderAdults(plan: WeekPlan, state: PipelineState, qloo: QlooClient, tracer: Tracer): Promise<void> {
  try {
    const picks = plan.residents.flatMap((r) => r.oneToOne?.picks ?? []);
    const ids = [...plan.sessions.map((s) => s.entity.entity_id), ...picks.map((p) => p.entity_id)];
    const cache = await fetchOlderAdultSignals(state, qloo, tracer, ids);
    for (const s of plan.sessions) {
      const sig = cache.get(s.entity.entity_id);
      if (sig) s.olderAdults = sig;
    }
    for (const r of plan.residents) {
      if (!r.oneToOne) continue;
      const m: Record<string, OlderAdultSignal> = {};
      for (const p of r.oneToOne.picks) {
        const sig = cache.get(p.entity_id);
        if (sig) m[p.entity_id] = sig;
      }
      if (Object.keys(m).length) r.oneToOne = { ...r.oneToOne, olderAdults: m };
    }
  } catch (e) {
    safeReason(e, "older-adults");
  }
}

// ---------------------------------------------------------------------------
// Outing ideas (heatmap)
// ---------------------------------------------------------------------------

export const OUTING_AREAS = 3;
/** Cells closer than this to an already chosen area are the same area. */
const MIN_AREA_KM = 2;
/** Radius of the venue lookup around a heatmap cell, in meters. */
export const AREA_RADIUS_M = 1000;
const AREA_VENUES = 5;
/** Qloo place categories that suit a care-home group outing (ids confirmed against /v2/tags). */
export const OUTING_PLACE_TAGS = [
  "museum",
  "art_gallery",
  "performing_arts_theater",
  "botanical_garden",
  "garden",
  "park",
  "historical_landmark",
  "tourist_attraction",
  "aquarium",
  "zoo",
]
  .map((t) => `urn:tag:category:place:${t}`)
  .join(",");
/** Cells looked up (one extra in case two cells share a neighborhood name). */
const AREA_LOOKUPS = OUTING_AREAS + 1;

function km(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const dLat = r(b.lat - a.lat);
  const dLon = r(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/** The group's most shared entity favorites, plus food tags. */
function groupTaste(state: PipelineState) {
  const counts = new Map<string, number>();
  for (const r of state.residents.values()) for (const id of r.allSignals) counts.set(id, (counts.get(id) ?? 0) + 1);
  const entities = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id).slice(0, MAX_SIGNAL_IDS);
  const tags = [...new Set([...state.residents.values()].flatMap((r) => r.foodTags))].slice(0, 10);
  const tagNames = new Map<string, string>();
  for (const r of state.residents.values()) for (const f of r.favorites) if (f.tag) tagNames.set(f.tag.id, f.tag.name);
  return { entities, tags, tagNames };
}

/** Most common neighborhood name among the venues Qloo returned. */
function neighborhoodOf(venues: QlooEntity[]): string | undefined {
  const counts = new Map<string, number>();
  for (const v of venues) {
    const n = v.properties?.geocode?.name?.trim();
    if (n) counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/**
 * Top areas near the home where the group's taste clusters. One heatmap call, then one place call per
 * chosen cell to name it and list matching venues. Returns [] on any failure.
 */
export async function buildOutingIdeas(state: PipelineState, qloo: QlooClient, tracer: Tracer): Promise<OutingArea[]> {
  const city = state.request.homeCity?.trim();
  if (!city) return [];
  try {
    const { entities, tags, tagNames } = groupTaste(state);
    if (!entities.length && !tags.length) return [];
    const signal: Record<string, string> = {};
    if (entities.length) signal["signal.interests.entities"] = entities.join(",");
    if (tags.length) signal["signal.interests.tags"] = tags.join(",");

    state.qlooRequests++;
    const cells = await tracer.tryCall(
      "get_taste_heatmap",
      { city, signals: entities.length, tags: tags.length },
      () => qloo.heatmap({ "filter.location.query": city, ...signal }),
      (r) => `${r.length} taste hotspots near ${city}`,
    );
    if (!cells?.length) return [];

    // Distinct areas, strongest first.
    const chosen: typeof cells = [];
    for (const c of [...cells].sort((a, b) => b.affinity - a.affinity)) {
      if (chosen.every((x) => km(x, c) >= MIN_AREA_KM)) chosen.push(c);
      if (chosen.length >= AREA_LOOKUPS) break;
    }

    const looked = await mapLimit(chosen, 2, async (cell) => {
      state.qlooRequests++;
      const venues = await tracer.tryCall(
        "get_area_venues",
        { lat: cell.lat, lon: cell.lon, radius_m: AREA_RADIUS_M },
        () =>
          qloo.insights({
            "filter.type": "urn:entity:place",
            "filter.location": `POINT(${cell.lon} ${cell.lat})`,
            "filter.location.radius": AREA_RADIUS_M,
            // Group-outing places only; without this the food tags pull in takeaways and bars.
            "filter.tags": OUTING_PLACE_TAGS,
            ...signal,
            take: AREA_VENUES,
          }),
        (r) => `${r.length} venues${neighborhoodOf(r) ? ` in ${neighborhoodOf(r)}` : ""}`,
      );
      return { cell, venues: (venues ?? []).filter(suitableForGroup) };
    });

    const tasteNames = [
      ...entities.map((id) => state.names.get(id)).filter((n): n is string => !!n),
      ...tags.map((t) => tagNames.get(t)).filter((n): n is string => !!n),
    ].slice(0, 2);
    const taste = tasteNames.length ? ` for fans of ${tasteNames.join(" and ")}` : "";

    const out: OutingArea[] = [];
    const seen = new Set<string>();
    for (const { cell, venues } of looked) {
      // Only Qloo-provided descriptions: its neighborhood name, else the nearest matching venue.
      if (!venues.length) continue;
      const name = neighborhoodOf(venues) ?? `Near ${venues[0]!.name}`;
      if (seen.has(name)) continue;
      seen.add(name);
      const top = venues.slice(0, 3).map((v) => v.name);
      const rank = out.length === 0 ? "Strongest" : out.length === 1 ? "Second-strongest" : "Third-strongest";
      out.push({
        name,
        lat: cell.lat,
        lon: cell.lon,
        affinity: Math.round(cell.affinity * 1000) / 1000,
        venues: top,
        why: `${rank} Qloo taste hotspot near ${city}${taste}${top.length ? `; try ${top.join(", ")}` : ""}.`,
      });
      if (out.length >= OUTING_AREAS) break;
    }
    return out;
  } catch (e) {
    safeReason(e, "outing-ideas"); // logged server-side; the plan simply has no outing ideas
    return [];
  }
}

/** Runs both enrichments on a finished plan. Never throws; adds the extra Qloo requests to the count. */
export async function enrichPlan(plan: WeekPlan, state: PipelineState, qloo: QlooClient, tracer: Tracer): Promise<void> {
  const before = state.qlooRequests;
  const [, areas] = await Promise.all([annotateOlderAdults(plan, state, qloo, tracer), buildOutingIdeas(state, qloo, tracer)]);
  if (areas.length) plan.outingIdeas = areas;
  plan.qlooRequests += state.qlooRequests - before;
}
