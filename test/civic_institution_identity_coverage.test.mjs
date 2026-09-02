import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { AGENCY_CONSTELLATION_SECTIONS } from "../site/agency_constellation_section_registry.mjs";
import {
  buildAgencyConstellationView,
  renderAgencyConstellationDeferredFragment,
  renderAgencyConstellationDocument,
} from "../site/agency_constellation.mjs";
import {
  AGENCY_IDENTITY_COVERAGE_ANCHOR,
  AGENCY_IDENTITY_COVERAGE_SCHEMA,
  projectAgencyIdentityCoverage,
  renderAgencyIdentityCoverage,
  renderAgencyIdentityCoverageSection,
} from "../site/civic_institution_identity_coverage.mjs";
import {
  CATEGORY_EVIDENCE_STATES,
  defaultRouteIdentityReport,
  projectInstitutionProfileNavigation,
} from "../site/civic_institution_profile_navigation.mjs";
import { buildAgencyIdentityEvidence } from "../tools/lib/agency_identity_evidence.mjs";
import edgeWorker from "../site/pages_edge.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = JSON.parse(
  readFileSync(new URL("./fixtures/civic_institution_identity_coverage/cases.json", import.meta.url), "utf8"),
);
const LOOKUP = JSON.parse(readFileSync(join(ROOT, "site/data/agency_constellation_lookup.json"), "utf8"));
const REPORT = JSON.parse(readFileSync(join(ROOT, "site/data/agency_route_identity_report.json"), "utf8"));
const CROSSWALK = JSON.parse(readFileSync(join(ROOT, "worker/src/data/agency_crosswalk.json"), "utf8"));
const BOARD_LOOKUP = JSON.parse(
  readFileSync(join(ROOT, "site/data/community_board_constellation_lookup.json"), "utf8"),
);
const SOURCES = {
  intelligence: JSON.parse(readFileSync(join(ROOT, "site/data/entity_intelligence_lookup.json"), "utf8")),
  certification: JSON.parse(readFileSync(join(ROOT, "site/data/exam_certification_constellation.json"), "utf8")),
  staffing_exams: JSON.parse(readFileSync(join(ROOT, "site/data/staffing_exams.json"), "utf8")),
  obligations: JSON.parse(readFileSync(join(ROOT, "site/data/agency_obligations_lookup.json"), "utf8")),
};

function lookupView(id) {
  const row = LOOKUP.by_id[id];
  assert.ok(row, `missing lookup for ${id}`);
  return {
    canonical_id: id,
    id,
    display_name: row.display_name,
    path: row.path,
    subject_ref: row.subject_ref,
    categories: Object.entries(row.categories || {}).map(([categoryId, category]) => ({
      id: categoryId,
      ...category,
    })),
    summary: { generated_at: LOOKUP.generated_at || FIXTURES.as_of },
  };
}

function coverageFor(canonicalId, canonicalName) {
  const view = lookupView(canonicalId);
  const identity = { canonical_id: canonicalId, canonical_name: canonicalName };
  const evidence = buildAgencyIdentityEvidence({
    identity,
    publisherRow: CROSSWALK.entries[canonicalId],
    view,
    generatedAt: `${FIXTURES.as_of}T00:00:00.000Z`,
  });
  const navigation = projectInstitutionProfileNavigation({
    view: { ...view, identity_evidence: evidence },
    identity,
    identityEvidence: evidence,
    publisherRow: CROSSWALK.entries[canonicalId],
    routeIdentityReport: REPORT,
  });
  return { navigation, coverage: projectAgencyIdentityCoverage(navigation) };
}

function uncertaintyCoverage(routeId, { hasRoute }) {
  const navigation = projectInstitutionProfileNavigation({
    identity: { canonical_id: routeId, canonical_name: routeId.replace(/-/g, " ") },
    publisherRow: null,
    hasRoute,
    routeIdentityReport: REPORT,
  });
  return { navigation, coverage: projectAgencyIdentityCoverage(navigation) };
}

