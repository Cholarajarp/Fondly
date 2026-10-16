// Family taste link. SECURITY NOTE: like the rest of the public demo these endpoints have no login.
// Access is by unguessable secrets instead: the family holds a 192-bit token, the coordinator holds
// the token plus a second 192-bit manage key. Secrets travel in headers or JSON bodies, never in URL
// paths, so request logs (path only) never record them. Invites hold a resident alias, never a name.
// Every endpoint is rate limited per IP; creation and Qloo search also have daily caps.

import { Router, type Request, type Response, type NextFunction } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import {
  FAVORITE_KINDS,
  QlooError,
  type CreatedInvite,
  type FamilyInviteView,
  type FamilySubmission,
  type FamilySuggestion,
  type FavoriteKind,
  type InviteStatusResult,
  type QlooClient,
  type QlooEntity,
} from "../../shared/types.ts";
import { DOMAIN_TAG, KIND_TYPE } from "../engine/qloo-ops.ts";
import { isValidSecret, type InvitesStore } from "../invites-store.ts";

export const TOKEN_HEADER = "x-family-token";

export interface FamilyLimits {
  /** Invites created per IP per hour. */
  createPerHour: number;
  /** Family page loads and coordinator status checks per IP per hour. */
  readPerHour: number;
  /** Family submissions (including edits) per IP per hour. */
  submitPerHour: number;
  /** Autocomplete searches per IP per hour. */
  searchPerHour: number;
  /** Invites created per UTC day, all users. */
  createDailyCap: number;
  /** Qloo searches per UTC day, all users. */
  searchDailyCap: number;
}

export const DEFAULT_FAMILY_LIMITS: FamilyLimits = {
  createPerHour: 60,
  readPerHour: 600,
  submitPerHour: 30,
  searchPerHour: 400,
  createDailyCap: 2000,
  searchDailyCap: 5000,
};

