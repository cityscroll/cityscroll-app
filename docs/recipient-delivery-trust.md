# Recipient delivery trust

The send boundary consults two independent facts before any subscriber or
transactional mail, and refuses delivery when **either** holds. The facts have
separate authorities, separate storage, and separate lifecycles, so one changing
never clears the other.

## The two facts

| Fact | Table | Authority | Lifecycle |
| --- | --- | --- | --- |
| Provider suppression | `recipient_suppressions` (0036) | The mail provider's suppression export, folded in by reconciliation | A refresh adds/updates rows; a recipient absent from a later export is lifted (never deleted) |
| Operator hold | `operator_recipient_holds` (0038) | An operator decision | Recorded with its own date, reason, and provenance; a provider refresh or lift never reads or writes this table |

Recipient identities are stored only as the sha256 hex digest of the normalized
address. The address itself never lands in the database.

`deliveryHoldForRecipient(db, email)` in
[`worker/src/lib/recipient_suppression.mjs`](../worker/src/lib/recipient_suppression.mjs)
reads both facts and returns a hold when either is active. Every send boundary —
the single-watch signup, the pack signup, the account sign-in, the digest and
rollup sends, and any product-intake consumer — calls this one boundary. The
private Desk read model unions the same two authorities.

`operator_recipient_holds` is **read-only** from the worker. The operator owns the
write side; this repository formalizes the schema (`CREATE TABLE IF NOT EXISTS`,
so applying it over an existing production table is a no-op) and the read boundary.
No backfill or apply is performed by application code.

## Provider-suppression reconciliation (operator command)

Reconciliation folds the provider's complete current suppression export into
`recipient_suppressions` with an idempotent dry-run/apply receipt that carries
counts only — never addresses.

Production (D1) runs through the admin route; always dry-run first and read the
counts before applying:

```
curl -sS -X POST "$WORKER_ORIGIN/admin/recipient-suppressions/reconcile?key=$ADMIN_KEY" \
  -H 'content-type: application/json' -d '{"mode":"dry-run"}'
# review the receipt counts, then:
curl -sS -X POST "$WORKER_ORIGIN/admin/recipient-suppressions/reconcile?key=$ADMIN_KEY" \
  -H 'content-type: application/json' -d '{"mode":"apply"}'
```

A local/provisioned SQLite database can be reconciled from an export fixture or
directly from the provider with
[`tools/reconcile_recipient_suppressions.mjs`](../tools/reconcile_recipient_suppressions.mjs)
(dry-run by default; `--apply` writes):

```
node tools/reconcile_recipient_suppressions.mjs --input export.json --db local.sqlite
RESEND_API_KEY=… node tools/reconcile_recipient_suppressions.mjs --from-provider --db local.sqlite --apply
```

## Freshness watchdog

`evaluateSuppressionFreshness` checks the age of the last successful
reconciliation against a declared maximum (`SUPPRESSION_RECONCILE_MAX_AGE_MS`,
default seven days). A never-run or stale authority, and a failed reconciliation,
are raised through the repository's ops alert routing (guard
`recipient-suppression-freshness`, desk-routed by the emergency-only notification
policy). The mail watchdog surface (`GET /admin/reliability/mail`) runs this check
and includes the freshness status in its response.

## Enrollment instrumentation

Every signup decision records a bounded, privacy-preserving receipt
(`signup_decision_receipts`, 0039) linking route, time bucket, challenge and rate
decision, and welcome outcome. The receipt is keyed by a rotating pseudonymous key
(an HMAC of the actor under a per-window salt from the server secret): the same
actor collapses to one key within a window and to a different key across windows,
and the key cannot be reversed without the secret. No raw IP, no address, and no
stable identifier is stored, and only counts and buckets ever leave the worker.

Two ceilings feed temporary containment (`enrollment_containment`, 0039):

- **Per-route accepted volume** (`ENROLLMENT_ACCEPTED_BUDGET`): when accepted
  signups on a route cross the ceiling in a window, the route is placed under
  containment.
- **Transactional-mail budget** (`TRANSACTIONAL_MAIL_BUDGET`): when welcome sends
  for the window reach the budget, all routes are contained.

Containment is a bounded, self-expiring refusal (`ENROLLMENT_CONTAINMENT_TTL_MS`,
default one hour) of further accepts on a route, recorded with an explicit expiry.
It sits after the verified challenge and the per-actor rate limit, so it catches
distributed traffic — many actors, one route — that no single-actor limit would
stop. It is never an address or network ban, and it does not weaken the verified
challenge, the single opt-in, or the suppression authority. Crossing either
ceiling also raises an ops alert (`enrollment-accepted-volume`,
`transactional-mail-budget`).

The default budgets are starting points; tune them per environment from the
observed baseline.
