# Merge-throughput gate audit

`tools/merge_gate_audit.mjs` is the MT-2 projection over the MT-1 telemetry
contract. It reads the required checks from `tools/merge_queue_policy.json`,
joins each check to the same source window, and writes
`cityscroll.merge-throughput.gate-audit.v1`.

For each required check the audit retains:

- completed failure conclusions as real catches;
- total elapsed runner minutes and its duration denominator;
- ejection-linked jam incidents;
- MT-1 flake and rerun-clears-it rates;
- serialized wall-time contribution, measured as completed interval time not
  overlapped by a sibling required check; and
- an explicit sample window and observation denominators.

Unknown, pending, unavailable, and uninstrumented observations remain unknown.
They cannot produce a zero score or a removal recommendation. Recommendations
also carry the protected failure class, a replacement check or monitor, and a
reliability non-regression condition. The audit records `ALLGREEN` and required
protection as unchanged policy boundaries; it does not change merge policy.

## Fixture proof

The focused fixture contains a slow, high-catch unit gate, a low-catch flaky
browser gate, and an uninstrumented reading-level gate:

```sh
node tools/merge_gate_audit.mjs --fixture test/fixtures/merge-throughput --check
node tools/merge_gate_audit.mjs --fixture test/fixtures/merge-throughput/gate-audit --check
node --test test/merge_gate_audit.test.mjs
```

The fixture ranks the path-filter candidate first, retains the high-catch unit
gate, and marks the uninstrumented gate `insufficient-evidence`.

## Shared watermark serialization finding

The audit includes `architecture-watermark-serialization` as a supplemental
gate-like finding. `architecture/generated/watermark.json` is a single generated
target written by `node tools/reconcile_architecture.mjs --write-watermark`.
The repository history shows the target carried by recent architecture-affecting
PRs, including #1354 (`ffed31cb`) and #1359 (`0c7818a4`); the observed records
for #1329, #1354, #1357, and #1359 each show one to two conflicts. This is a
serialization point: otherwise independent changes contend on the same file,
creating rebase work without increasing validation coverage.

The finding proposes, but does not implement, three remedies:

1. **Merge-neutral watermark:** keep the reviewed baseline stable during normal
   PRs and advance it in an explicit review step. This removes the direct
   conflict source but adds a deliberate baseline-release operation.
2. **Per-module split:** partition facts by module or canary owner. This enables
   independent updates but requires aggregation and cross-module consistency
   checks.
3. **Merge driver:** merge the generated target with a deterministic custom
   driver. This preserves the current shape but moves risk into tooling and
   requires proof that no reviewed fact is dropped.

The existing architecture reconciliation and frozen-canary replay remain the
replacement monitor for any future remediation. No remediation is applied by
this audit.

## Manual check-value record

**Recorded:** 2026-08-29 · `qr_share` preflight split

| Check portion | Decision | Detection value | Cost observed tonight |
| --- | --- | --- | --- |
| Queens land-page render canary | Required | Retains the real product detection surface: the fixture-backed land route must render its data and copy | — |
| QR dialog interaction, capture, and annotation assertions | Non-blocking a11y diagnostic | Zero product regressions caught by this portion in the fixture-only bisect verdict | Two workers blocked and one bisect spent |

The failures came from stale prepared test artifacts; a cleanly prepared run
passed on `main`. Full capture now prepares the Pages-shaped artifact itself,
while required preflight runs only the independent land canary.
