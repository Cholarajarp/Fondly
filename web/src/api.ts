import type { AgentEvent, IntakeResult, PlanRequest, ReplanRequest, WeekPlan } from "../../shared/types";

export interface Health {
  ok: boolean;
  qloo: boolean;
  llm: boolean;
  model?: string | null;
}

/** Error carrying the HTTP status so the UI can pick a friendly message. */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function readError(res: Response): Promise<ApiError> {
  let message = `Request failed (${res.status})`;
  try {
    const body: unknown = await res.json();
    if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
      message = body.error;
      const issues = (body as { issues?: { path: string; message: string }[] }).issues;
      if (issues?.length) message += `: ${issues.slice(0, 3).map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join("; ")}`;
    }
  } catch {
    // Body was not JSON; keep the generic message.
  }
  return new ApiError(message, res.status);
}

async function send<T>(url: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers: { Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers } });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiError("Could not reach the Fondly server.", 0);
  }
  if (!res.ok) throw await readError(res);
  return (await res.json()) as T;
}

export const getHealth = (signal?: AbortSignal) => send<Health>("/api/health", { signal });
export const getPlan = (id: string, signal?: AbortSignal) => send<WeekPlan>(`/api/plans/${encodeURIComponent(id)}`, { signal });
export const parseIntake = (notes: string, signal?: AbortSignal) =>
  send<IntakeResult>("/api/intake", { method: "POST", body: JSON.stringify({ notes }), signal });

function parseBlock(block: string): string | null {
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line === "" || line.startsWith(":")) continue;
    if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  return data.length ? data.join("\n") : null;
}

const isEvent = (v: unknown): v is AgentEvent => !!v && typeof v === "object" && typeof (v as { kind?: unknown }).kind === "string";

/** POSTs and reads an SSE stream of AgentEvents (EventSource can't POST). */
async function streamEvents(url: string, body: unknown, onEvent: (e: AgentEvent) => void, signal: AbortSignal): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiError("Could not reach the Fondly server.", 0);
  }
  if (!res.ok) throw await readError(res);
  if (!res.body) throw new ApiError("The server returned an empty stream.", res.status);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const flush = (final: boolean) => {
    const parts = buffer.split(/\r?\n\r?\n/);
    buffer = final ? "" : (parts.pop() ?? "");
    for (const part of parts) {
      const payload = parseBlock(part);
      if (payload === null) continue;
      try {
        const parsed: unknown = JSON.parse(payload);
        if (isEvent(parsed)) onEvent(parsed);
      } catch {
        // Ignore malformed frames rather than killing the run.
      }
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    flush(false);
  }
  buffer += decoder.decode();
  flush(true);
}

export const streamPlan = (req: PlanRequest, onEvent: (e: AgentEvent) => void, signal: AbortSignal) =>
  streamEvents("/api/plan", req, onEvent, signal);

export const streamReplan = (planId: string, req: ReplanRequest, onEvent: (e: AgentEvent) => void, signal: AbortSignal) =>
  streamEvents(`/api/plans/${encodeURIComponent(planId)}/replan`, req, onEvent, signal);

export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 429) return err.message || "Too many requests right now. Give it a minute and try again.";
    if (err.status === 503) return err.message;
    if (err.status === 404) return "That plan couldn't be found. It may have expired.";
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}
