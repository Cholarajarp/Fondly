// Roster storage. Resident names live only in this browser (localStorage). The server, Qloo and
// the language model only ever see aliases (r1, r2…) and public cultural favorites.
import { useCallback, useEffect, useState } from "react";
import { BIRTH_YEAR_MAX, BIRTH_YEAR_MIN, type Day, type Domain, type Favorite, type PlanRequest, type SlotInput, type TimeOfDay } from "../../shared/types";

export interface RosterResident {
  id: string;
  name: string;
  favorites: Favorite[];
  unavailableDays: Day[];
  unavailableTimes: TimeOfDay[];
  optOut: Domain[];
  loved: string[];
  declined: string[];
  /** Optional: biases film and TV toward their teens and twenties. */
  birthYear?: number;
}

export interface Roster {
  rosterId: string;
  homeName: string;
  homeCity: string;
  /** Typical birth year at the home, for residents without their own. */
  defaultBirthYear?: number;
  residents: RosterResident[];
  slots: SlotInput[];
  /** Most recent plan for this roster. */
  lastPlanId?: string;
  planHistory: string[];
}

const KEY = "fondly.roster.v1";

export const DEFAULT_SLOTS: SlotInput[] = [
  { id: "s1", day: "Mon", time: "afternoon", domain: "music" },
  { id: "s2", day: "Tue", time: "afternoon", domain: "film" },
  { id: "s3", day: "Wed", time: "morning", domain: "books" },
  { id: "s4", day: "Wed", time: "afternoon", domain: "music" },
  { id: "s5", day: "Thu", time: "afternoon", domain: "tv" },
  { id: "s6", day: "Fri", time: "afternoon", domain: "music" },
  { id: "s7", day: "Sat", time: "afternoon", domain: "outing" },
];

export interface WeekPreset {
  id: string;
  label: string;
  description: string;
  build: () => SlotInput[];
}

const week = (cells: [Day, TimeOfDay, Domain][]): SlotInput[] =>
  cells.map(([day, time, domain], i) => ({ id: `s${i + 1}`, day, time, domain }));

/** Starting points for the week template. Staff can then change any cell. */
export const WEEK_PRESETS: WeekPreset[] = [
  { id: "classic", label: "Classic week", description: "Music, film, reading, TV and a Saturday outing", build: () => DEFAULT_SLOTS.map((s) => ({ ...s })) },
  {
    id: "active",
    label: "Active & social",
    description: "Sports socials, games club and two outings",
    build: () =>
      week([
        ["Mon", "afternoon", "sports"],
        ["Tue", "afternoon", "gaming"],
        ["Wed", "morning", "music"],
        ["Wed", "afternoon", "outing"],
        ["Thu", "afternoon", "sports"],
        ["Fri", "afternoon", "gaming"],
        ["Sat", "afternoon", "outing"],
        ["Sun", "afternoon", "film"],
      ]),
  },
  {
    id: "mixed",
    label: "Something for everyone",
    description: "One of every session type across the week",
    build: () =>
      week([
        ["Mon", "afternoon", "music"],
        ["Tue", "afternoon", "film"],
        ["Wed", "morning", "books"],
        ["Wed", "afternoon", "gaming"],
        ["Thu", "afternoon", "tv"],
        ["Fri", "afternoon", "sports"],
        ["Sat", "afternoon", "outing"],
      ]),
  },
  { id: "clear", label: "Clear week", description: "Remove every session and build your own", build: () => [] },
];

const randomId = () =>
  `roster_${Array.from(crypto.getRandomValues(new Uint8Array(9)), (b) => b.toString(16).padStart(2, "0")).join("")}`;

/** A ready-made home so first-time visitors (and judges) can plan a week in one click. Names are fictional. */
export function sampleRoster(): Roster {
  const res = (id: string, name: string, favorites: Favorite[], extra: Partial<RosterResident> = {}): RosterResident => ({
    id, name, favorites, unavailableDays: [], unavailableTimes: [], optOut: [], loved: [], declined: [], ...extra,
  });
  return {
    ...emptyRoster(),
    homeName: "Maple Grove House",
    homeCity: "Chicago",
    // Shows every session kind, including gaming and sports.
    slots: WEEK_PRESETS.find((p) => p.id === "mixed")!.build(),
    residents: [
      res("r1", "Margaret", [{ kind: "music", text: "Frank Sinatra" }, { kind: "film", text: "Casablanca" }, { kind: "food", text: "Italian" }, { kind: "gaming", text: "Tetris" }]),
      res("r2", "Harold", [{ kind: "music", text: "Johnny Cash" }, { kind: "film", text: "The Great Escape" }, { kind: "books", text: "Louis L'Amour" }, { kind: "sports", text: "Chicago Cubs" }]),
      res("r3", "Dorothy", [{ kind: "music", text: "Ella Fitzgerald" }, { kind: "books", text: "Agatha Christie" }, { kind: "tv", text: "Murder, She Wrote" }]),
      res("r4", "Walter", [{ kind: "music", text: "The Beatles" }, { kind: "tv", text: "M*A*S*H" }, { kind: "food", text: "Barbecue" }, { kind: "sports", text: "Green Bay Packers" }], { unavailableDays: ["Tue"] }),
      res("r5", "Evelyn", [{ kind: "music", text: "Patsy Cline" }, { kind: "film", text: "The Sound of Music" }, { kind: "books", text: "Jane Austen" }]),
      res("r6", "Arthur", [{ kind: "music", text: "Louis Armstrong" }, { kind: "film", text: "Singin' in the Rain" }], { unavailableTimes: ["morning"] }),
      res("r7", "Rose", [{ kind: "tv", text: "I Love Lucy" }, { kind: "music", text: "Elvis Presley" }, { kind: "food", text: "Mexican" }]),
      res("r8", "Frank", [{ kind: "books", text: "Ernest Hemingway" }, { kind: "film", text: "Rear Window" }, { kind: "gaming", text: "Pac-Man" }], { optOut: ["outing"] }),
    ],
  };
}

