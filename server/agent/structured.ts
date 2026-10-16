// LLM structured-output helpers: free-text intake notes -> favorites, and a re-plan instruction ->
// edits. The model only proposes; code validates and applies every change.
import { z } from "zod";
import {
  DAYS,
  DOMAINS,
  FAVORITE_KINDS,
  TIMES,
  type Day,
  type Domain,
  type Favorite,
  type FavoriteKind,
  type IntakeResult,
  type PlanRequest,
  type ResidentInput,
  type TimeOfDay,
} from "../../shared/types.ts";
import { generateJson, type GeminiClient } from "./gemini.ts";
import { EDIT_PROMPT, INTAKE_PROMPT } from "./prompt.ts";

const favSchema = {
  type: "object",
  properties: { kind: { type: "string", enum: FAVORITE_KINDS }, text: { type: "string" } },
  required: ["kind", "text"],
};
const arr = (items: unknown) => ({ type: "array", items });

const INTAKE_SCHEMA = {
  type: "object",
  properties: {
    favorites: arr(favSchema),
    unavailable_days: arr({ type: "string", enum: DAYS }),
    unavailable_times: arr({ type: "string", enum: TIMES }),
    opt_out: arr({ type: "string", enum: DOMAINS }),
  },
  required: ["favorites", "unavailable_days", "unavailable_times", "opt_out"],
};

const FavZ = z.object({ kind: z.enum(FAVORITE_KINDS as unknown as [FavoriteKind, ...FavoriteKind[]]), text: z.string().trim().min(1).max(120) });
const pickEnum = <T extends string>(vals: readonly T[]) => z.array(z.string()).transform((xs) => xs.filter((x): x is T => (vals as readonly string[]).includes(x)));

const IntakeZ = z.object({
  favorites: z.array(z.unknown()).transform((xs) => xs.flatMap((x) => (FavZ.safeParse(x).success ? [FavZ.parse(x)] : []))),
  unavailable_days: pickEnum(DAYS).default([]),
  unavailable_times: pickEnum(TIMES).default([]),
  opt_out: pickEnum(DOMAINS).default([]),
});

export async function parseIntake(
  gemini: GeminiClient,
  notes: string,
  opts: { signal?: AbortSignal } = {},
): Promise<IntakeResult> {
  const raw = await generateJson<unknown>(gemini, {
    system: INTAKE_PROMPT,
    user: `<notes>\n${notes}\n</notes>`,
    schema: INTAKE_SCHEMA,
    deadline: Date.now() + 45_000,
    signal: opts.signal,
  });
  const p = IntakeZ.parse(raw);
  return {
    favorites: dedupe(p.favorites).slice(0, 20),
    unavailableDays: [...new Set(p.unavailable_days)] as Day[],
    unavailableTimes: [...new Set(p.unavailable_times)] as TimeOfDay[],
    optOut: [...new Set(p.opt_out)] as Domain[],
  };
}

