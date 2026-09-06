import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { SITE_SOURCE } from "./helpers/site_source.mjs";

const read = (path) => readFileSync(new URL(`../site/${path}`, import.meta.url), "utf8");

test("interactive pages default to the production API origin", () => {
  for (const page of ["index.html", "about.html", "api.html"]) {
    const source = page === "index.html" ? SITE_SOURCE : read(page);
    assert.match(source, /window\.CROL_API_ORIGIN \|\| "https:\/\/api\.cityscroll\.org"/, page);
    assert.match(
      source,
      /window\.CROL_API_FALLBACK_ORIGIN \|\| "https:\/\/cityscroll-worker\.crol-worker\.workers\.dev"/,
      page,
    );
  }
  // Stats reads a materialised artifact from its own origin, so it configures no API origin.
  assert.doesNotMatch(read("stats.html"), /window\.CROL_API_ORIGIN/);
  assert.match(read("stats.html"), /fetch\("data\/served_coverage_snapshot\.json"/);
  assert.match(read("analytics.js"), /window\.CROL_API_ORIGIN/);
});
