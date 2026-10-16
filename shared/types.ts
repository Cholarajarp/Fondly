// Shared contracts between server and web. Keep this file dependency-free.
// Every entity and score in a plan comes from a live Qloo API response. There is no mock mode.

// ---------------------------------------------------------------------------
// Qloo
// ---------------------------------------------------------------------------

export type EntityType =
  | "urn:entity:artist"
  | "urn:entity:book"
  | "urn:entity:brand"
  | "urn:entity:destination"
  | "urn:entity:movie"
  | "urn:entity:person"
  | "urn:entity:place"
  | "urn:entity:podcast"
  | "urn:entity:tv_show"
  | "urn:entity:videogame";

export type InsightsType = EntityType | "urn:heatmap" | "urn:demographics";

/** Minimal normalized Qloo entity used across the app. */
export interface QlooEntity {
  entity_id: string;
  name: string;
  type?: string;
  subtype?: string;
  popularity?: number;
  /** Affinity score from /v2/insights, 0..1 when present. */
  affinity?: number;
  image_url?: string;
  tags?: { id: string; name: string; type?: string }[];
  properties?: {
    address?: string;
    short_description?: string;
    business_rating?: number;
    /** Age rating for media, e.g. ESRB "E", "T", "M" for video games, "PG-13" for films. */
    content_rating?: string;
    price_level?: number;
    release_year?: number;
    geocode?: { name?: string; admin1_region?: string; country_code?: string };
  };
  location?: { lat: number; lon: number };
  /** Explainability: input entity id -> contribution score 0..1 */
  explainability?: { entity_id: string; score: number }[];
}

export interface QlooTag {
  id: string;
  name: string;
  type?: string;
}

export interface HeatmapCell {
  geohash: string;
  lat: number;
  lon: number;
  affinity: number;
  popularity?: number;
}

export interface AgeAffinity {
  age: "35_and_younger" | "36_to_55" | "55_and_older";
  affinity: number;
}

/** Error thrown by the Qloo client. `status` is the HTTP status (0 for network/validation errors). */
export class QlooError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly path: string,
  ) {
    super(message);
    this.name = "QlooError";
  }
}

/** Interface the live Qloo client implements (server/qloo/client.ts). */
export interface QlooClient {
  searchEntities(query: string, types?: EntityType[], take?: number): Promise<QlooEntity[]>;
  searchTags(query: string, take?: number): Promise<QlooTag[]>;
  insights(params: Record<string, string | number | boolean>): Promise<QlooEntity[]>;
  heatmap(params: Record<string, string | number | boolean>): Promise<HeatmapCell[]>;
  demographics(params: Record<string, string | number | boolean>): Promise<AgeAffinity[]>;
  /** Number of real HTTP calls made (cache hits excluded). */
  callCount(): number;
}

// ---------------------------------------------------------------------------
// Fondly domain
// ---------------------------------------------------------------------------

/** Kinds of session the week can contain. */
export type Domain = "music" | "film" | "tv" | "books" | "gaming" | "sports" | "outing";
export const DOMAINS: readonly Domain[] = ["music", "film", "tv", "books", "gaming", "sports", "outing"];

/** Kinds of favorite staff can record for a resident. "food" resolves to Qloo tags, the rest to entities. */
export type FavoriteKind = "music" | "film" | "tv" | "books" | "gaming" | "sports" | "food";
export const FAVORITE_KINDS: readonly FavoriteKind[] = ["music", "film", "tv", "books", "gaming", "sports", "food"];

export const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
export type Day = (typeof DAYS)[number];
export const TIMES = ["morning", "afternoon", "evening"] as const;
export type TimeOfDay = (typeof TIMES)[number];

export interface Favorite {
  kind: FavoriteKind;
  /** What staff typed, e.g. "Patsy Cline". */
  text: string;
}

/**
 * One resident as sent to the server. Residents are identified only by an opaque id (r1, r2…).
 * Real names stay in the browser and are never sent to the server, Qloo or the language model.
 */
