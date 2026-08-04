# Static-hosting migration value scorecard — pre-cutover baseline

**Captured:** 2026-08-03 UTC

**Decision stage:** Cloudflare Pages parallel deployment; production routing unchanged

**After-soak verdict:** [open the measured button page](./migration-value-verdict.html)
or inspect the [machine-readable receipt](./migration-value-verdict.json).

**Related evidence:** [fresh route parity](./cloudflare-pages-route-parity.md),
[existing machine-readable baseline](./hosting-migration-baseline.json), and
[dual-host measurements](./hosting-dual-host-metrics.json)

This is the before-side value baseline for a later hosting decision. It does
not claim that a cutover will improve delivery speed or reliability. No DNS,
custom-domain, Worker-route, or GitHub Pages setting was changed while
collecting it.

## Scorecard

| Metric | Classification | Baseline | Method and source | Known gap |
| --- | --- | --- | --- | --- |
| Current-path merge-to-live proxy | **Measured** | 10 recent successful `main` runs: **56 s median**, 55.5 s mean, 49–64 s range | First to last timestamp in the complete logs for the 10 latest successful **Deploy site** runs on 2026-08-02; run links are below | Runner wall-clock excludes queue delay before the first log line and any propagation after the final smoke line, so it is a workflow-completion proxy rather than a browser-observed merge-to-live stopwatch |
| New-check confirmation latency | **Measured** | Latest parallel deploy: smoke green **18.7 s** and full parity PASS **20.6 s** after the deploy action reported completion | [Deploy Cloudflare Pages run 30767177902](https://github.com/cityscroll/crol-list/actions/runs/30767177902): deploy complete at `21:08:13.751Z`, smoke green at `21:08:32.406Z`, parity PASS at `21:08:34.371Z` | This is healthy-path confirmation latency, not a timed failure injection |
| Persistent-failure detection window | **Derived from configuration** | Each Pages deployment runs smoke and route parity with a **12-minute retry window** and 20-second retry interval | `.github/workflows/deploy-cloudflare-pages.yml`, `tools/live_url_smoke.mjs`, and `tools/pages_route_parity.mjs` | An active HTTP probe can finish just after the configured window; no controlled failing deployment was introduced for this baseline |
| Rollback drill time | **Unmeasured planning range; dry review only** | **5–15 min** of operator action, plus **0–12 min** of possible visitor recovery | Range carried forward from `hosting-migration-baseline.json`, derived from the operator-controlled **Static Hosting Cutover Runbook** | No rollback was executed or timed; replace this planning range only after an authorized drill |
| Failures caught by gates versus people | **Measured run-history count, with one documented human field case** | Gates: **4 failed runs / 2 failure classes** in available deploy-workflow history. People: **1 documented visitor-visible failure class** while deploy CI was green; its discovery latency is unknown | Workflow-history query and failed logs described below; human case is the 2026-07-30 redirect-loop fixture and the existing baseline | Failed runs are gate activations, not necessarily production incidents. The available history is too small for a rate or trend claim |

## Current-path timing sample

The current production path is the **Deploy site** workflow. Durations below
come from complete workflow logs for the 10 latest successful `main` pushes at
capture time.

| Run | First log (UTC) | Last log (UTC) | Wall-clock |
| --- | --- | --- | ---: |
| [30767177880](https://github.com/cityscroll/crol-list/actions/runs/30767177880) | 21:07:42 | 21:08:39 | 58 s |
| [30766546649](https://github.com/cityscroll/crol-list/actions/runs/30766546649) | 20:51:12 | 20:52:11 | 59 s |
| [30765796211](https://github.com/cityscroll/crol-list/actions/runs/30765796211) | 20:30:58 | 20:31:49 | 51 s |
| [30764952769](https://github.com/cityscroll/crol-list/actions/runs/30764952769) | 20:08:42 | 20:09:31 | 49 s |
| [30764290572](https://github.com/cityscroll/crol-list/actions/runs/30764290572) | 19:51:16 | 19:52:05 | 49 s |
| [30763893217](https://github.com/cityscroll/crol-list/actions/runs/30763893217) | 19:40:22 | 19:41:26 | 64 s |
| [30762919768](https://github.com/cityscroll/crol-list/actions/runs/30762919768) | 19:14:27 | 19:15:26 | 59 s |
| [30762563690](https://github.com/cityscroll/crol-list/actions/runs/30762563690) | 19:04:45 | 19:05:44 | 60 s |
| [30762361214](https://github.com/cityscroll/crol-list/actions/runs/30762361214) | 18:59:46 | 19:00:38 | 52 s |
| [30761510750](https://github.com/cityscroll/crol-list/actions/runs/30761510750) | 18:36:50 | 18:37:44 | 54 s |

The earlier machine-readable baseline used the GitHub API's
`run_started_at`-to-`updated_at` interval for eight successful 2026-07-30 runs
and recorded a 74.5 s median. The values are retained rather than silently
combined because the endpoints differ: the refreshed sample uses actual first
and last log timestamps and does not include runner queue/setup time before the
first line.

## What the new checks currently prove

The latest `main` sample compared the 30 most recent **Deploy site** runs with
the 30 most recent **Deploy Cloudflare Pages** runs. The commit SHA sets matched
30-for-30, and every paired run concluded successfully. The newest Pages run
deployed commit `561f2f4`, then passed both jobs:
parallel deployment and live URL/parity verification.

The fresh independent verification at capture time also passed on its first
attempt:

- route parity: 9/9 public inventory routes returned matching HTTP 200 status
  and expected content markers;
- live smoke: the Pages root and About route both returned HTTP 200 with the
  expected CityScroll marker.

This proves that the parallel host is being refreshed and that the checked
static routes currently match. It does not prove post-cutover DNS behavior,
custom-domain ownership, API behavior, email delivery, or rollback duration.

## Gate-versus-human evidence

Available failed-run history contained four deploy failures:

- [Pages run 30512176247](https://github.com/cityscroll/crol-list/actions/runs/30512176247)
  was stopped by route parity when all nine candidate routes returned HTTP 522.
- [Deploy site runs 30459656265](https://github.com/cityscroll/crol-list/actions/runs/30459656265),
  [30461740012](https://github.com/cityscroll/crol-list/actions/runs/30461740012),
  and [30472050664](https://github.com/cityscroll/crol-list/actions/runs/30472050664)
  were stopped by the build gate for the same artifact-permission failure.

That is four gate activations representing two distinct failure classes. The
documented 2026-07-30 redirect-loop field case was instead found by a person
while the deployment workflow was green. Its elapsed discovery time was not
recorded, so this baseline reports one human-detected class without inventing a
latency or treating it as comparable to a failed workflow run.

## Decision boundary

The evidence is sufficient to say Phase 1 is healthy and continuously
deploying. It is not authorization for a production cutover. The remaining
decision is whether the site owner authorizes the separately controlled DNS
cutover or holds the current production path. Any later rollback must follow
the **Static Hosting Cutover Runbook**; this public scorecard intentionally does
not reproduce operational rollback instructions.
