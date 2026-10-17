// SECURITY NOTE: the API is intentionally public (hackathon judges use it without login).
// Abuse is bounded by the per-IP rate limit, the concurrency cap and the daily cap on POST /api/plan.

import express, { type Express, type Request, type Response, type NextFunction } from "express";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { GeminiClient } from "./agent/run.ts";
import type { QlooClient } from "../shared/types.ts";
import { config, missingKeys as defaultMissingKeys } from "./config.ts";
import { createPlansStore, type PlansStore } from "./plans-store.ts";
import { createInvitesStore, type InvitesStore } from "./invites-store.ts";
import { createFamilyRouter, type FamilyLimits } from "./routes/family.ts";
import { createHealthRouter } from "./routes/health.ts";
import { isNvidiaConfigured } from "./agent/nvidia.ts";
import { createPlanRouter, type RunAgent } from "./routes/plan.ts";
import { createKitRouter } from "./routes/kits.ts";
import { createKitStore, type KitStore } from "./kits/store.ts";

export interface AppDeps {
  store?: PlansStore;
  kitStore?: KitStore;
  /** Gemini kit generations per IP per hour (cache hits are free). Defaults to 3x the plan limit. */
  kitPerHourLimit?: number;
  invites?: InvitesStore;
  familyLimits?: Partial<FamilyLimits>;
  getQloo?: () => QlooClient;
  getGemini?: () => GeminiClient;
  runAgent?: RunAgent;
  missingKeys?: () => string[];
  qlooConfigured?: () => boolean;
  llmConfigured?: () => boolean;
  llmFallbackConfigured?: () => boolean;
  model?: string;
  perHourLimit?: number;
  dailyCap?: number;
  maxConcurrent?: number;
  heartbeatMs?: number;
  /** Serve dist/web with SPA fallback. Defaults to NODE_ENV === "production". */
  serveStatic?: boolean;
  staticDir?: string;
  logRequests?: boolean;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_STATIC_DIR = path.resolve(here, "..", "dist", "web");

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  // Any https image: Qloo entity images are served from undocumented CDN hosts. Images can't execute code.
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", CSP);
  next();
}

function requestLogger(req: Request, res: Response, next: NextFunction) {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    // Path only (no query string, no bodies).
    const urlPath = req.originalUrl.split("?")[0];
    console.log(`${req.method} ${urlPath} ${res.statusCode} ${ms.toFixed(0)}ms`);
  });
  next();
}

function notConfigured(name: string): never {
  throw new Error(`${name} client is not configured`);
}

export function createApp(deps: AppDeps = {}): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1); // Render sits behind one proxy hop.

  if (deps.logRequests ?? config.NODE_ENV !== "test") app.use(requestLogger);
  app.use(securityHeaders);
  // Family link bodies are small (at most 45 short items), so they get a tighter limit, parsed first.
  app.use(["/api/invites", "/api/family"], express.json({ limit: "16kb" }));
  // A full roster (60 residents x 20 favorites) plus replan reactions fits well under this; zod bounds every field.
  app.use(express.json({ limit: "256kb" }));

  const missingKeys = deps.missingKeys ?? defaultMissingKeys;
  const store = deps.store ?? createPlansStore(config.CACHE_DIR);
  const qlooConfigured = deps.qlooConfigured ?? (() => !missingKeys().includes("QLOO_API_KEY"));

  app.use(
    "/api",
    createHealthRouter({
      qlooConfigured,
      llmConfigured: deps.llmConfigured ?? (() => !missingKeys().includes("GEMINI_API_KEY")),
      llmFallbackConfigured: deps.llmFallbackConfigured ?? isNvidiaConfigured,
      model: deps.model ?? config.GEMINI_MODEL,
    }),
  );

  app.use(
    "/api",
    createPlanRouter({
      store,
      missingKeys,
      getQloo: deps.getQloo ?? (() => notConfigured("Qloo")),
      getGemini: deps.getGemini ?? (() => notConfigured("Gemini")),
      runAgent: deps.runAgent,
      perHourLimit: deps.perHourLimit ?? config.PUBLIC_RATE_LIMIT_PER_HOUR,
      dailyCap: deps.dailyCap ?? config.DAILY_PLAN_CAP,
      maxConcurrent: deps.maxConcurrent ?? 3,
      heartbeatMs: deps.heartbeatMs,
    }),
  );

  const perHour = deps.perHourLimit ?? config.PUBLIC_RATE_LIMIT_PER_HOUR;
  const daily = deps.dailyCap ?? config.DAILY_PLAN_CAP;
  app.use(
    "/api",
    createKitRouter({
      plans: store,
      kits: deps.kitStore ?? createKitStore(config.CACHE_DIR),
      getGemini: deps.getGemini ?? (() => notConfigured("Gemini")),
      llmConfigured: deps.llmConfigured ?? (() => !missingKeys().includes("GEMINI_API_KEY")),
      perHourLimit: deps.kitPerHourLimit ?? perHour * 3,
      // A plan has at most 21 sessions; allow a kit for every session of every daily plan.
      dailyCap: daily * 21,
    }),
  );

  app.use(
    "/api",
    createFamilyRouter({
      store: deps.invites ?? createInvitesStore(config.CACHE_DIR),
      getQloo: deps.getQloo ?? (() => notConfigured("Qloo")),
      qlooConfigured,
      limits: deps.familyLimits,
    }),
  );

  // Unknown API routes -> JSON 404 (never the SPA).
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  const serveStatic = deps.serveStatic ?? config.NODE_ENV === "production";
  if (serveStatic) {
    const staticDir = deps.staticDir ?? DEFAULT_STATIC_DIR;
    const indexHtml = path.join(staticDir, "index.html");
    app.use(express.static(staticDir, { index: false, maxAge: "1h" }));
    app.get(/^(?!\/api(?:\/|$)).*/, (_req, res, next) => {
      if (!existsSync(indexHtml)) return next();
      res.setHeader("Cache-Control", "no-cache");
      res.sendFile(indexHtml);
    });
  }

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  // Final error handler: no stack traces or internals leak to clients.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const e = err as { type?: string; status?: number; name?: string };
    if (e?.type === "entity.parse.failed") {
      res.status(400).json({ error: "Invalid JSON body" });
      return;
    }
    if (e?.type === "entity.too.large") {
      res.status(413).json({ error: "Request body too large" });
      return;
    }
    console.error(`[error] ${e?.name ?? "Error"}`);
    if (res.headersSent) {
      res.end();
      return;
    }
    res.status(500).json({ error: "Internal error" });
  });

  return app;
}
