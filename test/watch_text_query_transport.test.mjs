import assert from "node:assert/strict";
import test from "node:test";

import {
  calendarFeedUrlForScope,
  routeHashFromScope,
  scopeFromLensState,
  scopeFromRouteHash,
  standingFeedUrlsFromWatch,
  subscriptionParamsFromWatch,
  subscriptionWatchFromScope,
} from "../site/scope_v0.mjs";
import {
  searchIntentFromLensState,
  searchIntentFromNlFilter,
  searchIntentFromScope,
} from "../site/search_intent.mjs";
import { followingUrlFromWatch, watchFromFollowingParams } from "../site/following_view.mjs";
import {
  encodeWatchFilter,
  prepareWatchFilter,
  sanitize,
} from "../worker/src/lib/filter.mjs";
import { applyWatchPatch } from "../worker/src/lib/prefs.mjs";
import { parseFeedQuery } from "../worker/src/lib/feed.mjs";
import { handleNl } from "../worker/src/nl.mjs";
import { MCP_TOOLS } from "../capabilities/mcp_tool_declarations.mjs";

const term = (value) => ({ kind: "term", value });
const phrase = (value) => ({ kind: "phrase", value });
const expr = (all, none = []) => ({ version: 1, all, none });

// E3: software OR consulting, excluding maintenance.
const E3 = expr([[term("software"), term("consulting")]], [term("maintenance")]);
const TWO_GROUP = expr(
  [[phrase("construction management")], [term("software")]],
  [term("maintenance")],
);

const FACETS = Object.freeze({
  agency: "Department of Parks and Recreation",
  minAmount: 100000,
  category: "Services (other than human services)",
  months: 6,
  geographies: ["geography:borough:1"],
  noticeType: "award",
});

function moneyWatch(expression, extra = {}) {
  return prepareWatchFilter("money", {
    keywords: [],
    ...FACETS,
    ...extra,
    text_query: expression,
  });
}

function assertFacets(filter) {
  assert.equal(filter.agency, FACETS.agency);
  assert.equal(filter.minAmount, FACETS.minAmount);
  assert.equal(filter.category, FACETS.category);
  assert.equal(filter.months, FACETS.months);
  assert.deepEqual(filter.geographies, FACETS.geographies);
  assert.equal(filter.noticeType, FACETS.noticeType);
}

test("A1: E3 round-trips route state, watch deep link, modern feed filter, and prefs", () => {
  const prepared = moneyWatch(E3);
  assert.equal(prepared.ok, true);
  const canonical = prepared.filter.text_query;
  assert.deepEqual(canonical.all, [[term("consulting"), term("software")]]);
  assert.deepEqual(canonical.none, [term("maintenance")]);
  assertFacets(prepared.filter);

  const scope = scopeFromLensState("money", prepared.filter);
  const fromScope = subscriptionWatchFromScope({ lens: "money", filter: prepared.filter });
  assert.deepEqual(fromScope.filter.text_query, canonical);
  assertFacets(fromScope.filter);
  const hash = routeHashFromScope(scope, { surface: "money" });
  const reloadedScope = scopeFromRouteHash(hash);
  const fromHash = searchIntentFromScope(reloadedScope);
  assert.deepEqual(fromHash.text_query, canonical);
  assert.equal(fromHash.text, "");

  const encoded = encodeWatchFilter("money", prepared.filter);
  assert.ok(encoded);
  const deepLink = JSON.parse(decodeURIComponent(encoded));
  assert.equal(deepLink.lens, "money");
  assert.deepEqual(deepLink.filter.text_query, canonical);
  assertFacets(deepLink.filter);

  const params = subscriptionParamsFromWatch({ lens: "money", filter: prepared.filter });
  assert.equal(params.get("lens"), "money");
  const modern = parseFeedQuery(params);
  assert.equal(modern.modern, true);
  assert.deepEqual(modern.filter.text_query, canonical);
  assertFacets(modern.filter);

  const followingHref = followingUrlFromWatch({ lens: "money", filter: prepared.filter });
  const following = watchFromFollowingParams(new URL(followingHref, "https://cityscroll.org").searchParams);
  assert.deepEqual(following.filter.text_query, canonical);
  assertFacets(following.filter);

  const patched = applyWatchPatch(
    { email: "reader@example.com", lens: "money", filter: sanitize("money", { keywords: ["legacy"] }), freq: "daily" },
    { filter: prepared.filter },
  );
  assert.equal(patched.ok, true);
  assert.deepEqual(patched.record.filter.text_query, canonical);
  assertFacets(patched.record.filter);
});

