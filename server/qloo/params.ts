// Strict per-type parameter allowlist for Qloo /v2/insights.
// Qloo silently ignores unknown params (returning empty or misleading results),
// so we reject anything not on the list before a request is ever sent.
import { QlooError, type InsightsType } from "../../shared/types.ts";

export type InsightsParams = Record<string, string | number | boolean>;

const COMMON_ENTITY = [
  "filter.type",
  "bias.trends",
  "filter.exclude.entities",
  "filter.exclude.tags",
  "operator.exclude.tags",
  "filter.external.exists",
  "operator.filter.external.exists",
  "filter.parents.types",
  "filter.popularity.min",
  "filter.popularity.max",
  "filter.results.entities",
  "filter.results.entities.query",
  "filter.tags",
  "operator.filter.tags",
  "offset",
  "page",
  "take",
  "signal.demographics.age",
  "signal.demographics.audiences",
  "signal.demographics.audiences.weight",
  "signal.demographics.gender",
  "signal.interests.entities",
  "signal.interests.tags",
  "operator.signal.interests.tags",
  "signal.location",
  "signal.location.query",
  "signal.location.radius",
  "feature.explainability",
  "sort_by",
  "diversify.by",
  "diversify.take",
];

const MOVIE_EXTRA = [
  "filter.content_rating",
  "filter.release_year.min",
  "filter.release_year.max",
  "filter.release_country",
  "operator.filter.release_country",
  "filter.rating.min",
  "filter.rating.max",
  "filter.release_date.min",
  "filter.release_date.max",
];

const TV_EXTRA = [
  ...MOVIE_EXTRA,
  "filter.finale_year.min",
  "filter.finale_year.max",
  "filter.latest_known_year.min",
  "filter.latest_known_year.max",
];

const DESTINATION_EXTRA = [
  "filter.geocode.name",
  "filter.geocode.admin1_region",
  "filter.geocode.admin2_region",
  "filter.geocode.country_code",
  "filter.location",
  "filter.location.query",
  "filter.location.radius",
  "filter.location.geohash",
  "filter.exclude.location.geohash",
  "filter.exclude.location",
  "filter.exclude.location.query",
];

const PLACE_EXTRA = [
  ...DESTINATION_EXTRA,
  "filter.address",
  "filter.hours",
  "filter.price_level.min",
  "filter.price_level.max",
  "filter.price_range.min",
  "filter.price_range.max",
  "filter.hotel_class.min",
  "filter.hotel_class.max",
  "filter.properties.business_rating.min",
  "filter.properties.business_rating.max",
  "filter.external.tripadvisor.rating.min",
  "filter.external.tripadvisor.rating.max",
  "filter.external.tripadvisor.rating.count.min",
  "filter.external.tripadvisor.rating.count.max",
  "filter.external.resy.count.min",
  "filter.external.resy.count.max",
  "filter.external.resy.rating.min",
  "filter.external.resy.rating.max",
  "filter.external.resy.party_size.min",
  "filter.external.resy.party_size.max",
  "filter.references_brand",
  "bias.quality",
];

const set = (...lists: string[][]): ReadonlySet<string> => new Set(lists.flat());

export const ALLOWED_PARAMS: Record<InsightsType, ReadonlySet<string>> = {
  "urn:entity:artist": set(COMMON_ENTITY),
  "urn:entity:brand": set(COMMON_ENTITY),
  "urn:entity:podcast": set(COMMON_ENTITY),
  "urn:entity:videogame": set(COMMON_ENTITY),
  "urn:entity:movie": set(COMMON_ENTITY, MOVIE_EXTRA),
  "urn:entity:tv_show": set(COMMON_ENTITY, TV_EXTRA),
  "urn:entity:book": set(COMMON_ENTITY, ["filter.publication_year.min", "filter.publication_year.max"]),
  "urn:entity:person": set(COMMON_ENTITY, [
    "filter.date_of_birth.min",
    "filter.date_of_birth.max",
    "filter.date_of_death.min",
    "filter.date_of_death.max",
    "filter.gender",
  ]),
  "urn:entity:destination": set(COMMON_ENTITY, DESTINATION_EXTRA),
  "urn:entity:place": set(COMMON_ENTITY, PLACE_EXTRA),
  "urn:heatmap": set([
    "filter.type",
    "filter.location",
    "filter.location.query",
    "filter.location.radius",
    "heatmap.dimensions",
    "filter.dimensions.hotel_class",
    "filter.dimensions.price_level",
    "output.heatmap.boundary",
    "signal.demographics.age",
    "signal.demographics.audiences",
    "signal.demographics.gender",
    "signal.interests.entities",
    "signal.interests.tags",
    "take",
  ]),
  "urn:demographics": set(["filter.type", "signal.interests.entities", "signal.interests.tags", "take"]),
};

// Qloo documents two bucket sets (insights signals and demographics output); both are accepted.
export const VALID_AGE_VALUES: ReadonlySet<string> = new Set([
  "24_and_younger",
  "25_to_29",
  "30_to_34",
  "35_to_44",
  "45_to_54",
  "35_and_younger",
  "36_to_55",
  "55_and_older",
]);

export const MAX_TAKE = 50;

function fail(message: string): never {
  throw new QlooError(message, 0, "/v2/insights");
}

/** Throws QlooError (status 0) if params are not valid for their filter.type. */
export function validateInsightsParams(params: InsightsParams): InsightsType {
  const type = params["filter.type"];
  if (typeof type !== "string" || type.trim() === "") {
    fail("Qloo insights params: filter.type is required");
  }
  const allowed = ALLOWED_PARAMS[type as InsightsType];
  if (!allowed) {
    fail(
      `Qloo insights params: unsupported filter.type "${type}". Supported: ${Object.keys(ALLOWED_PARAMS).join(", ")}`,
    );
  }

  const bad = Object.keys(params).filter((k) => !allowed.has(k));
  if (bad.length > 0) {
    fail(`Qloo insights params not allowed for filter.type=${type}: ${bad.join(", ")}`);
  }

  if (params.take !== undefined) {
    const take = Number(params.take);
    if (!Number.isInteger(take) || take < 1 || take > MAX_TAKE) {
      fail(`Qloo insights params: take must be an integer 1..${MAX_TAKE} (got ${String(params.take)})`);
    }
  }

  const age = params["signal.demographics.age"];
  if (age !== undefined) {
    const values = String(age)
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    const badAges = values.filter((v) => !VALID_AGE_VALUES.has(v));
    if (values.length === 0 || badAges.length > 0) {
      fail(
        `Qloo insights params: invalid signal.demographics.age value(s) ${badAges.join(", ") || "(empty)"}. ` +
          `Allowed: ${[...VALID_AGE_VALUES].join(", ")}`,
      );
    }
  }

  return type as InsightsType;
}

/** Converts params to a URLSearchParams with keys sorted (stable for caching). */
export function toQuery(params: Record<string, string | number | boolean | undefined>): URLSearchParams {
  const q = new URLSearchParams();
  for (const key of Object.keys(params).sort()) {
    const v = params[key];
    if (v === undefined) continue;
    q.set(key, String(v));
  }
  return q;
}
