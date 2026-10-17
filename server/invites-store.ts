// Family taste link invites. An invite holds the resident ALIAS only (r1, r2…), never a name:
// the optional "who is this for" label lives in the link's #fragment, which browsers never send.
// Two secrets per invite:
//   token     - in the family's link; lets them read and edit their own answers.
//   manageKey - kept by the coordinator only; needed to read status and mark the invite reviewed.
// Files are keyed by SHA-256(token), so a directory listing or backup never reveals live tokens,
// and only a hash of the manage key is stored.

import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FamilySubmission, InviteStatus } from "../shared/types.ts";
import { atomicWriteJson, pruneJsonDir } from "./plans-store.ts";

/** 24 random bytes = 192 bits, base64url = 32 characters. */
const SECRET_BYTES = 24;
const SECRET_RE = /^[A-Za-z0-9_-]{32}$/;

export const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export const newSecret = (): string => randomBytes(SECRET_BYTES).toString("base64url");

export function isValidSecret(s: unknown): s is string {
  return typeof s === "string" && SECRET_RE.test(s);
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest();

export interface InviteRecord {
  v: 1;
  residentId: string;
  manageKeyHash: string;
  createdAt: string;
  expiresAt: string;
  status: InviteStatus;
  submittedAt?: string;
  reviewedAt?: string;
  submission?: FamilySubmission;
}

export type InviteLookup =
  | { ok: true; record: InviteRecord }
  | { ok: false; reason: "not_found" | "expired" };

export type SubmitResult = InviteLookup | { ok: false; reason: "reviewed" };

export interface InvitesStore {
  create(residentId: string): Promise<{ token: string; manageKey: string; record: InviteRecord }>;
  /** Family access: token only. */
  get(token: string): Promise<InviteLookup>;
  /** Coordinator access: token and manage key. A wrong key reads as not found. */
  getManaged(token: string, manageKey: string): Promise<InviteLookup>;
  /** One submission per invite; replaces the previous one until the coordinator has reviewed it. */
  submit(token: string, submission: FamilySubmission): Promise<SubmitResult>;
  markReviewed(token: string, manageKey: string): Promise<InviteLookup>;
  prune(): Promise<number>;
}

export interface InviteStoreOptions {
  ttlMs?: number;
  /** Files untouched for this long are deleted (must exceed ttlMs). Default 30 days. */
  maxAgeMs?: number;
  /** At most this many invites are kept. Default 5000. */
  maxInvites?: number;
  pruneEveryMs?: number;
  now?: () => number;
}

export function createInvitesStore(dir: string, opts: InviteStoreOptions = {}): InvitesStore {
  const invitesDir = path.resolve(dir, "invites");
  const ttlMs = opts.ttlMs ?? INVITE_TTL_MS;
  const maxAgeMs = Math.max(opts.maxAgeMs ?? 30 * 24 * 60 * 60 * 1000, ttlMs);
  const maxInvites = opts.maxInvites ?? 5000;
  const pruneEveryMs = opts.pruneEveryMs ?? 10 * 60 * 1000;
  const now = opts.now ?? Date.now;
  let lastPrune = 0;

  const fileFor = (token: string) => {
    if (!isValidSecret(token)) throw new Error("Invalid token");
    return path.join(invitesDir, `${sha256(token).toString("hex")}.json`);
  };

  // Per-invite write lock so two concurrent submits cannot interleave read-modify-write.
  const locks = new Map<string, Promise<unknown>>();
  function withLock<T>(token: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(token) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    locks.set(token, tail);
    void tail.then(() => {
      if (locks.get(token) === tail) locks.delete(token);
    });
    return run;
  }

  async function read(token: string): Promise<InviteRecord | null> {
    if (!isValidSecret(token)) return null;
    try {
      const rec = JSON.parse(await fs.readFile(fileFor(token), "utf8")) as InviteRecord;
      return rec?.v === 1 ? rec : null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async function lookup(token: string): Promise<InviteLookup> {
    const record = await read(token);
    if (!record) return { ok: false, reason: "not_found" };
    if (Date.parse(record.expiresAt) <= now()) return { ok: false, reason: "expired" };
    return { ok: true, record };
  }

  const keyMatches = (record: InviteRecord, manageKey: string) => {
    if (!isValidSecret(manageKey)) return false;
    const want = Buffer.from(record.manageKeyHash, "hex");
    const got = sha256(manageKey);
    return want.length === got.length && timingSafeEqual(want, got);
  };

  async function managed(token: string, manageKey: string): Promise<InviteLookup> {
    const record = await read(token);
    if (!record || !keyMatches(record, manageKey)) return { ok: false, reason: "not_found" };
    if (Date.parse(record.expiresAt) <= now()) return { ok: false, reason: "expired" };
    return { ok: true, record };
  }

  async function prune(): Promise<number> {
    lastPrune = now();
    return pruneJsonDir(invitesDir, maxAgeMs, maxInvites, now());
  }

  return {
    prune,
    async create(residentId) {
      const token = newSecret();
      const manageKey = newSecret();
      const t = now();
      const record: InviteRecord = {
        v: 1,
        residentId,
        manageKeyHash: sha256(manageKey).toString("hex"),
        createdAt: new Date(t).toISOString(),
        expiresAt: new Date(t + ttlMs).toISOString(),
        status: "waiting",
      };
      await atomicWriteJson(fileFor(token), record);
      if (now() - lastPrune >= pruneEveryMs) {
        prune().catch((err) => console.warn("[invites] prune failed:", err instanceof Error ? err.message : err));
      }
      return { token, manageKey, record };
    },
    get: lookup,
    getManaged: managed,
    submit(token, submission) {
      return withLock(token, async (): Promise<SubmitResult> => {
        const found = await lookup(token);
        if (!found.ok) return found;
        if (found.record.status === "reviewed") return { ok: false, reason: "reviewed" };
        const record: InviteRecord = { ...found.record, status: "received", submittedAt: new Date(now()).toISOString(), submission };
        await atomicWriteJson(fileFor(token), record);
        return { ok: true, record };
      });
    },
    markReviewed(token, manageKey) {
      return withLock(token, async () => {
        const found = await managed(token, manageKey);
        if (!found.ok) return found;
        // Reviewed invites keep no answers: the coordinator has them now.
        const { submission: _drop, ...rest } = found.record;
        const record: InviteRecord = { ...rest, status: "reviewed", reviewedAt: new Date(now()).toISOString() };
        await atomicWriteJson(fileFor(token), record);
        return { ok: true as const, record };
      });
    },
  };
}
