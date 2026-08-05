---
id: crol-list/static-first-loading-panels
title: "Finish static-first migration for remaining read-only loading panels"
status: proposed
wave: null
builds_on: []
blocks: []
effort: M
spec: Replace read-only profile and legacy-detail skeletons with bounded snapshots or explicit
  unavailable states; keep spinners only for user-triggered writes and genuinely live lookups.
context:
  - site/app/entities.mjs
  - site/app/workspace.mjs
  - site/app/routing.mjs
  - site/app/people.mjs
  - tools/sample_surface_load.py
verify: "python3 tools/sample_surface_load.py --live --gate --out artifacts/surface-load/loading-panels.json"
needs_james: null
session: null
---

# Finish static-first migration for remaining read-only loading panels

The decision/outcome paths now paint from daily snapshots, but several read-only detail surfaces
still begin with unbounded loading copy or empty skeletons:

- official, agency, and vendor profile shells and the three vendor profile tail panels;
- shared-investigation and matter-detail readers;
- the legacy task-example and notice hash-route shells;
- staffing detail payroll lookups where the annual snapshot can provide an initial value.

Audit each source for boundedness and publication cadence. Add it to an existing daily snapshot when
the result changes no more than daily; otherwise retain a live enhancement with a measured loading
budget and an explicit failure or absence state. User-triggered sends, uploads, translations, and
payroll refreshes are outside this card because their progress indicators represent active work.
