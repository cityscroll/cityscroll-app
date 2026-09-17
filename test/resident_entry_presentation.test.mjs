import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SITE_SOURCE } from "./helpers/site_source.mjs";
import { withPinnedClock } from "./helpers/test_clock.mjs";
import { click, describeNode, mountDocument } from "./helpers/preview_dom.mjs";
import { buildSearchDocument, renderSearchDocument } from "../site/primary_document_view.mjs";
import {
  browseReturnScopeFromLocation,
  createBrowseReturnContext,
  writeBrowseReturnHistory,
  browseReturnFromHistoryState,
} from "../site/browse_return_context.mjs";
import { searchFrontDoorHref } from "../site/search_front_door_scope.mjs";
import {
  SEARCH_RESULT_FULL_RECORD_CLASS,
  SEARCH_RESULT_INSPECTION_DIALOG_ID,
  SEARCH_RESULT_INSPECTION_READY_ATTRIBUTE,
  SEARCH_RESULT_TITLE_LINK_CLASS,
  bindSearchResultInspection,
  renderSearchResultFullRecordLink,
  renderSearchResultInspectButton,
  searchResultInspectionFacts,
} from "../site/search_result_inspection.mjs";

const require = createRequire(import.meta.url);
const Staffing = require("../site/staffing.js");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const index = SITE_SOURCE;
const i18n = read("site/i18n.js");
const CONTINUITY_HARNESS = "test/browse_return_context.test.mjs";

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `missing ${startMarker}`);
  const end = endMarker ? source.indexOf(endMarker, start) : source.length;
  assert.ok(end > start, `missing end after ${startMarker}`);
  return source.slice(start, end);
}

