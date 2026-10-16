import { describe, it, expect } from "vitest";
import { ALLOWED_PARAMS, toQuery, validateInsightsParams } from "../server/qloo/params.ts";
import { QlooError } from "../shared/types.ts";

function errorOf(fn: () => unknown): QlooError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(QlooError);
    return e as QlooError;
  }
  throw new Error("expected function to throw");
}

describe("validateInsightsParams", () => {
  it("has an allowlist for all 12 insight types", () => {
    expect(Object.keys(ALLOWED_PARAMS)).toHaveLength(12);
  });

  it("rejects filter.release_year.min on artist", () => {
    const e = errorOf(() =>
      validateInsightsParams({ "filter.type": "urn:entity:artist", "filter.release_year.min": 2000 }),
    );
    expect(e.status).toBe(0);
    expect(e.message).toContain("filter.release_year.min");
    expect(e.message).toContain("urn:entity:artist");
  });

  it("accepts filter.release_year.min on movie", () => {
    expect(
      validateInsightsParams({ "filter.type": "urn:entity:movie", "filter.release_year.min": 2000, take: 10 }),
    ).toBe("urn:entity:movie");
  });

  it("rejects filter.location.query on artist but accepts it on place", () => {
    expect(() =>
      validateInsightsParams({ "filter.type": "urn:entity:artist", "filter.location.query": "Austin" }),
    ).toThrow(/filter\.location\.query/);
    expect(() =>
      validateInsightsParams({ "filter.type": "urn:entity:place", "filter.location.query": "Austin" }),
    ).not.toThrow();
  });

  it("lists every bad param", () => {
    const e = errorOf(() =>
      validateInsightsParams({ "filter.type": "urn:demographics", "filter.tags": "x", bogus: 1 }),
    );
    expect(e.message).toContain("filter.tags");
    expect(e.message).toContain("bogus");
  });

  it("rejects bad age values and accepts valid ones", () => {
    expect(() =>
      validateInsightsParams({ "filter.type": "urn:entity:artist", "signal.demographics.age": "18_to_24" }),
    ).toThrow(/18_to_24/);
    expect(() =>
      validateInsightsParams({
        "filter.type": "urn:entity:artist",
        "signal.demographics.age": "35_and_younger,36_to_55",
      }),
    ).not.toThrow();
  });

  it("enforces take 1..50", () => {
    expect(() => validateInsightsParams({ "filter.type": "urn:entity:artist", take: 51 })).toThrow(/take/);
    expect(() => validateInsightsParams({ "filter.type": "urn:entity:artist", take: 0 })).toThrow(/take/);
    expect(() => validateInsightsParams({ "filter.type": "urn:entity:artist", take: 50 })).not.toThrow();
  });

  it("requires filter.type and rejects unknown types", () => {
    expect(() => validateInsightsParams({ take: 5 })).toThrow(/filter\.type is required/);
    expect(() => validateInsightsParams({ "filter.type": "urn:entity:recipe" })).toThrow(/unsupported filter\.type/);
  });
});

describe("toQuery", () => {
  it("sorts keys and stringifies values", () => {
    expect(toQuery({ take: 5, "filter.type": "urn:entity:artist", "feature.explainability": true }).toString()).toBe(
      "feature.explainability=true&filter.type=urn%3Aentity%3Aartist&take=5",
    );
  });
});
