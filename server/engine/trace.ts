import type { AgentEvent } from "../../shared/types.ts";

export const clip = (s: string | undefined, max: number): string | undefined => {
  if (s === undefined) return undefined;
  // eslint-disable-next-line no-control-regex
  const clean = s.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
};

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Short, user-safe reason for plan notes (shown to coordinators). Never includes upstream bodies,
 * keys or stacks; the full message goes to the server log instead.
 */
export function safeReason(e: unknown, where: string): string {
  console.warn(`[${where}]`, clip(errMsg(e), 500));
  const status = (e as { status?: unknown } | null)?.status;
  if (typeof status === "number") {
    if (status === 429) return "rate limited, try again in a minute";
    if (status === 401 || status === 403) return "the service rejected the server's credentials";
    if (status === 0) return "the service could not be reached";
    if (status >= 500) return "the service is having trouble right now";
  }
  if (/timeout|timed out|abort/i.test(errMsg(e))) return "the request timed out";
  return "an unexpected error occurred";
}

/** Emits tool_call/tool_result events around code-driven work so the UI shows every Qloo request. */
export class Tracer {
  private n = 0;
  constructor(public readonly emit: (e: AgentEvent) => void) {}

  async call<T>(tool: string, input: unknown, fn: () => Promise<T>, summarize: (r: T) => string): Promise<T> {
    const id = `c${++this.n}`;
    const t0 = Date.now();
    this.emit({ kind: "tool_call", id, tool, input });
    try {
      const res = await fn();
      this.emit({ kind: "tool_result", id, tool, ok: true, summary: summarize(res), ms: Date.now() - t0 });
      return res;
    } catch (err) {
      this.emit({ kind: "tool_result", id, tool, ok: false, summary: `error: ${clip(errMsg(err), 160)}`, ms: Date.now() - t0 });
      throw err;
    }
  }

  async tryCall<T>(tool: string, input: unknown, fn: () => Promise<T>, summarize: (r: T) => string): Promise<T | undefined> {
    try {
      return await this.call(tool, input, fn, summarize);
    } catch (e) {
      const status = (e as { status?: unknown })?.status;
      if (!this.fatal && (status === 401 || status === 403 || status === 429)) this.fatal = e;
      return undefined;
    }
  }

  /** First auth/quota failure seen by tryCall; these affect every call, so the run should report them. */
  fatal: unknown;
}

/** Runs async tasks with bounded concurrency, preserving order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}
