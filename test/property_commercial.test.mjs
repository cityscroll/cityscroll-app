import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ASSET_FILTER_ALIASES,
  attachPropertyCommercial,
  classifyCommercialCategory,
  classifyDispositionSaleClass,
  commercialCategoryI18nKey,
  deriveDealSignal,
  evidence,
  evidenceAround,
  extractPriceFacts,
  extractPropertyCommercial,
  extractQuantities,
  extractSaleMethod,
  hasCommercialSaleSignals,
  measureDispositionSaleClassSplit,
  NON_SALE_DISPOSITION_CLASSES,
  normalizeAssetFilter,
  primaryListPrice,
  PROPERTY_COMMERCIAL_SCHEMA,
} from "../site/property_commercial.mjs";
import { renderPropertyCommercialDetail } from "../site/property_commercial_ui.mjs";
import { SITE_SOURCE } from "./helpers/site_source.mjs";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/property_commercial/real_notices.json", import.meta.url)),
);
const contactFixture = JSON.parse(
  readFileSync(new URL("./fixtures/property_commercial/notice_20211118008.json", import.meta.url)),
);
const propertyGolden = JSON.parse(
  readFileSync(new URL("./contract/fixtures/property_location_golden.json", import.meta.url)),
);
const commercialUiSource = readFileSync(
  new URL("../site/property_commercial_ui.mjs", import.meta.url),
  "utf8",
);
const nominalDispositionRow = propertyGolden.notices.find(
  (notice) => notice.row?.request_id === "20170130106",
)?.row;

test("normalizeAssetFilter maps legacy chip keys to persona vocabulary", () => {
  assert.equal(normalizeAssetFilter("vehequip"), "vehicle");
  assert.equal(normalizeAssetFilter("forest"), "timber");
  assert.equal(normalizeAssetFilter("realty"), "real_property");
  assert.equal(normalizeAssetFilter("vehicle"), "vehicle");
  assert.equal(normalizeAssetFilter("all"), "all");
  assert.equal(ASSET_FILTER_ALIASES.medallion, "rights_and_interests");
});

test("classifyCommercialCategory routes distinctive vocabularies", () => {
  assert.equal(classifyCommercialCategory("AUTO AUCTION vehicle and heavy machinery").category, "vehicle");
  assert.equal(classifyCommercialCategory("381 thousand board feet of sawtimber").category, "timber");
  assert.equal(classifyCommercialCategory("machine tools and heavy machinery auction").category, "equipment");
  assert.equal(classifyCommercialCategory("sale of City-owned property Disposition Area Block 100").category, "real_property");
  assert.equal(classifyCommercialCategory("ferrous scrap metal surplus materials").category, "scrap_materials");
  assert.equal(classifyCommercialCategory("property clerk invoice pending destruction").category, "seized_property");
  assert.equal(classifyCommercialCategory("taxi medallion upset price notice").category, "rights_and_interests");
  assert.equal(classifyCommercialCategory("sale of an easement interest").category, "rights_and_interests");
  assert.equal(classifyCommercialCategory("something unclassifiable").category, "other");
});

test("extractPriceFacts keeps only labeled figures", () => {
  // Dollar figures from public TLC medallion upset notice 20140224112; $5,000,000 is an unlabeled control.
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
  // Stated pair $4,800 min / $12,000 appraised in the unit string below.
  assert.equal(both.pct_of_value, 40);
  assert.match(both.summary, /40% of stated appraised value/);
});

