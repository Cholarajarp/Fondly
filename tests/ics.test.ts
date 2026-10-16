import { describe, expect, it } from "vitest";
import { buildIcs, dateForDay, escapeText, foldLine, nextMonday } from "../shared/ics.ts";
import type { ScheduledSession } from "../shared/types.ts";

const session = (over: Partial<ScheduledSession>): ScheduledSession => ({
  slotId: "s1",
  day: "Mon",
  time: "afternoon",
  domain: "music",
  entity: { entity_id: "E1", name: "Patsy Cline" },
  source: "group",
  related: [],
  attendees: ["r1"],
  matches: [],
  meanFit: 1,
  title: "Sing-along: Patsy Cline",
  brief: "",
  ...over,
});

const utf8 = (s: string) => new TextEncoder().encode(s).length;

/** Minimal RFC 5545 reader: unfold, then split into properties. */
function unfold(ics: string): string[] {
  return ics.replace(/\r\n[ \t]/g, "").split("\r\n").filter(Boolean);
}

describe("ics text helpers", () => {
  it("escapes backslash, semicolon, comma and newlines", () => {
    expect(escapeText("a\\b;c,d\ne\r\nf")).toBe("a\\\\b\\;c\\,d\\ne\\nf");
    expect(escapeText("bell\u0007")).toBe("bell");
  });

  it("folds at 75 octets without splitting multi-byte characters", () => {
    const long = `SUMMARY:${"é".repeat(60)}${"x".repeat(40)}`;
    const folded = foldLine(long);
    const parts = folded.split("\r\n");
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(utf8(p)).toBeLessThanOrEqual(75);
    for (const p of parts.slice(1)) expect(p.startsWith(" ")).toBe(true);
    expect(folded.replace(/\r\n /g, "")).toBe(long);
    expect(foldLine("SHORT:x")).toBe("SHORT:x");
  });
});

describe("week dates", () => {
  it("next Monday is strictly after today", () => {
    expect(nextMonday(new Date(2026, 9, 16)).toDateString()).toBe(new Date(2026, 9, 19).toDateString()); // Fri -> Mon
    expect(nextMonday(new Date(2026, 9, 19, 9)).toDateString()).toBe(new Date(2026, 9, 26).toDateString()); // Mon -> next Mon
    expect(nextMonday(new Date(2026, 9, 25)).toDateString()).toBe(new Date(2026, 9, 26).toDateString()); // Sun -> Mon
    expect(dateForDay(new Date(2026, 9, 26), "Sun").toDateString()).toBe(new Date(2026, 10, 1).toDateString()); // month rollover
  });
});

describe("buildIcs", () => {
  const sessions = [
    session({ slotId: "s2", day: "Wed", time: "morning", domain: "books", title: "Mystery morning, with tea; biscuits", entity: { entity_id: "B1", name: "Murder on the Orient Express" } }),
    session({}),
    session({
      slotId: "s3",
      day: "Sat",
      time: "evening",
      domain: "outing",
      title: "Trip to the conservatory",
      entity: { entity_id: "P1", name: "Garfield Park Conservatory", properties: { address: "300 N Central Park Ave, Chicago, IL 60624" } },
    }),
  ];
  const ics = buildIcs(sessions, { planId: "0b9f0f8e-1d2c-4c3b-9a8e-7f6e5d4c3b2a", homeName: "Maple Grove", weekStart: new Date(2026, 9, 19), now: new Date(Date.UTC(2026, 9, 16, 12, 0, 0)) });

  it("uses CRLF everywhere and folds every line", () => {
    expect(ics.endsWith("\r\n")).toBe(true);
    expect(ics.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    for (const line of ics.split("\r\n")) expect(utf8(line)).toBeLessThanOrEqual(75);
  });

  it("has a valid structure with one VEVENT per session", () => {
    const lines = unfold(ics);
    expect(lines[0]).toBe("BEGIN:VCALENDAR");
    expect(lines.at(-1)).toBe("END:VCALENDAR");
    expect(lines).toContain("VERSION:2.0");
    expect(lines.some((l) => l.startsWith("PRODID:"))).toBe(true);
    expect(lines.filter((l) => l === "BEGIN:VEVENT")).toHaveLength(3);
    expect(lines.filter((l) => l === "END:VEVENT")).toHaveLength(3);
    const uids = lines.filter((l) => l.startsWith("UID:"));
    expect(new Set(uids).size).toBe(3);
    for (const l of lines) expect(l).toMatch(/^[A-Z-]+[:;]/);
    expect(lines.filter((l) => l.startsWith("DTSTAMP:")).every((l) => l === "DTSTAMP:20261016T120000Z")).toBe(true);
  });

  it("orders events and maps day/slot to the planned week", () => {
    const starts = unfold(ics).filter((l) => l.startsWith("DTSTART"));
    expect(starts).toEqual(["DTSTART:20261019T140000", "DTSTART:20261021T100000", "DTSTART:20261024T183000"]);
    expect(unfold(ics).filter((l) => l.startsWith("DTEND"))).toEqual(["DTEND:20261019T150000", "DTEND:20261021T110000", "DTEND:20261024T193000"]);
  });

  it("escapes text fields and adds a location for outings only", () => {
    const lines = unfold(ics);
    expect(lines).toContain("SUMMARY:Mystery morning\\, with tea\\; biscuits");
    expect(lines).toContain("LOCATION:300 N Central Park Ave\\, Chicago\\, IL 60624");
    expect(lines.filter((l) => l.startsWith("LOCATION:"))).toHaveLength(1);
    expect(lines.some((l) => l.startsWith("DESCRIPTION:") && l.includes("\\n"))).toBe(true);
  });

  it("never includes resident ids", () => {
    expect(ics).not.toMatch(/\br1\b/);
  });
});
