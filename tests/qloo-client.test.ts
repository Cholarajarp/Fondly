import { describe, it, expect, vi } from "vitest";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createQlooClient } from "../server/qloo/client.ts";
import { createFileCache, createMemoryCache } from "../server/qloo/cache.ts";
import { QlooError } from "../shared/types.ts";

const KEY = "test-secret-key-123";
const BASE = "https://hackathon.api.qloo.com";

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function stubFetch(...responses: (Response | Error)[]) {
  const fn = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    const next = responses.shift();
    if (!next) throw new Error("no more stubbed responses");
    if (next instanceof Error) throw next;
    return next;
  });
  return fn;
}

function client(fetchImpl: ReturnType<typeof stubFetch>, extra: Parameters<typeof createQlooClient>[0] = {}) {
  return createQlooClient({ apiKey: KEY, baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch, retryBaseMs: 1, ...extra });
}

async function catchErr(p: Promise<unknown>): Promise<QlooError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(QlooError);
    return e as QlooError;
  }
  throw new Error("expected rejection");
}

describe("request basics", () => {
  it("sends X-Api-Key, Accept and the correct URL", async () => {
    const f = stubFetch(json({ results: { entities: [] } }));
    await client(f).insights({ "filter.type": "urn:entity:artist", "signal.interests.entities": "abc", take: 5 });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0]!;
    const u = new URL(String(url));
    expect(u.origin + u.pathname).toBe(`${BASE}/v2/insights`);
    expect(u.searchParams.get("filter.type")).toBe("urn:entity:artist");
    expect(u.searchParams.get("signal.interests.entities")).toBe("abc");
    expect(u.searchParams.get("take")).toBe("5");
    expect(u.searchParams.has("api_key")).toBe(false);
    const headers = init!.headers as Record<string, string>;
    expect(headers["X-Api-Key"]).toBe(KEY);
    expect(headers.Accept).toBe("application/json");
    expect(headers).not.toHaveProperty("Authorization");
    expect(init!.method).toBe("GET");
  });

  it("builds /search and /v2/tags URLs", async () => {
    const f = stubFetch(json({ results: [] }), json({ results: { tags: [] } }));
    const c = client(f);
    await c.searchEntities("Phoebe Bridgers", ["urn:entity:artist"], 3);
    await c.searchTags("indie", 7);
    const s = new URL(String(f.mock.calls[0]![0]));
    expect(s.pathname).toBe("/search");
    expect(s.searchParams.get("query")).toBe("Phoebe Bridgers");
    expect(s.searchParams.get("types")).toBe("urn:entity:artist");
    expect(s.searchParams.get("take")).toBe("3");
    const t = new URL(String(f.mock.calls[1]![0]));
    expect(t.pathname).toBe("/v2/tags");
    expect(t.searchParams.get("filter.query")).toBe("indie");
    expect(t.searchParams.get("take")).toBe("7");
  });

  it("validates params before sending", async () => {
    const f = stubFetch();
    const e = await catchErr(
      client(f).insights({ "filter.type": "urn:entity:artist", "filter.release_year.min": 1999 }),
    );
    expect(e.status).toBe(0);
    expect(f).not.toHaveBeenCalled();
  });

  it("throws 503 when key is missing (on call, not construction)", async () => {
    const prev = process.env.QLOO_API_KEY;
    delete process.env.QLOO_API_KEY;
    try {
      const f = stubFetch();
      const c = createQlooClient({ fetchImpl: f as unknown as typeof fetch });
      const e = await catchErr(c.searchEntities("x"));
      expect(e.status).toBe(503);
      expect(e.message).toBe("QLOO_API_KEY is not configured");
      expect(f).not.toHaveBeenCalled();
    } finally {
      if (prev !== undefined) process.env.QLOO_API_KEY = prev;
    }
  });
});

