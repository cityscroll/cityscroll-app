import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ASSET_FILTER_ALIASES,
  attachPropertyCommercial,
  classifyCommercialCategory,
  commercialCategoryI18nKey,
  deriveDealSignal,
  extractPriceFacts,
  extractPropertyCommercial,
  extractQuantities,
  extractSaleMethod,
  normalizeAssetFilter,
  primaryListPrice,
  PROPERTY_COMMERCIAL_SCHEMA,
} from "../site/property_commercial.mjs";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/property_commercial/real_notices.json", import.meta.url)),
);

test("normalizeAssetFilter maps legacy chip keys to persona vocabulary", () => {
  assert.equal(normalizeAssetFilter("vehequip"), "vehicle");
  assert.equal(normalizeAssetFilter("forest"), "timber");
  assert.equal(normalizeAssetFilter("realty"), "real_property");
  assert.equal(normalizeAssetFilter("vehicle"), "vehicle");
  assert.equal(normalizeAssetFilter("all"), "all");
  assert.equal(ASSET_FILTER_ALIASES.medallion, "other");
});

test("classifyCommercialCategory routes distinctive vocabularies", () => {
  assert.equal(classifyCommercialCategory("AUTO AUCTION vehicle and heavy machinery").category, "vehicle");
  assert.equal(classifyCommercialCategory("381 thousand board feet of sawtimber").category, "timber");
  assert.equal(classifyCommercialCategory("machine tools and heavy machinery auction").category, "equipment");
  assert.equal(classifyCommercialCategory("sale of City-owned property Disposition Area Block 100").category, "real_property");
  assert.equal(classifyCommercialCategory("ferrous scrap metal surplus materials").category, "scrap_materials");
  assert.equal(classifyCommercialCategory("something unclassifiable").category, "other");
});

test("extractPriceFacts keeps only labeled figures", () => {
  const facts = extractPriceFacts(
    "minimum bid of $1,700,000; minimum upset price $850,000; the project costs $5,000,000 in total",
  );
  assert.ok(facts.some((f) => f.kind === "minimum_bid" && f.amount === 1700000));
  assert.ok(facts.some((f) => f.kind === "upset_price" && f.amount === 850000));
  assert.equal(facts.some((f) => f.amount === 5000000), false, "unlabeled dollars stay out");
});

test("deriveDealSignal is honest about missing pairs and derives when both exist", () => {
  const onlyFloor = deriveDealSignal(extractPriceFacts("minimum bid $4,800"));
  assert.equal(onlyFloor.status, "insufficient");
  assert.equal(onlyFloor.comparables_slot.status, "not_yet_acquired");

  const both = deriveDealSignal(
    extractPriceFacts("appraised at a value of $12,000. Minimum bid: $4,800."),
  );
  assert.equal(both.status, "derived");
  assert.equal(both.pct_of_value, 40);
  assert.match(both.summary, /40% of stated appraised value/);
});

test("extractQuantities reads timber volumes", () => {
  const qty = extractQuantities(
    "sell approximately 381 thousand board feet of mixed hardwood and more than 198 cords of hardwood firewood",
  );
  assert.ok(qty.some((q) => q.unit === "board_feet" && q.amount === 381000));
  assert.ok(qty.some((q) => q.unit === "cords" && q.amount === 198));
});

test("extractSaleMethod prefers online and sealed labels", () => {
  assert.equal(
    extractSaleMethod("posts vehicle auctions online every week at govdeals.com").method,
    "online_auction",
  );
  assert.equal(extractSaleMethod("Sealed bids will be publicly opened").method, "sealed_bid");
  assert.equal(extractSaleMethod("offered at public auction on October 28").method, "public_auction");
});

