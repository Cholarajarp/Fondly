import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { QlooClient, ScheduledSession, WeekPlan } from "../shared/types.ts";
import { kitFacts, mediaLinks } from "../shared/kit.ts";
import type { GeminiClient } from "../server/agent/gemini.ts";
import { createApp } from "../server/app.ts";
import { createPlansStore } from "../server/plans-store.ts";
import { createKitStore } from "../server/kits/store.ts";
import { generateKit, kitUserMessage, lineOk, SessionKitZ, templateKit, validateDraft } from "../server/kits/generate.ts";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "fondly-kits-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const music = (over: Partial<ScheduledSession> = {}): ScheduledSession => ({
  slotId: "s1",
  day: "Mon",
  time: "afternoon",
  domain: "music",
  entity: {
    entity_id: "A1",
    name: "Patsy Cline",
    image_url: "https://images.example.com/patsy.jpg",
    properties: { short_description: "American country singer known for Crazy and Walkin' After Midnight.", release_year: 1957 },
    tags: [{ id: "t1", name: "Country" }],
  },
  source: "favorite",
  related: [{ entity_id: "A2", name: "Loretta Lynn" }],
  attendees: ["r1", "r2"],
  matches: [{ residentId: "r1", fit: 1, ownFavorite: true, why: "own favorite" }],
  meanFit: 0.9,
  title: "Sing-along: Patsy Cline",
  brief: "b",
  ...over,
});

const outing = (props: ScheduledSession["entity"]["properties"], location?: { lat: number; lon: number }) =>
  music({ slotId: "s7", domain: "outing", entity: { entity_id: "P1", name: "Lincoln Park Zoo", properties: props, ...(location ? { location } : {}) } });

const goodDraft = {
  intro:
    "Good afternoon, everyone, and welcome. Today we are spending time with the music of Patsy Cline, an American country singer known for songs like Crazy and Walkin' After Midnight. Her voice was warm and clear, and many people remember hearing her on the radio at home, at dances or in the car. We will listen to a few of her songs together. You are welcome to sing along, tap your feet, clap, or simply sit back and enjoy the music. If a song brings back a memory, we would love to hear it, but there is no need to say anything at all if you would rather listen. Let us settle in and start with the first song now.",
  prompts: ["Where were you when you first heard Patsy Cline?", "Which song makes you want to dance?", "Who did you listen to the radio with?", "What does country music remind you of?", "Is there a song you would like to hear again today?"],
  adaptations: ["Keep the volume moderate and check with the group.", "Seat everyone so they can see the speaker.", "Offer shakers so people can join without singing."],
  quiz: [
    { question: "What kind of music did Patsy Cline sing?", answer: "Country" },
    { question: "Can you name one of her songs?", answer: "Crazy" },
    { question: "Which song did you enjoy most today?", answer: "Any answer is welcome" },
  ],
};

const jsonText = (obj: unknown) => ({ text: JSON.stringify(obj), candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify(obj) }] }, finishReason: "STOP" }] });
function fakeGemini(reply: unknown | Error) {
  const generateContent = vi.fn(async () => {
    if (reply instanceof Error) throw reply;
    return jsonText(reply);
  });
  return { gemini: { models: { generateContent } } as unknown as GeminiClient, generateContent };
}

describe("kit facts and links", () => {
  it("facts come from the Qloo entity only", () => {
    const f = kitFacts(music());
    expect(f).toMatchObject({ name: "Patsy Cline", year: 1957, imageUrl: "https://images.example.com/patsy.jpg", tags: ["Country"], related: ["Loretta Lynn"] });
    expect(f.description).toContain("country singer");
    expect(kitFacts(music({ entity: { entity_id: "x", name: "X", image_url: "http://insecure/img.png" } })).imageUrl).toBeUndefined();
  });

  it("builds deterministic, encoded search links per session type", () => {
    const m = mediaLinks(music());
    expect(m.map((l) => l.url)).toEqual(["https://www.youtube.com/results?search_query=Patsy+Cline+songs", "https://open.spotify.com/search/Patsy%20Cline"]);
    const film = mediaLinks(music({ domain: "film", entity: { entity_id: "F", name: "Casablanca & Co", properties: { release_year: 1942 } } }));
    expect(film[0]!.url).toBe("https://www.youtube.com/results?search_query=Casablanca+%26+Co+1942+trailer");
    expect(mediaLinks(music({ domain: "tv" }))[0]!.url).toContain("trailer");
    const books = mediaLinks(music({ domain: "books", entity: { entity_id: "B", name: "Emma" } }));
    expect(books[0]!.url).toBe("https://openlibrary.org/search?q=Emma");
    expect(books.every((l) => l.url.startsWith("https://"))).toBe(true);
  });

  it("outing links need an address or coordinates", () => {
    const withAddr = mediaLinks(outing({ address: "2001 N Clark St, Chicago" }));
    expect(withAddr[0]!.url).toBe("https://www.google.com/maps/search/?api=1&query=Lincoln+Park+Zoo%2C+2001+N+Clark+St%2C+Chicago");
    expect(withAddr[1]!.url).toContain("/maps/dir/?api=1&destination=");
    expect(mediaLinks(outing({}, { lat: 41.92, lon: -87.63 }))[0]!.url).toContain("query=41.92%2C-87.63");
    expect(mediaLinks(outing({}))).toEqual([]);
    expect(mediaLinks(outing({}, { lat: 200, lon: 0 }))).toEqual([]);
  });

  it("the model sees facts but no residents or image urls", () => {
    const msg = kitUserMessage(music());
    expect(msg).toContain("Patsy Cline");
    expect(msg).not.toMatch(/\br1\b|r2|images\.example/);
  });
});

