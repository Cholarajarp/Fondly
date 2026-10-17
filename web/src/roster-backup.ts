// Roster backup: export to and import from JSON or CSV files. Pure functions only (no DOM), so
// they are unit tested in tests/roster-backup.test.ts. The roster otherwise lives only in this
// browser's localStorage, so a backup file is the only way to survive a cleared browser.
//
// Resident objects are handled generically: fields this module does not know about (for example a
// newer optional field) are kept as-is in JSON, and written as extra columns in CSV.
import { z } from "zod";
import { DAYS, DOMAINS, FAVORITE_KINDS, TIMES, type Favorite, type FavoriteKind, type SlotInput } from "../../shared/types";
import { nextResidentId, validBirthYear, type Roster, type RosterResident } from "./roster";

export const BACKUP_FORMAT = "fondly-roster";
export const BACKUP_VERSION = 1;
export const MAX_RESIDENTS = 60;
const MAX_SLOTS = 21;
/** Backup files larger than this are rejected before parsing. */
export const MAX_BACKUP_BYTES = 2 * 1024 * 1024;

// Same bounds the server enforces on plan requests (server/agent/run.ts), so an imported roster
// can always be planned.
const RESIDENT_ID = /^r\d{1,3}$/;
const entityId = z.string().regex(/^[A-Za-z0-9_:-]{1,100}$/, "Expected a Qloo entity id");
const FavoriteZ = z.object({ kind: z.enum(FAVORITE_KINDS as [FavoriteKind, ...FavoriteKind[]]), text: z.string().trim().min(1).max(120) });

// Same range the server and editor enforce (see validBirthYear in roster.ts).
const BirthYearZ = z.number().refine(validBirthYear, "Birth years must be whole years from 1915 to 1975");

const ResidentZ = z.looseObject({
  id: z.string().regex(RESIDENT_ID, "Resident ids must look like r1, r2…"),
  name: z.string().trim().max(60).default(""),
  favorites: z.array(FavoriteZ).max(20).default([]),
  unavailableDays: z.array(z.enum(DAYS)).max(7).default([]),
  unavailableTimes: z.array(z.enum(TIMES)).max(3).default([]),
  optOut: z.array(z.enum(DOMAINS as [string, ...string[]])).max(DOMAINS.length).default([]),
  loved: z.array(entityId).max(40).default([]),
  declined: z.array(entityId).max(40).default([]),
  birthYear: BirthYearZ.optional(),
});

const SlotZ = z.object({
  id: z.string().regex(/^s\d{1,3}$/),
  day: z.enum(DAYS),
  time: z.enum(TIMES),
  domain: z.enum(DOMAINS as [string, ...string[]]),
});

const residentsZ = z
  .array(ResidentZ)
  .max(MAX_RESIDENTS, `At most ${MAX_RESIDENTS} residents`)
  .refine((rs) => new Set(rs.map((r) => r.id)).size === rs.length, "Resident ids must be unique");

const BackupZ = z.object({
  format: z.literal(BACKUP_FORMAT),
  version: z.number().int().min(1).max(BACKUP_VERSION),
  roster: z.object({
    homeName: z.string().trim().max(80).default(""),
    homeCity: z.string().trim().max(100).default(""),
    defaultBirthYear: BirthYearZ.optional(),
    residents: residentsZ,
    slots: z
      .array(SlotZ)
      .max(MAX_SLOTS, `At most ${MAX_SLOTS} sessions per week`)
      .refine((ss) => new Set(ss.map((s) => s.id)).size === ss.length, "Session ids must be unique")
      .refine((ss) => new Set(ss.map((s) => `${s.day}-${s.time}`)).size === ss.length, "Only one session per day and time")
      .optional(),
  }),
});

/** What an import produces: residents always; home details and week only from JSON backups. */
export interface ImportedRoster {
  kind: "json" | "csv";
  residents: RosterResident[];
  homeName?: string;
  homeCity?: string;
  defaultBirthYear?: number;
  slots?: SlotInput[];
}

export class BackupError extends Error {}

