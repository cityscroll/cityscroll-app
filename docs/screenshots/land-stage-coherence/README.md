# Land stage pointer coherence — field case 2019K0190

User report (2026-08-03): Community Board review was shown as the **current**
stage with a statutory deadline of 2026-05-01 while City Planning Commission
steps on the same card already showed completed 2026-07-15.

- `before/` — production capture of the stranded pointer
- `after/` — local capture with the pipeline pointer advanced past missing CB
  outcomes when later stages have terminal completions

Re-run: `python3 tools/capture_land_stage_coherence.py`
