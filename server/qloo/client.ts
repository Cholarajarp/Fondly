// Live Qloo API client. Only real API data; there is no mock or fixture path.
// Responses are cached server-side (private cache, see cache.ts) to respect the event quota.
import {
  QlooError,
  type AgeBucket,
  type EntityDemographics,
  type EntityType,
  type HeatmapCell,
  type QlooClient,
  type QlooEntity,
  type QlooTag,
} from "../../shared/types.ts";
import type { QlooCache } from "./cache.ts";
import { MAX_TAKE, toQuery, validateInsightsParams, type InsightsParams } from "./params.ts";

export const DEFAULT_BASE_URL = "https://hackathon.api.qloo.com";
const MAX_ATTEMPTS = 3;
/** Rate limits get more patience: the hackathon API sends no Retry-After, and a burst clears in seconds. */
const MAX_ATTEMPTS_429 = 6;
const RATE_LIMIT_BASE_MS = 2_000;
const MAX_CONCURRENCY = 4;
const RETRY_AFTER_CAP_MS = 10_000;

export interface QlooClientOptions {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  cache?: QlooCache;
  timeoutMs?: number;
  /** Base delay for exponential backoff (default 500ms). Mostly for tests. */
  retryBaseMs?: number;
}

export function isQlooConfigured(): boolean {
  return (process.env.QLOO_API_KEY ?? "").trim() !== "";
}