const issueText = (err: z.ZodError) => {
  const i = err.issues[0];
  if (!i) return "The file is not a valid roster.";
  const where = formatPath(i.path);
  return `${where ? `${where}: ` : ""}${i.message}`;
};

function formatPath(path: PropertyKey[]): string {
  // roster.residents.2.favorites.0.text -> "Resident 3, favorites 1, text"
  const parts: string[] = [];
  for (let k = 0; k < path.length; k++) {
    const p = path[k];
    if (p === "roster") continue;
    const next = path[k + 1];
    if ((p === "residents" || p === "slots" || p === "favorites") && typeof next === "number") {
      parts.push(`${p === "residents" ? "Resident" : p === "slots" ? "Session" : "favorite"} ${next + 1}`);
      k++;
    } else parts.push(String(p));
  }
  return parts.join(", ");
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

/** Full backup: home details, every resident (all fields, including ones added later) and the week. */
export function rosterToJson(r: Roster, now = new Date()): string {
  return JSON.stringify(
    {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: now.toISOString(),
      roster: {
        homeName: r.homeName,
        homeCity: r.homeCity,
        ...(r.defaultBirthYear !== undefined ? { defaultBirthYear: r.defaultBirthYear } : {}),
        residents: r.residents,
        slots: r.slots,
      },
    },
    null,
    2,
  );
}

export function parseJsonBackup(text: string): ImportedRoster {
  let raw: unknown;
  try {
    raw = JSON.parse(stripBom(text));
  } catch {
    throw new BackupError("This file is not valid JSON.");
  }
  if (!raw || typeof raw !== "object" || (raw as { format?: unknown }).format !== BACKUP_FORMAT) {
    throw new BackupError("This JSON file is not a Fondly roster backup.");
  }
  if (typeof (raw as { version?: unknown }).version === "number" && (raw as { version: number }).version > BACKUP_VERSION) {
    throw new BackupError("This backup was made by a newer version of Fondly.");
  }
  const parsed = BackupZ.safeParse(raw);
  if (!parsed.success) throw new BackupError(issueText(parsed.error));
  const { homeName, homeCity, defaultBirthYear, residents, slots } = parsed.data.roster;
  return {
    kind: "json",
    residents: residents as RosterResident[],
    homeName,
    homeCity,
    ...(defaultBirthYear !== undefined ? { defaultBirthYear } : {}),
    ...(slots ? { slots: slots as SlotInput[] } : {}),
  };
}

// ---------------------------------------------------------------------------
// CSV (residents only)
// ---------------------------------------------------------------------------

const LIST_COLUMNS = ["unavailableDays", "unavailableTimes", "optOut", "loved", "declined"] as const;
/** Fixed columns, in order. Favorites get one column per kind. Unknown resident fields follow. */
export const CSV_COLUMNS = ["id", "name", ...FAVORITE_KINDS, ...LIST_COLUMNS] as const;
const KNOWN_KEYS = new Set<string>(["id", "name", "favorites", ...LIST_COLUMNS]);
const LIST_SEP = ";";
/** Never copied from a CSV header onto a resident object. */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Joins list items with ";", escaping literal ";" and "\" so any text survives the round trip. */
const joinList = (items: string[]) => items.map((s) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;")).join(`${LIST_SEP} `);

function splitList(cell: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < cell.length; i++) {
    const c = cell[i]!;
    if (c === "\\" && i + 1 < cell.length) cur += cell[++i];
    else if (c === LIST_SEP) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

// Spreadsheet apps run cells that start with these as formulas; a leading ' keeps them as text.
const FORMULA_START = /^[=+\-@\t\r]/;

function csvCell(v: string): string {
  const safe = FORMULA_START.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(safe) || safe !== safe.trim() ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function extraToCell(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

/** Best-effort reading of a column this module doesn't know: numbers, booleans and JSON come back typed. */
function cellToExtra(cell: string): unknown {
  if (/^-?\d+(\.\d+)?$/.test(cell)) return Number(cell);
  if (cell === "true" || cell === "false") return cell === "true";
  if (/^[[{]/.test(cell)) {
    try {
      return JSON.parse(cell);
    } catch {
      // Not JSON after all: keep the text.
    }
  }
  return cell;
}

/** One row per resident. Home details and the week are not included (use JSON for a full backup). */
export function rosterToCsv(r: Roster): string {
  const extras: string[] = [];
  for (const res of r.residents) {
    for (const k of Object.keys(res)) if (!KNOWN_KEYS.has(k) && !extras.includes(k)) extras.push(k);
  }
  const header = [...CSV_COLUMNS, ...extras];
  const rows = r.residents.map((res) => {
    const rec = res as unknown as Record<string, unknown>;
    return [
      res.id,
      res.name,
      ...FAVORITE_KINDS.map((k) => joinList(res.favorites.filter((f) => f.kind === k).map((f) => f.text))),
      ...LIST_COLUMNS.map((k) => joinList((res[k] as string[] | undefined) ?? [])),
      ...extras.map((k) => extraToCell(rec[k])),
    ];
  });
  // BOM so Excel opens the file as UTF-8; CRLF line endings per RFC 4180.
  return "\uFEFF" + [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

/** RFC 4180 parser: quoted fields, doubled quotes, commas and newlines inside quotes, CRLF or LF. */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const s = stripBom(text);
  while (i < s.length) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else field += c;
      i++;
      continue;
    }
    if (c === '"' && field === "") quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      if (c === "\r" && s[i + 1] === "\n") i++;
    } else field += c;
    i++;
  }
  if (quoted) throw new BackupError("The CSV file has an unclosed quote.");
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

const normHeader = (h: string) => h.trim().toLowerCase().replace(/[\s_-]+/g, "");
const unformula = (cell: string) => (/^'[=+\-@\t\r]/.test(cell) ? cell.slice(1) : cell);

export function parseCsvBackup(text: string): ImportedRoster {
  const rows = parseCsvRows(text);
  if (rows.length === 0) throw new BackupError("The CSV file is empty.");
  const header = rows[0]!.map((h) => h.trim());
  const known = new Map<string, string>(CSV_COLUMNS.map((c) => [normHeader(c), c]));
  // Friendlier header names people may type in a spreadsheet.
  for (const [alias, col] of [["book", "books"], ["game", "gaming"], ["sport", "sports"], ["alias", "id"]] as const) known.set(alias, col);
  const cols = header.map((h) => known.get(normHeader(h)) ?? h);
  if (!cols.includes("name")) throw new BackupError('The CSV file needs a "name" column.');
  if (new Set(cols.filter(Boolean)).size !== cols.filter(Boolean).length) throw new BackupError("The CSV file has the same column twice.");
  const body = rows.slice(1);
  if (body.length > MAX_RESIDENTS) throw new BackupError(`At most ${MAX_RESIDENTS} residents (the file has ${body.length}).`);

  const residents: Record<string, unknown>[] = [];
  body.forEach((cells, n) => {
    const get = (col: string) => {
      const i = cols.indexOf(col);
      return i >= 0 ? unformula((cells[i] ?? "").trim()) : "";
    };
    const favorites: Favorite[] = [];
    for (const k of FAVORITE_KINDS) for (const t of splitList(get(k))) favorites.push({ kind: k, text: t });
    const rec: Record<string, unknown> = { id: get("id"), name: get("name"), favorites };
    for (const k of LIST_COLUMNS) rec[k] = splitList(get(k));
    cols.forEach((c, i) => {
      if (!c || CSV_COLUMNS.includes(c as (typeof CSV_COLUMNS)[number]) || KNOWN_KEYS.has(c) || UNSAFE_KEYS.has(c)) return;
      const v = unformula((cells[i] ?? "").trim());
      if (v !== "") rec[c] = cellToExtra(v);
    });
    if (!rec.name) throw new BackupError(`Row ${n + 2}: every resident needs a name.`);
    residents.push(rec);
  });

  // Rows without an id get the next free alias.
  let max = residents.reduce((m, r) => Math.max(m, RESIDENT_ID.test(String(r.id)) ? Number(String(r.id).slice(1)) : 0), 0);
  for (const r of residents) if (!r.id) r.id = `r${++max}`;

  const parsed = residentsZ.safeParse(residents);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    const row = typeof i?.path[0] === "number" ? `Row ${i.path[0] + 2}` : "";
    const field = i?.path.slice(1).filter((p) => typeof p !== "number").join(".");
    throw new BackupError(`${[row, field].filter(Boolean).join(", ")}${row || field ? ": " : ""}${i?.message ?? "Invalid roster."}`);
  }
  return { kind: "csv", residents: parsed.data as RosterResident[] };
}

// ---------------------------------------------------------------------------
// Files and applying an import
// ---------------------------------------------------------------------------

/** Picks the parser from the file name (or content when the extension is unknown). */
export function parseBackupFile(name: string, text: string): ImportedRoster {
  const lower = name.toLowerCase();
  if (lower.endsWith(".json")) return parseJsonBackup(text);
  if (lower.endsWith(".csv")) return parseCsvBackup(text);
  const t = stripBom(text).trimStart();
  if (t.startsWith("{")) return parseJsonBackup(text);
  if (t) return parseCsvBackup(text);
  throw new BackupError("Choose a .json or .csv roster file.");
}

/**
 * Replace: the file becomes the roster. The roster id and plan history stay, so family links and
 * the browser's mapping of plans to names keep working; the last plan is dropped because it was
 * for different residents. CSV files carry residents only, so home details and the week stay.
 */
export function replaceRoster(r: Roster, imp: ImportedRoster): Roster {
  return {
    ...r,
    lastPlanId: undefined,
    residents: imp.residents,
    ...(imp.homeName !== undefined ? { homeName: imp.homeName } : {}),
    ...(imp.homeCity !== undefined ? { homeCity: imp.homeCity } : {}),
    ...(imp.kind === "json" ? { defaultBirthYear: imp.defaultBirthYear } : {}),
    ...(imp.slots ? { slots: imp.slots } : {}),
  };
}

const nameKey = (name: string) => name.trim().toLowerCase();

/**
 * Merge by name: a resident whose name matches (ignoring case) is updated from the file and keeps
 * their current alias; new names are added with new aliases; everyone else is left alone. Home
 * details are filled in only where blank, and the current week is kept.
 */
export function mergeRoster(r: Roster, imp: ImportedRoster): { roster: Roster; updated: number; added: number } {
  const residents = [...r.residents];
  const index = new Map<string, number>();
  residents.forEach((x, i) => {
    const k = nameKey(x.name);
    if (k && !index.has(k)) index.set(k, i);
  });
  let updated = 0;
  let added = 0;
  for (const inc of imp.residents) {
    const k = nameKey(inc.name);
    const at = k ? index.get(k) : undefined;
    if (at !== undefined) {
      residents[at] = { ...residents[at]!, ...inc, id: residents[at]!.id };
      updated++;
    } else {
      if (residents.length >= MAX_RESIDENTS) throw new BackupError(`Merging would go over ${MAX_RESIDENTS} residents. Try replace instead.`);
      const id = nextResidentId({ ...r, residents });
      residents.push({ ...inc, id });
      if (k) index.set(k, residents.length - 1);
      added++;
    }
  }
  return {
    roster: {
      ...r,
      residents,
      homeName: r.homeName.trim() ? r.homeName : (imp.homeName ?? r.homeName),
      homeCity: r.homeCity.trim() ? r.homeCity : (imp.homeCity ?? r.homeCity),
      ...(r.defaultBirthYear === undefined && imp.defaultBirthYear !== undefined ? { defaultBirthYear: imp.defaultBirthYear } : {}),
    },
    updated,
    added,
  };
}

/** Residents whose alias would point at a different person after a replace (their family links must go). */
export function aliasesChangedByReplace(r: Roster, imp: ImportedRoster): string[] {
  const next = new Map(imp.residents.map((x) => [x.id, nameKey(x.name)]));
  return r.residents.filter((x) => next.get(x.id) !== nameKey(x.name)).map((x) => x.id);
}

/** `fondly-roster-maple-grove-house-2026-10-16.json` */
export function backupFileName(r: Roster, ext: "json" | "csv", now = new Date()): string {
  const slug = r.homeName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  const d = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return `fondly-roster${slug ? `-${slug}` : ""}-${d}.${ext}`;
}

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}
