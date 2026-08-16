import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildVendorSearchDocuments,
  projectVendorSearchDocument,
  rankVendorSearchDocuments,
} from "../site/vendor_search_producer.mjs";

const ref = "vendor:stem:THINK!%20CENTER%20FOR%20LEADERSHIP";

function lookup(overrides = {}) {
  return {
    schema_version: 1,
    version: "cross_domain_object_link_v2",
    generated_at: "2026-08-12T16:01:38.473Z",
    entity_index: [{
      ref,
      kind: "vendor",
      display_name: "Think! Center for Leadership",
      domains_matched: 1,
      total_linked_objects: 1,
    }],
    by_ref: {
      [ref]: {
        ok: true,
        version: "cross_domain_object_link_v2",
        root: {
          kind: "vendor",
          ref,
          stem: "THINK! CENTER FOR LEADERSHIP",
          display_name: "Think! Center for Leadership",
        },
        links: [{
          type: "named_vendor",
          to: ref,
          confidence: "strong",
          method: "vendor_stem_v1",
          provenance: {
            source_system: "city_record",
            source_record_id: "notice:20260812001",
            source_fields: ["vendor_name"],
            observed_at: "2026-08-12",
          },
        }],
      },
    },
    ...overrides,
  };
}

const aliasRegistry = {
  entries: [{
    id: "alias-001",
    label: "verified_alias",
    status: "ACCEPTED",
    left: { display_name: "Think! Center for Leadership" },
    right: { display_name: "Think Leadership Center" },
    reviewed_date: "2026-08-05",
  }],
};

test("vendor documents preserve exact identity, reviewed aliases, route, and provenance", () => {
  const source = lookup();
  const result = projectVendorSearchDocument(ref, source.by_ref[ref], {
    lookup: source,
    aliasRegistry,
  });
  assert.equal(result.outcome, "indexed");
  assert.equal(result.document.object_ref, ref);
  assert.equal(result.document.object_type, "vendor");
  assert.equal(result.document.domain, "contracts");
  assert.equal(result.document.canonical_href, "/vendors/THINK!%20CENTER%20FOR%20LEADERSHIP/");
  assert.deepEqual(result.document.source_observation_refs, ["notice:20260812001"]);
  assert.deepEqual(result.document.provenance.reviewed_aliases, ["Think Leadership Center"]);
  assert.match(result.document.classification.basis, /exact vendor stem/i);

  const ranked = rankVendorSearchDocuments([result.document], "Think Leadership Center");
  assert.deepEqual(ranked.map((row) => row.object_ref), [ref]);
  assert.equal(ranked[0].classification.method, "canonical_vendor_read_model");
});

test("unresolved vendor identities fail closed and coverage is explicit", () => {
  const source = lookup();
  const unresolved = projectVendorSearchDocument("vendor:possible:THINK", {
    root: { kind: "vendor", ref: "vendor:possible:THINK", display_name: "Think" },
    links: [],
  }, { lookup: source, aliasRegistry });
  assert.equal(unresolved.outcome, "unclassified");
  assert.equal(unresolved.document, null);

  const partial = buildVendorSearchDocuments({
    ...source,
    entity_index: [
      ...source.entity_index,
      { ref: "vendor:possible:UNKNOWN", kind: "vendor", display_name: "Unknown" },
    ],
    by_ref: {
      ...source.by_ref,
      "vendor:possible:UNKNOWN": { root: { kind: "vendor", ref: "vendor:possible:UNKNOWN" } },
    },
  }, { aliasRegistry });
  assert.equal(partial.coverage.state, "partial");
  assert.equal(partial.coverage.indexed_count, 1);
  assert.equal(partial.coverage.not_indexed_count, 1);

  assert.equal(buildVendorSearchDocuments({
    schema_version: 1,
    version: "cross_domain_object_link_v2",
    entity_index: [],
    by_ref: {},
  }).coverage.state, "empty");
  assert.equal(buildVendorSearchDocuments({}).coverage.state, "not_indexed");
});

test("the committed entity-intelligence read model produces a bounded vendor corpus", () => {
  const source = JSON.parse(readFileSync(new URL("../site/data/entity_intelligence_lookup.json", import.meta.url)));
  const registry = JSON.parse(readFileSync(new URL("../entity_resolution/review/alias_registry.json", import.meta.url)));
  const corpus = buildVendorSearchDocuments(source, { aliasRegistry: registry });
  const vendorCount = source.entity_index.filter((row) => row.kind === "vendor").length;
  assert.equal(corpus.coverage.total_count, vendorCount);
  assert.ok(corpus.documents.length > 0);
  assert.ok(["matched", "partial"].includes(corpus.coverage.state));
  assert.ok(corpus.documents.every((row) => row.object_type === "vendor"));
});