// ---------- helpers ----------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };
/** Qloo returns some names HTML-escaped ("Ratchet &amp; Clank"); decode once at the boundary. */
export const decodeEntities = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? decodeEntities(v) : undefined);
const num = (v: unknown): number | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
};
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function createSemaphore(max: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((r) => queue.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

// ---------- normalizers (never throw; skip malformed items) ----------

function normalizeExplainability(raw: unknown): { entity_id: string; score: number }[] | undefined {
  const out: { entity_id: string; score: number }[] = [];
  const visit = (v: unknown, depth: number) => {
    if (depth > 4 || v == null) return;
    if (Array.isArray(v)) {
      for (const item of v) visit(item, depth + 1);
      return;
    }
    if (!isObj(v)) return;
    const id = str(v.entity_id) ?? str(v.id);
    const score = num(v.score) ?? num(v.affinity) ?? num(v.weight);
    if (id && score !== undefined) {
      out.push({ entity_id: id, score });
      return;
    }
    for (const [k, val] of Object.entries(v)) {
      const n = num(val);
      if (n !== undefined && typeof val === "number") out.push({ entity_id: k, score: n });
      else visit(val, depth + 1);
    }
  };
  visit(raw, 0);
  return out.length ? out : undefined;
}

function normalizeTagList(raw: unknown): QlooTag[] {
  if (!Array.isArray(raw)) return [];
  const out: QlooTag[] = [];
  for (const t of raw) {
    if (!isObj(t)) continue;
    const id = str(t.id) ?? str(t.tag_id);
    const name = str(t.name);
    if (!id || !name) continue;
    const type = str(t.type);
    out.push(type ? { id, name, type } : { id, name });
  }
  return out;
}

export function normalizeEntity(raw: unknown): QlooEntity | undefined {
  if (!isObj(raw)) return undefined;
  const entity_id = str(raw.entity_id) ?? str(raw.id);
  const name = str(raw.name);
  if (!entity_id || !name) return undefined;

  const e: QlooEntity = { entity_id, name };
  const type = str(raw.type) ?? (Array.isArray(raw.types) ? str(raw.types[0]) : undefined);
  if (type) e.type = type;
  const subtype = str(raw.subtype);
  if (subtype) e.subtype = subtype;
  const popularity = num(raw.popularity);
  if (popularity !== undefined) e.popularity = popularity;

  const query = isObj(raw.query) ? raw.query : undefined;
  const affinity = num(query?.affinity) ?? num(raw.affinity);
  if (affinity !== undefined) e.affinity = affinity;

  const props = isObj(raw.properties) ? raw.properties : undefined;
  if (props) {
    const p: NonNullable<QlooEntity["properties"]> = {};
    const address = str(props.address);
    if (address) p.address = address;
    const desc = str(props.short_description) ?? str(props.description);
    if (desc) p.short_description = desc;
    const rating = num(props.business_rating);
    if (rating !== undefined) p.business_rating = rating;
    const contentRating = str(props.content_rating);
    if (contentRating) p.content_rating = contentRating;
    const price = num(props.price_level);
    if (price !== undefined) p.price_level = price;
    const year = num(props.release_year) ?? num(props.publication_year);
    if (year !== undefined) p.release_year = year;
    if (isObj(props.geocode)) {
      const g: NonNullable<NonNullable<QlooEntity["properties"]>["geocode"]> = {};
      const gName = str(props.geocode.name);
      if (gName) g.name = gName;
      const admin1 = str(props.geocode.admin1_region);
      if (admin1) g.admin1_region = admin1;
      const cc = str(props.geocode.country_code);
      if (cc) g.country_code = cc;
      if (Object.keys(g).length) p.geocode = g;
    }
    if (Object.keys(p).length) e.properties = p;
    const img = isObj(props.image) ? str(props.image.url) : undefined;
    if (img) e.image_url = img;
  }

  if (isObj(raw.location)) {
    const lat = num(raw.location.lat) ?? num(raw.location.latitude);
    const lon = num(raw.location.lon) ?? num(raw.location.lng) ?? num(raw.location.longitude);
    if (lat !== undefined && lon !== undefined) e.location = { lat, lon };
  }

  const tags = normalizeTagList(raw.tags);
  if (tags.length) e.tags = tags;

  const expl = normalizeExplainability(query?.explainability);
  if (expl) e.explainability = expl;
  return e;
}

function normalizeEntities(raw: unknown): QlooEntity[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeEntity).filter((e): e is QlooEntity => e !== undefined);
}

const results = (body: unknown): unknown => (isObj(body) ? body.results : undefined);

export function normalizeInsights(body: unknown): QlooEntity[] {
  const r = results(body);
  return normalizeEntities(isObj(r) ? r.entities : undefined);
}

export function normalizeSearch(body: unknown): QlooEntity[] {
  const r = results(body);
  return normalizeEntities(Array.isArray(r) ? r : isObj(r) ? r.entities : undefined);
}

export function normalizeTags(body: unknown): QlooTag[] {
  const r = results(body);
  return normalizeTagList(isObj(r) ? r.tags : Array.isArray(r) ? r : undefined);
}

export function normalizeHeatmap(body: unknown): HeatmapCell[] {
  const r = results(body);
  const items = isObj(r) ? r.heatmap : undefined;
  if (!Array.isArray(items)) return [];
  const out: HeatmapCell[] = [];
  for (const item of items) {
    if (!isObj(item) || !isObj(item.location)) continue;
    const lat = num(item.location.latitude) ?? num(item.location.lat);
    const lon = num(item.location.longitude) ?? num(item.location.lon);
    const geohash = str(item.location.geohash);
    if (lat === undefined || lon === undefined || !geohash) continue;
    const q = isObj(item.query) ? item.query : {};
    const aff = num(q.affinity_rank) ?? num(q.affinity);
    if (aff === undefined) continue;
    const cell: HeatmapCell = { geohash, lat, lon, affinity: clamp01(aff) };
    const pop = num(q.popularity);
    if (pop !== undefined) cell.popularity = pop;
    out.push(cell);
  }
  return out;
}

const AGE_KEYS: AgeBucket[] = ["24_and_younger", "25_to_29", "30_to_34", "35_to_44", "45_to_54", "55_and_older"];

/** One row per signal entity: `{ entity_id, query: { age: { "55_and_older": 0.39, ... } } }` (values -1..1). */
export function normalizeDemographics(body: unknown): EntityDemographics[] {
  const r = results(body);
  const items = isObj(r) ? r.demographics : undefined;
  if (!Array.isArray(items)) return [];
  const out: EntityDemographics[] = [];
  for (const item of items) {
    if (!isObj(item) || !isObj(item.query) || !isObj(item.query.age)) continue;
    const entity_id = str(item.entity_id);
    if (!entity_id) continue;
    const src = item.query.age;
    const age: EntityDemographics["age"] = {};
    for (const key of AGE_KEYS) {
      const v = num(src[key]);
      if (v !== undefined) age[key] = Math.max(-1, Math.min(1, v));
    }
    if (Object.keys(age).length) out.push({ entity_id, age });
  }
  return out;
}

// ---------- client ----------

export function createQlooClient(opts: QlooClientOptions = {}): QlooClient {
  const apiKey = (opts.apiKey ?? process.env.QLOO_API_KEY ?? "").trim();
  const baseUrl = (opts.baseUrl ?? process.env.QLOO_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const cache = opts.cache;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const retryBaseMs = opts.retryBaseMs ?? 500;
  const rateLimitBaseMs = opts.retryBaseMs === undefined ? RATE_LIMIT_BASE_MS : retryBaseMs * 4;
  const limit = createSemaphore(MAX_CONCURRENCY);
  let calls = 0;
  // Shared cooldown: after any 429, every queued call waits until this time instead of re-bursting.
  let coolUntil = 0;

  const redact = (s: string) => (apiKey ? s.split(apiKey).join("[REDACTED]") : s);
  const err = (message: string, status: number, path: string) => new QlooError(redact(message), status, path);

  function backoffMs(attempt: number, retryAfter: string | null): number {
    if (retryAfter !== null) {
      const secs = Number(retryAfter);
      if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, RETRY_AFTER_CAP_MS);
      const date = Date.parse(retryAfter);
      if (Number.isFinite(date)) return Math.min(Math.max(0, date - Date.now()), RETRY_AFTER_CAP_MS);
    }
    const base = retryBaseMs * 2 ** attempt;
    return Math.min(base + Math.random() * base, RETRY_AFTER_CAP_MS);
  }

  async function errorMessageFromBody(res: Response): Promise<string | undefined> {
    try {
      const text = await res.text();
      if (!text) return undefined;
      try {
        const j = JSON.parse(text) as unknown;
        if (isObj(j)) {
          const e = j.error;
          if (typeof e === "string") return e;
          if (isObj(e) && typeof e.message === "string") return e.message;
          if (typeof j.message === "string") return j.message;
          if (Array.isArray(j.errors)) return JSON.stringify(j.errors).slice(0, 500);
        }
      } catch {
        /* not JSON */
      }
      return text.slice(0, 500);
    } catch {
      return undefined;
    }
  }

  async function httpError(res: Response, path: string): Promise<QlooError> {
    const detail = await errorMessageFromBody(res);
    const suffix = detail ? `: ${detail}` : "";
    switch (res.status) {
      case 401:
        return err(
          `Qloo rejected the API key (401) on ${path}. Check QLOO_API_KEY, that requests use the X-Api-Key header, ` +
            `and that QLOO_BASE_URL is ${DEFAULT_BASE_URL} (hackathon keys do not work on other hosts)${suffix}`,
          401,
          path,
        );
      case 403:
        return err(`Qloo denied access (403) on ${path}; this entity type is likely not supported for this key${suffix}`, 403, path);
      case 400:
        return err(`Qloo bad request (400) on ${path}${suffix || " (no error message returned)"}`, 400, path);
      default:
        return err(`Qloo request failed (${res.status}) on ${path}${suffix}`, res.status, path);
    }
  }

  function requireKey() {
    if (!apiKey) throw new QlooError("QLOO_API_KEY is not configured", 503, "");
  }

  /** GET with cache, retries and concurrency limit. Caches the normalized result. */
  async function get<T>(
    path: string,
    params: Record<string, string | number | boolean>,
    normalize: (body: unknown) => T,
  ): Promise<T> {
    requireKey();
    const qs = toQuery(params).toString();
    const cacheKey = `${path}?${qs}`;
    if (cache) {
      const hit = await cache.get(cacheKey).catch(() => undefined);
      if (hit !== undefined) return hit as T;
    }
    const url = `${baseUrl}${path}${qs ? `?${qs}` : ""}`;

    let lastError: QlooError | undefined;
    for (let attempt = 0; ; attempt++) {
      let retryAfter: string | null = null;
      const outcome = await limit(async (): Promise<{ body: unknown } | { error: QlooError; retry: boolean }> => {
        const wait = coolUntil - Date.now();
        if (wait > 0) await sleep(wait);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          calls++;
          const res = await fetchImpl(url, {
            method: "GET",
            headers: { "X-Api-Key": apiKey, Accept: "application/json" },
            signal: controller.signal,
          });
          if (res.ok) {
            const text = await res.text();
            try {
              return { body: text ? (JSON.parse(text) as unknown) : {} };
            } catch {
              return { error: err(`Qloo returned non-JSON response on ${path}`, res.status, path), retry: false };
            }
          }
          retryAfter = res.headers.get("retry-after");
          const retry = res.status === 429 || res.status >= 500;
          return { error: await httpError(res, path), retry };
        } catch (e) {
          const aborted = controller.signal.aborted;
          const msg = aborted
            ? `Qloo request timed out after ${timeoutMs}ms on ${path}`
            : `Qloo network error on ${path}: ${e instanceof Error ? e.message : String(e)}`;
          return { error: err(msg, 0, path), retry: true };
        } finally {
          clearTimeout(timer);
        }
      });

      if ("body" in outcome) {
        const value = normalize(outcome.body);
        // Empty results are not cached: one odd response must not stick for the whole TTL.
        const empty = Array.isArray(value) && value.length === 0;
        if (cache && !empty) await cache.set(cacheKey, value).catch(() => undefined);
        return value;
      }
      lastError = outcome.error;
      const limited = outcome.error.status === 429;
      if (!outcome.retry || attempt >= (limited ? MAX_ATTEMPTS_429 : MAX_ATTEMPTS) - 1) break;
      if (limited && retryAfter === null) {
        const delay = Math.min(rateLimitBaseMs * 2 ** attempt, 16_000) * (1 + Math.random() * 0.25);
        coolUntil = Math.max(coolUntil, Date.now() + delay);
        await sleep(delay);
      } else {
        await sleep(backoffMs(attempt, retryAfter));
      }
    }
    throw lastError ?? err(`Qloo request failed on ${path}`, 0, path);
  }

  function checkTake(take: number, path: string) {
    if (!Number.isInteger(take) || take < 1 || take > MAX_TAKE) {
      throw new QlooError(`take must be an integer 1..${MAX_TAKE} (got ${take})`, 0, path);
    }
  }

  return {
    async searchEntities(query: string, types?: EntityType[], take = 20) {
      requireKey();
      checkTake(take, "/search");
      const params: Record<string, string | number> = { query, take };
      if (types?.length) params.types = types.join(",");
      return get("/search", params, normalizeSearch);
    },
    async searchTags(query: string, take = 20, types?: string[]) {
      requireKey();
      checkTake(take, "/v2/tags");
      const params: Record<string, string | number> = { "filter.query": query, take };
      if (types?.length) params["filter.tag.types"] = types.join(",");
      return get("/v2/tags", params, normalizeTags);
    },
    async insights(params: InsightsParams) {
      requireKey();
      const type = validateInsightsParams(params);
      if (!type.startsWith("urn:entity:")) {
        throw new QlooError(
          `insights() requires an entity filter.type; use heatmap()/demographics() for ${type}`,
          0,
          "/v2/insights",
        );
      }
      return get("/v2/insights", params, normalizeInsights);
    },
    async heatmap(params: InsightsParams) {
      requireKey();
      const p = { ...params, "filter.type": "urn:heatmap" };
      validateInsightsParams(p);
      return get("/v2/insights", p, normalizeHeatmap);
    },
    async demographics(params: InsightsParams) {
      requireKey();
      const p = { ...params, "filter.type": "urn:demographics" };
      validateInsightsParams(p);
      return get("/v2/insights", p, normalizeDemographics);
    },
    callCount: () => calls,
  };
}
