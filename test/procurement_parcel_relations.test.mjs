import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { addressShardKey, parseAddressQuery } from "../site/precomputed_address_geocoder.mjs";

import {
  materializeProcurementSiteEvidence,
} from "../warehouse/lib/procurement_site_evidence.mjs";
import {
  observationFromMoneyRow,
  observationFromPassportContractRow,
} from "../entity_resolution/cross_domain/object_links.mjs";
import {
  buildProcurementParcelRelations,
  validateProcurementParcelRelations,
} from "../warehouse/lib/procurement_parcel_relations.mjs";

const fixtureUrl = new URL("../warehouse/fixtures/procurement-site-evidence/field_cases.json", import.meta.url);

async function fixture() {
  return JSON.parse(await readFile(fixtureUrl, "utf8"));
}

function resolverFor(source) {
  return {
    manifest: {
      schema: "cityscroll.address-index-manifest.v1",
      source: { name: "NYC Department of City Planning Property Address Directory", version: source.source_snapshot.pad_version },
      generated_at: source.source_snapshot.pad_generated_at,
      shard_count: 64,
    },
    shards: new Map(),
  };
}

function materializerResolver(source) {
  const resolver = resolverFor(source);
  for (const row of source.pad_rows) {
    const query = parseAddressQuery(row.address);
    const key = addressShardKey(query.street, 64);
    const shard = resolver.shards.get(key) || { schema: "cityscroll.address-index-shard.v1", key, streets: {} };
    shard.streets[query.street] ||= [];
    shard.streets[query.street].push([query.house_sort, query.house_sort, 0, row.bbl, row.zip]);
    resolver.shards.set(key, shard);
  }
  return resolver;
}

async function makeDoc(source) {
  return materializeProcurementSiteEvidence({
    retainedAwardRows: source.award_rows,
    awardRows: source.award_rows,
    hearingRows: source.hearing_rows,
    resolver: materializerResolver(source),
    sourceSnapshot: source.source_snapshot,
  });
}

test("accepted Coyle evidence reaches its parcel and canonical contract", async () => {
  const source = await fixture();
  const evidence = await makeDoc(source);
  const coyle = evidence.records.find((row) => row.request_id === "20241104015");
  const award = observationFromMoneyRow({ request_id: "20241104015", pin: "07122P0010020", agency_name: "Homeless Services", vendor_name: "Westhab Inc." });
  const contract = observationFromPassportContractRow({ contract_id: "CT107120258802303", epin: "07122P0010020", agency_name: "Homeless Services", vendor_name: "Westhab Inc." });
  const doc = buildProcurementParcelRelations({ siteEvidence: evidence, observations: [award, contract] });
  validateProcurementParcelRelations(doc);

  const parcelEdges = doc.relations.filter((edge) => edge.to === "parcel:3073670011");
  assert.ok(parcelEdges.some((edge) => edge.from === "notice:20241104015"));
  assert.ok(parcelEdges.some((edge) => edge.from === "contract:CT107120258802303"));
  assert.equal(coyle.evidence[0].contract_scope.epin, "07122P0010020");
  assert.ok(parcelEdges.every((edge) => edge.provenance.evidence_refs.length > 0));
});

test("relations reject non-site roles, preserve separate sites, and are deterministic", async () => {
  const source = await fixture();
  const evidence = await makeDoc(source);
  const award = observationFromMoneyRow({ request_id: "20260728014", pin: "07121P0122001R001", agency_name: "Homeless Services", vendor_name: "Neighborhood Association" });
  const one = buildProcurementParcelRelations({ siteEvidence: evidence, observations: [award] });
  const shuffled = buildProcurementParcelRelations({ siteEvidence: { ...evidence, records: [...evidence.records].reverse() }, observations: [award] });
  assert.deepEqual(one.relations, shuffled.relations);
  assert.deepEqual(one.relations.filter((edge) => edge.from === "notice:20260728014").map((edge) => edge.to), ["parcel:2031870007", "parcel:3016001001"]);

  const revoked = { ...evidence, records: evidence.records.map((record) => record.request_id === "20260728014" ? { ...record, classification: "ambiguous_target", evidence: record.evidence.map((item) => ({ ...item, resolved_bbl: null, resolution: { ...item.resolution, status: "ambiguous" } })) } : record) };
  assert.equal(buildProcurementParcelRelations({ siteEvidence: revoked, observations: [award] }).relations.some((edge) => edge.from === "notice:20260728014"), false);
});

test("no publisher fetch is needed on relation reads", () => {
  const doc = buildProcurementParcelRelations({ siteEvidence: { records: [] } });
  assert.deepEqual(doc.relations, []);
});
