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
  assert.match(showNotice, /buildApply\(r,false\)/);
});

test("the rail exposes official domains and unavailable actions as status text", () => {
  assert.match(html, /action\.destination_label/);
  assert.match(html, /next-action-unavailable" role="status"/);
  assert.match(html, /CrolActions\.compileActionRail/);
});
