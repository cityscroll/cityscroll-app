# Civic Action Paths documentation receipt

This receipt joins the Action Path v0 contract, continuation safety, Community Board evidence policy, domain coverage, remaining gaps, visual evidence, tests, and implementation references. Screenshots are not proof by themselves.

- Exact replay family: `rules.request_ids`
- Semantic graph noun: false
- Cross-board inference: false
- Unknown as zero: false
- Non-causality: CityScroll reports what happened to the rulemaking and never attributes adoption or effectiveness to a resident comment.

## Implementation

- `site/action_path_v0.mjs`
- `site/action_registry.js`
- `site/council_hearing_matter_continuation.mjs`
- `site/council_hearing_action_path.mjs`
- `site/civic_outcome_transition.mjs`
- `site/community_board_participation.mjs`
- `worker/src/lib/continuation_replay.mjs`
- `ontology/action_path_coverage.mjs`
- `tools/lib/action_path_generalization_audit.mjs`

## Tests

- `test/action_path_v0.test.mjs`
- `test/action_path_coverage.test.mjs`
- `test/action_path_generalization_audit.test.mjs`
- `test/council_hearing_matter_continuation.test.mjs`
- `test/civic_outcome_transition.test.mjs`
- `test/community_board_participation.test.mjs`
- `test/civic_action_paths_documentation.test.mjs`
- `worker/test/continuation_replay.test.mjs`

## Fixtures

- `test/fixtures/action_path_v0.json`
- `ontology/fixtures/dimensions/action_path_coverage.json`
- `site/data/meeting_outcomes_snapshot.json`
- `site/data/community_board_participation.json`
- `site/data/rules_domain_observations.json`

## Remaining gaps

- matter:{legistar_id} exact compiler family
- community-board committee-identity replay
- land, money, staffing, and property Action Path continuation adapters

