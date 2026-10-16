import "dotenv/config";
import { z } from "zod";

const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalString = z.preprocess(emptyToUndefined, z.string().optional());

const EnvSchema = z.object({
  PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(3000)),
  QLOO_API_KEY: optionalString,
  QLOO_BASE_URL: z.preprocess(emptyToUndefined, z.string().url().default("https://hackathon.api.qloo.com")),
  GEMINI_API_KEY: optionalString,
  GEMINI_MODEL: optionalString,
  NODE_ENV: z.preprocess(emptyToUndefined, z.string().default("development")),
  CACHE_DIR: z.preprocess(emptyToUndefined, z.string().default(".cache")),
  PUBLIC_RATE_LIMIT_PER_HOUR: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(20)),
  DAILY_PLAN_CAP: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(200)),
});

export type Config = z.infer<typeof EnvSchema>;

function load(): Config {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    // Only report which variables are invalid, never their values.
    const names = [...new Set(parsed.error.issues.map((i) => String(i.path[0])))];
    throw new Error(`Invalid environment configuration: ${names.join(", ")}`);
  }
  return parsed.data;
}

export const config: Config = load();

/** Names (never values) of required secrets that are not configured. */
export function missingKeys(): string[] {
  const missing: string[] = [];
  if (!config.QLOO_API_KEY) missing.push("QLOO_API_KEY");
  if (!config.GEMINI_API_KEY) missing.push("GEMINI_API_KEY");
  return missing;
}
