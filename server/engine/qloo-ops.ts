// Qloo operations for Fondly. Every function returns only data Qloo actually returned.
// Privacy: only entity ids, tag ids and public cultural names (what staff typed as a favorite)
// are ever sent to Qloo. Resident names never leave the browser.
import type { Domain, EntityType, FavoriteKind, QlooClient, QlooEntity, QlooTag, YearRange } from "../../shared/types.ts";

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
/** Newest release year a recommended (not favorite) video game may have. */
export const CLASSIC_GAME_MAX_YEAR = 2010;
const isGame = (e: QlooEntity) => e.type === "urn:entity:videogame" || e.subtype === "urn:entity:videogame";

export function suitableForGroup(e: QlooEntity): boolean {
  const rating = e.properties?.content_rating?.trim().toUpperCase();
  if (rating && MATURE_RATINGS.has(rating)) return false;
  // Qloo ignores the release-year filter for games and recommends current console titles; a care
  // home's games club plays classics (Tetris, Wii Bowling). A suggested game needs a known classic
  // year; residents' own favorite games never pass through here.
  const year = e.properties?.release_year;
  if (isGame(e) && !(typeof year === "number" && year <= CLASSIC_GAME_MAX_YEAR)) return false;
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

/** Exact or prefix name match only (no "top result" fallback). */
function nameMatch<T extends { name: string }>(results: T[], text: string): { hit: T; exact: boolean } | undefined {
  const n = norm(text);
  const exact = results.find((e) => norm(e.name) === n);
  if (exact) return { hit: exact, exact: true };
  const prefix = results.find((e) => norm(e.name).startsWith(n) || n.startsWith(norm(e.name)));
  return prefix ? { hit: prefix, exact: false } : undefined;
}

/**
 * Genre tag types per favorite kind (checked live: /v2/tags with filter.tag.types returns e.g.
 * "Big Band" and "Gospel" for genre:music, "Westerns" and "Musicals" for genre:media).
 * Sports favorites are always teams or leagues, so they never resolve to a genre.
 */
export const GENRE_TAG_TYPE: Partial<Record<Exclude<FavoriteKind, "food">, string>> = {
  music: "urn:tag:genre:music",
  film: "urn:tag:genre:media",
  tv: "urn:tag:genre:media",
  books: "urn:tag:genre:media",
  gaming: "urn:tag:genre:media",
};

// Plural-tolerant, so "westerns" matches "Westerns" and "game shows" matches "Game Show".
const singular = (s: string) => s.replace(/s\b/g, "");

/**
 * True when the text reads like a proper name ("The Beatles", "Johnny Cash") rather than a genre
 * ("gospel", "big band", "Westerns"). A proper name keeps an exact entity match over a same-named genre.
 */
export const looksLikeName = (text: string): boolean => {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return /^the\s/i.test(text.trim()) || (words.length >= 2 && words.every((w) => /^[\p{Lu}\p{N}]/u.test(w)));
};

export type FavoriteHit = { entity: QlooEntity; tag?: undefined } | { tag: QlooTag; entity?: undefined };

/**
 * Resolves a non-food favorite to a Qloo entity, or to a genre tag when the text is a genre.
 * Qloo's entity search alone turns "big band" into "Big Band Katowice" and "gospel" into a band
 * called Gospel, so: an exact genre tag wins over a partial entity match (and over an exact one
 * unless the text looks like a proper name); with no name match at all, a related genre tag beats
 * Qloo's top entity result.
 */
export async function resolveFavorite(qloo: QlooClient, kind: Exclude<FavoriteKind, "food">, text: string): Promise<FavoriteHit | undefined> {
  const tagType = GENRE_TAG_TYPE[kind];
  if (!tagType) {
    const entity = await resolveEntity(qloo, kind, text);
    return entity ? { entity } : undefined;
  }
  const res = await qloo.searchEntities(text, [KIND_TYPE[kind]], 5);
  const named = nameMatch(res, text);
  // A clear proper-name match needs no genre lookup (saves a Qloo call for most favorites).
  if (named?.exact && looksLikeName(text)) return { entity: named.hit };
  const tags = await qloo.searchTags(text, 5, [tagType]).catch(() => [] as QlooTag[]);
  const n = singular(norm(text));
  const exactTag = tags.find((t) => singular(norm(t.name)) === n);
  if (exactTag) return { tag: exactTag };
  if (named) return { entity: named.hit };
  // No name match: a genre tag sharing a word with the text ("old westerns" -> Westerns) beats a random entity.
  const words = new Set(n.split(" ").filter((w) => w.length > 2));
  const related = tags.find((t) => singular(norm(t.name)).split(" ").some((w) => words.has(w)));
  if (related) return { tag: related };
  return res[0] ? { entity: res[0] } : undefined;
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

export const MAX_SIGNAL_TAGS = 10;

/** Entity and/or genre-tag taste signals; Qloo needs at least one of the two. */
function withSignals(p: Params, signalIds: string[], tagIds: string[] = []) {
  if (signalIds.length) p["signal.interests.entities"] = signalIds.slice(0, MAX_SIGNAL_IDS).join(",");
  if (tagIds.length) p["signal.interests.tags"] = tagIds.slice(0, MAX_SIGNAL_TAGS).join(",");
}

/**
 * Session types whose Qloo entities carry release years and honor filter.release_year.* (checked
 * live: movies and TV shows return only titles inside the window). Artists accept the filter but
 * silently ignore it and have no release year, so music cannot be era-filtered.
 */
export const ERA_DOMAINS: ReadonlySet<Exclude<Domain, "outing">> = new Set(["film", "tv"]);

/** True when a title's release year falls inside the window. Titles without a year never count. */
export const inYears = (e: QlooEntity, years: YearRange | undefined): boolean => {
  const y = e.properties?.release_year;
  return !!years && typeof y === "number" && y >= years.from && y <= years.to;
};

/** Recommendations for a domain from a set of taste signals (group- or resident-level). */
export function recommendParams(
  domain: Exclude<Domain, "outing">,
  signalIds: string[],
  opts: { take?: number; exclude?: string[]; explain?: boolean; city?: string; tags?: string[]; years?: YearRange } = {},
): Params {
  const p: Params = { "filter.type": DOMAIN_TYPE[domain], take: opts.take ?? GROUP_TAKE };
  withSignals(p, signalIds, opts.tags);
  if (opts.exclude?.length) p["filter.exclude.entities"] = opts.exclude.slice(0, 50).join(",");
  if (opts.explain) p["feature.explainability"] = true;
  if (opts.years && ERA_DOMAINS.has(domain)) {
    p["filter.release_year.min"] = opts.years.from;
    p["filter.release_year.max"] = opts.years.to;
  }
  withHomeTeams(domain, p, opts.city);
  return withDiscoveryTag(domain, withDomainTag(domain, p));
}

/** Score a fixed list of candidates against one resident's taste signals (entities and/or genre tags). */
export function scoreParams(domain: Exclude<Domain, "outing">, signalIds: string[], candidateIds: string[], tagIds: string[] = []): Params {
  // Candidates are already domain-filtered; the tag filter is not re-applied when scoring a fixed list.
  const p: Params = {
    "filter.type": DOMAIN_TYPE[domain],
    "filter.results.entities": candidateIds.slice(0, SCORE_TAKE).join(","),
    "feature.explainability": true,
    take: Math.max(1, Math.min(candidateIds.length, SCORE_TAKE)),
  };
  withSignals(p, signalIds, tagIds);
  return p;
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
