import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildParcelSearchDocuments,
  projectParcelSearchDocument,
} from "../site/parcel_search_producer.mjs";

const bbl = "3017910019";

function crossDomain(overrides = {}) {
  return {
    schema_version: 1,
    version: "property_cross_domain_v1",
    generated_at: "2026-08-06T00:05:16.576Z",
    provenance: {
      methods: ["exact_bbl_v1"],
      sources: ["property_domain_observations", "zap-bbl", "LL48"],
      property_feed: { source_generated_at: "2026-08-02T13:13:26.639Z" },
    },
    coverage: { by_bbl_count: 1, property_rows_with_bbl: 1, zap_matched_bbl_count: 1 },
    by_bbl: {
      [bbl]: {
        bbl,
        parcel_ref: `bbl:${bbl}`,
        status: "matched",
        property_notices: [{ request_id: "20241112003", method: "exact_bbl_v1" }],
        land_projects: [{ project_id: "2024K0123", method: "exact_bbl_v1", confidence: "strong" }],
        ll48: {
          status: "matched",
          items: [{
            id: `4e2n-s75z:bbl:${bbl}`,
            bbl,
            label: "City-owned site",
            address: "123 Fulton Street",
            method: "exact_bbl_v1",
            provenance: { source_record_id: `4e2n-s75z:bbl:${bbl}` },
          }],
        },
      },
    },
    ...overrides,
  };
}

function residentSnapshot() {
  return {
    schema_version: 1,
    generated_at: "2026-08-02T18:47:20.520Z",
    properties: [{
      request_id: "20241112003",
      short_title: "Disposition of 123 Fulton Street",
      property_location: {
        bbls: [bbl],
        addresses: [
          { label: "123 Fulton Street", borough: "Brooklyn", bbl },
          { label: "Possible unstamped address", borough: "Brooklyn", bbl: null },
        ],
      },
      disposition_join_keys: [`bbl:${bbl}`],
    }],
  };
}

test("parcel documents retain exact BBL identity, address labels, linked identifiers, and provenance", () => {
  const source = crossDomain();
  const result = projectParcelSearchDocument(bbl, source.by_bbl[bbl], {
    crossDomain: source,
    residentSnapshot: residentSnapshot(),
  });
  assert.equal(result.outcome, "indexed");
  assert.equal(result.document.object_ref, `bbl:${bbl}`);
  assert.equal(result.document.object_type, "parcel");
  assert.equal(result.document.domain, "property");
  assert.equal(result.document.canonical_href, `/parcels/${bbl}/`);
  assert.ok(result.document.search_text.includes("123 Fulton Street"));
  assert.ok(!result.document.search_text.includes("Possible unstamped address"));
  assert.ok(result.document.search_text.includes("2024K0123"));
  assert.deepEqual(result.document.source_observation_refs, [
    "notice:20241112003",
    "project:2024K0123",
    `4e2n-s75z:bbl:${bbl}`,
  ]);
  assert.equal(result.document.provenance.identity.method, "exact_bbl_v1");
  assert.deepEqual(result.document.provenance.match_states, ["exact", "verified"]);
});

test("possible and inconsistent parcel matches fail closed with explicit coverage", () => {
  const source = crossDomain();
  const possible = projectParcelSearchDocument(bbl, {
    bbl,
    parcel_ref: `possible-bbl:${bbl}`,
    status: "possible",
  }, { crossDomain: source, residentSnapshot: residentSnapshot() });
  assert.equal(possible.outcome, "unclassified");
  assert.equal(possible.document, null);

  const partial = buildParcelSearchDocuments(crossDomain({
    by_bbl: {
      ...source.by_bbl,
      "3017910020": { bbl: "3017910020", parcel_ref: "possible-bbl:3017910020", status: "possible" },
    },
  }), { residentSnapshot: residentSnapshot() });
  assert.equal(partial.coverage.state, "partial");
  assert.equal(partial.documents.length, 1);
  assert.equal(buildParcelSearchDocuments(crossDomain({ by_bbl: {} })).coverage.state, "empty");
  assert.equal(buildParcelSearchDocuments({}).coverage.state, "not_indexed");
});

test("the committed exact-BBL graph admits every observed parcel regardless of ZAP match", () => {
  const source = JSON.parse(readFileSync(new URL("../site/data/property_cross_domain_lookup.json", import.meta.url)));
  const residents = JSON.parse(readFileSync(new URL("../site/data/property_resident_snapshot.json", import.meta.url)));
  const corpus = buildParcelSearchDocuments(source, { residentSnapshot: residents });
  assert.equal(corpus.coverage.state, "matched");
  assert.equal(corpus.documents.length, Object.keys(source.by_bbl).length);
  assert.ok(corpus.documents.some((row) => row.provenance.match_states.includes("verified")));
});
