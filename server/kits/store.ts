// Session-kit cache: `${dir}/kits/<planId>/<slotId>.json`, a sibling of the plans directory so
// reopening a kit is instant and costs no language-model call. Kits hold no resident data.
import { promises as fs } from "node:fs";
import path from "node:path";
import type { SessionKit } from "../../shared/types.ts";
import { atomicWriteJson, isValidPlanId } from "../plans-store.ts";
import { SessionKitZ } from "./generate.ts";

export interface KitStore {
  getKit(planId: string, slotId: string): Promise<SessionKit | null>;
  saveKit(kit: SessionKit): Promise<void>;
}

const SLOT_RE = /^s\d{1,3}$/;
export const isValidSlotId = (id: unknown): id is string => typeof id === "string" && SLOT_RE.test(id);

export function createKitStore(dir: string, opts: { maxAgeMs?: number } = {}): KitStore {
  const kitsDir = path.resolve(dir, "kits");
  // Plans are pruned at 90 days; kits follow the same window.
  const maxAgeMs = opts.maxAgeMs ?? 90 * 24 * 60 * 60 * 1000;
  // Reads ignore stale kits; this removes whole per-plan folders past the window (at most hourly).
  let lastPrune = 0;
  const maybePrune = () => {
    const now = Date.now();
    if (now - lastPrune < 60 * 60 * 1000) return;
    lastPrune = now;
    void (async () => {
      const names = await fs.readdir(kitsDir).catch(() => [] as string[]);
      for (const n of names) {
        const p = path.join(kitsDir, n);
        const st = await fs.stat(p).catch(() => null);
        if (st?.isDirectory() && now - st.mtimeMs > maxAgeMs) await fs.rm(p, { recursive: true, force: true }).catch(() => {});
      }
    })();
  };
  const file = (planId: string, slotId: string) => {
    if (!isValidPlanId(planId) || !isValidSlotId(slotId)) throw new Error("Invalid kit id");
    return path.join(kitsDir, planId.toLowerCase(), `${slotId}.json`);
  };
  return {
    async getKit(planId, slotId) {
      if (!isValidPlanId(planId) || !isValidSlotId(slotId)) return null;
      const f = file(planId, slotId);
      try {
        const st = await fs.stat(f);
        if (Date.now() - st.mtimeMs > maxAgeMs) return null;
        const parsed = SessionKitZ.safeParse(JSON.parse(await fs.readFile(f, "utf8")));
        // A corrupt or outdated file is treated as a miss and regenerated.
        return parsed.success ? parsed.data : null;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        if (err instanceof SyntaxError) return null;
        throw err;
      }
    },
    async saveKit(kit) {
      await atomicWriteJson(file(kit.planId, kit.slotId), SessionKitZ.parse(kit));
      maybePrune();
    },
  };
}
