import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { DAYS, TIMES, type ScheduledSession, type SessionKit, type WeekPlan } from "../../../shared/types";
import { kitFacts, mediaLinks, type KitFacts } from "../../../shared/kit";
import { buildIcs, dateForDay, nextMonday, sessionLine, SLOT_TIMES } from "../../../shared/ics";
import { describeError, getSessionKit } from "../api";
import { Modal, printSheet } from "./Modal";
import { DOMAIN_LABEL } from "./RosterEditor";

const DAY_LONG: Record<string, string> = { Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday", Sat: "Saturday", Sun: "Sunday" };
const when = (s: Pick<ScheduledSession, "day" | "time">) => `${DAY_LONG[s.day]} ${s.time}, ${SLOT_TIMES[s.time].label}`;
/** Titles are model-written; never show one on a public sheet if it carries a resident alias. */
const publicTitle = (s: ScheduledSession) => (/\br\d{1,3}\b/.test(s.title) || !s.title.trim() ? s.entity.name : s.title);

// ---------------------------------------------------------------------------
// Facts and links (Qloo data only)
// ---------------------------------------------------------------------------

function FactsImage({ facts, className }: { facts: KitFacts; className: string }) {
  const [broken, setBroken] = useState(false);
  if (!facts.imageUrl || broken) return null;
  const alt = `${DOMAIN_LABEL[facts.domain]} image for ${facts.name}${facts.year ? ` (${facts.year})` : ""}, from Qloo`;
  return <img className={className} src={facts.imageUrl} alt={alt} referrerPolicy="no-referrer" onError={() => setBroken(true)} />;
}

function Facts({ facts }: { facts: KitFacts }) {
  return (
    <section className="kit-facts" aria-labelledby="kit-facts-h">
      <FactsImage facts={facts} className="kit-img" />
      <div>
        <h3 id="kit-facts-h">About {facts.name}</h3>
        <dl className="kit-dl">
          <div>
            <dt>Type</dt>
            <dd>{DOMAIN_LABEL[facts.domain]}</dd>
          </div>
          {facts.year && (
            <div>
              <dt>Year</dt>
              <dd>{facts.year}</dd>
            </div>
          )}
          {facts.address && (
            <div>
              <dt>Address</dt>
              <dd>{facts.address}</dd>
            </div>
          )}
          {facts.contentRating && (
            <div>
              <dt>Rating</dt>
              <dd>{facts.contentRating}</dd>
            </div>
          )}
        </dl>
        {facts.description ? <p className="kit-desc">{facts.description}</p> : <p className="hint">Qloo has no description for this item.</p>}
        {facts.tags.length > 0 && <p className="hint">Qloo tags: {facts.tags.join(", ")}</p>}
        <p className="kit-source">Facts from Qloo. Nothing in this box is written by the language model.</p>
      </div>
    </section>
  );
}

function Links({ s }: { s: ScheduledSession }) {
  const links = mediaLinks(s);
  return (
    <section aria-labelledby="kit-links-h">
      <h3 id="kit-links-h">Find it to play or show</h3>
      {links.length ? (
        <ul className="kit-links">
          {links.map((l) => (
            <li key={l.url}>
              <a href={l.url} target="_blank" rel="noopener noreferrer">
                {l.label}
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="hint">Qloo has no address for this venue, so there is no map link. Check the venue's details before the outing.</p>
      )}
      <p className="hint">Search pages only. Pick the exact video, album or edition you want to use.</p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Kit body (shared by the dialog and the large-print handout)
// ---------------------------------------------------------------------------

function KitBody({ kit, headingLevel }: { kit: SessionKit; headingLevel: 3 | 2 }) {
  const H = headingLevel === 3 ? "h3" : "h2";
  return (
    <>
      <section>
        <H>Read aloud (about 1 minute)</H>
        <p className="kit-intro">{kit.intro}</p>
      </section>
      <section>
        <H>Conversation prompts</H>
        <ol className="kit-list">
          {kit.prompts.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ol>
      </section>
      <section>
        <H>Gentle quiz</H>
        <ol className="kit-list">
          {kit.quiz.map((q) => (
            <li key={q.question}>
              {q.question} <span className="kit-answer">Answer: {q.answer}</span>
            </li>
          ))}
        </ol>
      </section>
      <section>
        <H>So everyone can join in</H>
        <ul className="kit-list">
          {kit.adaptations.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
        <p className="hint">Practical tips only, not medical advice. Follow each resident's care plan.</p>
      </section>
    </>
  );
}

function SourceNote({ kit }: { kit: SessionKit }) {
  return kit.source === "template" ? (
    <p className="notice kit-note">
      <strong>Template kit.</strong> {kit.fallbackReason ?? "Built from Qloo data only."}
    </p>
  ) : (
    <p className="hint kit-note">Written by Gemini from the Qloo facts above, then checked by Fondly for invented years, medical terms and resident details.</p>
  );
}

/** Large-print handout. Rendered into <body> so it prints without the app around it. */
function KitHandout({ s, kit, facts, homeName }: { s: ScheduledSession; kit: SessionKit; facts: KitFacts; homeName?: string }) {
  return createPortal(
    <article className="print-sheet sheet-kit" aria-hidden="true">
      <header className="sheet-head">
        <p className="sheet-eyebrow">
          {homeName ? `${homeName} · ` : ""}
          {when(s)}
        </p>
        <h1>{publicTitle(s)}</h1>
        <p className="sheet-sub">
          {facts.name}
          {facts.year ? ` (${facts.year})` : ""}
          {facts.address ? ` · ${facts.address}` : ""}
        </p>
      </header>
      <div className="sheet-facts">
        <FactsImage facts={facts} className="sheet-img" />
        {facts.description && <p>{facts.description}</p>}
      </div>
      <KitBody kit={kit} headingLevel={2} />
      <p className="sheet-foot">Facts from Qloo. {kit.source === "template" ? "Template kit." : "Text by Gemini, checked by Fondly."} Planned with Fondly.</p>
    </article>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Kit dialog
// ---------------------------------------------------------------------------

type KitState = { state: "loading" } | { state: "ready"; kit: SessionKit; cached: boolean } | { state: "error"; message: string };

export function KitDialog({ plan, s, onClose }: { plan: WeekPlan; s: ScheduledSession; onClose: () => void }) {
  const [st, setSt] = useState<KitState>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const facts = kitFacts(s);

  useEffect(() => {
    const ctl = new AbortController();
    setSt({ state: "loading" });
    getSessionKit(plan.id, s.slotId, ctl.signal)
      .then((r) => setSt({ state: "ready", kit: r.kit, cached: r.cached }))
      .catch((err) => {
        if (!ctl.signal.aborted) setSt({ state: "error", message: describeError(err) });
      });
    return () => ctl.abort();
  }, [plan.id, s.slotId, attempt]);

  const titleId = `kit-h-${s.slotId}`;
  return (
    <Modal labelledBy={titleId} onClose={onClose} className="kit-modal">
      <header className="modal-head">
        <div style={{ minWidth: 0 }}>
          <p className="eyebrow eyebrow-brand">Session kit · {when(s)}</p>
          <h2 id={titleId}>{s.title || s.entity.name}</h2>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close session kit" data-autofocus>
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </header>
      <div className="modal-body">
        <Facts facts={facts} />
        <Links s={s} />
        <div aria-live="polite" aria-busy={st.state === "loading"}>
          {st.state === "loading" && (
            <p className="tl-status kit-loading">
              <span className="tl-icon tl-spin" aria-hidden="true" /> Preparing the read-aloud intro, prompts and quiz…
            </p>
          )}
          {st.state === "error" && (
            <div className="error-msg" role="alert">
              <p style={{ margin: 0 }}>{st.message}</p>
              <button type="button" className="btn btn-ghost btn-sm" style={{ marginTop: "0.6rem" }} onClick={() => setAttempt((n) => n + 1)}>
                Try again
              </button>
            </div>
          )}
          {st.state === "ready" && (
            <>
              <SourceNote kit={st.kit} />
              <div className="kit-body">
                <KitBody kit={st.kit} headingLevel={3} />
              </div>
              <span className="sr-only">{st.cached ? "Kit loaded from saved copy." : "Kit ready."}</span>
            </>
          )}
        </div>
      </div>
      <footer className="modal-foot">
        <button type="button" className="btn btn-primary" disabled={st.state !== "ready"} onClick={() => printSheet("kit")}>
          Print large-print handout
        </button>
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Close
        </button>
      </footer>
      {st.state === "ready" && <KitHandout s={s} kit={st.kit} facts={facts} homeName={plan.request.homeName} />}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Exports: calendar file and noticeboard poster
// ---------------------------------------------------------------------------

const fmtDate = (d: Date) => d.toLocaleDateString(undefined, { day: "numeric", month: "short" });

export function downloadIcs(plan: WeekPlan): Date {
  const weekStart = nextMonday();
  const ics = buildIcs(plan.sessions, { planId: plan.id, homeName: plan.request.homeName, weekStart });
  const url = URL.createObjectURL(new Blob([ics], { type: "text/calendar;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "fondly-week.ics";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return weekStart;
}

/** One-page landscape noticeboard poster. No resident names, ids or fits. */
export function NoticeboardPoster({ plan }: { plan: WeekPlan }) {
  const monday = nextMonday();
  const byDay = DAYS.map((d) => ({
    day: d,
    date: dateForDay(monday, d),
    sessions: plan.sessions.filter((s) => s.day === d).sort((a, b) => TIMES.indexOf(a.time) - TIMES.indexOf(b.time)),
  })).filter((d) => d.sessions.length > 0);
  const sunday = dateForDay(monday, "Sun");
  return createPortal(
    <article className="print-sheet sheet-poster" aria-hidden="true">
      <header className="poster-head">
        <h1>This week's activities</h1>
        <p>
          {plan.request.homeName ? `${plan.request.homeName} · ` : ""}
          {fmtDate(monday)} to {fmtDate(sunday)}
        </p>
      </header>
      <div className="poster-grid" style={{ gridTemplateColumns: `repeat(${Math.max(1, byDay.length)}, minmax(0, 1fr))` }}>
        {byDay.map((d) => (
          <section key={d.day} className="poster-day">
            <h2>
              {DAY_LONG[d.day]}
              <span>{fmtDate(d.date)}</span>
            </h2>
            {d.sessions.map((s) => (
              <div key={s.slotId} className="poster-item">
                <p className="poster-time">{SLOT_TIMES[s.time].label}</p>
                <p className="poster-title">{publicTitle(s)}</p>
                <p className="poster-line">{sessionLine(s)}</p>
              </div>
            ))}
          </section>
        ))}
      </div>
      <p className="poster-foot">Everyone is welcome. Ask a member of staff if you would like help getting there.</p>
    </article>,
    document.body,
  );
}
