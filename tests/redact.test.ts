import { describe, expect, it } from "vitest";
import { WEEK_PRESETS, redactIntake, redactNames, sampleRoster, type RosterResident } from "../web/src/roster.ts";
import { DOMAINS } from "../shared/types.ts";

const res = (id: string, name: string) =>
  ({ id, name, favorites: [], unavailableDays: [], unavailableTimes: [], optOut: [], loved: [], declined: [] }) as RosterResident;

const dot = res("r1", "Dorothy Hale");
const walt = res("r2", "Walter Price");
const all = [dot, walt];

describe("name redaction", () => {
  it("removes every part of the resident's own name from intake notes", () => {
    const out = redactIntake("Dorothy loves Sinatra. Mrs Hale grew up in Chicago. dorothy hale hums Patsy Cline.", dot, all);
    expect(out).not.toMatch(/dorothy|hale/i);
    expect(out).toContain("the resident loves Sinatra");
  });

  it("replaces other residents' names with their aliases", () => {
    const out = redactIntake("Dorothy and Walter watch M*A*S*H together.", dot, all);
    expect(out).toBe("the resident and r2 watch M*A*S*H together.");
  });

  it("only matches whole words", () => {
    expect(redactNames("Walterville is nice", all)).toBe("Walterville is nice");
  });
});

describe("week presets", () => {
  it("builds valid, unique slots for every preset", () => {
    for (const p of WEEK_PRESETS) {
      const slots = p.build();
      expect(slots.length).toBeLessThanOrEqual(21);
      expect(new Set(slots.map((s) => s.id)).size).toBe(slots.length);
      expect(new Set(slots.map((s) => `${s.day}-${s.time}`)).size).toBe(slots.length);
      for (const s of slots) expect(DOMAINS).toContain(s.domain);
    }
  });

  it("sample home exercises gaming and sports", () => {
    const r = sampleRoster();
    const kinds = new Set(r.slots.map((s) => s.domain));
    expect(kinds.has("gaming") && kinds.has("sports")).toBe(true);
    const favs = new Set(r.residents.flatMap((x) => x.favorites.map((f) => f.kind)));
    expect(favs.has("gaming") && favs.has("sports")).toBe(true);
  });
});
