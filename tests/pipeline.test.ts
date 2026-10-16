import { describe, expect, it } from "vitest";
import { slimEntity } from "../server/engine/pipeline.ts";

describe("slimEntity", () => {
  it("caps tags and drops explainability so saved plans stay small", () => {
    const tags = Array.from({ length: 250 }, (_, i) => ({ id: `urn:tag:${i}`, name: `t${i}` }));
    const out = slimEntity({
      entity_id: "e1",
      name: "Casablanca",
      properties: { short_description: "1942 film" },
      tags,
      explainability: [{ entity_id: "x", score: 0.5 }],
    });
    expect(out.tags).toHaveLength(8);
    expect(out.tags?.[0].name).toBe("t0");
    expect(out.explainability).toBeUndefined();
    expect(out.properties?.short_description).toBe("1942 film");
  });

  it("leaves tagless entities alone", () => {
    expect(slimEntity({ entity_id: "e2", name: "X" })).toEqual({ entity_id: "e2", name: "X" });
  });
});
