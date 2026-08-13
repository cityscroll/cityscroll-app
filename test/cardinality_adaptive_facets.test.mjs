import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { AGENCY_GROUPS } from "../site/agency_identity.mjs";
import { agencyScopeLinksHTML } from "../site/agency_scope_links.mjs";
import { constellationLink, filterChip, officialSourceLink, staticFact } from "../site/affordance_grammar.mjs";

const shell = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");

test("shared affordance primitives keep navigation, sources, filters, and facts distinct", () => {
  assert.match(constellationLink({ href: "/agencies/buildings/", label: "Buildings" }), /class="ui-constellation-link"[^>]*href="\/agencies\/buildings\/"[^>]*><span aria-hidden="true">◆<\/span>/);
  assert.match(officialSourceLink({ href: "https://example.gov/record", label: "Official record" }), /class="ui-official-source-link"[^>]*target="_blank" rel="noopener noreferrer"[^>]*>.*↗/);
  assert.match(filterChip({ label: "Anyone", pressed: true }), /<button type="button" class="ui-filter-chip" aria-pressed="true"/);
  assert.match(staticFact({ label: "Published today" }), /<span class="ui-static-fact">Published today<\/span>/);
});

test("small facets use inline links while large agency facets use a searchable typeahead", () => {
  const small = agencyScopeLinksHTML({ surface: "rules", agencies: Object.keys(AGENCY_GROUPS).slice(0, 3) });
  assert.match(small, /data-cardinality-facet="small"/);
  assert.doesNotMatch(small, /role="combobox"|<select/);
  assert.match(small, /class="ui-filter-chip/);

  const large = agencyScopeLinksHTML({
    surface: "rules",
    agencies: Object.keys(AGENCY_GROUPS).slice(0, 12),
    searchQuery: "health",
    t: (key) => ({ agency_label: "Agency", all_agencies: "All agencies" })[key] || key,
  });
  assert.match(large, /data-cardinality-facet="large"/);
  assert.match(large, /type="search"[^>]*role="combobox"[^>]*aria-autocomplete="list"/);
  assert.match(large, /placeholder="Type to filter agency"/);
  assert.match(large, /href="\/agencies\/[^/]+\/" data-agency-entity-link=/);
  assert.match(large, /class="ui-constellation-link facet-entity-link"/);
  assert.match(large, /class="ui-filter-chip" aria-pressed=/);
  assert.match(large, /data-agency-scope-link=/);
  assert.match(large, /class="facet-typeahead-input"[^>]*value="health"/);
  assert.doesNotMatch(large, /<select/);
});

test("unresolved agency names remain visible as plain text", () => {
  const knownAgency = Object.keys(AGENCY_GROUPS).find((name) => /Buildings$/.test(name));
  const unresolvedAgency = ["Unresolved", "agency", "fixture"].join(" ");
  const html = agencyScopeLinksHTML({
    surface: "rules",
    // Synthetic unresolved label: source is this test fixture, not a public agency claim.
    agencies: [knownAgency, unresolvedAgency],
  });
  assert.match(html, new RegExp(unresolvedAgency));
  assert.match(html, /class="ui-static-fact facet-unresolved-option"/);
  assert.doesNotMatch(html, /href="[^"]*Unresolved|data-agency-entity-link="[^"]*unresolved/i);
});

test("Staffing keeps non-geographic actions out and renders eligibility as a chip group", () => {
  const staffing = shell.slice(shell.indexOf('id="tab-people"'), shell.indexOf('id="tab-land"'));
  assert.doesNotMatch(staffing, /data-near-you-link|See on map/);
  assert.match(staffing, /id="career-eligibility-facets"[^>]*role="group"/);
  assert.match(staffing, /id="career-eligibility" hidden aria-hidden="true" tabindex="-1"/);
});
