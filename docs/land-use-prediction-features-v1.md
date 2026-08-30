# Stage-aware land-use prediction feature vector v1

Card 5 is implemented by
[`worker/src/lib/land_prediction_features.mjs`](../worker/src/lib/land_prediction_features.mjs).
It is the normalized feature-layer contract between the temporal C2 snapshot,
the historical C3 actor resolution, the C4 project-specific member stance, and
the later interpretable predictor.

## Contract

`buildLandPredictionFeatureVector()` accepts a validated C2 snapshot through
`snapshot` (or builds one from the same C2 inputs), an optional validated C4
`member_stance` record, and an optional validated C3 `actor_resolution` record.
It normalizes `application_type` through the land-use action-family map and
`procedural_stage` through the ULURP phase spine (plus status-facet aliases such
as `council` → `city_council`). It does not invent a family from a descriptive
label. Historical actors come from C3 when supplied, otherwise from the C2
snapshot. A local-member stance is attached only when its `official:{PersonId}`
matches a historically resolved actor; a vacant seat or a current-member identity
stays explicit `unknown`. It emits the following institutional keys, even when a
source has no observation:

```text
application_type
procedural_stage
community_board_action
borough_president_action
cpc_recommendation
cpc_disposition
cpc_vote
local_council_member_stance
council_subcommittee_action
land_use_committee_action
modifications_or_conditions
```

An absent signal is a feature with `state: "unknown"`, a null value, and an
empty evidence trace. This is different from C2's
`no_known_position` and `neutral_mixed` states. A populated feature retains its
source, source clocks, confidence, and an `evidence` array with inspectable
source references plus `cutoff`, `identity`, `relation`, and `observation`
when those facts exist. C4 stance rows retain the selected evidence IDs and source
locators; conflicts therefore remain traceable rather than becoming a single
unexplained value.

The vector carries `prediction_as_of` and never admits a feature whose
availability clock is after that cutoff. C2's procedural stage is materialized
as a source-linked feature when it was not already present as an observed
feature. Building with only an application, cutoff, and stage therefore still
produces a valid sparse vector.

## Stage interaction boundary

`stage_interactions` declares
`local_council_member_stance@<procedural_stage>` as
`learnable_stage_interaction`. This is model metadata: a later predictor may
estimate a different coefficient by stage, and may find no useful coefficient.
The feature layer supplies no coefficient, threshold, directional outcome, or
member-veto rule. A stance is evidence about a project, not a deterministic
decision rule.

Named fixtures under `test/fixtures/land_prediction_features/` cover complete,
sparse, cutoff-boundary, conflicting, unknown, and multi-stage applications.

Focused proof:

```sh
node --test worker/test/land_prediction_features.test.mjs \
  worker/test/land_prediction_snapshot.test.mjs \
  worker/test/land_prediction_actor_resolution.test.mjs \
  worker/test/land_prediction_member_stance.test.mjs
```
