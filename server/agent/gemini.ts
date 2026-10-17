// Thin Gemini helpers shared by the agent loop and the structured-output calls.
import { ApiError, ThinkingLevel, type Content, type GenerateContentParameters, type GenerateContentResponse, type GoogleGenAI } from "@google/genai";
import { NvidiaError, isNvidiaConfigured, nvidiaGenerate, nvidiaModels } from "./nvidia.ts";

export type GeminiClient = Pick<GoogleGenAI, "models">;

export const DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-lite";
/**
 * Tried in order after the primary model reports overload (5xx) or is unavailable (404): capacity is
 * per model, so moving to another model recovers. All Gemini 3, so thinking config and thought
 * signatures stay valid. GEMINI_FALLBACK_MODELS overrides (comma-separated, "none" disables).
 */
export const DEFAULT_FALLBACK_MODELS = ["gemini-3.5-flash", "gemini-3-flash-preview"];

export function fallbackModels(primary: string): string[] {
  const raw = process.env.GEMINI_FALLBACK_MODELS?.trim();
  if (raw === "none") return [];
  const list = raw ? raw.split(",").map((m) => m.trim()).filter(Boolean) : DEFAULT_FALLBACK_MODELS;
  return list.filter((m) => m !== primary);
}

const THINKING_LEVELS: Record<string, ThinkingLevel> = {
  minimal: ThinkingLevel.MINIMAL,
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
};

export function modelConfig(): { model: string; thinking: ThinkingLevel } {
  const model = process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
  const raw = process.env.GEMINI_THINKING?.trim().toLowerCase() ?? "";
  return { model, thinking: THINKING_LEVELS[raw] ?? ThinkingLevel.LOW };
}

/** Free-tier keys hit per-minute limits easily: retry 429/5xx a few times. */
export const RETRY_DELAYS_MS = [4_000, 10_000, 20_000];

export const isRetryable = (err: unknown) =>
  err instanceof ApiError && (err.status === 429 || err.status === 503 || err.status === 500);

export const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

/** Error with a user-safe message. */
export class AgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentError";
  }
}

/**
 * One generateContent call with bounded retries. Throws AgentError for configuration errors
 * and the last error for anything else.
 */
const STICKY_MS = 10 * 60 * 1000;
const stickyModel = new Map<string, { model: string; until: number }>();
/** Until this time, calls go straight to NVIDIA (Gemini recently rate limited or failed). */
let nvidiaUntil = 0;
/** Marks a conversation's first content once it has moved to NVIDIA. */
const ON_NVIDIA = Symbol("onNvidia");
type Tagged = Content & { [ON_NVIDIA]?: true };

/** Test hook: forget remembered fallbacks. */
export const resetStickyModels = () => {
  stickyModel.clear();
  nvidiaUntil = 0;
};

type RetryOpts = { signal?: AbortSignal; deadline: number; sleep?: (ms: number, s?: AbortSignal) => Promise<void>; onRetry?: (s: number) => void };

/** Tries each NVIDIA model once, within the caller's deadline. */
async function viaNvidia(params: GenerateContentParameters, opts: RetryOpts, contents: Content[]): Promise<GenerateContentResponse> {
  if (contents[0]) (contents[0] as Tagged)[ON_NVIDIA] = true;
  let last: unknown;
  for (const model of nvidiaModels()) {
    const remaining = opts.deadline - Date.now();
    if (remaining <= 500) throw new AgentError("Time budget reached");
    const signals = [AbortSignal.timeout(Math.min(remaining, 90_000))];
    if (opts.signal) signals.push(opts.signal);
    try {
      return await nvidiaGenerate(model, params, { signal: AbortSignal.any(signals) });
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      if (err instanceof NvidiaError && (err.status === 401 || err.status === 403)) {
        throw new AgentError("The fallback language model rejected the server's API key. Check NVIDIA_API_KEY.");
      }
      console.warn(`[llm] nvidia ${model} failed: ${err instanceof NvidiaError ? err.status : (err as Error)?.name}`);
      last = err;
    }
  }
  throw last ?? new AgentError("No NVIDIA model available");
}

