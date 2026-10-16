// Qloo operations for Fondly. Every function returns only data Qloo actually returned.
// Privacy: only entity ids, tag ids and public cultural names (what staff typed as a favorite)
// are ever sent to Qloo. Resident names never leave the browser.
import type { Domain, EntityType, FavoriteKind, QlooClient, QlooEntity, QlooTag } from "../../shared/types.ts";

type Params = Record<string, string | number | boolean>;

export const DOMAIN_TYPE: Record<Exclude<Domain, "outing">, EntityType> = {
  music: "urn:entity:artist",
  film: "urn:entity:movie",
  tv: "urn:entity:tv_show",
  books: "urn:entity:book",
  gaming: "urn:entity:videogame",
  // Qloo models teams and leagues as brands tagged "Sports Organization".
  sports: "urn:entity:brand",
};

export const KIND_TYPE: Record<Exclude<FavoriteKind, "food">, EntityType> = DOMAIN_TYPE;

/** Extra tag filter per domain, so e.g. "sports" brands stay teams and leagues, never soda or sneakers. */
export const DOMAIN_TAG: Partial<Record<Exclude<Domain, "outing">, string>> = {
  sports: "urn:tag:genre:brand:sports_organization",
};

const withDomainTag = (domain: Exclude<Domain, "outing">, p: Params): Params => {
  const tag = DOMAIN_TAG[domain];
  if (tag) p["filter.tags"] = tag;
  return p;
};

/**
 * Sports fans follow teams near home: a location signal makes Qloo favor the region's clubs
 * (for Chicago: White Sox, Bears, Blackhawks) over global ones. Other domains are not location-bound.
 */
function withHomeTeams(domain: Exclude<Domain, "outing">, p: Params, city: string | undefined) {
  if (domain === "sports" && city?.trim()) p["signal.location.query"] = city.trim();
}

/**
 * Extra filter for *discovered* titles (group picks, expansions, the popular baseline), never for
 * resolving a resident's own favorite. Games must be family friendly: Qloo's insights results often
 * omit content ratings, but its audience tags are reliable.
 */
const DISCOVERY_TAG: Partial<Record<Exclude<Domain, "outing">, string>> = {
  gaming: "urn:tag:audience:qloo:family_friendly",
};

const withDiscoveryTag = (domain: Exclude<Domain, "outing">, p: Params): Params => {
  const extra = DISCOVERY_TAG[domain];
  if (extra) p["filter.tags"] = p["filter.tags"] ? `${p["filter.tags"]},${extra}` : extra;
  return p;
};

const MATURE_RATINGS = new Set(["M", "AO", "NC-17", "X", "TV-MA"]);
const MATURE_TAG = /:(blood_soaked|gory|gore|mature_themes|graphic_violence|sexual_content|explicit|shooter|first_person_shooter|survival_horror)$/;

/**
 * True when a discovered title suits a group session in a care home. Residents' own stated
 * favorites are never filtered (staff already know them); this only gates recommendations.
 */
export function suitableForGroup(e: QlooEntity): boolean {
  const rating = e.properties?.content_rating?.trim().toUpperCase();
  if (rating && MATURE_RATINGS.has(rating)) return false;
  return !e.tags?.some((t) => MATURE_TAG.test(t.id) || NOT_AN_OUTING.test(t.id));
}

// Places that rank high in a city but are not somewhere a group goes for an afternoon out.
const NOT_AN_OUTING =
  /^urn:tag:category:place:(\w+_)?(airport|airline|train_station|bus_station|transit_station|subway_station|parking\w*|gas_station|hotel|motel|hospital|clinic|office\w*|corporate_office|bank|atm|night_club|bar|casino|adult\w*)$/;

export const kindToDomain = (k: FavoriteKind): Domain | undefined => (k === "food" ? undefined : k);

/** Age signal Qloo accepts on entity insights; used for the "most popular titles" baseline. */
export const OLDER_ADULT_AGE = "55_and_older";
/** Popularity floor for the baseline; required for Qloo to accept the request. */
export const BASELINE_MIN_POPULARITY = 0.5;

export const GROUP_TAKE = 25;
export const SCORE_TAKE = 50;
export const MAX_SIGNAL_IDS = 25;
export const RELATED_TAKE = 5;
export const BASELINE_TAKE = 20;
export const OUTING_TAKE = 15;
export const ONE_TO_ONE_TAKE = 6;

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/^the\s+/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Prefer an exact name match, then a prefix match, then Qloo's top result. */
export function pickByName<T extends { name: string }>(results: T[], text: string): T | undefined {
  const n = norm(text);
  return (
    results.find((e) => norm(e.name) === n) ??
    results.find((e) => norm(e.name).startsWith(n) || n.startsWith(norm(e.name))) ??
    results[0]
  );
}

