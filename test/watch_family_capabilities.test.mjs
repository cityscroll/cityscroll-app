import assert from "node:assert/strict";
import test from "node:test";

import {
  WATCH_FAMILY_CAPABILITIES,
  WATCH_FAMILY_CAPABILITIES_SCHEMA,
  rankWatchFamilySuggestions,
} from "../site/watch_family_capabilities.mjs";
import {
  buildFollowingViewModel,
  canonicalFollowingScope,
  renderFollowingDocument,
  watchFromFollowingParams,
} from "../site/following_view.mjs";

const EXPECTED_FAMILIES = [
  "contracts-awards",
  "rezonings-land-use",
  "meetings",
  "exams-staffing",
  "rules",
  "property",
  "procurement",
  "agency-activity",
  "vendor-activity",
  "mandates",
  "geographic-scopes",
];

test("the canonical watch-family capability spans every public follow family", () => {
  assert.equal(WATCH_FAMILY_CAPABILITIES_SCHEMA, "cityscroll.watch_family_capabilities.v1");
  assert.deepEqual(WATCH_FAMILY_CAPABILITIES.map((capability) => capability.id), EXPECTED_FAMILIES);
  for (const capability of WATCH_FAMILY_CAPABILITIES) {
    assert.ok(capability.lens);
    assert.ok(capability.label);
    assert.ok(capability.description);
    assert.ok(capability.filter && typeof capability.filter === "object");
  }
});

test("family ranking keeps the full span and raises a matching family", () => {
  const ranked = rankWatchFamilySuggestions("I want to follow zoning changes");
  assert.deepEqual(ranked.map((capability) => capability.id).sort(), [...EXPECTED_FAMILIES].sort());
  assert.equal(ranked[0].id, "rezonings-land-use");
  assert.deepEqual(ranked.map((capability) => capability.rank), Array.from({ length: EXPECTED_FAMILIES.length }, (_, index) => index + 1));
});

test("Following onboarding renders family suggestions as preview links, not submit controls", () => {
  const html = renderFollowingDocument(buildFollowingViewModel({ onboarding: true }, { templates: [] }));
  assert.equal((html.match(/data-suggestion-kind="watch-family"/g) || []).length, EXPECTED_FAMILIES.length + 1);
  assert.match(html, /Choose what to follow/);
  assert.match(html, /Pick a suggestion to open its preview/);
  assert.match(html, /data-watch-family-id="contracts-awards"[\s\S]*href="https:\/\/cityscroll\.org\/following\?lens=money/);
  assert.match(html, /data-watch-family-id="geographic-scopes"[\s\S]*lens=district/);
  assert.doesNotMatch(html, /data-watch-family-id="contracts-awards"[\s\S]*<button[^>]*type="submit"/);
});

test("a family suggestion URL round-trips to the shared editable watch sentence", () => {
  const html = renderFollowingDocument(buildFollowingViewModel({
    ...watchFromFollowingParams(new URLSearchParams("lens=land&filter=%7B%22keywords%22%3A%5B%22rezoning%22%5D%2C%22status%22%3A%22all%22%7D&freq=weekly")),
    requested: true,
  }, { templates: [] }));
  assert.match(html, /Notify me when new zoning records mentioning 'rezoning' are published citywide\./);
  assert.match(html, /data-following-subscribe-form/);
});

test("a rezoning suggestion and a Zoning plus Brooklyn plus keyword choice share one canonical scope", () => {
  const landing = renderFollowingDocument(buildFollowingViewModel({}, { templates: [] }));
  const suggestionHref = landing.match(
    /data-watch-family-id="rezonings-land-use"[\s\S]*?href="([^"]+)"/,
  )?.[1];
  assert.ok(suggestionHref, "Rezonings and land use must link into Following");
  const suggestionUrl = new URL(suggestionHref.replaceAll("&amp;", "&"));
  assert.equal(suggestionUrl.searchParams.get("step"), null);
  const suggestion = watchFromFollowingParams(suggestionUrl.searchParams);
  assert.equal(suggestion.requested, true);
  assert.equal(suggestion.lens, "land");
  assert.deepEqual(suggestion.filter.keywords, ["rezoning"]);
  assert.equal(suggestion.filter.status, undefined);

  const suggestionThenPlace = canonicalFollowingScope({
    lens: suggestion.lens,
    filter: { ...suggestion.filter, boro: "Brooklyn" },
  });
  const direct = canonicalFollowingScope(watchFromFollowingParams(new URLSearchParams({
    lens: "land",
    boro: "Brooklyn",
    q: "rezoning",
  })));
  assert.deepEqual(suggestionThenPlace, direct);
  assert.equal(suggestionThenPlace.lens, "land");
  assert.equal(suggestionThenPlace.filter.boro, "Brooklyn");
  assert.deepEqual(suggestionThenPlace.filter.keywords, ["rezoning"]);

  const suggestionItem = landing.match(
    /data-watch-family-id="rezonings-land-use"[\s\S]*?<\/li>/,
  )?.[0] || "";
  assert.doesNotMatch(suggestionItem, /<button[^>]*type="submit"/);
  assert.match(landing, /It does not make a watch/);
});