export async function generateWithRetry(
  gemini: GeminiClient,
  params: GenerateContentParameters,
  opts: { signal?: AbortSignal; deadline: number; sleep?: (ms: number, s?: AbortSignal) => Promise<void>; onRetry?: (s: number) => void },
): Promise<GenerateContentResponse> {
  const sleep = opts.sleep ?? defaultSleep;
  const fallbacks = fallbackModels(params.model);
  // If the primary recently failed over, start where the last call succeeded instead of re-probing
  // a retired or overloaded model on every one of the agent's turns.
  let model = params.model;
  const sticky = stickyModel.get(params.model);
  if (sticky && sticky.until > Date.now() && fallbacks.includes(sticky.model)) {
    fallbacks.splice(0, fallbacks.indexOf(sticky.model) + 1);
    model = sticky.model;
  }
  // A conversation that already failed over stays on NVIDIA: Gemini would reject its history.
  const contents = Array.isArray(params.contents) ? (params.contents as Content[]) : [];
  // LLM_PROVIDER=nvidia skips Gemini entirely (e.g. when its daily quota is gone).
  const forced = process.env.LLM_PROVIDER?.trim().toLowerCase() === "nvidia";
  if (isNvidiaConfigured() && (forced || nvidiaUntil > Date.now() || contents.some((c) => (c as Tagged)[ON_NVIDIA]))) {
    return viaNvidia(params, opts, contents);
  }
  for (let attempt = 0; ; attempt++) {
    const remaining = opts.deadline - Date.now();
    if (remaining <= 500) throw new AgentError("Time budget reached");
    const signals = [AbortSignal.timeout(Math.max(1, remaining))];
    if (opts.signal) signals.push(opts.signal);
    try {
      const res = await gemini.models.generateContent({
        ...params,
        model,
        config: {
          ...params.config,
          abortSignal: AbortSignal.any(signals),
        },
      });
      if (model !== params.model) stickyModel.set(params.model, { model, until: Date.now() + STICKY_MS });
      return res;
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      const status = err instanceof ApiError ? err.status : undefined;
      if (status === 401 || status === 403) throw new AgentError("The language model rejected the server's API key. Check GEMINI_API_KEY.");
      // Overloaded or unavailable model: move to the next fallback model and retry right away.
      if ((status === 503 || status === 500 || status === 404) && fallbacks.length) {
        model = fallbacks.shift()!;
        opts.onRetry?.(0);
        attempt--;
        continue;
      }
      // Rate limited, overloaded or timed out: NVIDIA answers now instead of after a backoff.
      const timedOut = (err as Error)?.name === "TimeoutError" || (err as Error)?.name === "AbortError";
      if (isNvidiaConfigured() && (isRetryable(err) || timedOut) && opts.deadline - Date.now() > 5_000) {
        console.warn(`[llm] gemini ${model} failed (status=${status ?? (err as Error)?.name}); switching to NVIDIA`);
        nvidiaUntil = Date.now() + STICKY_MS;
        return viaNvidia(params, opts, contents);
      }
      const delay = RETRY_DELAYS_MS[attempt];
      if (isRetryable(err) && delay !== undefined && opts.deadline - Date.now() > delay + 10_000) {
        opts.onRetry?.(Math.round(delay / 1000));
        await sleep(delay, opts.signal);
        continue;
      }
      throw err;
    }
  }
}

/** Structured JSON call: returns the parsed object or throws. */
export async function generateJson<T>(
  gemini: GeminiClient,
  args: { system: string; user: string; schema: Record<string, unknown>; deadline: number; signal?: AbortSignal; sleep?: (ms: number, s?: AbortSignal) => Promise<void> },
): Promise<T> {
  const { model, thinking } = modelConfig();
  const res = await generateWithRetry(
    gemini,
    {
      model,
      contents: [{ role: "user", parts: [{ text: args.user }] }],
      config: {
        systemInstruction: args.system,
        responseMimeType: "application/json",
        responseJsonSchema: args.schema,
        thinkingConfig: { thinkingLevel: thinking },
        maxOutputTokens: 4096,
      },
    },
    { signal: args.signal, deadline: args.deadline, sleep: args.sleep },
  );
  const text = res.text ?? "";
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AgentError("The language model returned malformed JSON.");
  }
}