for (const entry of fixture.cases) {
  test(`real commercial case ${entry.request_id}: ${entry.note.slice(0, 60)}`, () => {
    const commercial = extractPropertyCommercial(entry.row, { attachments: entry.attachments });
    assert.equal(commercial.schema, PROPERTY_COMMERCIAL_SCHEMA);
    assert.equal(commercial.item.category, entry.expect.category);

    if (entry.expect.sale_method) {
      assert.equal(commercial.sale_method?.method, entry.expect.sale_method);
    }
    if (entry.expect.has_package_url) {
      assert.ok(commercial.participation.package_url);
      if (entry.expect.package_host) {
        assert.match(commercial.participation.package_url, new RegExp(entry.expect.package_host, "i"));
      }
    }
    if (entry.expect.has_price != null) {
      assert.equal(Boolean(commercial.primary_price), entry.expect.has_price);
    }
    if (entry.expect.price_kinds) {
      for (const kind of entry.expect.price_kinds) {
        assert.ok(
          commercial.price_facts.some((f) => f.kind === kind),
          `expected price kind ${kind}`,
        );
      }
    }
    if (entry.expect.quantity_units) {
      for (const unit of entry.expect.quantity_units) {
        assert.ok(commercial.quantities.some((q) => q.unit === unit), `expected quantity ${unit}`);
      }
    }
    if (entry.expect.deal_status) {
      assert.equal(commercial.deal_signal.status, entry.expect.deal_status);
    }
    if (entry.expect.deal_pct != null) {
      assert.equal(commercial.deal_signal.pct_of_value, entry.expect.deal_pct);
    }
    if (entry.expect.has_show_step) {
      assert.ok(commercial.participation.steps.some((s) => s.kind === "show_or_inspection"));
    }
    if (entry.expect.item_mentions_attachment) {
      assert.match(String(commercial.item.label || ""), /attachment inventory/i);
      assert.equal(commercial.item.source, "attachment_metadata");
    }
    // Every fact carries evidence when present.
    for (const fact of commercial.price_facts) {
      assert.ok(fact.evidence && fact.evidence.length >= 4);
      assert.equal(fact.source, "notice_body");
    }
    assert.ok(commercial.glance.item);
    assert.equal(commercialCategoryI18nKey(commercial.item.category).startsWith("asset_"), true);
  });
}

test("golden vehicle case paints glance item + bid steps without inventing a deal", () => {
  const entry = fixture.cases.find((c) => c.request_id === "20251106024");
  const commercial = extractPropertyCommercial(entry.row);
  assert.equal(commercial.item.category, "vehicle");
  assert.equal(commercial.glance.price, null);
  assert.equal(commercial.deal_signal.status, "insufficient");
  assert.ok(commercial.participation.has_fields);
  assert.match(commercial.participation.package_url, /govdeals\.com/i);
  assert.ok(commercial.participation.steps.some((s) => s.kind === "registration"));
});

test("golden deal-signal case: min bid is 40% of stated appraised value", () => {
  const entry = fixture.cases.find((c) => c.request_id === "synthetic-deal-vehicle-001");
  const commercial = extractPropertyCommercial(entry.row);
  assert.equal(commercial.deal_signal.status, "derived");
  assert.equal(commercial.deal_signal.pct_of_value, 40);
  assert.match(commercial.glance.deal, /40%/);
  assert.equal(primaryListPrice(commercial.price_facts).kind, "minimum_bid");
  assert.equal(commercial.deal_signal.comparables_slot.status, "not_yet_acquired");
});

test("attachPropertyCommercial stamps rows and coverage metrics", () => {
  const view = {
    schema_version: 1,
    properties: fixture.cases.map((c) => c.row),
  };
  const bag = Object.fromEntries(
    fixture.cases.map((c) => [c.request_id, c.attachments || []]),
  );
  const stamped = attachPropertyCommercial(view, { attachmentsByRequestId: bag });
  assert.equal(stamped.properties.length, fixture.cases.length);
  assert.ok(stamped.properties.every((r) => r.commercial?.schema === PROPERTY_COMMERCIAL_SCHEMA));
  assert.equal(stamped.commercial_metrics.metric, "property_commercial_price_coverage");
  assert.ok(stamped.commercial_metrics.n === fixture.cases.length);
});
