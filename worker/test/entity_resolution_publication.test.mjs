import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PUBLIC_ENTITY_FIELDS,
  PUBLIC_ENTITY_LINK_FIELDS,
  measurePublicEntityLinkConfidenceRate,
  publicEntityLinkConfidence,
  serializePublicEntity,
  serializePublicEntityLink,
} from "../../entity_resolution/publication/index.mjs";

const disallowed = {
  raw_snapshot: "private-raw-marker",
  normalized_snapshot: "private-normalized-marker",
  content_hash: "private-hash-marker",
  attrs_json: "private-attrs-marker",
  method: "private-method-marker",
  matcher_version: "private-matcher-marker",
  evidence_json: "private-evidence-marker",
  resolution_run_id: "private-run-marker",
  review_status: "private-review-marker",
  reviewer: "private-reviewer-marker",
  notes: "private-notes-marker",
};

const privateMarkers = [
  "private-raw-marker",
  "private-normalized-marker",
  "private-hash-marker",
  "private-attrs-marker",
  "private-confidence-marker",
  "private-method-marker",
  "private-matcher-marker",
  "private-evidence-marker",
  "private-run-marker",
  "private-review-marker",
  "private-reviewer-marker",
  "private-notes-marker",
];

function assertDeskFieldsAbsent(value) {
  const json = JSON.stringify(value);
  for (const marker of privateMarkers) {
    assert.doesNotMatch(json, new RegExp(marker));
  }
  // Raw desk numeric confidence and matcher method must not leak.
  assert.doesNotMatch(json, /"confidence"\s*:/);
  assert.doesNotMatch(json, /"method"\s*:/);
  assert.doesNotMatch(json, /"matcher_version"\s*:/);
  assert.doesNotMatch(json, /"evidence_json"\s*:/);
  assert.doesNotMatch(json, /"resolution_run_id"\s*:/);
  assert.doesNotMatch(json, /"review_status"\s*:/);
  assert.doesNotMatch(json, /source_record_id|raw_snapshot|normalized_snapshot|content_hash|attrs_json/);
}

test("public entity serialization is an explicit field allowlist", () => {
  assert.deepEqual(PUBLIC_ENTITY_FIELDS, ["id", "type", "name"]);
  const serialized = serializePublicEntity({
    id: "vendor:acme",
    entity_type: "vendor",
    display_name: "Acme LLC",
    confidence: "private-confidence-marker",
    ...disallowed,
  });

  assert.deepEqual(serialized, {
    id: "vendor:acme",
    type: "vendor",
    name: "Acme LLC",
  });
  assertDeskFieldsAbsent(serialized);
});

test("public link serialization exposes provenance and banded link confidence", () => {
  assert.deepEqual(PUBLIC_ENTITY_LINK_FIELDS, ["entity_id", "source", "link_confidence"]);
  const strong = serializePublicEntityLink({
    canonical_entity_id: "vendor:acme",
    source_system: "city_record",
    source_system_id: "20260801001",
    source_url: "https://example.gov/records/20260801001",
    source_record_id: "city_record:20260801001:private-content-hash",
    confidence: 0.98,
    ...disallowed,
  });

  assert.deepEqual(strong, {
    entity_id: "vendor:acme",
    source: {
      system: "city_record",
      id: "20260801001",
      url: "https://example.gov/records/20260801001",
    },
    link_confidence: { status: "strong", basis: "entity_link" },
  });
  assertDeskFieldsAbsent(strong);
  assert.doesNotMatch(JSON.stringify(strong), /0\.98|private-content-hash/);

  const tentative = serializePublicEntityLink({
    canonical_entity_id: "vendor:acme",
    source_system: "checkbook",
    source_system_id: "CT-1",
    confidence: 0.84,
  });
  assert.deepEqual(tentative.link_confidence, { status: "tentative", basis: "entity_link" });
  assert.doesNotMatch(JSON.stringify(tentative), /0\.84/);
});

test("publicEntityLinkConfidence bands scores without exposing numbers", () => {
  assert.deepEqual(publicEntityLinkConfidence(0.95), { status: "strong", basis: "entity_link" });
  assert.deepEqual(publicEntityLinkConfidence(0.949), { status: "tentative", basis: "entity_link" });
  assert.deepEqual(publicEntityLinkConfidence(null), { status: "not_scored", basis: "entity_link" });
  assert.deepEqual(publicEntityLinkConfidence("nope"), { status: "not_scored", basis: "entity_link" });
});

test("public_entity_link_confidence_rate moves 0 → 1 when bands are present", () => {
  const unlabeled = {
    entity: { id: "vendor:acme" },
    linked_records: [
      { source: { system: "city_record", id: "1" } },
      { source: { system: "checkbook", id: "2" } },
    ],
  };
  const labeled = {
    entity: { id: "vendor:acme" },
    linked_records: [
      {
        source: { system: "city_record", id: "1" },
        link_confidence: { status: "strong", basis: "entity_link" },
      },
      {
        source: { system: "checkbook", id: "2" },
        link_confidence: { status: "tentative", basis: "entity_link" },
      },
    ],
  };
  const before = measurePublicEntityLinkConfidenceRate([unlabeled]);
  assert.equal(before.metric, "public_entity_link_confidence_rate");
  assert.equal(before.eligible, 2);
  assert.equal(before.labeled, 0);
  assert.equal(before.rate, 0);

  const after = measurePublicEntityLinkConfidenceRate([labeled]);
  assert.equal(after.eligible, 2);
  assert.equal(after.labeled, 2);
  assert.equal(after.rate, 1);
});

test("public serializers fail closed when required display fields are absent", () => {
  assert.equal(serializePublicEntity({ id: "vendor:acme", entity_type: "vendor" }), null);
  assert.equal(serializePublicEntityLink({
    canonical_entity_id: "vendor:acme",
    source_record_id: "city_record:notice:hash",
  }), null);
});
