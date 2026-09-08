// The public Stats page as a reader experience: what it offers, in what order, in which
// languages, and with which real records behind its worked examples.
//
// The page already reported served coverage and a narrow search-usage summary. Those
// measurements are contracted elsewhere (test/served_coverage_snapshot.test.mjs and
// worker/test/search_usage.test.mjs). This file contracts the parts a reader meets: the
// section order, the three worked paths and the routes behind them, and the rule that no
// first-class string on the page is English-only.

import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import { landProjectPath } from "../site/land_project_route.mjs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const PAGE = read("../site/stats.html");
const DEMO_LINKS = JSON.parse(read("../site/demo/demo-links.json"));
const COVERAGE = JSON.parse(read("../site/data/served_coverage_snapshot.json"));
const SHIPPING_LANGS = ["es", "zh-Hans", "ru", "bn", "ht", "ko", "fr", "pl", "ar", "ur"];

function demoUrl(id) {
  const entry = DEMO_LINKS.entries.find((candidate) => candidate.id === id);
  assert.ok(entry, `demo manifest has no entry ${id}`);
  return entry.url;
}

/** Byte offset of a section heading, so order is asserted against the document itself. */
function headingAt(key) {
  const index = PAGE.indexOf(`data-i18n="${key}"`);
  assert.notEqual(index, -1, `the page carries no heading for ${key}`);
  return index;
}

test("the page reads as one sequence: what is here, how it is used, what it is for, what it means", () => {
  const order = [
    "stats_h_explore",
    "stats_h_recent_use",
    "stats_h_connections",
    "stats_h_about_numbers",
  ].map((key) => headingAt(key));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "the four sections are out of order");

  // Each section keeps the element the measurement paints into, in its own section.
  assert.ok(headingAt("stats_h_explore") < PAGE.indexOf('<div id="coverage">'));
  assert.ok(PAGE.indexOf('<div id="coverage">') < headingAt("stats_h_recent_use"));
  assert.ok(headingAt("stats_h_recent_use") < PAGE.indexOf('<div id="search-use">'));
  assert.ok(PAGE.indexOf('<div id="search-use">') < headingAt("stats_h_connections"));

  // The old presentation's headings are gone rather than reworded in place.
  for (const retired of ['data-i18n="stats_h_general"', 'data-i18n="stats_h_coverage"', 'data-i18n="stats_public_method_heading"']) {
    assert.equal(PAGE.includes(retired), false, `${retired} still stands on the page`);
  }
});

test("the worked paths are static content, not something a reader waits for", () => {
  // Everything in the connections and methodology sections is in the served markup, so a
  // reader with no working client analytics — or no JavaScript at all — still gets the
  // point of the product rather than an empty frame.
  const script = PAGE.slice(PAGE.indexOf("<script>\n(() =>"));
  for (const marker of ["paths", "hops", "path-links", "dl class=\"method\""]) {
    assert.equal(script.includes(marker), false, `${marker} is built by script instead of served`);
  }
  assert.equal((PAGE.match(/<article class="path"/g) || []).length, 3);
  // Each path card is named by its own heading for assistive technology.
  for (const id of ["path-contracts-title", "path-land-title", "path-rules-title"]) {
    assert.match(PAGE, new RegExp(`aria-labelledby="${id}"`));
    assert.match(PAGE, new RegExp(`<h3 id="${id}" data-i18n="`));
  }
});

test("each worked path names an established product domain, and adds no taxonomy of its own", () => {
  const domainKeys = [...PAGE.matchAll(/class="path-domain" data-i18n="stats_domain_([a-z_]+)"/g)]
    .map((match) => match[1]);
  assert.deepEqual(domainKeys, ["contracts", "zoning", "rules"]);
  const served = new Set(COVERAGE.domains.map((domain) => domain.domain_id));
  for (const key of domainKeys) {
    assert.ok(served.has(key), `${key} is not a served coverage domain`);
  }
});

