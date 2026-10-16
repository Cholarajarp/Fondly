import { useEffect, useMemo, useState } from "react";
import { DAYS, TIMES, type Reaction, type ScheduledSession, type WeekPlan } from "../../../shared/types";
import { nameOf, type Roster } from "../roster";
import { Markdown } from "./Markdown";
import { DOMAIN_LABEL, initials } from "./RosterEditor";
import { SLOT_TIMES } from "../../../shared/ics";
import { printSheet } from "./Modal";
import { downloadIcs, KitDialog, NoticeboardPoster } from "./SessionKit";

const DAY_LONG: Record<string, string> = { Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday", Sat: "Saturday", Sun: "Sunday" };
const pct = (n: number) => `${Math.round(n * 100)}%`;
const order = (s: { day: string; time: string }) => DAYS.indexOf(s.day as never) * 3 + TIMES.indexOf(s.time as never);

type Tab = "week" | "residents" | "families" | "next";

const STEP_LABEL: Record<string, string> = {
  resolve_favorites: "matching favorites",
  build_candidates: "candidate pool",
  score_residents: "scoring",
  build_baseline: "baseline",
  optimize: "optimizing",
  plan_one_to_ones: "1:1 plans",
  record_sessions: "session briefs",
  finish: "summary and newsletter",
};

/** Who did the work: the agent, or the deterministic safety net. Counts come from code, not the model. */
function AgentRunLine({ plan }: { plan: WeekPlan }) {
  const run = plan.agentRun;
  if (!run) return null;
  const net = run.steps.filter((s) => s.by === "safety_net").map((s) => STEP_LABEL[s.step] ?? s.step);
  const helped = run.steps.filter((s) => s.by === "both").map((s) => STEP_LABEL[s.step] ?? s.step);
  const extra = [run.expansions && `${run.expansions} expansion${run.expansions === 1 ? "" : "s"}`, run.revisions && `${run.revisions} revision${run.revisions === 1 ? "" : "s"}`].filter(Boolean);
  const head = !net.length && !helped.length ? "Agent-driven: all steps" : net.length === run.steps.length ? "Built by the safety net (the agent did not run)" : "Agent-driven, with safety-net help";
  const parts = [
    `${run.toolCalls} agent tool call${run.toolCalls === 1 ? "" : "s"}${extra.length ? `, ${extra.join(", ")}` : ""}`,
    net.length && net.length !== run.steps.length ? `safety net did: ${net.join(", ")}` : "",
    helped.length ? `safety net completed: ${helped.join(", ")}` : "",
  ].filter(Boolean);
  return (
    <p className="agent-run">
      {head} ({parts.join("; ")}).
    </p>
  );
}

// ---------------------------------------------------------------------------
// Fairness panel
// ---------------------------------------------------------------------------

function Fairness({ plan }: { plan: WeekPlan }) {
  const m = plan.metrics;
  const rows = [
    { key: "fondly", label: "Fondly (this plan)", metrics: m, method: "Qloo taste data for each resident plus the fairness optimizer.", ours: true, available: true },
    ...plan.baselines.map((b) => ({ key: b.key, label: b.label, metrics: b.metrics, method: b.method, ours: false, available: b.available, note: b.note })),
  ];
  const unscorable = plan.residents.filter((r) => !r.scorable).length;
  return (
    <section className="card" aria-labelledby="fair-h">
      <div className="fair">
        <div>
          <p className="eyebrow">Reach this week</p>
          <h2 id="fair-h" className="sr-only">
            Reach this week
          </h2>
          <div className="big-stat">
            <span className="v">{m.reached}</span>
            <span className="of">of {m.total} residents have at least one session strongly matched to their taste</span>
          </div>
          <div className="stat-row">
            <div className="mini">
              <div className="k">Least-served resident</div>
              <div className="v">{pct(m.minBest)}</div>
              <div className="d">best match they can attend</div>
            </div>
            <div className="mini">
              <div className="k">Average best match</div>
              <div className="v">{pct(m.meanBest)}</div>
              <div className="d">across residents</div>
            </div>
            <div className="mini">
              <div className="k">Optimizer passes</div>
              <div className="v">{plan.optimizerRuns}</div>
              <div className="d">{plan.qlooRequests} Qloo requests</div>
            </div>
          </div>
          <AgentRunLine plan={plan} />
          {unscorable > 0 && (
            <p className="hint" style={{ marginTop: "0.75rem" }}>
              {unscorable} resident{unscorable === 1 ? "" : "s"} could not be scored because none of their favorites matched on Qloo. See Residents.
            </p>
          )}
        </div>
        <div>
          <p className="eyebrow">Compared on the same residents, same slots</p>
          <ul className="compare">
            {rows.map((r) => (
              <li key={r.key} className="compare-row">
                <div className="compare-top">
                  <span>{r.label}</span>
                  <strong>{r.available && r.metrics ? `${r.metrics.reached} / ${r.metrics.total}` : "n/a"}</strong>
                </div>
                {r.available && r.metrics ? (
                  <p className="compare-discovery">
                    Least-served {Math.round(r.metrics.minBest * 100)}% · two best sessions avg {Math.round(r.metrics.meanTop2 * 100)}%
                    {r.metrics.discoveryReached !== undefined && r.metrics.discoveryReached !== r.metrics.reached
                      ? ` · ${r.metrics.discoveryReached} reached beyond their own favorites`
                      : ""}
                  </p>
                ) : null}
                <div className={`bar${r.ours ? " ours" : ""}`} aria-hidden="true">
                  <span style={{ width: r.metrics && r.metrics.total ? `${(r.metrics.reached / r.metrics.total) * 100}%` : "0%" }} />
                </div>
                <p className="compare-method">{"note" in r && r.note ? r.note : r.method}</p>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

function Thumb({ s }: { s: ScheduledSession }) {
  const [broken, setBroken] = useState(false);
  if (s.entity.image_url && !broken)
    return <img className="thumb" src={s.entity.image_url} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} />;
  return (
    <span className="thumb thumb-fallback" aria-hidden="true">
      {s.entity.name.slice(0, 1)}
    </span>
  );
}

function SessionCard({ s, roster, onOpenKit }: { s: ScheduledSession; roster: Roster; onOpenKit: (slotId: string) => void }) {
  const strong = s.matches.length;
  return (
    <article className={`session dom-${s.domain}`} aria-labelledby={`ses-${s.slotId}`}>
      <div className="session-when">
        <span>
          {DAY_LONG[s.day]} {s.time}
        </span>
        <span className="badge">{DOMAIN_LABEL[s.domain]}</span>
      </div>
      <div className="session-top">
        <Thumb s={s} />
        <div style={{ minWidth: 0 }}>
          <h3 id={`ses-${s.slotId}`}>{s.title}</h3>
          <div className="session-entity">
            {s.entity.name}
            {s.entity.properties?.release_year ? ` (${s.entity.properties.release_year})` : ""}
            {s.domain === "outing" && s.entity.properties?.address ? ` · ${s.entity.properties.address}` : ""}
          </div>
        </div>
      </div>
      <div>
        <span className={`badge ${strong >= 2 ? "badge-sage" : strong === 1 ? "badge-warn" : ""}`}>
          Strong match for {strong} of {s.attendees.length}
        </span>
      </div>
      {strong > 0 && (
        <ul className="who" aria-label="Strongly matched residents">
          {s.matches.map((m) => (
            <li key={m.residentId} className={`who-chip${m.ownFavorite ? " own" : ""}`} title={m.why}>
              {nameOf(roster, m.residentId)}
              {m.ownFavorite ? " ★" : ""}
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="btn btn-ghost btn-sm kit-open no-print" onClick={() => onOpenKit(s.slotId)} aria-label={`Open session kit for ${s.title || s.entity.name}`}>
        Open kit
      </button>
      <details>
        <summary>Staff brief</summary>
        <Markdown source={s.brief} />
        {s.related.length > 0 && <p className="related">Qloo related: {s.related.map((r) => r.name).join(", ")}</p>}
        <ul className="related" style={{ paddingLeft: "1rem", marginTop: "0.5rem" }}>
          {s.matches.slice(0, 6).map((m) => (
            <li key={m.residentId}>
              <strong>{nameOf(roster, m.residentId)}:</strong> {m.why}
            </li>
          ))}
        </ul>
      </details>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Residents
// ---------------------------------------------------------------------------

function Residents({ plan, roster }: { plan: WeekPlan; roster: Roster }) {
  const sessions = new Map(plan.sessions.map((s) => [s.slotId, s]));
  const sorted = [...plan.residents].sort((a, b) => Number(a.reached) - Number(b.reached) || a.bestFit - b.bestFit);
  return (
    <div className="people">
      {sorted.map((r) => {
        const name = nameOf(roster, r.residentId);
        const top = r.sessions.filter((s) => s.ownFavorite || s.fit >= 0.8).slice(0, 3);
        return (
          <article key={r.residentId} className={`card person${r.scorable && !r.reached ? " unreached" : ""}`}>
            <div className="person-head">
              <span className="avatar" aria-hidden="true">
                {initials(name, r.residentId)}
              </span>
              <h3>{name}</h3>
              {!r.scorable ? (
                <span className="badge badge-bad">Needs favorites</span>
              ) : r.reached ? (
                <span className="badge badge-sage">Matched</span>
              ) : (
                <span className="badge badge-warn">1:1 visit</span>
              )}
            </div>
            {r.scorable && (
              <div className="fitbar">
                <span>Best match</span>
                <span className="bar" aria-hidden="true">
                  <span style={{ width: pct(r.bestFit) }} />
                </span>
                <span className="num">{pct(r.bestFit)}</span>
              </div>
            )}
            {top.length > 0 && (
              <ul>
                {top.map((s) => {
                  const ses = sessions.get(s.slotId);
                  return ses ? (
                    <li key={s.slotId}>
                      <strong>
                        {DAY_LONG[ses.day]} {ses.time}:
                      </strong>{" "}
                      {ses.entity.name}. <span className="hint">{s.why}</span>
                    </li>
                  ) : null;
                })}
              </ul>
            )}
            {r.oneToOne && (
              <div className="one2one">
                <strong>1:1 visit idea:</strong> {r.oneToOne.picks.map((p) => p.name).join(", ")}
              </div>
            )}
            {r.warnings.length > 0 && (
              <ul className="notices">
                {r.warnings.map((w) => (
                  <li key={w} className="notice">
                    {w}
                  </li>
                ))}
              </ul>
            )}
            <details>
              <summary className="hint" style={{ cursor: "pointer" }}>
                Care-plan note
              </summary>
              <p className="care-note">{r.careNote}</p>
              <CopyButton className="btn btn-quiet btn-sm no-print" text={`${name}: ${r.careNote}`} label="Copy note" />
            </details>
          </article>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Next week / re-plan
// ---------------------------------------------------------------------------

export interface ReplanInput {
  mode: "edit" | "next_week";
  instruction?: string;
  reactions: { slotId: string; residentId: string; reaction: Reaction }[];
}

function NextWeek({
  plan,
  roster,
  onReplan,
  busy,
  disabledReason,
}: {
  plan: WeekPlan;
  roster: Roster;
  onReplan: (r: ReplanInput) => void;
  busy: boolean;
  disabledReason?: string;
}) {
  const [reactions, setReactions] = useState<Record<string, Reaction | undefined>>({});
  const [instruction, setInstruction] = useState("");
  const rows = useMemo(() => [...plan.sessions].sort((a, b) => order(a) - order(b)).flatMap((s) => s.attendees.map((r) => ({ s, r }))), [plan]);
  const set = (key: string, v: Reaction) => setReactions((x) => ({ ...x, [key]: x[key] === v ? undefined : v }));
  const list = () =>
    Object.entries(reactions)
      .filter((e): e is [string, Reaction] => !!e[1])
      .map(([k, reaction]) => {
        const [slotId, residentId] = k.split("|") as [string, string];
        return { slotId, residentId, reaction };
      });
  const count = list().length;

  return (
    <div className="replan">
      <section className="card" aria-labelledby="react-h">
        <div className="card-head">
          <div>
            <h2 id="react-h">How did it go?</h2>
            <p className="hint">Mark who enjoyed or declined each session. Fondly learns from it: loved items become favorites, declined ones are never matched to that resident again.</p>
          </div>
        </div>
        <div className="reactions-wrap">
          <table className="reactions">
            <thead>
              <tr>
                <th scope="col">Session</th>
                <th scope="col">Resident</th>
                <th scope="col">Reaction</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ s, r }) => {
                const key = `${s.slotId}|${r}`;
                const name = nameOf(roster, r);
                return (
                  <tr key={key}>
                    <td>
                      {s.day} {s.time}: {s.entity.name}
                    </td>
                    <td>{name}</td>
                    <td>
                      <span className="react-btns">
                        <button type="button" className="react love" aria-pressed={reactions[key] === "loved"} aria-label={`${name} loved ${s.entity.name}`} onClick={() => set(key, "loved")}>
                          Loved
                        </button>
                        <button type="button" className="react decline" aria-pressed={reactions[key] === "declined"} aria-label={`${name} declined ${s.entity.name}`} onClick={() => set(key, "declined")}>
                          Declined
                        </button>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card" aria-labelledby="change-h">
        <h2 id="change-h">What changed?</h2>
        <div className="field">
          <label htmlFor="instr">Tell Fondly in plain words (optional)</label>
          <textarea
            id="instr"
            value={instruction}
            maxLength={1000}
            placeholder={`e.g. ${roster.residents[0]?.name.split(" ")[0] ?? "Dot"} has a hospital appointment Tuesday. A new resident, Walt, loves Johnny Cash and westerns.`}
            onChange={(e) => setInstruction(e.target.value)}
          />
          <p className="hint">Names are swapped for aliases on this device before the text is sent.</p>
        </div>
        <div className="form-actions" style={{ marginTop: "1rem" }}>
          <button type="button" className="btn btn-primary" disabled={busy || !!disabledReason} onClick={() => onReplan({ mode: "next_week", instruction: instruction.trim() || undefined, reactions: list() })}>
            Plan next week
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy || !!disabledReason || (!instruction.trim() && count === 0)}
            onClick={() => onReplan({ mode: "edit", instruction: instruction.trim() || undefined, reactions: list() })}
          >
            Adjust this week
          </button>
          {disabledReason && (
            <span className="hint" role="status">
              {disabledReason}
            </span>
          )}
          <span className="hint">{count} reaction{count === 1 ? "" : "s"} marked. “Next week” uses fresh titles; “Adjust” keeps sessions that still work.</span>
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Diff banner
// ---------------------------------------------------------------------------

function DiffBanner({ plan, roster }: { plan: WeekPlan; roster: Roster }) {
  const d = plan.diff;
  if (!d) return null;
  const delta = plan.metrics.reached - d.metricsBefore.reached;
  const newlyReached = d.residentChanges.filter((c) => c.toReached && !c.fromReached);
  return (
    <section className="card diff" aria-labelledby="diff-h">
      <h2 id="diff-h">What changed from the last plan</h2>
      <p>
        Reach went from <strong className="num">{d.metricsBefore.reached}</strong> to <strong className="num">{plan.metrics.reached}</strong>{" "}
        {delta !== 0 && <span className={delta > 0 ? "delta-up" : "delta-down"}>({delta > 0 ? "+" : ""}{delta})</span>}.
        {newlyReached.length > 0 && ` Now reached: ${newlyReached.map((c) => nameOf(roster, c.residentId)).join(", ")}.`}
      </p>
      {d.edits.length > 0 && (
        <>
          <p className="eyebrow" style={{ marginTop: "0.75rem" }}>
            Changes applied
          </p>
          <ul>
            {d.edits.slice(0, 12).map((e) => (
              <li key={e}>{e.replace(/\br\d{1,3}\b/g, (id) => nameOf(roster, id))}</li>
            ))}
          </ul>
        </>
      )}
      {d.changedSlots.length > 0 && (
        <>
          <p className="eyebrow" style={{ marginTop: "0.75rem" }}>
            {d.changedSlots.length} session{d.changedSlots.length === 1 ? "" : "s"} changed
          </p>
          <ul>
            {d.changedSlots.slice(0, 10).map((c) => (
              <li key={c.slotId}>
                {c.day} {c.time}: {c.from ?? "nothing"} → {c.to ?? "open"}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Plan view
// ---------------------------------------------------------------------------

interface Props {
  plan: WeekPlan;
  roster: Roster;
  onReplan: (r: ReplanInput) => void;
  onEditRoster: () => void;
  busy: boolean;
  /** Why replanning is unavailable right now (server unhealthy). */
  disabledReason?: string;
}

/** Copies text and briefly confirms (or reports failure) in place, announced to screen readers. */
function CopyButton({ text, label, className }: { text: string; label: string; className: string }) {
  const [state, setState] = useState<"idle" | "ok" | "fail">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const t = setTimeout(() => setState("idle"), 2000);
    return () => clearTimeout(t);
  }, [state]);
  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error("no clipboard");
      await navigator.clipboard.writeText(text);
      setState("ok");
    } catch {
      setState("fail");
    }
  };
  return (
    <button type="button" className={className} onClick={() => void copy()} aria-live="polite">
      {state === "ok" ? "Copied" : state === "fail" ? "Copy failed, select the text instead" : label}
    </button>
  );
}

export function PlanView({ plan, roster, onReplan, onEditRoster, busy, disabledReason }: Props) {
  const [tab, setTab] = useState<Tab>("week");
  const sessions = useMemo(() => [...plan.sessions].sort((a, b) => order(a) - order(b)), [plan]);
  const mine = plan.request.rosterId === roster.rosterId;
  const view: Roster = mine ? roster : { ...roster, residents: [] };
  const unreached = plan.residents.filter((r) => r.scorable && !r.reached).length;
  const tabs: { id: Tab; label: string; n?: number }[] = [
    { id: "week", label: "This week", n: sessions.length },
    { id: "residents", label: "Residents", n: plan.residents.length },
    { id: "families", label: "For families" },
    ...(mine ? [{ id: "next" as Tab, label: "Next week" }] : []),
  ];
  const homeName = plan.request.homeName || roster.homeName;
  const [kitSlot, setKitSlot] = useState<string | null>(null);
  const kitSession = kitSlot ? plan.sessions.find((s) => s.slotId === kitSlot) : undefined;
  const [exportMsg, setExportMsg] = useState("");
  const addToCalendar = () => {
    try {
      const monday = downloadIcs(plan);
      setExportMsg(`Downloaded fondly-week.ics for the week of ${monday.toLocaleDateString(undefined, { day: "numeric", month: "long" })}.`);
    } catch {
      setExportMsg("Could not create the calendar file in this browser.");
    }
  };

  return (
    <article className="plan" aria-labelledby="plan-h">
      <div className="plan-head">
        <div>
          <p className="eyebrow eyebrow-brand">Week plan{homeName ? ` · ${homeName}` : ""}</p>
          <h1 id="plan-h">
            {plan.metrics.reached} of {plan.metrics.total} residents matched
          </h1>
          <p className="hint" style={{ margin: "0.4rem 0 0" }}>
            Built {new Date(plan.createdAt).toLocaleString()} from {plan.qlooRequests} Qloo requests.
            {unreached > 0 && ` ${unreached} resident${unreached === 1 ? " gets" : "s get"} a 1:1 visit plan.`}
          </p>
        </div>
        <div className="plan-actions">
          <button type="button" className="btn btn-ghost" onClick={() => window.print()}>
            Print
          </button>
          {sessions.length > 0 && (
            <>
              <button type="button" className="btn btn-ghost" onClick={addToCalendar} aria-describedby="export-note">
                Add to calendar
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => printSheet("poster")} aria-describedby="export-note">
                Noticeboard poster
              </button>
            </>
          )}
          {mine && (
            <button type="button" className="btn btn-ghost" onClick={onEditRoster}>
              Edit roster
            </button>
          )}
        </div>
      </div>

      {sessions.length > 0 && (
        <p id="export-note" className="hint no-print export-note">
          Calendar and poster use next week, Monday to Sunday, at {SLOT_TIMES.morning.label} for mornings, {SLOT_TIMES.afternoon.label} for afternoons and{" "}
          {SLOT_TIMES.evening.label} for evenings. The poster shows no resident names.
          <span role="status" className="export-status">
            {exportMsg ? ` ${exportMsg}` : ""}
          </span>
        </p>
      )}

      {!mine && <p className="notice">This plan was made on another device, so residents show as aliases (r1, r2…). Names never leave the device they were entered on.</p>}

      <DiffBanner plan={plan} roster={view} />

      <div className="tabs" role="tablist" aria-label="Plan sections">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" id={`tab-${t.id}`} aria-controls={`panel-${t.id}`} aria-selected={tab === t.id} tabIndex={tab === t.id ? 0 : -1} className="tab" onClick={() => setTab(t.id)}>
            {t.label}
            {t.n !== undefined && <span className="tab-n">{t.n}</span>}
          </button>
        ))}
      </div>

      <div role="tabpanel" id="panel-week" aria-labelledby="tab-week" className="tab-panel" data-print-title="This week" hidden={tab !== "week"} tabIndex={0}>
        <Fairness plan={plan} />
        <section className="card" aria-labelledby="sum-h">
          <h2 id="sum-h">Summary for the activity coordinator</h2>
          <Markdown source={plan.summary.replace(/\br\d{1,3}\b/g, (id) => nameOf(view, id))} />
        </section>
        {sessions.length === 0 && (
          <section className="card" role="status">
            <h2>No sessions could be scheduled</h2>
            <p>Qloo returned no usable picks for this week's slots. Check the notes below, add a few more favorites, or try different session types in the week template.</p>
          </section>
        )}
        <div className="cal">
          {sessions.map((s) => (
            <SessionCard key={s.slotId} s={s} roster={view} onOpenKit={setKitSlot} />
          ))}
        </div>
        {plan.notes.length > 0 && (
          <section className="card" aria-labelledby="notes-h">
            <h2 id="notes-h">Notes and limits</h2>
            <ul className="notices">
              {plan.notes.map((n) => (
                <li key={n} className="notice">
                  {n}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      <div role="tabpanel" id="panel-residents" aria-labelledby="tab-residents" className="tab-panel" data-print-title="Residents" hidden={tab !== "residents"} tabIndex={0}>
        <Residents plan={plan} roster={view} />
      </div>

      <div role="tabpanel" id="panel-families" aria-labelledby="tab-families" className="tab-panel" data-print-title="For families" hidden={tab !== "families"} tabIndex={0}>
        <section className="card">
          <div className="card-head">
            <div>
              <h2>Family newsletter</h2>
              <p className="hint">No resident-level details. Copy it into your newsletter or noticeboard.</p>
            </div>
            <CopyButton className="btn btn-ghost btn-sm no-print" text={plan.newsletter} label="Copy text" />
          </div>
          <Markdown source={plan.newsletter} />
        </section>
      </div>

      {mine && (
        <div role="tabpanel" id="panel-next" aria-labelledby="tab-next" className="tab-panel no-print" hidden={tab !== "next"} tabIndex={0}>
          <NextWeek plan={plan} roster={view} onReplan={onReplan} busy={busy} disabledReason={disabledReason} />
        </div>
      )}

      {kitSession && <KitDialog plan={plan} s={kitSession} onClose={() => setKitSlot(null)} />}
      {sessions.length > 0 && <NoticeboardPoster plan={plan} />}

      <p className="footnote">
        Matches are Qloo's aggregate taste affinities, ranked per resident. They describe taste, not health or ability, and do not replace knowing the person. Always
        check with residents and families.
      </p>
    </article>
  );
}