function categoryState(coverage, id) {
  return coverage.category_states.find((row) => row.id === id);
}

// A1 [outcome] [G1]
test("A1 DSNY and NYCEDC expose a concise capability summary on the ordinary agency profile", () => {
  for (const specimen of [FIXTURES.dsny, FIXTURES.nycedc]) {
    const { coverage } = coverageFor(specimen.canonical_id, specimen.canonical_name);
    assert.equal(coverage.schema, AGENCY_IDENTITY_COVERAGE_SCHEMA);
    assert.equal(coverage.anchor, AGENCY_IDENTITY_COVERAGE_ANCHOR);
    assert.equal(coverage.subject_ref, specimen.subject_ref);

    // The summary is a concise state tally, not a per-record dump.
    assert.match(coverage.summary.headline, /^\d+ [a-z]/);
    assert.ok(coverage.summary.headline.length <= 90, coverage.summary.headline);
    assert.ok(coverage.summary.supported_count >= 1, specimen.canonical_id);

    // Every summarized capability names a followable path.
    for (const row of coverage.supported_capabilities) {
      assert.ok(row.href, `${specimen.canonical_id}/${row.id} has no path`);
      assert.ok(row.source_basis, `${specimen.canonical_id}/${row.id} has no basis`);
    }

    for (const id of specimen.expected_matched_categories) {
      assert.equal(categoryState(coverage, id)?.state, "matched", `${specimen.canonical_id}/${id}`);
    }
    for (const id of specimen.expected_empty_categories || []) {
      assert.equal(categoryState(coverage, id)?.state, "empty", `${specimen.canonical_id}/${id}`);
    }
  }
});

test("A1 DSNY keeps its six-category stable route and NYCEDC keeps a present route", () => {
  const dsny = coverageFor(FIXTURES.dsny.canonical_id, FIXTURES.dsny.canonical_name).coverage;
  assert.equal(dsny.category_states.filter((row) => row.state === "matched").length, 6);
  assert.equal(dsny.identity.route, `/agencies/${FIXTURES.dsny.canonical_id}/`);

  const edc = coverageFor(FIXTURES.nycedc.canonical_id, FIXTURES.nycedc.canonical_name).coverage;
  assert.equal(edc.identity.route, `/agencies/${FIXTURES.nycedc.canonical_id}/`);
});

test("A1 the profile renders one inspectable identity-and-coverage disclosure", () => {
  const { navigation, coverage } = coverageFor(FIXTURES.dsny.canonical_id, FIXTURES.dsny.canonical_name);
  const html = renderAgencyIdentityCoverageSection(navigation);

  // Exactly one disclosure block, reached from the ordinary profile anchor.
  assert.equal(html.match(/id="agency-identity-and-coverage"/g).length, 1);
  assert.equal(html.match(/<details/g).length, 1);
  assert.match(html, /<summary>Identity and coverage details<\/summary>/);
  assert.match(html, /data-coverage-headline="1"/);
  assert.ok(html.includes(coverage.summary.headline));

  // Inspection names source identity, category state, basis, and vintage.
  assert.match(html, /Source identity/);
  assert.match(html, new RegExp(`Source id ${FIXTURES.dsny.canonical_id}`));
  assert.match(html, /Basis /);
  assert.match(html, /As of \d{4}-\d{2}-\d{2}/);
  assert.match(html, /Record categories/);
  assert.match(html, /data-category="contracts"/);

  // The block stays inside the established profile section contract.
  assert.match(html, /id="institution-profile-navigation"/);
});

