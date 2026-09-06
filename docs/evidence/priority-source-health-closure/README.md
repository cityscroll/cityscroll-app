# Priority source observation closure

This directory records bounded evidence that the seven priority civic source families and the 59-board minutes detector produce attributable acquisition, serving, and measurement observations through the existing health model. It contains no credentials, private diagnostic payloads, or captured image binaries.

## What closed

CityScroll-controlled attempt, success, and serving clocks stay distinct from publisher vintage. A rebuild of an old warehouse snapshot cannot clear ingestion staleness. Empty detector input is measurement unavailable and never means boards published no minutes.

| Family | Canonical source IDs |
| --- | --- |
| City Record | `city-record` |
| PASSPort contracts/RFX | `passport-public-contracts`, `passport-public-rfx` |
| Checkbook contracts/spending | `checkbook-contracts`, `checkbook-spending` |
| Legistar | `nyc-council-legistar` |
| Rules RSS | `nyc-rules-rss` |
| ZAP projects | `zap-projects` |
| Community-board minutes | `non-council-board-minutes` |

PASSPort evidence is the Worker/D1 ingest-meta path (`GET /admin/passport-ingest-meta`). A CI request to the publisher dump is not health proof.

## Host rail

[`warehouse-rail.json`](warehouse-rail.json) is a live inspection of the installed warehouse-backed first-class refresh job. Isolated failure and recovery fixtures are labeled isolated.

## Capture policy

The post-change render manifest records route, viewport, revision, data vintage, assertion, and render-content digest. Capture images remain ignored under `docs/evidence/priority-source-health-closure/captures`.
