import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
const analytics = readFileSync(new URL("../site/analytics.js", import.meta.url), "utf8");

// Homepage no longer ships the "What are you here to do?" scenario grid (owner noise cut).
// Category tabs and task-first deep links remain; analytics still tolerates scenario attributes
// if they reappear elsewhere.

test("homepage scenario grid is gone; every category lens tab remains", () => {
  assert.doesNotMatch(html, /scenario-nav/);
  assert.doesNotMatch(html, /class="scenario-route"/);
  assert.doesNotMatch(html, /data-i18n="scenario_heading"/);
  for (const lens of ["money", "people", "land", "property", "rules", "meetings", "alerts"]) {
    assert.match(html, new RegExp(`data-tab="${lens}"`));
  }
});

test("scenario measurement code stays bounded if attributes reappear", () => {
  assert.match(analytics, /target\.matches\("\[data-scenario\]\[data-scenario-lens\]"\)/);
  assert.match(analytics, /record\("scenario_open"/);
  assert.match(analytics, /lens:\s*target\.dataset\.scenarioLens/);
  assert.match(analytics, /detail:\s*target\.dataset\.scenario/);
  assert.doesNotMatch(analytics, /scenario_open[\s\S]{0,240}(visitor|identity|profile|raw_query)/i);
});
