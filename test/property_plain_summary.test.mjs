import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { cleanNoticeText } from "../site/text_clean.mjs";
import {
  buildPropertyPlainSummary,
  deShoutPropertyTitle,
  ensurePropertyCardPlainSummary,
  propertyCardPlainSummary,
  propertyCardTitleDisclosureHTML,
  propertyPlainSummaryHTML,
  propertyPlainSummarySurface,
} from "../site/property_plain_summary.mjs";

const fixture = JSON.parse(await readFile(new URL("./fixtures/property_plain_summary/real_notices.json", import.meta.url)));
const fallbackVerdicts = JSON.parse(await readFile(new URL("../docs/evidence/property-a11y-template-fallbacks/verdicts.json", import.meta.url)));
const expectedLead = new Map([
  ["pending-destruction", "The listed products were seized and may be destroyed."],
  ["unclaimed-property", "The Property Clerk has listed items with no one claiming ownership."],
  ["forest-timber-sale", "This is a forest management project."],
  ["lease-auction", "This notice is about a public auction for a property lease."],
  ["surplus-auction", "This is a vehicle auction."],
  ["direct-property-sale", "This notice is about a public sale of real property."],
  ["medallion-result", "A taxi medallion auction was held. This notice lists the winning bidders."],
  ["udaap", "This notice is about an Urban Development Action Area Project (UDAAP)."],
  ["acquisition", "This notice is about getting a property right."],
  ["disposition-hearing", "This notice is about a public hearing on a property matter."],
  ["public-hearing-section-pointer", "These notices are in the Public Hearing section."],
]);

function receiptSource(row, receipt) {
  const source = String(row[receipt.field] || "");
  return receipt.normalization === "clean_notice_text" ? cleanNoticeText(source) : source;
}

function assertReceipt(row, receipt) {
  assert.ok(receipt.field, "receipt names a source field");
  assert.ok(Number.isInteger(receipt.start) && receipt.start >= 0, "receipt has a start offset");
  assert.ok(Number.isInteger(receipt.end) && receipt.end > receipt.start, "receipt has an end offset");
  const source = receiptSource(row, receipt);
  assert.equal(source.slice(receipt.start, receipt.end), receipt.text);
}

test("every census pattern has a deterministic real-notice template with exact source receipts", () => {
  for (const item of fixture.cases.filter((item) => item.templated !== false)) {
    const summary = buildPropertyPlainSummary(item.row, { today: "2026-08-04" });
    assert.equal(summary.templated, true, item.id);
    assert.equal(summary.pattern, item.pattern, item.id);
    assert.equal(summary.facts[0].text, expectedLead.get(item.id), item.id);
    assert.equal(summary.text, summary.facts.map((fact) => fact.text).join(" "), item.id);
    assert.equal(propertyPlainSummarySurface(summary), [
      summary.text,
      ...summary.definitions.map((definition) => definition.text),
    ].join(" "), item.id);
    const card = propertyCardPlainSummary(summary);
    assert.ok(card, `${item.id}: templated notice has card copy`);
    assert.equal((card.text.match(/[.!?](?:\s|$)/g) || []).length, 1, `${item.id}: card copy is one sentence`);
    assert.ok(card.sources.length > 0, `${item.id}: card copy is source-backed`);
    card.sources.forEach((receipt) => assertReceipt(item.row, receipt));
    for (const fact of [...summary.facts, ...summary.definitions]) {
      assert.ok(fact.sources.length > 0, `${item.id}: ${fact.kind} is source-backed`);
      assert.ok(["source_template", "typed_event", "reader_action", "census_plain_equivalent"].includes(fact.basis));
      fact.sources.forEach((receipt) => assertReceipt(item.row, receipt));
      assert.ok(fact.sources.every((receipt) => ["short_title", "additional_description_1", "event_date"].includes(receipt.field)));
    }
  }
});