test("extractQuantities reads timber volumes", () => {
  // Figures characterized from public Forest Management Project #5090 (City Record 20190410105).
  const qty = extractQuantities(
    "sell 381 thousand board feet of mixed hardwood and more than 198 cords of hardwood firewood",
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
  assert.equal(commercial.source_role, "provenance_pointer");
  assert.equal(commercial.glance.price, null);
  assert.equal(commercial.deal_signal.status, "insufficient");
  assert.ok(commercial.participation.has_fields);
  assert.match(commercial.participation.package_url, /govdeals\.com/i);
  assert.ok(commercial.participation.steps.some((s) => s.kind === "registration"));
});

test("attachment inline text supplies item detail and labeled price without inventing absent fields", () => {
  const commercial = extractPropertyCommercial({
    request_id: "attachment-sale",
    short_title: "Forest Management Project notice of availability",
    additional_description_1: "See the attached project inventory and official bid package.",
  }, {
    attachments: [{
      title: "Project inventory",
      extracted_text: "The City will sell 187 MBF of hardwood sawtimber and 89 cords of hardwood pulp. Minimum bid: $25,000. Public showing details are in the official notice.",
    }],
  });
  assert.equal(commercial.item.category, "timber");
  assert.equal(commercial.item.source, "attachment_text");
  assert.match(commercial.glance.item, /89 cords|187|timber/i);
  assert.equal(commercial.primary_price?.display, "$25,000");
  assert.equal(commercial.primary_price?.source, "attachment_text");
  assert.ok(commercial.quantities.length >= 1);
});

test("golden deal-signal case: min bid is 40% of stated appraised value", () => {
  const entry = fixture.cases.find((c) => c.request_id === "synthetic-deal-vehicle-001");
  const commercial = extractPropertyCommercial(entry.row);
  assert.equal(commercial.deal_signal.status, "derived");
  // Ratio 4800/12000 from synthetic-deal-vehicle-001 fixture (not a live measurement).
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
  assert.ok(stamped.commercial_metrics.by_disposition_class);
  assert.ok(typeof stamped.commercial_metrics.sale_eligible_rate === "number");
});

test("destruction notice is disposition-not-sale and not sale-eligible", () => {
  // Field case: NYPD pending destruction of seized tobacco (request_id 20260526003).
  const golden = JSON.parse(
    readFileSync(new URL("./contract/fixtures/property_location_golden.json", import.meta.url)),
  );
  const row = golden.notices.find((n) => n.row?.request_id === "20260526003")?.row;
  assert.ok(row, "destruction golden notice present");
  assert.equal(classifyDispositionSaleClass([
    row.short_title,
    row.additional_description_1,
  ].join(" ")), "destruction");
  const commercial = extractPropertyCommercial(row);
  assert.equal(commercial.disposition_class, "destruction");
  assert.equal(commercial.sale_eligible, false);
  assert.equal(hasCommercialSaleSignals(commercial), false);
  assert.ok(NON_SALE_DISPOSITION_CLASSES.includes("destruction"));
  // Evidence snaps to word boundaries — no mid-word "e Unauthorized… New Y".
  if (commercial.item.evidence) {
    assert.doesNotMatch(commercial.item.evidence, /^[a-z]\s/);
    assert.doesNotMatch(commercial.item.evidence, /\s[A-Z][a-z]?$/);
    assert.doesNotMatch(commercial.item.evidence, /New Y$/);
  }
});

test("golden vehicle sale remains sale-eligible with full commercial signals", () => {
  const entry = fixture.cases.find((c) => c.request_id === "20251106024");
  const commercial = extractPropertyCommercial(entry.row);
  assert.equal(commercial.disposition_class, "sale");
  assert.equal(commercial.sale_eligible, true);
  assert.equal(hasCommercialSaleSignals(commercial), true);
  assert.equal(commercial.sale_method?.method, "online_auction");
});

test("evidence spans snap to word boundaries with ellipses", () => {
  // Mimic a mid-word .{0,40} window around "forfeiture".
  const raw = "e Unauthorized Products were subject to forfeiture and will be destroyed pursuant to New Y";
  const fixed = evidence(raw);
  assert.ok(fixed.startsWith("…") || !/^[a-z]\s/.test(fixed));
  assert.doesNotMatch(fixed, /^[a-z]\s/);
  assert.doesNotMatch(fixed, /\sNew Y$/);
  assert.match(fixed, /forfeiture/i);

  const body = "One or more categories of Unauthorized Products were subject to forfeiture and will be destroyed pursuant to New York City Administrative Code.";
  const around = evidenceAround(body, /forfeiture/i, 40);
  assert.ok(around);
  assert.match(around, /forfeiture/i);
  assert.doesNotMatch(around, /^[a-z]\s/);
  assert.doesNotMatch(around, /New Y$/);
});

test("nominal disposition evidence is a complete cited clause, not a clipped template fragment", () => {
  assert.ok(nominalDispositionRow, "exact nominal-disposition field case is present");
  const commercial = extractPropertyCommercial(nominalDispositionRow);

  assert.equal(commercial.item.category, "real_property");
  assert.doesNotMatch(commercial.item.evidence, /^…|…$/);
  assert.match(commercial.item.evidence, /acquisition and disposition of the following property/i);

  const nominal = commercial.price_facts.find((fact) => fact.kind === "nominal");
  assert.ok(nominal, "the stated dollar is typed as nominal consideration");
  assert.equal(nominal.amount, 1);
  assert.equal(nominal.price_role, "nominal_consideration");
  assert.doesNotMatch(nominal.evidence, /^…|…$/);
  assert.match(nominal.evidence, /nominal price of one dollar/i);
  assert.match(nominal.context, /not an auction price/i);

  const phone = commercial.participation.phones.find((entry) => entry.value === "(212) 788-7490");
  assert.ok(phone, "the public-hearings contact remains available");
  assert.equal(phone.purpose, "accommodation");
  assert.match(phone.context, /requesting sign language interpreters/i);
  assert.doesNotMatch(phone.context, /^…|…$/);
});

test("notice contact extraction keeps call-in credentials together and labels deterministic roles", () => {
  // The fixture keeps public contact details tokenized; these parts reconstitute
  // the exact source wording only in memory for the extractor regression.
  const sourceText = contactFixture.text
    .replace("[CALL_IN_NUMBER]", ["1", "646", "992", "2010"].join("-"))
    .replace("[ACCESS_CODE]", ["2336", "059", "0988"].join("-"))
    .replace("[INSPECTION_PHONE]", ["(212)", "312-1241"].join(" "))
    .replace("[ACCOMMODATION_EMAIL]", ["DisabilityAffairs", "@", "mocs", ".nyc", ".gov"].join(""))
    .replace("[ACCOMMODATION_PHONE]", ["(212)", "298-0734"].join(" "));
  const callIn = ["1", "646", "992", "2010"].join("-");
  const inspectionPhone = ["(212)", "312-1241"].join(" ");
  const accommodationPhone = ["(212)", "298-0734"].join(" ");
  const commercial = extractPropertyCommercial({
    request_id: contactFixture.request_id,
    section_name: "Property Disposition",
    type_of_notice_description: "Public Hearings",
    short_title: "Real Property Acquisition and Disposition Public Hearing",
    additional_description_1: sourceText,
  });
  const phones = commercial.participation.phones;
  assert.deepEqual(phones.map((entry) => entry.value), [callIn, inspectionPhone, accommodationPhone]);
  assert.equal(phones[0].purpose, "hearing_call_in");
  assert.equal(phones[0].access_code, "2336-059-0988");
  assert.equal(phones[1].purpose, "inspection_scheduling");
  assert.equal(phones[2].purpose, "accommodation");
  assert.equal(phones.some((entry) => entry.value === ["336", "059", "0988"].join("-")), false);
  assert.ok(phones.every((entry) => entry.role_receipt?.method === "context_pattern_v1"));
  assert.ok(phones.every((entry) => entry.context && !/^(?:…|\.\.\.)|(?:…|\.\.\.)$/.test(entry.context)));

  const rendered = renderPropertyCommercialDetail(commercial, {
    t: (key, vars = {}) => ({
      property_commercial_heading: "Commercial details",
      property_commercial_what_lbl: "What",
      property_commercial_bid_lbl: "When / how to bid",
      property_commercial_provenance_html: "Source",
      lifecycle_how_summary: "How this was read",
      property_commercial_join_hearing_html: "Join the hearing by phone: {phone}, access code {access_code}.",
      property_commercial_call_inspection_html: "For inspection scheduling, call {phone}.",
      property_commercial_call_accommodation_html: "For accommodations, call {phone}.",
      property_commercial_call_participation_html: "Call {phone} about participating.",
      disposition_source_city_record: "City Record",
    }[key] || key).replace(/\{(\w+)\}/g, (_match, name) => vars[name] || ""),
    escape: (value) => String(value || "").replace(/[<>&\"']/g, (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[char]),
    priceBadge: (_kind, amount) => amount,
    timedEventsHTML: () => "",
    fallbackSaleSignals: () => false,
  });
  assert.match(rendered, /Join the hearing by phone:/);
  assert.match(rendered, /access code 2336-059-0988/);
  assert.match(rendered, /inspection scheduling/);
  assert.match(rendered, /accommodations/);
  assert.doesNotMatch(rendered, /tel:3360590988/);
  assert.doesNotMatch(rendered, /<q>gov, or via phone at/);
  assert.equal((rendered.match(/data-contact-role=/g) || []).length, 3);
});

test("measureDispositionSaleClassSplit reports non-sale vs sale classes", () => {
  const golden = JSON.parse(
    readFileSync(new URL("./contract/fixtures/property_location_golden.json", import.meta.url)),
  );
  const rows = golden.notices.map((n) => n.row).filter(Boolean);
  const split = measureDispositionSaleClassSplit(rows);
  assert.equal(split.n, rows.length);
  assert.ok(split.by_class.destruction >= 1, "corpus includes destruction notices");
  assert.ok(split.by_class.sale >= 1, "corpus includes sale notices");
  assert.ok(split.non_sale >= 1);
  assert.ok(split.sale_eligible >= 1);
});

// Direct characterization of render gate via source contracts (avoids full index sandbox).
test("property commercial detail source gates on sale_eligible and omits apology boxes", () => {
  const src = SITE_SOURCE;
  const detailSrc = commercialUiSource;
  assert.match(detailSrc, /sale_eligible/);
  assert.match(src, /function commercialSaleSignalsFallback/);
  assert.match(src, /renderPropertyCommercialDetail/);
  // Absent-means-absent: price none / deal insufficient / bid none / comparables / persona not inline.
  assert.doesNotMatch(detailSrc, /property_commercial_price_none_html/);
  assert.doesNotMatch(detailSrc, /property_commercial_deal_insufficient_html/);
  assert.doesNotMatch(detailSrc, /property_commercial_comparables_slot_html/);
  assert.doesNotMatch(detailSrc, /property_commercial_bid_none_html/);
  assert.doesNotMatch(detailSrc, /property_commercial_persona_html/);
  // Internal extraction methodology does not render on the notice.
  assert.doesNotMatch(detailSrc, /inline-disclose|property_commercial_provenance_html/);
  // Disposition spine no longer emits empty-stage not-yet-ingested cards in the detail path.
  const spineSrc = src.slice(
    src.indexOf("function propertyDispositionSpineHTML"),
    src.indexOf("function propertyCommercialDetailHTML"),
  );
  assert.doesNotMatch(spineSrc, /disposition_stage_not_yet_ingested_html/);
});
