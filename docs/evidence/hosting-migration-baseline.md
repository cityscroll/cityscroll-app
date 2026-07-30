# Hosting migration value scorecard — baseline (before)

**Captured:** 2026-07-30 (UTC)  
**Serving shape:** GitHub Pages origin, Worker mirror on `cityscroll.org` / `www`  
**Machine record:** [`hosting-migration-baseline.json`](./hosting-migration-baseline.json)

This is the **before** side of the migration value scorecard. The migration’s claimed value — ship faster, catch breaks faster, roll back instantly — is **measured after cutover** against these numbers, not asserted up front.

Nothing here changes production DNS or host ownership.

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
| Silent digest (`sent_today=0`, no receipt) | Manual `/stats` | **6–10 min** after 13:00 UTC cron (reads at 13:06 / 13:10) | **EMAIL HEALTH** + **STATS SANITY** |
| API/CORS dead while HTML 200 | Feature/console | Class inventory (not a timed outage sample) | **WORKER ACCESS** |

## Rollback time (estimated from runbook)

Operator sequence (dashboard-first): remove Pages custom domains for apex/www → restore Worker custom domains → re-smoke.

| Bound | Minutes | Tag |
| --- | --- | --- |
| Operator action | 5–15 | estimated |
| Extra visitor recovery (cache lag) | 0–12 | estimated |

After cutover, replace this with a timed drill in `after_cutover.rollback_wall_clock` in the JSON.

## After cutover

Leave `after_cutover` in the JSON as `not-yet-measured` until a flip has actually run. Compare:

1. Deploy site (or Pages-primary equivalent) wall-clock samples  
2. Time from failure injection / first bad probe to red gate  
3. Timed rollback drill wall-clock  

Only then claim ship-faster / catch-faster / roll-back-instantly with numbers.