test("golden summaries use only extracted actions and typed event dates", () => {
  const byId = new Map(fixture.cases.map((item) => [item.id, item.row]));
  const forest = buildPropertyPlainSummary(byId.get("forest-timber-sale"), { today: "2019-04-16" });
  assert.match(forest.text, /Bids are due by December 6, 2023 at 4:00 PM\./);
  assert.match(forest.text, /You can send a proposal\./);
  assert.match(forest.text, /You can go to a public showing\./);

  const hearing = buildPropertyPlainSummary(byId.get("udaap"), { today: "2017-05-19" });
  assert.match(hearing.text, /The hearing is on June 21, 2017 at 10:00 AM\./);
  assert.match(hearing.text, /You can attend and speak at the hearing\./);
  assert.match(hearing.text, /You can ask for a sign language interpreter\./);
  assert.ok(hearing.definitions.some((item) => /hearing may start late/i.test(item.text)));
});

test("card summaries compose one receipted what-plus-key-event sentence without re-extraction", () => {
  const item = fixture.cases.find((entry) => entry.id === "forest-timber-sale");
  const summary = buildPropertyPlainSummary(item.row, { today: "2019-04-16" });
  const card = propertyCardPlainSummary(summary);

  assert.equal(
    card.text,
    "This is a forest project; bids due December 6, 2023 at 4:00 PM.",
  );
  assert.equal(card.key_fact_kind, "event_bid_deadline");
  assert.equal(card.event_kind, "bid_deadline");
  assert.deepEqual(card.fact_kinds, ["what", "event_bid_deadline"]);
  assert.ok(card.sources.length > 0);
  card.sources.forEach((receipt) => assertReceipt(item.row, receipt));
  assert.equal((card.text.match(/[.!?](?:\s|$)/g) || []).length, 1, "the card variant is one sentence");
});

test("card summaries use a receipted action when no timed event exists and preserve honest fallback", () => {
  const unclaimed = fixture.cases.find((entry) => entry.id === "unclaimed-property");
  const summary = buildPropertyPlainSummary(unclaimed.row, { today: "2026-08-04" });
  const card = propertyCardPlainSummary(summary);
  assert.match(card.text, /^No one has claimed these items; you can ask/);
  assert.equal(card.key_fact_kind, "action_inquire_claim");
  assert.equal(card.action_kind, "inquire_claim");

  const fallback = fallbackVerdicts.verdicts.find((entry) => entry.verdict === "permanent_honest_fallback");
  assert.equal(propertyCardPlainSummary(buildPropertyPlainSummary({
    request_id: fallback.request_id,
    section_name: "Property Disposition",
    ...fallback.row,
  })), null);
});

test("card variant caches the landed detail facts and preserves the exact legal title", () => {
  const row = structuredClone(fixture.cases.find((entry) => entry.id === "forest-timber-sale").row);
  const card = ensurePropertyCardPlainSummary(row, { today: "2019-04-16" });
  assert.equal(card, row.property_card_plain_summary);
  assert.equal(card, ensurePropertyCardPlainSummary(row, { today: "2099-01-01" }));
  assert.ok(row.property_plain_summary?.templated);

  const title = "NYC DCAS <RFP>";
  const html = propertyCardTitleDisclosureHTML({
    display_title_html: "NYC DCAS &lt;RFP&gt;",
    original_title: title,
  });
  assert.match(html, /<summary[^>]*>Legal title<\/summary>/);
  assert.match(html, /<q[^>]*>NYC DCAS &lt;RFP&gt;<\/q>/);
});

test("legal-title de-shouting preserves mixed case, proper names, acronyms, and roman numerals", () => {
  assert.equal(
    deShoutPropertyTitle("OFFICIAL NOTICE FROM NYC DCAS: WNYC RFP FOR EAST NEW YORK — PHASE II"),
    "Official notice from NYC DCAS: WNYC RFP for East New York — phase II",
  );
  assert.equal(
    deShoutPropertyTitle("CARPENTERS EDDY WEST FOREST MANAGEMENT PROJECT #5202 NOTICE OF PROJECT AVAILABILITY"),
    "Carpenters Eddy West forest management project #5202 notice of project availability",
  );
  assert.equal(
    deShoutPropertyTitle("Notice of Public Auction on 10/28/15"),
    "Notice of Public Auction on 10/28/15",
    "already mixed-case source titles are not rewritten",
  );
  assert.equal(
    deShoutPropertyTitle("SALE IN KENT, NY. TBX907B WILL BE OFFERED"),
    "Sale in Kent, NY. TBX907B will be offered",
    "state abbreviations, source identifiers, and sentence boundaries survive the transform",
  );
});

