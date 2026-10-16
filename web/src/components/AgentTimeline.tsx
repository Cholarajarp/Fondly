import { useEffect, useState } from "react";
import type { AgentEvent, Metrics } from "../../../shared/types";

/** One row in the timeline, derived by folding AgentEvents. */
export type TimelineStep =
  | { kind: "status"; key: string; message: string }
  | { kind: "tool"; key: string; tool: string; label: string; state: "running" | "ok" | "fail"; ms?: number; summary?: string };

export interface TimelineState {
  steps: TimelineStep[];
  progress: { label: string; metrics: Metrics }[];
}

export const emptyTimeline = (): TimelineState => ({ steps: [], progress: [] });

const QLOO_TOOLS = new Set([
  "resolve_entity",
  "resolve_tag",
  "get_recommendations",
  "get_outing_venues",
  "score_resident",
  "get_baseline",
  "get_related",
  "get_one_to_one",
]);

function field(input: unknown, name: string): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const v = (input as Record<string, unknown>)[name];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** Plain-language labels. Resident ids are shown as-is (names stay in the roster view). */
export function toolLabel(tool: string, input: unknown): string {
  switch (tool) {
    case "resolve_favorites":
      return "Matching favorites on Qloo";
    case "resolve_entity":
      return field(input, "purpose") ? `Checking “${field(input, "query")}” (AI-only plan)` : `Looking up “${field(input, "query") ?? "favorite"}”`;
    case "resolve_tag":
      return `Looking up cuisine “${field(input, "query") ?? ""}”`;
    case "build_candidates":
      return "Gathering candidate activities";
    case "get_recommendations":
      return `Qloo recommendations: ${field(input, "domain") ?? ""}`;
    case "get_outing_venues":
      return `Finding outing venues in ${field(input, "city") ?? "town"}`;
    case "score_residents":
      return "Scoring every option for every resident";
    case "score_resident":
      return `Scoring ${field(input, "domain") ?? ""} for ${field(input, "resident") ?? "a resident"}`;
    case "build_baseline":
    case "get_baseline":
      return `Building the generic popular-titles calendar${field(input, "domain") ? `: ${field(input, "domain")}` : ""}`;
    case "optimize":
      return "Running the fairness optimizer";
    case "expand_for_residents":
      return `Searching wider for ${(input as { resident_ids?: string[] })?.resident_ids?.join(", ") ?? "unreached residents"}`;
    case "plan_one_to_ones":
      return "Planning 1:1 visits";
    case "get_one_to_one":
      return `1:1 picks for ${field(input, "resident") ?? "a resident"}`;
    case "get_related":
      return `Related titles for ${field(input, "entity") ?? "a session"}`;
    case "record_sessions":
      return "Writing session briefs";
    case "finish":
      return "Writing the summary and newsletter";
    case "parse_instruction":
      return "Reading your instruction";
    default:
      return tool.replace(/_/g, " ");
  }
}

export function applyEvent(s: TimelineState, ev: AgentEvent, seq: number): TimelineState {
  if (ev.kind === "status") return { ...s, steps: [...s.steps, { kind: "status", key: `s${seq}`, message: ev.message }] };
  if (ev.kind === "progress") return { ...s, progress: [...s.progress, { label: ev.label, metrics: ev.metrics }] };
  if (ev.kind === "tool_call")
    return { ...s, steps: [...s.steps, { kind: "tool", key: `${ev.id}-${seq}`, tool: ev.tool, label: toolLabel(ev.tool, ev.input), state: "running" }] };
  if (ev.kind === "tool_result") {
    // Match the most recent running step with this id prefix.
    let idx = -1;
    for (let i = s.steps.length - 1; i >= 0; i--) {
      const st = s.steps[i]!;
      if (st.kind === "tool" && st.key.startsWith(`${ev.id}-`) && st.state === "running") {
        idx = i;
        break;
      }
    }
    const state = ev.ok ? ("ok" as const) : ("fail" as const);
    if (idx < 0) return { ...s, steps: [...s.steps, { kind: "tool", key: `${ev.id}-${seq}`, tool: ev.tool, label: toolLabel(ev.tool, undefined), state, ms: ev.ms, summary: ev.summary }] };
    const steps = s.steps.slice();
    const st = steps[idx] as Extract<TimelineStep, { kind: "tool" }>;
    steps[idx] = { ...st, state, ms: ev.ms, summary: ev.summary };
    return { ...s, steps };
  }
  return s;
}