export function emptyRoster(): Roster {
  return { rosterId: randomId(), homeName: "", homeCity: "", residents: [], slots: DEFAULT_SLOTS, planHistory: [] };
}

function load(): Roster {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return emptyRoster();
    const r = JSON.parse(raw) as Partial<Roster>;
    if (!r || typeof r.rosterId !== "string" || !Array.isArray(r.residents)) return emptyRoster();
    return { ...emptyRoster(), ...r, planHistory: r.planHistory ?? [] } as Roster;
  } catch {
    return emptyRoster();
  }
}

export function useRoster(): [Roster, (update: (r: Roster) => Roster) => void, () => void] {
  const [roster, setRoster] = useState<Roster>(load);
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(roster));
    } catch {
      // Storage full or disabled: the roster still works for this session.
    }
  }, [roster]);
  const update = useCallback((fn: (r: Roster) => Roster) => setRoster((r) => fn(r)), []);
  const reset = useCallback(() => setRoster(emptyRoster()), []);
  return [roster, update, reset];
}

export function nextResidentId(r: Roster): string {
  const n = r.residents.reduce((m, x) => Math.max(m, Number(x.id.slice(1)) || 0), 0);
  return `r${n + 1}`;
}

export function nextSlotId(slots: SlotInput[]): string {
  const n = slots.reduce((m, x) => Math.max(m, Number(x.id.slice(1)) || 0), 0);
  return `s${n + 1}`;
}

export function newResident(r: Roster, name: string): RosterResident {
  return { id: nextResidentId(r), name, favorites: [], unavailableDays: [], unavailableTimes: [], optOut: [], loved: [], declined: [] };
}

/** The request sent to the server: no names. */
export function toRequest(r: Roster): PlanRequest {
  return {
    rosterId: r.rosterId,
    ...(r.homeName.trim() ? { homeName: r.homeName.trim() } : {}),
    homeCity: r.homeCity.trim(),
    residents: r.residents.map((x) => ({
      id: x.id,
      favorites: x.favorites,
      ...(x.unavailableDays.length ? { unavailableDays: x.unavailableDays } : {}),
      ...(x.unavailableTimes.length ? { unavailableTimes: x.unavailableTimes } : {}),
      ...(x.optOut.length ? { optOut: x.optOut } : {}),
      ...(x.loved.length ? { loved: x.loved } : {}),
      ...(x.declined.length ? { declined: x.declined } : {}),
      ...(validBirthYear(x.birthYear) ? { birthYear: x.birthYear } : {}),
    })),
    slots: r.slots,
    ...(validBirthYear(r.defaultBirthYear) ? { defaultBirthYear: r.defaultBirthYear } : {}),
  };
}

/** True for a whole year in the accepted range (the server rejects anything else). */
export const validBirthYear = (y: unknown): y is number =>
  typeof y === "number" && Number.isInteger(y) && y >= BIRTH_YEAR_MIN && y <= BIRTH_YEAR_MAX;

/** Folds a server request (after re-planning) back into the local roster, keeping names. */
export function mergeRequest(r: Roster, req: PlanRequest): Roster {
  const names = new Map(r.residents.map((x) => [x.id, x.name]));
  return {
    ...r,
    residents: req.residents.map((x) => ({
      id: x.id,
      name: names.get(x.id) ?? `New resident (${x.id})`,
      favorites: x.favorites,
      unavailableDays: x.unavailableDays ?? [],
      unavailableTimes: x.unavailableTimes ?? [],
      optOut: x.optOut ?? [],
      loved: x.loved ?? [],
      declined: x.declined ?? [],
      ...(x.birthYear !== undefined ? { birthYear: x.birthYear } : {}),
    })),
    slots: req.slots,
  };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Replaces resident names in free text with their ids before it leaves the browser.
 * Full names first, then first names that are unique on the roster.
 */
/**
 * Redacts intake notes about one resident: their full name and each part of it (first name,
 * surname) become "the resident"; other residents' names become their ids.
 */
export function redactIntake(text: string, self: RosterResident, residents: RosterResident[]): string {
  const name = self.name.trim();
  let out = text;
  if (name) {
    const parts = [name, ...name.split(/\s+/).filter((p) => p.length > 1)];
    for (const p of parts) out = out.replace(new RegExp(`\\b${escapeRe(p)}\\b`, "gi"), "the resident");
  }
  return redactNames(out, residents.filter((r) => r.id !== self.id));
}

export function redactNames(text: string, residents: RosterResident[]): string {
  let out = text;
  const full = residents.filter((r) => r.name.trim()).sort((a, b) => b.name.length - a.name.length);
  for (const r of full) out = out.replace(new RegExp(`\\b${escapeRe(r.name.trim())}\\b`, "gi"), r.id);
  const firsts = new Map<string, RosterResident[]>();
  for (const r of residents) {
    const f = r.name.trim().split(/\s+/)[0];
    if (f && f.length > 1) firsts.set(f.toLowerCase(), [...(firsts.get(f.toLowerCase()) ?? []), r]);
  }
  for (const [f, rs] of firsts) if (rs.length === 1) out = out.replace(new RegExp(`\\b${escapeRe(f)}\\b`, "gi"), rs[0]!.id);
  return out;
}

/** Display name for an id. */
export const nameOf = (r: Roster, id: string) => r.residents.find((x) => x.id === id)?.name || id;
