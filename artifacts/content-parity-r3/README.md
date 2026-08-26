# Notice progressive-hydration capture

The baseline is the default branch at the start of this change; the candidate contains the
progressive Notice context hydration. Both captures use the same local build harness, fixture
network, viewport sizes, and three samples per viewport. The Notice content comparison waits for
the candidate's settled context marker before extracting records and controls.

## Results

- Notice content parity: **PASS** on mobile and desktop; no records, fields, or controls were lost.
- Notice readiness: **PASS** on mobile and desktop.
- Notice `component_ready_ms`: **−6.6 ms** mobile and **−4.65 ms** desktop (p75).
- Full six-surface content parity: **PASS** for Home, Near You, Following, Contracts, Notice, and Agency.

The screenshots and JSON captures are grouped under `baseline-main/` and `candidate/`. The focused
Notice report is under `notice-report/`.
