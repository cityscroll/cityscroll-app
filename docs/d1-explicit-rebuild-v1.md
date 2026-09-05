# D1 explicit rebuild v1

D1-09 makes a full derived-state rebuild an exceptional operation. Ordinary
deploys use the keyed upsert path. Use a rebuild only for a schema or key
migration, corrupted derived state, or a deliberately selected backfill.

## Required inputs

Run `tools/d1_explicit_rebuild.mjs` with:

- `--reason <text>` — the operational reason for the rebuild.
- `--source-snapshot <path>` — the D1 partition snapshot captured before the
  rebuild. The file is hashed byte-for-byte.
- `--confirm <token>` — the exact value printed by
  `expectedConfirmation(reason, snapshot_sha256)`; it is bound to both the
  reason and snapshot bytes.
- `--estimate-writes <n>` — a positive write estimate.
- actor and run identity — `--actor`/`--run-id`, or the corresponding GitHub
  environment values.

The command writes only to its staging output directory. It emits the rebuild
plan, bounded-publisher plan and dry run, deterministic SQL, and a publication
receipt containing the actor, run, source snapshot hash, estimate, and reason.
It does not execute SQL and has no direct-apply flag.

Apply the staged plan only through `tools/d1_bounded_publisher.mjs`. Run the
D1-08 reconcile against the resulting derived state and stop if it is not
consistent; the new generation must not serve before reconcile passes.

## Rollback

Restore the prior derived snapshot through the bounded publisher, or rerun the
same explicit rebuild from its captured inputs with a new run identity. Keep
the original staging receipt and record the rollback as a new publication run;
never rewrite the earlier receipt or delete generation-fence state.

The legacy SQL generator remains in place until the explicit path has passed
staging proof: deterministic repeat output, bounded-publisher rehearsal, and a
clean D1-08 reconcile fixture. Only then may the legacy generator be removed.