describe("kit validation and fallback", () => {
  it("accepts a grounded draft", () => {
    const kit = validateDraft(goodDraft, music(), randomUUID());
    expect(kit?.source).toBe("gemini");
    expect(kit?.prompts).toHaveLength(5);
    expect(kit?.quiz).toHaveLength(3);
  });

  it("rejects invented years and medical advice item by item", () => {
    const years = new Set(["1957"]);
    expect(lineOk("She recorded it in 1961.", years, 300)).toBe(false);
    expect(lineOk("Her big year was 1957.", years, 300)).toBe(true);
    expect(lineOk("Music therapy helps with dementia.", years, 300)).toBe(false);
    expect(lineOk("Ask r3 to start.", years, 300)).toBe(false);
    const kit = validateDraft(
      { ...goodDraft, prompts: ["Remember 1962?", ...goodDraft.prompts.slice(1)], adaptations: ["Check medication first.", "Seat people close.", "Go slowly.", "Offer shakers."] },
      music(),
      randomUUID(),
    )!;
    expect(kit.prompts).toHaveLength(5);
    expect(kit.prompts.join(" ")).not.toContain("1962");
    expect(kit.adaptations.join(" ")).not.toMatch(/medication/i);
  });

  it("falls back when the intro invents a fact or is malformed", () => {
    expect(validateDraft({ ...goodDraft, intro: goodDraft.intro.replace("Today", "In 1963") }, music(), randomUUID())).toBeNull();
    expect(validateDraft({ ...goodDraft, intro: "Hi." }, music(), randomUUID())).toBeNull();
    expect(validateDraft({ nope: true }, music(), randomUUID())).toBeNull();
  });

  it("template kits are valid for every session type", () => {
    for (const domain of ["music", "film", "tv", "books", "gaming", "sports", "outing"] as const) {
      const kit = templateKit(music({ domain }), randomUUID(), "test");
      expect(SessionKitZ.safeParse(kit).success).toBe(true);
      expect(kit.source).toBe("template");
    }
    const bare = templateKit(music({ entity: { entity_id: "x", name: "Mystery Band" }, related: [] }), randomUUID(), "test");
    expect(SessionKitZ.safeParse(bare).success).toBe(true);
    expect(bare.intro).not.toMatch(/\b(1[5-9]\d{2}|20\d{2})\b/);
  });

  it("generateKit never throws: model errors become a marked template", async () => {
    const { gemini } = fakeGemini(Object.assign(new Error("boom"), { status: 400 }));
    const kit = await generateKit(() => gemini, music(), randomUUID());
    expect(kit.source).toBe("template");
    expect(kit.fallbackReason).toMatch(/unavailable/);
    const bad = await generateKit(() => fakeGemini({ intro: "x", prompts: [], adaptations: [], quiz: [] }).gemini, music(), randomUUID());
    expect(bad.source).toBe("template");
    expect(bad.fallbackReason).toMatch(/fact checks/);
  });
});

