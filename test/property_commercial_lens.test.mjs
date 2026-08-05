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
  commercialCloseDate,
  commercialMatchesFilters,
  commercialPriceAmount,
  extractPropertyCommercial,
  hasCommercialSaleSignals,
  isCloseDatePast,
  isCommercialSaleEligible,
  normalizePriceBandFilter,
  normalizePropertySort,
  normalizeSaleMethodFilter,
  priceBandForAmount,
} from "../site/property_commercial.mjs";
import {
  filterPropertyExplorerEntries,
  sortPropertyExplorerEntries,
  stampPropertyExplorerTemporal,
} from "../site/property_explorer.mjs";
import {
  defaultViewCardsFromEntries,
  findCurrencyLeakedDateChips,
  findCurrencyLeakedDateI18n,
  findPastDeadlinesInDefaultView,
} from "../site/property_list_sanity.mjs";
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

  // Item type is a domain facet, not a sales-only gate: non-sale classes remain
  // available for the current/archive qualification pass that follows filtering.
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
    true,
    "non-sale destruction remains in its item-type scope",
  );

  const byPrice = sortPropertyExplorerEntries(entries, "price_desc", (r) => r.commercial);
  // Temporal honesty outranks price: current/undated notices stay ahead of the archive.
  // Within each temporal bucket, explicit price order remains descending.
  const buckets = new Map();
  for (const entry of byPrice) {
    const close = commercialCloseDate(entry.primary, entry.primary.commercial);
    const bucket = close && isCloseDatePast(close, "2026-08-03") ? "closed" : close ? "open" : "undated";
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    const amount = commercialPriceAmount(entry.primary.commercial);
    if (amount != null) buckets.get(bucket).push(amount);
  }
  for (const amounts of buckets.values()) {
    for (let i = 1; i < amounts.length; i++) {
      assert.ok(amounts[i - 1] >= amounts[i], "price_desc is non-increasing inside each temporal bucket");
    }
  }

  const byClose = sortPropertyExplorerEntries(entries, "closing_soon", (r) => r.commercial, {
    today: "2026-08-03",
  });
  assert.equal(byClose.length, entries.length);
});

test("closing_soon puts open closes first; past-dated sales sink to archive tail", () => {
  const today = "2026-08-03";
  const mk = (id, close, stage = "auction_or_rfp") => ({
    kind: "notice",
    primary: {
      request_id: id,
      event_date: close,
      start_date: close,
      commercial: {
        close_date: close,
        glance: { close_date: close },
        sale_eligible: true,
      },
    },
    members: [],
    notice_count: 1,
    process_stage: stage,
    process_filter: stage,
    action_key: "disposition_phase_action_bid",
  });
  const raw = [
    mk("past-2013", "2013-09-16"),
    mk("past-2014", "2014-01-01"),
    mk("soon", "2026-08-20"),
    mk("later", "2026-12-01"),
    mk("undated", null),
  ];
  raw[4].primary.event_date = null;
  raw[4].primary.start_date = null;
  raw[4].primary.end_date = null;
  raw[4].primary.commercial = { sale_eligible: true, glance: {} };

  const stamped = stampPropertyExplorerTemporal(raw, {
    today,
    commercialOf: (r) => r.commercial,
  });
  assert.equal(stamped.find((e) => e.primary.request_id === "past-2013").temporal_status, "closed");
  assert.equal(stamped.find((e) => e.primary.request_id === "soon").temporal_status, "open");
  assert.equal(
    stamped.find((e) => e.primary.request_id === "past-2013").action_key,
    "property_action_closed",
    "closed sales never keep a live bid CTA",
  );
  assert.equal(
    stamped.find((e) => e.primary.request_id === "soon").action_key,
    "disposition_phase_action_bid",
  );

  const sorted = sortPropertyExplorerEntries(stamped, "closing_soon", (r) => r.commercial, { today });
  const ids = sorted.map((e) => e.primary.request_id);
  // Open soonest first, then undated, then closed (most recent closed first).
  assert.deepEqual(ids.slice(0, 2), ["soon", "later"]);
  assert.ok(ids.indexOf("undated") < ids.indexOf("past-2014"));
  assert.ok(ids.indexOf("past-2014") < ids.indexOf("past-2013"));
  assert.equal(ids[ids.length - 1], "past-2013");

  // Default open head must not include past closes.
  const cards = defaultViewCardsFromEntries(sorted);
  const sanity = findPastDeadlinesInDefaultView(cards, { today, topN: 5 });
  assert.equal(sanity.ok, true, JSON.stringify(sanity.findings));
  assert.ok(sanity.open_head.every((c) => c.temporal_status !== "closed"));
});

test("chip-format lint catches currency-before-month date chips", () => {
  const bad = findCurrencyLeakedDateChips([
    "closes $September 16, 2013",
    "closes $January 1, 2014",
    "min bid $4,800",
  ]);
  assert.equal(bad.ok, false);
  assert.equal(bad.findings.length, 2);

  const good = findCurrencyLeakedDateChips([
    "closes September 16, 2026",
    "closed January 1, 2014",
    "min bid $4,800",
    "upset price $850,000",
  ]);
  assert.equal(good.ok, true, JSON.stringify(good.findings));

  // Catalog: date keys must not use ${date} price-prefix form.
  const leak = findCurrencyLeakedDateI18n({
    property_commercial_close: "closes ${date}",
    property_commercial_closed: "closed {date}",
  });
  assert.equal(leak.ok, false);
  assert.equal(leak.findings[0].key, "property_commercial_close");

  const enSrc = readFileSync(join(ROOT, "site/i18n.js"), "utf8");
  const closeLine = enSrc.match(/property_commercial_close:\s*"([^"]+)"/);
  assert.ok(closeLine, "en close key present");
  assert.equal(closeLine[1], "closes {date}", "en close key has no $ price prefix");
  assert.doesNotMatch(closeLine[1], /\$\{date\}/);
});

test("isCloseDatePast treats missing dates as not closed", () => {
  assert.equal(isCloseDatePast("2013-09-16", "2026-08-03"), true);
  assert.equal(isCloseDatePast("2026-08-03", "2026-08-03"), false);
  assert.equal(isCloseDatePast("2026-08-20", "2026-08-03"), false);
  assert.equal(isCloseDatePast(null, "2026-08-03"), false);
  assert.equal(commercialCloseDate({ event_date: "2014-01-01T00:00:00.000" }, null), "2014-01-01");

  const hearing = extractPropertyCommercial({
    request_id: "hearing-temporal",
    type_of_notice_description: "Public Hearings",
    additional_description_1: "A public hearing will be held on June 27, 2018.",
  });
  assert.equal(hearing.close_date, "2018-06-27");
  assert.equal(isCloseDatePast(commercialCloseDate({}, hearing), "2026-08-03"), true);
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
  assert.match(href, /\/following\?/);
  assert.match(href, /vehicle/);
  assert.match(href, /online_auction/);
});

test("property watch context carries neighborhood and disposition stage through Following", () => {
  const scope = alertScopeFromLensState("property", {
    borough: "Brooklyn",
    neighborhood: "Greenpoint",
    process: "auction_or_rfp",
  });
  const href = alertsHref(scope);
  assert.match(href, /\/following\?/);
  assert.deepEqual(scope.filter, {
    keywords: [],
    agency: null,
    process: "auction_or_rfp",
    borough: "Brooklyn",
    neighborhood: "Greenpoint",
  });
  assert.match(SITE_SOURCE, /propertyWatchExtra/);
  assert.match(SITE_SOURCE, /w==="property"\s*\?\s*propertyWatchExtra/);
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