export const qlooCalls = (s: TimelineState) => s.steps.filter((x) => x.kind === "tool" && QLOO_TOOLS.has(x.tool) && x.state !== "running").length;

function Icon({ state }: { state: "running" | "ok" | "fail" }) {
  if (state === "running") return <span className="tl-icon tl-spin" aria-label="Running" />;
  if (state === "ok")
    return (
      <span className="tl-icon tl-ok" aria-label="Done">
        ✓
      </span>
    );
  return (
    <span className="tl-icon tl-fail" aria-label="Failed">
      ✕
    </span>
  );
}

function Elapsed({ running }: { running: boolean }) {
  const [start] = useState(() => Date.now());
  const [ms, setMs] = useState(0);
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => setMs(Date.now() - start), 250);
    return () => window.clearInterval(t);
  }, [running, start]);
  const s = Math.floor(ms / 1000);
  return <span className="counter" aria-hidden="true">{s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`}</span>;
}

interface Props {
  title: string;
  timeline: TimelineState;
  running: boolean;
  onCancel?: () => void;
}

export function AgentTimeline({ title, timeline, running, onCancel }: Props) {
  const calls = qlooCalls(timeline);
  // Show the newest steps first so the live action is always visible.
  const steps = [...timeline.steps].reverse();
  const last = timeline.progress[timeline.progress.length - 1];
  const first = timeline.progress[0];
  return (
    <section className="card timeline" aria-labelledby="tl-h">
      <div className="progress-track" aria-hidden="true">
        <div className={`progress-bar${running ? "" : " done"}`} />
      </div>
      <div className="tl-inner">
        <div className="tl-head">
          <div>
            <p className="eyebrow eyebrow-brand">{running ? "Fondly is planning" : "Planning run"}</p>
            <h2 id="tl-h">{title}</h2>
          </div>
          <div className="tl-meta">
            {running && <Elapsed running={running} />}
            <span className="counter">
              <strong>{calls}</strong> Qloo requests
            </span>
            {running && onCancel && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
                Cancel
              </button>
            )}
          </div>
        </div>
        {last && (
          <p className="reach-live" role="status">
            <span>
              {last.label}: <strong className="num">{last.metrics.reached}</strong> of {last.metrics.total} residents have a strongly matched session
              {first && first !== last && first.metrics.reached !== last.metrics.reached ? ` (was ${first.metrics.reached})` : ""}
            </span>
          </p>
        )}
        <ol className="tl-list" aria-live="polite" aria-relevant="additions">
          {steps.length === 0 && running && (
            <li className="tl-step tl-status">
              <span className="tl-icon tl-spin" aria-hidden="true" />
              <span>Connecting…</span>
            </li>
          )}
          {steps.map((s) =>
            s.kind === "status" ? (
              <li key={s.key} className="tl-step tl-status">
                <span className="tl-icon tl-note" aria-hidden="true" />
                <span>{s.message}</span>
              </li>
            ) : (
              <li key={s.key} className={`tl-step tl-${s.state}`}>
                <Icon state={s.state} />
                <div>
                  <div className="tl-line">
                    <span className="tl-label">{s.label}</span>
                    {s.ms !== undefined && <span className="tl-ms">{(s.ms / 1000).toFixed(1)}s</span>}
                  </div>
                  {s.summary && <span className="tl-summary">{s.summary}</span>}
                </div>
              </li>
            ),
          )}
        </ol>
        <p className="tl-foot">Every title, venue and score comes from a live Qloo response. The schedule is chosen by a deterministic optimizer, not the language model.</p>
      </div>
    </section>
  );
}
