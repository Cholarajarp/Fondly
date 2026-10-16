import { describe, expect, it } from "vitest";
import {
  DOMAIN_TAG,
  DOMAIN_TYPE,
  baselineParams,
  recommendParams,
  resolveEntity,
  scoreParams,
  suitableForGroup,
} from "../server/engine/qloo-ops.ts";
import { validateInsightsParams } from "../server/qloo/params.ts";
import { namesEntity } from "../server/engine/pipeline.ts";
import { DOMAINS, type QlooClient, type QlooEntity } from "../shared/types.ts";

const SPORTS = "urn:tag:genre:brand:sports_organization";

function fakeQloo(results: QlooEntity[]): QlooClient {
  return { searchEntities: async () => results } as unknown as QlooClient;
}

describe("session kinds", () => {
  it("maps every non-outing domain to a Qloo entity type the param allowlist accepts", () => {
    for (const d of DOMAINS) {
      if (d === "outing") continue;
      expect(DOMAIN_TYPE[d]).toMatch(/^urn:entity:/);
      expect(() => validateInsightsParams(recommendParams(d, ["e1"]))).not.toThrow();
      expect(() => validateInsightsParams(baselineParams(d))).not.toThrow();
    }
    expect(DOMAIN_TYPE.gaming).toBe("urn:entity:videogame");
  });

  it("keeps sports recommendations and baselines to sports organizations", () => {
    expect(DOMAIN_TAG.sports).toBe(SPORTS);
    expect(recommendParams("sports", ["e1"])["filter.tags"]).toBe(SPORTS);
    expect(baselineParams("sports")["filter.tags"]).toBe(SPORTS);
    // Scoring a fixed, already-filtered list needs no tag filter; other domains never get one.
    expect(scoreParams("sports", ["e1"], ["c1"])["filter.tags"]).toBeUndefined();
    expect(recommendParams("music", ["e1"])["filter.tags"]).toBeUndefined();
    // Sports favor the home's regional teams; music etc. are not location-bound.
    expect(recommendParams("sports", ["e1"], { city: "Chicago" })["signal.location.query"]).toBe("Chicago");
    expect(baselineParams("sports", "Chicago")["signal.location.query"]).toBe("Chicago");
    expect(recommendParams("music", ["e1"], { city: "Chicago" })["signal.location.query"]).toBeUndefined();
  });

  it("keeps mature-rated or gory titles out of group discovery", () => {
    const e = (props: Partial<QlooEntity>): QlooEntity => ({ entity_id: "x", name: "x", ...props });
    expect(suitableForGroup(e({ properties: { content_rating: "M" } }))).toBe(false);
    expect(suitableForGroup(e({ tags: [{ id: "urn:tag:audience:qloo:blood_soaked", name: "Blood" }] }))).toBe(false);
    expect(suitableForGroup(e({ properties: { content_rating: "E10+" } }))).toBe(true);
    expect(suitableForGroup(e({}))).toBe(true);
    const place = (id: string) => e({ tags: [{ id, name: id }] });
    expect(suitableForGroup(place("urn:tag:category:place:international_airport"))).toBe(false);
    expect(suitableForGroup(place("urn:tag:category:place:airport"))).toBe(false);
    expect(suitableForGroup(place("urn:tag:category:place:aquarium"))).toBe(true);
    expect(suitableForGroup(place("urn:tag:category:place:botanical_garden"))).toBe(true);
    // The gaming baseline asks Qloo for family-friendly titles.
    expect(baselineParams("gaming")["filter.tags"]).toBe("urn:tag:audience:qloo:family_friendly");
    expect(recommendParams("gaming", ["e1"])["filter.tags"]).toBe("urn:tag:audience:qloo:family_friendly");
    expect(suitableForGroup(e({ tags: [{ id: "urn:tag:genre:qloo:shooter", name: "Shooter" }] }))).toBe(false);
  });

  it("resolves a sports favorite only to a tagged sports brand", async () => {
    const apparel: QlooEntity = { entity_id: "b1", name: "New York Yankees", tags: [{ id: "urn:tag:genre:brand:apparel", name: "Apparel" }] };
    const team: QlooEntity = {
      entity_id: "b2",
      name: "New York Yankees Baseball",
      tags: [{ id: `${SPORTS}:baseball:mlb`, name: "Major League Baseball" }],
    };
    expect((await resolveEntity(fakeQloo([apparel, team]), "sports", "New York Yankees"))?.entity_id).toBe("b2");
    expect(await resolveEntity(fakeQloo([apparel]), "sports", "New York Yankees")).toBeUndefined();
    // Other kinds keep plain name matching.
    expect((await resolveEntity(fakeQloo([apparel]), "gaming", "New York Yankees"))?.entity_id).toBe("b1");
  });
});

describe("namesEntity", () => {
  it("accepts titles that name what is scheduled", () => {
    expect(namesEntity("Sing-along: Patsy Cline and friends", "Patsy Cline")).toBe(true);
    expect(namesEntity("Beatles sing-along", "The Beatles")).toBe(true);
    expect(namesEntity("Classic TV: Family", "Family")).toBe(true);
    expect(namesEntity("Tetris and tea", "Tetris")).toBe(true);
    expect(namesEntity("Games club: Tetris", "Tetris")).toBe(true);
  });

  it("rejects titles where a generic name is folded into prose or missing", () => {
    expect(namesEntity("TV Classics: Family Favorites", "Family")).toBe(false);
    expect(namesEntity("Film afternoon: a classic", "Casablanca")).toBe(false);
    expect(namesEntity("Patsy Clineish tunes", "Patsy Cline")).toBe(false);
  });
});
