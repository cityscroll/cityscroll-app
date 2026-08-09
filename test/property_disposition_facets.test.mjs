/**
 * Property disposition facet pivots — join-backed scope links for sale method,
 * price band, disposition process stage, and When (temporal).
 *
 *   node --test test/property_disposition_facets.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { extractPropertyCommercial } from "../site/property_commercial.mjs";
import {
  buildPropertyExplorerEntries,
  countPropertyProcessStages,
  filterPropertyExplorerEntries,
} from "../site/property_explorer.mjs";
import {
  countPropertyPriceBands,
  countPropertySaleMethods,
  countPropertyTemporalStages,
  normalizePropertyProcess,
  normalizePropertyTemporal,
  propertyDispositionScopeHref,
  propertyFacetChipItems,
  propertyPriceBandControlModel,
  propertyPriceBandKey,
  propertyProcessControlModel,
  propertySaleMethodControlModel,
  propertySaleMethodKey,
  propertyTemporalControlModel,
  propertyTemporalKey,
} from "../site/property_disposition_facets.mjs";
import { scopeFromRouteHash } from "../site/scope_v0.mjs";
import { boroughScopeHref } from "../site/borough_scope_links.mjs";
import { groupDispositionSpines } from "../worker/src/lib/property_disposition_spine.mjs";
import { SITE_SOURCE } from "./helpers/site_source.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const commercialFixture = JSON.parse(
  readFileSync(join(ROOT, "test/fixtures/property_commercial/real_notices.json"), "utf8"),
);
const dispositionFixture = JSON.parse(
  readFileSync(join(ROOT, "test/fixtures/property_disposition/multi_notice_bbl.json"), "utf8"),
);

function commercialEntries() {
  return commercialFixture.cases.map((entry) => {
    const commercial = extractPropertyCommercial(entry.row, { attachments: entry.attachments });
    const row = { ...entry.row, commercial };
    return {
      kind: "notice",
      primary: row,
      members: [row],
      notice_count: 1,
      process_filter: "unstaged",
    };
  });
}

function dispositionEntries() {
  const spines = groupDispositionSpines(dispositionFixture.notices);
  return buildPropertyExplorerEntries(dispositionFixture.notices, spines);
}

test("propertyDispositionScopeHref emits typed shareable property scope edges", () => {
  assert.equal(
    propertyDispositionScopeHref({}, { saleMethod: "online_auction" }),
    "#property?method=online_auction",
  );
  assert.equal(
    propertyDispositionScopeHref({}, { priceBand: "100k_plus" }),
    "#property?price=100k_plus",
  );
  assert.equal(
    propertyDispositionScopeHref({}, { process: "hearing" }),
    "#property?process=hearing",
  );
  assert.equal(
    propertyDispositionScopeHref({}, { process: "auction_or_rfp" }),
    "#property?process=auction_or_rfp",
  );
  assert.equal(
    propertyDispositionScopeHref({}, { process: "award_or_conveyance" }),
    "#property?process=award_or_conveyance",
  );
  assert.equal(
    propertyDispositionScopeHref({}, { stage: "soon" }),
    "#property?stage=soon",
  );
  // Clearing a facet returns the bare property surface.
  assert.equal(
    propertyDispositionScopeHref({ saleMethod: "online_auction" }, { saleMethod: "all" }),
    "#property",
  );
  // Composed scope preserves the orthogonal facet.
  assert.equal(
    propertyDispositionScopeHref({ process: "hearing" }, { priceBand: "under_10k" }),
    "#property?price=under_10k&process=hearing",
  );
});

test("all five Property pivots replace one axis and preserve the composed scope", () => {
  const currentHash = "#property?agency=HPD&boro=Brooklyn&asset=real_property&method=online_auction&price=100k_plus&process=hearing&stage=soon&sort=newest&view=archive&facet=%7B%22entity_refs_all%22%3A%5B%22bbl%3A1020260015%22%5D%7D";
  const cases = [
    ["borough", "#property?agency=HPD&asset=real_property&method=online_auction&price=100k_plus&process=hearing&stage=soon&sort=newest&view=archive&facet=%7B%22entity_refs_all%22%3A%5B%22bbl%3A1020260015%22%5D%7D&boro=Queens", { currentHash, borough: "Queens" }],
    ["sale method", "#property?agency=HPD&boro=Brooklyn&asset=real_property&method=sealed_bid&price=100k_plus&sort=newest&process=hearing&stage=soon&view=archive&facet=%7B%22entity_refs_all%22%3A%5B%22bbl%3A1020260015%22%5D%7D", { currentHash, saleMethod: "sealed_bid" }],
    ["price band", "#property?agency=HPD&boro=Brooklyn&asset=real_property&method=online_auction&price=under_10k&sort=newest&process=hearing&stage=soon&view=archive&facet=%7B%22entity_refs_all%22%3A%5B%22bbl%3A1020260015%22%5D%7D", { currentHash, priceBand: "under_10k" }],
    ["disposition stage", "#property?agency=HPD&boro=Brooklyn&asset=real_property&method=online_auction&price=100k_plus&sort=newest&process=award_or_conveyance&stage=soon&view=archive&facet=%7B%22entity_refs_all%22%3A%5B%22bbl%3A1020260015%22%5D%7D", { currentHash, process: "award_or_conveyance" }],
    ["When", "#property?agency=HPD&boro=Brooklyn&asset=real_property&method=online_auction&price=100k_plus&sort=newest&process=hearing&stage=past&view=archive&facet=%7B%22entity_refs_all%22%3A%5B%22bbl%3A1020260015%22%5D%7D", { currentHash, stage: "past" }],
  ];
  for (const [label, expected, patch] of cases) {
    const href = label === "borough"
      ? boroughScopeHref("property", "Queens", currentHash)
      : propertyDispositionScopeHref({ currentHash }, Object.fromEntries(Object.entries(patch).filter(([key]) => key !== "currentHash")));
    const scope = scopeFromRouteHash(href);
    assert.equal(href, expected, `${label} emits canonical Property scope`);
    assert.deepEqual(scope.facets.values.entity_refs_all, ["bbl:1020260015"], `${label} preserves opaque entity constraint`);
    assert.equal(scope.facets.agencies[0], "HPD", `${label} preserves agency`);
    assert.equal(scope.place.boroughs[0], label === "borough" ? "Queens" : "Brooklyn", `${label} preserves or replaces borough deliberately`);
  }
});

test("obtainable-key test: unknown sale method / price / process / temporal never invent", () => {
  assert.equal(normalizePropertyProcess("nope"), "all");
  assert.equal(normalizePropertyTemporal("whenever"), "all");
  assert.equal(propertySaleMethodKey({ commercial: { sale_method: { method: "garage_sale" } } }), null);
  assert.equal(propertySaleMethodKey({ commercial: {} }), null);
  assert.equal(propertyPriceBandKey({ commercial: { primary_price: { amount: "n/a" } } }), null);
  assert.equal(propertyPriceBandKey({ commercial: {} }), null);
  // Undated non-hearing rows stay outside temporal bands (fail closed).
  assert.equal(propertyTemporalKey({ short_title: "AUTO AUCTION" }), null);
  assert.equal(propertyTemporalKey({ event_date: "not-a-date" }), null);
});

test("sale method chips are inventory-backed exact keys from real notices", () => {
  const entries = commercialEntries();
  const counts = countPropertySaleMethods(entries);
  // Golden vehicle auction 20251106024 → online_auction (GovDeals).
  assert.ok(counts.online_auction >= 1, "online_auction from 20251106024");
  // Timber sealed bid 20190410105.
  assert.ok(counts.sealed_bid >= 1, "sealed_bid from 20190410105");
  // Methods not present in the fixture inventory must not appear as chips.
  assert.equal(counts.rfp || 0, 0);
  assert.equal(counts.lease_auction || 0, 0);

  const model = propertySaleMethodControlModel(counts, "online_auction");
  const chips = propertyFacetChipItems(model, "saleMethod");
  const ids = chips.map((c) => c.id);
  assert.ok(ids.includes("all"));
  assert.ok(ids.includes("online_auction"));
  assert.ok(ids.includes("sealed_bid"));
  assert.equal(ids.includes("rfp"), false, "absent methods are not inventable chips");
  assert.equal(ids.includes("lease_auction"), false);

  const online = chips.find((c) => c.id === "online_auction");
  assert.equal(online.href, "#property?method=online_auction");
  assert.equal(online.pressed, true);

  // Filtering by exact key admits only matching notices.
  const filtered = filterPropertyExplorerEntries(entries, {
    saleMethod: "online_auction",
    commercialOf: (row) => row.commercial,
  });
  assert.ok(filtered.length >= 1);
  for (const entry of filtered) {
    assert.equal(propertySaleMethodKey(entry.primary), "online_auction");
  }
});

test("price bands are ordered scope links; unknown prices stay outside bands", () => {
  const entries = commercialEntries();
  const counts = countPropertyPriceBands(entries);
  // Unpriced golden vehicle auction must not land in a dollar band.
  const auto = entries.find((e) => e.primary.request_id === "20251106024");
  assert.ok(auto);
  assert.equal(propertyPriceBandKey(auto.primary), null);
  assert.ok(counts.unpriced >= 1, "unpriced residual from real notices");

  // Upset Price Notice 20140224112 carries an explicit high price → 100k_plus.
  const priced = entries.find((e) => e.primary.request_id === "20140224112")
    || entries.find((e) => propertyPriceBandKey(e.primary) === "100k_plus");
  assert.ok(priced, "expected at least one priced real notice in fixture");
  assert.equal(propertyPriceBandKey(priced.primary), "100k_plus");
  assert.ok(counts["100k_plus"] >= 1);

  const model = propertyPriceBandControlModel(counts, "100k_plus");
  const chips = propertyFacetChipItems(model, "priceBand");
  assert.deepEqual(chips.map((c) => c.id), [
    "all",
    "priced",
    "under_10k",
    "10k_100k",
    "100k_plus",
  ]);
  // unpriced is residual — never a selectable band chip.
  assert.equal(chips.some((c) => c.id === "unpriced"), false);
  assert.equal(chips.find((c) => c.id === "100k_plus").href, "#property?price=100k_plus");
  assert.equal(model.unpriced_count, counts.unpriced);

  const onlyHigh = filterPropertyExplorerEntries(entries, {
    priceBand: "100k_plus",
    commercialOf: (row) => row.commercial,
  });
  for (const entry of onlyHigh) {
    assert.equal(propertyPriceBandKey(entry.primary), "100k_plus");
  }
  // Auto auction (no price) never matches a band filter.
  assert.equal(onlyHigh.some((e) => e.primary.request_id === "20251106024"), false);
});

test("disposition process rail is hearing → auction/RFP → award pivots from real spines", () => {
  const entries = dispositionEntries();
  const counts = countPropertyProcessStages(entries);
  assert.ok(counts.hearing >= 1, "hearing stage from multi-notice BBL fixture");
  assert.ok(counts.auction_or_rfp >= 1, "auction_or_rfp stage from multi-notice BBL fixture");
  assert.ok(counts.award_or_conveyance >= 1, "award_or_conveyance from full-chain fixture");
  assert.ok(counts.unstaged >= 1, "unstaged residual present");

  const model = propertyProcessControlModel(counts, "hearing");
  assert.deepEqual(model.lifecycle.map((item) => item.id), [
    "hearing",
    "auction_or_rfp",
    "award_or_conveyance",
  ]);
  assert.equal(model.lifecycle[0].href, "#property?process=hearing");
  assert.equal(model.lifecycle[1].href, "#property?process=auction_or_rfp");
  assert.equal(model.lifecycle[2].href, "#property?process=award_or_conveyance");
  assert.equal(model.lifecycle[0].pressed, true);
  assert.ok(model.unstaged, "unstaged residual is explicit, not inferred into a lifecycle step");
  assert.equal(model.unstaged.href, "#property?process=unstaged");

  const chips = propertyFacetChipItems(model, "process");
  assert.deepEqual(chips.map((c) => c.id), [
    "all",
    "hearing",
    "auction_or_rfp",
    "award_or_conveyance",
    "unstaged",
  ]);

  const hearings = filterPropertyExplorerEntries(entries, { process: "hearing" });
  for (const entry of hearings) {
    assert.equal(entry.process_filter, "hearing");
  }
});

test("When temporal chips use source dates; undated stays outside dated bands", () => {
  const today = "2026-08-06";
  const rows = [
    {
      request_id: "soon-1",
      event_date: "2026-08-20",
      type_of_notice_description: "Sale",
      commercial: { sale_eligible: true },
    },
    {
      request_id: "past-1",
      event_date: "2015-10-28",
      type_of_notice_description: "Sale",
      commercial: { sale_eligible: true },
    },
    {
      request_id: "proposed-1",
      event_date: null,
      type_of_notice_description: "Public Hearings",
      commercial: { sale_eligible: false },
    },
    {
      // Real undated shape: vehicle online auction with no event_date (20251106024).
      request_id: "20251106024",
      event_date: null,
      type_of_notice_description: "Sale",
      short_title: "AUTO AUCTION",
      commercial: { sale_method: { method: "online_auction" }, sale_eligible: true },
    },
  ];
  const entries = rows.map((row) => ({
    kind: "notice",
    primary: row,
    members: [row],
    notice_count: 1,
    process_filter: "unstaged",
  }));

  assert.equal(propertyTemporalKey(rows[0], { today }), "soon");
  assert.equal(propertyTemporalKey(rows[1], { today }), "past");
  assert.equal(propertyTemporalKey(rows[2], { today }), "proposed");
  assert.equal(propertyTemporalKey(rows[3], { today }), null, "undated sale stays unknown");

  const counts = countPropertyTemporalStages(entries, {
    today,
    temporalOf: (row) => propertyTemporalKey(row, { today }),
  });
  assert.equal(counts.soon, 1);
  assert.equal(counts.past, 1);
  assert.equal(counts.proposed, 1);
  assert.equal(counts.undated, 1);

  const model = propertyTemporalControlModel(counts, "soon");
  const chips = propertyFacetChipItems(model, "temporal");
  const ids = chips.map((c) => c.id);
  assert.ok(ids.includes("all"));
  assert.ok(ids.includes("soon"));
  assert.ok(ids.includes("past"));
  assert.ok(ids.includes("proposed"));
  // Empty upcoming bucket is inventory-hidden; undated is never a dated-band chip.
  assert.equal(ids.includes("upcoming"), false);
  assert.equal(ids.includes("undated"), false);
  assert.equal(chips.find((c) => c.id === "soon").href, "#property?stage=soon");

  const soonOnly = filterPropertyExplorerEntries(entries, {
    temporal: "soon",
    temporalOf: (row) => propertyTemporalKey(row, { today }),
  });
  assert.deepEqual(soonOnly.map((e) => e.primary.request_id), ["soon-1"]);

  const pastOnly = filterPropertyExplorerEntries(entries, {
    temporal: "past",
    temporalOf: (row) => propertyTemporalKey(row, { today }),
  });
  assert.deepEqual(pastOnly.map((e) => e.primary.request_id), ["past-1"]);
  // Undated auto auction must not be forced into "past".
  assert.equal(pastOnly.some((e) => e.primary.request_id === "20251106024"), false);
});

test("property app renders disposition facet rails as pressed filter chips", () => {
  assert.match(SITE_SOURCE, /property_disposition_facets\.mjs/);
  assert.match(SITE_SOURCE, /property_disposition_facets_ui\.mjs/);
  assert.match(SITE_SOURCE, /propertyDispositionFacetRailsHTML/);
  assert.match(SITE_SOURCE, /bindPropertyScopeFacetRail/);
  // Shareable scope destinations live on the shared filter-chip primitive.
  const ui = readFileSync(join(ROOT, "site/property_disposition_facets_ui.mjs"), "utf8");
  assert.match(ui, /filterChip\(\{/);
  assert.match(ui, /data-filter-href/);
  assert.doesNotMatch(ui, /<a class="chip/);
  // Asset type rail may remain buttons; the four disposition rails use filter chips.
  assert.match(SITE_SOURCE, /salerail/);
  assert.match(SITE_SOURCE, /pricerail/);
  assert.match(SITE_SOURCE, /liferail/);
  assert.match(SITE_SOURCE, /processrail/);
  assert.match(ui, /data-scope-edge/);
});

test("markup still hosts the four disposition facet rails under More filters", () => {
  const index = readFileSync(join(ROOT, "site/index.html"), "utf8");
  assert.match(index, /id="salerail"/);
  assert.match(index, /id="pricerail"/);
  assert.match(index, /id="processrail"/);
  assert.match(index, /id="liferail"/);
  // The borough scope rail remains adjacent to the landed disposition facets.
  assert.match(index, /id="property-borough-rail"/);
  assert.match(index, /id="propertyagency"/);
  assert.doesNotMatch(index, /id="propertyboro"/);
  assert.doesNotMatch(index, /id="property-sale-method"/);
  assert.doesNotMatch(index, /id="property-price-band"/);
  assert.doesNotMatch(index, /id="property-process-stage"/);
  assert.doesNotMatch(index, /id="property-when"/);
});
