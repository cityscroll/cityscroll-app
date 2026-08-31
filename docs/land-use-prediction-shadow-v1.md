# Land-use prediction shadow comparison

`worker/src/lib/land_prediction_shadow.mjs` runs the incumbent and V2 from one validated `cityscroll.land_prediction_snapshot.v1`. The return value keeps the incumbent under `authoritative`; V2, disagreement details, explicit missingness, and storage errors remain operator-only `shadow` evidence.

The comparison rejects project, cutoff, or evidence-envelope mismatches. Observation time is optional metadata and never changes the historical cutoff. Storage is best-effort and retains no additional personal data. The dataset is not a public search, ranking, or forecast authority.

Promotion is a separate fail-closed data receipt. It requires compatible C7 held-out evidence, coverage and timing, a non-triggered kill criterion, C7 authorization, and explicit review approval. Anecdotes and disagreement counts are not gate inputs. The currently committed C7 receipt withholds product promotion, so V2 remains `shadow_only_until_backtest_gate`.

The retained comparison controls are in `test/fixtures/land_prediction_shadow/gold.v1.json`; the
generated promotion decision is `warehouse/receipts/proof/lup2_c9_shadow_latest.json`.

Verify with `node tools/build_land_prediction_shadow.mjs --check` and
`node --test worker/test/land_prediction_shadow.test.mjs`.
