import { GoogleGenAI } from "@google/genai";
import type { QlooClient } from "../shared/types.ts";
import { config, missingKeys } from "./config.ts";
import { createApp } from "./app.ts";
import { DEFAULT_GEMINI_MODEL, type GeminiClient } from "./agent/gemini.ts";
import { isNvidiaConfigured, nvidiaModels } from "./agent/nvidia.ts";
import { createQlooClient, isQlooConfigured } from "./qloo/client.ts";
import { createFileCache } from "./qloo/cache.ts";

let qloo: QlooClient | undefined;
let gemini: GeminiClient | undefined;

// Clients are created lazily so the server can boot (and report health) without keys.
function getQloo(): QlooClient {
  qloo ??= createQlooClient({
    apiKey: config.QLOO_API_KEY,
    baseUrl: config.QLOO_BASE_URL,
    cache: createFileCache(config.CACHE_DIR),
  });
  return qloo;
}

function getGemini(): GeminiClient {
  if (!config.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not configured");
  gemini ??= new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });
  return gemini;
}

// The primary model: NVIDIA when configured (Gemini is then the fallback), unless LLM_PROVIDER=gemini.
const nvidiaFirst = isNvidiaConfigured() && process.env.LLM_PROVIDER?.trim().toLowerCase() !== "gemini";
const model = nvidiaFirst ? nvidiaModels()[0]! : (config.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL);

const app = createApp({
  getQloo,
  getGemini,
  qlooConfigured: () => isQlooConfigured(),
  llmConfigured: () => Boolean(config.GEMINI_API_KEY),
  model,
  missingKeys,
});

const server = app.listen(config.PORT, () => {
  console.log(
    `Fondly listening on :${config.PORT} (env=${config.NODE_ENV}) ` +
      `qloo=${isQlooConfigured()} llm=${Boolean(config.GEMINI_API_KEY)} model=${model}`,
  );
  const missing = missingKeys();
  if (missing.length) console.warn(`Missing configuration: ${missing.join(", ")} (planning endpoints will return 503)`);
});

function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`);
  server.close(() => process.exit(0));
  // SSE streams may hold connections open; force exit after a grace period.
  setTimeout(() => process.exit(0), 10_000).unref();
  server.closeIdleConnections?.();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
