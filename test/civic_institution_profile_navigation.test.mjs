import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { AGENCY_GROUPS, agencyCanonicalId } from "../site/agency_identity.mjs";
import { AGENCY_CONSTELLATION_SECTIONS } from "../site/agency_constellation_section_registry.mjs";
import {
  CATEGORY_EVIDENCE_STATES,
  INSTITUTION_PROFILE_NAVIGATION_SCHEMA,
  ROUTE_ALIAS_OF_RELATION,
  agencyRouteUncertaintyKind,
  defaultRouteIdentityReport,
  projectInstitutionProfileNavigation,
  projectReviewedRouteAliases,
  renderInstitutionProfileNavigation,
  renderInstitutionUncertaintyDocument,
} from "../site/civic_institution_profile_navigation.mjs";
import {
  NYCEDC_CANONICAL_ID,
  WILLETS_POINT_PARCEL_BBL,
  WILLETS_POINT_PROJECT_ID,
  resolveNycEdcDevelopmentRoles,
} from "../site/civic_institution_development_roles.mjs";
import {
  NYCHA_BOARD_MEETING_ID,
  NYCHA_CANONICAL_ID,
} from "../site/civic_institution_governing_bodies.mjs";
import { loadOntologyRegistry } from "../ontology/index.mjs";
import { buildAgencyIdentityEvidence } from "../tools/lib/agency_identity_evidence.mjs";
import { renderAgencyIndex } from "../tools/build_agency_documents.mjs";
import edgeWorker from "../site/pages_edge.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = JSON.parse(
  readFileSync(new URL("./fixtures/civic_institution_profile_navigation/cases.json", import.meta.url), "utf8"),
);
const LOOKUP = JSON.parse(readFileSync(join(ROOT, "site/data/agency_constellation_lookup.json"), "utf8"));
const REPORT = JSON.parse(readFileSync(join(ROOT, "site/data/agency_route_identity_report.json"), "utf8"));
const REGISTRY = JSON.parse(readFileSync(join(ROOT, "ontology/registry.v0.json"), "utf8"));
const CROSSWALK = JSON.parse(readFileSync(join(ROOT, "worker/src/data/agency_crosswalk.json"), "utf8"));
const BOARD_LOOKUP = JSON.parse(
  readFileSync(join(ROOT, "site/data/community_board_constellation_lookup.json"), "utf8"),
);

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
    summary: { generated_at: LOOKUP.generated_at || "2026-08-31" },
  };
}

function dsnyProjection() {
  const identity = FIXTURES.dsny;
  const evidence = buildAgencyIdentityEvidence({
    identity,
    publisherRow: CROSSWALK.entries[identity.canonical_id],
    view: lookupView(identity.canonical_id),
    generatedAt: "2026-08-31T00:00:00.000Z",
  });
  return projectInstitutionProfileNavigation({
    view: { ...lookupView(identity.canonical_id), identity_evidence: evidence },
    identity,
    identityEvidence: evidence,
    publisherRow: CROSSWALK.entries[identity.canonical_id],
    routeIdentityReport: REPORT,
  });
}

function nycedcProjection() {
  const identity = FIXTURES.nycedc;
  const development = resolveNycEdcDevelopmentRoles({
    project: {
      project_id: WILLETS_POINT_PROJECT_ID,
      project_name: "Willets Point Phase II Mapping Actions",
      primary_applicant: "EDC - Economic Development Corporation for NYC",
      current_milestone_date: "2024-06-01",
    },
    projectBbls: [WILLETS_POINT_PARCEL_BBL],
  });
  const evidence = buildAgencyIdentityEvidence({
    identity,
    publisherRow: CROSSWALK.entries[identity.canonical_id],
    view: lookupView(identity.canonical_id),
    generatedAt: "2026-08-31T00:00:00.000Z",
    developmentRoleSources: {
      project: {
        project_id: WILLETS_POINT_PROJECT_ID,
        project_name: "Willets Point Phase II Mapping Actions",
        primary_applicant: "EDC - Economic Development Corporation for NYC",
        current_milestone_date: "2024-06-01",
      },
      projectBbls: [WILLETS_POINT_PARCEL_BBL],
    },
  });
  assert.equal(development.accepted.some((edge) => edge.relation_id === "applicant_on"), true);
  return projectInstitutionProfileNavigation({
    view: { ...lookupView(identity.canonical_id), identity_evidence: evidence },
    identity,
    identityEvidence: evidence,
    publisherRow: CROSSWALK.entries[identity.canonical_id],
    routeIdentityReport: REPORT,
  });
}

