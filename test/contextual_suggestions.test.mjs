import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  BROWSE_FACETS,
  buildBrowseView,
  renderBrowseView,
} from "../site/browse_view.mjs";
import {
  buildContextualSuggestions,
  productionDestinationCheck,
  renderContextualSuggestions,
} from "../site/contextual_suggestions.mjs";
import { scopeFromRouteHash } from "../site/scope_v0.mjs";

const payload = JSON.parse(readFileSync("site/data/money_default_open.json", "utf8"));
const propertyPayload = JSON.parse(readFileSync("site/data/property_domain_observations.json", "utf8"));
const productionIntelligence = JSON.parse(readFileSync("site/data/entity_intelligence_lookup.json", "utf8"));

function hrefParams(href) {
  return new URL(href, "https://cityscroll.org").searchParams;
}

test("Browse suggestions are bounded, data-derived, and their destination count equals the scoped view", () => {
  const view = buildBrowseView("contracts", payload, new URLSearchParams(), { limit: 1000 });
  assert.ok(view.contextualSuggestions.length > 0);
  assert.ok(view.contextualSuggestions.length <= 3);
  assert.ok(view.contextualSuggestions.every((suggestion) => suggestion.count > 0));

  for (const suggestion of view.contextualSuggestions.filter((item) => item.kind === "intersect")) {
    const destination = buildBrowseView("contracts", payload, hrefParams(suggestion.href), { limit: 1000 });
    assert.equal(destination.total, suggestion.count);
    assert.equal(destination.scope.mode, "applied");
  }
});

test("a constrained scope advertises following without adding a request to the hot path", () => {
  const params = new URLSearchParams({ agency: payload.notices[0].agency_name });
  const view = buildBrowseView("contracts", payload, params, { limit: 1000 });
  const follow = view.contextualSuggestions.find((suggestion) => suggestion.kind === "follow");
  assert.ok(follow);
  assert.match(follow.href, /^\/following\?lens=money&filter=/);
  assert.equal(follow.count, view.total);
  assert.equal(hrefParams(follow.href).get("count"), String(view.total));
});

test("three-way suggestions are made from co-occurring edges and survive the same scope route", () => {
  const scope = scopeFromRouteHash("#money?facet=%7B%22entity_refs_all%22%3A%5B%22agency:id:one%22%5D%7D");
  const suggestions = buildContextualSuggestions({
    scope,
    surface: "money",
    route: BROWSE_FACETS.contracts.route,
    edgeInventory: [
      { ref: "project:2022M0258", kind: "project", count: 2 },
      { ref: "vendor:stem:MAKE%20IT%20ZESTY", kind: "vendor", count: 2 },
    ],
    edgePairs: [{
      refs: ["project:2022M0258", "vendor:stem:MAKE%20IT%20ZESTY"],
      labels: ["project 2022M0258", "MAKE IT ZESTY"],
      count: 1,
    }],
    resultCount: 2,
    max: 3,
  });
  const threeWay = suggestions.find((suggestion) => suggestion.kind === "three-way");
  assert.ok(threeWay);
  assert.equal(threeWay.count, 1);
  assert.deepEqual(JSON.parse(hrefParams(threeWay.href).get("facet")).entity_refs_all, [
    "agency:id:one",
    "project:2022M0258",
    "vendor:stem:MAKE%20IT%20ZESTY",
  ]);
});

test("an unscoped two-ref destination is an intersection, never a three-way suggestion", () => {
  const suggestions = buildContextualSuggestions({
    scope: scopeFromRouteHash("#money"),
    surface: "money",
    route: BROWSE_FACETS.contracts.route,
    edgePairs: [{
      refs: ["agency:id:one", "vendor:stem:ACME"],
      labels: ["agency one", "ACME"],
      count: 1,
    }],
    resultCount: 2,
  });
  assert.equal(suggestions.some((suggestion) => suggestion.kind === "three-way"), false);
  assert.equal(suggestions.find((suggestion) => suggestion.kind === "intersection")?.count, 1);
});

