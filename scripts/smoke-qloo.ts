// Live smoke test for every Qloo call Fondly makes. Run after adding QLOO_API_KEY: `npm run smoke [city]`.
// Prints pass/fail per call and entity names only, never the key.
import "dotenv/config";
import { createQlooClient } from "../server/qloo/client.ts";
import {
  baselineParams,
  outingParams,
  rankFits,
  recommendParams,
  resolveEntity,
  scoreParams,
} from "../server/engine/qloo-ops.ts";

const city = process.argv[2] ?? "Chicago";
const qloo = createQlooClient();

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];

async function check(name: string, fn: () => Promise<string>) {
  const t = Date.now();
  try {
    const detail = await fn();
    checks.push({ name, ok: true, detail: `${detail} (${Date.now() - t}ms)` });
  } catch (err) {
    checks.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) });
  }
}

const names = (xs: { name: string }[], n = 4) => xs.slice(0, n).map((x) => x.name).join(" | ");
let sinatra = "";
let cash = "";
let candidates: string[] = [];
let tagId = "";

await check("search artist (resolve_favorites)", async () => {
  const [a] = await qloo.searchEntities("Frank Sinatra", ["urn:entity:artist"], 5);
  const [b] = await qloo.searchEntities("Johnny Cash", ["urn:entity:artist"], 5);
  if (!a || !b) throw new Error("artist not found");
  sinatra = a.entity_id;
  cash = b.entity_id;
  return `${a.name}, ${b.name}`;
});

await check("search movie/book/tv", async () => {
  const [m] = await qloo.searchEntities("Casablanca", ["urn:entity:movie"], 5);
  const [b] = await qloo.searchEntities("Agatha Christie", ["urn:entity:book"], 5);
  const [t] = await qloo.searchEntities("I Love Lucy", ["urn:entity:tv_show"], 5);
  if (!m || !b || !t) throw new Error(`missing: ${[!m && "movie", !b && "book", !t && "tv"].filter(Boolean).join(",")}`);
  return `${m.name} | ${b.name} | ${t.name}`;
});

await check("food tags (search_tags)", async () => {
  const tags = await qloo.searchTags("Italian", 10);
  if (!tags.length) throw new Error("no tags");
  tagId = tags[0]!.id;
  return tags.slice(0, 3).map((t) => t.id).join(", ");
});

await check("group candidates (build_candidates)", async () => {
  const r = await qloo.insights(recommendParams("music", [sinatra, cash]));
  if (!r.length) throw new Error("no candidates");
  candidates = r.map((e) => e.entity_id);
  return `${r.length} artists: ${names(r)}`;
});

await check("per-resident affinity (score_residents)", async () => {
  const r = await qloo.insights(scoreParams("music", [sinatra], candidates));
  const fits = rankFits(r);
  if (!fits.size) throw new Error("no affinity scores returned");
  const explained = r.filter((e) => e.explainability).length;
  return `${fits.size} scored, explainability on ${explained}/${r.length}`;
});

await check("baseline (build_baseline)", async () => {
  const r = await qloo.insights(baselineParams("film"));
  if (!r.length) throw new Error("empty baseline");
  return names(r);
});

for (const [domain, fav] of [
  ["gaming", "Pac-Man"],
  ["sports", "Chicago Cubs"],
] as const) {
  await check(`${domain}: resolve, recommend, baseline`, async () => {
    const e = await resolveEntity(qloo, domain, fav);
    if (!e) throw new Error(`could not resolve ${fav}`);
    const recs = await qloo.insights(recommendParams(domain, [e.entity_id], { take: 8 }));
    if (!recs.length) throw new Error("no recommendations");
    const base = await qloo.insights(baselineParams(domain));
    if (!base.length) throw new Error("empty baseline");
    return `${e.name} -> ${names(recs)} || baseline: ${names(base, 3)}`;
  });
}

await check(`outings in ${city}`, async () => {
  const r = await qloo.insights(outingParams(city, [], tagId ? [tagId] : []));
  if (!r.length) throw new Error("no venues");
  return names(r);
});

for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}: ${c.detail}`);
console.log(`\nQloo HTTP calls: ${qloo.callCount()}`);
process.exit(checks.every((c) => c.ok) ? 0 : 1);
