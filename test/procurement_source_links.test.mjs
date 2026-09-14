import assert from "node:assert/strict";
import test from "node:test";

import { buildProcurementObjects } from "../site/procurement_object_contract.mjs";
import { buildCrossSourceCoverageLedger, renderCrossSourceCoverageLedger } from "../site/cross_source_coverage_ledger.mjs";
import { procurementSourceLinkItems } from "../site/procurement_source_links.mjs";

function record(source_system, source_system_id, snapshot) {
  return {
    source_system,
    source_system_id,
    normalized_snapshot: JSON.stringify(snapshot),
    raw_snapshot: JSON.stringify(snapshot),
  content_hash: source_system_id + "-hash",
  };
}

test("procurement source destinations are centralized and accurately labeled", () => {
  const city = record("city_record", "20240829105", { request_id: "20240829105" });
  const passport = record("passport_public_contracts", "contract:CT107120258801626", { contract_id: "CT107120258801626" });
  const checkbook = record("checkbook_contracts", "registered:CT107120258801626", { id: "CT107120258801626" });
  const [builtObject] = buildProcurementObjects({ sourceRecords: [city, passport, checkbook] }).objects;
  const object = { ...builtObject, compatibility: { ...builtObject.compatibility, city_record_notice_hrefs: ["/notices/20240829105"] } };
  const observations = [city, passport, checkbook].map((entry) => ({
    ...entry,
    source_observation_ref: entry.source_system + ":" + entry.source_system_id,
    snapshot: JSON.parse(entry.normalized_snapshot),
  }));
  const links = procurementSourceLinkItems(object, observations);
  assert.deepEqual(links.map(({ source_system, record_href, official_href, search_href }) => ({
    source_system, record_href, official_href, search_href,
  })), [
    {
      source_system: "city_record",
      record_href: "/notices/20240829105",
      official_href: "https://a856-cityrecord.nyc.gov/RequestDetail/20240829105",
      search_href: undefined,
    },
    {
      source_system: "passport_public_contracts",
      record_href: undefined,
      official_href: "https://a0333-passportpublic.nyc.gov/contracts.html",
      search_href: undefined,
    },
    {
      source_system: "checkbook_contracts",
      record_href: undefined,
      official_href: undefined,
      search_href: "https://www.checkbooknyc.com/smart_search/citywide?search_term=CT107120258801626",
    },
  ]);
});

test("coverage keeps official handoffs separate from matched source names", () => {
  const ledger = buildCrossSourceCoverageLedger({
    object: {
      procurement_id: "procurement:contract:CT1",
      source_observation_refs: ["passport_public_contracts:contract:CT1"],
    },
    observations: [{
      source_system: "passport_public_contracts",
      source_observation_ref: "passport_public_contracts:contract:CT1",
      snapshot: { contract_id: "CT1" },
    }],
    sourceCoverage: null,
  });
  const passport = ledger.sources.find((row) => row.source_system === "passport_public_contracts");
  assert.equal(passport.record_href, null);
  assert.equal(passport.official_href, "https://a0333-passportpublic.nyc.gov/contracts.html");
  const html = renderCrossSourceCoverageLedger(ledger);
  assert.match(html, /Open PASSPort contracts portal/);
  assert.match(html, /target="_blank" rel="noopener noreferrer"/);
  assert.doesNotMatch(html, /Lookup not run · as of/);
});
