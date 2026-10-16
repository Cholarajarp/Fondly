import { describe, expect, it } from "vitest";
import { computeMetrics, fillInOrder, optimize, optimizeBest, unreached, type EngineCandidate, type EngineSlot } from "../server/engine/optimize.ts";
import { rankFits } from "../server/engine/qloo-ops.ts";

const cand = (id: string, domain: EngineCandidate["domain"], fits: Record<string, number>): EngineCandidate => ({
  id,
  domain,
  fit: new Map(Object.entries(fits)),
});

describe("optimize", () => {
  const residents = ["r1", "r2", "r3"];
  const slots: EngineSlot[] = [
    { id: "s1", domain: "music", attendees: ["r1", "r2", "r3"] },
    { id: "s2", domain: "music", attendees: ["r1", "r2", "r3"] },
  ];

  it("prefers reaching everyone over maximizing the crowd favorite", () => {
    // "pop" delights r1 and r2; nothing else matters to them. r3 only likes "niche".
    const cands = [
      cand("pop", "music", { r1: 1, r2: 1, r3: 0 }),
      cand("pop2", "music", { r1: 0.95, r2: 0.95, r3: 0 }),
      cand("niche", "music", { r1: 0.1, r2: 0.1, r3: 1 }),
    ];
    const res = optimize({ slots, candidates: cands, residents });
    const picked = new Set(res.bySlot.values());
    expect(picked.has("niche")).toBe(true);
    expect(res.metrics.reached).toBe(3);
    expect(res.metrics.minBest).toBe(1);
  });

  it("never reuses a candidate and respects attendance", () => {
    const s: EngineSlot[] = [
      { id: "s1", domain: "film", attendees: ["r1"] },
      { id: "s2", domain: "film", attendees: ["r2"] },
    ];
    const cands = [cand("a", "film", { r1: 1, r2: 1 }), cand("b", "film", { r1: 0.5, r2: 0.9 })];
    const res = optimize({ slots: s, candidates: cands, residents: ["r1", "r2"] });
    expect(new Set(res.bySlot.values()).size).toBe(2);
    expect(res.bySlot.get("s1")).toBe("a");
    expect(res.bySlot.get("s2")).toBe("b");
  });

  it("honors locked slots, exclusions and declined (blocked) items", () => {
    const cands = [
      { ...cand("x", "music", { r1: 1, r2: 1, r3: 1 }), blocked: new Set(["r3"]) },
      cand("y", "music", { r1: 0.2, r2: 0.2, r3: 0.9 }),
      cand("z", "music", { r1: 1, r2: 1, r3: 1 }),
    ];
    const res = optimize({ slots, candidates: cands, residents, locked: new Map([["s1", "y"]]), exclude: new Set(["z"]) });
    expect(res.bySlot.get("s1")).toBe("y");
    expect(res.bySlot.get("s2")).toBe("x");
    // r3 declined x, so their best is y (0.9), not x.
    expect(res.metrics.minBest).toBe(0.9);
  });

  it("is never worse than a baseline seed on the same pool", () => {
    const cands = [
      cand("a", "music", { r1: 0.9, r2: 0.1, r3: 0.1 }),
      cand("b", "music", { r1: 0.1, r2: 0.9, r3: 0.1 }),
      cand("c", "music", { r1: 0.1, r2: 0.1, r3: 0.9 }),
      cand("d", "music", { r1: 0.85, r2: 0.85, r3: 0.85 }),
    ];
    const seed = fillInOrder(slots, cands);
    const seeded = computeMetrics(seed, slots, cands, residents);
    const res = optimizeBest({ slots, candidates: cands, residents }, [seed]);
    expect(res.metrics.reached).toBeGreaterThanOrEqual(seeded.reached);
    expect(res.metrics.minBest).toBeGreaterThanOrEqual(seeded.minBest);
    expect(unreached(res, { slots, candidates: cands, residents })).toEqual([]);
  });
});

describe("rankFits", () => {
  it("turns affinities into percentile ranks with ties sharing a rank", () => {
    const fits = rankFits([
      { entity_id: "a", name: "a", affinity: 0.2 },
      { entity_id: "b", name: "b", affinity: 0.9 },
      { entity_id: "c", name: "c", affinity: 0.5 },
      { entity_id: "d", name: "d", affinity: 0.5 },
      { entity_id: "e", name: "e" },
    ]);
    expect(fits.get("a")).toBe(0);
    expect(fits.get("b")).toBe(1);
    expect(fits.get("c")).toBe(0.5);
    expect(fits.get("d")).toBe(0.5);
    expect(fits.has("e")).toBe(false);
  });
});
