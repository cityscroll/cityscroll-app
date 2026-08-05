/**
 * Legacy Alerts characterization plus the Following route handoff.
 *
 *   node --test test/alerts_reground.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { alertsHref, parseAlertsEntryParams, isContextAlertsHash } from "../site/alerts_context_carry.mjs";
import { SITE_SOURCE } from "./helpers/site_source.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(ROOT, "site/index.html"), "utf8");
const i18n = readFileSync(join(ROOT, "site/i18n.js"), "utf8");
const workspace = readFileSync(join(ROOT, "site/app/workspace.mjs"), "utf8");

test("exactly one email field on #alerts (one subscribe machine)", () => {
  const tab = html.slice(html.indexOf('id="tab-alerts"'), html.indexOf('id="tab-notice"'));
  const emails = [...tab.matchAll(/id="adest"/g)];
  assert.equal(emails.length, 1, "one #adest only");
  // Email is not nested inside the advanced disclosure — it is the finish step.
  const advStart = tab.indexOf('id="advopts"');
  const advEnd = tab.indexOf("</details>", advStart);
  const advBlock = tab.slice(advStart, advEnd);
  assert.ok(!advBlock.includes('id="adest"'), "email must not live inside More ways to watch");
  assert.ok(!advBlock.includes('id="asubscribe"'), "subscribe must not live inside advanced disclosure");
  assert.match(tab, /alerts-email-step/);
});

test("advanced options are progressive disclosure, not a second form", () => {
  assert.match(html, /id="advopts"/);
  assert.ok(!/id="advopts"[^>]*\sopen/.test(html), "advopts starts closed on bare entry");
  assert.match(i18n, /build_alert_heading:\s*"More ways to watch"/);
  // Subscribe + single email live in the main finish path.
  assert.match(html, /id="asubscribe"/);
  assert.match(html, /id="apreview"/);
  assert.doesNotMatch(html, /id="quizgo"/);
});

test("multi-watch rollup is demoted behind disclosure", () => {
  assert.match(html, /<details[^>]*id="alerts-rollup-prefs"/);
  assert.ok(!/id="alerts-rollup-prefs"[^>]*\sopen/.test(html), "rollup starts closed");
  assert.match(i18n, /alerts_rollup_summary:\s*"Manage existing alerts"/);
  assert.match(SITE_SOURCE, /panel\.open\s*=\s*true/);
});

test("agency follow opens Following with the same entity scope", () => {
  assert.match(workspace, /alerts_context_carry\.mjs/);
  assert.match(workspace, /location\.assign/);
  assert.match(workspace, /lens:\s*"entity"/);
  const href = alertsHref({
    lens: "entity",
    filter: { kind: "agency", name: "Design and Construction" },
  });
  const url = new URL(href);
  assert.equal(url.pathname, "/following");
  const p = parseAlertsEntryParams(url.search);
  assert.equal(p.lens, "entity");
  assert.equal(p.filter.kind, "agency");
  assert.equal(p.filter.name, "Design and Construction");
});

test("bare #alerts is not a context-carry entry", () => {
  assert.equal(isContextAlertsHash("#alerts"), false);
});

test("i18n carries single-flow lead copy", () => {
  assert.match(i18n, /quiz_heading:\s*"Get email alerts"/);
  assert.match(i18n, /alerts_flow_lead:/);
  assert.match(i18n, /alerts_email_step_label:\s*"Your email"/);
});
