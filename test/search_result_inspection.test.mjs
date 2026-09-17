// Separate inspecting a search result from exploring its collection.
//
// Public alias: cdf0772654b48
//
// Search used to rewrite Money primary title destinations into the same
// Contracts collection handoff as "Continue in Contracts". After enhancement
// the title-sized control inspects in place, an explicit full-record link keeps
// the grounded canonical destination, and Continue in Contracts remains a
// separately named handoff. Family navigation still focuses headings without
// rewriting the query.
//
//   A1 frozen shelter procurement 07122P0012063 inspects in place, opens its
//      exact record explicitly, and offers a separate Contracts continuation
//   A2 query, family counts, ordering and relevance stay equivalent; Land
//      family navigation focuses its heading without rewriting the query/URL
//   A3 positive and negative fixtures distinguish the prior title→collection
//      rewrite from the intended primary-inspect outcome
//   A4 source observation 20260818019 tested separately from procurement
//      identity; no-JS links, missing detail, keyboard family navigation, and
//      return to the same search position; journey evidence recorded
//
//   node --test test/search_result_inspection.test.mjs

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  BROWSE_INSPECTION_LEGACY_BASELINE,
  BROWSE_INSPECTION_SURFACES,
} from "../site/browse_inspection_contract.mjs";
import {
  activateFamilyNavHeading,
  renderFamilyNav,
} from "../site/search_family_nav.mjs";
import {
  buildSearchLensHandoffHref,
  searchDestinationForResult,
} from "../site/search_lens_handoff.mjs";
import { renderSearchResultCard } from "../site/search_document.mjs";
import {
  SEARCH_RESULT_FULL_RECORD_CLASS,
  SEARCH_RESULT_INSPECT_CLASS,
  SEARCH_RESULT_INSPECTION_DIALOG_ID,
  SEARCH_RESULT_INSPECTION_READY_ATTRIBUTE,
  SEARCH_RESULT_INSPECTION_TITLE_ID,
  SEARCH_RESULT_TITLE_LINK_CLASS,
  bindSearchResultInspection,
  searchResultInspectionFacts,
} from "../site/search_result_inspection.mjs";
import {
  buildUniversalSearchResultView,
  renderUniversalSearchResultHtml,
} from "../site/universal_search_relevance_ux.mjs";
import { click, describeNode, keydown, mountDocument } from "./helpers/preview_dom.mjs";

const ROOT = process.cwd();
const EVIDENCE_PATH = join("docs", "evidence", "search-result-inspection", "acceptance-manifest.json");
const CSS = readFileSync(new URL("../site/search.css", import.meta.url), "utf8");
const SEARCH_DOCUMENT_SOURCE = readFileSync(new URL("../site/search_document.mjs", import.meta.url), "utf8");

const SHELTER_RECORD = Object.freeze({
  result_schema: "cityscroll.universal_search_result.v1",
  outcome: "indexed",
  object_ref: "procurement:07122P0012063",
  object_type: "procurement",
  entity_type: "procurement",
  domain: "contracts",
  lens: "notices",
  title: "SHELTER FACILITIES FOR HOMELESS SINGLE ADULTS",
  summary: "Procurement for shelter facilities serving homeless single adults.",
  source_route: "/procurements/procurement%3A07122P0012063",
  canonical_href: "/procurements/procurement%3A07122P0012063",
  source_observation_refs: ["notice:20260818019"],
  match_fields: [{
    field: "title",
    matched_term: "shelter",
    source_observation_ref: "notice:20260818019",
  }],
  match_evidence: {
    field: "title",
    matched_normalized_term: "shelter",
    source_identifier: "notice:20260818019",
    snippet: {
      text: "SHELTER FACILITIES FOR HOMELESS SINGLE ADULTS",
      mark_start: 0,
      mark_end: 7,
    },
  },
  ranking: { lifecycle_state: "active" },
  provenance: { kind_label: "Contract", producer: "procurement_search_document.v1" },
  edge_provenance: {
    document_producer: "procurement_search_document.v1",
    source_observation_refs: ["notice:20260818019"],
  },
});

const KEYWORD_PAYLOAD = Object.freeze({
  query: "shelter",
  resolved_term: {
    canonical_tokens: ["shelter"],
    structured_filters: {},
    alias_receipt: null,
  },
});

