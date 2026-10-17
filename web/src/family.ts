// Family taste link, coordinator side. Invite secrets are kept in this browser only, mapped to the
// resident's alias. The "who is this for" label lives only in the link's #fragment and here; it is
// never sent to the server.
import { useCallback, useEffect, useRef, useState } from "react";
import type { CreatedInvite, FamilyItem, FamilySubmission, InviteStatusResult } from "../../shared/types";
import { createInvite, getInviteStatuses, markInviteReviewed } from "./api";
import type { RosterResident } from "./roster";

export interface FamilyLink {
  token: string;
  manageKey: string;
  createdAt: string;
  expiresAt: string;
  /** Optional name or label shown to the family, e.g. "Mum". Only ever in the #fragment. */
  label?: string;
  /** Set once the coordinator has added or dismissed the family's answers. */
  reviewedAt?: string;
}

interface Stored {
  rosterId: string;
  links: Record<string, FamilyLink>;
}

const KEY = "fondly.familyLinks.v1";
export const MAX_LABEL = 40;
const MAX_FAVORITES = 20;
const MAX_DECLINED = 40;

export const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;

/** `https://host/#/family/<token>?for=<label>`. Everything after # stays in the browser. */
export function familyUrl(origin: string, token: string, label?: string): string {
  const l = label?.trim().slice(0, MAX_LABEL);
  return `${origin}/#/family/${token}${l ? `?${new URLSearchParams({ for: l })}` : ""}`;
}

/** Parses `#/family/<token>[?for=label]`. */
export function parseFamilyHash(hash: string): { token: string; label?: string } | null {
  const m = /^#\/family\/([^/?#]+)(?:\?(.*))?$/.exec(hash);
  if (!m?.[1] || !TOKEN_RE.test(m[1])) return null;
  let label: string | undefined;
  try {
    label = new URLSearchParams(m[2] ?? "").get("for")?.trim().slice(0, MAX_LABEL) || undefined;
  } catch {
    label = undefined;
  }
  return { token: m[1], ...(label ? { label } : {}) };
}

/** What the roster shows for one resident. */
export type LinkState =
  | { kind: "none" }
  | { kind: "waiting"; link: FamilyLink }
  | { kind: "received"; link: FamilyLink; submission: FamilySubmission; submittedAt?: string }
  | { kind: "reviewed"; link: FamilyLink }
  | { kind: "expired"; link: FamilyLink };

export function linkState(link: FamilyLink | undefined, status: InviteStatusResult | undefined, now = Date.now()): LinkState {
  if (!link) return { kind: "none" };
  if (link.reviewedAt) return { kind: "reviewed", link };
  if (status && (!status.found || status.expired)) return { kind: "expired", link };
  if (Date.parse(link.expiresAt) <= now) return { kind: "expired", link };
  if (status?.status === "received" && status.submission) return { kind: "received", link, submission: status.submission, submittedAt: status.submittedAt };
  if (status?.status === "reviewed") return { kind: "reviewed", link };
  return { kind: "waiting", link };
}

const favKey = (f: { kind: string; text: string }) => `${f.kind}:${f.text.trim().toLowerCase()}`;

/**
 * Folds accepted family suggestions into a resident. Favorites are added as typed (deduped, up to
 * 20 in total). Things to avoid become declined Qloo ids, so the planner never matches them.
 */
export function mergeFamilyItems(
  r: RosterResident,
  accepted: { favorites: FamilyItem[]; avoid: FamilyItem[] },
): { resident: RosterResident; added: number; avoided: number; skipped: number } {
  const have = new Set(r.favorites.map(favKey));
  const favorites = [...r.favorites];
  let skipped = 0;
  for (const f of accepted.favorites) {
    const text = f.text.trim();
    if (!text || have.has(favKey(f))) continue;
    if (favorites.length >= MAX_FAVORITES) {
      skipped++;
      continue;
    }
    have.add(favKey(f));
    favorites.push({ kind: f.kind, text: text.slice(0, 120) });
  }
  const declined = [...r.declined];
  let avoided = 0;
  for (const a of accepted.avoid) {
    if (!a.entityId || declined.includes(a.entityId)) continue;
    if (declined.length >= MAX_DECLINED) {
      skipped++;
      continue;
    }
    declined.push(a.entityId);
    avoided++;
  }
  const declinedSet = new Set(declined);
  return {
    resident: { ...r, favorites, declined, loved: r.loved.filter((id) => !declinedSet.has(id)) },
    added: favorites.length - r.favorites.length,
    avoided,
    skipped,
  };
}