export interface FamilyRouteDeps {
  store: InvitesStore;
  getQloo: () => QlooClient;
  qlooConfigured: () => boolean;
  limits?: Partial<FamilyLimits>;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export const MAX_FAMILY_FAVORITES = 30;
export const MAX_FAMILY_AVOID = 15;

const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const PHONE_RE = /\d[\d\s().-]{6,}\d/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

const itemText = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine((s) => !CONTROL_RE.test(s), "Use plain text")
  .refine((s) => !EMAIL_RE.test(s) && !PHONE_RE.test(s), "Please don't include contact details");
// Qloo entity ids are UUID-like; tag ids look like urn:tag:genre:place:restaurant:italian.
// Same id rule as plan requests, because accepted "avoid" ids become a resident's declined list.
const qlooId = z.string().regex(/^[A-Za-z0-9_:-]{1,100}$/, "Expected a Qloo id");
const kind = z.enum(FAVORITE_KINDS as unknown as [FavoriteKind, ...FavoriteKind[]]);
const AVOID_KINDS = FAVORITE_KINDS.filter((k) => k !== "food") as Exclude<FavoriteKind, "food">[];

const dedupe = <T extends { kind: string; text: string }>(items: T[]) =>
  new Set(items.map((i) => `${i.kind}:${i.text.toLowerCase()}`)).size === items.length;

export const FamilySubmissionSchema = z
  .object({
    favorites: z
      .array(z.object({ kind, text: itemText, entityId: qlooId.optional() }).strict())
      .max(MAX_FAMILY_FAVORITES)
      .refine(dedupe, "Each favorite only once"),
    // Things to avoid must be picked Qloo entities (they become "declined" ids), never food or free text.
    avoid: z
      .array(z.object({ kind: z.enum(AVOID_KINDS as [Exclude<FavoriteKind, "food">, ...Exclude<FavoriteKind, "food">[]]), text: itemText, entityId: qlooId }).strict())
      .max(MAX_FAMILY_AVOID)
      .refine(dedupe, "Each item only once"),
  })
  .strict()
  .refine((s) => s.favorites.length + s.avoid.length > 0, "Add at least one favorite");

const secret = z.string().refine(isValidSecret, "Invalid link");
const CreateSchema = z.object({ residentId: z.string().regex(/^r\d{1,3}$/) }).strict();
const ManageSchema = z.object({ token: secret, manageKey: secret }).strict();
const StatusSchema = z.object({ invites: z.array(ManageSchema).min(1).max(60) }).strict();
const SearchSchema = z.object({ kind, q: z.string().trim().min(2).max(80) }).strict();

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

function dailyCounter(cap: number) {
  let day = "";
  let count = 0;
  return () => {
    const d = new Date().toISOString().slice(0, 10);
    if (d !== day) {
      day = d;
      count = 0;
    }
    if (count >= cap) return false;
    count++;
    return true;
  };
}

const MESSAGES = {
  not_found: "We couldn't find this link. Please check it was copied in full, or ask the care home for a new one.",
  expired: "This link has expired. Links last 14 days, so please ask the care home for a new one.",
  reviewed: "Thank you. The care home has already added your suggestions, so this link is now closed.",
} as const;

function suggestion(e: QlooEntity): FamilySuggestion {
  const year = e.properties?.release_year;
  const where = e.properties?.geocode?.name;
  return {
    id: e.entity_id,
    name: e.name,
    ...(year ? { detail: String(year) } : where ? { detail: where } : {}),
  };
}

/** Qloo-backed autocomplete for one favorite kind. Mirrors how favorites are resolved for planning. */
export async function searchFamily(qloo: QlooClient, k: FavoriteKind, q: string): Promise<FamilySuggestion[]> {
  if (k === "food") {
    const tags = await qloo.searchTags(q, 10);
    const food = tags.filter((t) => /genre:place|restaurant|cuisine|dish|food/i.test(`${t.id} ${t.type ?? ""}`));
    // Qloo often returns the same cuisine under several tag families; show each name once.
    const names = new Set<string>();
    return (food.length ? food : tags)
      .filter((t) => !names.has(t.name.toLowerCase()) && names.add(t.name.toLowerCase()))
      .slice(0, 6)
      .map((t) => ({ id: t.id, name: t.name }));
  }
  const res = await qloo.searchEntities(q, [KIND_TYPE[k]], 10);
  const tag = DOMAIN_TAG[k];
  const kept = tag ? res.filter((e) => e.tags?.some((t) => t.id === tag || t.id.startsWith(`${tag}:`))) : res;
  const seen = new Set<string>();
  return kept
    .filter((e) => !seen.has(e.entity_id) && seen.add(e.entity_id))
    .slice(0, 6)
    .map(suggestion);
}

export function createFamilyRouter(deps: FamilyRouteDeps): Router {
  const router = Router();
  const limits = { ...DEFAULT_FAMILY_LIMITS, ...deps.limits };
  const takeCreate = dailyCounter(limits.createDailyCap);
  const takeSearch = dailyCounter(limits.searchDailyCap);

  const limiter = (limit: number) =>
    rateLimit({
      windowMs: 60 * 60 * 1000,
      limit,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      handler: (_req, res) => {
        res.status(429).json({ error: "Too many requests from this connection. Please try again in a little while." });
      },
    });
  const createLimiter = limiter(limits.createPerHour);
  const readLimiter = limiter(limits.readPerHour);
  const submitLimiter = limiter(limits.submitPerHour);
  const searchLimiter = limiter(limits.searchPerHour);

  // Answers are personal to one family: never cache them in shared caches.
  router.use(["/invites", "/family"], (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  const badRequest = (res: Response, error: z.ZodError) =>
    res.status(400).json({
      error: "Please check your answers",
      issues: error.issues.slice(0, 10).map((i) => ({ path: i.path.join("."), message: i.message })),
    });

  const tokenOf = (req: Request): string | null => {
    const t = req.get(TOKEN_HEADER);
    return isValidSecret(t) ? t : null;
  };

  const fail = (res: Response, reason: keyof typeof MESSAGES) =>
    res.status(reason === "not_found" ? 404 : reason === "expired" ? 410 : 409).json({ error: MESSAGES[reason], reason });

  // --- coordinator --------------------------------------------------------

  router.post("/invites", createLimiter, async (req, res, next) => {
    try {
      const parsed = CreateSchema.safeParse(req.body);
      if (!parsed.success) return void badRequest(res, parsed.error);
      if (!takeCreate()) return void res.status(429).json({ error: "The demo has reached its daily limit for family links. Please try again tomorrow." });
      const { token, manageKey, record } = await deps.store.create(parsed.data.residentId);
      const body: CreatedInvite = { token, manageKey, residentId: record.residentId, createdAt: record.createdAt, expiresAt: record.expiresAt };
      res.status(201).json(body);
    } catch (err) {
      next(err);
    }
  });

  router.post("/invites/status", readLimiter, async (req, res, next) => {
    try {
      const parsed = StatusSchema.safeParse(req.body);
      if (!parsed.success) return void badRequest(res, parsed.error);
      const results = await Promise.all(
        parsed.data.invites.map(async ({ token, manageKey }): Promise<InviteStatusResult> => {
          const found = await deps.store.getManaged(token, manageKey);
          if (!found.ok) return found.reason === "expired" ? { token, found: true, expired: true } : { token, found: false };
          const r = found.record;
          return {
            token,
            found: true,
            status: r.status,
            residentId: r.residentId,
            expiresAt: r.expiresAt,
            ...(r.submittedAt ? { submittedAt: r.submittedAt } : {}),
            ...(r.submission ? { submission: r.submission } : {}),
          };
        }),
      );
      res.json({ invites: results });
    } catch (err) {
      next(err);
    }
  });

  router.post("/invites/review", submitLimiter, async (req, res, next) => {
    try {
      const parsed = ManageSchema.safeParse(req.body);
      if (!parsed.success) return void badRequest(res, parsed.error);
      const done = await deps.store.markReviewed(parsed.data.token, parsed.data.manageKey);
      if (!done.ok) return void fail(res, done.reason);
      res.json({ status: done.record.status });
    } catch (err) {
      next(err);
    }
  });

  // --- family -------------------------------------------------------------

  router.get("/family", readLimiter, async (req, res, next) => {
    try {
      const token = tokenOf(req);
      if (!token) return void fail(res, "not_found");
      const found = await deps.store.get(token);
      if (!found.ok) return void fail(res, found.reason);
      const r = found.record;
      const view: FamilyInviteView = { status: r.status, expiresAt: r.expiresAt, ...(r.submission ? { submission: r.submission } : {}) };
      res.json(view);
    } catch (err) {
      next(err);
    }
  });

  router.put("/family", submitLimiter, async (req, res, next) => {
    try {
      const token = tokenOf(req);
      if (!token) return void fail(res, "not_found");
      const parsed = FamilySubmissionSchema.safeParse(req.body);
      if (!parsed.success) return void badRequest(res, parsed.error);
      const done = await deps.store.submit(token, parsed.data as FamilySubmission);
      if (!done.ok) return void fail(res, done.reason);
      res.json({ status: done.record.status, submittedAt: done.record.submittedAt });
    } catch (err) {
      next(err);
    }
  });

  router.get("/family/search", searchLimiter, async (req, res, next) => {
    try {
      const token = tokenOf(req);
      if (!token) return void fail(res, "not_found");
      const parsed = SearchSchema.safeParse({ kind: req.query.kind, q: req.query.q });
      if (!parsed.success) return void badRequest(res, parsed.error);
      // Only live invites may search, so this cannot be used as an open Qloo proxy.
      const found = await deps.store.get(token);
      if (!found.ok) return void fail(res, found.reason);
      if (found.record.status === "reviewed") return void fail(res, "reviewed");
      if (!deps.qlooConfigured()) return void res.status(503).json({ error: "Suggestions are not available right now. You can still type a name and add it." });
      if (!takeSearch()) return void res.status(429).json({ error: "Suggestions are paused for today. You can still type a name and add it." });
      try {
        res.json({ results: await searchFamily(deps.getQloo(), parsed.data.kind, parsed.data.q) });
      } catch (err) {
        console.warn(`[family] search failed: ${err instanceof QlooError ? `status=${err.status}` : (err as Error)?.name ?? "Error"}`);
        res.status(502).json({ error: "Suggestions are not available right now. You can still type a name and add it." });
      }
    } catch (err) {
      next(err);
    }
  });

  return router;
}
