# Versioned action log

CityScroll records successful pin, watch, and desk review interventions as append-only D1 rows in
`action_log`. This ledger is for reproducible product-method and later review-yield analysis;
it is separate from aggregate usage analytics and the operational watch lifecycle log.

Each row carries `schema_version`, `action_type`, an object type and optional public object id,
`ts`, `method`, and `method_version`. Bounded metadata may contain only enumerated product
dimensions and counts. The writer accepts no actor field or free text, and rows contain no email,
IP address, cookie, user agent, account id, or session id. Pin-store, watch, and review events
therefore remain anonymous and cannot be assembled into a person's activity history.

Supported v1 actions are pin saves, watch confirmation/update/pause/resume/removal, and
entity-pair `review_decision` rows emitted when the authenticated false-split desk appends a
disposition. Desk evidence (`false_split_disposition_event`) remains the authoritative audit
table and may keep operator-facing actor/note fields; the product action log only records the
pair id, method version, and enumerated decision (`same` / `different` / `unresolved` for
desk `defer`). Action-log writes are fail-soft and never block the desk mutation.

## Export review actions toward gold

Confirmed same/different review actions can be exported into gold-ready candidates without
overwriting any versioned gold file. A desk decision cannot contain or apply an `entity_link`
mutation; policy-satisfied verdict receipts are immutable candidate inputs for the same export:

```bash
node tools/export_review_actions_to_gold.mjs --fixtures
node tools/export_review_actions_to_gold.mjs --fixtures --check
node tools/export_review_actions_to_gold.mjs --fixtures --out-dir review-action-export
```

Pure model: `entity_resolution/eval/review_action_export.mjs`. Fixture:
`entity_resolution/eval/fixtures/review_actions_v0.json`. Characterization:
`node --test test/review_action_export.test.mjs`. Promotion into a new `gold_vN.jsonl` still
uses the clerical-audit append-only path; this export only materializes candidates + a receipt.
Operative links may be produced only by a later versioned policy rerun over promoted gold.

Migration: `worker/migrations/0010_action_log.sql`. Writer and schema contract:
`worker/src/lib/action_log.mjs`. Characterization:
`node --test worker/test/action_log.test.mjs worker/test/false_split_evidence.test.mjs worker/test/session_pins.test.mjs`.