function dedupe(favs: Favorite[]): Favorite[] {
  const seen = new Set<string>();
  return favs.filter((f) => {
    const k = `${f.kind}:${f.text.toLowerCase()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Re-plan instruction -> edits
// ---------------------------------------------------------------------------

const EDIT_SCHEMA = {
  type: "object",
  properties: {
    edits: arr({
      type: "object",
      properties: {
        action: { type: "string", enum: ["add_favorites", "remove_favorites", "set_unavailable", "opt_out", "add_resident"] },
        resident_id: { type: "string" },
        favorites: arr(favSchema),
        days: arr({ type: "string", enum: DAYS }),
        times: arr({ type: "string", enum: TIMES }),
        session_types: arr({ type: "string", enum: DOMAINS }),
      },
      required: ["action", "resident_id"],
    }),
  },
  required: ["edits"],
};

const EditZ = z.object({
  action: z.enum(["add_favorites", "remove_favorites", "set_unavailable", "opt_out", "add_resident"]),
  resident_id: z.string().trim().regex(/^r\d{1,3}$/),
  favorites: z.array(z.unknown()).optional().transform((xs) => (xs ?? []).flatMap((x) => (FavZ.safeParse(x).success ? [FavZ.parse(x)] : []))),
  days: pickEnum(DAYS).optional(),
  times: pickEnum(TIMES).optional(),
  session_types: pickEnum(DOMAINS).optional(),
});
export type Edit = z.infer<typeof EditZ>;

export async function parseInstruction(
  gemini: GeminiClient,
  instruction: string,
  residentIds: string[],
  opts: { signal?: AbortSignal } = {},
): Promise<Edit[]> {
  const raw = await generateJson<{ edits?: unknown[] }>(gemini, {
    system: EDIT_PROMPT,
    user: `Existing resident ids: ${residentIds.join(", ")}\n<instruction>\n${instruction}\n</instruction>`,
    schema: EDIT_SCHEMA,
    deadline: Date.now() + 45_000,
    signal: opts.signal,
  });
  return (raw.edits ?? []).flatMap((e) => {
    const p = EditZ.safeParse(e);
    return p.success ? [p.data] : [];
  });
}

/** Applies validated edits to a copy of the request. Returns the new request and a human log. */
export function applyEdits(req: PlanRequest, edits: Edit[]): { request: PlanRequest; log: string[] } {
  const residents: ResidentInput[] = req.residents.map((r) => ({ ...r, favorites: [...r.favorites] }));
  const byId = new Map(residents.map((r) => [r.id, r]));
  const log: string[] = [];
  for (const e of edits) {
    let r = byId.get(e.resident_id);
    if (e.action === "add_resident") {
      if (r) {
        log.push(`${e.resident_id} already exists; added favorites instead.`);
      } else if (residents.length >= 60) {
        log.push(`Could not add ${e.resident_id}: the roster is full (60).`);
        continue;
      } else {
        r = { id: e.resident_id, favorites: [] };
        residents.push(r);
        byId.set(r.id, r);
        log.push(`Added new resident ${e.resident_id}.`);
      }
    }
    if (!r) {
      log.push(`Ignored an edit for unknown resident ${e.resident_id}.`);
      continue;
    }
    switch (e.action) {
      case "add_resident":
      case "add_favorites": {
        const have = new Set(r.favorites.map((f) => `${f.kind}:${f.text.toLowerCase()}`));
        const add = e.favorites.filter((f) => !have.has(`${f.kind}:${f.text.toLowerCase()}`));
        r.favorites = [...r.favorites, ...add].slice(0, 20);
        if (add.length) log.push(`${r.id}: added ${add.map((f) => f.text).join(", ")}.`);
        break;
      }
      case "remove_favorites": {
        const drop = new Set(e.favorites.map((f) => f.text.toLowerCase()));
        const before = r.favorites.length;
        r.favorites = r.favorites.filter((f) => !drop.has(f.text.toLowerCase()));
        if (r.favorites.length < before) log.push(`${r.id}: removed ${before - r.favorites.length} favorite(s).`);
        break;
      }
      case "set_unavailable": {
        if (e.days?.length) r.unavailableDays = [...new Set([...(r.unavailableDays ?? []), ...(e.days as Day[])])];
        if (e.times?.length) r.unavailableTimes = [...new Set([...(r.unavailableTimes ?? []), ...(e.times as TimeOfDay[])])];
        log.push(`${r.id}: unavailable ${[...(e.days ?? []), ...(e.times ?? [])].join(", ")}.`);
        break;
      }
      case "opt_out": {
        if (e.session_types?.length) {
          r.optOut = [...new Set([...(r.optOut ?? []), ...(e.session_types as Domain[])])];
          log.push(`${r.id}: opted out of ${e.session_types.join(", ")}.`);
        }
        break;
      }
    }
  }
  return { request: { ...req, residents }, log };
}
