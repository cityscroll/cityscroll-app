import { test } from "node:test";
import assert from "node:assert/strict";
import { describeFilter, welcomeEmailHtml } from "../src/lib/confirm_email.mjs";
import { subCanonical } from "../src/lib/subscriptions.mjs";

test("describeFilter renders a money threshold query", () => {
  assert.equal(
    describeFilter("money", { minAmount: 1000000, keywords: ["construction"] }),
    "Contracts and RFPs — about “construction” · ≥ $1,000,000"
  );
});

test("describeFilter renders a person lookup with the recovered name", () => {
  assert.equal(
    describeFilter("people", { lookupType: "person", keywords: ["rodriguez"] }),
    "Staffing and exams — a person named “rodriguez”"
  );
});

test("describeFilter names an exam interest-area watch", () => {
  assert.equal(
    describeFilter("people", { view:"guide", interestArea:"public-safety", interestLabel:"Public safety" }),
    "Civil-service exams — Public safety"
  );
});

test("describeFilter renders a land query with borough + status", () => {
  assert.equal(
    describeFilter("land", { boro: "Brooklyn", keywords: ["rezoning"], status: "all" }),
    "Zoning — about “rezoning” · in Brooklyn · including closed"
  );
});

test("describeFilter renders geography watches in resident language", () => {
  assert.equal(
    describeFilter("property", { geographies: ["geography:nta2020:QN0201"] }),
    "Property — in Neighborhood tabulation area QN0201",
  );
  assert.doesNotMatch(
    describeFilter("meetings", { geographies: ["geography:police_precinct:110"] }),
    /geography:/,
  );
});

test("describeFilter falls back to 'all notices' when empty", () => {
  assert.equal(describeFilter("rules", {}), "Rules — all notices");
});

test("describeFilter names a single-mandate exact-id watch", () => {
  assert.equal(
    describeFilter("mandates", {
      agency_id: "homeless-services",
      agency: "Homeless Services",
      mandate_id: "66056-006",
    }),
    "Mandate 66056-006 for Homeless Services",
  );
  assert.equal(
    describeFilter("obligations", {
      agency_id: "parks-and-recreation",
      agency: "Parks and Recreation",
    }),
    "Parks and Recreation mandates — expected filings",
  );
});

test("describeFilter uses plain-language district and report-mandate labels", () => {
  assert.equal(
    describeFilter("district", { councilDistrict: "33" }),
    "Council District 33 weekly digest",
  );
  assert.equal(
    describeFilter("mandates", {
      agency: "Parks and Recreation",
      deliverable_type: "report",
    }),
    "Parks and Recreation report mandates — expected filings",
  );
});

test("describeFilter: agency + notice type + category + amount ceiling — the multi-field alert case", () => {
  assert.equal(
    describeFilter("money", {
      keywords: ["construction"], agency: "Parks and Recreation", category: "Construction/Construction Services",
      noticeType: "award", minAmount: 1000000, maxAmount: 5000000, months: 3,
    }),
    "Contracts and RFPs — about “construction” · awards only · ≥ $1,000,000 · ≤ $5,000,000 · " +
      "category “Construction/Construction Services” · agency “Parks and Recreation” · due within 3 mo"
  );
});

test("describeFilter names an exact procurement watch", () => {
  assert.equal(
    describeFilter("money", { procurement_id: "procurement:contract:CT101520271400806", noticeType: "award" }),
    "Contracts — exact contract procurement:contract:CT101520271400806",
  );
});

test("describeFilter: noticeType alone (no amount) still renders — closes the old amount-implies-type gap", () => {
  assert.equal(
    describeFilter("money", { noticeType: "solicitation", agency: "Sanitation" }),
    "Contracts and RFPs — open solicitations only · agency “Sanitation”"
  );
});

test("topicless welcome discloses the weekly contracts default and both control links", () => {
  const html = welcomeEmailHtml({
    manageUrl: "https://cityscroll.org/prefs?token=manage",
    unsubscribeUrl: "https://api.cityscroll.org/unsubscribe?token=remove",
    lens: "money",
    filter: {},
    freq: "weekly",
    noTopicDefault: true,
  });
  assert.match(html, /weekly NYC contracts digest/);
  assert.match(html, /solicitations, awards, and other procurement notices/);
  assert.match(html, /prefs\?token=manage/);
  assert.match(html, /unsubscribe\?token=remove/);
  assert.doesNotMatch(html, /confirm/i);
});

test("describeFilter names a typed agency scope carried by the watch", () => {
  assert.match(
    describeFilter("money", {
      agency: "Housing Preservation and Development",
      noticeType: "award",
      entity_refs_all: ["agency:id:housing-preservation-and-development"],
      connection_relation: "published_by_agency",
    }),
    /published by this agency/,
  );
});

test("subCanonical is stable regardless of email case/whitespace", () => {
  const a = subCanonical({ email: " A@B.com ", lens: "money", filter: { minAmount: 1000000 } });
  const b = subCanonical({ email: "a@b.com", lens: "money", filter: { minAmount: 1000000 } });
  assert.equal(a, b);
});
