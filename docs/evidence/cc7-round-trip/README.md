# CC-7 correction round-trip pilot

This is a bounded, fixture-backed exercise of the challengeable-claims seam. It
does not claim that equivalent records elsewhere are correct or challengeable.
The machine-readable record is [pilot.json](pilot.json), and the screenshots
are generated from that same replay.

## Result

| Case | Seeded error | Failure origin | Adjudication | Source-of-truth change | Visible result |
| --- | --- | --- | --- | --- | --- |
| CC7-IDENTITY-001 | Wrong identity | Entity resolution | Confirmed | `canonical_entity_ref` changed from `entity:official:cc7-1001` to `entity:official:cc7-1002` | Yes |
| CC7-RELATIONSHIP-001 | Wrong contract → vendor connection | Joining | Confirmed | `vendor_ref` changed from Northstar Works to Harbor Maintenance | Yes |
| CC7-GROUPING-001 | Two notices grouped as one hearing | Derived interpretation | Confirmed | `grouping_mode` changed from `one_meeting` to `separate_notices` | Yes |
| CC7-MISSING-001 | Missing Community Board host relationship | Ingestion | Confirmed | `host_board_ref` populated with Manhattan Community Board 6 | Yes |
| CC7-NEGATIVE-INSUFFICIENT-EVIDENCE-001 | Same grouping challenge without source evidence | Derived interpretation | Unresolved | No change applied | No; assertion remains visible |

Each confirmed case begins with the assertion and attached provenance, submits a
structured payload through the exact `POST /feedback` route shape, records the
adjudication evidence and decision, applies a guarded change only to the named
pilot source-of-truth envelope, and reprojects the visible result. The replay
does not call the production endpoint or send email.

## Before and after captures

Desktop captures are 1440px wide; mobile captures are 390px wide.

| Case | Before | After |
| --- | --- | --- |
| Identity | desktop (owner-only evidence retained under the registered RCP-03 disposition) · mobile (owner-only evidence retained under the registered RCP-03 disposition) | desktop (owner-only evidence retained under the registered RCP-03 disposition) · mobile (owner-only evidence retained under the registered RCP-03 disposition) |
| Relationship | desktop (owner-only evidence retained under the registered RCP-03 disposition) · mobile (owner-only evidence retained under the registered RCP-03 disposition) | desktop (owner-only evidence retained under the registered RCP-03 disposition) · mobile (owner-only evidence retained under the registered RCP-03 disposition) |
| Grouping | desktop (owner-only evidence retained under the registered RCP-03 disposition) · mobile (owner-only evidence retained under the registered RCP-03 disposition) | desktop (owner-only evidence retained under the registered RCP-03 disposition) · mobile (owner-only evidence retained under the registered RCP-03 disposition) |
| Missing relationship | desktop (owner-only evidence retained under the registered RCP-03 disposition) · mobile (owner-only evidence retained under the registered RCP-03 disposition) | desktop (owner-only evidence retained under the registered RCP-03 disposition) · mobile (owner-only evidence retained under the registered RCP-03 disposition) |
| Insufficient evidence | desktop (owner-only evidence retained under the registered RCP-03 disposition) · mobile (owner-only evidence retained under the registered RCP-03 disposition) | desktop (owner-only evidence retained under the registered RCP-03 disposition) · mobile (owner-only evidence retained under the registered RCP-03 disposition) |

## Reproduce

From the repository root:

```bash
node tools/cc7_round_trip_pilot.mjs
python3 tools/capture_cc7_round_trip_pilot.py
node --test test/cc7_round_trip_pilot.test.mjs
```

The pilot source of truth is intentionally in-memory and scoped to the five
records above. The negative replay is important: a disagreement without source
evidence is retained as unresolved, and its visible assertion and source truth
remain unchanged. This pilot therefore demonstrates the seam and one complete
assertion → challenge → evidence → correction → visible-result path; it does
not establish universal correctness, correction coverage, adjudication capacity,
or automatic correction of equivalent records.
