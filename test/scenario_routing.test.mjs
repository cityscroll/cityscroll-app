import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const analytics = readFileSync(new URL("../analytics.js", import.meta.url), "utf8");

const EXPECTED = new Map([
  ["city-work", ["money"]],
  ["neighborhood", ["land", "property", "meetings"]],
  ["hearings", ["meetings", "rules"]],
  ["city-career", ["people"]],
  ["subsidies-land-use", ["meetings", "land"]],
  ["legal-compliance", ["property", "rules", "meetings"]],
]);

function routeTags() {
  return [...html.matchAll(
    /<a class="scenario-route" href="([^"]+)" data-scenario="([^"]+)" data-scenario-lens="([^"]+)"/g,
  )].map((match) => ({ href: match[1].replace(/&amp;/g, "&"), scenario: match[2], lens: match[3] }));
}

test("the task-first layer is additive and leaves every category lens tab in place", () => {
  assert.match(html, /<section class="scenario-nav wrap" aria-labelledby="scenario-heading">/);
  for (const lens of ["money", "people", "land", "property", "rules", "meetings", "alerts"]) {
    assert.match(html, new RegExp(`<button class="tabbtn[^"]*" data-tab="${lens}"`));
  }
});

test("every declared scenario maps only to static existing-lens hashes", () => {
  const routes = routeTags();
  assert.ok(routes.length >= 11, "the six scenarios should expose their useful cross-lens routes");
  for (const [scenario, lenses] of EXPECTED) {
    assert.deepEqual(
      [...new Set(routes.filter((route) => route.scenario === scenario).map((route) => route.lens))],
      lenses,
    );
  }
  for (const route of routes) {
    assert.ok(route.href.startsWith(`#${route.lens}`), `${route.scenario} route should open ${route.lens}`);
    assert.doesNotMatch(route.href, /^https?:/, "scenario routing must stay static and local");
  }
});

test("high-intent scenarios arrive with useful precomputed filters", () => {
  const routes = routeTags();
  assert.ok(routes.some((route) => route.scenario === "city-work" && route.href === "#money?mode=open&closing=week"));
  assert.ok(routes.some((route) => route.scenario === "subsidies-land-use" && route.href === "#meetings?when=upcoming&q=IDA"));
  assert.ok(routes.some((route) => route.scenario === "legal-compliance" && route.href === "#property?asset=realty"));
});

test("scenario measurement records only bounded declared task and route values", () => {
  assert.match(analytics, /target\.matches\("\[data-scenario\]\[data-scenario-lens\]"\)/);
  assert.match(analytics, /record\("scenario_open"/);
  assert.match(analytics, /lens:\s*target\.dataset\.scenarioLens/);
  assert.match(analytics, /detail:\s*target\.dataset\.scenario/);
  assert.doesNotMatch(analytics, /scenario_open[\s\S]{0,240}(visitor|identity|profile|raw_query)/i);
});
