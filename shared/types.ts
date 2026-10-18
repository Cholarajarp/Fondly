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

/** Age buckets Qloo's demographics insights return (checked live). */
export type AgeBucket = "24_and_younger" | "25_to_29" | "30_to_34" | "35_to_44" | "45_to_54" | "55_and_older";

/** One entity's age affinities from urn:demographics: -1..1, 0 = average audience. */
export interface EntityDemographics {
  entity_id: string;
  age: Partial<Record<AgeBucket, number>>;
}

/** Qloo's 55-and-older audience signal for a scheduled pick. */
export interface OlderAdultSignal {
  /** Qloo's 55_and_older affinity, -1..1 (0 = average). */
  affinity: number;
  /** True when the affinity is clearly positive and 55+ is this title's strongest age group ("Loved by 55+"). */
  loved: boolean;
}

/** An area near the home where the group's taste clusters (Qloo heatmap). */
export interface OutingArea {
  /** Neighborhood name Qloo returns for venues there (geocode), when available. */
  name: string;
  lat: number;
  lon: number;
  /** Qloo heatmap affinity rank 0..1. */
  affinity: number;
  /** Top group-matched venues Qloo returns in the area. */
  venues: string[];
  /** One line on why, built from Qloo data. */
  why: string;
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
  /** `types` limits results to tag types, e.g. "urn:tag:genre:music" (Qloo's filter.tag.types). */
  searchTags(query: string, take?: number, types?: string[]): Promise<QlooTag[]>;
  insights(params: Record<string, string | number | boolean>): Promise<QlooEntity[]>;
  heatmap(params: Record<string, string | number | boolean>): Promise<HeatmapCell[]>;
  demographics(params: Record<string, string | number | boolean>): Promise<EntityDemographics[]>;
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
  /** Optional birth year (BIRTH_YEAR_MIN..BIRTH_YEAR_MAX): biases film and TV toward the years of their youth. */
  birthYear?: number;
}

/** Accepted birth years. Qloo's release years make the window meaningful for these cohorts. */
export const BIRTH_YEAR_MIN = 1915;
export const BIRTH_YEAR_MAX = 1975;
/**
 * Reminiscence bump: people respond most to the culture of their teens and twenties.
 * The youth window is birthYear + YOUTH_FROM_AGE .. birthYear + YOUTH_TO_AGE.
 */
export const YOUTH_FROM_AGE = 10;
export const YOUTH_TO_AGE = 30;

export interface YearRange {
  from: number;
  to: number;
}

export const youthYears = (birthYear: number): YearRange => ({ from: birthYear + YOUTH_FROM_AGE, to: birthYear + YOUTH_TO_AGE });

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
  /** Typical birth year at the home, used for residents without their own birthYear. Absent: no era bias. */
  defaultBirthYear?: number;
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
  /** Qloo tag: cuisines for food, genres (e.g. "Big Band", "Westerns") for other kinds. */
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
  /** True when the title was released in the resident's youth window (film and TV only). */
  fromYouth?: boolean;
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
  /** Qloo 55+ audience signal for the pick, when Qloo returned one. */
  olderAdults?: OlderAdultSignal;
}

export interface OneToOnePlan {
  picks: QlooEntity[];
  note: string;
  /** Pick entity id -> Qloo 55+ audience signal. */
  olderAdults?: Record<string, OlderAdultSignal>;
}

export interface ResidentOutcome {
  residentId: string;
  /** False when none of the resident's favorites resolved on Qloo, so they could not be scored. */
  scorable: boolean;
  reached: boolean;
  bestFit: number;
  bestSlotId?: string;
  /** Every scheduled session the resident can attend, with their fit. */
  sessions: { slotId: string; fit: number; ownFavorite: boolean; why: string; fromYouth?: boolean }[];
  favorites: ResolvedFavorite[];
  /** Release years of their teens and twenties (from their own or the home's birth year). */
  youthYears?: YearRange;
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
  /** Which plan steps the agent performed and which the deterministic safety net filled in. Absent on older plans. */
  agentRun?: AgentRunAccount;
  /** Areas near the home where the group's taste clusters (Qloo heatmap). Absent when unavailable. */
  outingIdeas?: OutingArea[];
}

/** A plan step and who performed it. */
export interface PlanStepAccount {
  step: string;
  /** "both": the agent ran the step and the safety net completed it. */
  by: "agent" | "safety_net" | "both";
}

export interface AgentRunAccount {
  steps: PlanStepAccount[];
  /** Tool calls the agent made (including rejected ones). */
  toolCalls: number;
  expansions: number;
  revisions: number;
  /** The agent's own account of what it tried and what is still weak (free text, no numbers shown from it). */
  selfEvaluation?: { tried: string; remaining: string };
}

// ---------------------------------------------------------------------------
// Streaming events (SSE `data:` payloads)
// ---------------------------------------------------------------------------

export type AgentEvent =
  | { kind: "status"; message: string }
  /** First event: the id the finished plan will be saved under, so a dropped stream can recover it. */
  | { kind: "started"; planId: string }
  | { kind: "tool_call"; id: string; tool: string; input: unknown; /** The agent's stated reason (agent tools only), clipped. */ reason?: string }
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

// ---------------------------------------------------------------------------
// Family taste link
// ---------------------------------------------------------------------------

/**
 * One cultural item a family member suggests. `entityId` is set when they picked a Qloo
 * suggestion (a Qloo tag id for food). No free-text notes: nothing personal can be submitted.
 */
export interface FamilyItem {
  kind: FavoriteKind;
  text: string;
  entityId?: string;
}

export interface FamilySubmission {
  favorites: FamilyItem[];
  /** Things to keep out of their sessions. Always picked Qloo entities, never food or health notes. */
  avoid: FamilyItem[];
}

/** waiting: link sent, nothing back yet. received: family answered. reviewed: coordinator added or dismissed it. */
export type InviteStatus = "waiting" | "received" | "reviewed";

/** What the family page sees (token holder). Holds no resident alias or name. */
export interface FamilyInviteView {
  status: InviteStatus;
  expiresAt: string;
  submission?: FamilySubmission;
}

/** What the coordinator sees for each of their invites (token + manage key holder). */
export interface InviteStatusResult {
  token: string;
  found: boolean;
  expired?: boolean;
  status?: InviteStatus;
  residentId?: string;
  expiresAt?: string;
  submittedAt?: string;
  submission?: FamilySubmission;
}

export interface CreatedInvite {
  token: string;
  /** Second secret, kept by the coordinator only: required to read status and mark an invite reviewed. */
  manageKey: string;
  residentId: string;
  createdAt: string;
  expiresAt: string;
}

/** A Qloo suggestion for the family autocomplete. */
export interface FamilySuggestion {
  id: string;
  name: string;
  /** Year or place, to tell same-named items apart. */
  detail?: string;
}
