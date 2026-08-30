import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  MTA_ANNUAL_SOURCE_SYSTEM,
  MTA_CD_AWARDS_SOURCE_SYSTEM,
  buildMtaSourceRecord,
  mtaAnnualContractSourceSystemId,
  mtaCdAwardSourceSystemId,
  normalizeMtaAnnualContractRow,
  parseMtaCdRecentAwardsHtml,
} from "../worker/src/lib/mta_procurement_source_records.mjs";
import { buildProcurementArtifacts } from "../tools/build_shared_procurement_read_model.mjs";
import { renderProcurementDocument } from "../site/procurement_document.mjs";
import { buildAgencyConstellationView } from "../site/agency_constellation_model.mjs";
import { agencyRouteAliasTarget, resolveAgencyIdentity } from "../site/agency_identity.mjs";

const fixture = JSON.parse(readFileSync(new URL("../site/data/mta_procurement_sources.json", import.meta.url)));

function emptySpine() {
  return { generated_at: fixture.generated_at, rows: { passport_contracts: [], checkbook_contracts: [] } };
}

function buildFixture() {
  return buildProcurementArtifacts(emptySpine(), { rows: [] }, { mtaSources: fixture });
}

test("MTA source adapters preserve source ids and distinguish annual contracts from awards", () => {
  const annual = fixture.annual_contracts[0];
  const normalized = normalizeMtaAnnualContractRow(annual.raw_snapshot, {
    procuringInstitutionId: "long-island-rail-road",
    sourceAgencyLabel: "Long Island Rail Road",
    retrievedAt: annual.retrieved_at,
    metadata: fixture.annual_snapshot_metadata,
  });
  assert.equal(mtaAnnualContractSourceSystemId(annual.raw_snapshot), "contract:8000000863");
  assert.equal(normalized.observation_type, "contract");
  assert.equal(normalized.source_agency_label, "Long Island Rail Road");
  assert.equal(normalized.contract_amount, 65333757);

  const award = fixture.cd_awards[0].normalized_snapshot;
  assert.equal(mtaCdAwardSourceSystemId(award), "award:A37703");
  assert.equal(award.observation_type, "award");
  assert.equal(award.procuring_institution_id, "mta-construction-and-development");

  const record = buildMtaSourceRecord({
    sourceSystem: MTA_ANNUAL_SOURCE_SYSTEM,
    sourceSystemId: annual.source_record_id,
    rawRow: annual.raw_snapshot,
    normalizedRow: normalized,
    contentHash: annual.content_hash,
  });
  assert.notDeepEqual(record.raw_snapshot, record.normalized_snapshot);
  assert.equal(record.content_hash, annual.content_hash);
  assert.equal(record.source_system_id, annual.source_record_id);
});

test("C&D parser admits A37703 with the official award fields", () => {
  const html = `<h2>2026 awards</h2><details><summary><div>A37703 Flood Protection of Selected NYCT Vulnerabilities</div></summary><div class="field--name-field-accordion-text"><ul><li>Firm: Gramercy Group, Inc.</li><li>Award Date: July 20, 2026</li><li>Award Amount: $10,713,000</li></ul></div></details>`;
  const [award] = parseMtaCdRecentAwardsHtml(html, {
    retrievedAt: fixture.cd_awards[0].retrieved_at,
    metadata: fixture.cd_awards_snapshot_metadata,
  });
  assert.equal(award.source_record_id, "A37703");
  assert.equal(award.vendor_name, "Gramercy Group, Inc.");
  assert.equal(award.award_date, "July 20, 2026");
  assert.equal(award.award_amount, 10713000);
  assert.deepEqual(award.snapshot_metadata, fixture.cd_awards_snapshot_metadata);
});

