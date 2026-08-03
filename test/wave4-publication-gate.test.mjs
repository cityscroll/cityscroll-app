import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { SITE_SOURCE } from "./helpers/site_source.mjs";

const root = new URL("../", import.meta.url);
const siteRoot = new URL("../site/", import.meta.url);
const publicPages = [
  "index.html",
  "about.html",
  "data.html",
  "stats.html",
  "api.html",
  "changelog.html",
  "standards.html",
];
const fixtureOnlyOutputs = [
  "action_registry.json",
  "alarm_ledger.json",
  "coverage_ledger.json",
  "delivery_events.json",
  "forecast_bundle.json",
  "money_ledger.json",
  "ocds-gap-table.json",
  "process_spine.json",
  "review_queue.json",
  "routing_ontology.json",
  "unresolved-joins.json",
];

test("fixture-only Wave 4 surfaces stay out of the public site", () => {
  for (const page of publicPages) {
    const html = readFileSync(new URL(page, siteRoot), "utf8");
    assert.doesNotMatch(html, /contract\.html|Reference preview|bounded fixtures/i, page);
    assert.doesNotMatch(
      html,
      /data\/(?:action_registry|alarm_ledger|coverage_ledger|delivery_events|forecast_bundle|money_ledger|ocds-gap-table|process_spine|review_queue|routing_ontology|unresolved-joins)\.json/,
      page,
    );
  }
  assert.equal(existsSync(new URL("contract.html", siteRoot)), false);
  assert.equal(existsSync(new URL("contract.js", siteRoot)), false);
  for (const output of fixtureOnlyOutputs) {
    assert.equal(existsSync(new URL(`data/${output}`, siteRoot)), false, output);
    assert.equal(existsSync(new URL(`test/fixtures/wave4/generated/${output}`, root)), true, output);
  }
});

test("the shipped notice surface keeps real joins and item-specific missing states", () => {
  const html = SITE_SOURCE;
  const strings = readFileSync(new URL("i18n.js", siteRoot), "utf8");
  // Precompute-first: notice detail consumes GET /contract-lifecycle, not a live
  // Checkbook proxy (checkbookByPin / checkbookQueryByField are gone from the client).
  assert.match(html, /async function loadLifecycle\(/);
  assert.match(html, /function lifecycleDollarsHTML\(/);
  assert.match(html, /\/contract-lifecycle\?id=/);
  assert.doesNotMatch(html, /async function checkbookByPin\(/);
  assert.doesNotMatch(html, /async function checkbookQueryByField\(/);
  assert.match(html, /async function externalAwardForNotice\(r, el\)/);
  assert.match(html, /loadChain\(r\)/);
  // Registration gap is the established lifecycle register (precompute-first dollars panel).
  assert.match(strings, /Not yet shown here — registered contracts live in \{source\}/);
  assert.match(html, /lifecycleDollarsHTML|lifecycle_unmatched_registered_html/);
  assert.match(html, /t\("external_award_none_note_html"/);
  assert.match(strings, /Not yet shown here — matching awards live in \{source\}/);
});
