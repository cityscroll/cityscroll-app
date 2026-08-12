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

test("parcel documents organize by civic process, not by source", () => {
  const composed = read("site/composed_object_documents.mjs");
  const biographyUi = read("site/parcel_biography_ui.mjs");
  const parcelScope = read("site/parcel_scope.mjs");
  const i18n = read("site/i18n.js");

  assert.doesNotMatch(composed, /grouped by source/i);
  assert.match(composed, /arranged by civic process/);
  assert.match(parcelScope, /PARCEL_PROCESS_SECTION_ORDER/);
  assert.match(parcelScope, /"property"[\s\S]*"land"[\s\S]*"tax_lien"[\s\S]*"ll48"[\s\S]*"cofo"/);
  assert.match(biographyUi, /PARCEL_PROCESS_SECTION_ORDER/);
  assert.match(biographyUi, /officialSourceLink/);
  assert.match(composed, /officialSourceLink/);
  assert.match(composed, /parcelItemOfficialSource/);
  // Source names stay out of the public lede and process headings.
  assert.match(i18n, /property_xd_deck: "Public records connected with this parcel, arranged by civic process/);
  assert.match(i18n, /property_xd_land_heading: "Land-use process"/);
  assert.match(i18n, /property_xd_tax_lien_heading: "Tax-lien status"/);
  assert.doesNotMatch(i18n, /property_xd_deck: "Observed City Record/);
});