export interface ResidentInput {
  id: string;
  favorites: Favorite[];
  unavailableDays?: Day[];
  unavailableTimes?: TimeOfDay[];
  /** Session kinds this resident does not want to attend. */
  optOut?: Domain[];
  /** Qloo entity ids the resident enjoyed in past sessions (used as extra taste signal). */
  loved?: string[];
  /** Qloo entity ids the resident declined (never scheduled as a match for them). */
  declined?: string[];
}

export interface SlotInput {
  id: string;
  day: Day;
  time: TimeOfDay;
  domain: Domain;
}

export interface PlanRequest {
  /** Client-generated id of the roster; lets the browser map resident ids back to names. */
  rosterId: string;
  homeName?: string;
  /** City used for outing venues. */
  homeCity: string;
  residents: ResidentInput[];
  slots: SlotInput[];
}

export type ResolveStatus = "matched" | "not_found";

export interface ResolvedFavorite {
  kind: FavoriteKind;
  text: string;
  status: ResolveStatus;
  /** Qloo entity (music/film/tv/books). */
  entity?: Pick<QlooEntity, "entity_id" | "name" | "type" | "image_url">;
  /** Qloo tag (food). */
  tag?: QlooTag;
}

/** Where a candidate came from. */
export type CandidateSource = "group" | "favorite" | "expanded" | "baseline" | "llm_only";

export interface SessionMatch {
  residentId: string;
  /** 0..1, rank of this session among this week's options for the resident (1 = their top option). */
  fit: number;
  /** True if the session is one of the resident's own stated (or previously loved) favorites. */
  ownFavorite: boolean;
  /** Plain-language reason built from Qloo explainability. */
  why: string;
}

export interface ScheduledSession {
  slotId: string;
  day: Day;
  time: TimeOfDay;
  domain: Domain;
  entity: QlooEntity;
  source: CandidateSource;
  /** Qloo entities related to the session entity, to fill the hour (e.g. more artists to play). */
  related: QlooEntity[];
  /** Residents available for this slot and not opted out of its kind. */
  attendees: string[];
  /** Attendees for whom this is a strong match (fit >= REACH_THRESHOLD or own favorite). */
  matches: SessionMatch[];
  /** Mean fit across attendees. */
  meanFit: number;
  title: string;
  /** Markdown, written by the agent from Qloo data (templated fallback). */
  brief: string;
}

export interface OneToOnePlan {
  picks: QlooEntity[];
  note: string;
}

export interface ResidentOutcome {
  residentId: string;
  /** False when none of the resident's favorites resolved on Qloo, so they could not be scored. */
  scorable: boolean;
  reached: boolean;
  bestFit: number;
  bestSlotId?: string;
  /** Every scheduled session the resident can attend, with their fit. */
  sessions: { slotId: string; fit: number; ownFavorite: boolean; why: string }[];
  favorites: ResolvedFavorite[];
  oneToOne?: OneToOnePlan;
  /** Deterministic care-plan note (no LLM text), suitable for activity documentation. */
  careNote: string;
  warnings: string[];
}

export interface Metrics {
  /** Residents with at least one strong match they can attend. */
  reached: number;
  /** Residents that could be scored. */
  total: number;
  /** Lowest best-fit across scorable residents (the least-served resident). */
  minBest: number;
  /** Mean best-fit across scorable residents. */
  meanBest: number;
  /** Mean of each resident's two best attendable sessions. */
  meanTop2: number;
  /**
   * Residents strongly matched by a session that is NOT one of their own stated favorites.
   * Own favorites always score 1.0, so this isolates what taste data discovered beyond the intake form.
   */
  discoveryReached?: number;
}

export interface BaselineComparison {
  key: "popular_55" | "llm_only";
  label: string;
  /** How the baseline was built, in plain words. */
  method: string;
  available: boolean;
  metrics?: Metrics;
  sessions: { slotId: string; entityId: string; name: string }[];
  note?: string;
}

