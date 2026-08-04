import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  editDistance,
  normalizeSearchText,
  resolveNeighborhood,
  sameWords,
} from "../site/neighborhood_search.mjs";
import { filterPropertyExplorerEntries } from "../site/property_explorer.mjs";
import { propertyPlacementsFromRow } from "../tools/lib/district_activity.mjs";
import { CURATED_ALIASES } from "../tools/build_neighborhood_gazetteer.mjs";

const gazetteer = JSON.parse(readFileSync(new URL("../site/data/neighborhood_gazetteer.json", import.meta.url)));
const receipt = JSON.parse(readFileSync(new URL("../site/data/neighborhood_gazetteer_receipt.json", import.meta.url)));
const performanceReceipt = JSON.parse(readFileSync(new URL("../warehouse/receipts/proof/neighborhood_search_latest.json", import.meta.url)));
const i18n = readFileSync(new URL("../site/i18n.js", import.meta.url), "utf8");
const boundaries = JSON.parse(readFileSync(new URL("../site/data/district_boundaries.json", import.meta.url)));
const propertyRows = JSON.parse(readFileSync(new URL("../site/data/property_domain_observations.json", import.meta.url))).property_rows;
const districtActivity = JSON.parse(readFileSync(new URL("../site/data/district_activity.json", import.meta.url)));

test("official NTA gazetteer resolves the reported neighborhood cases", () => {
  const canarsie = resolveNeighborhood("Canarsie", gazetteer);
  assert.equal(canarsie?.borough, "Brooklyn");
  assert.deepEqual(canarsie?.community_districts, ["K18"]);
  assert.deepEqual(canarsie?.nta_codes, ["BK1803"]);

  for (const query of ["Bedford Stuyvesant", "Bed-Stuy", "bed stuy"]) {
    const result = resolveNeighborhood(query, gazetteer);
    assert.equal(result?.name, "Bedford-Stuyvesant");
    assert.deepEqual(result?.community_districts, ["K03"]);
    assert.deepEqual(result?.nta_codes, ["BK0301", "BK0302"]);
  }
});

test("normalization handles punctuation, ordinals, saints, diacritics, and word order", () => {
  assert.equal(normalizeSearchText("St. George & New-Brighton, 1st"), "saint george and new brighton 1");
  assert.equal(normalizeSearchText("Café"), "cafe");
  assert.equal(sameWords("Hudson Yards-Chelsea", "Chelsea, Hudson Yards"), true);
  assert.equal(editDistance("Canarsie", "Canarsy", 2), 2);
  assert.equal(resolveNeighborhood("Canarsy", gazetteer)?.name, "Canarsie");
  assert.equal(resolveNeighborhood("show property in bed stuy", gazetteer)?.name, "Bedford-Stuyvesant");
});

test("every curated alias is attached to an official neighborhood", () => {
  for (const [target, aliases] of Object.entries(CURATED_ALIASES)) {
    assert.ok(gazetteer.neighborhoods.some((entry) => entry.name === target), `missing target: ${target}`);
    for (const alias of aliases) assert.equal(resolveNeighborhood(alias, gazetteer)?.name, target, alias);
  }
});

test("promise parity: every common fixture name resolves whenever the placeholder promises neighborhoods", () => {
  const promisesNeighborhoods = /kw_placeholder_property:\s*"[^"]*neighborhood/i.test(i18n);
  assert.equal(promisesNeighborhoods, true, "property search should state its supported place capability");
  const missing = gazetteer.common_neighborhoods.filter((name) => !resolveNeighborhood(name, gazetteer));
  assert.deepEqual(missing, []);
  assert.ok(gazetteer.common_neighborhoods.length >= 50);
});

test("gazetteer receipt identifies the current official NYC Open Data dataset", () => {
  assert.equal(gazetteer.source.dataset_id, "9nt8-h7nd");
  assert.equal(receipt.dataset_id, "9nt8-h7nd");
  assert.equal(receipt.source_row_count, gazetteer.source_row_count);
  assert.equal(receipt.residential_nta_count, gazetteer.residential_nta_count);
  assert.equal(receipt.neighborhood_count, gazetteer.neighborhood_count);
  assert.ok(receipt.promise_fixture_count >= 50);
  assert.match(receipt.artifact_sha256, /^[a-f0-9]{64}$/);
});

test("committed performance receipt stays within the request-path budget", () => {
  assert.equal(performanceReceipt.gazetteer_entries, gazetteer.neighborhood_count);
  assert.equal(performanceReceipt.within_budget, true);
  assert.ok(performanceReceipt.p95_ms < performanceReceipt.budget_p95_ms);
  assert.equal(performanceReceipt.resolved, performanceReceipt.resolutions);
});

test("property geography filtering uses the same community-district key as the map drill", () => {
  const entries = [
    { primary: { request_id: "in", _communityDistrict: "K18" }, members: [{ _communityDistrict: "K18" }] },
    { primary: { request_id: "out", _communityDistrict: "K03" }, members: [{ _communityDistrict: "K03" }] },
  ];
  const filtered = filterPropertyExplorerEntries(entries, { communityDistricts: ["K18"] });
  assert.deepEqual(filtered.map((entry) => entry.primary.request_id), ["in"]);
});

test("Canarsie and Bedford-Stuyvesant list counts equal their committed map counts", () => {
  for (const [query, expected] of [["Canarsie", 1], ["Bed-Stuy", 3]]) {
    const place = resolveNeighborhood(query, gazetteer);
    const communityDistrict = place.community_districts[0];
    const listCount = propertyRows.filter((row) =>
      propertyPlacementsFromRow(row, boundaries)[0]?.community === communityDistrict).length;
    assert.equal(listCount, expected, `${query} fixture count`);
    assert.equal(listCount, districtActivity.by_level.community_district[communityDistrict].property);
  }
});