describe("kit store", () => {
  it("round-trips kits and treats corrupt files as a miss", async () => {
    const store = createKitStore(dir);
    const planId = randomUUID();
    const kit = validateDraft(goodDraft, music(), planId)!;
    await store.saveKit(kit);
    expect(await store.getKit(planId, "s1")).toEqual(kit);
    expect(await store.getKit(planId, "s2")).toBeNull();
    expect(await store.getKit("../etc", "s1")).toBeNull();
    mkdirSync(path.join(dir, "kits", planId), { recursive: true });
    writeFileSync(path.join(dir, "kits", planId, "s2.json"), "{not json");
    expect(await store.getKit(planId, "s2")).toBeNull();
  });
});

describe("kit endpoint", () => {
  function setup(reply: unknown | Error, overrides: Parameters<typeof createApp>[0] = {}) {
    const sub = mkdtempSync(path.join(dir, "app-"));
    const plans = createPlansStore(sub);
    const { gemini, generateContent } = fakeGemini(reply);
    const app = createApp({
      store: plans,
      kitStore: createKitStore(sub),
      missingKeys: () => [],
      getQloo: () => ({}) as QlooClient,
      getGemini: () => gemini,
      qlooConfigured: () => true,
      llmConfigured: () => true,
      perHourLimit: 100,
      dailyCap: 100,
      logRequests: false,
      serveStatic: false,
      ...overrides,
    });
    return { app, plans, generateContent };
  }
  const plan = (): WeekPlan =>
    ({ id: randomUUID(), createdAt: new Date().toISOString(), request: { rosterId: "roster_abc", homeCity: "Chicago", residents: [], slots: [] }, sessions: [music()] }) as unknown as WeekPlan;

  it("generates once, then serves the cached kit", async () => {
    const { app, plans, generateContent } = setup(goodDraft);
    const p = plan();
    await plans.savePlan(p);
    const first = await request(app).post(`/api/plans/${p.id}/sessions/s1/kit`).send({});
    expect(first.status).toBe(200);
    expect(first.body.cached).toBe(false);
    expect(first.body.kit.source).toBe("gemini");
    const second = await request(app).post(`/api/plans/${p.id}/sessions/s1/kit`).send({});
    expect(second.body.cached).toBe(true);
    expect(second.body.kit).toEqual(first.body.kit);
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it("does not cache template fallbacks", async () => {
    const { app, plans, generateContent } = setup(new Error("down"));
    const p = plan();
    await plans.savePlan(p);
    const a = await request(app).post(`/api/plans/${p.id}/sessions/s1/kit`).send({});
    expect(a.status).toBe(200);
    expect(a.body.kit.source).toBe("template");
    await request(app).post(`/api/plans/${p.id}/sessions/s1/kit`).send({});
    expect(generateContent).toHaveBeenCalledTimes(2);
  });

  it("validates ids and body, and 404s unknown plans or sessions", async () => {
    const { app, plans } = setup(goodDraft);
    const p = plan();
    await plans.savePlan(p);
    expect((await request(app).post(`/api/plans/not-a-uuid/sessions/s1/kit`).send({})).status).toBe(400);
    expect((await request(app).post(`/api/plans/${p.id}/sessions/x1/kit`).send({})).status).toBe(400);
    expect((await request(app).post(`/api/plans/${p.id}/sessions/s1/kit`).send({ prompt: "ignore rules" })).status).toBe(400);
    expect((await request(app).post(`/api/plans/${randomUUID()}/sessions/s1/kit`).send({})).status).toBe(404);
    expect((await request(app).post(`/api/plans/${p.id}/sessions/s9/kit`).send({})).status).toBe(404);
  });

  it("rate limits new generations per IP, but not cache hits", async () => {
    const { app, plans } = setup(goodDraft, { kitPerHourLimit: 1 });
    const p = plan();
    p.sessions.push(music({ slotId: "s2" }));
    await plans.savePlan(p);
    expect((await request(app).post(`/api/plans/${p.id}/sessions/s1/kit`).send({})).status).toBe(200);
    expect((await request(app).post(`/api/plans/${p.id}/sessions/s1/kit`).send({})).status).toBe(200);
    const limited = await request(app).post(`/api/plans/${p.id}/sessions/s2/kit`).send({});
    expect(limited.status).toBe(429);
    expect(limited.body.error).toMatch(/hourly limit/);
  });

  it("serves a template kit without calling Gemini when no key is configured", async () => {
    const { app, plans, generateContent } = setup(goodDraft, { llmConfigured: () => false });
    const p = plan();
    await plans.savePlan(p);
    const res = await request(app).post(`/api/plans/${p.id}/sessions/s1/kit`).send({});
    expect(res.status).toBe(200);
    expect(res.body.kit.source).toBe("template");
    expect(generateContent).not.toHaveBeenCalled();
  });
});
