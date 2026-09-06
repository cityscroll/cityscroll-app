# Card "PPD-07" rendered evidence: gated research lanes and honest handoff copy

Textual evidence to accompany `capture-manifest.json`. This card ships gates,
a pre-registration, a classification, and copy — no rendered page of its own
beyond one disclosure spliced into the existing procurement detail handoff —
so, like the sibling PPD-06 evidence, there is no screenshot here. Each block
below is the exact JSON
`tools/render_procurement_research_lane_capture_fixtures.mjs` prints for the
named case, calling the real `evaluateResearchLaneGates()` and
`buildProcurementHandoffCopy()` functions against the committed registry and
the committed classification.

## The gate over the committed registry

- Case id: `research-lane-gate-green`

Every one of cards PPD-01 through PPD-06 carries its own evidence shard or capture manifest, and both runnable lanes are pre-registered by content hash, so `node tools/procurement_research_lane_gates.mjs --check` reports no failures. This is what A1 and A2 mean in practice: the ordering is machine-checked, not asserted.

```json
{
  "gate_command": "node tools/procurement_research_lane_gates.mjs --check",
  "ok": true,
  "failures": [],
  "prerequisite_cards": [
    {
      "card": "PPD-01",
      "evidence_shards": [
        "architecture/evidence.d/cityscroll-engineering--opportunity-first-alert-atom.json"
      ],
      "manifests": [
        "docs/evidence/procurement-pursuit-decision/alerts/capture-manifest.json"
      ]
    },
    {
      "card": "PPD-02",
      "evidence_shards": [],
      "manifests": [
        "docs/evidence/procurement-pursuit-decision/windows/capture-manifest.json"
      ]
    },
    {
      "card": "PPD-03",
      "evidence_shards": [
        "architecture/evidence.d/cityscroll-engineering--pursuit-snapshot.json"
      ],
      "manifests": [
        "docs/evidence/procurement-pursuit-decision/pursuit-snapshot/capture-manifest.json"
      ]
    },
    {
      "card": "PPD-04",
      "evidence_shards": [
        "architecture/evidence.d/cityscroll-engineering--related-context-and-benchmarks.json"
      ],
      "manifests": [
        "docs/evidence/procurement-pursuit-decision/related-context/capture-manifest.json"
      ]
    },
    {
      "card": "PPD-05",
      "evidence_shards": [
        "architecture/evidence.d/cityscroll-engineering--explainable-preference-set.json"
      ],
      "manifests": [
        "docs/evidence/procurement-pursuit-decision/preference-set/capture-manifest.json"
      ]
    },
    {
      "card": "PPD-06",
      "evidence_shards": [
        "architecture/evidence.d/cityscroll-engineering--lightweight-pursuit-state.json"
      ],
      "manifests": [
        "docs/evidence/procurement-pursuit-decision/pursuit-state/capture-manifest.json"
      ]
    }
  ],
  "lanes": [
    {
      "id": "outcome_study",
      "status": "gated",
      "runnable": true,
      "preregistration": {
        "path": "docs/research/procurement-response-window-study/preregistration.md",
        "content_sha256": "27b7e8a588fcd8f827a1bbe4d1b7652f8a5d7b32a1dcc357bdf8e1618e313d77"
      },
      "steps": [
        "Confirm the gate passes: every prerequisite card carries its own evidence, and this lane's pre-registration is registered by content hash.",
        "Freeze the data vintage named in the pre-registration and take the field extract it specifies.",
        "Apply the pre-registered exclusion rules before looking at any relationship.",
        "Report associations with their sample sizes and their unknowns, in the pre-registered wording."
      ]
    },
    {
      "id": "access_feasibility",
      "status": "gated",
      "runnable": true,
      "preregistration": {
        "path": "docs/research/procurement-access-classification/preregistration.md",
        "content_sha256": "2a5598ce1f8717baaf7d12b1eb5ed1c3eb7a9d3a5a6224c769f8b43de1c3e118"
      },
      "steps": [
        "Confirm the gate passes, as above.",
        "Classify each pre-registered field from committed fixtures and committed data only, with no live retrieval of any kind.",
        "Write the per-field, per-agency counts and the observation vintage to the classification file.",
        "Where a field is authenticated or unavailable, say so in the handoff copy, with the last-observed date taken from the record."
      ]
    },
    {
      "id": "learned_ranking",
      "status": "deferred",
      "runnable": false,
      "preregistration": null,
      "steps": []
    }
  ]
}
```

