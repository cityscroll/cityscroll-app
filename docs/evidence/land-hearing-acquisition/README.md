# Land hearing acquisition evidence

Residents rely on the daily refresh for current hearing dates and other civic
records. An incomplete hearing sweep was preventing those updates from passing
the publication gates.

## Classification and counterfactual

This is an acquisition regression, not a closed hearing or a summary ordering
error. [The failed refresh](https://github.com/cityscroll/cityscroll-app/actions/runs/34312625501)
logged `ZAP fetch failed 2025K0305: This operation was aborted` at
2026-09-09T05:15:44Z, then wrote a snapshot after fetching 231 of 235 projects.
The summary treated the missing rows as a checked-empty result.

The [publisher project](https://zap.planning.nyc.gov/projects/2025K0305) and its
[public API](https://zap-api-production.herokuapp.com/projects/2025K0305) still
published the November 30 review session and December 2 public hearing when
checked on September 9. Their exact milestone identifiers and dates are retained
in the [bounded test fixture](../../../test/fixtures/land_authority_summary/published-hearing-recovery.json).
The fixture keeps only project identity and the two hearing milestones.

[The counterfactual receipt](counterfactual.json) records the same authority builder
run against four input states:

| Inputs | Published opportunity | Next procedural body |
| --- | --- | --- |
| Committed inputs | November 30 CPC session | CPC, with publisher identifier |
| Retained earlier refresh | Same session | Same source-explicit CPC body |
| Logged failed-request omissions reconstructed | None | Null |
| Publisher response recovered after an injected timeout | Same session | Same source-explicit CPC body |

The retained refresh revision predates the failing run. Its four logged failed
project requests were removed to reconstruct the failure; this does not claim to
recover the discarded full acquisition. The reconstructed inputs produced exactly
the three reported failures (19 passing, 3 failing). Restoring the target project
through the repaired retry path yielded 22 passing authority tests. The procedure
profile successor stayed Community Board review in all four states: it never became
the published CPC event.

## Acquisition contract

- Retry transient network failures, HTTP 408/429, and server errors at most twice,
  with bounded delays and the existing request timeouts.
- If a status listing, project response, or exhausted transient request cannot
  establish valid evidence, stop before writing either the snapshot or receipt.
  The refresh runner retains the previous artifact and its original vintage.
- A publisher HTTP 404/410 is recorded in `materialization.unavailable_project_ids`
  and the receipt. Other successfully fetched projects can still refresh. The
  authority materializer carries that availability into its per-project input;
  unavailable evidence renders as unknown, with no invented next body or calendar
  event. A successful empty response remains distinct from unavailable evidence.
- Keep the existing publication refusal, rebuild sequence, provenance assertions,
  and procedure-versus-published-opportunity distinctness checks.

The null dereference in the failed run was in the test assertion, after the
materializer had returned null. The production materializer and panel already
handle absent expected stages and next bodies; the acquisition tests exercise both
through the unavailable-evidence path without changing the existing assertions.

## Reproduction and checks

Run the unchanged authority tests and the acquisition regression tests:

```sh
node --test test/land_upcoming_hearings.test.mjs test/land_authority_summary.test.mjs test/land_authority_panel.test.mjs test/first_class_refresh_committed_read_models.test.mjs
node tools/build_land_authority_summary.mjs --check
node tools/architecture_evidence_shards.mjs --check
node tools/reconcile_architecture.mjs --check --no-write
make prepush
```

The acquisition tests inject timeouts and missing responses without network reads,
assert that failed acquisition invokes neither artifact write, and carry explicit
unavailability through the summary and panel. The refresh-registry suite checks
builder parity and gate coverage. Code verification is separate from the next
scheduled refresh and its resulting pull request.
