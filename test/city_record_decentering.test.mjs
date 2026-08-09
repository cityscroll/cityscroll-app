import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("browse cards do not repeat City Record as a source action", () => {
  const rules = read("site/app/rules.mjs");
  const property = read("site/app/property.mjs");
  const meetings = read("site/app/feed-actions.mjs");

  assert.doesNotMatch(rules, /secondaryActions=\[officialSourceLink\(\{ href: REQ_URL/);
  assert.doesNotMatch(rules, /open_notice_btn[^\n]*officialSourceLink\(\{ href: REQ_URL/);
  assert.doesNotMatch(property, /secondaryActions=\[`<a class="act" href="\$\{REQ_URL/);
  assert.doesNotMatch(meetings, /secondaryActions\.push\(officialSourceLink\(\{ href: REQ_URL\(record\.request_id\)/);
});

test("retained City Record handoffs use the source-link grammar", () => {
  const feedActions = read("site/app/feed-actions.mjs");
  const land = read("site/app/land.mjs");
  const workspace = read("site/app/workspace.mjs");
  const routing = read("site/app/routing.mjs");

  assert.match(feedActions, /cityRecordNotice[\s\S]*officialSourceLink\(\{ href:action\.destination, label:t\("city_record_link"\)/);
  assert.match(land, /id="land-city-record-source"/);
  assert.match(land, /cr\.outerHTML=officialSourceLink\(\{ href:REQ_URL\(rows\[0\]\.request_id\)/);
  assert.match(workspace, /officialSourceLink\(\{ href:REQ_URL\(latestNoticeId\)/);
  assert.match(routing, /officialSourceLink\(\{ href:sourceHref, label:t\("city_record_link"\)/);
});

test("the City Record source branch cannot claim the action rail primary", () => {
  const feedActions = read("site/app/feed-actions.mjs");
  const sourceBranch = feedActions.match(
    /if\(cityRecordNotice\)\{([\s\S]*?)\n      \}\n      const primary=/,
  );
  assert.ok(sourceBranch, "City Record source branch should precede primary assignment");
  assert.doesNotMatch(sourceBranch[1], /class=\\?"act/);
  assert.match(sourceBranch[1], /next-action-source/);
});
