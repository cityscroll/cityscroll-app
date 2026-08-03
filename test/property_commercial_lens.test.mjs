/**
 * Property commercial lens organization: filters, sorts, sale gate, alerts scope.
 *
 *   node --test test/property_commercial_lens.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  commercialMatchesFilters,
  commercialPriceAmount,
  extractPropertyCommercial,
  hasCommercialSaleSignals,
  isCommercialSaleEligible,
  normalizePriceBandFilter,
  normalizePropertySort,
  normalizeSaleMethodFilter,
  priceBandForAmount,
} from "../site/property_commercial.mjs";
import {
  filterPropertyExplorerEntries,
  sortPropertyExplorerEntries,
} from "../site/property_explorer.mjs";
import {
  alertScopeFromLensState,
  alertScopeFromNotice,
  alertsHref,
} from "../site/alerts_context_carry.mjs";
import { SITE_SOURCE } from "./helpers/site_source.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(
  readFileSync(join(ROOT, "test/fixtures/property_commercial/real_notices.json"), "utf8"),
);

function commercialRow(entry) {
  const commercial = extractPropertyCommercial(entry.row, { attachments: entry.attachments });
  return { ...entry.row, commercial, _asset: commercial.item.category };
}

const rows = fixture.cases.map(commercialRow);

test("normalize helpers accept persona keys and reject noise", () => {
  assert.equal(normalizeSaleMethodFilter("online-auction"), "online_auction");
  assert.equal(normalizeSaleMethodFilter("nope"), "all");
  assert.equal(normalizePriceBandFilter("100k_plus"), "100k_plus");
  assert.equal(normalizePropertySort("price_desc"), "price_desc");
  assert.equal(normalizePropertySort("bogus"), "closing_soon");
});

test("sale eligibility: vehicle auction is eligible; destruction is not", () => {
  const auto = rows.find((r) => r.request_id === "20251106024");
  assert.ok(auto, "auto auction fixture");
  assert.equal(isCommercialSaleEligible(auto.commercial), true);
  assert.equal(hasCommercialSaleSignals(auto.commercial), true);

  const destruction = extractPropertyCommercial({
    request_id: "destruction-1",
    short_title: "Owners are wanted — unauthorized tobacco pending destruction",
    additional_description_1:
      "Property Clerk Division. Unauthorized tobacco product seized during enforcement. Pending destruction. Owners are wanted.",
    section_name: "Property Disposition",
  });
  assert.equal(destruction.disposition_class, "destruction");
  assert.equal(isCommercialSaleEligible(destruction), false);
});

test("commercialMatchesFilters gates non-sales when category filter is on", () => {
  const destruction = extractPropertyCommercial({
    request_id: "destruction-2",
    short_title: "Property clerk unclaimed property pending destruction",
    additional_description_1: "owners are wanted; pending destruction of unauthorized tobacco",
  });
  // Category-only commercial filter must drop non-sales even if category were other.
  assert.equal(
    commercialMatchesFilters(destruction, { asset: "other", commercialOnly: true }),
    false,
  );

  const auto = rows.find((r) => r.request_id === "20251106024");
  assert.equal(
    commercialMatchesFilters(auto.commercial, { asset: "vehicle" }),
    true,
  );
  assert.equal(
    commercialMatchesFilters(auto.commercial, { saleMethod: "online_auction" }),
    true,
  );
});

test("price band and amount helpers", () => {
  // $4,800 / $850,000 characterized from synthetic-deal-vehicle-001 and City Record 20140224112 fixtures.
  assert.equal(priceBandForAmount(4800), "under_10k"); // source: synthetic-deal-vehicle-001 min bid
  assert.equal(priceBandForAmount(850000), "100k_plus"); // source: City Record 20140224112 upset
  assert.equal(priceBandForAmount(null), null);

  const priced = extractPropertyCommercial({
    request_id: "p1",
    short_title: "Public auction",
    // $4,800 mirrors synthetic-deal-vehicle-001 fixture min bid shape.
    additional_description_1: "minimum bid of $4,800 at public auction of city-owned property",
  });
  assert.equal(commercialPriceAmount(priced), 4800); // source: synthetic fixture amount above
  assert.equal(commercialMatchesFilters(priced, { priceBand: "under_10k" }), true);
  assert.equal(commercialMatchesFilters(priced, { priceBand: "100k_plus" }), false);
});

test("explorer filter + sort: closing soon and price order", () => {
  const entries = rows.map((r) => ({
    kind: "notice",
    primary: r,
    members: [r],
    notice_count: 1,
    process_stage: null,
    process_filter: "unstaged",
  }));

  const vehicles = filterPropertyExplorerEntries(entries, {
    asset: "vehicle",
    assetOf: (r) => r._asset,
    commercialOf: (r) => r.commercial,
  });
  assert.ok(vehicles.length >= 1);
  for (const e of vehicles) {
    assert.equal(e.primary._asset, "vehicle");
    assert.notEqual(e.primary.commercial.sale_eligible, false);
  }

  // Destruction must not survive a commercial asset filter on the explorer list.
  const withDestruction = [
    ...entries,
    {
      kind: "notice",
      primary: {
        request_id: "destruction-list",
        short_title: "pending destruction unauthorized tobacco",
        additional_description_1: "property clerk division owners are wanted",
        commercial: extractPropertyCommercial({
          request_id: "destruction-list",
          short_title: "pending destruction unauthorized tobacco",
          additional_description_1: "property clerk division owners are wanted",
        }),
        _asset: "other",
      },
      members: [],
      notice_count: 1,
      process_filter: "unstaged",
    },
  ];
  withDestruction[withDestruction.length - 1].members = [
    withDestruction[withDestruction.length - 1].primary,
  ];
  const otherOnly = filterPropertyExplorerEntries(withDestruction, {
    asset: "other",
    assetOf: (r) => r._asset,
    commercialOf: (r) => r.commercial,
  });
  assert.equal(
    otherOnly.some((e) => e.primary.request_id === "destruction-list"),
    false,
    "non-sale destruction stays out of commercial-filtered views",
  );

  const byPrice = sortPropertyExplorerEntries(entries, "price_desc", (r) => r.commercial);
  const amounts = byPrice
    .map((e) => commercialPriceAmount(e.primary.commercial))
    .filter((n) => n != null);
  for (let i = 1; i < amounts.length; i++) {
    assert.ok(amounts[i - 1] >= amounts[i], "price_desc is non-increasing among priced rows");
  }

  const byClose = sortPropertyExplorerEntries(entries, "closing_soon", (r) => r.commercial);
  assert.equal(byClose.length, entries.length);
});

test("alert scope from commercial lens state carries asset + method + borough", () => {
  const scope = alertScopeFromLensState("property", {
    asset: "vehicle",
    saleMethod: "online_auction",
    borough: "Brooklyn",
    q: "",
  });
  assert.equal(scope.lens, "property");
  assert.equal(scope.filter.asset, "vehicle");
  assert.equal(scope.filter.saleMethod, "online_auction");
  assert.equal(scope.filter.borough, "Brooklyn");
  const href = alertsHref(scope);
  assert.match(href, /#alerts\?/);
  assert.match(href, /vehicle/);
  assert.match(href, /online_auction/);
});

test("alert scope from sale notice prefers commercial asset", () => {
  const auto = rows.find((r) => r.request_id === "20251106024");
  const scope = alertScopeFromNotice({
    ...auto,
    section_name: "Property Disposition",
  });
  assert.equal(scope.lens, "property");
  assert.equal(scope.filter.asset, "vehicle");
});

test("list/export/watch wiring present in site surface", () => {
  const src = SITE_SOURCE;
  assert.match(src, /id="salerail"/);
  assert.match(src, /id="pricerail"/);
  assert.match(src, /id="propsort"/);
  assert.match(src, /propSaleMethod|saleMethod/);
  assert.match(src, /csv_sale_method|csv_primary_price|csv_commercial_item/);
  assert.match(src, /property-export-overflow|data-export-csv="property"/);
});
