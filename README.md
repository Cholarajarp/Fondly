<p align="center"><img src="docs/banner.jpg" alt="Fondly — Activities every resident loves" width="100%"></p>

# Fondly

**A weekly activity planner for care homes. Every resident gets at least one session built around what they love, and every match is backed by Qloo taste data.**

An activity coordinator lists residents and the music, films, TV, books, games, sports and food they love. Fondly's agent uses the Qloo Taste API and Gemini to build a week of group sessions that reaches every resident, then explains why each pick fits. The plan comes with per-resident match reasons, staff briefs, a family newsletter, and a side-by-side comparison against two baselines.

Built for the **Qloo Agentic Hackathon**.

**Try it:** [fondly-7trs.onrender.com](https://fondly-7trs.onrender.com/). Click **Load sample home**, then **Plan this week**. You'll watch the agent call Qloo live (about a minute), then get the calendar, match reasons, newsletter and baseline comparison.

## Why it's different

- **Every number comes from code.** Gemini decides which steps to run and writes the briefs and newsletter. Fits, reach and the schedule come from Qloo affinity and a deterministic optimizer. The plan can only contain entities Qloo actually returned.
- **Fair, not popular.** The optimizer maximizes how many residents get a strong match (fit ≥ 0.8), then lifts the least-served resident, respecting availability and opt-outs.
- **Compared honestly.** The same slots are filled two other ways and scored with the same Qloo fits: Qloo's most popular titles, and the same Gemini model working without Qloo.
- **It learns.** Mark sessions *loved* or *declined* per resident. "Plan next week" uses loved titles as new taste signals, never repeats declined ones, and excludes last week's titles.
- **Names stay in the browser.** Resident names live in localStorage. The server, Qloo and Gemini see only aliases (`r1`, `r2`…) and the public cultural favorites. No health data is collected.
- **It always finishes.** If Gemini fails or runs out of time, a deterministic pipeline completes the plan from Qloo data.

- **Ready to run Monday.** Each session opens a kit: Qloo facts, YouTube/Spotify/library/map search links, a 60-second read-aloud, conversation prompts, adaptation tips and a gentle quiz, plus a large-print handout. Gemini writes only from the Qloo facts and the kit is cached, so reopening it is instant and free. The week exports as an `.ics` calendar and a one-page noticeboard poster with no resident names.

## How it works

```text
Browser (React) ── aliases only ──▶ POST /api/plan  (Server-Sent Events)
                                     │
                                     ├─ Gemini agent: tool calls, briefs, newsletter
                                     │    resolve_favorites ─▶ build_candidates ─▶ score_residents
                                     │    ─▶ build_baseline ─▶ optimize ─▶ record_sessions ─▶ finish
                                     ├─ pipeline: every Qloo call, fits from Qloo affinity
                                     ├─ optimizer: max-min scheduler, no model involved
                                     └─ safety net: runs any step the agent skipped
                                     │
                     Qloo client (4 concurrent, retries, shared 429 cooldown, disk cache)
                                     │
                     Qloo Taste API: /search · /v2/tags · /v2/insights
```

Design details are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

1. **Resolve favorites.** Each favorite is matched to a Qloo entity via `/search`; foods resolve to tags via `/v2/tags`.
2. **Build candidates.** `/v2/insights` turns the group's combined taste into candidates per session type (artists, movies, TV, books, games, sports teams, and local venues for outings).
3. **Score every resident.** A per-resident `/v2/insights` call with `filter.results.entities` and explainability gives each resident's affinity for each candidate.
4. **Optimize for fairness.** Greedy construction plus local search assigns one candidate per slot, maximizing reach, then the least-served fit.
5. **Compare.** Both baselines are scored on the same residents with the same metric.
6. **Write it up.** Gemini records a title and brief per session, a staff summary and a newsletter. Titles that don't name the scheduled item fall back to templates.

## Surfaces

| Surface | Path | Access |
| --- | --- | --- |
| Planner UI | `/` | Public |
| Health | `GET /api/health` | Public, booleans only |
| Plan a week | `POST /api/plan` (SSE) | Public, rate limited |
| Re-plan (edit or next week) | `POST /api/plans/:id/replan` (SSE) | Public, rate limited |
| Intake notes to favorites | `POST /api/intake` | Public, rate limited |
| Saved plan | `GET /api/plans/:id` | Public, by UUID |
| Session kit (facts, links, read-aloud, prompts, quiz) | `POST /api/plans/:id/sessions/:sid/kit` | Public, rate limited, cached per session |
| Calendar file and noticeboard poster | `fondly-week.ics` download and print view, built in the browser | Public |

## Run it locally

Requires Node 22.19+.

```bash
npm install
cp .env.example .env   # add QLOO_API_KEY and GEMINI_API_KEY
npm run smoke          # checks every Qloo call Fondly makes
npm run dev            # API on :3000, web on :5173 (proxies /api)
```

Both keys are required. There is no mock mode: without keys the server boots and reports health, but planning endpoints return `503`. A free-tier Gemini key from Google AI Studio works.

`npm test` runs the unit tests (in-memory fakes), `npm run typecheck` runs `tsc`, and `npm run build && npm start` serves the production build.

## Deploy to Render

`render.yaml` is a Render Blueprint: one Starter web service in Oregon with a 1 GB persistent disk at `/var/data` for the Qloo response cache and saved plans (`CACHE_DIR=/var/data/cache`). The health check is `/api/health`.

Set `QLOO_API_KEY` and `GEMINI_API_KEY` in the Render dashboard (`sync: false`, so they never live in the repo). Everything else (`QLOO_BASE_URL`, `GEMINI_MODEL`, `GEMINI_THINKING`, `PUBLIC_RATE_LIMIT_PER_HOUR=20`) is set in the Blueprint.

## Security and limitations

- API keys are read from the environment only. Qloo error messages redact the key, and config errors report variable names, never values.
- No login. The public demo is protected by limits, not auth: 20 plans per IP per hour, 3 concurrent runs, and a daily plan cap (`DAILY_PLAN_CAP`, default 200).
- Strict CSP, `X-Frame-Options: DENY`, 256 KB JSON body limit, Zod validation on every request and tool input. Errors sent to clients never include stacks or upstream bodies.
- Saved plans are readable by anyone with the plan's UUID. They hold aliases and favorites only, never names.
- Single instance. Rate limits and the daily cap are in memory and reset on restart; cache and plans live on one disk.

## Project layout

| Path | What it is |
| --- | --- |
| `server/app.ts`, `server/index.ts` | Express app, security headers, static hosting, lazy client setup |
| `server/routes/` | `/api/plan`, re-plan, intake, saved plans (SSE streaming, limits); `/api/health` |
| `server/agent/` | Gemini agent loop, tool definitions, prompts, structured-output helpers |
| `server/engine/pipeline.ts` | Plan state and every Qloo call: resolve, candidates, scoring, baselines, plan assembly |
| `server/engine/optimize.ts` | Deterministic max-min scheduler |
| `server/engine/qloo-ops.ts` | Qloo request builders and entity filters |
| `server/qloo/` | Qloo client (retries, concurrency, cooldown), disk cache, param validation |
| `server/plans-store.ts` | File-based plan store with retention |
| `shared/types.ts` | Types shared by server and web |
| `web/src/` | React UI: roster editor, agent timeline, plan view |
| `scripts/smoke-qloo.ts` | Live check of every Qloo call |
| `tests/` | Vitest suites |

TypeScript, Express 5, React 19, Vite, `@google/genai`, Zod, Vitest.

## License

[MIT](LICENSE).
