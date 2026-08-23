import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTRACT_COLUMNS,
  CONTRACTS_PORTAL,
  PASSPORT_PUBLIC_HAS_PER_CONTRACT_PAGE,
  PASSPORT_PUBLIC_HAS_PER_VENDOR_PAGE,
  RFX_PORTAL,
  VENDOR_PORTAL,
  passportPublicOfficialSource,
  passportRfxHandoffUrl,
} from "../worker/src/lib/passport_parse.mjs";
import { buildProcurementObjects } from "../site/procurement_object_contract.mjs";
import {
  procurementOfficialSourceItems,
  renderProcurementDocument,
} from "../site/procurement_document.mjs";
import { residentOfficialSource } from "../site/provenance_disclosure.mjs";

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

test("PASSPort Public dump and portal have no per-contract or per-vendor page", () => {
  assert.equal(PASSPORT_PUBLIC_HAS_PER_CONTRACT_PAGE, false);
  assert.equal(PASSPORT_PUBLIC_HAS_PER_VENDOR_PAGE, false);
  assert.equal(CONTRACT_COLUMNS.some((name) => /url|href|link/i.test(name)), false);
  const contract = passportPublicOfficialSource("contract", {
    contract_id: "CT185720228800365",
    epin: "85721B0111001A001",
    ctr_id: "4618449",
    vendor: "FIREMATIC SUPPLY CO. INC",
  });
  assert.equal(contract.per_item, false);
  assert.equal(contract.href, CONTRACTS_PORTAL);
  assert.equal(contract.label, "PASSPort Public contracts");
  assert.doesNotMatch(contract.href, /CT185720228800365|85721B0111001A001|4618449/);
  assert.equal(passportPublicOfficialSource("vendor").href, VENDOR_PORTAL);
  assert.equal(passportPublicOfficialSource("vendor").per_item, false);
});

test("RFx official source deep-links numeric rfp_id; else the public browse portal", () => {
  const deep = passportPublicOfficialSource("rfx", { rfp_id: "36426" });
  assert.equal(deep.per_item, true);
  assert.equal(deep.href, passportRfxHandoffUrl("36426"));
  const browse = passportPublicOfficialSource("passport_public_rfx", { rfp_id: "RFX-88" });
  assert.equal(browse.per_item, false);
  assert.equal(browse.href, RFX_PORTAL);
});

test("PASSPort-only procurement object links the public contracts browse, not a minted contract URL", () => {
  const passport = sourceRecord(
    "passport_public_contracts",
    "contract:85721B0111001A001:4618449",
    {
      ctr_id: "4618449",
      epin: "85721B0111001A001",
      contract_id: "CT185720228800365",
      title: "Bid 2100089 Nozzles (Brand Specific) Amendment #1",
      vendor: "FIREMATIC SUPPLY CO. INC",
      agency: "DCASDIVISION OF MUNICIPAL SUPPLY SERVICE",
      status: "Registered",
      current_amount: 49689.78,
    },
  );
  const built = buildProcurementObjects({ sourceRecords: [passport] });
  const [object] = built.objects;
  assert.equal(object.procurement_id, "procurement:contract:CT185720228800365");
  assert.deepEqual(object.compatibility.city_record_notice_hrefs, []);

  const observations = [{
    source_observation_ref: `passport_public_contracts:${passport.source_system_id}`,
    source_system: "passport_public_contracts",
    snapshot: JSON.parse(passport.normalized_snapshot),
  }];
  const items = procurementOfficialSourceItems(object, observations);
  assert.deepEqual(items, [{
    href: CONTRACTS_PORTAL,
    label: "PASSPort Public contracts",
  }]);

  const html = renderProcurementDocument(object, observations);
  assert.match(html, /Official records/);
  assert.match(html, /href="https:\/\/a0333-passportpublic\.nyc\.gov\/contracts\.html"/);
  assert.match(html, />PASSPort Public contracts<span aria-hidden="true">↗<\/span>/);
  assert.doesNotMatch(html, /City Record notice/);
  assert.doesNotMatch(html, /passport\.cityofnewyork\.us\/.*CT185720228800365/);
  assert.doesNotMatch(html, /a0333-passportpublic\.nyc\.gov\/contracts\.html\?/);
});

test("Checkbook-only object links a labeled Checkbook search; City Record notices stay first", () => {
  const checkbook = sourceRecord(
    "checkbook_contracts",
    "contract:registered:CT101520271400806:BILLIG LAW PC:prime-vendor:2026-08-15",
    {
      id: "CT101520271400806",
      pin: "01523BLA66814-03-R1",
      title: "Small purchase legal services",
      vendor: "BILLIG LAW PC",
      status: "registered",
    },
  );
  const cityRecord = sourceRecord("city_record", "20260623008", {
    request_id: "20260623008",
    pin: "01523BLA66814-03-R1",
    type_of_notice_description: "Award",
  });
  const built = buildProcurementObjects({ sourceRecords: [checkbook, cityRecord] });
  const [object] = built.objects;
  const observations = [
    {
      source_observation_ref: `checkbook_contracts:${checkbook.source_system_id}`,
      source_system: "checkbook_contracts",
      snapshot: JSON.parse(checkbook.normalized_snapshot),
    },
    {
      source_observation_ref: "city_record:20260623008",
      source_system: "city_record",
      snapshot: JSON.parse(cityRecord.normalized_snapshot),
    },
  ];
  const items = procurementOfficialSourceItems(object, observations);
  assert.equal(items[0].label, "City Record notice");
  assert.equal(items[0].href, "/notices/20260623008");
  assert.equal(items[1].label, "Search Checkbook NYC");
  assert.match(items[1].href, /checkbooknyc\.com\/smart_search\/citywide\?search_term=CT101520271400806/);
});

test("residentOfficialSource admits the PASSPort Public contracts portal", () => {
  const source = residentOfficialSource({
    sourceSystem: "passport_public_contracts",
    sourceRecordId: "contract:85721B0111001A001:4618449",
  });
  assert.equal(source.href, CONTRACTS_PORTAL);
  assert.equal(source.label, "PASSPort Public contracts");
});