export interface PlanDiff {
  previousPlanId: string;
  metricsBefore: Metrics;
  changedSlots: { slotId: string; day: Day; time: TimeOfDay; from?: string; to?: string }[];
  residentChanges: { residentId: string; fromBest: number; toBest: number; fromReached: boolean; toReached: boolean }[];
  /** Human-readable list of the edits applied (instruction + reactions). */
  edits: string[];
}

export interface WeekPlan {
  id: string;
  createdAt: string;
  request: PlanRequest;
  sessions: ScheduledSession[];
  residents: ResidentOutcome[];
  metrics: Metrics;
  baselines: BaselineComparison[];
  /** Markdown summary for staff. */
  summary: string;
  /** Markdown family newsletter (no resident-level data). */
  newsletter: string;
  /** Plan-level notes: missing data, unresolved favorites, skipped steps. */
  notes: string[];
  /** Qloo requests made for this plan (including cached responses). */
  qlooRequests: number;
  /** Number of optimizer passes the agent ran. */
  optimizerRuns: number;
  previousPlanId?: string;
  diff?: PlanDiff;
}

// ---------------------------------------------------------------------------
// Streaming events (SSE `data:` payloads)
// ---------------------------------------------------------------------------

export type AgentEvent =
  | { kind: "status"; message: string }
  | { kind: "tool_call"; id: string; tool: string; input: unknown }
  | { kind: "tool_result"; id: string; tool: string; ok: boolean; summary: string; ms: number }
  | { kind: "progress"; label: string; metrics: Metrics }
  | { kind: "done"; plan: WeekPlan }
  | { kind: "error"; message: string };

// ---------------------------------------------------------------------------
// Re-planning and intake
// ---------------------------------------------------------------------------

export type Reaction = "loved" | "declined";

export interface ReplanRequest {
  /** "edit": change this week, keep what still works. "next_week": new week, learn from reactions, no repeats. */
  mode: "edit" | "next_week";
  /** Free-text instruction with resident names already replaced by ids in the browser. */
  instruction?: string;
  reactions?: { slotId: string; residentId: string; reaction: Reaction }[];
  /** Optional full replacement roster/template (from the roster editor). */
  request?: PlanRequest;
}

export interface IntakeResult {
  favorites: Favorite[];
  unavailableDays: Day[];
  unavailableTimes: TimeOfDay[];
  optOut: Domain[];
}

/** Fit at or above this counts as a strong match ("reached"). Fits are rank-based, so this means
 * "among roughly the top fifth of this week's options for that resident". */
export const REACH_THRESHOLD = 0.8;

// ---------------------------------------------------------------------------
// Session kits (ready-to-run material per session)
// ---------------------------------------------------------------------------

export interface SessionKitQuizItem {
  question: string;
  answer: string;
}

/**
 * Read-aloud material for one scheduled session, generated once per plan + slot and cached on the
 * server. Facts and media links are not stored here: the browser builds them from the Qloo entity.
 */
export interface SessionKit {
  planId: string;
  slotId: string;
  /** Qloo entity the kit was written for. */
  entityId: string;
  /** "gemini": written by the language model and checked by code. "template": deterministic fallback. */
  source: "gemini" | "template";
  /** User-safe reason the template was used, when source is "template". */
  fallbackReason?: string;
  createdAt: string;
  /** About 60 seconds read aloud. */
  intro: string;
  /** Exactly 5 reminiscence / conversation prompts. */
  prompts: string[];
  /** Simple sensory and adaptation tips for mixed abilities. No medical advice. */
  adaptations: string[];
  /** Exactly 3 gentle quiz questions. */
  quiz: SessionKitQuizItem[];
}

export interface SessionKitResponse {
  kit: SessionKit;
  /** True when the kit came from the server cache (no language-model call). */
  cached: boolean;
}
