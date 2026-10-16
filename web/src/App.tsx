import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentEvent, WeekPlan } from "../../shared/types";
import { describeError, getHealth, getPlan, streamPlan, streamReplan } from "./api";
import { AgentTimeline, applyEvent, emptyTimeline, type TimelineState } from "./components/AgentTimeline";
import { ErrorPanel } from "./components/ErrorPanel";
import { Header, isHealthy, type HealthState } from "./components/Header";
import { PlanView, type ReplanInput } from "./components/PlanView";
import { RosterEditor } from "./components/RosterEditor";
import { mergeRequest, redactNames, toRequest, useRoster } from "./roster";

type Route = { name: "home" } | { name: "plan"; id: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseHash(hash: string): Route {
  const m = /^#\/plan\/([^/?#]+)$/.exec(hash);
  if (m?.[1]) {
    const id = decodeURIComponent(m[1]);
    if (UUID_RE.test(id)) return { name: "plan", id };
  }
  return { name: "home" };
}

type View =
  | { name: "idle" }
  | { name: "running"; title: string }
  | { name: "loading" }
  | { name: "plan"; plan: WeekPlan }
  | { name: "error"; title: string; message: string; retry?: () => void };

function Hero({ onStart, hasRoster }: { onStart: () => void; hasRoster: boolean }) {
  return (
    <section className="hero" aria-labelledby="hero-h">
      <div>
        <p className="eyebrow eyebrow-brand">For activity coordinators</p>
        <h1 id="hero-h">
          A week where <em>every</em> resident gets something they love.
        </h1>
        <p className="lede">
          Group activities usually play to the majority. Fondly scores every option for every resident with Qloo taste data, then schedules the week so the
          least-served resident is as well served as possible. Anyone still left out gets a 1:1 visit plan.
        </p>
        <div className="hero-actions">
          <button type="button" className="btn btn-primary" onClick={onStart}>
            {hasRoster ? "Continue with your roster" : "Set up your residents"}
          </button>
          <span className="hint">No sign-up. Names stay on your device.</span>
        </div>
      </div>
      <ol className="hero-points" aria-label="How it works">
        <li>
          <span className="n">1</span>
          <div>
            <strong>Add favorites</strong>
            <span>A few artists, films, shows, books or cuisines each, or describe them in your own words.</span>
          </div>
        </li>
        <li>
          <span className="n">2</span>
          <div>
            <strong>Fondly plans the week</strong>
            <span>Live Qloo affinity per resident, a fairness optimizer, and a side-by-side check against a generic popular-titles calendar.</span>
          </div>
        </li>
        <li>
          <span className="n">3</span>
          <div>
            <strong>Run it, then tell Fondly how it went</strong>
            <span>Reactions and changes feed next week's plan, with a clear diff of what moved.</span>
          </div>
        </li>
      </ol>
    </section>
  );
}

export default function App() {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  const [health, setHealth] = useState<HealthState>({ state: "loading" });
  const [roster, updateRoster, resetRoster] = useRoster();
  const [view, setView] = useState<View>({ name: "idle" });
  const [timeline, setTimeline] = useState<TimelineState>(emptyTimeline);
  const runRef = useRef<AbortController | null>(null);
  const seq = useRef(0);
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const ctl = new AbortController();
    getHealth(ctl.signal)
      .then((h) => setHealth({ state: "ready", health: h }))
      .catch((err) => {
        if (!ctl.signal.aborted) setHealth({ state: "error", message: describeError(err) });
      });
    return () => ctl.abort();
  }, []);

  useEffect(() => {
    const onHash = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Load a plan from the URL unless it's the one already shown.
  useEffect(() => {
    if (route.name !== "plan") return;
    if (view.name === "plan" && view.plan.id === route.id) return;
    if (view.name === "running") return;
    const ctl = new AbortController();
    setView({ name: "loading" });
    getPlan(route.id, ctl.signal)
      .then((plan) => setView({ name: "plan", plan }))
      .catch((err) => {
        if (!ctl.signal.aborted) setView({ name: "error", title: "Couldn't open that plan", message: describeError(err) });
      });
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route]);

  useEffect(() => () => runRef.current?.abort(), []);

  const goHome = useCallback(() => {
    runRef.current?.abort();
    setView({ name: "idle" });
    if (window.location.hash) window.history.pushState(null, "", window.location.pathname);
    setRoute({ name: "home" });
    window.scrollTo({ top: 0 });
  }, []);

  const toSetup = useCallback(() => {
    goHome();
    requestAnimationFrame(() => document.getElementById("setup")?.scrollIntoView({ behavior: "smooth" }));
  }, [goHome]);

  const run = useCallback(
    async (title: string, start: (onEvent: (e: AgentEvent) => void, signal: AbortSignal) => Promise<void>, retry: () => void) => {
      runRef.current?.abort();
      const ctl = new AbortController();
      runRef.current = ctl;
      setTimeline(emptyTimeline());
      setView({ name: "running", title });
      window.scrollTo({ top: 0, behavior: "smooth" });
      let finished = false;
      try {
        await start((ev) => {
          if (ctl.signal.aborted) return;
          if (ev.kind === "done") {
            finished = true;
            const plan = ev.plan;
            // Fold the server's request back in (re-plans may add residents or change availability).
            updateRoster((r) => ({
              ...(plan.request.rosterId === r.rosterId ? mergeRequest(r, plan.request) : r),
              lastPlanId: plan.id,
              planHistory: [plan.id, ...r.planHistory.filter((x) => x !== plan.id)].slice(0, 20),
            }));
            setView({ name: "plan", plan });
            window.history.pushState(null, "", `#/plan/${plan.id}`);
            setRoute({ name: "plan", id: plan.id });
            requestAnimationFrame(() => mainRef.current?.focus());
          } else if (ev.kind === "error") {
            finished = true;
            setView({ name: "error", title: "The plan couldn't be finished", message: ev.message, retry });
          } else {
            setTimeline((t) => applyEvent(t, ev, ++seq.current));
          }
        }, ctl.signal);
        if (!finished && !ctl.signal.aborted) setView({ name: "error", title: "The connection closed early", message: "The server stopped before the plan was ready. Please try again.", retry });
      } catch (err) {
        if (ctl.signal.aborted) return;
        setView({ name: "error", title: "The plan couldn't be started", message: describeError(err), retry });
      } finally {
        if (runRef.current === ctl) runRef.current = null;
      }
    },
    [updateRoster],
  );

  const planWeek = useCallback(() => {
    const req = toRequest(roster);
    const go = () => void run("Planning this week", (on, s) => streamPlan(req, on, s), go);
    go();
  }, [roster, run]);

  const replan = useCallback(
    (from: WeekPlan, input: ReplanInput) => {
      const body = {
        mode: input.mode,
        reactions: input.reactions,
        request: toRequest(roster),
        ...(input.instruction ? { instruction: redactNames(input.instruction, roster.residents) } : {}),
      };
      const go = () => void run(input.mode === "next_week" ? "Planning next week" : "Adjusting this week", (on, s) => streamReplan(from.id, body, on, s), go);
      go();
    },
    [roster, run],
  );

  const cancel = useCallback(() => {
    runRef.current?.abort();
    runRef.current = null;
    setView({ name: "idle" });
    if (route.name === "plan") window.history.back();
  }, [route]);

  const ready = isHealthy(health);
  const intakeEnabled = health.state === "ready" && health.health.llm;
  const disabledReason =
    health.state === "loading"
      ? "Checking the server…"
      : health.state === "error"
        ? "The server is unreachable."
        : !ready
          ? `The server is not configured yet (${[!health.health.qloo && "Qloo key", !health.health.llm && "language model key"].filter(Boolean).join(", ")}). Planning is disabled until it is.`
          : undefined;

  return (
    <div className="app">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <Header health={health} onHome={goHome} />
      <main id="main" ref={mainRef} tabIndex={-1}>
        {view.name === "running" && <AgentTimeline title={view.title} timeline={timeline} running onCancel={cancel} />}
        {view.name === "loading" && (
          <section className="card" aria-busy="true">
            <p className="tl-status">Loading plan…</p>
          </section>
        )}
        {view.name === "error" && <ErrorPanel title={view.title} message={view.message} onRetry={view.retry} onDismiss={goHome} />}
        {view.name === "plan" && (
          <>
            {timeline.steps.length > 0 && (
              <details className="no-print">
                <summary className="hint" style={{ cursor: "pointer" }}>
                  Show how this plan was built ({timeline.steps.length} steps)
                </summary>
                <AgentTimeline title="Planning run" timeline={timeline} running={false} />
              </details>
            )}
            <PlanView plan={view.plan} roster={roster} busy={false} disabledReason={disabledReason} onEditRoster={toSetup} onReplan={(i) => (ready ? replan(view.plan, i) : undefined)} />
          </>
        )}
        {view.name === "idle" && route.name === "home" && (
          <>
            <Hero onStart={() => document.getElementById("setup")?.scrollIntoView({ behavior: "smooth" })} hasRoster={roster.residents.length > 0} />
            {roster.lastPlanId && (
              <p className="notice">
                Your last plan is saved.{" "}
                <a href={`#/plan/${roster.lastPlanId}`}>Open it</a> to record how the week went and plan the next one.
              </p>
            )}
            <RosterEditor
              roster={roster}
              update={updateRoster}
              onPlan={planWeek}
              onReset={resetRoster}
              canPlan={ready}
              busy={false}
              intakeEnabled={intakeEnabled}
              disabledReason={disabledReason}
            />
            <section className="how" aria-label="What makes Fondly different">
              <div className="card">
                <h3>Fair by design</h3>
                <p>The optimizer maximizes how many residents get a strong match, then lifts the least-served resident. The language model never picks the numbers.</p>
              </div>
              <div className="card">
                <h3>Measured, not claimed</h3>
                <p>Every plan is compared on the same residents against a generic “most popular titles” calendar and the same AI working without Qloo.</p>
              </div>
              <div className="card">
                <h3>Private by default</h3>
                <p>Only aliases and public favorites leave this device. No accounts, no health data, nothing to leak.</p>
              </div>
            </section>
          </>
        )}
        <p className="footnote">Fondly is a hackathon project. Taste data from Qloo. It plans activities; it does not give care or medical advice.</p>
      </main>
    </div>
  );
}
