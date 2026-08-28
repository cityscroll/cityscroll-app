# Land-use prediction member stance v1

Card 4 adds a source-preserving, application-specific Council member stance
contract. The implementation is
[`worker/src/lib/land_prediction_member_stance.mjs`](../worker/src/lib/land_prediction_member_stance.mjs).
It is a bounded evidence projection, not an ideology or political score.

## Record shape

```json
{
  "schema_version": 1,
  "application_id": "2024A0001",
  "member_id": "official:123",
  "as_of": "2024-06-01T00:00:00.000Z",
  "evidence": [
    {
      "evidence_id": "statement-1",
      "application_id": "2024A0001",
      "member_id": "official:123",
      "direction": "support",
      "evidence_type": "direct_public_statement",
      "source": { "url": "https://example.invalid/statement-1" },
      "source_language": "The member said the application should move forward.",
      "observed_at": "2024-05-20T12:00:00.000Z",
      "effective_at": "2024-05-20T12:00:00.000Z",
      "confidence": 0.9
    }
  ],
  "resolution": {
    "as_of": "2024-06-01T00:00:00.000Z",
    "direction": "support",
    "confidence": 0.9,
    "selected_evidence_ids": ["statement-1"],
    "reason": "latest_evidence",
    "history": [
      {
        "evidence_id": "statement-1",
        "direction": "support",
        "observed_at": "2024-05-20T12:00:00.000Z",
        "effective_at": "2024-05-20T12:00:00.000Z",
        "status": "current"
      }
    ]
  }
}
```

`direction` is one of `support`, `oppose`, `conditional`,
`mixed_or_unclear`, or `unknown`. `confidence` is a separate bounded
evidence-strength field; it never supplies or changes direction.

The six admitted evidence types are:

* `direct_public_statement`
* `hearing_or_meeting_remarks`
* `requested_project_modification`
* `official_press_release_or_newsletter`
* `project_specific_legislative_or_committee_action`
* `reputable_reporting`

Each evidence row must preserve source language, an inspectable source
locator, both exact application and member IDs, an observation timestamp, and
confidence. Rows observed after `as_of` are excluded from that historical
projection, leaving `unknown` when no in-scope evidence remains. A future
`effective_at` is allowed when the source was already observed by `as_of`, as
the source may describe a future-effective stance. The contract does not
represent party, ideology, demographics, endorsements, reputation, or
generalized housing views, so those facts cannot produce a stance.

## Deterministic history and conflicts

Evidence is retained in ascending `(effective_at || observed_at, observed_at,
evidence_id)` order. The latest effective/observed clock is authoritative for
the current projection:

* no evidence yields `unknown` with no confidence;
* a latest explicit `unknown` yields `unknown`, including when older evidence
  existed;
* more than one substantive direction at the latest clock yields
  `mixed_or_unclear`, retains every conflicting evidence ID, and leaves current
  confidence null;
* one substantive direction at the latest clock supersedes earlier evidence;
  same-direction rows remain selected and current confidence is the
  conservative minimum of their evidence confidence values.

Supersession changes only the derived `resolution`; it never removes an
evidence row. `appendLandMemberStanceEvidence` is the history-preserving
addition seam for later observations.
