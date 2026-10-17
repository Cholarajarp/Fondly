// SECURITY NOTE: public like the other plan endpoints (no login for hackathon judges). Kits are
// read from cache when possible; only cache misses call Gemini, and those are bounded by a per-IP
// hourly limit and a daily cap. Kits contain no resident data.

import { Router, type Request, type Response, type NextFunction } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import type { SessionKit, SessionKitResponse } from "../../shared/types.ts";
import type { GeminiClient } from "../agent/gemini.ts";
import { isValidPlanId, type PlansStore } from "../plans-store.ts";
import { generateKit, templateKit } from "../kits/generate.ts";
import { isValidSlotId, type KitStore } from "../kits/store.ts";

export interface KitRouteDeps {
  plans: PlansStore;
  kits: KitStore;
  getGemini: () => GeminiClient;
  /** True when a Gemini key is configured. Without one, kits are built from the template. */
  llmConfigured: () => boolean;
  /** Language-model kit generations per IP per hour. Cache hits don't count. */
  perHourLimit: number;
  /** Language-model kit generations per UTC day, all users. */
  dailyCap: number;
}

// The endpoint takes no options; anything in the body is rejected so the contract stays explicit.
const KitBodySchema = z.object({}).strict();

export function createKitRouter(deps: KitRouteDeps): Router {
  const router = Router();
  let day = "";
  let count = 0;
  const takeDaily = () => {
    const d = new Date().toISOString().slice(0, 10);
    if (d !== day) {
      day = d;
      count = 0;
    }
    if (count >= deps.dailyCap) return false;
    count++;
    return true;
  };
  // Two clicks on the same kit share one Gemini call.
  const inflight = new Map<string, Promise<SessionKit>>();

  const generationLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: deps.perHourLimit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({ error: "You've hit the hourly limit for session kits in this demo. Please try again later." });
    },
  });
  // Every request (hits included) is still bounded so plan ids and slots can't be scanned quickly.
  const requestLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: Math.max(240, deps.perHourLimit * 10),
    standardHeaders: false,
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({ error: "Too many requests. Please try again later." });
    },
  });

  router.post("/plans/:id/sessions/:sid/kit", requestLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id, sid } = req.params as { id: string; sid: string };
      if (!isValidPlanId(id) || !isValidSlotId(sid)) {
        res.status(400).json({ error: "Invalid plan or session id" });
        return;
      }
      const body = KitBodySchema.safeParse(req.body ?? {});
      if (!body.success) {
        res.status(400).json({ error: "Invalid request", issues: body.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
        return;
      }
      const plan = await deps.plans.getPlan(id);
      const session = plan?.sessions.find((s) => s.slotId === sid);
      if (!plan || !session) {
        res.status(404).json({ error: plan ? "Session not found" : "Plan not found" });
        return;
      }

      const cached = await deps.kits.getKit(plan.id, sid);
      if (cached && cached.entityId === session.entity.entity_id) {
        res.json({ kit: cached, cached: true } satisfies SessionKitResponse);
        return;
      }

      if (!deps.llmConfigured()) {
        // Template kits are deterministic and free, so they are not cached.
        res.json({ kit: templateKit(session, plan.id, "No language model is configured on this server, so this kit is built from Qloo data only."), cached: false } satisfies SessionKitResponse);
        return;
      }

      const key = `${plan.id}/${sid}`;
      let pending = inflight.get(key);
      if (!pending) {
        // Only new generations count against the hourly limit and the daily cap.
        const allowed = await new Promise<boolean>((resolve) => {
          void generationLimiter(req, res, () => resolve(true));
          res.once("finish", () => resolve(false));
        });
        if (!allowed) return;
        if (!takeDaily()) {
          res.status(429).json({ error: "The demo has reached its daily limit for session kits. Please try again tomorrow." });
          return;
        }
        pending = (async () => {
          const kit = await generateKit(deps.getGemini, session, plan.id);
          // Template kits after a failure are not cached, so a later open can still get the full kit.
          if (kit.source === "gemini") await deps.kits.saveKit(kit);
          return kit;
        })().finally(() => inflight.delete(key));
        inflight.set(key, pending);
      }
      const kit = await pending;
      res.json({ kit, cached: false } satisfies SessionKitResponse);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