test("registry registers route_alias_of without renaming agency identity", () => {
  const registry = loadOntologyRegistry();
  const link = registry.link_types.find((row) => row.id === ROUTE_ALIAS_OF_RELATION);
  const agency = registry.object_types.find((row) => row.id === "agency");
  const property = registry.object_types.find((row) => row.id === "property_site");
  const person = registry.object_types.find((row) => row.id === "person-leader");
  assert.equal(link.status, "registered");
  assert.equal(link.inverse, "has_route_alias");
  assert.deepEqual(link.required_evidence, [
    "source_id",
    "canonical_id",
    "redirect_path",
    "disposition_basis",
    "non_collision_status",
  ]);
  assert.match(link.negative_rule, /Colliding comparison keys/);
  assert.equal(agency.primary_key_pattern, "agency:{canonical_id|name}");
  assert.equal(property.primary_key_pattern, "disposition:{agency}:{bbl|taxlot}|notice:{notice_id}");
  assert.equal(person.primary_key_pattern, "person-leader:{agency_id}:{person_id|name}");
});

test("reviewed aliases project through route_alias_of and skip generic or colliding paths", () => {
  const aliases = projectReviewedRouteAliases(REPORT);
  const housing = aliases.find((edge) => edge.source_id === FIXTURES.housing_alias);
  assert.equal(housing.relation_id, ROUTE_ALIAS_OF_RELATION);
  assert.equal(housing.canonical_id, NYCHA_CANONICAL_ID);
  assert.equal(housing.redirect_path, "/agencies/n-y-c-housing-authority/");
  assert.equal(housing.href, "/agencies/housing-authority/");
  assert.equal(housing.collision, false);
  assert.ok(housing.disposition_basis);
  assert.equal(aliases.some((edge) => edge.source_id === "board-meetings"), false);
  assert.equal(aliases.some((edge) => edge.source_id === "nyc-taxi-and-limousine-commission"), false);
  assert.equal(aliases.some((edge) => edge.source_id === "equal-employ-practices-comm"), false);
  assert.equal(aliases.every((edge) => edge.source_id !== edge.canonical_id), true);
});

test("DSNY exposes six-category states and unclassified kind with source basis", () => {
  const projection = dsnyProjection();
  assert.equal(projection.schema, INSTITUTION_PROFILE_NAVIGATION_SCHEMA);
  assert.equal(projection.identity.subject_ref, "agency:id:sanitation");
  assert.equal(projection.identity.route, "/agencies/sanitation/");
  assert.equal(projection.identity.institution_kind, null);
  assert.equal(projection.identity.classification_status, "unclassified");
  const byId = Object.fromEntries(projection.category_states.map((row) => [row.id, row]));
  for (const id of ["contracts", "vendors", "meetings", "rules", "obligations", "staffing"]) {
    assert.equal(byId[id].state, "matched");
    assert.ok(byId[id].source_basis);
    assert.ok(CATEGORY_EVIDENCE_STATES.includes(byId[id].state));
  }
  const kind = projection.role_capabilities.find((row) => row.id === "institution_kind");
  assert.equal(kind.state, "blocked");
  const html = renderInstitutionProfileNavigation(projection);
  assert.match(html, /id="institution-profile-navigation"/);
  assert.match(html, /data-identity-state="matched"/);
  assert.match(html, /data-category="contracts"[^>]*data-evidence-state="matched"/);
  assert.doesNotMatch(html, /institution kind: Mayoral Agency/i);
  assert.doesNotMatch(html, /role-capability filter/i);
});

