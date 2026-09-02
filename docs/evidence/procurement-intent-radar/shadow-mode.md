# Procurement Intent Radar prospective shadow mode

## What this is

As of 2026-08-31. Shadow mode replays newly arriving meeting and document text through the
existing candidate extractor and reconciliation bridge, keeps every resulting intent internal, and
resolves those intents only when later solicitation evidence arrives. It is a measurement mode. No
route, search result, follow target, notification, or resident-facing claim is produced, and nothing
here promotes the workstream.

The two phases are separated by the information boundary that matters. The assertion phase sees only
an arriving source span, its metadata, its citations, and its clocks. The resolution phase is the only
phase that reads later solicitations, and it records its finding beside the earlier assertion rather
than rewriting it.

## What was observed

The retained stream `test/fixtures/procurement_intent_radar/shadow_arrivals.v0.json` carries 15 arrivals:
11 source observations and 4 solicitation observations.
It opened 7 internal intents: 2 open, 2 resolved, 1 ambiguous,
1 not observed inside the stated window, and 1 superseded.

The arrival stream is a bounded, retained fixture stream. It is not a recurrent estimate of arriving Council material and cannot authorize promotion. The stream is versioned fixture material rather than retained city evidence,
so its source spans and solicitation rows make no claim about any real agency or real solicitation.

| Register | Result |
| --- | --- |
| Occurrence | 2 realized, 1 awaiting review, 3 not observed yet, 1 not observed in the stated window |
| Timing | 1 window hit, 1 window miss, 1 abstained for want of a stated window |
| Abstentions | 1 extraction abstention, 2 arrivals with insufficient source evidence, 1 intent needing human review |
| Freshness | 2 stale arrivals over the 30-day threshold; maximum arrival lag 131 days |
| Idempotency | 1 duplicate replay, 0 assertions rewritten by replay |
| Supersession | 1 superseded, 1 superseded assertion retained verbatim |
| Realization cardinality | 1 one-to-one, 1 one-to-many, 5 with no accepted realization |

### No-promotion gate

**withheld.** Shadow mode is a bounded prospective observation on a retained fixture stream. It measures prospective behavior; it does not establish recurrence and does not authorize any public surface.

| Gate | Measured | Threshold | Result |
| --- | ---: | ---: | --- |
| Public surfaces created | 0 | 0 | pass |
| Temporal leakage failures | 0 | 0 | pass |
| Recurrent arrival corpus | 11 source observations | a recurrent retained arrival corpus | withheld |

## What remains unknown

An open intent has not failed. It has not been observed yet, and the artifact records that separately
from an intent whose stated window closed with no observed solicitation. Ambiguous candidates stay
internal review leads and never become accepted edges. Every provisional identity keeps its publisher
fields as explicit nulls until a later observation resolves them.

## Per-intent evidence

| Intent | Asserted | Arrived | Agency | Stated window | State | Occurrence | Timing | Lead | Realizations |
| --- | --- | --- | --- | --- | --- | --- | --- | ---: | ---: |
| procurement-intent:acs-request-for-proposals-2026 | 2026-01-14 | 2026-01-16 | agency:id:acs | 2026-06-01 → 2026-08-31 | resolved | realized | hit | 175 | 1 accepted / 1 candidates |
| procurement-intent:dss-solicitation-2026 | 2026-02-04 | 2026-02-06 | agency:id:dss | no stated window | ambiguous | review_required | review_required | — | 0 accepted / 1 candidates |
| procurement-intent:agency-unresolved-solicitation-2026 | 2026-02-18 | 2026-02-19 | agency:unresolved | 2026-06-01 → 2026-06-30 | unmatched | not_observed_in_stated_window | not_observed_in_stated_window | — | 0 accepted / 0 candidates |
| procurement-intent:dycd-request-for-proposals-2026 | 2026-03-11 | 2026-03-12 | agency:id:dycd | 2026-03-01 → 2026-05-31 | resolved | realized | miss | 96 | 2 accepted / 2 candidates |
| procurement-intent:acs-solicitation-2026 | 2026-07-15 | 2026-08-04 | agency:id:acs | 2026-09-01 → 2026-11-30 | superseded | not_observed_yet | not_observed_yet | — | 0 accepted / 0 candidates |
| procurement-intent:acs-solicitation-2026 | 2026-08-12 | 2026-08-19 | agency:id:acs | open → 2026-12-31 | open | not_observed_yet | not_observed_yet | — | 0 accepted / 0 candidates |
| procurement-intent:dycd-competitive-procurement-2026 | 2026-07-22 | 2026-08-27 | agency:id:dycd | 2026-09-01 → 2026-11-30 | open | not_observed_yet | not_observed_yet | — | 0 accepted / 0 candidates |

### Arrivals that opened no intent

| Arrival | Arrived | Disposition | Reasons |
| --- | --- | --- | --- |
| arr-2026-0004 | 2026-02-24 | insufficient_evidence | missing_source_span |
| arr-2026-0005 | 2026-02-26 | insufficient_evidence | missing_source_citation |
| arr-2026-0006 | 2026-03-04 | abstained | past_tense, completed_action, not_future_intent, contains_rfp_baseline_must_fail |
| arr-2026-0012 | 2026-07-20 | duplicate_replay | identical_sealed_source_already_observed |

## How this was established

Evaluator versions: extractor pir-phase1.0; prospective ontology 0.1.0; realization matcher pir-realization-matcher.v1; shadow mode pir-shadow-mode.v1.

Each arriving source is sealed at its own publication clock before extraction, so a later EPIN, title,
vendor, coverage field, or publication date cannot enter candidate generation. The assertion phase is
handed the source projection of the stream and never the solicitation projection, so later evidence is
structurally out of reach rather than merely unused. Every assertion is fingerprinted before resolution
and re-checked after it; a changed fingerprint is a hard failure.

Identity is content-addressed from the sealed source, so replaying the same arrival is a recorded
duplicate rather than a second intent. A later arrival that resolves to the same provisional subject
supersedes the earlier one and the earlier assertion is retained unchanged.

Runtime dependencies: none. Citation URLs are retained strings. Shadow mode never fetches them and reads no live service. The run is reproducible from the
retained, versioned stream alone.

Visibility: internal_only. Public routes 0; public realized edges 0; notifications 0; resident-facing claims 0. Authorization: none; PIR-6 public surfaces remain paused and this card does not authorize them.

Rebuild:

```sh
node tools/run_procurement_intent_shadow_mode.mjs
node tools/run_procurement_intent_shadow_mode.mjs --check
```
