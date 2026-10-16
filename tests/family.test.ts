import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FamilySubmission, QlooClient, QlooEntity } from "../shared/types.ts";
import { createApp } from "../server/app.ts";
import { createInvitesStore, isValidSecret, newSecret } from "../server/invites-store.ts";
import { FamilySubmissionSchema, searchFamily, TOKEN_HEADER } from "../server/routes/family.ts";
import { familyUrl, linkState, mergeFamilyItems, parseFamilyHash, type FamilyLink } from "../web/src/family.ts";
import type { RosterResident } from "../web/src/roster.ts";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), "fondly-family-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sub: FamilySubmission = {
  favorites: [
    { kind: "music", text: "Vera Lynn", entityId: "E-VERA" },
    { kind: "food", text: "Italian", entityId: "urn:tag:genre:place:restaurant:italian" },
    { kind: "film", text: "Brief Encounter" },
  ],
  avoid: [{ kind: "film", text: "Jaws", entityId: "E-JAWS" }],
};

const DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------

describe("invite secrets", () => {
  it("are 192-bit, URL-safe and unique", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const s = newSecret();
      expect(s).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect(Buffer.from(s, "base64url")).toHaveLength(24);
      seen.add(s);
    }
    expect(seen.size).toBe(500);
  });

  it("rejects malformed tokens before touching the disk", () => {
    for (const bad of ["", "short", "../../etc/passwd", `${"a".repeat(31)}/`, "a".repeat(33), null, 42]) expect(isValidSecret(bad)).toBe(false);
  });
});