test("each worked path opens a real record and hands the reader on to the guide", () => {
  // Routes are resolved from the manifests and route modules that own them, never retyped.
  const award = demoUrl("graph-walk-agency-vendor-award");
  const notice = demoUrl("notice-sanitation-connected-mandate");
  const land = landProjectPath("2022M0258");
  assert.equal(land, "/browse/zoning/#land/2022M0258");

  for (const href of [award, notice, land.replace(/^\//, "")]) {
    assert.ok(PAGE.includes(`href="${href}"`), `the page does not open ${href}`);
  }

  for (const guide of [
    "guide/start/trace-an-award-and-keep-the-trail/",
    "guide/how-to/read-a-land-use-projects-next-step/",
    "guide/start/trace-a-notice-to-the-duty-behind-it/",
  ]) {
    assert.ok(PAGE.includes(`href="${guide}"`), `the page does not link ${guide}`);
    // Linked, not copied: the tutorial itself stays in the guide.
    const article = read(`../site/guide/_articles/${guide.split("/").filter(Boolean).pop()}.md`);
    assert.match(article, /^last_reviewed: \d{4}-\d{2}-\d{2}$/m, `${guide} needs a recorded review date`);
  }
  // Both link roles are translated; neither is a bare URL or an English-only label.
  assert.equal((PAGE.match(/data-i18n="stats_path_open"/g) || []).length, 3);
  assert.equal((PAGE.match(/data-i18n="stats_path_guide"/g) || []).length, 3);
});

test("the record names inside a path are marked as the published English they are", () => {
  const names = [...PAGE.matchAll(/<span class="hop-name" lang="en">([^<]+)<\/span>/g)].map((m) => m[1]);
  assert.equal(names.length, 9, "each of the three paths states three named steps");
  // Each name is a published identity a reader can look up, not a paraphrase and not a
  // live datum that would go stale sitting in static markup.
  for (const identity of [
    "Homeless Services",
    "Housing Options &amp; Geriatric Association Resources",
    "Notice 20231222103",
    "Timbale Terrace · 2022M0258",
    "Housing Preservation and Development",
    "Zoning Application Portal · project 2022M0258",
    "Notice 20260605008",
    "Mandate 64116-001",
    "New York City Charter § 753(e)(2)",
  ]) {
    assert.ok(names.includes(identity), `the paths do not name ${identity}`);
  }
  // The role beside each name is translated, so the structure reads in every language even
  // though the record's own name does not.
  assert.equal((PAGE.match(/class="hop-role" data-i18n="stats_path_role_/g) || []).length, 9);
});

test("every first-class string the rewrite adds ships in all ten translated languages", () => {
  const added = [
    "stats_h_explore", "stats_p_explore", "stats_h_recent_use", "stats_h_connections",
    "stats_p_connections", "stats_h_about_numbers", "stats_coverage_empty",
    "stats_search_use_span_partial", "stats_paths_checked_html", "stats_path_open",
    "stats_path_guide", "stats_path_contracts_title", "stats_path_contracts_what",
    "stats_path_contracts_limit", "stats_path_land_title", "stats_path_land_what",
    "stats_path_land_limit", "stats_path_rules_title", "stats_path_rules_what",
    "stats_path_rules_limit", "stats_path_role_agency", "stats_path_role_paid",
    "stats_path_role_award", "stats_path_role_project", "stats_path_role_applicant",
    "stats_path_role_source", "stats_path_role_notice", "stats_path_role_duty",
    "stats_path_role_law", "stats_method_counted_label", "stats_method_counted_desc",
    "stats_method_periods_label", "stats_method_periods_desc", "stats_method_fresh_label",
    "stats_method_fresh_desc", "stats_method_limits_label", "stats_method_limits_desc",
    "stats_method_private_label", "stats_method_private_html",
  ];
  const english = read("../site/i18n.js");
  for (const key of added) assert.match(english, new RegExp(`\\n\\s+${key}:`), `en is missing ${key}`);
  for (const lang of SHIPPING_LANGS) {
    const source = read(`../site/i18n/lang/${lang}.js`);
    for (const key of added) assert.match(source, new RegExp(`\\n\\s+${key}:`), `${lang} is missing ${key}`);
  }
});

test("the methodology sits beside the claims and keeps receipt internals out", () => {
  const about = PAGE.slice(headingAt("stats_h_about_numbers"), PAGE.indexOf("</main>"));
  for (const key of [
    "stats_method_counted_label", "stats_method_periods_label",
    "stats_method_fresh_label", "stats_method_limits_label",
    "stats_public_languages_label", "stats_method_private_label",
  ]) {
    assert.ok(about.includes(`data-i18n="${key}"`) || about.includes(`data-i18n-html="${key}"`), key);
  }
  // Short definitions next to each measurement, not a dump of how the receipts are stored.
  for (const internal of ["receipt", "KV", "scan bound", "allowlist", "snapshot_sha", "cursor"]) {
    assert.equal(new RegExp(`>[^<]*\\b${internal}\\b`, "i").test(about), false, `${internal} leaked into the page`);
  }
});

test("a period whose last day is still running says so, from the response's own instant", () => {
  assert.match(PAGE, /stats_search_use_span_partial/);
  assert.match(PAGE, /const endsMidDay = \(value\) => !!value && !\/T00:00:00\(\?:\\\.0\+\)\?Z\$\/\.test\(String\(value\)\)/);
  // The decision is read off the published instant; the page consults no clock of its own.
  const script = PAGE.slice(PAGE.indexOf("<script>\n(() =>"));
  assert.equal(/Date\.now\(\)|new Date\(\)(?!\s*\))/.test(script), false, "the page reads a clock");
});

test("the Stats document keeps its public endpoints and its gated crosslink boundary", () => {
  assert.match(PAGE, /<link rel="canonical" href="https:\/\/cityscroll\.org\/stats\.html">/);
  assert.match(PAGE, /<meta property="og:url" content="https:\/\/cityscroll\.org\/stats\.html">/);
  assert.doesNotMatch(PAGE, /href="(?:\/)?data-health\//);
  assert.match(PAGE, /https:\/\/api\.cityscroll\.org\/stats/);
});