describe("retries and errors", () => {
  it("retries 429 then succeeds", async () => {
    const f = stubFetch(
      json({ error: "slow down" }, 429, { "retry-after": "0" }),
      json({ results: [{ entity_id: "e1", name: "A" }] }),
    );
    const c = client(f);
    const res = await c.searchEntities("a");
    expect(res).toEqual([{ entity_id: "e1", name: "A" }]);
    expect(f).toHaveBeenCalledTimes(2);
    expect(c.callCount()).toBe(2);
  });

  it("retries 5xx and network errors up to 3 attempts", async () => {
    const f = stubFetch(json({}, 502), new TypeError("fetch failed"), json({}, 503));
    const c = client(f);
    const e = await catchErr(c.searchEntities("a"));
    expect(e.status).toBe(503);
    expect(f).toHaveBeenCalledTimes(3);
    expect(c.callCount()).toBe(3);
  });

  it("does not retry 401 and mentions base URL and header", async () => {
    const f = stubFetch(json({ error: "unauthorized" }, 401), json({ results: [] }));
    const e = await catchErr(client(f).searchEntities("a"));
    expect(e.status).toBe(401);
    expect(e.path).toBe("/search");
    expect(e.message).toContain("X-Api-Key");
    expect(e.message).toContain(BASE);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("does not retry 403 and explains entity type", async () => {
    const f = stubFetch(json({ error: "You do not have permission to access urn:entity:book" }, 403));
    const e = await catchErr(client(f).insights({ "filter.type": "urn:entity:book" }));
    expect(e.status).toBe(403);
    expect(e.message).toMatch(/entity type/);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("includes the 400 body error message", async () => {
    const f = stubFetch(json({ error: { message: "at least one valid signal or filter is required" } }, 400));
    const e = await catchErr(client(f).insights({ "filter.type": "urn:entity:artist" }));
    expect(e.status).toBe(400);
    expect(e.message).toContain("at least one valid signal or filter is required");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("redacts the API key from error messages", async () => {
    const f = stubFetch(json({ error: `bad key ${KEY}` }, 400), new TypeError(`connect failed for ${KEY}`));
    const c = client(f);
    const e1 = await catchErr(c.searchEntities("a"));
    expect(e1.message).not.toContain(KEY);
    expect(e1.message).toContain("[REDACTED]");
    const f2 = stubFetch(new TypeError(`boom ${KEY}`), new TypeError(`boom ${KEY}`), new TypeError(`boom ${KEY}`));
    const e2 = await catchErr(client(f2).searchEntities("a"));
    expect(e2.status).toBe(0);
    expect(e2.message).not.toContain(KEY);
  });

  it("limits in-flight requests to 4", async () => {
    let inFlight = 0;
    let peak = 0;
    const f = vi.fn(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return json({ results: [] });
    });
    const c = createQlooClient({ apiKey: KEY, fetchImpl: f as unknown as typeof fetch });
    await Promise.all(Array.from({ length: 10 }, (_, i) => c.searchEntities(`q${i}`)));
    expect(f).toHaveBeenCalledTimes(10);
    expect(peak).toBeLessThanOrEqual(4);
  });
});

describe("normalizers", () => {
  it("normalizes insights entities including explainability and missing fields", async () => {
    const f = stubFetch(
      json({
        results: {
          entities: [
            {
              entity_id: "p1",
              name: "The Bar",
              type: "urn:entity:place",
              subtype: "urn:entity:place:bar",
              popularity: 0.9,
              query: {
                affinity: 0.77,
                explainability: { "signal.interests.entities": [{ entity_id: "h1", score: 0.6 }] },
              },
              properties: {
                address: "1 Main St",
                business_rating: 4.5,
                price_level: 2,
                geocode: { name: "Austin", admin1_region: "TX", country_code: "US" },
                image: { url: "https://img/x.jpg" },
              },
              location: { lat: 30.2, lon: -97.7 },
              tags: [{ tag_id: "t1", name: "Dive", type: "urn:tag:genre" }, { name: "no id" }],
            },
            { entity_id: "p2", name: "Bare", query: { explainability: { h1: 0.4, h2: 0.1 } } },
            { name: "no id" },
            null,
            "garbage",
          ],
        },
      }),
    );
    const res = await client(f).insights({
      "filter.type": "urn:entity:place",
      "filter.location.query": "Austin",
      "feature.explainability": true,
    });
    expect(res).toHaveLength(2);
    expect(res[0]).toEqual({
      entity_id: "p1",
      name: "The Bar",
      type: "urn:entity:place",
      subtype: "urn:entity:place:bar",
      popularity: 0.9,
      affinity: 0.77,
      image_url: "https://img/x.jpg",
      properties: {
        address: "1 Main St",
        business_rating: 4.5,
        price_level: 2,
        geocode: { name: "Austin", admin1_region: "TX", country_code: "US" },
      },
      location: { lat: 30.2, lon: -97.7 },
      tags: [{ id: "t1", name: "Dive", type: "urn:tag:genre" }],
      explainability: [{ entity_id: "h1", score: 0.6 }],
    });
    expect(res[1]).toEqual({
      entity_id: "p2",
      name: "Bare",
      explainability: [
        { entity_id: "h1", score: 0.4 },
        { entity_id: "h2", score: 0.1 },
      ],
    });
  });

  it("returns [] when results are missing", async () => {
    const f = stubFetch(json({}), json({ results: null }), json({ results: {} }));
    const c = client(f);
    expect(await c.insights({ "filter.type": "urn:entity:artist" })).toEqual([]);
    expect(await c.searchEntities("a")).toEqual([]);
    expect(await c.searchTags("a")).toEqual([]);
  });

  it("normalizes heatmap cells (affinity_rank preferred, clamped, malformed skipped)", async () => {
    const f = stubFetch(
      json({
        results: {
          heatmap: [
            { location: { latitude: 30.1, longitude: -97.1, geohash: "9v6k" }, query: { affinity: 0.2, affinity_rank: 0.9, popularity: 0.5 } },
            { location: { latitude: 30.2, longitude: -97.2, geohash: "9v6m" }, query: { affinity: 1.4 } },
            { location: { latitude: 30.3, geohash: "9v6n" }, query: { affinity: 0.3 } },
            { query: { affinity: 0.3 } },
            { location: { latitude: 30.4, longitude: -97.4, geohash: "9v6p" } },
          ],
        },
      }),
    );
    const cells = await client(f).heatmap({ "filter.location.query": "Austin", "signal.interests.entities": "h1" });
    const url = new URL(String(f.mock.calls[0]![0]));
    expect(url.searchParams.get("filter.type")).toBe("urn:heatmap");
    expect(cells).toEqual([
      { geohash: "9v6k", lat: 30.1, lon: -97.1, affinity: 0.9, popularity: 0.5 },
      { geohash: "9v6m", lat: 30.2, lon: -97.2, affinity: 1 },
    ]);
  });

  it("normalizes demographics from the first item's age block", async () => {
    const f = stubFetch(
      json({
        results: {
          demographics: [
            { entity_id: "h1", query: { age: { "35_and_younger": 0.3, "36_to_55": -0.1 }, gender: { male: 0.1 } } },
            { entity_id: "h2", query: { age: { "55_and_older": 0.9 } } },
          ],
        },
      }),
      json({ results: { demographics: [{ entity_id: "x" }] } }),
    );
    const c = client(f);
    expect(await c.demographics({ "signal.interests.entities": "h1" })).toEqual([
      { age: "35_and_younger", affinity: 0.3 },
      { age: "36_to_55", affinity: -0.1 },
    ]);
    expect(await c.demographics({ "signal.interests.entities": "x" })).toEqual([]);
  });

  it("rejects non-demographics params for demographics()", async () => {
    const f = stubFetch();
    await expect(client(f).demographics({ "filter.location.query": "Austin" })).rejects.toThrow(/filter\.location\.query/);
    expect(f).not.toHaveBeenCalled();
  });

  it("normalizes search and tags", async () => {
    const f = stubFetch(
      json({ results: [{ entity_id: "a1", name: "Artist", types: ["urn:entity:artist"], popularity: 0.8 }, { id: "x" }] }),
      json({ results: { tags: [{ id: "t1", name: "Indie" }, { tag_id: "t2", name: "Folk", type: "urn:tag:genre" }, { id: "t3" }] } }),
    );
    const c = client(f);
    expect(await c.searchEntities("artist")).toEqual([
      { entity_id: "a1", name: "Artist", type: "urn:entity:artist", popularity: 0.8 },
    ]);
    expect(await c.searchTags("indie")).toEqual([
      { id: "t1", name: "Indie" },
      { id: "t2", name: "Folk", type: "urn:tag:genre" },
    ]);
  });
});

describe("cache", () => {
  it("cache hit skips fetch and does not count as a call", async () => {
    const f = stubFetch(json({ results: [{ entity_id: "a1", name: "A" }] }));
    const c = client(f, { cache: createMemoryCache() });
    const first = await c.searchEntities("a");
    const second = await c.searchEntities("a");
    expect(second).toEqual(first);
    expect(f).toHaveBeenCalledTimes(1);
    expect(c.callCount()).toBe(1);
  });

  it("does not cache errors", async () => {
    const f = stubFetch(json({ error: "bad" }, 400), json({ results: [] }));
    const c = client(f, { cache: createMemoryCache() });
    await expect(c.searchEntities("a")).rejects.toBeInstanceOf(QlooError);
    expect(await c.searchEntities("a")).toEqual([]);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("file cache round-trips, expires and tolerates corrupt files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qloo-cache-"));
    try {
      const cache = createFileCache(dir);
      expect(await cache.get("k")).toBeUndefined();
      await cache.set("k", { a: 1 });
      expect(await cache.get("k")).toEqual({ a: 1 });

      const files = await readdir(join(dir, "qloo"));
      expect(files).toHaveLength(1);
      await writeFile(join(dir, "qloo", files[0]!), "{not json", "utf8");
      expect(await cache.get("k")).toBeUndefined();

      const expired = createFileCache(dir, -1);
      await expired.set("e", 1);
      expect(await expired.get("e")).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("decodeEntities", () => {
  it("decodes the HTML entities Qloo sometimes returns in names", async () => {
    const { decodeEntities } = await import("../server/qloo/client.ts");
    expect(decodeEntities("Ratchet &amp; Clank: Rift Apart")).toBe("Ratchet & Clank: Rift Apart");
    expect(decodeEntities("Rock &#39;n&#x27; Roll")).toBe("Rock 'n' Roll");
    expect(decodeEntities("AT&T &bogus;")).toBe("AT&T &bogus;");
  });
});
