import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildCouncilMatterSearchDocuments } from "../site/council_matter_search_producer.mjs";
import { projectLandSearchDocument } from "../site/land_search_producer.mjs";
import { buildProcurementSearchDocuments } from "../site/procurement_search_producer.mjs";
import { exactIdentifierVariants, siteHistoryForParcelIds } from "../site/search_identifier_support.mjs";
import { keywordTextMatches, resolveKeywordQuery } from "../site/keyword_matcher.mjs";
import { createSiteLifecycleReader } from "../site/site_lifecycle_projection.mjs";
import { parseAddressQuery, resolveAddressFromShard } from "../site/precomputed_address_geocoder.mjs";
import { testClockISOString, withPinnedClock } from "./helpers/test_clock.mjs";

const PROCUREMENT_FIXTURE = JSON.parse(readFileSync(
  new URL("./fixtures/site_lifecycle_identifier_search/procurement_coyle.json", import.meta.url),
  "utf8",
));

const LAND = projectLandSearchDocument({
  project_id: "2020K0270",
  project_name: "Coyle Street Rezoning",
  ulurp_numbers: "C210239ZMK; N210240ZRK",
  ceqr_number: "21DCP123K",
  bbls: ["3073670011", "3073670029"],
}, { artifact: { schema_version: 1, dataset_id: "hgx4-8ukb", source: "ZAP", materialized_at: "2026-09-09" } }).document;

test("native land and procurement documents retain exact identifiers and parcel history", async () => {
  await withPinnedClock("2026-09-15T12:00:00.000Z", async () => {
    const procurementModel = {
      schema: "cityscroll.shared_procurement_read_model.v1",
      generated_at: testClockISOString(),
      rows: [PROCUREMENT_FIXTURE.object],
      observations: PROCUREMENT_FIXTURE.observations,
      sources: {},
    };
    const procurement = buildProcurementSearchDocuments(procurementModel).documents[0];

  for (const query of [
    "3073670011", "2020K0270", "21DCP123K", "C 210239 ZMK", "N 210240 ZRK",
  ]) assert.equal(keywordTextMatches(LAND.search_text, resolveKeywordQuery(query)), true, query);
  assert.ok(procurement, "the native procurement producer must emit a document");
  for (const query of ["07122P0010020", "CT107120258802303", "20241104015"]) {
    assert.equal(keywordTextMatches(procurement.search_text, resolveKeywordQuery(query)), true, query);
  }
  assert.equal(LAND.canonical_href, "/browse/zoning/#land/2020K0270");
  assert.equal(procurement.object_ref, PROCUREMENT_FIXTURE.object.procurement_id);
  assert.equal(procurement.canonical_href, "/procurements/procurement%3Acontract%3ACT107120258802303");
  assert.deepEqual(procurement.provenance.site_history, {
    parcel_ids: ["3073670011"],
    href: "/parcels/3073670011/",
    relation: "accepted_exact_parcel_membership",
  });
  assert.equal(
    keywordTextMatches(LAND.search_text, resolveKeywordQuery("07122P0010020")),
    false,
    "the procurement PIN must not become a land alias",
  );
  assert.deepEqual(LAND.provenance.site_history, {
    parcel_ids: ["3073670011", "3073670029"],
    href: "/parcels/3073670011/",
    relation: "accepted_exact_parcel_membership",
  });
  assert.equal(siteHistoryForParcelIds([]), null);
  });
});

test("retained Council matter identifiers remain native matter results", () => {
  const corpus = buildCouncilMatterSearchDocuments({
    generated_at: "2026-09-05",
    matters: {
      "90001": {
        matter_id: "90001", matter_file: "LU 0010-2022", join_value: "C210239ZMK",
        project_id: "2020K0270", resolution_ids: ["Res 0051-2022", "Res 0052-2022"],
        title: "Coyle Street Rezoning", source_url: "https://nyc.legistar.com/Gateway.aspx?M=L&ID=90001",
        parcel_ids: ["3073670011"],
      },
    },
  });
  const doc = corpus.documents[0];
  for (const query of ["LU 0010-2022", "C 210239 ZMK", "Res 0051-2022", "2020K0270"]) {
    assert.equal(keywordTextMatches(doc.search_text, resolveKeywordQuery(query)), true, query);
  }
  assert.equal(doc.object_ref, "council:matter:90001");
  assert.equal(doc.canonical_href, "/matters/90001/");
  assert.equal(doc.provenance.site_history.href, "/parcels/3073670011/");
});

test("PAD entrance is unique-or-unknown and never chooses a borough", () => {
  const query = parseAddressQuery("250 Broadway");
  const shard = { schema: "cityscroll.address-index-shard.v1", streets: { BROADWAY: [[1000, 999000, 0, "1000000001", "10001"], [1000, 999000, 0, "2000000002", "10451"]] } };
  assert.equal(resolveAddressFromShard(query, shard).status, "unknown");
  assert.equal(resolveAddressFromShard(query, shard).reason, "ambiguous");
});

test("site-history readers reject mismatched reverse generations", () => {
  assert.throws(() => createSiteLifecycleReader(
    { generation: "g1", content_hash: "h1" },
    [{ generation: "g1", rows: [] }],
    { generation: "g2", content_hash: "h1", members: {} },
  ), /generation mismatch/);
});
