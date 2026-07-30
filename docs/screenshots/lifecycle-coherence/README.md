# Lifecycle rendering coherence — field-case captures

Field cases (live):

- https://cityscroll.org/#notice/20260623008 (HNTB award)
- https://cityscroll.org/#notice/20260617040 (IDA hearing, no PIN)

API payloads used for fixtures:

- `GET https://api.cityscroll.org/contract-lifecycle?id=20260623008`
- `GET https://api.cityscroll.org/contract-lifecycle?id=20260617040`

Captures are offline fixtures matching those payloads (before = defective
renderer symptoms; after = coherent renderer). Characterization:
`node --test test/lifecycle_coherence_field_cases.test.mjs`