test("A1: two required groups with a phrase survive the same transports", () => {
  const prepared = moneyWatch(TWO_GROUP);
  assert.equal(prepared.ok, true);
  const canonical = prepared.filter.text_query;
  assert.equal(canonical.all.length, 2);
  assert.ok(canonical.all.some((group) => group.some((atom) => atom.kind === "phrase" && atom.value === "construction management")));
  assert.ok(canonical.all.some((group) => group.some((atom) => atom.kind === "term" && atom.value === "software")));

  const intent = searchIntentFromLensState("money", prepared.filter);
  assert.deepEqual(intent.text_query, canonical);
  assert.equal(intent.text, "");

  const feeds = standingFeedUrlsFromWatch({ lens: "money", filter: prepared.filter });
  const parsed = parseFeedQuery(new URL(feeds.atom).searchParams);
  assert.deepEqual(parsed.filter.text_query, canonical);
  assert.equal(feeds.ics, null, "calendar must not advertise a broader substitute");
  assert.equal(calendarFeedUrlForScope({ lens: "money", filter: prepared.filter }), null);
});

test("A3/A6: malformed JSON, unknown keys, over-limit atoms, and mixed keywords are rejected before widening", () => {
  assert.equal(parseFeedQuery(new URLSearchParams("lens=money&filter={")).error, "invalid filter");
  assert.equal(prepareWatchFilter("money", { keywords: [], text_query: { version: 2, all: [[term("software")]] } }).ok, false);
  assert.equal(prepareWatchFilter("money", { keywords: [], text_query: { version: 1, extra: true, all: [[term("software")]] } }).ok, false);
  assert.equal(prepareWatchFilter("money", {
    keywords: [],
    text_query: { version: 1, all: [[term("a")], [term("b")], [term("c")], [term("d")], [term("e")]] },
  }).ok, false);
  assert.equal(prepareWatchFilter("meetings", { keywords: [], text_query: E3 }).ok, false);
  const mixed = prepareWatchFilter("money", { keywords: ["software"], text_query: E3 });
  assert.equal(mixed.ok, false);
  assert.equal(mixed.reason, "text-query-legacy_keywords_present");
});

test("A6: Unicode, quotes, percent and underscore user input canonicalize rather than flatten to q", () => {
  const prepared = moneyWatch(expr([[term("  CAFÉ  "), term("cafe\u0301")]], [term("maintenance")]));
  assert.equal(prepared.ok, true);
  assert.deepEqual(prepared.filter.text_query.all[0], [term("café")]);

  const quoted = moneyWatch(expr([[term("software")], [phrase("construction management")]]));
  assert.equal(quoted.ok, true);
  const viaParams = subscriptionWatchFromScope({
    lens: "money",
    filter: JSON.parse(subscriptionParamsFromWatch({ lens: "money", filter: quoted.filter }).get("filter")),
  });
  assert.deepEqual(viaParams.filter.text_query, quoted.filter.text_query);

  const underscore = prepareWatchFilter("money", {
    keywords: [],
    agency: FACETS.agency,
    text_query: expr([[{ kind: "term", value: "soft_ware" }]]),
  });
  assert.equal(underscore.ok, false, "underscore splits a term; do not silently coerce");
});

test("A4: SearchIntent carries the expression; NL structured input skips a model call", async () => {
  const prepared = moneyWatch(E3);
  const intent = searchIntentFromNlFilter("money", prepared.filter);
  assert.deepEqual(intent.text_query, prepared.filter.text_query);
  assert.equal(intent.text, "");

  const res = await handleNl(new Request("https://api.cityscroll.org/nl", {
    method: "POST",
    headers: { origin: "https://cityscroll.org", "content-type": "application/json" },
    body: JSON.stringify({ lens: "money", filter: prepared.filter }),
  }), {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.model, null);
  assert.deepEqual(body.filter.text_query, prepared.filter.text_query);
  assert.deepEqual(body.search_intent.text_query, prepared.filter.text_query);

  const rejected = await handleNl(new Request("https://api.cityscroll.org/nl", {
    method: "POST",
    headers: { origin: "https://cityscroll.org", "content-type": "application/json" },
    body: JSON.stringify({
      lens: "money",
      filter: { keywords: [], text_query: { version: 9, all: [[term("software")]] } },
    }),
  }), {});
  assert.equal(rejected.status, 400);
  const fail = await rejected.json();
  assert.equal(fail.error, "unsupported_filter");
  assert.match(fail.reason, /unsupported_version/);
  assert.match(fail.correction, /explicit matching controls/i);
});

test("A4: existing MCP preview/create tools accept a structured filter without a new tool", () => {
  const preview = MCP_TOOLS.find((tool) => tool.name === "preview_watch");
  const create = MCP_TOOLS.find((tool) => tool.name === "create_watch");
  assert.ok(preview);
  assert.ok(create);
  assert.equal(preview.inputSchema.properties.filter.type, "object");
  assert.equal(create.inputSchema.properties.filter.type, "object");
  assert.ok(preview.inputSchema.required.includes("lens"));
  assert.ok(!preview.inputSchema.required.includes("filter"));
  assert.ok(create.inputSchema.required.includes("email"));
  assert.ok(create.inputSchema.required.includes("lens"));
});
