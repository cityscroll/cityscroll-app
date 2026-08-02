import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");

test("notice detail loads and mounts the shared action registry", () => {
  assert.match(html, /<script src="action_registry\.js"><\/script>/);
  assert.match(html, /id="nactions"/);
  assert.match(html, /mountNoticeActionRail\(\$\("#nactions"\),r\)/);
  assert.match(html, /id="dactions"/);
});

test("notice detail keeps utility controls separate from the single action rail", () => {
  const showNotice = html.slice(html.indexOf("async function showNotice"), html.indexOf("/* ===================== INIT"));
  assert.doesNotMatch(showNotice, /id="nics"/);
  assert.doesNotMatch(showNotice, /noticeParticipation/);
  // How-to-respond leads (after the action rail) without a second set of primary CTAs
  assert.match(showNotice, /buildApply\(r,false\)/);
  const applyAt = showNotice.indexOf("buildApply(r,false)");
  const lifecycleAt = showNotice.indexOf('id="nlifecycle"');
  assert.ok(applyAt > 0 && lifecycleAt > applyAt, "response path appears before contract lifecycle");
});

test("the rail exposes official domains and unavailable actions as status text", () => {
  assert.match(html, /action\.destination_label/);
  assert.match(html, /next-action-unavailable" role="status"/);
  assert.match(html, /CrolActions\.compileActionRail/);
});

test("solicitation rail hydrates from lifecycle evidence and renders a copyable response guide", () => {
  assert.match(html, /rfx_detail:lifecycleData&&lifecycleData\.rfx_detail/);
  assert.match(html, /paintNoticeActionRail\(actionsEl,r,null,data\)/);
  assert.match(html, /class="bid-guide" open/);
  assert.match(html, /data-copy-value/);
  assert.doesNotMatch(html, /href="\$\{PASSPORT\}"/);
  assert.doesNotMatch(html, /official_application_url:kind==="solicitation"\?PASSPORT/);
});

test("hearing action matter passes venue, participation, and full body for step extraction", () => {
  assert.match(html, /venue:hearing&&hearing\.venue\|\|null/);
  assert.match(html, /participation:hearing&&hearing\.participation\|\|null/);
  assert.match(html, /additional_description_1,r\.additional_description_2,r\.additional_description_3/);
  assert.match(html, /printout_1,r\.printout_2,r\.printout_3/);
  assert.match(html, /guide\.system==="hearing_extracted"/);
  assert.match(html, /hearing_guide_heading/);
  assert.match(html, /hearing_guide_attend_step/);
  assert.match(html, /hearing_guide_testimony/);
});

test("rules action matter passes hearing_date, summary, and comment fields for guide steps", () => {
  assert.match(html, /comment_by_date:rule&&rule\.comment_by_date\|\|null/);
  assert.match(html, /hearing_date:rule&&rule\.hearing_date\|\|null/);
  assert.match(html, /summary:rule&&rule\.summary\|\|null/);
  assert.match(html, /guide\.system==="rules_extracted"/);
  assert.match(html, /rule_guide_heading/);
  assert.match(html, /rule_guide_comment_by_step/);
  assert.match(html, /rule_guide_comment_portal_step_html/);
  assert.match(html, /rule_guide_attend_step/);
  assert.match(html, /rule_guide_attend_date_step/);
});
