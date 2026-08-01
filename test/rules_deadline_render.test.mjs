import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const html = await readFile(new URL("../site/index.html", import.meta.url), "utf8");
const worker = await readFile(new URL("../worker/src/rules.mjs", import.meta.url), "utf8");

test("rules materialization carries the distinct event spine to the public read model", () => {
  assert.match(worker, /events:\s*deriveRuleEvents\(m\.rule, now\)/);
  assert.match(worker, /effective_date:\s*m\.rule\.effective_date/);
  assert.match(worker, /schema_version:\s*2/);
});

test("Agency Rules notice detail mounts and renders the event spine", () => {
  assert.match(html, /<div id="drules"><\/div>/);
  assert.match(html, /<div id="nrules"><\/div>/);
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

test("digest temporal path cites comment-close by valid_at from the event spine", async () => {
  const alertTemporal = await readFile(new URL("../worker/src/lib/alert_temporal.mjs", import.meta.url), "utf8");
  assert.match(alertTemporal, /commentCloseValidAt/);
  assert.match(alertTemporal, /event_type === "comment_close"/);
  assert.match(alertTemporal, /trigger_field:\s*"valid_at"/);
  assert.match(alertTemporal, /event_type:\s*"comment_close"/);
});