test("A1 the disclosure ships in what the ordinary DSNY and NYCEDC routes serve", () => {
  for (const specimen of [FIXTURES.dsny, FIXTURES.nycedc]) {
    const view = buildAgencyConstellationView(specimen.canonical_id, SOURCES);
    // The agency route serves this fragment into the profile document.
    const fragment = renderAgencyConstellationDeferredFragment(view);
    assert.match(fragment, /id="agency-identity-and-coverage"/, specimen.canonical_id);
    assert.match(fragment, /data-coverage-headline="1"/, specimen.canonical_id);
    assert.equal(
      fragment.match(/id="agency-identity-and-coverage"/g).length,
      1,
      `${specimen.canonical_id} must disclose exactly once`,
    );

    const document = renderAgencyConstellationDocument(view);
    assert.match(
      document,
      /data-civic-object-deferred-href="[^"]*relationships\.json"/,
      specimen.canonical_id,
    );
    // First paint stays compact: the disclosure is not duplicated into it.
    assert.doesNotMatch(document, /id="agency-identity-and-coverage"/, specimen.canonical_id);
  }
});

// A2 [boundary] [G2]
test("A2 the agency index keeps its scale with no role filters or evidence chips", () => {
  const index = readFileSync(join(ROOT, "site/agencies/index.html"), "utf8");
  assert.match(index, /<h1>City agencies<\/h1>/);
  assert.doesNotMatch(index, /agency-identity-and-coverage/);
  assert.doesNotMatch(index, /institution-profile-navigation/);
  assert.doesNotMatch(index, /agency-coverage-/);
  assert.doesNotMatch(index, /data-role-filter/);
  assert.doesNotMatch(index, /data-coverage-schema/);
  assert.doesNotMatch(index, /data-evidence-state/);
});

test("A2 the disclosure stays one profile section rather than new index chrome", () => {
  const ids = AGENCY_CONSTELLATION_SECTIONS.map((section) => section.id);
  assert.equal(ids.filter((id) => id === "institution-navigation").length, 1);
  // No second institution taxonomy was introduced alongside the disclosure.
  assert.equal(ids.filter((id) => id.includes("identity-and-coverage")).length, 0);
});