test("NYCEDC project navigation is a typed link with parcel trail and empty categories stay empty", () => {
  const projection = nycedcProjection();
  const projects = projection.role_capabilities.find((row) => row.id === "projects");
  assert.equal(projects.state, "matched");
  assert.equal(projects.record_href, `/browse/zoning/#land/${WILLETS_POINT_PROJECT_ID}`);
  assert.equal(
    projects.parcel_hrefs.some((href) => href.includes(WILLETS_POINT_PARCEL_BBL)),
    true,
  );
  const empty = projection.category_states.filter((row) => row.state === "empty").map((row) => row.id);
  assert.deepEqual(empty.sort(), ["contracts", "meetings", "obligations", "rules", "staffing", "vendors"].sort());
  assert.equal(empty.every((id) => projection.category_states.find((row) => row.id === id).count === 0), true);
  const html = renderInstitutionProfileNavigation(projection);
  assert.match(html, /href="\/browse\/zoning\/#land\/2024Q0135"/);
  assert.match(html, /href="\/parcels\/4018200001/);
  assert.match(html, /data-category="vendors"[^>]*data-evidence-state="empty"/);
  assert.match(html, /not proof this institution has none/);
  assert.doesNotMatch(html, /\/agencies\/\?q=/);
});

test("housing-authority incoming alias and NYCHA meeting remain source-qualified", () => {
  const evidence = buildAgencyIdentityEvidence({
    identity: {
      canonical_id: NYCHA_CANONICAL_ID,
      canonical_name: "New York City Housing Authority",
    },
    publisherRow: CROSSWALK.entries[NYCHA_CANONICAL_ID],
    view: lookupView(NYCHA_CANONICAL_ID),
    generatedAt: "2026-08-31T00:00:00.000Z",
  });
  const projection = projectInstitutionProfileNavigation({
    view: { ...lookupView(NYCHA_CANONICAL_ID), identity_evidence: evidence },
    identity: { canonical_id: NYCHA_CANONICAL_ID, canonical_name: "New York City Housing Authority" },
    identityEvidence: evidence,
    publisherRow: CROSSWALK.entries[NYCHA_CANONICAL_ID],
    routeIdentityReport: REPORT,
  });
  const alias = projection.route_aliases.incoming.find((edge) => edge.source_id === FIXTURES.housing_alias);
  assert.equal(alias.to, NYCHA_CANONICAL_ID);
  assert.equal(alias.href, "/agencies/housing-authority/");
  const html = renderInstitutionProfileNavigation(projection);
  assert.match(html, /n-y-c-housing-authority/);
  assert.match(html, /href="\/agencies\/housing-authority\//);
  const nychaRel = JSON.parse(readFileSync(join(ROOT, "site/agencies/housing-authority/relationships-data.json"), "utf8"));
  const meetings = nychaRel.view.categories.find((row) => row.id === "meetings").items;
  assert.equal(meetings.some((item) => String(item.href || "").includes(NYCHA_BOARD_MEETING_ID)), true);
});

test("EEP collision, unresolved routes, OTI buckets, and Community Boards stay uncertainty-safe", () => {
  const eep = projectInstitutionProfileNavigation({
    identity: {
      canonical_id: "equal-employment-practices-commission",
      canonical_name: "Equal Employment Practices Commission",
    },
    publisherRow: CROSSWALK.entries["equal-employment-practices-commission"],
    view: lookupView("equal-employment-practices-commission"),
    routeIdentityReport: REPORT,
  });
  assert.equal(eep.identity_evidence_state.status, "collision");
  assert.equal(eep.identity_evidence_state.linking, false);
  assert.deepEqual(eep.identity_evidence_state.collision_ids, [
    "equal-employ-practices-comm",
    "equal-employment-practices-commission",
  ]);
  assert.equal(eep.route_aliases.outgoing.length, 0);
  const html = renderInstitutionProfileNavigation(eep);
  assert.match(html, /data-identity-state="collision"/);
  assert.match(html, /EQUAL EMPLOYMENT PRACTICES COMMISSION/);
  assert.doesNotMatch(html, /data-relation="route_alias_of"/);

  for (const id of FIXTURES.unresolved) {
    assert.equal(agencyRouteUncertaintyKind(id, REPORT), "unresolved");
    const projection = projectInstitutionProfileNavigation({
      identity: { canonical_id: id, canonical_name: id },
      publisherRow: null,
      hasRoute: true,
      routeIdentityReport: REPORT,
    });
    assert.equal(projection.identity_evidence_state.status, "unresolved");
    assert.equal(projection.role_capabilities.every((row) => row.state === "blocked" || row.id === "institution_kind" || row.id === "community_board_child"), true);
    const page = renderInstitutionUncertaintyDocument(projection);
    assert.match(page, /data-identity-state="unresolved"/);
    assert.match(page, /stays on an evidence page/);
    assert.doesNotMatch(page, /href="\/agencies\/taxi-and-limousine-commission\//);
  }

  assert.equal(agencyRouteUncertaintyKind("equal-employ-practices-comm", REPORT), "collision");
  const oti = eep.role_capabilities.find((row) => row.id === "institution_kind");
  assert.equal(oti.state, "blocked");
  const board = eep.role_capabilities.find((row) => row.id === "community_board_child");
  assert.equal(board.state, "blocked");
  assert.doesNotMatch(html, /brooklyn-cb-15/);
});

test("agency index, routes, aliases, scopes, property keys, person-leader, staffing, and board body ids stay compatible", () => {
  const index = readFileSync(join(ROOT, "site/agencies/index.html"), "utf8");
  assert.equal(index, renderAgencyIndex());
  // The directory now lists the destinations this repository publishes rather
  // than the keys of the name-reconciliation table, so profiles that exist are
  // reachable from it. Reviewed names the table carries without a published
  // profile stay listed by name, unlinked, so a reference to one keeps working.
  const indexIds = [...index.matchAll(/data-subject-ref="agency:id:([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual([...indexIds].sort(), Object.keys(LOOKUP.by_id).sort());
  assert.ok(indexIds.includes("sanitation"));
  assert.ok(indexIds.includes("economic-development-corporation"));
  assert.ok(indexIds.includes("city-planning-commission"));
  for (const name of Object.keys(AGENCY_GROUPS)) {
    assert.match(index, new RegExp(`>${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}<|data-canonical-id="${agencyCanonicalId(name)}"`), name);
  }
  // A board keeps its own canonical destination and its own subject; it is
  // never republished under an agency route.
  const boardIds = [...index.matchAll(/data-subject-ref="community-board:([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual([...boardIds].sort(), Object.keys(BOARD_LOOKUP.by_id).sort());
  assert.doesNotMatch(index, /href="\/agencies\/[a-z-]+-cb-\d+\//);
  const routeDirs = readdirSync(join(ROOT, "site/agencies"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.ok(routeDirs.includes("sanitation"));
  assert.ok(routeDirs.includes("economic-development-corporation"));
  assert.ok(routeDirs.includes("housing-authority"));
  assert.equal(LOOKUP.aliases["n-y-c-housing-authority"], "housing-authority");
  assert.equal(LOOKUP.by_id["n-y-c-housing-authority"], undefined);
  assert.equal(LOOKUP.by_id.sanitation.subject_ref, "agency:id:sanitation");
  assert.equal(REPORT.classification_counts.unresolved, 2);
  assert.equal(defaultRouteIdentityReport.schema, "cityscroll.agency_route_identity_report.v1");

  const follow = LOOKUP.by_id.sanitation;
  assert.equal(follow.subject_ref.startsWith("agency:id:"), true);
  assert.equal(REGISTRY.object_types.find((row) => row.id === "property_site").primary_key_pattern,
    "disposition:{agency}:{bbl|taxlot}|notice:{notice_id}");
  assert.equal(REGISTRY.object_types.find((row) => row.id === "person-leader").primary_key_pattern,
    "person-leader:{agency_id}:{person_id|name}");
  assert.equal(REGISTRY.object_types.find((row) => row.id === "agency").primary_key_pattern,
    "agency:{canonical_id|name}");

  const staffing = lookupView("sanitation").categories.find((row) => row.id === "staffing");
  assert.equal(staffing.state || staffing.status, "matched");
  assert.ok(staffing.count >= 1);

  const bodyIds = Object.keys(BOARD_LOOKUP.by_id).sort();
  assert.equal(bodyIds.length, 59);
  assert.ok(bodyIds.includes(FIXTURES.board_id));
  assert.equal(BOARD_LOOKUP.by_id[FIXTURES.board_id].body_id, "brooklyn-cb-15");
  assert.equal(BOARD_LOOKUP.by_id[FIXTURES.board_id].path, "/community-boards/brooklyn-cb-15/");
  assert.equal(CROSSWALK.entries["board-of-education-retirement-system"].acronym, "BERS");
  assert.equal(LOOKUP.by_id["employees-retirement-system"].subject_ref, "agency:id:employees-retirement-system");
});

test("profile navigation is a compact profile disclosure, not an index-wide filter rail", () => {
  const ids = AGENCY_CONSTELLATION_SECTIONS.map((section) => section.id);
  assert.ok(ids.includes("institution-navigation"));
  const index = readFileSync(join(ROOT, "site/agencies/index.html"), "utf8");
  assert.doesNotMatch(index, /institution-profile-navigation/);
  assert.doesNotMatch(index, /data-role-filter/);
  assert.match(index, /<h1>Agencies &amp; public bodies<\/h1>/);
});

test("unresolved and colliding routes render an evidence stop instead of a guessed profile", async () => {
  const home = "<title>CityScroll</title><div id=\"entityview\">Agency profile</div>";
  const env = {
    ASSETS: {
      fetch: async () => new Response(home, { headers: { "Content-Type": "text/html" } }),
    },
  };
  const unresolved = await edgeWorker.fetch(
    new Request("https://cityscroll.org/agencies/nyc-taxi-and-limousine-commission/"),
    env,
  );
  assert.equal(unresolved.status, 200);
  const unresolvedBody = await unresolved.text();
  assert.match(unresolvedBody, /data-identity-state="unresolved"/);
  assert.doesNotMatch(unresolvedBody, /id="entityview"/);
  assert.doesNotMatch(unresolvedBody, /href="\/agencies\/taxi-and-limousine-commission\//);

  const collision = await edgeWorker.fetch(
    new Request("https://cityscroll.org/agencies/equal-employ-practices-comm/"),
    env,
  );
  assert.equal(collision.status, 200);
  const collisionBody = await collision.text();
  assert.match(collisionBody, /data-identity-state="collision"/);
  assert.doesNotMatch(collisionBody, /id="entityview"/);

  const unknown = await edgeWorker.fetch(new Request("https://cityscroll.org/agencies/hpd/"), env);
  assert.equal(unknown.status, 200);
  assert.match(await unknown.text(), /id="entityview"/);

  const alias = await edgeWorker.fetch(
    new Request("https://cityscroll.org/agencies/n-y-c-housing-authority/"),
    env,
  );
  assert.equal(alias.status, 308);
  assert.equal(alias.headers.get("Location"), "https://cityscroll.org/agencies/housing-authority/");
});
