// NVIDIA NIM fallback (OpenAI-compatible chat completions) for when Gemini is rate limited or down.
// Translates Gemini request params to OpenAI messages/tools and the reply back into a Gemini-shaped
// response, so the agent loop and JSON helpers work unchanged.
import type { Content, GenerateContentParameters, GenerateContentResponse, Part } from "@google/genai";

export const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
/** Tried in order. Picked by live probe: both handle parallel tool calls and JSON mode. */
export const DEFAULT_NVIDIA_MODELS = ["nvidia/nemotron-3.5-super-vl-120b-a12b", "nvidia/nemotron-3-super-120b-a12b"];

export const isNvidiaConfigured = () => Boolean(process.env.NVIDIA_API_KEY?.trim());

export function nvidiaModels(): string[] {
  const raw = process.env.NVIDIA_MODELS?.trim();
  return raw ? raw.split(",").map((m) => m.trim()).filter(Boolean) : DEFAULT_NVIDIA_MODELS;
}

export class NvidiaError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "NvidiaError";
  }
}

type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
type Message =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

const textOf = (parts: Part[]) =>
  parts
    .filter((p) => typeof p.text === "string" && !p.thought)
    .map((p) => p.text)
    .join("\n");

const systemText = (s: unknown): string => {
  if (!s) return "";
  if (typeof s === "string") return s;
  if (Array.isArray(s)) return s.map(systemText).join("\n");
  const o = s as { text?: string; parts?: Part[] };
  return o.text ?? (o.parts ? textOf(o.parts) : "");
};

/** Gemini contents -> OpenAI messages. Function call ids are kept, or synthesized in call order. */
export function toMessages(params: GenerateContentParameters): Message[] {
  const out: Message[] = [];
  const sys = systemText(params.config?.systemInstruction);
  const json = params.config?.responseMimeType === "application/json";
  const schema = params.config?.responseJsonSchema;
  const sysFull = json && schema ? `${sys}\n\nRespond with only a JSON object matching this JSON Schema:\n${JSON.stringify(schema)}` : sys;
  if (sysFull.trim()) out.push({ role: "system", content: sysFull });

  const contents: Content[] = typeof params.contents === "string" ? [{ role: "user", parts: [{ text: params.contents }] }] : (params.contents as Content[]);
  let seq = 0;
  const pending: string[] = []; // ids of the last assistant turn's calls, matched to responses by order
  for (const c of contents) {
    const parts = c.parts ?? [];
    if (c.role === "model") {
      const calls: ToolCall[] = parts
        .filter((p) => p.functionCall)
        .map((p) => ({
          id: p.functionCall!.id || `call_${++seq}`,
          type: "function",
          function: { name: p.functionCall!.name ?? "", arguments: JSON.stringify(p.functionCall!.args ?? {}) },
        }));
      pending.splice(0, pending.length, ...calls.map((x) => x.id));
      out.push({ role: "assistant", content: textOf(parts) || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    let i = 0;
    for (const p of parts) {
      if (!p.functionResponse) continue;
      const id = p.functionResponse.id || pending[i] || `call_${++seq}`;
      i++;
      out.push({ role: "tool", tool_call_id: id, content: JSON.stringify(p.functionResponse.response ?? {}) });
    }
    const text = textOf(parts);
    if (text) out.push({ role: "user", content: text });
  }
  return out;
}

function toTools(params: GenerateContentParameters) {
  const decls = (params.config?.tools ?? []).flatMap((t) => ("functionDeclarations" in t ? (t.functionDeclarations ?? []) : []));
  return decls.map((d) => ({
    type: "function" as const,
    function: { name: d.name ?? "", description: d.description ?? "", parameters: (d.parametersJsonSchema ?? d.parameters ?? { type: "object", properties: {} }) as object },
  }));
}

/** OpenAI finish reasons in Gemini's vocabulary, so the agent's blocked-reply check still works. */
const FINISH: Record<string, string> = { stop: "STOP", tool_calls: "STOP", length: "MAX_TOKENS", content_filter: "SAFETY" };

const parseArgs =(s: string): Record<string, unknown> => {
  try {
    const v = JSON.parse(s || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
};

/** Pulls the JSON object out of a reply that may wrap it in a code fence or prose. */
export function extractJson(text: string): string {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  if (t.startsWith("{") || t.startsWith("[")) return t;
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  return a >= 0 && b > a ? t.slice(a, b + 1) : t;
}

/** One chat completion against NVIDIA, returned in the shape the Gemini callers read. */
export async function nvidiaGenerate(
  model: string,
  params: GenerateContentParameters,
  opts: { signal: AbortSignal; fetchImpl?: typeof fetch },
): Promise<GenerateContentResponse> {
  const key = process.env.NVIDIA_API_KEY?.trim();
  if (!key) throw new NvidiaError("NVIDIA_API_KEY is not set", 0);
  const tools = toTools(params);
  const json = params.config?.responseMimeType === "application/json";
  const body = {
    model,
    messages: toMessages(params),
    max_tokens: Math.max(params.config?.maxOutputTokens ?? 0, 4096),
    temperature: 0.4,
    ...(tools.length ? { tools, tool_choice: "auto" } : {}),
    ...(json ? { response_format: { type: "json_object" } } : {}),
  };
  const res = await (opts.fetchImpl ?? fetch)(`${process.env.NVIDIA_BASE_URL?.trim() || NVIDIA_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok) throw new NvidiaError(`NVIDIA ${model} returned ${res.status}`, res.status);
  const data = (await res.json()) as {
    choices?: { finish_reason?: string; message?: { content?: string | null; tool_calls?: ToolCall[] } }[];
  };
  const msg = data.choices?.[0]?.message;
  if (!msg) throw new NvidiaError(`NVIDIA ${model} returned no choices`, 502);
  const calls = msg.tool_calls ?? [];
  const parts: Part[] = calls.map((c) => ({ functionCall: { id: c.id, name: c.function.name, args: parseArgs(c.function.arguments) } }));
  const content = msg.content ?? "";
  const text = json ? extractJson(content) : content;
  if (text) parts.unshift({ text });
  const fc = parts.filter((p) => p.functionCall).map((p) => p.functionCall!);
  // Only the fields the callers read: candidates, text, functionCalls.
  return {
    candidates: [{ content: { role: "model", parts }, finishReason: FINISH[data.choices?.[0]?.finish_reason ?? ""] ?? "STOP" }],
    text: text || undefined,
    functionCalls: fc.length ? fc : undefined,
  } as unknown as GenerateContentResponse;
}
