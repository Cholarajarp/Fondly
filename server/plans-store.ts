import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { WeekPlan } from "../shared/types.ts";

export interface PlansStore {
  savePlan(plan: WeekPlan): Promise<void>;
  getPlan(id: string): Promise<WeekPlan | null>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidPlanId(id: unknown): id is string {
  return typeof id === "string" && UUID_RE.test(id);
}

export async function atomicWriteJson(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data), "utf8");
  try {
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

/**
 * Deletes `.json` files in `dir` last written more than `maxAgeMs` ago, and all but the newest
 * `maxFiles`. Returns how many were removed. A missing directory is a no-op.
 */
export async function pruneJsonDir(dir: string, maxAgeMs: number, maxFiles: number, now = Date.now()): Promise<number> {
  let names: string[];
  try {
    names = (await fs.readdir(dir)).filter((n) => n.endsWith(".json"));
  } catch {
    return 0;
  }
  const files = (
    await Promise.all(
      names.map(async (n) => {
        const file = path.join(dir, n);
        try {
          return { file, mtime: (await fs.stat(file)).mtimeMs };
        } catch {
          return null;
        }
      }),
    )
  ).filter((x): x is { file: string; mtime: number } => !!x);
  files.sort((a, b) => b.mtime - a.mtime);
  const cutoff = now - maxAgeMs;
  const doomed = files.filter((f, i) => i >= maxFiles || f.mtime < cutoff);
  await Promise.all(doomed.map((f) => fs.rm(f.file, { force: true })));
  return doomed.length;
}

export interface RetentionOptions {
  /** Plans older than this are deleted. Default 90 days. */
  maxAgeMs?: number;
  /** At most this many plans are kept (oldest removed first). Default 5000. */
  maxPlans?: number;
  /** Minimum time between prune passes. Default 10 minutes. */
  pruneEveryMs?: number;
}

/**
 * File-based store: `${dir}/plans/<id>.json`. Plans hold no resident names (only aliases r1, r2…
 * and public cultural favorites); names stay in the coordinator's browser.
 * Old plans are pruned after saves so the disk cannot fill up.
 */
export function createPlansStore(dir: string, opts: RetentionOptions = {}): PlansStore & { prune(): Promise<number> } {
  const plansDir = path.resolve(dir, "plans");
  const maxAgeMs = opts.maxAgeMs ?? 90 * 24 * 60 * 60 * 1000;
  const maxPlans = opts.maxPlans ?? 5000;
  const pruneEveryMs = opts.pruneEveryMs ?? 10 * 60 * 1000;
  let lastPrune = 0;
  const planFile = (id: string) => {
    if (!isValidPlanId(id)) throw new Error("Invalid plan id");
    return path.join(plansDir, `${id.toLowerCase()}.json`);
  };

  async function prune(): Promise<number> {
    lastPrune = Date.now();
    return pruneJsonDir(plansDir, maxAgeMs, maxPlans);
  }

  return {
    prune,
    async savePlan(plan) {
      await atomicWriteJson(planFile(plan.id), plan);
      if (Date.now() - lastPrune >= pruneEveryMs) {
        prune().catch((err) => console.warn("[plans] prune failed:", err instanceof Error ? err.message : err));
      }
    },
    async getPlan(id) {
      if (!isValidPlanId(id)) return null;
      try {
        return JSON.parse(await fs.readFile(planFile(id), "utf8")) as WeekPlan;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },
  };
}
