// Thin Gemini helpers shared by the agent loop and the structured-output calls.
import { ApiError, ThinkingLevel, type GenerateContentParameters, type GenerateContentResponse, type GoogleGenAI } from "@google/genai";

export type GeminiClient = Pick<GoogleGenAI, "models">;

export const DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-lite";
/** Used after the primary model reports overload (5xx): capacity is per model, so retrying elsewhere recovers. */
export const DEFAULT_FALLBACK_MODEL = "gemini-2.5-flash";

export function fallbackModel(): string | undefined {
  const raw = process.env.GEMINI_FALLBACK_MODEL?.trim();
  if (raw === "none") return undefined;
  return raw || DEFAULT_FALLBACK_MODEL;
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
export async function generateWithRetry(
  gemini: GeminiClient,
  params: GenerateContentParameters,
  opts: { signal?: AbortSignal; deadline: number; sleep?: (ms: number, s?: AbortSignal) => Promise<void>; onRetry?: (s: number) => void },
): Promise<GenerateContentResponse> {
  const sleep = opts.sleep ?? defaultSleep;
  const fallback = fallbackModel();
  let model = params.model;
  for (let attempt = 0; ; attempt++) {
    const remaining = opts.deadline - Date.now();
    if (remaining <= 500) throw new AgentError("Time budget reached");
    const signals = [AbortSignal.timeout(Math.max(1, remaining))];
    if (opts.signal) signals.push(opts.signal);
    try {
      return await gemini.models.generateContent({
        ...params,
        model,
        config: {
          ...params.config,
          // thinkingLevel is Gemini 3 only; older fallback models reject it.
          ...(model !== params.model && !model.startsWith("gemini-3") ? { thinkingConfig: undefined } : {}),
          abortSignal: AbortSignal.any(signals),
        },
      });
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      const status = err instanceof ApiError ? err.status : undefined;
      if (status === 401 || status === 403) throw new AgentError("The language model rejected the server's API key. Check GEMINI_API_KEY.");
      // Overload on the primary model: switch once to the fallback model and retry right away.
      if ((status === 503 || status === 500) && fallback && model !== fallback) {
        model = fallback;
        opts.onRetry?.(0);
        continue;
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
