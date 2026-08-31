# Action Path coverage

This receipt measures grounded targets, grounded continuations, exact replay, current actions, and current application sources. Legitimate no-action civic objects remain valid. Button density is not a coverage target.

## Ratios

- actions_with_grounded_target / actions_sampled: 14 / 16 = 0.875 (derived)
- actions_with_grounded_continuation / actions_sampled: 4 / 16 = 0.25 (derived)
- continuations_exactly_replayable / continuations_proposed: 4 / 7 = 0.571429 (derived)
- entities_with_current_action / entities_sampled: 10 / 16 = 0.625 (derived)
- current_application_ctas_with_current_source / application_ctas: 1 / 1 = 1 (derived)
- cross_board_inference_violations: 0 (measured)

## Diagnostic classes

- no_action (4): council-unavailable-action, cb-manhattan-closed-apply, cb-bronx-no-apply, no-action-archive
- action_only (3): council-action-only, council-unmatched-live, cb-current-application
- target_unknown (1): target-unknown-comment
- continuation_unknown (1): council-multiple-candidates
- continuation_not_replayable (2): council-single-continuation, council-unsupported-lossy
- grounded_path (3): dot-t1-before-hearing, dot-t2-after-adoption, dot-t3-after-effective
- stale_opportunity (2): dot-t1-after-comment-close, cb-stale-application

## Sampled rows

- council-action-only: action_only entity=notice:20260827001 action=attend continuation=none exact_replay=false
- council-single-continuation: continuation_not_replayable entity=matter:79200 action=attend continuation=matter:79200 exact_replay=false
- council-multiple-candidates: continuation_unknown entity=meeting:city_record:20260707021 action=attend continuation=none exact_replay=false
- council-unsupported-lossy: continuation_not_replayable entity=meeting:city_record:20260707022 action=attend continuation=none exact_replay=false
- council-unavailable-action: no_action entity=notice:20260827002 action=comment continuation=none exact_replay=false
- council-unmatched-live: action_only entity=meeting:city_record:20260728026 action=document continuation=none exact_replay=false
- dot-t1-before-hearing: grounded_path entity=rulemaking:dot:bicycle-owned-racks action=comment continuation=rulemaking:dot:bicycle-owned-racks exact_replay=true
- dot-t2-after-adoption: grounded_path entity=rulemaking:dot:bicycle-owned-racks action=document continuation=rulemaking:dot:bicycle-owned-racks exact_replay=true
- dot-t3-after-effective: grounded_path entity=rulemaking:dot:bicycle-owned-racks action=document continuation=rulemaking:dot:bicycle-owned-racks exact_replay=true
- dot-t1-after-comment-close: stale_opportunity entity=rulemaking:dot:bicycle-owned-racks action=comment continuation=rulemaking:dot:bicycle-owned-racks exact_replay=true
- cb-manhattan-closed-apply: no_action entity=community-board:manhattan-cb-02 action=apply_full_board_membership continuation=none exact_replay=false
- cb-bronx-no-apply: no_action entity=community-board:bronx-cb-02 action=apply_full_board_membership continuation=none exact_replay=false
- cb-current-application: action_only entity=community-board:manhattan-cb-06 action=apply_public_committee_membership continuation=none exact_replay=false
- cb-stale-application: stale_opportunity entity=community-board:queens-cb-02 action=apply_public_committee_membership continuation=none exact_replay=false
- no-action-archive: no_action entity=notice:20200101001 action=none continuation=none exact_replay=false
- target-unknown-comment: target_unknown entity=notice:20260801001 action=comment continuation=none exact_replay=false