function load(rosterId: string): Record<string, FamilyLink> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const s = JSON.parse(raw) as Partial<Stored>;
    if (s?.rosterId !== rosterId || !s.links || typeof s.links !== "object") return {};
    const out: Record<string, FamilyLink> = {};
    for (const [id, l] of Object.entries(s.links)) {
      if (/^r\d{1,3}$/.test(id) && l && TOKEN_RE.test(l.token) && TOKEN_RE.test(l.manageKey)) out[id] = l;
    }
    return out;
  } catch {
    return {};
  }
}

const POLL_MS = 60_000;

/** Family links for the current roster, with live status from the server. */
export function useFamilyLinks(rosterId: string) {
  const [links, setLinks] = useState<Record<string, FamilyLink>>(() => load(rosterId));
  const [statuses, setStatuses] = useState<Record<string, InviteStatusResult>>({});
  const linksRef = useRef(links);
  linksRef.current = links;

  // A different roster (cleared or replaced) starts with no links.
  const loadedFor = useRef(rosterId);
  useEffect(() => {
    if (loadedFor.current === rosterId) return;
    loadedFor.current = rosterId;
    setLinks(load(rosterId));
    setStatuses({});
  }, [rosterId]);

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify({ rosterId, links } satisfies Stored));
    } catch {
      // Storage full or disabled: links still work for this session.
    }
  }, [rosterId, links]);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const open = Object.entries(linksRef.current).filter(([, l]) => !l.reviewedAt && Date.parse(l.expiresAt) > Date.now());
    if (open.length === 0) return;
    try {
      const res = await getInviteStatuses(open.map(([, l]) => ({ token: l.token, manageKey: l.manageKey })), signal);
      const byToken = new Map(res.invites.map((s) => [s.token, s]));
      setStatuses((prev) => {
        const next = { ...prev };
        for (const [id, l] of open) {
          const s = byToken.get(l.token);
          if (s) next[id] = s;
        }
        return next;
      });
    } catch {
      // Offline or rate limited: keep the last known statuses and try again on the next poll.
    }
  }, []);

  const openCount = Object.values(links).filter((l) => !l.reviewedAt).length;
  useEffect(() => {
    if (openCount === 0) return;
    const ctl = new AbortController();
    void refresh(ctl.signal);
    const tick = () => {
      if (document.visibilityState === "visible") void refresh(ctl.signal);
    };
    const id = window.setInterval(tick, POLL_MS);
    window.addEventListener("focus", tick);
    return () => {
      ctl.abort();
      window.clearInterval(id);
      window.removeEventListener("focus", tick);
    };
  }, [openCount, refresh]);

  const create = useCallback(async (residentId: string, label?: string): Promise<FamilyLink> => {
    const inv: CreatedInvite = await createInvite(residentId);
    const l = label?.trim().slice(0, MAX_LABEL);
    const link: FamilyLink = { token: inv.token, manageKey: inv.manageKey, createdAt: inv.createdAt, expiresAt: inv.expiresAt, ...(l ? { label: l } : {}) };
    setLinks((x) => ({ ...x, [residentId]: link }));
    setStatuses((x) => {
      const { [residentId]: _old, ...rest } = x;
      return rest;
    });
    return link;
  }, []);

  /** Marks the family's answers handled on the server (which then deletes them) and locally. */
  const complete = useCallback(async (residentId: string) => {
    const link = linksRef.current[residentId];
    if (!link) return;
    try {
      await markInviteReviewed(link.token, link.manageKey);
    } catch {
      // Already reviewed or expired on the server: the local record is still marked done.
    }
    setLinks((x) => (x[residentId] ? { ...x, [residentId]: { ...x[residentId]!, reviewedAt: new Date().toISOString() } } : x));
  }, []);

  const forget = useCallback((residentId: string) => {
    setLinks(({ [residentId]: _gone, ...rest }) => rest);
    setStatuses(({ [residentId]: _gone, ...rest }) => rest);
  }, []);

  const stateOf = useCallback((residentId: string) => linkState(links[residentId], statuses[residentId]), [links, statuses]);

  return { stateOf, create, complete, forget, refresh };
}

export type FamilyLinks = ReturnType<typeof useFamilyLinks>;
