import assert from "node:assert/strict";
import { test } from "node:test";

import {
  evaluatePropertyWatch,
  propertyWatchStageLabel,
} from "../src/lib/property_saved_watch.mjs";
import { sanitize } from "../src/lib/filter.mjs";
import { subDigestHtml } from "../src/alerts.mjs";

const hearing = {
  request_id: "property-hearing-1",
  start_date: "2026-07-01T00:00:00.000",
  type_of_notice_description: "Public Hearings",
  short_title: "Brooklyn property disposition hearing",
  additional_description_1: "Public hearing on the proposed disposition of BBL 3025180036, Borough of Brooklyn Block 2518 Lot 36.",
  property_location: { scope: "local", boroughs: ["Brooklyn"], neighborhoods: [], addresses: [], tax_lots: [{ block: "2518", lots: ["36"] }], bbls: ["3025180036"] },
};

const auction = {
  request_id: "property-auction-1",
  start_date: "2026-08-01T00:00:00.000",
  event_date: "2026-08-20T00:00:00.000",
  type_of_notice_description: "Sale",
  short_title: "Public auction of Brooklyn property",
  additional_description_1: "Public auction on August 20 for BBL 3025180036, Borough of Brooklyn Block 2518 Lot 36.",
  property_location: { scope: "local", boroughs: ["Brooklyn"], neighborhoods: [], addresses: [], tax_lots: [{ block: "2518", lots: ["36"] }], bbls: ["3025180036"] },
};

test("a property watch records the stage at which a parcel first matched", () => {
  const result = evaluatePropertyWatch([hearing], {
    borough: "Brooklyn",
    process: "hearing",
  }, new Set());

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].property_watch.matched_at_stage, "hearing");
  assert.equal(result.rows[0].property_watch.current_stage, "hearing");
  assert.equal(result.rows[0].property_watch.transition, null);
  assert.ok(result.markSeenIds.some((key) => key.includes(":matched:hearing")));
});

test("a later stage remains in the digest and is named positively", () => {
  const first = evaluatePropertyWatch([hearing], {
    borough: "Brooklyn",
    process: "hearing",
  }, new Set());
  const seen = new Set(first.markSeenIds);
  seen.add(hearing.request_id);

  const result = evaluatePropertyWatch([auction], {
    borough: "Brooklyn",
    process: "hearing",
  }, seen);

  assert.equal(result.rows.length, 1, "the watched parcel survives leaving the original stage");
  assert.equal(result.rows[0].property_watch.matched_at_stage, "hearing");
  assert.deepEqual(result.rows[0].property_watch.transition, {
    from: "hearing",
    to: "auction_or_rfp",
    label: "moved to auction / RFP",
  });
  assert.equal(propertyWatchStageLabel("award_or_conveyance", { transition: true }), "moved to award / conveyance");
  assert.doesNotMatch(result.rows[0].property_watch.transition.label, /no longer|removed|missing/i);
});

test("borough and neighborhood filters are applied honestly", () => {
  assert.equal(evaluatePropertyWatch([hearing], { borough: "Queens", process: "hearing" }, new Set()).rows.length, 0);
  assert.equal(evaluatePropertyWatch([hearing], { neighborhood: "Williamsburg", process: "hearing" }, new Set()).rows.length, 0);
});

test("the subscription sanitizer preserves property neighborhood and process", () => {
  const filter = sanitize("property", { borough: "Brooklyn", neighborhood: "Greenpoint", process: "auction_or_rfp" });
  assert.equal(filter.borough, "Brooklyn");
  assert.equal(filter.neighborhood, "Greenpoint");
  assert.equal(filter.process, "auction_or_rfp");
});

test("property digest copy shows matched-at stage and the positive transition", () => {
  const transitioned = evaluatePropertyWatch([auction], { borough: "Brooklyn", process: "hearing" }, new Set([
    "property-stage:bbl%3A3025180036:matched:hearing",
    "property-stage:bbl%3A3025180036:current:hearing",
  ])).rows;
  const html = subDigestHtml("Brooklyn hearing-stage parcels", "property", transitioned, "https://example.com/unsubscribe", "2026-08-01");
  assert.match(html, /Matched at:<\/b> hearing/);
  assert.match(html, /moved to auction \/ RFP/);
  assert.doesNotMatch(html, /no longer listed|removed from/i);
});