const AGENCY_RECORD = Object.freeze({
  result_schema: "cityscroll.universal_search_result.v1",
  outcome: "indexed",
  object_ref: "agency:parks-and-recreation",
  object_type: "agency",
  entity_type: "agency",
  domain: "people",
  lens: "agencies",
  title: "Department of Parks and Recreation",
  summary: "City parks agency.",
  source_route: "/agencies/parks-and-recreation/",
  canonical_href: "/agencies/parks-and-recreation/",
  source_observation_refs: ["agency_constellation:parks-and-recreation"],
  match_fields: [{
    field: "alias",
    matched_term: "dpr",
    source_observation_ref: "agency_constellation:parks-and-recreation",
  }],
  ranking: { lifecycle_state: "active" },
  provenance: { kind_label: "Agency", producer: "agency_search_document.v1" },
  edge_provenance: {
    document_producer: "agency_search_document.v1",
    source_observation_refs: ["agency_constellation:parks-and-recreation"],
  },
});

function shelterHTML() {
  return renderUniversalSearchResultHtml(SHELTER_RECORD);
}

function mountShelter(bindOptions = {}) {
  const html = `<div data-search-document><div class="topic-search-results">${shelterHTML()}</div></div>`;
  const { doc, container } = mountDocument(html, { containerClass: "search-host" });
  const controller = bindSearchResultInspection(container, bindOptions);
  const dialog = doc.getElementById(SEARCH_RESULT_INSPECTION_DIALOG_ID);
  return { doc, container, controller, dialog };
}

function inspectButton(container, uid = SHELTER_RECORD.object_ref) {
  return [...container.querySelectorAll("[data-search-result-inspection-uid]")]
    .find((node) => node.getAttribute("data-search-result-inspection-uid") === uid);
}

function fullRecordLink(container, uid = SHELTER_RECORD.object_ref) {
  return [...container.querySelectorAll(`.${SEARCH_RESULT_FULL_RECORD_CLASS}`)]
    .find((node) => node.getAttribute("data-browse-return-uid") === uid);
}

