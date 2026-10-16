# Land outcome observations

`GET /zap-outcomes?id=<project_id>` is a public, materialization-only read. It
returns the retained observation; reading it never contacts the publisher or
refreshes its age. Missing observations return `404` with `not-materialized`.

A machine client should identify itself honestly and request JSON:

```sh
curl --header 'User-Agent: CityScrollDiagnostics/1.0 (+https://cityscroll.org)' \
  --header 'Accept: application/json' \
  'https://api.cityscroll.org/zap-outcomes?id=2026K0233'
```

The configured alternate host is `cityscroll-worker.crol-worker.workers.dev`.
Neither public read requires an admin credential. A Cloudflare `1010` response
is a [client-signature rejection](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1010/), distinct from CORS or an application-level
missing record. Correlate its Ray ID with owner-side security events before
attributing it to a particular rule. Do not disable security globally to test
public read access.

## Observation and attempt clocks

- `record.generated_at` is the retained observation time. Downloading the record,
  putting it in session cache, or generating a static bundle does not renew it.
- The endpoint's `stale` flag applies the 24-hour observation objective. The
  browser also checks the retained observation time and labels stale or failed
  checks as the last recorded stage.
- Prewarming refreshes observations after 18 hours. A matching project identity,
  successful exact join, and valid observation timestamp are required before
  replacing a cached record. An empty set of decisions is not an acquisition error.
- Failed acquisition leaves the previous record untouched. A separate
  `<outcome-key>:attempt` KV record carries the attempt time and result.
- Refresh summaries distinguish `ok`, `partial`, `failed`, and `skipped`.
  Skips distinguish `already-fresh` and `empty-roster`; a missing KV binding is
  a `no-kv` failure. Scheduled acquisition receipts map skipped work to `held`,
  never new successful acquisition.

Outcome acquisition starts independently in the existing 08:00 UTC morning
window, so digest delivery and unrelated advisory jobs cannot prevent it from
starting. The authenticated admin refresh uses the same acquisition function;
public reads remain read-only. See [release configuration](release/cloudflare-native-builds.md).

## Stage evidence

A published notice or scheduled, held, postponed, or cancelled hearing does not
complete a review stage. Explicit completed milestones and submitted dispositions
provide completion evidence; draft and planned records do not. Parallel procedures
continue to use the resolved procedure's existing stage model.

Static bundles retain the event spine, milestones, statutory clock, and original
observation time. A late static load cannot overwrite a live observation, and an
older or thinner API payload cannot erase richer retained evidence. Failure of the
optional project-connections section does not discard otherwise usable outcome data.

Regression coverage: [refresh-to-render recovery](../test/land_outcome_recovery.test.mjs),
[cache prewarming](../worker/test/zap_outcomes_prewarm.test.mjs), and
[stage selection](../test/land_phase_spine.test.mjs).