test("production Property inventory advertises the accepted project-agency-vendor traversal", () => {
  assert.equal(productionIntelligence.project_agency_vendor.public_bundle_count, 1);
  const [bundle] = productionIntelligence.project_agency_vendor.bundles;
  const [projectRef] = bundle.refs.filter((ref) => ref.startsWith("project:"));
  const startParams = new URLSearchParams({
    facet: JSON.stringify({ entity_refs_all: [projectRef] }),
  });
  const start = buildBrowseView("property", propertyPayload, startParams, { limit: 1000 });
  const continuation = start.contextualSuggestions.find((suggestion) => suggestion.kind === "three-way");

  assert.ok(continuation, "the real project scope advertises its accepted three-way continuation");
  assert.equal(continuation.count, bundle.browse_scope.result_count);
  assert.deepEqual(continuation.refs, bundle.refs);
  assert.equal(continuation.href, bundle.browse_scope.href);
  assert.equal(
    new URL(continuation.href, "https://cityscroll.org").href,
    new URL(bundle.browse_scope.href, "https://cityscroll.org").href,
    "the accepted bundle supplies one stable live URL",
  );

  const destination = buildBrowseView("property", propertyPayload, hrefParams(continuation.href), { limit: 1000 });
  assert.equal(destination.total, 1);
  assert.deepEqual(destination.rows.map((row) => `notice:${row.request_id}`), [bundle.subject_ref]);
  assert.ok(destination.contextualSuggestions.some((suggestion) => (
    suggestion.kind === "follow" && suggestion.count === destination.total
  )));

  const chips = [...renderBrowseView(destination).matchAll(/href="([^"]+)" class="x-remove-scope"/g)];
  assert.equal(chips.length, 3, "all three constraints remain individually removable");
  for (const [, href] of chips) {
    const reverse = buildBrowseView("property", propertyPayload, hrefParams(href), { limit: 1000 });
    assert.equal(reverse.scope.refs.length, 2);
    assert.ok(reverse.total > 0, "each reverse traversal lands on a positive two-way intersection");
  }
});

test("destination approval is fail-closed for broken pivots", () => {
  const suggestions = buildContextualSuggestions({
    scope: scopeFromRouteHash("#money?q=school"),
    surface: "money",
    route: "/browse/contracts/",
    resultCount: 4,
    edgeInventory: [{ ref: "agency:id:broken", kind: "agency", count: 4, pivotHref: "/agencies/broken/" }],
    destinationCheck: (suggestion) => suggestion.kind !== "pivot",
  });
  assert.doesNotMatch(renderContextualSuggestions(suggestions), /data-suggestion-kind="pivot"/);
  assert.ok(suggestions.every((suggestion) => suggestion.kind !== "pivot"));
});

test("production destination approval suppresses entity routes until they are documents", () => {
  assert.equal(productionDestinationCheck({ kind: "pivot", href: "/agencies/hpd/" }), false);
  assert.equal(productionDestinationCheck({ kind: "pivot", href: "/vendors/hntb/" }), false);
  assert.equal(productionDestinationCheck({ kind: "pivot", href: "/officials/7801/" }), false);
  assert.equal(productionDestinationCheck({ kind: "pivot", href: "/browse/contracts/?facet=%7B%7D" }), true);
  assert.equal(productionDestinationCheck({ kind: "intersect", href: "/agencies/hpd/" }), true);
});

test("the production default destination check is applied without a test-only callback", () => {
  const suggestions = buildContextualSuggestions({
    scope: scopeFromRouteHash("#money?q=school"),
    surface: "money",
    route: "/browse/contracts/",
    resultCount: 4,
    edgeInventory: [{ ref: "agency:id:broken", kind: "agency", count: 4, pivotHref: "/agencies/broken/" }],
  });
  assert.ok(suggestions.every((suggestion) => suggestion.kind !== "pivot"));
});
