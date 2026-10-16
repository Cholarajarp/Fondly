import { useEffect, useId, useState } from "react";
import type { FamilyItem } from "../../../shared/types";
import { describeError } from "../api";
import { MAX_LABEL, familyUrl, mergeFamilyItems, type FamilyLinks, type LinkState } from "../family";
import type { RosterResident } from "../roster";
import { KIND_LABEL } from "./RosterEditor";

const STATUS_TEXT: Record<LinkState["kind"], string> = {
  none: "Not sent",
  waiting: "Waiting",
  received: "Response received",
  reviewed: "Added",
  expired: "Expired",
};
const STATUS_CLASS: Record<LinkState["kind"], string> = {
  none: "badge",
  waiting: "badge badge-warn",
  received: "badge badge-brand",
  reviewed: "badge badge-sage",
  expired: "badge",
};

export function FamilyStatusBadge({ state }: { state: LinkState }) {
  if (state.kind === "none") return null;
  return <span className={STATUS_CLASS[state.kind]}>Family: {STATUS_TEXT[state.kind]}</span>;
}

const itemKey = (i: FamilyItem, prefix: string) => `${prefix}:${i.kind}:${i.text.toLowerCase()}`;

function Review({
  r,
  favorites,
  avoid,
  onDone,
}: {
  r: RosterResident;
  favorites: FamilyItem[];
  avoid: FamilyItem[];
  onDone: (accepted: { favorites: FamilyItem[]; avoid: FamilyItem[] } | null) => void;
}) {
  const id = useId();
  const have = new Set(r.favorites.map((f) => `${f.kind}:${f.text.toLowerCase()}`));
  const all = [...favorites.map((f) => itemKey(f, "f")), ...avoid.map((a) => itemKey(a, "a"))];
  // Everything starts accepted; already-known favorites are shown but cannot be added twice.
  const [keep, setKeep] = useState<Set<string>>(() => new Set(all));
  const toggle = (k: string) => setKeep((s) => (s.has(k) ? new Set([...s].filter((x) => x !== k)) : new Set([...s, k])));
  const row = (i: FamilyItem, prefix: "f" | "a") => {
    const k = itemKey(i, prefix);
    const dupe = prefix === "f" && have.has(`${i.kind}:${i.text.toLowerCase()}`);
    return (
      <li key={k} className="review-item">
        <label>
          <input type="checkbox" checked={!dupe && keep.has(k)} disabled={dupe} onChange={() => toggle(k)} />
          <span className="fav-kind">{KIND_LABEL[i.kind]}</span>
          <span>{i.text}</span>
          {dupe && <span className="hint">(already listed)</span>}
          {prefix === "f" && !i.entityId && !dupe && <span className="hint">(typed, not picked)</span>}
        </label>
      </li>
    );
  };
  const chosen = all.filter((k) => keep.has(k)).length;
  return (
    <div className="family-review" role="group" aria-labelledby={`${id}-h`}>
      <h4 id={`${id}-h`}>Review the family's suggestions</h4>
      {favorites.length > 0 && (
        <>
          <p className="label">Favorites to add</p>
          <ul className="review-list">{favorites.map((f) => row(f, "f"))}</ul>
        </>
      )}
      {avoid.length > 0 && (
        <>
          <p className="label">To avoid (never scheduled as a match for {r.name || r.id})</p>
          <ul className="review-list">{avoid.map((a) => row(a, "a"))}</ul>
        </>
      )}
      <div className="form-actions">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() =>
            onDone({
              favorites: favorites.filter((f) => keep.has(itemKey(f, "f"))),
              avoid: avoid.filter((a) => keep.has(itemKey(a, "a"))),
            })
          }
        >
          Add {chosen} selected
        </button>
        <button type="button" className="btn btn-quiet btn-sm" onClick={() => onDone(null)}>
          Dismiss all
        </button>
      </div>
    </div>
  );
}