## The same gate with one prerequisite card’s evidence withdrawn

- Case id: `research-lane-gate-withdrawn-evidence`

The registry is copied in memory with one prerequisite card pointing at an evidence shard that is not present. The gate fails and names the card. Nothing on disk is touched by this case.

```json
{
  "withdrawn_card": "PPD-01",
  "withdrawn_shard": "cityscroll-engineering/opportunity-first-alert-atom",
  "ok": false,
  "failures": [
    {
      "code": "missing_evidence_shard",
      "detail": "Card PPD-01 names evidence shard cityscroll-engineering/opportunity-first-alert-atom-withdrawn-for-this-capture, which is not present at architecture/evidence.d/cityscroll-engineering--opportunity-first-alert-atom-withdrawn-for-this-capture.json.",
      "card": "PPD-01"
    }
  ]
}
```

## The access classification, summarized

- Case id: `access-classification-summary`

Each examined field with its class and its sample size, plus the corpus, the thresholds, and the observation vintage the classification was produced at. The full per-field, per-agency counts are in `docs/research/procurement-access-classification/classification.json`.

```json
{
  "schema": "cityscroll.procurement_access_classification.v1",
  "observation_vintage": {
    "browse_projection_generated_at": "2026-08-18T04:05:51.552Z",
    "read_model_generated_at": "2026-08-18T04:05:51.552Z",
    "source_contracts_document": "docs/data-sources.md",
    "attachment_metadata_built_at": "2026-08-09T01:41:39.752Z"
  },
  "corpus": {
    "records": 13791,
    "agencies": 101,
    "source_observations": 27670
  },
  "thresholds": {
    "min_records": 200,
    "min_agencies": 10,
    "min_presence_rate": 0.3
  },
  "summary": {
    "fields_total": 15,
    "by_class": {
      "accessible": 6,
      "authenticated": 2,
      "unavailable": 1,
      "unstable": 6
    }
  },
  "fields": [
    {
      "id": "solicitation_title",
      "class": "accessible",
      "records_observed": 13791,
      "records_examined": 13791,
      "agencies_observed": 101
    },
    {
      "id": "publishing_agency",
      "class": "accessible",
      "records_observed": 13790,
      "records_examined": 13791,
      "agencies_observed": 101
    },
    {
      "id": "solicitation_identifier",
      "class": "accessible",
      "records_observed": 13786,
      "records_examined": 13791,
      "agencies_observed": 98
    },
    {
      "id": "procurement_method",
      "class": "accessible",
      "records_observed": 12770,
      "records_examined": 13791,
      "agencies_observed": 65
    },
    {
      "id": "published_amount",
      "class": "accessible",
      "records_observed": 13788,
      "records_examined": 13791,
      "agencies_observed": 100
    },
    {
      "id": "official_notice_pointer",
      "class": "accessible",
      "records_observed": 12899,
      "records_examined": 13791,
      "agencies_observed": 44
    },
    {
      "id": "response_due_date",
      "class": "unstable",
      "records_observed": 3,
      "records_examined": 27670,
      "agencies_observed": 2
    },
    {
      "id": "solicitation_release_date",
      "class": "unstable",
      "records_observed": 2,
      "records_examined": 27670,
      "agencies_observed": 2
    },
    {
      "id": "published_contact",
      "class": "unstable",
      "records_observed": 0,
      "records_examined": 27670,
      "agencies_observed": 0
    },
    {
      "id": "pre_bid_conference",
      "class": "unstable",
      "records_observed": 0,
      "records_examined": 27670,
      "agencies_observed": 0
    },
    {
      "id": "certification_goal_marker",
      "class": "unstable",
      "records_observed": 0,
      "records_examined": 27670,
      "agencies_observed": 0
    },
    {
      "id": "solicitation_package_documents",
      "class": "authenticated",
      "records_observed": 8,
      "records_examined": 13791,
      "agencies_observed": 0
    },
    {
      "id": "qa_content",
      "class": "authenticated",
      "records_observed": 0,
      "records_examined": 27670,
      "agencies_observed": 0
    },
    {
      "id": "amendment_documents",
      "class": "unavailable",
      "records_observed": 0,
      "records_examined": 27670,
      "agencies_observed": 0
    },
    {
      "id": "published_bid_results",
      "class": "unstable",
      "records_observed": 1,
      "records_examined": 1,
      "agencies_observed": 0
    }
  ]
}
```

