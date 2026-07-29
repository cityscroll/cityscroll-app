import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
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
    const html = readFileSync(new URL(page, root), "utf8");
    assert.doesNotMatch(html, /contract\.html|Reference preview|bounded fixtures/i, page);
    assert.doesNotMatch(
      html,
      /data\/(?:action_registry|alarm_ledger|coverage_ledger|delivery_events|forecast_bundle|money_ledger|ocds-gap-table|process_spine|review_queue|routing_ontology|unresolved-joins)\.json/,
      page,
    );
  }
  assert.equal(existsSync(new URL("contract.html", root)), false);
  assert.equal(existsSync(new URL("contract.js", root)), false);
  for (const output of fixtureOnlyOutputs) {
    assert.equal(existsSync(new URL(`data/${output}`, root)), false, output);
    assert.equal(existsSync(new URL(`test/fixtures/wave4/generated/${output}`, root)), true, output);
  }
});

test("the shipped notice surface keeps real joins and item-specific missing states", () => {
  const html = readFileSync(new URL("index.html", root), "utf8");
  const strings = readFileSync(new URL("i18n.js", root), "utf8");
  assert.match(html, /async function checkbookByPin\(pin\)/);
  assert.match(html, /async function externalAwardForNotice\(r, el\)/);
  assert.match(html, /loadChain\(r\)/);
  assert.match(html, /no registered contract in Checkbook NYC for PIN/);
  assert.match(html, /t\("external_award_none_note_html"/);
  assert.match(strings, /found no matching award there either/);
});
