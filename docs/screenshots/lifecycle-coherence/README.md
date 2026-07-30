# Lifecycle rendering coherence — field-case captures

Field cases (live):

- https://cityscroll.org/#notice/20260623008 (HNTB award) — payments ownership / no false gap
- https://cityscroll.org/#notice/20260617040 (IDA hearing, no PIN)

API payloads used for fixtures (verify HTTP 200 when re-capturing):

- `GET https://api.cityscroll.org/contract-lifecycle?id=20260623008`
- `GET https://api.cityscroll.org/contract-lifecycle?id=20260617040`

Captures are offline fixtures matching those payloads (before = defective
renderer symptoms including **joined payments rendered as not-shown and
duplicated** across the payments card and Follow-the-Dollars; after =
summary + link on payments, detail only on dollars). Characterization:
`node --test test/lifecycle_coherence_field_cases.test.mjs`

Viewports: 390 and 1440. Re-run: `python3 tools/capture_lifecycle_coherence.py`
