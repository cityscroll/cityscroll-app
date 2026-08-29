/**
 * Guarded Checkbook NYC corroboration for PASSPort-only identities.
 * verify: node --test test/checkbook_passport_corroboration.test.mjs test/procurement_object_contract.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

import { isPublicSameContractCrosswalkRow } from "../entity_resolution/cross_domain/pin_family_mismatch.mjs";
import {
  classifyCheckbookPassportCorroboration,
  isPassportOnlyProcurement,
  publicProcurementAmount,
  servedProcurementForCorroboration,
} from "../site/checkbook_passport_corroboration.mjs";
import {
  buildProcurementObjects,
  resolveProcurementRoute,
} from "../site/procurement_object_contract.mjs";
import { materializeProcurementSearchDocument } from "../site/procurement_search_producer.mjs";
import { renderProcurementDocument } from "../site/procurement_document.mjs";
import { buildSharedProcurementReadModel } from "../site/shared_procurement_read_model.mjs";
import {
  checkbookContractsByPinRequestXml,
  checkbookSpendingByContractIdRequestXml,
  classifyPassportCheckbookXml,
} from "../worker/src/lib/checkbook_passport_lookup.mjs";

function sourceRecord(sourceSystem, sourceSystemId, snapshot) {
  return {
    source_system: sourceSystem,
    source_system_id: sourceSystemId,
    content_hash: `${sourceSystemId}-hash`,
    normalized_snapshot: JSON.stringify(snapshot),
    raw_snapshot: JSON.stringify(snapshot),
    ingested_at: "2026-08-18T19:46:32Z",
  };
}

const FIREMATIC_PASSPORT = {
  ctr_id: "4618449",
  epin: "85721B0111001A001",
  contract_id: "CT1-857-20228800365",
  title: "Bid 2100089 Nozzles (Brand Specific) Amendment #1",
  vendor: "FIREMATIC SUPPLY CO. INC",
  agency: "DCASDIVISION OF MUNICIPAL SUPPLY SERVICE",
  status: "Registered",
  current_amount: 49689.78,
};

const FIREMATIC_CHECKBOOK = {
  id: "CT185720228800365",
  contract_id: "CT185720228800365",
  pin: "85721B0111001A001",
  vendor: "FIREMATIC SUPPLY CO. INC",
  prime_vendor: "FIREMATIC SUPPLY CO. INC",
  status: "registered",
  current: 208687.62,
  vendorRecordType: "Prime Vendor",
};

const TAMEER_PASSPORT = {
  ctr_id: "TAMEER-2305",
  epin: "85021B0087001C011",
  contract_id: "CT1-850-20228802305",
  vendor: "TAMEER INC",
  agency: "Department of Design and Construction",
  status: "Registered",
  current_amount: 26112.93,
};

const TAMEER_CHECKBOOK = {
  id: "CT185020218800001",
  contract_id: "CT185020218800001",
  pin: "85021B0087001C010",
  vendor: "TAMEER INC",
  prime_vendor: "TAMEER INC",
  status: "registered",
  current: 1779343.45,
  vendorRecordType: "Prime Vendor",
};

function firematicXml() {
  return `<response><status><result>success</result></status><result_records><contract_transactions><transaction>`
    + `<prime_contract_id>CT185720228800365</prime_contract_id>`
    + `<vendor_record_type>Prime Vendor</vendor_record_type>`
    + `<prime_vendor>FIREMATIC SUPPLY CO. INC</prime_vendor>`
    + `<prime_contract_pin>85721B0111001A001</prime_contract_pin>`
    + `<prime_contract_current_amount>208687.62</prime_contract_current_amount>`
    + `<status>registered</status>`
    + `</transaction></contract_transactions></result_records></response>`;
}

function passportRecord(snapshot) {
  const epin = snapshot.epin || snapshot.epin_norm;
  return sourceRecord(
    "passport_public_contracts",
    `contract:${epin}:${snapshot.ctr_id}`,
    snapshot,
  );
}

test("Firematic exact contract-id/PIN corroboration keeps the PASSPort amount", () => {
  const classified = classifyCheckbookPassportCorroboration({
    passport: FIREMATIC_PASSPORT,
    checkbookRows: [FIREMATIC_CHECKBOOK],
  });
  assert.equal(classified.status, "corroborated");
  assert.equal(classified.identity_class, "same_contract");
  assert.equal(classified.join_method, "contract_id_exact");
  assert.equal(classified.passport_amount, 49689.78);
  assert.equal(classified.checkbook_amount, 208687.62);
  assert.equal(classified.amount_disagrees, true);
  assert.equal(classified.overwrites_passport_amount, false);
  assert.equal(classified.evidence_only, true);
  assert.equal(classified.fabricates_object, false);
  assert.equal(classified.fabricates_route, false);
  assert.equal(isPublicSameContractCrosswalkRow({
    status: "matched",
    join_method: classified.join_method,
  }), true);

  const fromXml = classifyPassportCheckbookXml(FIREMATIC_PASSPORT, firematicXml());
  assert.equal(fromXml.status, "corroborated");
  assert.equal(fromXml.passport_amount, 49689.78);
  assert.equal(fromXml.checkbook_amount, 208687.62);

  const built = buildProcurementObjects({
    sourceRecords: [passportRecord(FIREMATIC_PASSPORT)],
    checkbookLookupRows: [FIREMATIC_CHECKBOOK],
  });
  assert.equal(built.objects.length, 1);
  const [object] = built.objects;
  assert.equal(object.procurement_id, "procurement:contract:CT185720228800365");
  assert.equal(isPassportOnlyProcurement(object), true);
  assert.deepEqual(object.source_observation_refs, [
    "passport_public_contracts:contract:85721B0111001A001:4618449",
  ]);
  assert.equal(object.checkbook_corroboration.status, "corroborated");
  assert.equal(object.checkbook_corroboration.passport_amount, 49689.78);
  assert.equal(object.checkbook_corroboration.checkbook_amount, 208687.62);
  assert.equal(publicProcurementAmount(object, [{
    source_observation_ref: object.source_observation_refs[0],
    source_system: "passport_public_contracts",
    snapshot: FIREMATIC_PASSPORT,
  }]), 49689.78);
});

test("TAMEER PIN-family and amount disagreement is related-instrument or needs-review", () => {
  const classified = classifyCheckbookPassportCorroboration({
    passport: TAMEER_PASSPORT,
    checkbookRows: [TAMEER_CHECKBOOK],
  });
  assert.ok(["related_instrument", "needs_review"].includes(classified.status), classified.status);
  assert.ok(["related_instrument", "needs_review"].includes(classified.identity_class), classified.identity_class);
  assert.notEqual(classified.identity_class, "same_contract");
  assert.notEqual(classified.join_method, "contract_id_exact");
  assert.equal(classified.checkbook_pin, "85021B0087001C010");
  assert.equal(classified.passport_pin, "85021B0087001C011");
  assert.equal(classified.passport_amount, 26112.93);
  assert.equal(classified.checkbook_amount, 1779343.45);
  assert.equal(classified.overwrites_passport_amount, false);
  assert.equal(classified.fabricates_object, false);
  assert.equal(isPublicSameContractCrosswalkRow({
    status: "matched",
    join_method: classified.join_method,
  }), false);

  const built = buildProcurementObjects({
    sourceRecords: [passportRecord(TAMEER_PASSPORT)],
    checkbookLookupRows: [TAMEER_CHECKBOOK],
  });
  assert.equal(built.objects.length, 1);
  const [object] = built.objects;
  assert.equal(object.procurement_id, "procurement:contract:CT185020228802305");
  assert.equal(object.source_observation_refs.some((ref) => ref.startsWith("checkbook_")), false);
  assert.ok(["related_instrument", "needs_review"].includes(object.checkbook_corroboration.identity_class));
  assert.equal(object.checkbook_corroboration.passport_amount, 26112.93);
  assert.equal(new Set(built.objects.map((row) => row.procurement_id)).size, 1);
});

test("Checkbook miss stays unknown and a hit does not mint a detail route", () => {
  const miss = classifyCheckbookPassportCorroboration({
    passport: FIREMATIC_PASSPORT,
    checkbookRows: [],
  });
  assert.equal(miss.status, "unknown");
  assert.equal(miss.identity_class, null);
  assert.equal(miss.fabricates_route, false);
  assert.equal(miss.passport_amount, 49689.78);

  const hit = classifyCheckbookPassportCorroboration({
    passport: { contract_id: "CT1-999-20990000001", epin: "99999P0001001", current_amount: 10 },
    checkbookRows: [{
      id: "CT199920990000001",
      pin: "99999P0001001",
      current: 99,
      vendor: "UNSERVED VENDOR",
    }],
  });
  assert.equal(hit.status, "corroborated");
  assert.equal(hit.fabricates_route, false);

  const served = buildProcurementObjects({
    sourceRecords: [passportRecord(FIREMATIC_PASSPORT)],
    checkbookLookupRows: [FIREMATIC_CHECKBOOK],
  });
  const href = "/procurements/procurement%3Acontract%3ACT199920990000001";
  assert.equal(resolveProcurementRoute(href, served.objects, { checkbookCorroboration: hit }), null);
  assert.equal(servedProcurementForCorroboration("procurement:contract:CT199920990000001", served.objects, hit), null);
  assert.equal(served.objects.some((row) => row.procurement_id === "procurement:contract:CT199920990000001"), false);

  const unknownBuilt = buildProcurementObjects({
    sourceRecords: [passportRecord(FIREMATIC_PASSPORT)],
    checkbookLookupRows: [],
    includeUnknownCheckbookCorroboration: true,
  });
  assert.equal(unknownBuilt.objects[0].checkbook_corroboration.status, "unknown");
  assert.equal(resolveProcurementRoute(
    "/procurements/procurement%3Acontract%3ACT185720228800365",
    unknownBuilt.objects,
  )?.procurement_id, "procurement:contract:CT185720228800365");
});

test("lookup XML is Contracts-by-PIN and Spending-by-contract_id", () => {
  const contracts = checkbookContractsByPinRequestXml("85721B0111001A001");
  assert.match(contracts, /<type_of_data>Contracts<\/type_of_data>/);
  assert.match(contracts, /<name>pin<\/name>/);
  assert.match(contracts, /85721B0111001A001/);
  const spending = checkbookSpendingByContractIdRequestXml("CT185720228800365");
  assert.match(spending, /<type_of_data>Spending<\/type_of_data>/);
  assert.match(spending, /<name>contract_id<\/name>/);
  assert.match(spending, /CT185720228800365/);
});

test("shared read model and search/document projection keep the PASSPort amount", () => {
  const passport = passportRecord(FIREMATIC_PASSPORT);
  const model = buildSharedProcurementReadModel({
    sourceRecords: [passport],
    checkbookLookupRows: [FIREMATIC_CHECKBOOK],
    generatedAt: "2026-08-18T20:00:00Z",
  });
  const [object] = model.rows;
  assert.equal(object.checkbook_corroboration.passport_amount, 49689.78);
  const document = materializeProcurementSearchDocument(object, model);
  assert.equal(document.provenance.browse_record.contract_amount, 49689.78);
  assert.doesNotMatch(document.summary, /208,687/);
  const html = renderProcurementDocument(object, model.observations);
  assert.match(html, /49,689\.78/);
  assert.doesNotMatch(html, /208687/);
});
