# Desk evidence-publication liveness

This directory records bounded evidence that monitoring and private Desk publication are independently observable between application code changes. It contains no credentials, private diagnostic payloads, or captured image binaries.

The four clocks on the authenticated data-source graph are operator-service facts, not publisher freshness:

1. Last monitor attempt
2. Last successful observation
3. Evidence revision
4. Last successful Desk publication

A successful unchanged-data cycle advances observation liveness without changing publisher vintage. A failed attempt never overwrites last success. Opening a pull request is backlog, not successful publication.

## Installed rails

The change reuses existing schedules. It does not add a parallel scheduler, evidence store, or monitoring product.

| Role | Installed trigger | Identity |
| --- | --- | --- |
| Collection and graph staging | `Deploy Cloudflare Pages` cron `15 10 * * *` | GitHub Actions workflow |
| Independent watchdog | `Reliability watchdogs` cron `50 * * * *` | GET `https://api.cityscroll.org/admin/reliability/scheduler` |
| Source-freshness observer | `source-freshness-watchdog` cron `30 10 * * *` | `com.cityscroll.external-schedules` |
| Dataset-refresh pull requests | `First-class dataset refresh` cron `40 6 * * *` | Backlog only |

Proposed operator-service budgets, distinct from publisher freshness: monitor interval 24 hours, missed-monitor grace 2 hours, publication within 2 hours of a completed evidence cycle. Faster existing schedules remain in place.

## Production observations retained here

The current live production observation is the newest dated envelope in this directory (`production-watchdog-read-YYYY-MM-DD.json`). Refresh it with `CITYSCROLL_ADMIN_KEY_FILE=/path/to/key node tools/capture_desk_publication_production_read.mjs`, which records scheduled Deploy Cloudflare Pages runs, Reliability watchdog observer cycles, the scheduler heartbeat, and the private Desk destination. Observer cycles do not count as publication; only a scheduled or dispatched Pages run may produce a publication heartbeat. [`production-watchdog-read.json`](production-watchdog-read.json) is the 2026-09-06 historical read and is not current.

Isolated pause and failure fixtures are labeled isolated and are not that read. Successful push deploys are unrelated application deploys, not Desk evidence publication. Dataset-refresh pull requests remain backlog.

## Capture policy

The post-change render manifest records route, viewport, revision, data vintage, assertion, and render-content digest. Capture images remain ignored under `.artifacts/desk-health-publication-liveness/captures`.
