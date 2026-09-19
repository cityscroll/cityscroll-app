# Procurement disclosure production proof

Evidence for tracking aliases `c755c57ebdc96` (initial disclosure packet) and
`cdef57e5c9127` (complete reader-proof obligations).

## Surfaces

| File | Role |
| --- | --- |
| `manifest.json` | Offline fixture render hashes from the real edge worker and committed read model. Twelve entries: six named contracts at desktop and 390px. |
| `production-readback.json` | Separate deployment read-back against live `https://cityscroll.org` and `https://api.cityscroll.org`. Records live URLs, served build identity, source acquisition vintages, required obligation results, and production readiness separately from implementation delivery. |

Both surfaces keep textual assertions and sha256 hashes only. Image binaries are never committed.

## Required obligations

The production envelope enumerates required obligation IDs and routes. Field-role
assertions cover Firematic original/current/action amounts and TAMEER
original/current/action amounts from retained fixtures (or an explicitly dated
newer source observation). BHRAGS requires headline/payment-section agreement,
31 payments, source dates, and scoped coverage. Browser obligations at 1440x900
and 390x844 must run after app readiness and notice settlement; museum scope must
remain visible at both sizes, and search `ACEDCA215` must expose a usable result
link that opens the museum notice at both sizes. HTML equality, viewport request
headers, HTTP 200, and text hashes are supporting evidence only.

## Regenerate

Never hand-edit hashes or revision fields.

```bash
node tools/capture_procurement_disclosure_production_proof.mjs --fixture-manifest
node tools/capture_procurement_disclosure_production_proof.mjs --production
node tools/capture_procurement_disclosure_production_proof.mjs --check
```

`--fixture-manifest` pins the capture clock, serves each route through the edge worker, recomputes every hash, and writes the producing git revision onto every entry so revision and hash stay paired.

`--production` issues read-only public GETs and a bounded browser collection. It does not submit forms, write state, or take account actions. The envelope always records `implementation_delivery` and `production_readiness` as separate results. Use `--require-ready` only when promotional readiness must fail the process.

Offline browser proof (local materializations):

```bash
python3 tools/capture_procurement_disclosure_browser_proof.py --mode offline --json-stdout
```

## Covering tests

`test/procurement_disclosure_production_proof.test.mjs` (offline; includes mutation tests).

Live collection is opt-in and wired into the Pages deploy workflow:

```bash
LIVE_PROCUREMENT_DISCLOSURE_CANARY=1 CITYSCROLL_DISCLOSURE_BROWSER=1 \
  node --test test/live_procurement_disclosure_canary.test.mjs
```
