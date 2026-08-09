import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  constellationLink,
  filterChip,
  officialSourceLink,
  staticFact,
} from "../site/affordance_grammar.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(ROOT, path), "utf8");

test("shared primitives emit the complete four-class grammar", () => {
  const constellation = constellationLink({ href: "/agencies/example/", label: "Example" });
  assert.match(constellation, /^<a class="ui-constellation-link"/);
  assert.match(constellation, /<span aria-hidden="true">◆<\/span>/);
  assert.doesNotMatch(constellation, /target=/);

  const source = officialSourceLink({ href: "https://example.gov/record", label: "Official record" });
  assert.match(source, /target="_blank" rel="noopener noreferrer"/);
  assert.match(source, /<span aria-hidden="true">↗<\/span>/);

  const chip = filterChip({ label: "Open", count: 3, pressed: true, attributes: { "data-filter-href": "#money" } });
  assert.match(chip, /^<button type="button" class="ui-filter-chip" aria-pressed="true"/);
  assert.match(chip, /data-filter-href="#money"/);
  assert.match(chip, /<span class="ct">3<\/span>/);
  assert.doesNotMatch(chip, /\shref=/);
  assert.doesNotMatch(chip, /aria-current=/);

  const fact = staticFact({ label: "Unresolved agency" });
  assert.match(fact, /^<span class="ui-static-fact">/);
  assert.doesNotMatch(fact, /href=|cursor:pointer|text-decoration/);
});

test("scope rails do not regress into navigational links styled as chips", () => {
  const files = [
    "site/index.html",
    "site/following/index.html",
    "site/borough_scope_links.mjs",
    "site/following_view.mjs",
    "site/property_disposition_facets_ui.mjs",
    "site/app/property.mjs",
    "site/app/entities.mjs",
    "site/app/people.mjs",
  ];
  for (const file of files) {
    const source = read(file);
    assert.doesNotMatch(source, /<a\b[^>]*class="[^"]*\bchip\b[^\"]*"[^>]*href=/, `${file}: chip links are not filter controls`);
    assert.doesNotMatch(source, /href=[^>]+class="[^"]*\bchip\b/, `${file}: chip links are not filter controls`);
  }
});

test("static fallback scope controls are buttons with pressed state and destinations", () => {
  const index = read("site/index.html");
  for (const marker of ["data-money-mode", "data-money-location-basis", "data-money-temporal"]) {
    assert.match(index, new RegExp(`[^>]*${marker}[^>]*aria-pressed="(?:true|false)"`), `${marker} has aria-pressed`);
  }
  assert.match(index, /id="land-attendance-rail"><button[^>]*aria-pressed="true"/);
  assert.match(index, /id="rules-agency-rail"><button[^>]*aria-pressed="true"/);
  assert.doesNotMatch(index, /<a\b[^>]*(?:data-money-mode|data-money-location-basis|data-money-temporal)/);
});