## Handoff copy for Fixture A’s matter

- Case id: `handoff-copy-fixture-a`

The lines the procurement detail handoff shows beneath the official records for the workstream’s Fixture A matter. The last-observed date is the record’s own latest observation stamp (2026-07-02), rendered as a date; it is never read from the clock.

```json
{
  "schema": "cityscroll.procurement_handoff_copy.v1",
  "observation_vintage": {
    "browse_projection_generated_at": "2026-08-18T04:05:51.552Z",
    "read_model_generated_at": "2026-08-18T04:05:51.552Z",
    "source_contracts_document": "docs/data-sources.md",
    "attachment_metadata_built_at": "2026-08-09T01:41:39.752Z"
  },
  "last_observed_at": "2026-07-02T10:00:00Z",
  "notes": [
    {
      "field": "solicitation_package_documents",
      "label": "Solicitation package documents",
      "class": "authenticated",
      "sign_in_required": true,
      "last_observed_at": "2026-07-02T10:00:00Z",
      "last_observed_label": "Jul 2, 2026",
      "line": "PASSPort sign-in is required to reach the solicitation package documents. CityScroll last observed this matter on Jul 2, 2026."
    },
    {
      "field": "qa_content",
      "label": "Question and answer content",
      "class": "authenticated",
      "sign_in_required": true,
      "last_observed_at": "2026-07-02T10:00:00Z",
      "last_observed_label": "Jul 2, 2026",
      "line": "PASSPort sign-in is required to reach the question and answer content. CityScroll last observed this matter on Jul 2, 2026."
    },
    {
      "field": "amendment_documents",
      "label": "Amendment documents",
      "class": "unavailable",
      "sign_in_required": false,
      "last_observed_at": "2026-07-02T10:00:00Z",
      "last_observed_label": "Jul 2, 2026",
      "line": "No public source CityScroll observes carries the amendment documents. CityScroll last observed this matter on Jul 2, 2026."
    }
  ]
}
```

## Handoff copy for a record carrying no observation date

- Case id: `handoff-copy-no-observation-date`

The same classification against a record with no observation stamp of its own. Every line keeps its access statement and simply carries no date sentence — a missing date is never filled in from the clock.

```json
{
  "schema": "cityscroll.procurement_handoff_copy.v1",
  "observation_vintage": {
    "browse_projection_generated_at": "2026-08-18T04:05:51.552Z",
    "read_model_generated_at": "2026-08-18T04:05:51.552Z",
    "source_contracts_document": "docs/data-sources.md",
    "attachment_metadata_built_at": "2026-08-09T01:41:39.752Z"
  },
  "last_observed_at": null,
  "notes": [
    {
      "field": "solicitation_package_documents",
      "label": "Solicitation package documents",
      "class": "authenticated",
      "sign_in_required": true,
      "last_observed_at": null,
      "last_observed_label": null,
      "line": "PASSPort sign-in is required to reach the solicitation package documents."
    },
    {
      "field": "qa_content",
      "label": "Question and answer content",
      "class": "authenticated",
      "sign_in_required": true,
      "last_observed_at": null,
      "last_observed_label": null,
      "line": "PASSPort sign-in is required to reach the question and answer content."
    },
    {
      "field": "amendment_documents",
      "label": "Amendment documents",
      "class": "unavailable",
      "sign_in_required": false,
      "last_observed_at": null,
      "last_observed_label": null,
      "line": "No public source CityScroll observes carries the amendment documents."
    }
  ]
}
```
