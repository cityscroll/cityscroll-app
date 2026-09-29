# Connected-history evaluation sources

Receipts under `verification_receipts/` freeze the cross-board evaluation cohort
built from already-retained ZAP, parcel, board-position, and BSA inputs before
any extraction tuning; record the bounded CEQR / DOT / EDC document retention
pass over the fixed six-case dossier; freeze typed explicit-reference and
scoped-history relation admission over that same dossier; and freeze
time-scoped participant role observations (applicant, speaker, operator, and
related roles) without inventing ownership or formal board action. The temporal
materialization reuses the shared civic valid/system clocks to retain scoped
before-and-after states without treating corrections as civic events.

Rebuild or verify:

```bash
node tools/build_connected_history_cohort.mjs
node tools/build_connected_history_cohort.mjs --check
node --test test/connected_history_cohort.test.mjs

# The document builder performs a bounded live acquisition. It records
# retrieved rows or explicit failure receipts; it never synthesizes a retained
# row from a URL. Unit tests inject their fixtures directly and do not write
# the production artifact.
node tools/build_connected_history_documents.mjs
node tools/build_connected_history_documents.mjs --check
node --test test/connected_history_documents.test.mjs

node tools/build_connected_history_relations.mjs
node tools/build_connected_history_relations.mjs --check
node --test test/connected_history_relations.test.mjs

node tools/build_connected_history_roles.mjs
# Byte-exact: the committed artifact and receipt must equal a fresh
# materialization, not only its selection hash, counts and strata.
node tools/build_connected_history_roles.mjs --check
node --test test/connected_history_roles.test.mjs

node tools/build_connected_history_time.mjs
node tools/build_connected_history_time.mjs --check
node --test test/connected_history_time.test.mjs
```

## Scheduled cycle

`.github/workflows/connected-history-cycle.yml` runs
`node tools/connected_history_cycle.mjs --run` daily at 07:13 UTC (and on
manual dispatch). The declaration is checked by
`node tools/connected_history_cycle.mjs --check-declaration` and
`test/connected_history_cycle.test.mjs`. Each run:

1. **acquisition**: re-fetches the fixed dossier documents and records every
   request with its digest and a content fingerprint. The fingerprint ignores
   HTML that differs on every response (inline scripts, hidden form state,
   hidden frames, comments, nonces). The frozen cohort's declared inputs are
   digested and reported as drifted or not. They are never re-frozen.
2. **materialization**: rebuilds documents, relations, roles, time and
   coverage in memory and compares them with the committed bytes. A document
   counts as changed only when its facts or content changed. A new fetch digest
   caused only by per-response markup does not count, and neither does a
   transport failure. A committed observation that cannot be re-fetched is
   kept.
3. **publication**: `derivePublicationDecision` decides `unchanged`,
   `published` or `held`. A change is held, and the served bytes stay as they
   are, when a committed observation could not be re-fetched or when a
   retained production measurement under `docs/evidence/` pins a changed path.
   Held files are uploaded with the run. A held change is republished only by
   a reviewed pull request that regenerates it through its builder, records
   the move in `REVIEWED_REPUBLICATIONS`
   ([`tools/lib/connected_history_release.mjs`](../../../tools/lib/connected_history_release.mjs)),
   and re-measures the pinned read-backs. The measurements that pin each
   served artifact are named in `test/connected_history_cycle.test.mjs`, and
   a builder run prints the ones its regeneration invalidates
   ([`tools/lib/retained_evidence_pins.mjs`](../../../tools/lib/retained_evidence_pins.mjs)).
4. **verification**: the owning builders' `--check` modes run over the tree
   the run leaves. A failure restores the committed bytes.

Every run writes `site/data/connected_history_cycle.json`, served at
`/data/connected_history_cycle.json`, and the workflow publishes it through
the `automation/connected-history-cycle` pull request with auto-merge. The
receipt records the run's start and finish, the served revision before and
after, each stage, the acquired sources and digests, each materialization's
committed and materialized digests and stamps, the publication decision with
its reason, and a ledger of earlier runs. Because a byte-identical run still
writes a new receipt, an idempotent cycle can be told apart from no cycle. A
failed stage writes a receipt naming that stage. Rebuilding from committed
inputs (a builder or a deploy) never writes a receipt, so a missing receipt
means no cycle ran. `verifyConnectedHistoryCycleReceipt` re-derives the status,
the outcome and the decision from the receipt's own facts.

Document retention resolves DOT parent-page attachment selectors once into an
auditable manifest, keeps publication time distinct from internal section dates
and observation time, and records acquisition failures without counting them as
retained evidence. Each retained row has a successful fetch receipt, fetched
timestamp, content hash, byte count, and a source span located in the fetched
body. Historical DOT presentations stay out of the open-consultation set.
Missing strata stay explicit; they are never replaced by substituted examples.
