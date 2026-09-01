---
card_standard: release-control-v1
richness_profile: standard
id: cityscroll-merge-throughput/mh-05-parallel-artifact-site-node
title: "Run the shared browser artifact beside the site-node unit family"
status: proposed
wave: merge-throughput-w5
spec: https://github.com/cityscroll/cityscroll-app/blob/2c096d708ea4fcc7792860abf4d5d288a94a3728/README.md#cityscroll
builds_on: []
related: []
context:
  - .github/workflows/ci.yml
  - test/ci_path_fast_path.test.mjs
  - tools/merge_queue_policy.json
  - architecture/evidence.d/cityscroll-merge-throughput--mh-05.json
  - https://github.com/cityscroll/cityscroll-app/pull/1502
  - https://github.com/cityscroll/cityscroll-app/commit/2c096d708ea4fcc7792860abf4d5d288a94a3728
  - https://github.com/cityscroll/cityscroll-app/pull/1490
verify: "python3 scripts/release_control_card_fitness.py check cityscroll-merge-throughput/cards/proposed/mh-05-parallel-artifact-site-node.md && node --test test/ci_path_fast_path.test.mjs --test-name-pattern='shared browser artifact|browser consumers'"
needs_james: null
reconstructed_from:
  - "https://github.com/cityscroll/cityscroll-app/pull/1502"
  - "https://github.com/cityscroll/cityscroll-app/commit/2c096d708ea4fcc7792860abf4d5d288a94a3728"
  - "https://github.com/cityscroll/cityscroll-app/pull/1490"
---

## Story

As an owner of a merge queue that runs a shared browser artifact and site-node unit tests, when both families are required for a frontend change, I need them to start independently so the serial critical path does not make every queued change wait for avoidable setup while both required verdicts remain authoritative.

## Change

**Before:** In baseline merge-group #1500, the `site-node` family ran from 19:34:48Z to 19:45:21Z (10m33s), and the browser artifact did not begin until 19:45:30Z, making the two independent families serial.

**After (intended):** The shared browser artifact starts from path detection without waiting for the aggregate Unit job, while the site-node family continues through the Unit aggregate and both Unit and Accessibility remain required merge checks.

**Theory / mechanism:** This is a dependency-edge removal in the workflow DAG: artifact production can consume the change classification directly, while the aggregate Unit job still gates its own family results and downstream browser shards still consume the verified artifact. The measured post-land serial critical-path savings were 6m42s, 9m52s, and 10m10s across three groups (mean 8m55s, median 9m52s), but artifact plus downstream browser shards remains dominant, so the observations do not yet establish a population-level residence reduction.

### Gap -> fix

| ID | Gap | Fix | Acceptance |
| --- | --- | --- | --- |
| G1 | The shared browser artifact waits for independent site-node unit execution to finish | Remove the aggregate Unit dependency from artifact production while retaining path-based artifact conditions | A1 |
| G2 | Parallel artifact production could weaken required-check or downstream artifact guarantees | Keep Unit and Accessibility required and require every browser consumer to wait for the verified artifact | A2 |
| G3 | Critical-path improvement evidence is scattered across baseline, merged implementation, and follow-up queue observations | Preserve the baseline interval, three post-land savings, and bounded queue-episode interpretation in a reproducible card record | A3 |

## Acceptance

- [ ] A1 [outcome] [G1] The workflow DAG allows the shared browser artifact and site-node unit family to start independently, with the artifact no longer depending on the aggregate Unit job.
- [ ] A2 [boundary] [G2] The workflow and merge policy still require Unit and Accessibility verdicts, and all browser shards consume only the successfully verified shared artifact.
- [ ] A3 [verification] [G3] The card fitness gate and focused CI DAG test pass, while recorded evidence names baseline #1500, PR #1502, commit `2c096d708ea4fcc7792860abf4d5d288a94a3728`, savings of 6m42s/9m52s/10m10s, and observed queue episodes #1502 (19m57s) and #1490 (19m14s) without claiming a population-wide residence reduction.
