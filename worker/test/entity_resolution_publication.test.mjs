import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PUBLIC_ENTITY_FIELDS,
  PUBLIC_ENTITY_LINK_FIELDS,
  serializePublicEntity,
  serializePublicEntityLink,
} from "../../entity_resolution/publication/index.mjs";

const disallowed = {
  raw_snapshot: "private-raw-marker",
  normalized_snapshot: "private-normalized-marker",
  content_hash: "private-hash-marker",
  attrs_json: "private-attrs-marker",
  confidence: "private-confidence-marker",
  method: "private-method-marker",
  matcher_version: "private-matcher-marker",
  evidence_json: "private-evidence-marker",
  resolution_run_id: "private-run-marker",
  review_status: "private-review-marker",
  reviewer: "private-reviewer-marker",
  notes: "private-notes-marker",
};

function assertAbsentFromJson(value) {
  const json = JSON.stringify(value);
  for (const [field, marker] of Object.entries(disallowed)) {
    assert.doesNotMatch(json, new RegExp(field));
    assert.doesNotMatch(json, new RegExp(marker));
  }
}

test("public entity serialization is an explicit field allowlist", () => {
  assert.deepEqual(PUBLIC_ENTITY_FIELDS, ["id", "type", "name"]);
  const serialized = serializePublicEntity({
    id: "vendor:acme",
    entity_type: "vendor",
    display_name: "Acme LLC",
    ...disallowed,
  });

  assert.deepEqual(serialized, {
    id: "vendor:acme",
    type: "vendor",
    name: "Acme LLC",
  });
  assertAbsentFromJson(serialized);
});

test("public link serialization exposes public provenance without matcher internals", () => {
  assert.deepEqual(PUBLIC_ENTITY_LINK_FIELDS, ["entity_id", "source"]);
  const serialized = serializePublicEntityLink({
    canonical_entity_id: "vendor:acme",
    source_system: "city_record",
    source_system_id: "20260801001",
    source_url: "https://example.gov/records/20260801001",
    source_record_id: "city_record:20260801001:private-content-hash",
    ...disallowed,
  });

  assert.deepEqual(serialized, {
    entity_id: "vendor:acme",
    source: {
      system: "city_record",
      id: "20260801001",
      url: "https://example.gov/records/20260801001",
    },
  });
  assertAbsentFromJson(serialized);
  assert.doesNotMatch(JSON.stringify(serialized), /source_record_id|private-content-hash/);
});

test("public serializers fail closed when required display fields are absent", () => {
  assert.equal(serializePublicEntity({ id: "vendor:acme", entity_type: "vendor" }), null);
  assert.equal(serializePublicEntityLink({
    canonical_entity_id: "vendor:acme",
    source_record_id: "city_record:notice:hash",
  }), null);
});
