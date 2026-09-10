# Precise-watch edit and delivery continuity — acceptance receipt

Textual proof that a saved precise-watch edit governs queued email without changing watch identity, delivered history, or another watch's entitlement. Grounded at repository revision `9e3e112cd5d0652db5e33c1f1cb4217ed15658aa`. Fixture counts describe the retained snapshot, not a live production census.

Atomic revision / cutoff strategy:

- Each precise watch stores `query_revision`, a fingerprint of the canonical v1 expression. Equivalent expressions share one fingerprint. Legacy watches without `text_query` keep their existing identity.
- Unsent outbox membership is re-evaluated for that watch against the current expression, before any result limit. Non-matching unsent rows become `cancelled` with reason `cancelled:query-revision` and a structured `suppression_json`. Exclusion is never recorded as delivery.
- A later intentional edit that makes a cancelled-by-revision item eligible again updates the same `(watch_id, item_id)` row back to `owed`. Ordinary enqueue uses `ON CONFLICT DO NOTHING` and does not resurrect it.
- The provider-submit cutoff is `before-provider-submit`: the last current-revision read after evaluation/attach and immediately before `reserveDeliveryOccasion` + `sendEmail`. A stale prepared batch is rebuilt. After the provider accepts a message there is no recall. Unchanged retries send the reserved `delivery_id` as `Idempotency-Key`.

Evaluated field contract is the same procurement projection as the shared evaluator: notice-backed `short_title` / description; SolarWinds `20260723004` is excluded by a whole-token `maintenance` atom.

Verify:

```
node --test worker/test/watch_text_query_edit_delivery.test.mjs worker/test/subscription_identity.test.mjs worker/test/digest_outbox_rollup.test.mjs
```

| Item | Delivered path | Evidence |
| --- | --- | --- |
| A1 queued SolarWinds excluded from the next email | prefs update then `processOneSub` with captured provider | After excluding maintenance, `notice:20260723004` is `cancelled:query-revision`. Captured HTML contains the three E2 titles and not SolarWinds Software Maintenance. |
| A2 two-watch rollup and structured suppression | `processAccountRollup`; `suppression_json` | The unchanged watch still delivers SolarWinds. The edited watch keeps a structured exclusion of `maintenance`. An unrelated account row stays `owed`. Exclusion is not `delivered`. |
| A3 identity, cadence, equivalent save, delivered history | `/prefs` JSON update; `query_revision` | KV key, `watch_id`, `subscriber_id`, and `freq` survive upgrade and an equivalent-expression save. A previously delivered id is not re-emailed. |
| A4 restore after removing an exclusion | `restoreQueryRevisionCancelledItem` | Retry enqueue leaves the cancelled SolarWinds row cancelled. Removing the exclusion moves the same row to `owed`. |
| A5 edit-versus-send race at the cutoff | `onBeforeQueryRevisionCutoff` before reserve/submit | An edit applied during preparation is honored; captured HTML omits SolarWinds. The reserved delivery id is the Idempotency-Key. A later edit does not recall a delivered row. |
| A6 paused/deleted, save failure, single/rollup parity | `/prefs` save failure + pause/delete; rollup path | Failed persistence returns the submitted edit and the prior watch. Pause does not drain owed rows. Delete cancels only that watch's owed set. Rollup and single-watch paths share the cutoff. |