// A3 [verification] [G3]
test("A3 collision and unresolved routes name evidence state, basis, and vintage without linking", () => {
  const collision = uncertaintyCoverage(FIXTURES.eep.route_id, { hasRoute: false });
  assert.equal(collision.coverage.identity.status, "collision");
  assert.equal(collision.coverage.identity.linking, false);
  assert.equal(collision.coverage.identity.comparison_key, FIXTURES.eep.comparison_key);
  assert.deepEqual([...collision.coverage.identity.collision_ids].sort(), [...FIXTURES.eep.collision_ids].sort());
  assert.ok(collision.coverage.identity.basis);
  assert.match(collision.coverage.identity.vintage, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(collision.coverage.summary.supported_count, 0);
  // A withheld identity is disclosed as withheld, never as absent activity.
  assert.match(collision.coverage.summary.copy, /withheld instead of guessed/);
  assert.doesNotMatch(collision.coverage.summary.copy, /no activity|does not exist/i);

  const collisionHtml = renderAgencyIdentityCoverage(collision.coverage);
  assert.match(collisionHtml, /data-identity-state="collision"/);
  assert.doesNotMatch(collisionHtml, /<a[^>]+href="\/agencies\//);

  for (const routeId of FIXTURES.unresolved) {
    const { coverage } = uncertaintyCoverage(routeId, { hasRoute: true });
    assert.equal(coverage.identity.status, "unresolved", routeId);
    assert.equal(coverage.identity.linking, false, routeId);
    assert.ok(coverage.identity.basis, routeId);
    assert.match(coverage.identity.vintage, /^\d{4}-\d{2}-\d{2}$/, routeId);
    assert.equal(coverage.summary.supported_count, 0, routeId);
    assert.match(coverage.summary.copy, /withheld instead of guessed/, routeId);
    const html = renderAgencyIdentityCoverage(coverage);
    assert.doesNotMatch(html, /<a[^>]+href="\/agencies\//, routeId);
    // Withholding is disclosed on the page, not silently omitted.
    assert.match(html, /not inferred/, routeId);
  }
});

test("A3 empty categories report a snapshot gap with basis and vintage, not zero activity", () => {
  const { coverage } = coverageFor(FIXTURES.nycedc.canonical_id, FIXTURES.nycedc.canonical_name);
  const empties = coverage.category_states.filter((row) => row.state === "empty");
  assert.ok(empties.length >= 1);
  for (const row of empties) {
    assert.ok(row.source_basis, `${row.id} has no basis`);
    assert.match(row.vintage, /^\d{4}-\d{2}-\d{2}$/, row.id);
    assert.match(row.copy, /not proof this institution has none/i, row.id);
    assert.equal(row.href, null, `${row.id} must not link an empty category`);
  }

  const html = renderAgencyIdentityCoverage(coverage);
  assert.match(html, /empty in this snapshot/);
  assert.doesNotMatch(html, /no activity/i);
});

test("A3 every disclosed state stays inside the declared evidence vocabulary", () => {
  const { coverage } = coverageFor(FIXTURES.dsny.canonical_id, FIXTURES.dsny.canonical_name);
  for (const row of [...coverage.category_states, ...coverage.capability_states]) {
    assert.ok(CATEGORY_EVIDENCE_STATES.includes(row.state), `${row.id}=${row.state}`);
    assert.ok(row.source_basis, `${row.id} has no basis`);
  }
  const counts = coverage.summary.counts;
  assert.equal(
    counts.matched + counts.empty + counts.unknown + counts.blocked,
    coverage.capability_states.length,
  );
});

test("A3 OTI classification and Community Board identity stay disclosed, never an institution kind", () => {
  const { coverage } = coverageFor(FIXTURES.dsny.canonical_id, FIXTURES.dsny.canonical_name);
  assert.equal(coverage.identity.classification_status, "unclassified");

  const blocked = coverage.capability_states.filter((row) => row.state === "blocked").map((row) => row.id);
  assert.ok(blocked.includes("institution_kind"));
  assert.ok(blocked.includes("community_board_child"));

  const html = renderAgencyIdentityCoverage(coverage);
  // Publisher organization type is disclosed as source vocabulary only.
  assert.match(html, /publisher organization type is source vocabulary/i);
  assert.match(html, /board-local body ids/i);

  // Community Board body identity is untouched by this disclosure.
  assert.equal(BOARD_LOOKUP.by_id[FIXTURES.board_id].body_id, FIXTURES.board_body_id);
});

test("A3 uncertainty stop pages serve the same disclosure at the ordinary agency route", async () => {
  const env = {
    ASSETS: {
      fetch: async () => new Response(
        "<title>CityScroll</title><div id=\"entityview\">Agency profile</div>",
        { headers: { "Content-Type": "text/html" } },
      ),
    },
  };
  for (const [routeId, state] of [
    [FIXTURES.eep.route_id, "collision"],
    [FIXTURES.unresolved[0], "unresolved"],
  ]) {
    const response = await edgeWorker.fetch(new Request(`https://cityscroll.org/agencies/${routeId}/`), env);
    assert.equal(response.status, 200, routeId);
    const body = await response.text();
    assert.match(body, /id="agency-identity-and-coverage"/, routeId);
    assert.match(body, new RegExp(`data-identity-state="${state}"`), routeId);
    assert.match(body, /Source report agency route identity report/, routeId);
    assert.doesNotMatch(body, /id="entityview"/, routeId);
  }
});

test("A3 reviewed route aliases stay the only linking alias projection", () => {
  const aliasTarget = defaultRouteIdentityReport.cases.find(
    (row) => row.redirect_from === `/agencies/${FIXTURES.housing_alias}/`,
  );
  assert.ok(aliasTarget, "expected the reviewed housing alias case");
  const { coverage } = coverageFor("housing-authority", "New York City Housing Authority");
  const incoming = coverage.route_aliases.incoming.map((edge) => edge.source_id);
  assert.ok(incoming.includes(FIXTURES.housing_alias));
  for (const edge of coverage.route_aliases.incoming) {
    assert.equal(edge.collision, false);
    assert.ok(edge.disposition_basis);
    assert.ok(edge.source_report);
  }
});