test("MTA fixtures reach canonical detail and retain independent receipts", () => {
  const { model, browse } = buildFixture();
  assert.equal(model.rows.length, 2);
  assert.equal(browse.rows.length, 2);
  const award = model.rows.find((row) => row.identity_keys.contract_ids.includes("A37703"));
  assert.ok(award);
  assert.deepEqual(award.stages.map((stage) => stage.stage), ["award"]);
  assert.deepEqual(award.institution_keys.procuring_institution_ids, ["mta-construction-and-development"]);
  const html = renderProcurementDocument(award, model.observations);
  assert.match(html, /A37703/);
  assert.match(html, /Gramercy Group, Inc\./);
  assert.match(html, /July 20, 2026/);
  assert.match(html, /10,713,000/);
  assert.match(html, /mta\.info\/agency\/construction-and-development\/contracting\/recent-awards/);
  const awardBrowse = browse.rows.find((row) => row.contract_id === "A37703");
  assert.deepEqual([...awardBrowse.entity_refs_all].sort(), [
    "agency:id:metropolitan-transportation-authority",
    "agency:id:mta-construction-and-development",
  ]);
});

test("MTA parent aggregation preserves child routing and exact-only joins", () => {
  const { browse } = buildFixture();
  const authorityProcurement = { ...browse, open_as_of: browse.generated_at, notices: browse.rows };
  const sources = { authority_procurement: authorityProcurement, publisher_agency_rows: [] };
  const parent = buildAgencyConstellationView("metropolitan-transportation-authority", sources);
  const cd = buildAgencyConstellationView("mta-construction-and-development", sources);
  const lirr = buildAgencyConstellationView("long-island-rail-road", sources);
  assert.equal(parent.categories.find((category) => category.id === "contracts").count, 2);
  assert.equal(cd.categories.find((category) => category.id === "contracts").count, 1);
  assert.equal(lirr.categories.find((category) => category.id === "contracts").count, 1);
  assert.equal(cd.categories.find((category) => category.id === "contracts").items[0].operating_entity_name, "MTA Construction & Development");
  assert.equal(lirr.categories.find((category) => category.id === "contracts").items[0].operating_entity_name, "Long Island Rail Road");

  const annual = fixture.annual_contracts[0].normalized_snapshot;
  const unrelated = { ...annual, transaction_number: "different-id", contract_id: "different-id" };
  const noMerge = buildProcurementArtifacts(emptySpine(), { rows: [] }, {
    mtaSources: {
      ...fixture,
      annual_contracts: [{ ...fixture.annual_contracts[0], normalized_snapshot: unrelated, source_record_id: "different-id" }],
      cd_awards: [],
    },
  });
  assert.equal(noMerge.model.rows.length, 1);
  assert.equal(noMerge.model.cross_source_identity_joins.length, 0);
});

test("MTA operating-entity identities stay distinct from the parent and each other", () => {
  const expected = new Map([
    ["MTA", "metropolitan-transportation-authority"],
    ["NYCT", "n-y-c-transit-authority"],
    ["TBTA", "triborough-bridge-and-tunnel-authority"],
    ["LIRR", "long-island-rail-road"],
    ["Metro-North", "metro-north-railroad"],
    ["MTA Bus", "mta-bus"],
    ["MTA C&D", "mta-construction-and-development"],
  ]);
  for (const [label, id] of expected) assert.equal(resolveAgencyIdentity(label).canonical_id, id, label);
  assert.equal(agencyRouteAliasTarget("mta-nyct"), "n-y-c-transit-authority");
  assert.equal(agencyRouteAliasTarget("mta-construction-development"), "mta-construction-and-development");
  assert.equal(new Set(expected.values()).size, expected.size);
});

test("annual/reporting and first-party rows join only on an exact contract identifier", () => {
  const annual = fixture.annual_contracts[0];
  const overlap = {
    ...annual,
    source_record_id: "A37703",
    raw_snapshot: { ...annual.raw_snapshot, transaction_number: "A37703" },
    normalized_snapshot: {
      ...annual.normalized_snapshot,
      transaction_number: "A37703",
      contract_id: "A37703",
    },
  };
  const { model } = buildProcurementArtifacts(emptySpine(), { rows: [] }, {
    mtaSources: { ...fixture, annual_contracts: [overlap] },
  });
  assert.equal(model.rows.length, 1);
  assert.deepEqual(model.cross_source_identity_joins.map((join) => ({
    basis: join.basis,
    matched_value: join.matched_value,
  })), [{ basis: "exact_contract_id", matched_value: "A37703" }]);
});
