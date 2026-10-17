import { useEffect, useId, useRef, useState } from "react";
import { DAYS, DOMAINS, FAVORITE_KINDS, TIMES, type Day, type Domain, type FavoriteKind, type TimeOfDay } from "../../../shared/types";
import { describeError, parseIntake } from "../api";
import type { FamilyLinks } from "../family";
import { FamilyLinkPanel, FamilyStatusBadge } from "./FamilyLinkPanel";
import { RosterBackup } from "./RosterBackup";
import { BirthYearInput } from "./BirthYearInput";
import { WEEK_PRESETS, newResident, redactIntake, nextSlotId, sampleRoster, type Roster, type RosterResident, type WeekPreset } from "../roster";

export const KIND_LABEL: Record<FavoriteKind, string> = {
  music: "Music",
  film: "Film",
  tv: "TV",
  books: "Book",
  gaming: "Game",
  sports: "Sport",
  food: "Food",
};
export const DOMAIN_LABEL: Record<Domain, string> = {
  music: "Music",
  film: "Film",
  tv: "TV",
  books: "Reading",
  gaming: "Gaming",
  sports: "Sports",
  outing: "Outing",
};
// Compact labels so all seven days fit the week grid on phones.
const DOMAIN_SHORT: Record<Domain, string> = {
  music: "Music",
  film: "Film",
  tv: "TV",
  books: "Read",
  gaming: "Game",
  sports: "Sport",
  outing: "Out",
};
const TIME_SHORT: Record<string, string> = { morning: "AM", afternoon: "PM", evening: "Eve" };
const PLACEHOLDER: Record<FavoriteKind, string> = {
  music: "e.g. Patsy Cline",
  film: "e.g. Casablanca",
  tv: "e.g. I Love Lucy",
  books: "e.g. Little Women",
  gaming: "e.g. Tetris",
  sports: "e.g. Chicago Cubs",
  food: "e.g. Italian",
};

