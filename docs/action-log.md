# Versioned action log

CityScroll records successful pin and watch interventions as append-only D1 rows in
`action_log`. This ledger is for reproducible product-method and later review-yield analysis;
it is separate from aggregate usage analytics and the operational watch lifecycle log.

Each row carries `schema_version`, `action_type`, an object type and optional public object id,
`ts`, `method`, and `method_version`. Bounded metadata may contain only enumerated product
dimensions and counts. The writer accepts no actor field or free text, and rows contain no email,
IP address, cookie, user agent, account id, or session id. Pin-store and watch events therefore
remain anonymous and cannot be assembled into a person's activity history.

Supported v1 actions are pin saves, watch confirmation/update/pause/resume/removal, and a reserved
entity-pair review decision. The current entity-resolution desk remains read-only; a future
authenticated decision route can use the reserved action only after its authorization and
adjudication semantics are defined.

Migration: `worker/migrations/0010_action_log.sql`. Writer and schema contract:
`worker/src/lib/action_log.mjs`. Characterization:
`node --test worker/test/action_log.test.mjs worker/test/session_pins.test.mjs`.
