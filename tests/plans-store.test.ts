import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createPlansStore } from "../server/plans-store.ts";
import type { WeekPlan } from "../shared/types.ts";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), "fondly-store-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const plan = () => ({ id: randomUUID() }) as WeekPlan;

describe("plans store retention", () => {
  it("deletes plans past the age limit", async () => {
    const dir = tmp();
    const store = createPlansStore(dir, { maxAgeMs: 60_000, pruneEveryMs: Infinity });
    const old = plan();
    const fresh = plan();
    await store.savePlan(old);
    await store.savePlan(fresh);
    const past = new Date(Date.now() - 120_000);
    utimesSync(path.join(dir, "plans", `${old.id}.json`), past, past);
    expect(await store.prune()).toBe(1);
    expect(await store.getPlan(old.id)).toBeNull();
    expect(await store.getPlan(fresh.id)).not.toBeNull();
  });

  it("keeps at most maxPlans, newest first", async () => {
    const dir = tmp();
    const store = createPlansStore(dir, { maxPlans: 2, pruneEveryMs: Infinity });
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const p = plan();
      ids.push(p.id);
      await store.savePlan(p);
      const t = new Date(Date.now() - (4 - i) * 1000);
      utimesSync(path.join(dir, "plans", `${p.id}.json`), t, t);
    }
    expect(await store.prune()).toBe(2);
    expect(readdirSync(path.join(dir, "plans"))).toHaveLength(2);
    expect(await store.getPlan(ids[3]!)).not.toBeNull();
    expect(await store.getPlan(ids[0]!)).toBeNull();
  });

  it("prune on an empty store is a no-op", async () => {
    expect(await createPlansStore(tmp()).prune()).toBe(0);
  });
});
