# Land-use prediction institutional signal registry v1

Card 10 adds a research-only quarantine for claims that a practical actor may
shape a formally decided land-use outcome. The implementation is
[`worker/src/lib/land_prediction_institutional_signal_registry.mjs`](../worker/src/lib/land_prediction_institutional_signal_registry.mjs).

## Boundary

The registry is a research queue, not a prediction feature store. Its envelope
is permanently marked `queue: "research"` and
`production_admission: "not_admitted"`. No production prediction module
imports it. A candidate is only eligible for the `promoted` status after an
inspectable historical evaluation records useful held-out predictive value.
Promotion status is therefore an evidence-backed research result, not a
hard-coded causal rule or member veto.

## Candidate shape

```json
{
  "id": "member-deference-land-use",
  "formal_actor_process": "New York City Council disposition through the Land Use Committee and Council process",
  "candidate_practical_actor": "The local Council member representing the application's district at prediction_as_of",
  "claimed_mechanism": "Other Council members may defer to the local member's project-specific position on a land-use application.",
  "relevant_stage": ["council_land_use_committee", "council_disposition"],
  "possible_evidence_sources": ["project-specific statements", "held-out outcomes"],
  "rival_explanation": ["H2 — information/sensor mechanism: the member may simply observe information CityScroll lacks."],
  "falsifier": ["No useful out-of-sample lift after formal-process controls."],
  "status": "proposed",
  "promotion_evidence": null,
  "rejection_rationale": null
}
```

Every candidate requires a formal actor/process, practical actor, mechanism,
stage, possible evidence sources, at least one rival explanation, at least one
falsifier, and one of `proposed`, `testing`, `promoted`, or `rejected`.

`promoted` additionally requires `promotion_evidence` that identifies
historical evidence, useful predictive value, an inspectable evaluation, a
positive held-out population, and a baseline/candidate metric comparison.
`rejected` requires `rejection_rationale`; the record remains in the registry
so an unsuccessful hypothesis is not repeatedly rediscovered and encoded.
Promoted and rejected statuses are terminal in the status-update seam, which
prevents either evidence-backed outcome from being silently undone.

## Seed hypothesis

The initial member-deference candidate is the Card 7 pair:

* H1: other Council members may defer to the local member's project-specific
  position during Council land-use decisions.
* H2: the member's position may be an information/sensor signal because the
  member observes negotiations, constituency response, concessions, and
  project viability that CityScroll does not otherwise observe.

The falsifiers require both a time-based held-out evaluation with formal
process controls and an early-enough evidence clock to provide forecasting
value. Narrative repetition, ideology, party, demographics, reputation, and
general policy views cannot promote a candidate.

Focused proof: `node --test worker/test/land_prediction_institutional_signal_registry.test.mjs`.
