// Private server-side cache for Qloo responses (allowed by Qloo's terms).
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { pruneJsonDir } from "../plans-store.ts";

export interface QlooCache {
  get(key: string): Promise<unknown | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

interface Entry {
  expiresAt: number;
  value: unknown;
}

/** File cache: one JSON file per sha256(key) under `<dir>/qloo/`. */
export function createFileCache(
  dir: string = process.env.CACHE_DIR ?? ".cache",
  ttlMs: number = DAY_MS,
  maxFiles: number = 2000,
): QlooCache {
  const root = join(dir, "qloo");
  let ready: Promise<unknown> | undefined;
  const ensureDir = () => (ready ??= mkdir(root, { recursive: true }));
  const fileFor = (key: string) => join(root, `${createHash("sha256").update(key).digest("hex")}.json`);
  // Expired entries are skipped on read but would otherwise pile up on the persistent disk.
  // Prune at most hourly (and once at boot), keeping files younger than the TTL and capping count.
  let lastPrune = 0;
  const maybePrune = () => {
    const now = Date.now();
    if (now - lastPrune < 60 * 60 * 1000) return;
    lastPrune = now;
    void pruneJsonDir(root, ttlMs, maxFiles, now).catch(() => {});
  };

  return {
    async get(key) {
      try {
        const raw = await readFile(fileFor(key), "utf8");
        const entry = JSON.parse(raw) as Partial<Entry>;
        if (typeof entry?.expiresAt !== "number" || entry.expiresAt < Date.now()) return undefined;
        return entry.value;
      } catch {
        // Missing or corrupt file: treat as a miss.
        return undefined;
      }
    },
    async set(key, value) {
      try {
        await ensureDir();
        const file = fileFor(key);
        const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
        const entry: Entry = { expiresAt: Date.now() + ttlMs, value };
        await writeFile(tmp, JSON.stringify(entry), "utf8");
        await rename(tmp, file);
        maybePrune();
      } catch {
        // Cache write failures must never break a request.
        ready = undefined;
      }
    },
  };
}

/** In-memory cache, mainly for tests. */
export function createMemoryCache(ttlMs: number = DAY_MS): QlooCache {
  const map = new Map<string, Entry>();
  return {
    async get(key) {
      const e = map.get(key);
      if (!e) return undefined;
      if (e.expiresAt < Date.now()) {
        map.delete(key);
        return undefined;
      }
      return e.value;
    },
    async set(key, value) {
      map.set(key, { expiresAt: Date.now() + ttlMs, value });
    },
  };
}
