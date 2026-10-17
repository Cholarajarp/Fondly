import { useEffect, useId, useRef, useState } from "react";
import type { FamilyItem, FamilySubmission, FamilySuggestion, FavoriteKind } from "../../../shared/types";
import { ApiError, describeError, getFamilyInvite, searchFamily, submitFamily } from "../api";
import { TOKEN_RE } from "../family";
import { ThemeToggle } from "./Header";

const MAX_FAVORITES = 30;
const MAX_AVOID = 15;

type AvoidKind = Exclude<FavoriteKind, "food">;

interface Section {
  id: string;
  title: string;
  hint: string;
  kinds: FavoriteKind[];
  placeholder: Partial<Record<FavoriteKind, string>>;
}

const KIND_WORD: Record<FavoriteKind, string> = {
  music: "Music",
  film: "Film",
  tv: "TV show",
  books: "Book",
  gaming: "Game",
  sports: "Team",
  food: "Food",
};

const SECTIONS: Section[] = [
  { id: "music", title: "Songs or singers they loved", hint: "Singers, bands or musicians, from any time in their life.", kinds: ["music"], placeholder: { music: "e.g. Vera Lynn" } },
  { id: "screen", title: "Films or TV they watched", hint: "Old favorites count most. Choose film or TV first.", kinds: ["film", "tv"], placeholder: { film: "e.g. The Sound of Music", tv: "e.g. I Love Lucy" } },
  { id: "books", title: "Books", hint: "Books they read or had read to them.", kinds: ["books"], placeholder: { books: "e.g. Little Women" } },
  { id: "sports", title: "Sports teams", hint: "Teams they followed or supported.", kinds: ["sports"], placeholder: { sports: "e.g. Chicago Cubs" } },
  { id: "food", title: "Foods", hint: "Cuisines or dishes they enjoyed.", kinds: ["food"], placeholder: { food: "e.g. Italian" } },
  { id: "gaming", title: "Games", hint: "Video or computer games they liked to play.", kinds: ["gaming"], placeholder: { gaming: "e.g. Tetris" } },
];

const AVOID_KINDS: AvoidKind[] = ["music", "film", "tv", "books", "sports", "gaming"];

const keyOf = (i: { kind: string; text: string }) => `${i.kind}:${i.text.trim().toLowerCase()}`;

type Load =
  | { state: "loading" }
  | { state: "closed"; title: string; message: string }
  | { state: "ready"; submitted: boolean; expiresAt: string };

