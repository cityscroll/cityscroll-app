import { SITE_SOURCE } from "./helpers/site_source.mjs";
/**
 * Characterization: multi-watch digest rollup + preference surface on #alerts.
 *
 * Pure helpers group demo watches by topic/agency/geography and build a
 * consolidated digest preview model. UI mounts on #alerts?view=rollup and
 * reuses worker account-level rollup (no second delivery product).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PREFS_CUTOVER_COPY,
  ROLLUP_GROUP_DIMS,
  buildRollupPreviewModel,
  demoRollupPreviewModel,
  demoRollupWatches,
  groupWatchesForRollup,
  shouldShowAccountRollup,
  watchDimension,
} from "../site/alerts_rollup_prefs.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = SITE_SOURCE;
const i18n = readFileSync(join(ROOT, "site/i18n.js"), "utf8");
const agents = readFileSync(join(ROOT, "AGENTS.md"), "utf8");

test("demo account has more than one active watch so rollup applies", () => {
  const watches = demoRollupWatches();
  assert.ok(watches.length > 1);
  assert.equal(shouldShowAccountRollup(watches), true);
  assert.equal(
    shouldShowAccountRollup([{ lens: "money", filter: {}, paused: false }]),
    false,
  );
});

test("group by topic / agency / geography clusters related watches", () => {
  const watches = demoRollupWatches();
  const byTopic = groupWatchesForRollup(watches, "topic");
  assert.ok(byTopic.length >= 2);
  assert.ok(byTopic.every((g) => g.dimension === "topic" && g.watches.length >= 1));

  const byAgency = groupWatchesForRollup(watches, "agency");
  const agencyLabels = byAgency.map((g) => g.label);
  assert.ok(agencyLabels.some((l) => /Education/i.test(l)));
  assert.ok(agencyLabels.some((l) => /Transportation/i.test(l)));

  const byGeo = groupWatchesForRollup(watches, "geography");
  assert.ok(byGeo.some((g) => /Lower East Side/i.test(g.label)));
  assert.ok(byGeo.some((g) => /unscoped|Citywide/i.test(g.label)));
});

test("empty agency/geography dimensions use honest unscoped labels", () => {
  const moneyAny = watchDimension({ lens: "money", filter: { keywords: ["it"] } }, "agency");
  assert.equal(moneyAny.label, "Any agency");
  const moneyGeo = watchDimension({ lens: "money", filter: { keywords: ["it"] } }, "geography");
  assert.equal(moneyGeo.label, "Citywide or unscoped");
});

test("rollup preview model uses multi-watch subject and section-per-watch body", () => {
  const model = demoRollupPreviewModel();
  assert.equal(model.rollupApplies, true);
  assert.equal(model.watchCount, 3);
  assert.ok(model.totalNew >= 1);
  assert.match(model.subject, /3 watches/);
  assert.match(model.summaryLine, /of 3 watches/);
  assert.equal(model.sections.length, 3);
  assert.equal(model.cutover, PREFS_CUTOVER_COPY);
  assert.ok(ROLLUP_GROUP_DIMS.includes(model.groupBy));
});

test("paused watches are excluded from rollup groups and preview", () => {
  const watches = [
    ...demoRollupWatches(),
    { key: "sub:paused", lens: "rules", filter: { keywords: ["ebike"] }, paused: true, query: "paused rules" },
  ];
  const groups = groupWatchesForRollup(watches, "topic");
  assert.ok(!groups.some((g) => g.watches.some((w) => w.key === "sub:paused")));
  const model = buildRollupPreviewModel(watches);
  assert.equal(model.watchCount, 3);
});

test("#alerts mounts rollup prefs panel and group-by chips", () => {
  assert.match(html, /id="alerts-rollup-prefs"/);
  assert.match(html, /id="rollupgroupby"/);
  assert.match(html, /id="alerts-rollup-emailmock"/);
  assert.match(html, /id="alertsPrefsManage"/);
  assert.match(html, /function renderAlertsRollupPrefs/);
  assert.match(html, /function initAlertsRollupPrefs/);
  assert.match(html, /import\("\.\.\/alerts_rollup_prefs\.mjs"\)/);
  assert.match(html, /view"\) === "rollup"/);
});

test("English i18n carries alerts rollup preference keys", () => {
  for (const key of [
    "alerts_rollup_summary",
    "alerts_rollup_heading",
    "alerts_rollup_lead",
    "alerts_rollup_group_label",
    "alerts_rollup_group_topic",
    "alerts_rollup_group_agency",
    "alerts_rollup_group_geography",
    "alerts_rollup_email_heading",
    "alerts_rollup_prefs_lead",
    "alerts_rollup_manage_btn",
    "alerts_rollup_cutover",
    "alerts_rollup_digest_footer",
  ]) {
    assert.match(i18n, new RegExp(`${key}\\s*:`), `missing en key ${key}`);
  }
});

test("public demo contract opens the top-level watch manager in Following", () => {
  const demo = JSON.parse(readFileSync(join(ROOT, "site/demo/demo-links.json"), "utf8"));
  const entry = demo.entries.find((row) => row.id === "alerts-rollup-prefs");
  assert.ok(entry, "demo-links must include alerts-rollup-prefs");
  assert.equal(entry.feature, "alerts-rollup-prefs");
  assert.equal(entry.url, "following/");
  assert.equal(entry.expectations.pathname, "/following/");
  assert.ok(entry.expectations.visible.some((loc) => loc.selector === "#your-following" && loc.text === "Your watches"));
  assert.ok(entry.expectations.visible.some((loc) => loc.selector === "[data-personal-watch-list]"));
});

test("project memory documents alerts rollup prefs surface", () => {
  assert.match(agents, /alerts-rollup-prefs|#alerts\?view=rollup|multi-watch digest rollup/i);
});
