// RFC 5545 calendar export for a week plan. Runs in the browser; dependency-free so it is testable
// under Node.
//
// Plans store a weekday and a part of day (morning/afternoon/evening), not concrete dates or clock
// times. The export therefore places the week on the upcoming Monday-to-Sunday (the next Monday
// strictly after today, in the browser's local time) and uses the slot times below. Events are
// "floating" local times (no TZID, no Z), so they stay at e.g. 2:00 pm in whatever time zone the
// calendar app uses, which is what a care home wants.
import { DAYS, TIMES, type Day, type ScheduledSession, type TimeOfDay } from "./types.ts";

/** Default clock times for each part of the day, local time, [hour, minute]. One-hour sessions. */
export const SLOT_TIMES: Record<TimeOfDay, { start: [number, number]; end: [number, number]; label: string }> = {
  morning: { start: [10, 0], end: [11, 0], label: "10:00 am" },
  afternoon: { start: [14, 0], end: [15, 0], label: "2:00 pm" },
  evening: { start: [18, 30], end: [19, 30], label: "6:30 pm" },
};

/** The Monday after `from` (never `from` itself), at local midnight. */
export function nextMonday(from: Date = new Date()): Date {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const daysUntil = ((8 - d.getDay()) % 7) || 7; // getDay: 0 = Sunday, 1 = Monday
  d.setDate(d.getDate() + daysUntil);
  return d;
}

/** Local calendar date for a weekday of the week starting `monday`. */
export function dateForDay(monday: Date, day: Day): Date {
  const d = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate());
  d.setDate(d.getDate() + DAYS.indexOf(day));
  return d;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
const localStamp = (d: Date, [h, m]: [number, number]) => `${pad(d.getFullYear(), 4)}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(h)}${pad(m)}00`;
const utcStamp = (d: Date) =>
  `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;

/** Escapes a TEXT value (RFC 5545 3.3.11): backslash, semicolon, comma and newlines. */
export function escapeText(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

const utf8Len = (s: string) => new TextEncoder().encode(s).length;

/**
 * Folds a content line at 75 octets (RFC 5545 3.1): continuation lines start with one space.
 * Splits on code-point boundaries so multi-byte UTF-8 characters are never cut.
 */
export function foldLine(line: string): string {
  if (utf8Len(line) <= 75) return line;
  const out: string[] = [];
  let cur = "";
  let curLen = 0;
  let limit = 75;
  for (const ch of line) {
    const n = utf8Len(ch);
    if (curLen + n > limit) {
      out.push(cur);
      cur = "";
      curLen = 0;
      limit = 74; // the leading space of a continuation line counts toward its 75 octets
    }
    cur += ch;
    curLen += n;
  }
  out.push(cur);
  return out.join("\r\n ");
}

export interface IcsOptions {
  /** Plan id, used to build stable UIDs. */
  planId: string;
  homeName?: string;
  /** Monday of the week to place sessions in. Defaults to nextMonday(now). */
  weekStart?: Date;
  /** DTSTAMP. Defaults to now. */
  now?: Date;
  /** Default SLOT_TIMES. */
  times?: typeof SLOT_TIMES;
}

/** One line of description for a session: what it is, never who it is for. */
export function sessionLine(s: Pick<ScheduledSession, "entity" | "domain" | "related">): string {
  const p = s.entity.properties;
  const year = p?.release_year ? ` (${p.release_year})` : "";
  if (s.domain === "outing") return p?.address ? `Outing to ${s.entity.name}, ${p.address}` : `Outing to ${s.entity.name}`;
  const kind: Record<string, string> = { music: "Music", film: "Film", tv: "TV", books: "Reading", gaming: "Games", sports: "Sports" };
  return `${kind[s.domain] ?? "Session"}: ${s.entity.name}${year}`;
}

/** Builds a VCALENDAR with one VEVENT per session. Lines end in CRLF and are folded at 75 octets. */
export function buildIcs(sessions: Pick<ScheduledSession, "slotId" | "day" | "time" | "domain" | "title" | "entity" | "related">[], opts: IcsOptions): string {
  const monday = opts.weekStart ?? nextMonday(opts.now ?? new Date());
  const times = opts.times ?? SLOT_TIMES;
  const stamp = utcStamp(opts.now ?? new Date());
  const weekKey = localStamp(monday, [0, 0]).slice(0, 8);
  const calName = opts.homeName ? `Fondly activities · ${opts.homeName}` : "Fondly activities";
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Fondly//Weekly activity plan//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(calName)}`,
  ];
  const rank = (s: { day: Day; time: TimeOfDay }) => DAYS.indexOf(s.day) * 3 + TIMES.indexOf(s.time);
  const ordered = [...sessions].sort((a, b) => rank(a) - rank(b));
  for (const s of ordered) {
    const date = dateForDay(monday, s.day);
    const t = times[s.time];
    const uidSafe = (x: string) => x.replace(/[^A-Za-z0-9-]/g, "");
    const description = [sessionLine(s), s.related.length ? `Related picks from Qloo: ${s.related.slice(0, 5).map((r) => r.name).join(", ")}` : "", "Planned with Fondly."]
      .filter(Boolean)
      .join("\n");
    lines.push(
      "BEGIN:VEVENT",
      `UID:${uidSafe(opts.planId)}-${uidSafe(s.slotId)}-${weekKey}@fondly`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${localStamp(date, t.start)}`,
      `DTEND:${localStamp(date, t.end)}`,
      `SUMMARY:${escapeText(s.title || s.entity.name)}`,
      `DESCRIPTION:${escapeText(description)}`,
      ...(s.domain === "outing" && s.entity.properties?.address ? [`LOCATION:${escapeText(s.entity.properties.address)}`] : []),
      `CATEGORIES:${escapeText(s.domain)}`,
      "TRANSP:OPAQUE",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}