/** Search box with Qloo suggestions (ARIA combobox). `requirePick` disallows free text. */
function Autocomplete({
  token,
  kind,
  label,
  placeholder,
  requirePick,
  disabled,
  onAdd,
}: {
  token: string;
  kind: FavoriteKind;
  label: string;
  placeholder?: string;
  requirePick?: boolean;
  disabled?: boolean;
  onAdd: (item: FamilyItem) => void;
}) {
  const id = useId();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<FamilySuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const cache = useRef(new Map<string, FamilySuggestion[]>());

  useEffect(() => {
    setResults([]);
    setActive(-1);
  }, [kind]);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setResults([]);
      setBusy(false);
      return;
    }
    const key = `${kind}:${term.toLowerCase()}`;
    const hit = cache.current.get(key);
    if (hit) {
      setResults(hit);
      setActive(-1);
      return;
    }
    const ctl = new AbortController();
    const t = window.setTimeout(() => {
      setBusy(true);
      searchFamily(token, kind, term, ctl.signal)
        .then((r) => {
          cache.current.set(key, r.results);
          setResults(r.results);
          setActive(-1);
          setNote(null);
        })
        .catch((err) => {
          if (ctl.signal.aborted) return;
          setResults([]);
          setNote(requirePick ? "Suggestions aren't available right now. Please try again in a moment." : "Suggestions aren't available right now. You can still type a name and press Add.");
          if (err instanceof ApiError && err.status === 429) setNote(err.message);
        })
        .finally(() => {
          if (!ctl.signal.aborted) setBusy(false);
        });
    }, 300);
    return () => {
      ctl.abort();
      window.clearTimeout(t);
    };
  }, [q, kind, token, requirePick]);

  const pick = (s: FamilySuggestion) => {
    onAdd({ kind, text: s.name, entityId: s.id });
    setQ("");
    setResults([]);
    setOpen(false);
    setActive(-1);
  };
  const addTyped = () => {
    const t = q.trim();
    if (!t) return;
    if (requirePick) {
      setNote("Please choose one of the suggestions, so the care home knows exactly which one you mean.");
      return;
    }
    // A typed name that exactly matches a suggestion is linked to it.
    const exact = results.find((r) => r.name.toLowerCase() === t.toLowerCase());
    if (exact) return pick(exact);
    onAdd({ kind, text: t.slice(0, 120) });
    setQ("");
    setResults([]);
    setOpen(false);
  };

  const listId = `${id}-list`;
  const showList = open && results.length > 0;
  return (
    <div className="fam-search">
      <label className="sr-only" htmlFor={`${id}-q`}>
        {label}
      </label>
      <div className="fam-search-row">
        <div className="fam-combo">
          <input
            id={`${id}-q`}
            type="text"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={showList}
            aria-controls={listId}
            aria-activedescendant={showList && active >= 0 ? `${id}-opt-${active}` : undefined}
            aria-describedby={`${id}-note`}
            autoComplete="off"
            value={q}
            maxLength={80}
            placeholder={placeholder}
            disabled={disabled}
            onChange={(e) => {
              setQ(e.target.value);
              setOpen(true);
              setNote(null);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => setOpen(false)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" && results.length) {
                e.preventDefault();
                setOpen(true);
                setActive((a) => (a + 1) % results.length);
              } else if (e.key === "ArrowUp" && results.length) {
                e.preventDefault();
                setActive((a) => (a <= 0 ? results.length - 1 : a - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                const chosen = showList && active >= 0 ? results[active] : undefined;
                if (chosen) pick(chosen);
                else addTyped();
              } else if (e.key === "Escape") {
                setOpen(false);
              }
            }}
          />
          {showList && (
            <ul id={listId} role="listbox" className="fam-options" aria-label={`Suggestions for ${label.toLowerCase()}`}>
              {results.map((s, i) => (
                <li
                  key={s.id}
                  id={`${id}-opt-${i}`}
                  role="option"
                  aria-selected={i === active}
                  className={i === active ? "active" : undefined}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(s)}
                >
                  <span>{s.name}</span>
                  {s.detail && <span className="fam-detail">{s.detail}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
        <button type="button" className="btn btn-ghost" onClick={addTyped} disabled={disabled || !q.trim()}>
          Add
        </button>
      </div>
      <p id={`${id}-note`} className="hint fam-note" aria-live="polite">
        {note ?? (busy ? "Looking for matches…" : q.trim().length >= 2 && open && results.length ? `${results.length} suggestion${results.length === 1 ? "" : "s"}. Use the arrow keys or tap one.` : "")}
      </p>
    </div>
  );
}

function Chips({ items, onRemove, label }: { items: FamilyItem[]; onRemove: (i: FamilyItem) => void; label: string }) {
  if (!items.length) return null;
  return (
    <ul className="fav-list fam-chips" aria-label={label}>
      {items.map((f) => (
        <li key={keyOf(f)} className="fav">
          <span className="fav-kind">{KIND_WORD[f.kind]}</span>
          <span>{f.text}</span>
          <button type="button" aria-label={`Remove ${f.text}`} onClick={() => onRemove(f)}>
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}

function SectionCard({
  section,
  token,
  items,
  full,
  onAdd,
  onRemove,
}: {
  section: Section;
  token: string;
  items: FamilyItem[];
  full: boolean;
  onAdd: (i: FamilyItem) => void;
  onRemove: (i: FamilyItem) => void;
}) {
  const id = useId();
  const [kind, setKind] = useState<FavoriteKind>(section.kinds[0]!);
  const mine = items.filter((i) => section.kinds.includes(i.kind));
  return (
    <fieldset className="card fam-section">
      <legend>
        <h2 id={`${id}-h`}>{section.title}</h2>
      </legend>
      <p className="hint">{section.hint}</p>
      {section.kinds.length > 1 && (
        <div className="fam-kinds" role="radiogroup" aria-label={`${section.title}: film or TV`}>
          {section.kinds.map((k) => (
            <label key={k} className="fam-kind">
              <input type="radio" name={`${id}-kind`} value={k} checked={kind === k} onChange={() => setKind(k)} />
              <span>{KIND_WORD[k]}</span>
            </label>
          ))}
        </div>
      )}
      <Autocomplete token={token} kind={kind} label={`${section.title}: ${KIND_WORD[kind]}`} placeholder={section.placeholder[kind]} disabled={full} onAdd={onAdd} />
      <Chips items={mine} onRemove={onRemove} label={`Added: ${section.title.toLowerCase()}`} />
    </fieldset>
  );
}

export function FamilyPage({ token, label }: { token: string; label?: string }) {
  const who = label || "your loved one";
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [favorites, setFavorites] = useState<FamilyItem[]>([]);
  const [avoid, setAvoid] = useState<FamilyItem[]>([]);
  const [avoidKind, setAvoidKind] = useState<AvoidKind>("music");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [dirty, setDirty] = useState(false);
  const thanksRef = useRef<HTMLDivElement>(null);
  const avoidId = useId();

  useEffect(() => {
    document.title = "Share their favorites · Fondly";
    if (!TOKEN_RE.test(token)) {
      setLoad({ state: "closed", title: "We couldn't open this link", message: "Please check it was copied in full, or ask the care home for a new one." });
      return;
    }
    const ctl = new AbortController();
    getFamilyInvite(token, ctl.signal)
      .then((v) => {
        if (v.status === "reviewed") {
          setLoad({ state: "closed", title: "Thank you", message: "The care home has already added your suggestions, so this link is now closed." });
          return;
        }
        setFavorites(v.submission?.favorites ?? []);
        setAvoid(v.submission?.avoid ?? []);
        setLoad({ state: "ready", submitted: v.status === "received", expiresAt: v.expiresAt });
      })
      .catch((err) => {
        if (ctl.signal.aborted) return;
        const status = err instanceof ApiError ? err.status : 0;
        setLoad({
          state: "closed",
          title: status === 410 ? "This link has expired" : status === 404 ? "We couldn't open this link" : status === 409 ? "Thank you" : "Something went wrong",
          message: describeFamilyError(err),
        });
      });
    return () => ctl.abort();
  }, [token]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const addTo = (set: typeof setFavorites, max: number) => (item: FamilyItem) => {
    set((list) => (list.length >= max || list.some((x) => keyOf(x) === keyOf(item)) ? list : [...list, item]));
    setDirty(true);
    setStatus(null);
  };
  const removeFrom = (set: typeof setFavorites) => (item: FamilyItem) => {
    set((list) => list.filter((x) => keyOf(x) !== keyOf(item)));
    setDirty(true);
    setStatus(null);
  };

  const submit = async () => {
    if (favorites.length + avoid.length === 0) {
      setStatus({ tone: "bad", text: "Please add at least one favorite first." });
      return;
    }
    setSaving(true);
    setStatus(null);
    try {
      const body: FamilySubmission = { favorites, avoid };
      await submitFamily(token, body);
      setDirty(false);
      setLoad((l) => (l.state === "ready" ? { ...l, submitted: true } : l));
      setStatus({ tone: "ok", text: "Sent. Thank you." });
      requestAnimationFrame(() => {
        thanksRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
        thanksRef.current?.focus();
      });
    } catch (err) {
      if (err instanceof ApiError && (err.status === 409 || err.status === 410 || err.status === 404)) {
        setLoad({ state: "closed", title: err.status === 410 ? "This link has expired" : "Thank you", message: describeFamilyError(err) });
        return;
      }
      setStatus({ tone: "bad", text: describeFamilyError(err) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="app family">
      <a className="skip" href="#fam-main" onClick={(e) => { e.preventDefault(); document.getElementById("fam-main")?.focus(); }}>
        Skip to content
      </a>
      <header className="site-header">
        <div className="nav">
          <span className="logo">
            <img src="/favicon.svg" alt="" width={30} height={30} />
            <span className="logo-word">Fondly</span>
          </span>
          <ThemeToggle />
        </div>
      </header>
      <main id="fam-main" tabIndex={-1} className="fam-main">
        {load.state === "loading" && (
          <section className="card" aria-busy="true">
            <p role="status">Opening your link…</p>
          </section>
        )}
        {load.state === "closed" && (
          <section className="card fam-closed" role="alert">
            <h1>{load.title}</h1>
            <p>{load.message}</p>
          </section>
        )}
        {load.state === "ready" && (
          <>
            <section className="fam-intro">
              <p className="eyebrow eyebrow-brand">A request from the care home</p>
              <h1>What does {who} love?</h1>
              <p className="lede">
                You know {who === "your loved one" ? "them" : who} best. Tell us the music, films, books, teams, foods and games they have enjoyed, and the activity team will plan
                group sessions around them. It takes about five minutes, and any answer helps.
              </p>
              <div className="privacy fam-privacy" role="note">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                </svg>
                <span>
                  Please share only favorite songs, films, books, teams, foods and games. <strong>Do not include medical or health information</strong>, names, addresses or phone
                  numbers. Only the care home team sees your answers.
                </span>
              </div>
            </section>

            {SECTIONS.map((s) => (
              <SectionCard
                key={s.id}
                section={s}
                token={token}
                items={favorites}
                full={favorites.length >= MAX_FAVORITES}
                onAdd={addTo(setFavorites, MAX_FAVORITES)}
                onRemove={removeFrom(setFavorites)}
              />
            ))}

            <fieldset className="card fam-section fam-avoid">
              <legend>
                <h2>Anything to avoid</h2>
              </legend>
              <p className="hint">
                A singer, film, show or team they disliked or that upsets them. Choose from the suggestions. This is only for activities: please don't describe health
                conditions here.
              </p>
              <div className="field">
                <label htmlFor={`${avoidId}-kind`}>What kind of thing to avoid</label>
                <select id={`${avoidId}-kind`} value={avoidKind} onChange={(e) => setAvoidKind(e.target.value as AvoidKind)}>
                  {AVOID_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {KIND_WORD[k]}
                    </option>
                  ))}
                </select>
              </div>
              <Autocomplete
                token={token}
                kind={avoidKind}
                label={`Something to avoid: ${KIND_WORD[avoidKind]}`}
                placeholder="Start typing a name"
                requirePick
                disabled={avoid.length >= MAX_AVOID}
                onAdd={addTo(setAvoid, MAX_AVOID)}
              />
              <Chips items={avoid} onRemove={removeFrom(setAvoid)} label="Things to avoid" />
            </fieldset>

            <section className="card fam-submit" aria-labelledby="fam-send-h">
              <h2 id="fam-send-h">{load.submitted ? "Update your answers" : "Send to the care home"}</h2>
              <p className="hint">
                {favorites.length} favorite{favorites.length === 1 ? "" : "s"}
                {avoid.length ? ` and ${avoid.length} to avoid` : ""}. You can come back to this link and change your answers until the care home has added them. The link
                works until {new Date(load.expiresAt).toLocaleDateString(undefined, { day: "numeric", month: "long" })}.
              </p>
              <div className="form-actions">
                <button type="button" className="btn btn-primary fam-send" onClick={submit} disabled={saving}>
                  {saving ? "Sending…" : load.submitted ? "Save changes" : "Send"}
                </button>
                <span className={`fam-status${status?.tone === "bad" ? " field-error" : ""}`} role="status" aria-live="polite">
                  {status?.text ?? ""}
                </span>
              </div>
              {load.submitted && !dirty && (
                <div ref={thanksRef} tabIndex={-1} className="fam-thanks">
                  <strong>Thank you for helping.</strong> The activity team will review your suggestions and add them to {who === "your loved one" ? "their" : `${who}'s`} profile.
                </div>
              )}
            </section>
          </>
        )}
        <p className="footnote">Fondly helps care homes plan activities. It does not collect health information.</p>
      </main>
    </div>
  );
}

function describeFamilyError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 0) return "We couldn't reach the server. Please check your connection and try again.";
    if (err.status === 400) return "Some answers couldn't be saved. Please remove contact details or unusual characters and try again.";
    return err.message || describeError(err);
  }
  return describeError(err);
}
