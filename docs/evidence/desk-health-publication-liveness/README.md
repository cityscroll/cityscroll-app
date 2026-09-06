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

[`production-watchdog-read.json`](production-watchdog-read.json) is a live production read of the independent watchdog. Isolated pause and failure fixtures are labeled isolated and are not that read.

The scheduled Pages publication path last succeeded on 2026-08-07 and the next scheduled attempt on 2026-09-05 failed during public origin deploy. Successful push deploys in between are unrelated application deploys, not Desk evidence publication. The first-class dataset-refresh workflow has no observed runs; missing that input is not proof that the Pages collector is stopped.

## Capture policy

The post-change render manifest records route, viewport, revision, data vintage, assertion, and render-content digest. Capture images remain ignored under `.artifacts/desk-health-publication-liveness/captures`.
