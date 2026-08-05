import { SITE_SOURCE } from "./helpers/site_source.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const html = SITE_SOURCE;
const worker = await readFile(new URL("../worker/src/rules.mjs", import.meta.url), "utf8");

test("rules materialization carries the distinct event spine to the public read model", () => {
  assert.match(worker, /events:\s*deriveRuleEvents\(m\.rule, now\)/);
  assert.match(worker, /effective_date:\s*m\.rule\.effective_date/);
  assert.match(worker, /schema_version:\s*RULES_VIEW_VERSION/);
});

test("Agency Rules notice detail mounts and renders the event spine", () => {
  assert.match(html, /<div id="drules" data-export-class="rule_lifecycle"><\/div>/);
  assert.match(html, /<div id="nrules" data-export-class="rule_lifecycle"><\/div>/);
  assert.match(html, /loadRuleLifecycle\(r, \$\("#drules"\)\)/);
  assert.match(html, /loadRuleLifecycle\(r, \$\("#nrules"\)\)/);
  assert.match(html, /function ruleEventSpineHTML\(/);
  for (const type of ["proposal_published", "public_hearing", "comment_close", "adoption", "effective"]) {
    assert.match(html, new RegExp(`"${type}"\\s*:`));
  }
});

test("rule event gaps use both lifecycle taxonomy registers", () => {
  assert.match(html, /rule_event_not_yet_ingested_html/);
  assert.match(html, /rule_event_not_published_html/);
});

test("comment-close detail keeps the official action and calendar affordance", () => {
  assert.match(html, /rule_comment_btn/);
  assert.match(html, /data-rule-event=/);
  assert.match(html, /downloadRuleEventICS/);
});

test("public demo contract includes a Rules lifecycle spine notice", async () => {
  const demo = JSON.parse(await readFile(new URL("../site/demo/demo-links.json", import.meta.url), "utf8"));
  const entry = demo.entries.find((row) => row.id === "rules-lifecycle-spine");
  assert.ok(entry, "demo-links must include rules-lifecycle-spine");
  assert.equal(entry.feature, "rules-lifecycle-spine");
  assert.match(entry.url, /^#notice\//);
  assert.ok(entry.expectations.visible.some((loc) => /rule-chain|chain-h/.test(loc.selector)));
  assert.ok(entry.expectations.visible.some((loc) => /Proposal published|Comment deadline|Public process|Public hearing|Rule lifecycle|Propose/.test(loc.text || "")));
  assert.ok(entry.expectations.visible.some((loc) => /rule-phase-stepper|rule-spine-lead|chain-h/.test(loc.selector || "")));
});

test("digest temporal path cites comment-close by valid_at from the event spine", async () => {
  const alertTemporal = await readFile(new URL("../worker/src/lib/alert_temporal.mjs", import.meta.url), "utf8");
  assert.match(alertTemporal, /commentCloseValidAt/);
  assert.match(alertTemporal, /event_type === "comment_close"/);
  assert.match(alertTemporal, /trigger_field:\s*"valid_at"/);
  assert.match(alertTemporal, /event_type:\s*"comment_close"/);
});
