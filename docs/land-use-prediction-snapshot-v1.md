# Land-use prediction snapshot v1

Card 2 defines the temporal snapshot contract used by later Land-Use
Prediction v2 work. The implementation is
[`worker/src/lib/land_prediction_snapshot.mjs`](../worker/src/lib/land_prediction_snapshot.mjs).
It is an input contract only: it does not predict an outcome, infer a stance,
or create a feature vector.

## Shape

```json
{
  "schema_version": 1,
  "application_id": "2024A0001",
  "prediction_as_of": "2024-06-01T00:00:00.000Z",
  "procedural_stage": "cpc",
  "features": [
    {
      "key": "community_board_action",
      "value": "conditional_favorable",
      "state": "known",
      "evidence_type": "official_record",
      "observed_at": "2024-05-20T00:00:00.000Z",
      "effective_at": "2024-05-20T00:00:00.000Z",
      "source": "source-record-id",
      "confidence": 0.8
    }
  ],
  "historical_actors": []
}
```

Every feature has a value, evidence type, both source clocks (null when not
applicable), source, and confidence (null when not applicable). `state` makes
missingness explicit:

- `unknown`: no usable evidence is available at the cutoff;
- `no_known_position`: the bounded source search established that no position
  is known at the cutoff;
- `neutral_mixed`: substantive project-specific evidence is neutral, mixed, or
  conflicting; it is not an absence of evidence;
- `known`: a substantive value is available.

An unknown feature is never converted into either of the other two states.
When all candidate evidence for a feature is after `prediction_as_of`, the
feature remains present as `unknown` with no future source or timestamp copied
into the snapshot. Separate admitted observations may retain the same feature
key, so conflicting evidence is not silently collapsed.

## Temporal rule

`observed_at` is the availability clock. A feature observed after
`prediction_as_of` is excluded. If no observation clock exists,
`effective_at` is treated conservatively as its first-available clock. A future
`effective_at` may remain when the evidence was observed before the cutoff,
because a published schedule can describe a future event without being
hindsight. The cutoff is inclusive.

The builder canonicalizes timestamps, source-object key order, feature order,
and historical actor order. The same inputs therefore produce byte-identical
JSON. Historical actors are resolved through an optional callback that always
receives the normalized `prediction_as_of`; absent a resolver, actor identity
is explicitly `unknown` rather than a current-officeholder guess. Full member
and district resolution belongs to Card 3.
