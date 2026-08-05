# Hosting migration value scorecard — baseline (before)

**Scorecard captured:** 2026-07-30 (UTC)  
**Dual-host live metrics captured:** 2026-08-02 (UTC) — see machine record  
**Serving shape:** GitHub Pages origin hostname + Worker mirror on `cityscroll.org` / `www`, parallel Cloudflare Pages host on `cityscroll.pages.dev`  
**Machine record:** [`hosting-migration-baseline.json`](./hosting-migration-baseline.json)  
**Full dual-host receipt:** [`hosting-dual-host-metrics.json`](./hosting-dual-host-metrics.json)

This is the **before** side of the migration value scorecard. The migration’s claimed value — ship faster, catch breaks faster, roll back instantly — is **measured after cutover** against these numbers, not asserted up front.

Nothing here changes production DNS or host ownership. The dual-host harness is **read-only**.

## Dual-host live metrics (measured pre-cutover)

Harness: `node tools/measure_hosting_baseline.mjs`  
Samples: **5** per host/path across **10** paths (route inventory + apple-touch-icon).

| Host | Role | Availability | TTFB median (ms) | Redirects |
| --- | --- | ---: | ---: | --- |
| `cityscroll.org` | Worker mirror (visitor production) | 10/10 | ~43 | direct 200 |
| `www.cityscroll.org` | Worker mirror (www) | 10/10 | ~45 | direct 200 |
| `cityscroll.pages.dev` | Cloudflare Pages parallel host | 10/10 | ~19 | pretty-URL 308 then 200 on `*.html` |
| `crol-list.org` | Documented GH Pages origin hostname | 10/10 | ~12 (301 hop) | single 301 → `cityscroll.org` (not a loop) |

**Payload parity** (production mirror vs Pages parallel, final body after redirects): **10/10** (rate 1.0), SHA-256 match on all sampled paths.

**Cache headers:** sampled responses carry `cache-control: public, max-age=0, must-revalidate`. `CF-Cache-Status` / `Age` were **not present** on samples. `x-github-request-id` was **absent** on visitor-facing hosts (consistent with Worker/Pages edge, not a raw GitHub Pages browser response).

**Redirect-loop class (2026-07-30):** no loops detected. Legacy hostname redirect is a single hop to `cityscroll.org`, not the mutual 301 loop documented in `test/fixtures/live_url_smoke/field-case-2026-07-30.json`.

Exact numbers, per-path samples, and provenance live in the JSON files (not restated here so the prose does not drift).

## Merge-to-live wall-clock (measured)

Workflow: **Deploy site** (`.github/workflows/deploy-pages.yml`) — build + GitHub Pages deploy + live-URL smoke.

| Metric | Value |
| --- | --- |
| Samples (successful `main` runs, 2026-07-30) | 8 |
| Median | **74.5 s** |
| Mean | **74.1 s** |
| Min / max | 52 s / 110 s |

Method: GitHub Actions `run_started_at` → `updated_at`. Run ids and titles are listed in the JSON.

Not included: multi-minute edge redirect-cache lag after a bad CNAME/DNS change (~10 minute class; see live-URL smoke retry window).

## Detection latency exemplars (today’s incident classes)

| Class | How it was found | Latency | Gate that encodes it now |
| --- | --- | --- | --- |
| Redirect loop while deploy green | Manual browser | Not stopwatch-quantified; human found while CI was green | Default URL smoke + **HUMAN-PATH JOURNEY** |
| Silent digest (`sent_today=0`, no receipt) | Manual operational-stats read | **6–10 min** after 13:00 UTC cron (reads at 13:06 / 13:10) | **EMAIL HEALTH** + **STATS SANITY** on authenticated desk data |
| API/CORS dead while HTML 200 | Feature/console | Class inventory (not a timed outage sample) | **WORKER ACCESS** |

## Rollback time (estimated from runbook)

Operator sequence (dashboard-first): remove Pages custom domains for apex/www → restore Worker custom domains → re-smoke.

| Bound | Minutes | Tag |
| --- | --- | --- |
| Operator action | 5–15 | estimated |
| Extra visitor recovery (cache lag) | 0–12 | estimated |

After cutover, replace this with a timed drill in `after_cutover.rollback_wall_clock` in the JSON.

## Re-run after cutover (one command)

When an **authorized** hosting flip has completed (or for a later dual-host re-sample), re-measure without changing routing from this harness:

```bash
node tools/measure_hosting_baseline.mjs \
  --phase after-cutover \
  --samples 5 \
  --out-receipt docs/evidence/hosting-dual-host-metrics-after.json \
  --write-baseline docs/evidence/hosting-migration-baseline.json
```

That command is **read-only**: it only fetches public URLs and writes evidence JSON under `docs/evidence/`. It does not edit DNS, Worker routes, Pages custom domains, or deploy config.

Then fill the remaining scorecard fields in `after_cutover` from deploy history and timed drills:

1. Deploy wall-clock samples (Pages-primary or equivalent workflow)  
2. Time from failure injection / first bad probe to red gate  
3. Timed rollback drill wall-clock  

Only then claim ship-faster / catch-faster / roll-back-instantly with numbers. Dual-host metrics may be re-measured independently of those three fields.

Characterization tests (offline fixtures): `node --test test/measure_hosting_baseline.test.mjs`.
