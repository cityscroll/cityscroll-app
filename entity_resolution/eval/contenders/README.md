# Optional OSS contender adapters

These adapters are opt-in evaluation tooling. They do not participate in the
site build, Worker runtime, production candidate generation, policy, review,
or link materialization.

Create an isolated environment when running them:

```bash
python3 -m venv entity_resolution/eval/.venv
entity_resolution/eval/.venv/bin/pip install -r entity_resolution/eval/optional-requirements.txt
node entity_resolution/eval/run_bakeoff.mjs \
  --gold entity_resolution/eval/gold_v1.jsonl \
  --out-dir entity_resolution/eval/bakeoff/2026-08-06
entity_resolution/eval/.venv/bin/python entity_resolution/eval/contenders/splink_adapter.py \
  --input entity_resolution/eval/bakeoff/2026-08-06/candidate_pairs.jsonl \
  --out-dir entity_resolution/eval/bakeoff/2026-08-06/splink \
  --output entity_resolution/eval/bakeoff/2026-08-06/splink.json
entity_resolution/eval/.venv/bin/python entity_resolution/eval/contenders/dedupe_adapter.py \
  --input entity_resolution/eval/bakeoff/2026-08-06/candidate_pairs.jsonl \
  --out-dir entity_resolution/eval/bakeoff/2026-08-06/dedupe \
  --output entity_resolution/eval/bakeoff/2026-08-06/dedupe.json
node entity_resolution/eval/run_bakeoff.mjs \
  --gold entity_resolution/eval/gold_v1.jsonl \
  --out-dir entity_resolution/eval/bakeoff/2026-08-06 \
  --splink-output entity_resolution/eval/bakeoff/2026-08-06/splink.json \
  --dedupe-output entity_resolution/eval/bakeoff/2026-08-06/dedupe.json
```

The adapters emit the scorer contract envelope: pair probability, evidence,
scorer version, model/settings artifact hash, and config hash. Splink includes
its trained model JSON and intermediate comparison columns. Dedupe uses its
Gazetteer index and records the trained settings hash. The final report marks
Dedupe's current gold-label training overlap explicitly; it is useful for
mechanical integration proof, not an out-of-sample winner claim.

The current gold set is intentionally small and baseline pair metrics are
saturated. Use the existing clerical audit to label unresolved-band candidates
and create a newer gold version before making a production scorer decision.