test("homepage default English copy avoids civic-object terminology", () => {
  const masthead = sliceBetween(index, 'class="nameplate"', 'id="browse-child-nav"');
  assert.doesNotMatch(masthead, /civic object/i);
  assert.match(masthead, /What's happening in your city\?/);
  assert.match(masthead, /Explore local decisions, public spending, and published chances to take part\./);
  assert.match(masthead, /Results stay grouped by record type\./);
  assert.match(i18n, /topic_search_intro:\s*"Search public records by topic, place, or agency\. Results stay grouped by record type\."/);
  assert.match(i18n, /topic_search_results_aria:\s*"Search results by record type"/);
  assert.doesNotMatch(i18n, /topic_search_intro:[^,\n]*civic object/i);
  assert.doesNotMatch(i18n, /site_tagline:[^,\n]*Subscribe to NYC contracts/i);
});

test("one search task precedes the specialist contracts signup", () => {
  const search = index.indexOf('data-home-topic-entry');
  const contractsCta = index.indexOf('id="homeCta"');
  const moneyIntro = index.indexOf('id="money-domain-intro"');
  assert.ok(search >= 0 && contractsCta > search, "search entry precedes the contracts signup");
  assert.ok(moneyIntro >= 0 && contractsCta > moneyIntro, "signup lives inside the Contracts intro");
  assert.match(index, /data-cta-context="contracts"/);
  assert.match(index, /name="source" value="contracts-intro"/);
  const homePaint = sliceBetween(index, "<header", 'id="tab-money"');
  assert.doesNotMatch(homePaint, /id="homeCta"/);
  assert.doesNotMatch(homePaint, /home_cta_prompt|Get weekly updates/);
  assert.doesNotMatch(homePaint, /home-topic-kicker/);
});

test("category destinations and Following remain labeled working links", () => {
  assert.match(index, /href="\/browse\/contracts\/"[^>]*data-tab="money"/);
  assert.match(index, /href="\/browse\/people\/"[^>]*data-tab="people"/);
  assert.match(index, /href="\/browse\/zoning\/"[^>]*data-tab="land"/);
  assert.match(index, /href="\/browse\/rules\/"[^>]*data-tab="rules"/);
  assert.match(index, /href="\/browse\/meetings\/"[^>]*data-tab="meetings"/);
  assert.match(index, /href="\/browse\/exams\/"[^>]*data-tab="exams"/);
  assert.match(index, /href="\/following\/"/);
  assert.match(index, /href="\/following\/\?onboarding=1"[^>]*id="homeCtaTopics"/);
  assert.match(index, /data-i18n="browse_facet_label">Browse by type</);
  assert.match(index, /aria-label="Browse by type"/);
  assert.doesNotMatch(index, />Civic objects</);
});

test("A4: participation claims follow to open opportunities and do not treat closed records as open actions", async () => {
  assert.match(index, /published chances to take part/);
  assert.match(index, /href="\/guide\/"/);
  assert.match(index, /href="\/browse\/exams\/"/);
  assert.doesNotMatch(index, /Bid now|Apply before it closes|Open for bidding today/i);

  const guideHome = read("site/guide/index.html");
  assert.match(guideHome, /href="\/guide\/how-to\/find-and-narrow-records\/"/);
  assert.match(guideHome, /href="\/guide\/understand\/dates-and-missing-information\/"/);

  const honestyArticle = read("site/guide/understand/dates-and-missing-information/index.html");
  assert.match(honestyArticle, /A closed window is still a real record/);
  assert.match(honestyArticle, /What it is not is a current invitation/);

  const practiceArticle = read("site/guide/how-to/find-and-narrow-records/index.html");
  assert.match(practiceArticle, /href="\/exams\/7016\/"/);
  assert.match(practiceArticle, /<strong>closed<\/strong> application window/);
  assert.match(practiceArticle, /href="\/browse\/exams\/"/);
  assert.match(practiceArticle, /check an open window/);

  const artifact = JSON.parse(read("site/data/staffing_exams.json"));
  const today = artifact.open_window_as_of;
  assert.match(String(today || ""), /^\d{4}-\d{2}-\d{2}/);
  const openExam = artifact.exams.find((exam) => exam.exam_number === "7006");
  const closedExam = artifact.exams.find((exam) => exam.exam_number === "7016");
  assert.ok(openExam, "open opportunity fixture 7006 must exist");
  assert.ok(closedExam, "closed practice fixture 7016 must exist");

  await withPinnedClock(`${String(today).slice(0, 10)}T12:00:00.000Z`, () => {
    assert.equal(Staffing.statusFor(openExam, today), "open", "7006 must be an open opportunity on the artifact clock");
    assert.equal(Staffing.statusFor(closedExam, today), "closed", "7016 must stay a closed record on the artifact clock");
    assert.ok(openExam.application_end >= today);
    assert.ok(closedExam.application_end < today);
  });

  const examsApp = read("site/app/exams.mjs");
  assert.match(
    examsApp,
    /kinetic_actions:status==="open"\s*\?/,
    "Apply actions must gate on an open window, not on closed records",
  );
  assert.match(examsApp, /career_closed_on/);
  assert.match(i18n, /guide_text_9386c2d8615b931a: "What it is not is a current invitation/);
});

test("A5: continuity harness covers homepage search entry inspect→dismiss→open→Back→continue", () => {
  assert.match(
    index,
    /data-home-topic-entry[\s\S]*?<form class="home-topic-form" method="get" action="\/search\/">/,
    "revised homepage entry must submit to /search/",
  );

  const continuityHarness = read(CONTINUITY_HARNESS);
  assert.match(
    continuityHarness,
    /citizen-entry: revised homepage search entry keeps \/search\/ scope/,
    `continuity harness ${CONTINUITY_HARNESS} must name the revised homepage search entry`,
  );
  assert.match(continuityHarness, /data-home-topic-entry/);
  assert.match(continuityHarness, /home-topic-form.*action=.*\/search\//s);

  const searchLocation = {
    pathname: "/search",
    search: "?q=shelter",
    hash: "",
    href: "https://cityscroll.org/search/?q=shelter",
  };
  assert.equal(browseReturnScopeFromLocation(searchLocation), "/search?q=shelter");
  const frontDoor = searchFrontDoorHref("all", new URLSearchParams("q=shelter"));
  assert.match(frontDoor, /^\/search\/\?/);
  assert.match(frontDoor, /q=shelter/);

  const shelterRecord = Object.freeze({
    object_ref: "procurement:07122P0012063",
    source_observation_refs: ["notice:20260818019"],
  });
  const shelterView = Object.freeze({
    href: "/procurements/procurement%3A07122P0012063",
    title: "SHELTER FACILITIES FOR HOMELESS SINGLE ADULTS",
    summary: "Procurement for shelter facilities serving homeless single adults.",
    entity_type: "procurement",
    entity_type_label: "Procurement",
    lens: "notices",
    lens_label: "Published records",
    lifecycle: Object.freeze({ state: "unknown", label: null, group: "other" }),
    evidence: Object.freeze({
      field: "title",
      reason: "Matched title",
      value: "shelter",
    }),
  });
  const facts = searchResultInspectionFacts(shelterRecord, shelterView);
  assert.ok(facts);
  const resultHtml = `<article class="topic-search-result" data-search-result>` +
    `<p class="topic-search-result-title">` +
    `<a class="${SEARCH_RESULT_TITLE_LINK_CLASS}" href="${facts.href}">${facts.title}</a>` +
    renderSearchResultInspectButton(facts) +
    `</p>` +
    renderSearchResultFullRecordLink(facts) +
    `</article>`;
  const { doc, container } = mountDocument(
    `<div data-search-document data-browse-return-heading="Search results"><div class="topic-search-results">${resultHtml}</div></div>`,
    { containerClass: "search-host" },
  );
  const controller = bindSearchResultInspection(container);
  assert.ok(controller);
  assert.ok(container.hasAttribute(SEARCH_RESULT_INSPECTION_READY_ATTRIBUTE));
  const dialog = doc.getElementById(SEARCH_RESULT_INSPECTION_DIALOG_ID);
  const inspect = [...container.querySelectorAll("[data-search-result-inspection-uid]")]
    .find((node) => node.getAttribute("data-search-result-inspection-uid") === facts.uid);
  const fullRecord = [...container.querySelectorAll(`.${SEARCH_RESULT_FULL_RECORD_CLASS}`)]
    .find((node) => node.getAttribute("data-browse-return-uid") === facts.uid);
  assert.ok(inspect, "search entry results expose a title-sized inspect control");
  assert.ok(fullRecord, "search entry results expose an explicit full-record link");

  click(inspect);
  assert.equal(dialog.open, true, "inspect opens without leaving /search/");
  click(dialog.querySelector("[data-search-result-inspection-close]"));
  assert.equal(dialog.open, false, "dismiss closes the inspection");
  assert.equal(
    describeNode(doc.activeElement),
    describeNode(inspect),
    "dismiss returns focus so the reader can continue from the same search position",
  );

  const history = {
    state: null,
    replaceState(next) { this.state = next; },
  };
  const now = 1_700_000_000_000;
  const remembered = createBrowseReturnContext({
    uid: facts.uid,
    href: fullRecord.getAttribute("href"),
    invoker: "preview",
    scope: browseReturnScopeFromLocation(searchLocation),
  }, now);
  assert.ok(remembered);
  assert.equal(writeBrowseReturnHistory(history, remembered, searchLocation), true);
  assert.equal(browseReturnFromHistoryState(history.state).uid, facts.uid);
  assert.equal(browseReturnFromHistoryState(history.state).scope, "/search?q=shelter");

  click(fullRecord);
  assert.equal(
    fullRecord.getAttribute("href"),
    "/procurements/procurement%3A07122P0012063",
    "open keeps the grounded full-record destination",
  );
  assert.equal(
    browseReturnScopeFromLocation(searchLocation),
    "/search?q=shelter",
    "Back returns to the homepage search entry's /search/ scope",
  );

  click(inspect);
  assert.equal(dialog.open, true, "continue can inspect again after Back");
  assert.match(dialog.textContent, /SHELTER FACILITIES FOR HOMELESS SINGLE ADULTS/);
});

test("search document keeps citizen wording and a Following handoff without the weekly email form", () => {
  const rendered = renderSearchDocument();
  assert.match(rendered, /What's happening in your city\?/);
  assert.match(rendered, /Results stay grouped by record type\./);
  assert.match(rendered, /aria-label="Search results by record type"/);
  assert.doesNotMatch(rendered, /civic object/i);

  const search = buildSearchDocument(index);
  assert.match(search, /id="homeCtaPrompt" data-i18n="browse_cta_prompt">Want email updates on this\?</);
  assert.match(search, /href="\/following\/\?onboarding=1"[^>]*id="homeCtaTopics"/);
  assert.doesNotMatch(search, /id="homeCtaForm"|id="homeCtaEmail"|id="homeCtaMsg"/);
  assert.doesNotMatch(search, /data-cta-context="contracts"/);
  // Contracts intro no longer carries the signup once Search relocates the handoff.
  const money = search.match(/id="money-domain-intro"[\s\S]*?<\/div>\s*<div class="lens-toolbar/)?.[0] || "";
  assert.doesNotMatch(money, /id="homeCta"/);
});

test("English catalog ships the citizen-entry keys", () => {
  for (const key of [
    "site_tagline",
    "topic_search_heading",
    "topic_search_intro",
    "topic_search_query_label",
    "browse_facet_label",
    "topic_search_results_aria",
    "home_cta_prompt",
    "home_cta_topics",
  ]) {
    assert.match(i18n, new RegExp(`${key}\\s*:`));
  }
});

test("A6: translated citizen-entry layout asserts Spanish lang and distinct catalog copy", () => {
  const es = read("site/i18n/lang/es.js");
  const harness = read("test/functional/citizen_entry_case.py");
  const manifest = JSON.parse(read("docs/evidence/citizen-entry/capture-manifest.json"));

  assert.match(es, /topic_search_heading:\s*"¿Qué está pasando en tu ciudad\?"/);
  assert.match(es, /browse_facet_label:\s*"Explorar por tipo"/);
  assert.match(es, /site_tagline:\s*"Explore decisiones locales, gasto público y oportunidades publicadas para participar\."/);
  assert.match(i18n, /topic_search_heading:\s*"What's happening in your city\?"/);
  assert.notEqual(
    es.match(/topic_search_heading:\s*"([^"]+)"/)?.[1],
    i18n.match(/topic_search_heading:\s*"([^"]+)"/)?.[1],
    "Spanish search heading must differ from English"
  );

  assert.match(harness, /document\.documentElement\.lang === 'es'/);
  assert.match(harness, /assert lang == "es"/);
  assert.match(harness, /Explorar por tipo/);
  assert.match(harness, /pasando en tu ciudad/);
  assert.match(harness, /oportunidades publicadas/);
  assert.doesNotMatch(
    harness,
    /Either the translated catalog applied, or English fallback remains coherent/
  );

  const translated = (manifest.captures || []).filter((entry) => entry.case === "citizen-entry-translated");
  assert.equal(translated.length, 2, "translated captures retained for both viewports");
  for (const entry of translated) {
    assert.equal(entry.lang, "es", "retained translated capture must record lang=es");
    assert.equal(entry.passed, true);
  }
  const englishCases = new Set([
    "citizen-entry-no-javascript",
    "citizen-entry-failed-enhancement",
    "citizen-entry-successful-enhancement",
  ]);
  const englishHashes = new Set(
    (manifest.captures || [])
      .filter((entry) => englishCases.has(entry.case))
      .map((entry) => entry.render_sha256)
  );
  const translatedHashes = new Set(translated.map((entry) => entry.render_sha256));
  assert.ok(englishHashes.size >= 1, "English captures must retain at least one body hash");
  assert.ok(translatedHashes.size >= 1, "translated captures must retain at least one body hash");
  for (const hash of translatedHashes) {
    assert.ok(!englishHashes.has(hash), "translated body hash must differ from English captures");
  }
});
