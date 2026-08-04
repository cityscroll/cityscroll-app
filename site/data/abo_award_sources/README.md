# Authorities Budget Office award residual — join measurement

Source contracts: `abo-local-authorities` (`8w5p-k45m`),
`abo-local-development-corporations` (`d84c-dk28`), and
`abo-state-authorities` (`ehig-g5x3`).

## Verdict (2026-08-04)

**Stopped for notice-level edge materialization.**

The fixed authority-stratified residual sample joined 1/50 notices (2%), below
the 30% usefulness threshold. Fuzzy title/date predictions measured 50%
precision, below the 95% floor. The existing authority-scoped recent-award
context remains valid, but it is not a notice-to-award relationship.

## Evidence posture

- Exact authority mapping: retained as source scoping, not match evidence.
- Exact source identifier: required when available. The local-authority and
  local-development-corporation tables do not publish a contract/PIN field;
  the state-authority `transaction_number` had no sampled notice counterpart.
- Vendor + amount + date: eligible as a composite only when all fields are
  present. The residual notices supplied vendor on 0/50 and amount on 0/50.
- Title + date: candidate generation only. Ten groups were reviewed: one
  plausible match, five false positives, and four ambiguous groups.

## Artifacts

- Receipt: `verification_receipts/abo_residual_2026-08-04.json`
- Payload contract: `../abo_award_residual_lookup.json` and the Worker twin
- Fixed labeled sample: `../../../warehouse/fixtures/abo-awards-residual/labeled_sample.json`
- Guarded collector: `../../../warehouse/scripts/abo_awards_run.py`
- Pure bridge: `../../../worker/src/lib/abo_awards_join.mjs`
- Detector: `node --test test/abo_awards_residual.test.mjs`

No reader UI is included. A later reader card may consume the payload only if
a new measurement clears both gates.