test("a recurring section-pointer notice gets its narrow source-backed template", () => {
  const item = fixture.cases.find((entry) => entry.id === "public-hearing-section-pointer");
  const summary = buildPropertyPlainSummary(item.row, { today: "2026-08-04" });
  assert.equal(summary.pattern, "disposition");
  assert.equal(summary.templated, true);
  assert.equal(summary.facts[0].text, "These notices are in the Public Hearing section.");
  summary.facts[0].sources.forEach((receipt) => assertReceipt(item.row, receipt));
});

test("all nine landed fallbacks have an evidence-backed recurring-template or permanent-fallback verdict", () => {
  assert.equal(fallbackVerdicts.verdicts.length, 9);
  assert.deepEqual(
    Object.fromEntries([...new Set(fallbackVerdicts.verdicts.map((item) => item.cohort))].map((cohort) => [
      cohort,
      fallbackVerdicts.verdicts.filter((item) => item.cohort === cohort).length,
    ])),
    {
      hpd_public_hearing_section_pointer: 6,
      real_property_parcel_public_auction: 2,
      unique_future_interest_deed_amendment: 1,
    },
  );

  for (const item of fallbackVerdicts.verdicts) {
    const row = { request_id: item.request_id, section_name: "Property Disposition", ...item.row };
    const summary = buildPropertyPlainSummary(row, { today: "2026-08-04" });
    assert.equal(summary.pattern, item.expected_pattern, item.request_id);
    if (item.verdict === "recurring_template") {
      assert.equal(summary.templated, true, item.request_id);
      assert.equal(summary.facts[0].text, item.expected_lead, item.request_id);
      summary.facts[0].sources.forEach((receipt) => assertReceipt(row, receipt));
    } else {
      assert.equal(item.verdict, "permanent_honest_fallback", item.request_id);
      assert.equal(summary.templated, false, item.request_id);
      assert.equal(summary.fallback_reason, "no_reader_visible_pattern_anchor", item.request_id);
      assert.ok(item.rationale.length > 80, `${item.request_id}: the permanent fallback has a recorded rationale`);
    }
  }
});

test("hidden-field pattern words cannot force a template", () => {
  const row = {
    section_name: "Property Disposition",
    short_title: "General property notice",
    additional_description_1: "Read the official notice for its exact terms.",
    additional_description_2: "Forest Management Project timber sale",
  };
  const summary = buildPropertyPlainSummary(row);
  assert.equal(summary.pattern, "forest_timber_sale");
  assert.equal(summary.templated, false);
  assert.equal(summary.text, row.additional_description_1);
});

test("summary markup leads with plain text, exposes receipts, and leaves fallback to the official disclosure", () => {
  const item = fixture.cases.find((entry) => entry.id === "unclaimed-property");
  const summary = buildPropertyPlainSummary(item.row);
  const html = propertyPlainSummaryHTML(summary, { escape: (value) => String(value) });
  assert.match(html, /data-property-plain-summary="1"/);
  assert.match(html, /What this means/);
  assert.match(html, /See the source wording/);
  assert.match(html, /Official notice text/);
  assert.ok(html.indexOf(summary.text) < html.indexOf("See the source wording"));
});

test("notice detail mounts the summary before context, actions, and original text", async () => {
  const [routing, property] = await Promise.all([
    readFile(new URL("../site/app/routing.mjs", import.meta.url), "utf8"),
    readFile(new URL("../site/app/property.mjs", import.meta.url), "utf8"),
  ]);
  const showNotice = routing.slice(routing.indexOf("async function showNotice"), routing.indexOf("// Publish live bindings", routing.indexOf("async function showNotice")));
  assert.match(showNotice, /id="nplain"/);
  assert.match(showNotice, /loadPropertyPlainSummary\(r, \$\("#nplain"\)\)/);
  assert.ok(showNotice.indexOf('id="nplain"') < showNotice.indexOf('id="ncontext"'));
  assert.ok(showNotice.indexOf('id="nplain"') < showNotice.indexOf('class="fulltext"'));
  assert.match(property, /import\("\.\.\/property_plain_summary\.mjs"\)/);
  assert.match(property, /globalThis\.loadPropertyPlainSummary = loadPropertyPlainSummary/);
});