export const initials = (name: string, id: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("") || id;

const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

function ShieldIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

function ResidentRow({
  r,
  onChange,
  onRemove,
  intakeEnabled,
  residents,
  links,
  defaultBirthYear,
}: {
  r: RosterResident;
  links: FamilyLinks;
  defaultBirthYear?: number;
  residents: RosterResident[];
  onChange: (r: RosterResident) => void;
  onRemove: () => void;
  intakeEnabled: boolean;
}) {
  const id = useId();
  const [kind, setKind] = useState<FavoriteKind>("music");
  const [text, setText] = useState("");
  const [notes, setNotes] = useState("");
  const [intakeBusy, setIntakeBusy] = useState(false);
  const [intakeMsg, setIntakeMsg] = useState<string | null>(null);

  const addFav = () => {
    const t = text.trim();
    if (!t || r.favorites.length >= 20) return;
    if (r.favorites.some((f) => f.kind === kind && f.text.toLowerCase() === t.toLowerCase())) return;
    onChange({ ...r, favorites: [...r.favorites, { kind, text: t }] });
    setText("");
  };

  const runIntake = async () => {
    if (notes.trim().length < 3) return;
    setIntakeBusy(true);
    setIntakeMsg(null);
    try {
      // Names never leave the browser: this resident's name (any part of it) and other residents' names are replaced.
      const safe = redactIntake(notes, r, residents);
      const res = await parseIntake(safe);
      const have = new Set(r.favorites.map((f) => `${f.kind}:${f.text.toLowerCase()}`));
      const add = res.favorites.filter((f) => !have.has(`${f.kind}:${f.text.toLowerCase()}`));
      onChange({
        ...r,
        favorites: [...r.favorites, ...add].slice(0, 20),
        unavailableDays: [...new Set([...r.unavailableDays, ...res.unavailableDays])],
        unavailableTimes: [...new Set([...r.unavailableTimes, ...res.unavailableTimes])],
        optOut: [...new Set([...r.optOut, ...res.optOut])],
      });
      setIntakeMsg(add.length ? `Added ${add.length} favorite${add.length === 1 ? "" : "s"}. Check them below.` : "No new favorites found in those notes.");
      setNotes("");
    } catch (err) {
      setIntakeMsg(describeError(err));
    } finally {
      setIntakeBusy(false);
    }
  };

  const family = links.stateOf(r.id);
  const summary = r.favorites.length ? r.favorites.slice(0, 4).map((f) => f.text).join(", ") + (r.favorites.length > 4 ? "…" : "") : "No favorites yet";

  return (
    <li>
      <details className="resident" open={r.favorites.length === 0}>
        <summary>
          <span className="avatar" aria-hidden="true">
            {initials(r.name, r.id)}
          </span>
          <span style={{ minWidth: 0 }}>
            <span className="resident-name">{r.name || "Unnamed resident"}</span>
            <span className="resident-sub">{summary}</span>
            <FamilyStatusBadge state={family} />
          </span>
          <span className="alias" title="The only identifier sent to the server">
            {r.id}
          </span>
        </summary>
        <div className="resident-body">
          <div className="grid-2">
            <div className="field">
              <label htmlFor={`${id}-name`}>Name (stays on this device)</label>
              <input id={`${id}-name`} value={r.name} maxLength={60} onChange={(e) => onChange({ ...r, name: e.target.value })} />
            </div>
            <div className="field">
              <span className="label">Favorites ({r.favorites.length}/20)</span>
              <div className="fav-add">
                <select aria-label="Favorite type" value={kind} onChange={(e) => setKind(e.target.value as FavoriteKind)}>
                  {FAVORITE_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {KIND_LABEL[k]}
                    </option>
                  ))}
                </select>
                <input
                  aria-label="Favorite"
                  value={text}
                  maxLength={120}
                  placeholder={PLACEHOLDER[kind]}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addFav();
                    }
                  }}
                />
                <button type="button" className="btn btn-ghost" onClick={addFav} disabled={!text.trim()}>
                  Add
                </button>
              </div>
            </div>
          </div>
          {r.favorites.length > 0 && (
            <ul className="fav-list" aria-label={`Favorites for ${r.name || r.id}`}>
              {r.favorites.map((f, i) => (
                <li key={`${f.kind}-${f.text}`} className="fav">
                  <span className="fav-kind">{KIND_LABEL[f.kind]}</span>
                  <span>{f.text}</span>
                  <button type="button" aria-label={`Remove ${f.text}`} onClick={() => onChange({ ...r, favorites: r.favorites.filter((_, j) => j !== i) })}>
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          {intakeEnabled && (
            <div className="intake">
              <label className="label" htmlFor={`${id}-notes`}>
                Or describe them in your own words
              </label>
              <textarea
                id={`${id}-notes`}
                value={notes}
                maxLength={2000}
                placeholder="e.g. Grew up dancing to Glenn Miller, loves old westerns and anything with Doris Day. Not a morning person. Hates bingo."
                onChange={(e) => setNotes(e.target.value)}
              />
              <div className="form-actions">
                <button type="button" className="btn btn-ghost btn-sm" onClick={runIntake} disabled={intakeBusy || notes.trim().length < 3}>
                  {intakeBusy ? "Reading…" : "Turn into favorites"}
                </button>
                <span className="hint" role="status">
                  {intakeMsg ?? "Health details are ignored and never stored."}
                </span>
              </div>
            </div>
          )}
          <FamilyLinkPanel r={r} state={family} links={links} onChange={onChange} />
          <div className="field">
            <span className="label">Not available</span>
            <div className="toggle-row">
              {DAYS.map((d) => (
                <button key={d} type="button" className="toggle" aria-pressed={r.unavailableDays.includes(d)} onClick={() => onChange({ ...r, unavailableDays: toggle(r.unavailableDays, d as Day) })}>
                  {d}
                </button>
              ))}
              {TIMES.map((t) => (
                <button key={t} type="button" className="toggle" aria-pressed={r.unavailableTimes.includes(t)} onClick={() => onChange({ ...r, unavailableTimes: toggle(r.unavailableTimes, t as TimeOfDay) })}>
                  {t}
                </button>
              ))}
            </div>
          </div>
          <BirthYearInput
            id={`${id}-born`}
            label="Birth year (optional, sent as a year only)"
            value={r.birthYear}
            fallback={defaultBirthYear}
            onChange={(birthYear) => {
              const { birthYear: _drop, ...rest } = r;
              onChange(birthYear === undefined ? rest : { ...rest, birthYear });
            }}
          />
          <div className="field">
            <span className="label">Doesn't want</span>
            <div className="toggle-row">
              {DOMAINS.map((d) => (
                <button key={d} type="button" className="toggle" aria-pressed={r.optOut.includes(d)} onClick={() => onChange({ ...r, optOut: toggle(r.optOut, d) })}>
                  {DOMAIN_LABEL[d]}
                </button>
              ))}
            </div>
          </div>
          <div>
            <button type="button" className="btn btn-quiet btn-sm btn-danger" onClick={onRemove}>
              Remove {r.name || r.id}
            </button>
          </div>
        </div>
      </details>
    </li>
  );
}

const MAX_SLOTS = 21;

function WeekTemplate({ roster, update }: { roster: Roster; update: (fn: (r: Roster) => Roster) => void }) {
  const [open, setOpen] = useState<{ day: Day; time: TimeOfDay } | null>(null);
  const at = (d: Day, t: TimeOfDay) => roster.slots.find((s) => s.day === d && s.time === t);
  const setCell = (d: Day, t: TimeOfDay, domain: Domain | null) => {
    update((r) => {
      const cur = r.slots.find((s) => s.day === d && s.time === t);
      if (!domain) return { ...r, slots: r.slots.filter((s) => s !== cur) };
      if (cur) return { ...r, slots: r.slots.map((s) => (s === cur ? { ...s, domain } : s)) };
      if (r.slots.length >= MAX_SLOTS) return r;
      return { ...r, slots: [...r.slots, { id: nextSlotId(r.slots), day: d, time: t, domain }] };
    });
    setOpen(null);
  };
  const applyPreset = (p: WeekPreset) => {
    update((r) => ({ ...r, slots: p.build() }));
    setOpen(null);
  };
  const counts = DOMAINS.map((d) => [d, roster.slots.filter((s) => s.domain === d).length] as const).filter(([, n]) => n > 0);

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h2>Week template</h2>
          <p className="hint">
            Start from a preset, then tap any cell to pick its session: music, film, TV, reading, gaming, sports or an
            outing. {roster.slots.length}/{MAX_SLOTS} sessions
            {counts.length ? ` (${counts.map(([d, n]) => `${n} ${d === "tv" ? "TV" : DOMAIN_LABEL[d].toLowerCase()}`).join(", ")})` : ""}.
          </p>
        </div>
      </div>
      <div className="presets" role="group" aria-label="Week presets">
        {WEEK_PRESETS.map((p) => (
          <button key={p.id} type="button" className="chip" title={p.description} onClick={() => applyPreset(p)}>
            {p.label}
          </button>
        ))}
      </div>
      <div className="week" role="grid" aria-label="Week template">
        <span />
        {DAYS.map((d) => (
          <span key={d} className="week-h" role="columnheader">
            {d}
          </span>
        ))}
        {TIMES.map((t) => (
          <div key={t} role="row" style={{ display: "contents" }}>
            <span className="week-time" role="rowheader" aria-label={t}>
              <span className="lbl-full">{t}</span>
              <span className="lbl-short" aria-hidden="true">{TIME_SHORT[t]}</span>
            </span>
            {DAYS.map((d) => {
              const s = at(d, t);
              const isOpen = open?.day === d && open.time === t;
              const full = !s && roster.slots.length >= MAX_SLOTS;
              return (
                <div key={d} role="gridcell" className="week-slot">
                  <button
                    type="button"
                    className={`week-cell${s ? ` on dom-${s.domain}` : ""}`}
                    aria-label={`${d} ${t}: ${s ? DOMAIN_LABEL[s.domain] : "no session"}. Choose session type.`}
                    aria-haspopup="menu"
                    aria-expanded={isOpen}
                    disabled={full}
                    title={full ? `The week is full (${MAX_SLOTS} sessions)` : undefined}
                    onClick={() => setOpen(isOpen ? null : { day: d, time: t })}
                  >
                    {s ? (
                      <>
                        <span className="lbl-full">{DOMAIN_LABEL[s.domain]}</span>
                        <span className="lbl-short">{DOMAIN_SHORT[s.domain]}</span>
                      </>
                    ) : (
                      "+"
                    )}
                  </button>
                  {isOpen && (
                    <SlotMenu
                      label={`${d} ${t}`}
                      current={s?.domain ?? null}
                      onPick={(domain) => setCell(d, t, domain)}
                      onClose={() => setOpen(null)}
                    />
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function SlotMenu({
  label,
  current,
  onPick,
  onClose,
}: {
  label: string;
  current: Domain | null;
  onPick: (d: Domain | null) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('[aria-checked="true"], button')?.focus();
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.parentElement?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  return (
    <div ref={ref} className="slot-menu" role="menu" aria-label={`Session for ${label}`}>
      {DOMAINS.map((d) => (
        <button
          key={d}
          type="button"
          role="menuitemradio"
          aria-checked={current === d}
          className={`slot-opt dom-${d}${current === d ? " sel" : ""}`}
          onClick={() => onPick(d)}
        >
          {DOMAIN_LABEL[d]}
        </button>
      ))}
      {current && (
        <button type="button" role="menuitem" className="slot-opt slot-clear" onClick={() => onPick(null)}>
          No session
        </button>
      )}
    </div>
  );
}

interface Props {
  roster: Roster;
  update: (fn: (r: Roster) => Roster) => void;
  onPlan: () => void;
  onReset: () => void;
  canPlan: boolean;
  busy: boolean;
  intakeEnabled: boolean;
  disabledReason?: string;
  familyLinks: FamilyLinks;
}

export function RosterEditor({ roster, update, onPlan, onReset, canPlan, busy, intakeEnabled, disabledReason, familyLinks }: Props) {
  const [newName, setNewName] = useState("");
  const [tried, setTried] = useState(false);
  const withFavs = roster.residents.filter((r) => r.favorites.length > 0).length;
  const problems: string[] = [];
  if (!roster.homeCity.trim()) problems.push("Add your town or city (used for outing venues).");
  if (roster.residents.length < 2) problems.push("Add at least 2 residents.");
  if (withFavs === 0) problems.push("Add favorites for at least one resident.");
  if (roster.slots.length === 0) problems.push("Add at least one session to the week.");

  const add = () => {
    const name = newName.trim();
    if (!name || roster.residents.length >= 60) return;
    update((r) => ({ ...r, residents: [...r.residents, newResident(r, name)] }));
    setNewName("");
  };

  return (
    <section className="setup" id="setup" aria-labelledby="setup-h">
      <div>
        <p className="eyebrow eyebrow-brand">Your home</p>
        <h2 id="setup-h">Who lives here, and what do they love?</h2>
      </div>
      <p className="privacy">
        <ShieldIcon />
        <span>
          Names stay on this device. Fondly sends only an alias (r1, r2…) and the favorites themselves (public artists, films, shows, books, cuisines). Never enter
          health information.
        </span>
      </p>
      {roster.residents.length === 0 && (
        <div className="sample-banner">
          <span>Just exploring? Load a sample home with eight residents and a typical week, then plan it.</span>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => update((r) => ({ ...sampleRoster(), rosterId: r.rosterId, planHistory: r.planHistory }))}
          >
            Load sample home
          </button>
        </div>
      )}
      <div className="card">
        <div className="grid-2">
          <div className="field">
            <label htmlFor="home-name">Home name (optional)</label>
            <input id="home-name" value={roster.homeName} maxLength={80} placeholder="e.g. Maple Court" onChange={(e) => update((r) => ({ ...r, homeName: e.target.value }))} />
          </div>
          <div className="field">
            <label htmlFor="home-city">Town or city</label>
            <input id="home-city" value={roster.homeCity} maxLength={100} placeholder="e.g. Austin, TX" onChange={(e) => update((r) => ({ ...r, homeCity: e.target.value }))} />
          </div>
          <BirthYearInput
            id="home-born"
            label="Typical birth year of residents (optional)"
            value={roster.defaultBirthYear}
            onChange={(y) =>
              update((r) => {
                const { defaultBirthYear: _drop, ...rest } = r;
                return y === undefined ? rest : { ...rest, defaultBirthYear: y };
              })
            }
          />
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <h2>Residents</h2>
            <p className="hint">
              {roster.residents.length}/60 residents, {withFavs} with favorites. Three to five favorites each works best.
            </p>
          </div>
          {roster.residents.length > 0 && (
            <button
              type="button"
              className="btn btn-quiet btn-sm"
              onClick={() => {
                if (window.confirm("Remove every resident and start over? This only affects this device.")) onReset();
              }}
            >
              Clear roster
            </button>
          )}
        </div>
        <ul className="residents">
          {roster.residents.map((r) => (
            <ResidentRow
              key={r.id}
              r={r}
              residents={roster.residents}
              intakeEnabled={intakeEnabled}
              links={familyLinks}
              defaultBirthYear={roster.defaultBirthYear}
              onChange={(next) => update((x) => ({ ...x, residents: x.residents.map((y) => (y.id === r.id ? next : y)) }))}
              onRemove={() => {
                familyLinks.forget(r.id);
                update((x) => ({ ...x, residents: x.residents.filter((y) => y.id !== r.id) }));
              }}
            />
          ))}
        </ul>
        <div className="add-resident" style={{ marginTop: roster.residents.length ? "1rem" : 0 }}>
          <input
            aria-label="New resident's name"
            placeholder={roster.residents.length >= 60 ? "Roster is full" : "New resident's name"}
            value={newName}
            maxLength={60}
            disabled={roster.residents.length >= 60}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
          />
          <button type="button" className="btn btn-ghost" onClick={add} disabled={!newName.trim() || roster.residents.length >= 60}>
            Add resident
          </button>
        </div>
        <RosterBackup roster={roster} update={update} familyLinks={familyLinks} />
      </div>

      <WeekTemplate roster={roster} update={update} />

      <div className="form-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || !canPlan}
          onClick={() => {
            setTried(true);
            if (problems.length === 0) onPlan();
          }}
        >
          {busy ? "Planning…" : "Plan this week"}
        </button>
        <span className="hint" role="status">
          {!canPlan && disabledReason ? disabledReason : tried && problems.length ? problems.join(" ") : "Takes about a minute. Every resident is scored on live Qloo data."}
        </span>
      </div>
    </section>
  );
}