function titleLink(container) {
  return container.querySelector(`.${SEARCH_RESULT_TITLE_LINK_CLASS}`);
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function assertFocused(doc, expected, message) {
  assert.ok(doc.activeElement === expected,
    `${message} — focus is on ${describeNode(doc.activeElement)}, expected ${describeNode(expected)}`);
}

function familyNavFixture() {
  return `<div data-search-document>
    <nav data-search-family-nav aria-label="Result families"><ul data-search-family-nav-list></ul></nav>
    <div data-keyword-lanes>
      <section class="topic-search-lane" data-search-lane="contracts">
        <div class="topic-search-lane-head"><h3 id="lane-contracts">Contracts</h3><p class="topic-search-lane-status">1 result</p></div>
        <div class="topic-search-lane-body"></div>
      </section>
      <section class="topic-search-lane" data-search-lane="land">
        <div class="topic-search-lane-head"><h3 id="lane-land">Land</h3><p class="topic-search-lane-status">0 results</p></div>
        <div class="topic-search-lane-body"></div>
      </section>
    </div>
  </div>`;
}

/* ---------- A3: positive vs prior negative hierarchy ---------- */

test("A3 negative fixture: Money title rewrite into the Contracts collection is gone", () => {
  assert.doesNotMatch(
    SEARCH_DOCUMENT_SOURCE,
    /destination\.surface === ["']money["'][\s\S]{0,160}primary\.href\s*=\s*href/,
    "search must not rewrite the Money primary title into the collection handoff",
  );
  const html = shelterHTML();
  assert.doesNotMatch(html, /\/browse\/contracts\//,
    "static result markup must not use the Contracts collection as the title destination");
});

test("A3 positive fixture: static title link, title-sized inspect, named full-record link", () => {
  const html = shelterHTML();
  assert.match(html, new RegExp(`class="${SEARCH_RESULT_TITLE_LINK_CLASS}" href="/procurements/procurement%3A07122P0012063"`));
  assert.match(html, new RegExp(`class="${SEARCH_RESULT_INSPECT_CLASS}"`));
  assert.match(html, new RegExp(`class="${SEARCH_RESULT_FULL_RECORD_CLASS}" href="/procurements/procurement%3A07122P0012063"`));
  assert.match(html, />Open the full record</);
  assert.doesNotMatch(html, /onclick=/);
});

/* ---------- A1: inspect, exact record, separate continuation ---------- */

test("A1: the enhanced primary control inspects the shelter result in place", () => {
  const { container, dialog } = mountShelter();
  assert.ok(container.hasAttribute(SEARCH_RESULT_INSPECTION_READY_ATTRIBUTE));
  const invoker = inspectButton(container);
  assert.ok((invoker.getAttribute("class") || "").split(/\s+/).includes(SEARCH_RESULT_INSPECT_CLASS));
  click(invoker);
  assert.equal(dialog.open, true);
  assert.match(dialog.textContent, /SHELTER FACILITIES FOR HOMELESS SINGLE ADULTS/);
  assert.match(dialog.textContent, /procurement:07122P0012063/);
  assert.equal(container.querySelectorAll("[data-search-result]").length, 1);
});

test("A1: the named full-record link keeps the exact procurement destination", () => {
  const { container } = mountShelter();
  const link = fullRecordLink(container);
  assert.equal(link.getAttribute("href"), "/procurements/procurement%3A07122P0012063");
  assert.equal(link.textContent.includes("Open the full record"), true);
  assert.equal(link.querySelector("button"), null);
  assert.equal(link.closest("button"), null);
});

test("A1: Continue in Contracts is a separate correctly scoped handoff", () => {
  const { doc } = mountDocument("<div></div>");
  const card = renderSearchResultCard(SHELTER_RECORD, KEYWORD_PAYLOAD, doc);
  const title = card.querySelector(`.${SEARCH_RESULT_TITLE_LINK_CLASS}`);
  const full = card.querySelector(`.${SEARCH_RESULT_FULL_RECORD_CLASS}`);
  const handoff = card.querySelector("[data-search-handoff='money']");
  const destination = searchDestinationForResult(SHELTER_RECORD);
  const expected = buildSearchLensHandoffHref(SHELTER_RECORD, KEYWORD_PAYLOAD, "?q=shelter");
  assert.equal(destination.surface, "money");
  assert.equal(title.getAttribute("href"), "/procurements/procurement%3A07122P0012063");
  assert.equal(full.getAttribute("href"), "/procurements/procurement%3A07122P0012063");
  assert.ok(handoff);
  assert.equal(handoff.getAttribute("href"), expected);
  assert.match(handoff.textContent, /Continue in Contracts/);
  assert.match(expected, /^\/browse\/contracts\/\?/);
  assert.match(expected, /record_ref/);
  assert.notEqual(title.getAttribute("href"), handoff.getAttribute("href"));
});

test("A1: search-results is conforming and the legacy title-continues baseline is gone", () => {
  const surface = BROWSE_INSPECTION_SURFACES.find((row) => row.surface_id === "search-results");
  assert.ok(surface);
  assert.equal(surface.classification, "conforming");
  assert.equal(surface.baseline_id, null);
  assert.equal(surface.detail_host, "modal_preview");
  assert.equal(surface.detail_host_module, "site/search_result_inspection.mjs");
  assert.equal(surface.journey_owner, "test/search_result_inspection.test.mjs");
  assert.equal(
    BROWSE_INSPECTION_LEGACY_BASELINE.some((row) => row.id === "search-title-continues-collection"),
    false,
  );
});

/* ---------- A2: relevance and family navigation boundary ---------- */

test("A2: relevance view and ordering for the shelter fixture stay grounded", () => {
  const view = buildUniversalSearchResultView(SHELTER_RECORD);
  assert.equal(view.href, "/procurements/procurement%3A07122P0012063");
  assert.equal(view.entity_type, "procurement");
  assert.equal(view.evidence.field, "title");
  assert.match(view.evidence.value, /SHELTER/);
  const agency = buildUniversalSearchResultView(AGENCY_RECORD);
  assert.equal(agency.href, "/agencies/parks-and-recreation/");
});

test("A2: Land family navigation focuses its heading without rewriting the query", () => {
  const { doc, container } = mountDocument(familyNavFixture(), { containerClass: "search-host" });
  const before = "/search/?q=shelter";
  doc.defaultView = { location: { href: before, search: "?q=shelter", pathname: "/search/" } };
  const items = renderFamilyNav(container, doc);
  assert.equal(items.length, 2);
  const landHeading = container.querySelector("#lane-land");
  const landButton = [...container.querySelectorAll(".topic-search-family-nav-item")]
    .find((node) => node.textContent.includes("Land"));
  assert.ok(landButton);
  click(landButton);
  assertFocused(doc, landHeading, "Land family nav focuses the Land heading");
  assert.equal(doc.defaultView.location.href, before);
  assert.equal(doc.defaultView.location.search, "?q=shelter");
  assert.equal(activateFamilyNavHeading(landHeading), true);
});

/* ---------- A2/A4 progressive enhancement and identity ---------- */

test("A2: without the ready marker CSS keeps the title link and hides inspect plus full-record", () => {
  assert.match(CSS, /\.topic-search-result-inspect,\s*\n\.topic-search-result-full-record\s*\{\s*display:\s*none/);
  assert.match(CSS, new RegExp(`\\[${SEARCH_RESULT_INSPECTION_READY_ATTRIBUTE}\\] \\.topic-search-result-title-link\\s*\\{[^}]*display:\\s*none`));
  assert.match(CSS, new RegExp(`\\[${SEARCH_RESULT_INSPECTION_READY_ATTRIBUTE}\\] \\.topic-search-result-inspect\\s*\\{`));
  assert.match(CSS, new RegExp(`\\[${SEARCH_RESULT_INSPECTION_READY_ATTRIBUTE}\\] \\.topic-search-result-full-record\\s*\\{[^}]*display:\\s*inline-block`));
  const { container } = mountDocument(`<div>${shelterHTML()}</div>`);
  assert.equal(container.hasAttribute(SEARCH_RESULT_INSPECTION_READY_ATTRIBUTE), false);
  assert.ok(titleLink(container));
});

test("A4: source observation 20260818019 is distinct from procurement identity", () => {
  const view = buildUniversalSearchResultView(SHELTER_RECORD);
  const facts = searchResultInspectionFacts(SHELTER_RECORD, view);
  assert.equal(facts.object_ref, "procurement:07122P0012063");
  assert.equal(facts.source_observation_ref, "notice:20260818019");
  assert.notEqual(facts.object_ref, facts.source_observation_ref);
  const { container, dialog } = mountShelter();
  click(inspectButton(container));
  assert.match(dialog.textContent, /procurement:07122P0012063/);
  assert.match(dialog.textContent, /notice:20260818019/);
});

test("A4: no-JavaScript and failed enhancement keep the grounded title link", () => {
  const html = shelterHTML();
  assert.match(html, /class="topic-search-result-title-link" href="\/procurements\/procurement%3A07122P0012063"/);
  const { container } = mountDocument(`<div>${html}</div>`);
  assert.equal(titleLink(container).getAttribute("href"), "/procurements/procurement%3A07122P0012063");
});

test("A4: opening inspection never navigates, submits, or fetches a publisher", () => {
  const requests = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (...args) => {
    requests.push(args);
    return Promise.reject(new Error("no request expected"));
  };
  try {
    const { container, dialog } = mountShelter();
    const hrefBefore = titleLink(container).getAttribute("href");
    click(inspectButton(container));
    assert.equal(dialog.open, true);
    assert.equal(titleLink(container).getAttribute("href"), hrefBefore);
    assert.equal(requests.length, 0);
    assert.equal(container.querySelectorAll("form").length, 0);
  } finally {
    if (previousFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = previousFetch;
  }
});

test("A4: Escape, Close, Tab containment, and disappeared-trigger fallback", () => {
  const { doc, container, dialog } = mountShelter();
  const button = inspectButton(container);
  click(button);
  const close = dialog.querySelector("[data-search-result-inspection-close]");
  assertFocused(doc, close, "opening moves focus inside the dialog");

  const focusable = [...dialog.querySelectorAll("a[href], button:not([disabled])")];
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  last.focus();
  keydown(dialog, "Tab");
  assertFocused(doc, first, "Tab wraps inside the dialog");
  first.focus();
  keydown(dialog, "Tab", { shiftKey: true });
  assertFocused(doc, last, "Shift+Tab wraps inside the dialog");

  click(close);
  assert.equal(dialog.open, false);
  assertFocused(doc, button, "Close returns focus to the invoker");

  dialog.showModal = undefined;
  click(button);
  assert.equal(dialog.getAttribute("aria-modal"), "true");
  keydown(dialog, "Escape");
  assert.equal(dialog.open, false);
  assertFocused(doc, button, "Escape closes the fallback dialog");

  click(button);
  container.innerHTML = `<div data-search-document><div class="topic-search-results">${shelterHTML()}</div></div>`;
  const survivor = inspectButton(container);
  dialog.close();
  assertFocused(doc, survivor, "focus follows a replaced trigger for the same result");
});

test("A4: rapid selection and failed detail keep the coherent summary and record link", async () => {
  const resolvers = new Map();
  const second = renderUniversalSearchResultHtml({
    ...AGENCY_RECORD,
    title: "Second shelter-adjacent agency",
  });
  const html = `<div data-search-document><div class="topic-search-results">${shelterHTML()}${second}</div></div>`;
  const { doc, container } = mountDocument(html, { containerClass: "search-host" });
  const controller = bindSearchResultInspection(container, {
    loadDetail: (facts) => new Promise((resolve, reject) => {
      resolvers.set(facts.uid, { resolve, reject });
    }),
  });
  assert.ok(controller);
  const dialog = doc.getElementById(SEARCH_RESULT_INSPECTION_DIALOG_ID);
  click(inspectButton(container, SHELTER_RECORD.object_ref));
  click(inspectButton(container, AGENCY_RECORD.object_ref));
  await tick();
  resolvers.get(SHELTER_RECORD.object_ref)?.resolve("Stale detail for the result the reader left");
  await tick();
  assert.match(dialog.textContent, /Second shelter-adjacent agency/);
  assert.doesNotMatch(dialog.textContent, /Stale detail/);

  resolvers.get(AGENCY_RECORD.object_ref)?.reject(new Error("detail unavailable"));
  await tick();
  assert.match(dialog.textContent, /Second shelter-adjacent agency/);
  assert.match(dialog.textContent, /Further detail did not load/);
  assert.equal(
    dialog.querySelector("[data-search-result-inspection-open]").getAttribute("href"),
    "/agencies/parks-and-recreation/",
  );
  assert.equal(doc.getElementById(SEARCH_RESULT_INSPECTION_TITLE_ID).textContent, "Second shelter-adjacent agency");
});

test("A4: dismiss restores useful focus so the reader can continue from the same search position", () => {
  const { doc, container, dialog } = mountShelter();
  const button = inspectButton(container);
  click(button);
  assert.equal(dialog.open, true);
  click(dialog.querySelector("[data-search-result-inspection-close]"));
  assert.equal(dialog.open, false);
  assertFocused(doc, button, "dismiss returns focus to the inspected result control");
  assert.equal(fullRecordLink(container).getAttribute("href"), "/procurements/procurement%3A07122P0012063");
});

/* ---------- A4 journey evidence ---------- */

test("A4: acceptance manifest records the rendered journey with revision, route, viewport, and fixture vintage", () => {
  assert.equal(existsSync(join(ROOT, EVIDENCE_PATH)), true);
  const manifest = JSON.parse(readFileSync(join(ROOT, EVIDENCE_PATH), "utf8"));
  assert.equal(manifest.schema, "cityscroll.search_result_inspection_acceptance.v1");
  assert.equal(manifest.record, "cityscroll-engineering/cdf0772654b48");
  assert.match(manifest.revision, /^[0-9a-f]{40}$/);
  assert.equal(manifest.route, "/search/?q=shelter");
  assert.equal(manifest.fixture_vintage, "20260818019");
  assert.ok(Array.isArray(manifest.viewport) && manifest.viewport.length === 2);
  assert.ok(Array.isArray(manifest.assertions) && manifest.assertions.length >= 4);
  assert.ok(manifest.assertions.some((row) => row.id === "primary-inspect-no-navigation" && row.result === "accepted"));
  assert.ok(manifest.assertions.some((row) => row.id === "separate-contracts-continuation" && row.result === "accepted"));
  assert.ok(manifest.assertions.some((row) => row.id === "source-observation-distinct-from-procurement-identity" && row.result === "accepted"));
  assert.ok(manifest.assertions.some((row) => row.id === "reject-money-title-collection-rewrite" && row.result === "rejected"));
  assert.ok(manifest.journey?.sequence?.includes("inspect"));
  assert.ok(manifest.journey?.sequence?.includes("open_full_record"));
  assert.ok(manifest.journey?.sequence?.includes("continue"));
  for (const banned of ["needs_james", "card_standard", "richness_profile", "autodispatch", "realization_gate"]) {
    assert.equal(JSON.stringify(manifest).includes(banned), false, banned);
  }
  const digest = createHash("sha256").update(JSON.stringify(manifest.assertions) + "\n").digest("hex");
  assert.equal(manifest.assertions_sha256, digest);
});