/** "Ask family" block inside a resident row. */
export function FamilyLinkPanel({ r, state, links, onChange }: { r: RosterResident; state: LinkState; links: FamilyLinks; onChange: (r: RosterResident) => void }) {
  const id = useId();
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 2500);
    return () => window.clearTimeout(t);
  }, [copied]);

  const url = "link" in state ? familyUrl(window.location.origin, state.link.token, state.link.label) : "";

  const copy = async (link = url) => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setMsg("Link copied. Send it to the family by text or email.");
    } catch {
      setMsg("Couldn't copy automatically. Select the link above and copy it.");
    }
  };

  const create = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const link = await links.create(r.id, label);
      setLabel("");
      await copy(familyUrl(window.location.origin, link.token, link.label));
    } catch (err) {
      setMsg(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const finish = async (accepted: { favorites: FamilyItem[]; avoid: FamilyItem[] } | null) => {
    if (accepted) {
      const res = mergeFamilyItems(r, accepted);
      onChange(res.resident);
      const parts = [res.added && `${res.added} favorite${res.added === 1 ? "" : "s"}`, res.avoided && `${res.avoided} to avoid`].filter(Boolean);
      setMsg(`${parts.length ? `Added ${parts.join(" and ")}.` : "Nothing new to add."}${res.skipped ? ` ${res.skipped} skipped because the list is full.` : ""}`);
    } else {
      setMsg("Dismissed. Nothing was added.");
    }
    setReviewing(false);
    await links.complete(r.id);
  };

  return (
    <div className="family-link">
      <div className="family-head">
        <span className="label">Ask family</span>
        <span className={STATUS_CLASS[state.kind]}>{STATUS_TEXT[state.kind]}</span>
      </div>
      {(state.kind === "none" || state.kind === "expired" || state.kind === "reviewed") && (
        <>
          <p className="hint">
            {state.kind === "expired"
              ? "The last link expired without a reply. Create a new one."
              : state.kind === "reviewed"
                ? "The family's answers were reviewed. You can ask again with a new link."
                : "Families often know favorites that residents can no longer tell you. Send them a private link; they pick real titles and you approve each one."}
          </p>
          <div className="family-create">
            <div className="field">
              <label htmlFor={`${id}-label`}>How the family knows them (optional)</label>
              <input
                id={`${id}-label`}
                value={label}
                maxLength={MAX_LABEL}
                placeholder="e.g. Mum, Grandpa Joe"
                aria-describedby={`${id}-label-hint`}
                onChange={(e) => setLabel(e.target.value)}
              />
              <span id={`${id}-label-hint`} className="hint">
                Shown on the family page. It stays in the link itself and is never sent to the server. Left empty, it says "your loved one".
              </span>
            </div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={create} disabled={busy}>
              {busy ? "Creating…" : state.kind === "none" ? "Create family link" : "Create a new link"}
            </button>
          </div>
        </>
      )}
      {(state.kind === "waiting" || state.kind === "received") && (
        <div className="family-share">
          <label className="sr-only" htmlFor={`${id}-url`}>
            Family link
          </label>
          <input id={`${id}-url`} className="mono" readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copy()}>
            {copied ? "Copied" : "Copy link"}
          </button>
          <span className="hint">
            {state.kind === "waiting"
              ? `Waiting for the family. Works until ${new Date(state.link.expiresAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}.`
              : "The family replied."}
          </span>
        </div>
      )}
      {state.kind === "received" &&
        (reviewing ? (
          <Review r={r} favorites={state.submission.favorites} avoid={state.submission.avoid} onDone={(a) => void finish(a)} />
        ) : (
          <div className="form-actions">
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setReviewing(true)}>
              Review &amp; add ({state.submission.favorites.length + state.submission.avoid.length})
            </button>
          </div>
        ))}
      <p className="hint" role="status" aria-live="polite">
        {msg ?? ""}
      </p>
    </div>
  );
}
