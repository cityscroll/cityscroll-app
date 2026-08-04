import assert from "node:assert/strict";
import test from "node:test";

import {
  DETAIL_BODY_LIMIT,
  classifyPropertyPattern,
  corpusSha256,
  currentPropertyExtraction,
  detectPropertyJargon,
  detectPropertySignals,
  renderedNoticeSurfaces,
  searchExcerptForTerm,
} from "../tools/property_a11y_census.mjs";

test("property census classifies specific patterns before the disposition catch-all", () => {
  const cases = [
    ["pending_destruction", "Official notice of pending destruction of unauthorized tobacco"],
    ["unclaimed_property", "Owners are wanted by the Property Clerk; property is without claimants"],
    ["forest_timber_sale", "Forest Management Project: sale of timber and firewood"],
    ["lease_or_real_property_rfp", "Request for proposals for leasing opportunities"],
    ["surplus_auction", "The City is selling surplus assets at an auto auction"],
    ["direct_property_sale", "Notice of Public Sale of Residential Property"],
    ["medallion_auction", "Notice of winning bidders from a medallion auction"],
    ["udaap", "Urban Development Action Area Project (UDAAP) disposition"],
    ["acquisition_or_easement", "Public hearing for an acquisition and easement"],
    ["disposition", "Public hearing on the proposed disposition area"],
  ];
  for (const [expected, text] of cases) {
    assert.equal(classifyPropertyPattern({ short_title: text }), expected, text);
  }
});

test("rendered surfaces mirror the title and detail-body boundaries", () => {
  const row = {
    short_title: "<b>A &amp; B</b>",
    additional_description_1: `<p>${"word ".repeat(1500)}</p>`,
    additional_description_2: "This field is fetched but not rendered in the full-notice disclosure.",
  };
  const surfaces = renderedNoticeSurfaces(row);
  assert.equal(surfaces.title, "A & B");
  assert.equal(surfaces.detail_body.length, DETAIL_BODY_LIMIT);
  assert.doesNotMatch(surfaces.combined, /fetched but not rendered/);
});

test("query excerpts use the same 70-character radius and are absent without a term", () => {
  const row = { additional_description_1: `${"a".repeat(90)} hearing ${"b".repeat(90)}` };
  assert.equal(searchExcerptForTerm(row), null);
  const excerpt = searchExcerptForTerm(row, "hearing");
  assert.ok(excerpt.startsWith("…"));
  assert.ok(excerpt.endsWith("…"));
  assert.equal(excerpt.length, 2 + 70 + "hearing".length + 70);
});

test("timed-event and action signals stay source-grounded", () => {
  const signals = detectPropertySignals({
    event_date: "2026-09-01T10:00:00.000",
    additional_description_1: "Bids must be received no later than August 20. Mail an objection within 30 days. Written comments may be submitted by email.",
  });
  assert.equal(signals.structured_event_date, true);
  assert.equal(signals.bid_deadline, true);
  assert.equal(signals.objection_deadline, true);
  assert.equal(signals.object_action, true);
  assert.equal(signals.comment_action, true);
});

test("current extraction measurement reuses Property stage and participation extractors", () => {
  const current = currentPropertyExtraction({
    type_of_notice_description: "Sale",
    event_date: "2026-09-01T10:00:00.000",
    additional_description_1: "Prospective bidders are required to attend the public showing. All bid proposals must be received no later than August 20.",
  });
  assert.equal(current.stage_auction_or_rfp, true);
  assert.equal(current.event_date_as_action_deadline, true);
  assert.equal(current.bid_deadline_step, true);
  assert.equal(current.inspection_or_showing_step, true);
  assert.equal(current.objection_step, false);
});

test("jargon inventory only records literal source-language evidence", () => {
  const jargon = detectPropertyJargon({
    additional_description_1: "Pursuant to Section 12, notice is hereby given that the Disposition Area will be conveyed by sealed bid.",
  });
  assert.equal(jargon.pursuant_to, true);
  assert.equal(jargon.notice_hereby_given, true);
  assert.equal(jargon.disposition_area, true);
  assert.equal(jargon.conveyance, true);
  assert.equal(jargon.sealed_bid, true);
  assert.equal(jargon.udaap, false);
});

test("corpus fingerprint is deterministic and source-field sensitive", () => {
  const row = { request_id: "1", short_title: "Disposition" };
  assert.equal(corpusSha256([row]), corpusSha256([{ short_title: "Disposition", request_id: "1" }]));
  assert.notEqual(corpusSha256([row]), corpusSha256([{ ...row, short_title: "Auction" }]));
  assert.equal(corpusSha256([row]), corpusSha256([{ ...row, ignored_field: "not in the source contract" }]));
});
