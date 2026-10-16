import { ApiError } from "@google/genai";
import { afterEach, describe, expect, it } from "vitest";
import { generateWithRetry, type GeminiClient } from "../server/agent/gemini.ts";

type Call = { model: string; thinking: unknown };

function fakeGemini(failures: number[]): { client: GeminiClient; calls: Call[] } {
  const calls: Call[] = [];
  const client = {
    models: {
      generateContent: async (p: { model: string; config?: { thinkingConfig?: unknown } }) => {
        calls.push({ model: p.model, thinking: p.config?.thinkingConfig });
        const status = failures.shift();
        if (status) throw new ApiError({ message: `status ${status}`, status });
        return { text: "ok" };
      },
    },
  } as unknown as GeminiClient;
  return { client, calls };
}

const params = { model: "gemini-3.1-flash-lite", contents: "hi", config: { thinkingConfig: { thinkingLevel: "LOW" } } } as never;
const opts = () => ({ deadline: Date.now() + 120_000, sleep: async () => undefined });

describe("generateWithRetry", () => {
  afterEach(() => {
    delete process.env.GEMINI_FALLBACK_MODEL;
  });

  it("switches to the fallback model on overload and drops Gemini 3 thinking config", async () => {
    const { client, calls } = fakeGemini([503]);
    await generateWithRetry(client, params, opts());
    expect(calls.map((c) => c.model)).toEqual(["gemini-3.1-flash-lite", "gemini-2.5-flash"]);
    expect(calls[1]!.thinking).toBeUndefined();
  });

  it("retries the same model on 429 rate limits", async () => {
    const { client, calls } = fakeGemini([429]);
    await generateWithRetry(client, params, opts());
    expect(calls.map((c) => c.model)).toEqual(["gemini-3.1-flash-lite", "gemini-3.1-flash-lite"]);
  });

  it("can disable the fallback", async () => {
    process.env.GEMINI_FALLBACK_MODEL = "none";
    const { client, calls } = fakeGemini([503]);
    await generateWithRetry(client, params, opts());
    expect(calls.map((c) => c.model)).toEqual(["gemini-3.1-flash-lite", "gemini-3.1-flash-lite"]);
  });
});
