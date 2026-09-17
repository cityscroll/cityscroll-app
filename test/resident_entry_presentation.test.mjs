import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SITE_SOURCE } from "./helpers/site_source.mjs";
import { buildSearchDocument, renderSearchDocument } from "../site/primary_document_view.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const index = SITE_SOURCE;
const i18n = read("site/i18n.js");

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

test("participation language stays honest and points at real destinations", () => {
  assert.match(index, /href="\/guide\/"/);
  assert.match(index, /published chances to take part/);
  assert.doesNotMatch(index, /Bid now|Apply before it closes|Open for bidding today/i);
  // Closed-window honesty remains owned by guide/exam surfaces, not invented here.
  assert.match(i18n, /guide_text_9386c2d8615b931a: "What it is not is a current invitation/);
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
