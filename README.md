<p align="center"><img src="docs/banner.jpg" alt="Fondly — Activities every resident loves" width="100%"></p>

# Fondly

A weekly activity planner for care homes. An activity coordinator lists residents and the music, films, TV, books and food they love; Fondly's agent uses the Qloo Taste API and Gemini to build a week of group sessions that reaches every resident, then explains why each pick fits.

Built for the Qloo Agentic Hackathon.

## Try it

Open the live demo, click **Load sample home**, then **Plan this week**. You'll watch the agent call Qloo live (about a minute), then get a calendar, per-resident match reasons, a newsletter, and a side-by-side comparison against two baselines.

## How it works

1. **Resolve favorites.** Each favorite is matched to a Qloo entity via `/search`; foods resolve to place tags via `/v2/tags`.
2. **Build candidates.** `/v2/insights` turns the group's combined taste into candidates per domain (artists, movies, TV, books, and local venues for outings).
3. **Score every resident.** A per-resident `/v2/insights` call with `filter.results.entities` and explainability gives each resident's affinity for each candidate.
4. **Optimize for fairness.** A local-search optimizer assigns candidates to slots, maximizing how many residents get a strong match while respecting availability and opt-outs.
5. **Compare honestly.** The same slots are filled two other ways and scored with the same Qloo fits: Qloo's most popular titles, and Gemini working without Qloo.
6. **Learn from feedback.** Mark sessions *loved* or *declined* per resident; "Plan next week" uses loved titles as new taste signals and never repeats declined ones.

Gemini drives the steps through tool calls and writes the session briefs and newsletter. All numbers come from code, not the model. If Gemini fails, a deterministic pipeline finishes the plan from Qloo data.

## Privacy

Resident names stay in the browser (localStorage). The server, Qloo and Gemini see only aliases (`r1`, `r2`…) and the public cultural favorites. No health data is collected.

## Run locally

Requires Node 22.19+.

```bash
npm install
cp .env.example .env   # add QLOO_API_KEY and GEMINI_API_KEY
npm run smoke          # checks every Qloo call Fondly makes
npm run dev            # API on :3000, web on Vite's port
```

`npm test` runs the unit tests (in-memory fakes; the app itself has no mock mode). `npm run build && npm start` serves the production build.

## Deploy

`render.yaml` is a Render Blueprint: one web service with a 1 GB disk for the Qloo response cache. Set `QLOO_API_KEY` and `GEMINI_API_KEY` in the Render dashboard. Public endpoints are rate limited per IP and capped per day to protect API quota.

## Stack

TypeScript, Express, React, Vite, `@google/genai`, Zod, Vitest.

## License

MIT
