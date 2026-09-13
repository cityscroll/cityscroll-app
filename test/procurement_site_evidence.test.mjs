import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  addressShardKey,
  parseAddressQuery,
} from "../site/precomputed_address_geocoder.mjs";
import {
  materializeProcurementSiteEvidence,
  sourceAcquisitionSelect,
  validateProcurementSiteEvidence,
} from "../warehouse/lib/procurement_site_evidence.mjs";
import { rowToSiteEvidenceSource } from "../warehouse/lib/ocp_lookup.mjs";

const fixtureUrl = new URL("../warehouse/fixtures/procurement-site-evidence/field_cases.json", import.meta.url);

async function loadFixture() {
  return JSON.parse(await readFile(fixtureUrl, "utf8"));
}

function fixtureResolver(fixture) {
  const manifest = {
    schema: "cityscroll.address-index-manifest.v1",
    generated_at: fixture.source_snapshot.pad_generated_at,
    source: { version: fixture.source_snapshot.pad_version },
    shard_count: 64,
  };
  const shards = new Map();
  for (const row of fixture.pad_rows) {
    const query = parseAddressQuery(row.address);
    const key = addressShardKey(query.street, 64);
    const shard = shards.get(key) || {
      schema: "cityscroll.address-index-shard.v1",
      key,
      streets: {},
    };
    shard.streets[query.street] ||= [];
    shard.streets[query.street].push([query.house_sort, query.house_sort, 0, row.bbl, row.zip]);
    shards.set(key, shard);
  }
  return { manifest, shards };
}

function recordFor(doc, source, id) {
  return doc.records.find((record) => record.source_system === source && record.request_id === id);
}

test("site-evidence acquisition retains publisher prose and role-specific addresses before OCP projection", () => {
  const source = rowToSiteEvidenceSource({
    request_id: "20241104015",
    additional_description_1: "facility text",
    other_info_1: "other text",
    vendor_address: "vendor address",
    address_to_request: "request address",
  });
  assert.match(sourceAcquisitionSelect(), /additional_description_1/);
  assert.match(sourceAcquisitionSelect(), /vendor_address/);
  assert.equal(source.additional_description_1, "facility text");
  assert.equal(source.other_info_1, "other text");
  assert.equal(source.vendor_address, "vendor address");
  assert.equal(source.address_to_request, "request address");
});

test("the reviewed fixture table replays through the real site-evidence materializer", async () => {
  const fixture = await loadFixture();
  const doc = materializeProcurementSiteEvidence({
    retainedAwardRows: fixture.award_rows,
    awardRows: fixture.award_rows,
    hearingRows: fixture.hearing_rows,
    resolver: fixtureResolver(fixture),
    sourceSnapshot: fixture.source_snapshot,
  });
  validateProcurementSiteEvidence(doc);

  assert.equal(doc.acquisition.retained_award_ids, 9);
  assert.equal(doc.acquisition.hearing_rows_reached_by_exact_identifier, 1);
  assert.deepEqual(doc.graph_edges, []);

  const coyle = recordFor(doc, "ocp_recent_contract_awards", "20241104015");
  assert.equal(coyle.classification, "accepted");
  assert.deepEqual(coyle.evidence.map((item) => item.resolved_bbl), ["3073670011"]);
  assert.equal(coyle.address_roles.vendor.published_value, "8 Bashford Street");
  assert.equal(coyle.address_roles.request.published_value, "150 Greenwich Street, New York, NY 10007");
  assert.equal(coyle.evidence[0].unit, null);
  assert.equal(coyle.evidence[0].provenance.resolver.version, "26b");

  const hearing = recordFor(doc, "city_record_online", "20230911014");
  assert.equal(hearing.epin, "07122P0010020");
  assert.equal(hearing.evidence.length, 1);
  assert.equal(hearing.evidence[0].resolved_bbl, "3073670011");
  assert.match(hearing.section_locator, /in-the-matter-of:07/);
  assert.notEqual(hearing.evidence[0].parent_notice_id, null);

  const staffing = recordFor(doc, "ocp_recent_contract_awards", "20021219009");
  assert.equal(staffing.classification, "unsupported_extraction");
  assert.equal(staffing.evidence.length, 0);

  const annex = recordFor(doc, "ocp_recent_contract_awards", "20260728014");
  assert.equal(annex.classification, "accepted");
  assert.deepEqual(annex.evidence.map((item) => item.resolved_bbl).sort(), ["2031870007", "3016001001"]);
  assert.equal(new Set(annex.evidence.map((item) => item.contract_scope.epin)).size, 1);

  const ambiguous = recordFor(doc, "ocp_recent_contract_awards", "20250718031");
  assert.equal(ambiguous.classification, "ambiguous_target");
  assert.equal(ambiguous.evidence[0].resolution.candidate_cardinality, 2);
  assert.equal(ambiguous.evidence[0].resolved_bbl, null);
  assert.equal(ambiguous.evidence[0].source_field, "short_title");

  const conflict = recordFor(doc, "ocp_recent_contract_awards", "20241130012");
  assert.equal(conflict.classification, "conflicting_target");
  assert.equal(conflict.evidence.length, 2);
  assert.ok(conflict.evidence.every((item) => item.resolution.status === "conflicting_target" && !item.resolved_bbl));
  assert.ok(conflict.evidence.every((item) => !/Livingston|Pine/.test(item.published_value)));

  const cleaning = recordFor(doc, "ocp_recent_contract_awards", "20250320005");
  assert.equal(cleaning.classification, "accepted");
  assert.equal(cleaning.evidence[0].resolved_bbl, "2024430100");
  assert.equal(cleaning.evidence[0].unit, "6th Floor");

  for (const [id, capacity] of [["20260804018", 150], ["20260817022", 200]]) {
    const tillary = recordFor(doc, "ocp_recent_contract_awards", id);
    assert.equal(tillary.classification, "accepted");
    assert.equal(tillary.evidence[0].resolved_bbl, "3020500104");
    assert.match(tillary.title, new RegExp(`${capacity} beds`));
  }

  const icahn = recordFor(doc, "ocp_recent_contract_awards", "20260730013");
  assert.equal(icahn.classification, "accepted");
  assert.equal(icahn.evidence[0].resolved_bbl, "1020840001");
  assert.equal(icahn.address_roles.vendor.published_value, "4 E 28th Street");
  assert.equal(icahn.evidence[0].original_address, "4 East 28th Street");
});

test("record-level reasons preserve empty, unsupported, conflict, and acquisition states", async () => {
  const fixture = await loadFixture();
  const extra = [
    { request_id: "empty-body", short_title: "Ordinary award", pin: "99999X0000001" },
    { request_id: "uncovered-site", short_title: "Shelter service", pin: "99999X0000002", additional_description_1: "Shelter service at 999 Unknown Street, Brooklyn, NY 11201." },
  ];
  const doc = materializeProcurementSiteEvidence({
    retainedAwardRows: extra,
    awardRows: extra,
    resolver: fixtureResolver(fixture),
  });
  assert.equal(doc.records.find((record) => record.request_id === "empty-body").classification, "no_publisher_body");
  assert.equal(doc.records.find((record) => record.request_id === "uncovered-site").classification, "successful_empty_scope");
});