export async function resolveEntity(qloo: QlooClient, kind: Exclude<FavoriteKind, "food">, text: string) {
  const res = await qloo.searchEntities(text, [KIND_TYPE[kind]], 5);
  const tag = DOMAIN_TAG[kind];
  if (!tag) return pickByName(res, text);
  // Only accept results carrying the domain tag (a "Yankees" sports favorite must not become a clothing brand).
  const tagged = res.filter((e) => e.tags?.some((t) => t.id === tag || t.id.startsWith(`${tag}:`)));
  return pickByName(tagged, text);
}

/** Food favorites resolve to Qloo tags (cuisines/dishes). Prefers place-genre tags. */
export async function resolveFoodTag(qloo: QlooClient, text: string): Promise<QlooTag | undefined> {
  const res = await qloo.searchTags(text, 10);
  const food = res.filter((t) => /genre:place|restaurant|cuisine|dish|food/i.test(`${t.id} ${t.type ?? ""}`));
  return pickByName(food.length ? food : res, text);
}

/** Recommendations for a domain from a set of taste signals (group- or resident-level). */
export function recommendParams(
  domain: Exclude<Domain, "outing">,
  signalIds: string[],
  opts: { take?: number; exclude?: string[]; explain?: boolean; city?: string } = {},
): Params {
  const p: Params = {
    "filter.type": DOMAIN_TYPE[domain],
    "signal.interests.entities": signalIds.slice(0, MAX_SIGNAL_IDS).join(","),
    take: opts.take ?? GROUP_TAKE,
  };
  if (opts.exclude?.length) p["filter.exclude.entities"] = opts.exclude.slice(0, 50).join(",");
  if (opts.explain) p["feature.explainability"] = true;
  withHomeTeams(domain, p, opts.city);
  return withDiscoveryTag(domain, withDomainTag(domain, p));
}

/** Score a fixed list of candidates against one resident's taste signals. */
export function scoreParams(domain: Exclude<Domain, "outing">, signalIds: string[], candidateIds: string[]): Params {
  // Candidates are already domain-filtered; the tag filter is not re-applied when scoring a fixed list.
  return {
    "filter.type": DOMAIN_TYPE[domain],
    "signal.interests.entities": signalIds.slice(0, MAX_SIGNAL_IDS).join(","),
    "filter.results.entities": candidateIds.slice(0, SCORE_TAKE).join(","),
    "feature.explainability": true,
    take: Math.max(1, Math.min(candidateIds.length, SCORE_TAKE)),
  };
}

/** Generic "popular with older adults" list, the comparison baseline (no resident data). */
export function baselineParams(domain: Exclude<Domain, "outing">, city?: string): Params {
  const p = withDomainTag(domain, {
    "filter.type": DOMAIN_TYPE[domain],
    "signal.demographics.age": OLDER_ADULT_AGE,
    // Qloo rejects an age-only request ("at least one valid signal or filter is required"),
    // so a popularity floor makes this a valid "widely popular titles" query.
    "filter.popularity.min": BASELINE_MIN_POPULARITY,
    take: BASELINE_TAKE,
  });
  withHomeTeams(domain, p, city);
  return withDiscoveryTag(domain, p);
}

/** Local outing venues that match the group's taste (restaurants etc. near the home). */
export function outingParams(city: string, signalIds: string[], tagIds: string[]): Params {
  const p: Params = {
    "filter.type": "urn:entity:place",
    "filter.location.query": city,
    take: OUTING_TAKE,
  };
  if (signalIds.length) p["signal.interests.entities"] = signalIds.slice(0, MAX_SIGNAL_IDS).join(",");
  if (tagIds.length) {
    p["signal.interests.tags"] = tagIds.slice(0, 10).join(",");
  }
  return p;
}

/** Score specific place candidates for one resident. */
export function outingScoreParams(city: string, signalIds: string[], tagIds: string[], placeIds: string[]): Params {
  const p = outingParams(city, signalIds, tagIds);
  p["filter.results.entities"] = placeIds.slice(0, SCORE_TAKE).join(",");
  p.take = Math.max(1, Math.min(placeIds.length, SCORE_TAKE));
  delete p["filter.location.query"];
  return p;
}

/**
 * Converts Qloo affinity scores (relative to one resident) into a 0..1 fit by percentile rank
 * among the scored candidates. Raw affinities are not comparable across residents; ranks are.
 * Ties share the same rank. Candidates Qloo did not return get no fit (treated as 0).
 */
export function rankFits(scored: QlooEntity[]): Map<string, number> {
  const withAff = scored.filter((e) => typeof e.affinity === "number");
  const out = new Map<string, number>();
  const n = withAff.length;
  if (n === 0) return out;
  if (n === 1) {
    out.set(withAff[0]!.entity_id, 1);
    return out;
  }
  const sorted = [...withAff].sort((a, b) => (a.affinity ?? 0) - (b.affinity ?? 0));
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && Math.abs((sorted[j + 1]!.affinity ?? 0) - (sorted[i]!.affinity ?? 0)) < 1e-9) j++;
    const rank = (i + j) / 2 / (n - 1);
    for (let k = i; k <= j; k++) out.set(sorted[k]!.entity_id, Math.round(rank * 1000) / 1000);
    i = j + 1;
  }
  return out;
}