describe("invites store", () => {
  it("stores only the alias, hashes the file name and manage key, and never stores the token", async () => {
    const dir = tmp();
    const store = createInvitesStore(dir);
    const { token, manageKey, record } = await store.create("r3");
    expect(record).toMatchObject({ residentId: "r3", status: "waiting" });
    expect(Date.parse(record.expiresAt) - Date.parse(record.createdAt)).toBe(14 * DAY);
    const files = readdirSync(path.join(dir, "invites"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f]{64}\.json$/);
    const raw = readFileSync(path.join(dir, "invites", files[0]!), "utf8");
    expect(raw).not.toContain(token);
    expect(raw).not.toContain(manageKey);
  });

  it("expires after 14 days", async () => {
    let t = Date.UTC(2026, 9, 1);
    const store = createInvitesStore(tmp(), { now: () => t });
    const { token, manageKey } = await store.create("r1");
    t += 14 * DAY - 1;
    expect((await store.get(token)).ok).toBe(true);
    t += 1;
    expect(await store.get(token)).toEqual({ ok: false, reason: "expired" });
    expect(await store.getManaged(token, manageKey)).toEqual({ ok: false, reason: "expired" });
    expect(await store.submit(token, sub)).toEqual({ ok: false, reason: "expired" });
  });

  it("allows one submission, editable until reviewed, then drops the answers", async () => {
    const store = createInvitesStore(tmp());
    const { token, manageKey } = await store.create("r1");
    await store.submit(token, sub);
    const edited = { ...sub, favorites: [sub.favorites[0]!] };
    const r = await store.submit(token, edited);
    expect(r.ok && r.record.submission).toEqual(edited);
    expect(r.ok && r.record.status).toBe("received");
    const done = await store.markReviewed(token, manageKey);
    expect(done.ok && done.record.status).toBe("reviewed");
    expect(done.ok && done.record.submission).toBeUndefined();
    expect(await store.submit(token, sub)).toEqual({ ok: false, reason: "reviewed" });
  });

  it("requires the manage key for coordinator reads", async () => {
    const store = createInvitesStore(tmp());
    const { token, manageKey } = await store.create("r1");
    expect((await store.getManaged(token, manageKey)).ok).toBe(true);
    expect(await store.getManaged(token, newSecret())).toEqual({ ok: false, reason: "not_found" });
    expect(await store.markReviewed(token, newSecret())).toEqual({ ok: false, reason: "not_found" });
    expect(await store.get(newSecret())).toEqual({ ok: false, reason: "not_found" });
  });

  it("serializes concurrent submissions", async () => {
    const store = createInvitesStore(tmp());
    const { token } = await store.create("r1");
    const results = await Promise.all(Array.from({ length: 8 }, () => store.submit(token, sub)));
    expect(results.every((r) => r.ok)).toBe(true);
    const got = await store.get(token);
    expect(got.ok && got.record.submission).toEqual(sub);
  });

  it("prunes invites past retention and beyond the cap", async () => {
    const dir = tmp();
    const store = createInvitesStore(dir, { ttlMs: 1000, maxAgeMs: 60_000, maxInvites: 2, pruneEveryMs: Infinity });
    const made = [];
    for (let i = 0; i < 4; i++) made.push(await store.create(`r${i + 1}`));
    const files = readdirSync(path.join(dir, "invites")).map((f) => path.join(dir, "invites", f));
    const old = new Date(Date.now() - 120_000);
    utimesSync(files[0]!, old, old);
    // One too old, then the newest two of the remaining three are kept.
    expect(await store.prune()).toBe(2);
    expect(readdirSync(path.join(dir, "invites"))).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------

describe("submission validation", () => {
  it("accepts a normal submission", () => {
    expect(FamilySubmissionSchema.safeParse(sub).success).toBe(true);
  });

  it.each([
    ["empty", { favorites: [], avoid: [] }],
    ["unknown field (notes)", { ...sub, notes: "has dementia" }],
    ["unknown item field", { favorites: [{ kind: "music", text: "x", diagnosis: "y" }], avoid: [] }],
    ["unknown kind", { favorites: [{ kind: "medical", text: "x" }], avoid: [] }],
    ["too long", { favorites: [{ kind: "music", text: "x".repeat(121) }], avoid: [] }],
    ["email", { favorites: [{ kind: "music", text: "call jane@example.com" }], avoid: [] }],
    ["phone", { favorites: [{ kind: "music", text: "ring 555 123 4567" }], avoid: [] }],
    ["control chars", { favorites: [{ kind: "music", text: "a\u0000b" }], avoid: [] }],
    ["too many", { favorites: Array.from({ length: 31 }, (_, i) => ({ kind: "music", text: `A${i}` })), avoid: [] }],
    ["duplicates", { favorites: [{ kind: "music", text: "ABBA" }, { kind: "music", text: "abba" }], avoid: [] }],
    ["avoid without a picked entity", { favorites: [], avoid: [{ kind: "film", text: "Jaws" }] }],
    ["avoid food", { favorites: [], avoid: [{ kind: "food", text: "Fish", entityId: "urn:tag:x" }] }],
    ["bad entity id", { favorites: [{ kind: "music", text: "x", entityId: "a,b" }], avoid: [] }],
  ])("rejects %s", (_label, body) => {
    expect(FamilySubmissionSchema.safeParse(body).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------

const entity = (id: string, name: string, extra: Partial<QlooEntity> = {}): QlooEntity => ({ entity_id: id, name, ...extra });
const searches: { q: string; types?: string[] }[] = [];
const fakeQloo = {
  async searchEntities(q: string, types?: string[]) {
    searches.push({ q, types });
    if (types?.[0] === "urn:entity:brand")
      return [entity("B1", "Chicago Cubs", { tags: [{ id: "urn:tag:genre:brand:sports_organization:baseball", name: "Baseball" }] }), entity("B2", "Cubs Clothing")];
    return [entity("A1", "Vera Lynn", { properties: { release_year: 1939 } }), entity("A1", "Vera Lynn (dupe)"), entity("A2", "Vera Lynn Tribute")];
  },
  async searchTags() {
    return [{ id: "urn:tag:genre:place:restaurant:italian", name: "Italian" }, { id: "urn:tag:keyword:italy", name: "Italy" }];
  },
} as unknown as QlooClient;

describe("family autocomplete", () => {
  it("dedupes entities and adds a year detail", async () => {
    expect(await searchFamily(fakeQloo, "music", "vera")).toEqual([
      { id: "A1", name: "Vera Lynn", detail: "1939" },
      { id: "A2", name: "Vera Lynn Tribute" },
    ]);
  });
  it("keeps only sports organizations for teams", async () => {
    expect((await searchFamily(fakeQloo, "sports", "cubs")).map((s) => s.id)).toEqual(["B1"]);
  });
  it("prefers place-genre tags for food", async () => {
    expect(await searchFamily(fakeQloo, "food", "ital")).toEqual([{ id: "urn:tag:genre:place:restaurant:italian", name: "Italian" }]);
  });
});

// ---------------------------------------------------------------------------

function app(limits = {}, qlooConfigured = true) {
  return createApp({
    invites: createInvitesStore(tmp()),
    missingKeys: () => [],
    getQloo: () => fakeQloo,
    qlooConfigured: () => qlooConfigured,
    logRequests: false,
    serveStatic: false,
    familyLimits: limits,
  });
}

describe("family API", () => {
  it("runs the whole flow: create, family read, submit, edit, coordinator status, review", async () => {
    const a = app();
    const created = await request(a).post("/api/invites").send({ residentId: "r2" });
    expect(created.status).toBe(201);
    const { token, manageKey } = created.body as { token: string; manageKey: string };
    expect(isValidSecret(token) && isValidSecret(manageKey)).toBe(true);
    expect(created.headers["cache-control"]).toBe("no-store");

    const view = await request(a).get("/api/family").set(TOKEN_HEADER, token);
    expect(view.status).toBe(200);
    expect(view.body).toEqual({ status: "waiting", expiresAt: created.body.expiresAt });
    // The family view never reveals the alias.
    expect(JSON.stringify(view.body)).not.toContain("r2");

    expect((await request(a).put("/api/family").set(TOKEN_HEADER, token).send(sub)).status).toBe(200);
    const edited = { favorites: [sub.favorites[0]], avoid: [] };
    expect((await request(a).put("/api/family").set(TOKEN_HEADER, token).send(edited)).status).toBe(200);
    expect((await request(a).get("/api/family").set(TOKEN_HEADER, token)).body.submission).toEqual(edited);

    const status = await request(a).post("/api/invites/status").send({ invites: [{ token, manageKey }, { token: newSecret(), manageKey: newSecret() }] });
    expect(status.status).toBe(200);
    expect(status.body.invites[0]).toMatchObject({ token, found: true, status: "received", residentId: "r2", submission: edited });
    expect(status.body.invites[1]).toMatchObject({ found: false });

    // The family token alone cannot read coordinator status or close the invite.
    const sneaky = await request(a).post("/api/invites/status").send({ invites: [{ token, manageKey: token }] });
    expect(sneaky.body.invites[0]).toEqual({ token, found: false });
    expect((await request(a).post("/api/invites/review").send({ token, manageKey: newSecret() })).status).toBe(404);

    expect((await request(a).post("/api/invites/review").send({ token, manageKey })).body).toEqual({ status: "reviewed" });
    const closed = await request(a).put("/api/family").set(TOKEN_HEADER, token).send(sub);
    expect(closed.status).toBe(409);
    expect(closed.body.reason).toBe("reviewed");
  });

  it("gives friendly errors for missing, malformed and expired links", async () => {
    const a = app();
    const none = await request(a).get("/api/family");
    expect(none.status).toBe(404);
    expect(none.body.error).toMatch(/couldn't find this link/);
    expect((await request(a).get("/api/family").set(TOKEN_HEADER, "../../x")).status).toBe(404);
    expect((await request(a).get("/api/family").set(TOKEN_HEADER, newSecret())).status).toBe(404);

    const dir = tmp();
    let t = Date.now();
    const store = createInvitesStore(dir, { now: () => t });
    const { token } = await store.create("r1");
    t += 15 * DAY;
    const b = createApp({ invites: store, missingKeys: () => [], logRequests: false, serveStatic: false });
    const exp = await request(b).get("/api/family").set(TOKEN_HEADER, token);
    expect(exp.status).toBe(410);
    expect(exp.body.error).toMatch(/expired/);
  });

  it("validates bodies and caps their size", async () => {
    const a = app();
    expect((await request(a).post("/api/invites").send({ residentId: "Margaret" })).status).toBe(400);
    expect((await request(a).post("/api/invites").send({ residentId: "r1", name: "Margaret" })).status).toBe(400);
    const { token } = (await request(a).post("/api/invites").send({ residentId: "r1" })).body as { token: string };
    expect((await request(a).put("/api/family").set(TOKEN_HEADER, token).send({ ...sub, notes: "x" })).status).toBe(400);
    const huge = await request(a)
      .put("/api/family")
      .set(TOKEN_HEADER, token)
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ favorites: [{ kind: "music", text: "x".repeat(20_000) }], avoid: [] }));
    expect(huge.status).toBe(413);
  });

  it("autocomplete needs a live invite and valid input", async () => {
    const a = app();
    const { token } = (await request(a).post("/api/invites").send({ residentId: "r1" })).body as { token: string };
    expect((await request(a).get("/api/family/search").query({ kind: "music", q: "vera" })).status).toBe(404);
    expect((await request(a).get("/api/family/search").set(TOKEN_HEADER, newSecret()).query({ kind: "music", q: "vera" })).status).toBe(404);
    expect((await request(a).get("/api/family/search").set(TOKEN_HEADER, token).query({ kind: "music", q: "v" })).status).toBe(400);
    expect((await request(a).get("/api/family/search").set(TOKEN_HEADER, token).query({ kind: "health", q: "vera" })).status).toBe(400);
    const ok = await request(a).get("/api/family/search").set(TOKEN_HEADER, token).query({ kind: "music", q: "vera" });
    expect(ok.status).toBe(200);
    expect(ok.body.results[0]).toEqual({ id: "A1", name: "Vera Lynn", detail: "1939" });

    const noQloo = app({}, false);
    const t2 = (await request(noQloo).post("/api/invites").send({ residentId: "r1" })).body.token as string;
    expect((await request(noQloo).get("/api/family/search").set(TOKEN_HEADER, t2).query({ kind: "music", q: "vera" })).status).toBe(503);
  });

  it("rate limits create, read, submit and search per IP", async () => {
    const a = app({ createPerHour: 2, readPerHour: 2, submitPerHour: 1, searchPerHour: 1 });
    const t = (await request(a).post("/api/invites").send({ residentId: "r1" })).body.token as string;
    await request(a).post("/api/invites").send({ residentId: "r2" });
    const c = await request(a).post("/api/invites").send({ residentId: "r3" });
    expect(c.status).toBe(429);
    expect(c.body.error).toMatch(/Too many requests/);

    await request(a).get("/api/family").set(TOKEN_HEADER, t);
    await request(a).get("/api/family").set(TOKEN_HEADER, t);
    expect((await request(a).get("/api/family").set(TOKEN_HEADER, t)).status).toBe(429);

    expect((await request(a).put("/api/family").set(TOKEN_HEADER, t).send(sub)).status).toBe(200);
    expect((await request(a).put("/api/family").set(TOKEN_HEADER, t).send(sub)).status).toBe(429);

    await request(a).get("/api/family/search").set(TOKEN_HEADER, t).query({ kind: "music", q: "vera" });
    expect((await request(a).get("/api/family/search").set(TOKEN_HEADER, t).query({ kind: "music", q: "vera" })).status).toBe(429);
  });

  it("enforces the daily invite cap", async () => {
    const a = app({ createDailyCap: 1 });
    expect((await request(a).post("/api/invites").send({ residentId: "r1" })).status).toBe(201);
    expect((await request(a).post("/api/invites").send({ residentId: "r2" })).status).toBe(429);
  });
});

// ---------------------------------------------------------------------------

const resident = (extra: Partial<RosterResident> = {}): RosterResident => ({
  id: "r1",
  name: "Dorothy",
  favorites: [{ kind: "music", text: "Vera Lynn" }],
  unavailableDays: [],
  unavailableTimes: [],
  optOut: [],
  loved: ["E-JAWS"],
  declined: [],
  ...extra,
});

describe("merging accepted family items (browser)", () => {
  it("adds new favorites, skips duplicates, and turns avoids into declined ids", () => {
    const res = mergeFamilyItems(resident(), sub);
    expect(res.added).toBe(2);
    expect(res.resident.favorites.map((f) => f.text)).toEqual(["Vera Lynn", "Italian", "Brief Encounter"]);
    expect(res.resident.declined).toEqual(["E-JAWS"]);
    // A declined title can no longer count as loved.
    expect(res.resident.loved).toEqual([]);
    expect(res.avoided).toBe(1);
    expect(res.resident.name).toBe("Dorothy");
  });

  it("respects the 20-favorite cap and reports what was skipped", () => {
    const full = resident({ favorites: Array.from({ length: 19 }, (_, i) => ({ kind: "music" as const, text: `A${i}` })) });
    const res = mergeFamilyItems(full, { favorites: sub.favorites, avoid: [] });
    expect(res.resident.favorites).toHaveLength(20);
    expect(res.added).toBe(1);
    expect(res.skipped).toBe(2);
  });

  it("adds nothing when everything was rejected", () => {
    const r = resident();
    const res = mergeFamilyItems(r, { favorites: [], avoid: [] });
    expect(res.resident.favorites).toEqual(r.favorites);
    expect(res.added + res.avoided).toBe(0);
  });
});

describe("family links (browser)", () => {
  const token = newSecret();
  it("keeps the label in the fragment and parses it back", () => {
    const url = familyUrl("https://fondly.example", token, "Grandma Rose & co");
    expect(url.startsWith(`https://fondly.example/#/family/${token}?for=`)).toBe(true);
    const hash = url.slice(url.indexOf("#"));
    expect(parseFamilyHash(hash)).toEqual({ token, label: "Grandma Rose & co" });
    expect(parseFamilyHash(`#/family/${token}`)).toEqual({ token });
    expect(parseFamilyHash("#/family/nope")).toBeNull();
    expect(parseFamilyHash(`#/plan/${token}`)).toBeNull();
  });

  it("derives roster status from the link and the server answer", () => {
    const link: FamilyLink = { token, manageKey: newSecret(), createdAt: "2026-10-01T00:00:00Z", expiresAt: "2026-10-15T00:00:00Z" };
    const now = Date.parse("2026-10-05T00:00:00Z");
    expect(linkState(undefined, undefined, now).kind).toBe("none");
    expect(linkState(link, undefined, now).kind).toBe("waiting");
    expect(linkState(link, { token, found: true, status: "received", submission: sub }, now).kind).toBe("received");
    expect(linkState(link, { token, found: false }, now).kind).toBe("expired");
    expect(linkState(link, undefined, Date.parse("2026-10-16T00:00:00Z")).kind).toBe("expired");
    expect(linkState({ ...link, reviewedAt: "2026-10-06T00:00:00Z" }, undefined, now).kind).toBe("reviewed");
  });
});
