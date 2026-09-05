import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  LAND_FAMILY_FILTER_VALUES,
  LAND_PROCEDURE_FILTER_VALUES,
  LAND_PROJECT_GET_CAPABILITY,
  LAND_PROJECT_GET_CAPABILITY_REFERENCE,
  LAND_PROJECTS_BROWSE_CAPABILITY,
  LAND_PROJECTS_BROWSE_CAPABILITY_REFERENCE,
  LAND_REGULATORY_EFFECT_FILTER_VALUES,
  LAND_STAGE_FILTER_VALUES,
  executeLandProjectGet,
  executeLandProjectsBrowse,
} from "../capabilities/land_projects.mjs";
import { CAPABILITY_REGISTRY } from "../capabilities/registry.mjs";
import {
  MCP_LAND_PROJECT_GET_ADAPTER,
  MCP_LAND_PROJECTS_BROWSE_ADAPTER,
  MCP_TOOLS,
  MCP_TOOL_BINDINGS,
} from "../capabilities/mcp_tool_declarations.mjs";
import {
  LAND_PROJECT_GET_HTTP_ADAPTER,
  LAND_PROJECTS_BROWSE_HTTP_ADAPTER,
  handleLandProject,
  handleLandProjectsBrowse,
  workerLandProjects,
} from "../worker/src/land_projects.mjs";
// worker/src/mcp.mjs is deliberately never imported here: it pulls in
// worker-only npm dependencies (e.g. subscribe.mjs's optin-token) that this
// root test family does not provision. Runtime MCP execution parity for
// get_land_project/browse_land_projects is proven in worker/test/ (the CS-10
// remote MCP canary and mcp_capability_adapter.test.mjs); this file checks
// the dispatcher's source text instead, matching the existing convention in
// test/federated_search_capability.test.mjs and
// test/authority_native_procurement_surfaces.test.mjs.
import { LAND_PROCEDURE_OPTIONS } from "../site/land_procedure_facet.mjs";
import { LAND_FAMILY_OPTIONS, LAND_STAGE_OPTIONS } from "../site/land_status_facets.mjs";
import { LAND_REGULATORY_EFFECT_OPTIONS } from "../site/land_regulatory_effect.mjs";
import { landProjectUrl } from "../site/land_project_route.mjs";

const CORPUS = JSON.parse(readFileSync(
  new URL("../worker/src/data/land_expedited_corpus.json", import.meta.url),
  "utf8",
));
const CORPUS_IDS = ["2024Q0356", "2024Q0419", "2025R0257", "2026X0362"];

function corpusRow(projectId) {
  const row = CORPUS.rows.find((entry) => entry.project_id === projectId);
  assert.ok(row, `frozen corpus is missing ${projectId}`);
  return row;
}

/** Shapes one frozen corpus row as an "exact" zap-outcomes cache record, the shape env.LAND_PROJECT_RECORDS carries. */
function exactRecord(projectId, overrides = {}) {
  const row = corpusRow(projectId);
  return {
    project_id: row.project_id,
    generated_at: CORPUS.captured_at,
    actions: row.actions,
    open_data: row.open_data,
    spine: row.spine,
    ...overrides,
  };
}

test("capability metadata declares bounded exact get and browse operations with two real adapters, reusing the resident filter vocabulary", () => {
  assert.equal(LAND_PROJECT_GET_CAPABILITY.reference, LAND_PROJECT_GET_CAPABILITY_REFERENCE);
  assert.equal(LAND_PROJECTS_BROWSE_CAPABILITY.reference, LAND_PROJECTS_BROWSE_CAPABILITY_REFERENCE);
  assert.equal(LAND_PROJECT_GET_CAPABILITY.bounds.output.oneProject, true);
  assert.equal(LAND_PROJECTS_BROWSE_CAPABILITY.bounds.output.maximumResults, 100);
  assert.equal(LAND_PROJECT_GET_CAPABILITY.adapters.length, 2);
  assert.equal(LAND_PROJECTS_BROWSE_CAPABILITY.adapters.length, 2);
  assert.ok(CAPABILITY_REGISTRY.includes(LAND_PROJECT_GET_CAPABILITY));
  assert.ok(CAPABILITY_REGISTRY.includes(LAND_PROJECTS_BROWSE_CAPABILITY));

  // A1/G1 negative rule: the capability's declared filter vocabulary is the
  // resident Land vocabulary, not an invented agent-only taxonomy. These
  // constants are duplicated (capabilities/land_projects.mjs carries no site/
  // dependency), so drift is caught here rather than assumed away.
  assert.deepEqual([...LAND_PROCEDURE_FILTER_VALUES], LAND_PROCEDURE_OPTIONS.map((o) => o.id));
  assert.deepEqual([...LAND_FAMILY_FILTER_VALUES], LAND_FAMILY_OPTIONS.map((o) => o.id));
  assert.deepEqual([...LAND_STAGE_FILTER_VALUES], LAND_STAGE_OPTIONS.map((o) => o.id));
  assert.deepEqual([...LAND_REGULATORY_EFFECT_FILTER_VALUES], LAND_REGULATORY_EFFECT_OPTIONS.map((o) => o.id));
});

test("A10 the MCP tool inventory and bindings reference the registered Land capabilities", () => {
  const getTool = MCP_TOOLS.find(({ name }) => name === "get_land_project");
  const browseTool = MCP_TOOLS.find(({ name }) => name === "browse_land_projects");
  assert.ok(getTool && browseTool);
  const getBinding = MCP_TOOL_BINDINGS.find(({ name }) => name === "get_land_project");
  const browseBinding = MCP_TOOL_BINDINGS.find(({ name }) => name === "browse_land_projects");
  assert.equal(getBinding.capabilityReference, LAND_PROJECT_GET_CAPABILITY_REFERENCE);
  assert.equal(getBinding.adapterId, MCP_LAND_PROJECT_GET_ADAPTER.id);
  assert.equal(browseBinding.capabilityReference, LAND_PROJECTS_BROWSE_CAPABILITY_REFERENCE);
  assert.equal(browseBinding.adapterId, MCP_LAND_PROJECTS_BROWSE_ADAPTER.id);
  assert.equal(LAND_PROJECT_GET_HTTP_ADAPTER.id, LAND_PROJECT_GET_CAPABILITY.adapters[0].id);
  assert.equal(MCP_LAND_PROJECT_GET_ADAPTER.id, LAND_PROJECT_GET_CAPABILITY.adapters[1].id);
  assert.equal(LAND_PROJECTS_BROWSE_HTTP_ADAPTER.id, LAND_PROJECTS_BROWSE_CAPABILITY.adapters[0].id);
  assert.equal(MCP_LAND_PROJECTS_BROWSE_ADAPTER.id, LAND_PROJECTS_BROWSE_CAPABILITY.adapters[1].id);
});

test("A1/A3 a live browse for the expedited procedure works without a keyword and promises no fixed count", async () => {
  const provider = workerLandProjects({});
  const result = await executeLandProjectsBrowse(provider.browse, { procedure: "elurp", limit: 25 });
  assert.notEqual(result.availability, "unavailable");
  assert.ok(typeof result.freshness.as_of === "string" && result.freshness.as_of.length > 0);
  assert.ok(Number.isInteger(result.total_matches) && result.total_matches >= 0);
  assert.ok(result.results.length <= result.total_matches);
  // No keyword/query field was supplied at all.
  for (const project of result.results) {
    assert.equal(project.procedure.publisher_observation, "ELURP");
  }
});

test("A2 captured historical-corpus mode returns exactly the four frozen projects, independent of live warehouse drift", async () => {
  const provider = workerLandProjects({});
  const withFilter = await executeLandProjectsBrowse(provider.browse, { corpus: "historical", procedure: "elurp" });
  const withoutFilter = await executeLandProjectsBrowse(provider.browse, { corpus: "historical" });
  for (const result of [withFilter, withoutFilter]) {
    assert.equal(result.availability, "complete");
    assert.equal(result.total_matches, 4);
    assert.deepEqual(result.results.map((p) => p.project_id).sort(), [...CORPUS_IDS].sort());
    assert.ok(result.coverage.sources.frozen_expedited_corpus);
    assert.equal(result.coverage.sources.frozen_expedited_corpus.row_count, 4);
  }
});

test("A4 an exact get for the primary canary returns its frozen values including the exact application id and canonical deep link", async () => {
  const provider = workerLandProjects({ LAND_PROJECT_RECORDS: { "2024Q0356": exactRecord("2024Q0356") } });
  const result = await executeLandProjectGet(provider.get, { projectId: "2024Q0356" });
  assert.equal(result.availability, "available");
  const project = result.project;
  assert.equal(project.project_id, "2024Q0356");
  assert.equal(project.canonical_id, "land:project:2024Q0356");
  assert.equal(project.deep_link, landProjectUrl("2024Q0356"));
  assert.equal(project.geography.borough, "Queens");
  assert.equal(project.geography.community_district, "Q11");
  assert.equal(project.geography.council_district, "19");
  assert.equal(project.applicant.primary_applicant, "DLC Properties LLC.");
  assert.equal(project.procedure.resolution, "uniform");
  assert.equal(project.procedure.actions.length, 1);
  assert.equal(project.procedure.actions[0].action_type, "ZM");
  assert.equal(project.procedure.actions[0].application_id, "260272ZMQ");
  assert.equal(project.procedure.actions[0].procedure_id, "elurp_197e");
  // Absent open-dataset number: Open Data carried no ulurp_numbers of its own.
  assert.equal(project.procedure.raw.ulurp_numbers, null);
  assert.equal(project.conflicts.length, 0);
});

test("A5/G3 a richer exact ZAP API action observation is not overwritten by a thinner Open Data row", async () => {
  const exact = await executeLandProjectGet(
    workerLandProjects({ LAND_PROJECT_RECORDS: { "2024Q0356": exactRecord("2024Q0356") } }).get,
    { projectId: "2024Q0356" },
  );
  // The thinner Open Data row alone (no ulurp_numbers, no ZAP action) cannot
  // resolve at all — this is the honest open-data-only outcome for this canary.
  const thinRow = { ...corpusRow("2024Q0356").open_data };
  const thin = await executeLandProjectGet(
    workerLandProjects({ LAND_READ_MODEL: { rows: [thinRow], generated_at: CORPUS.captured_at } }).get,
    { projectId: "2024Q0356" },
  );
  assert.equal(exact.project.procedure.actions[0].status, "resolved");
  assert.equal(exact.project.procedure.actions[0].application_id, "260272ZMQ");
  assert.equal(exact.project.coverage.richness, "exact");
  assert.equal(thin.project.procedure.actions[0].status, "unresolved");
  assert.equal(thin.project.procedure.actions[0].unresolved_reason, "missing_application_id");
  assert.equal(thin.project.coverage.richness, "open_data_only");

  // 2024Q0419: Open Data alone WOULD resolve (it carries an unprefixed
  // identifier), but the richer exact ZAP API identifier still wins and the
  // narrower Open Data identifier is retained as an alias, not discarded.
  const exact419 = await executeLandProjectGet(
    workerLandProjects({ LAND_PROJECT_RECORDS: { "2024Q0419": exactRecord("2024Q0419") } }).get,
    { projectId: "2024Q0419" },
  );
  assert.equal(exact419.project.procedure.actions[0].application_id, "C250331ZMQ");
  assert.equal(exact419.project.procedure.actions[0].aliases.length, 1);
  assert.equal(exact419.project.procedure.actions[0].aliases[0].application_id, "250331ZMQ");
});

test("A6/G3 a leading identifier prefix never overrides an explicit publisher ELURP procedure", async () => {
  for (const projectId of ["2024Q0419", "2025R0257"]) {
    const result = await executeLandProjectGet(
      workerLandProjects({ LAND_PROJECT_RECORDS: { [projectId]: exactRecord(projectId) } }).get,
      { projectId },
    );
    const action = result.project.procedure.actions[0];
    assert.equal(action.procedure_id, "elurp_197e");
    assert.notEqual(action.procedure_id, "ulurp_197c");
    assert.equal(action.evidence.rejected.length, 1);
    assert.equal(action.evidence.rejected[0].value, "ulurp_197c");
    assert.equal(action.evidence.rejected[0].reason, "identifier_prefix_cannot_override_explicit_elurp");
  }
  // 2026X0362: an observed City Council review milestone must not, by
  // itself, select the ordinary (non-expedited) variant.
  const housing = await executeLandProjectGet(
    workerLandProjects({ LAND_PROJECT_RECORDS: { "2026X0362": exactRecord("2026X0362") } }).get,
    { projectId: "2026X0362" },
  );
  assert.equal(housing.project.procedure.resolution, "uniform");
  assert.equal(housing.project.procedure.actions[0].procedure_id, "elurp_197e");
  assert.equal(housing.project.procedure.actions[0].evidence.rejected.length, 0);
});

test("A7/A8 every conflict remains attributed to the source observation that produced it", async () => {
  const result = await executeLandProjectGet(
    workerLandProjects({ LAND_PROJECT_RECORDS: { "2024Q0419": exactRecord("2024Q0419") } }).get,
    { projectId: "2024Q0419" },
  );
  assert.equal(result.project.conflicts.length, 2);
  const [alias, rejected] = result.project.conflicts;
  assert.equal(alias.kind, "alias");
  assert.equal(alias.source_system, "zap-projects-open-data");
  assert.ok(alias.source_record_id.includes("2024Q0419"));
  assert.ok(alias.reason);
  assert.equal(rejected.kind, "rejected_inference");
  assert.equal(rejected.source_system, "identifier_prefix");
  assert.ok(rejected.source_record_id.includes("2024Q0419"));
  assert.ok(rejected.reason);

  // No conflict at all is a distinct, honestly empty state — not an omission.
  const clean = await executeLandProjectGet(
    workerLandProjects({ LAND_PROJECT_RECORDS: { "2024Q0356": exactRecord("2024Q0356") } }).get,
    { projectId: "2024Q0356" },
  );
  assert.deepEqual(clean.project.conflicts, []);
});

test("A8 missing, empty, unavailable, and stale states remain distinct", async () => {
  const provider = workerLandProjects({});

  // Missing: an exact canonical id that was never published.
  const missing = await executeLandProjectGet(provider.get, { projectId: "notarealproject" });
  assert.equal(missing.availability, "not_yet_public");
  assert.equal(missing.error, "not-found");
  assert.equal(missing.project, null);

  // Empty: a real filter combination with a zero-row match.
  const empty = await executeLandProjectsBrowse(provider.browse, { corpus: "historical", borough: "Nowhereville" });
  assert.equal(empty.availability, "empty");
  assert.deepEqual(empty.results, []);
  assert.equal(empty.total_matches, 0);

  // Unavailable: a runtime failure (an unresolvable pagination cursor), not a
  // validation error — distinct from "empty" and from "missing".
  const unavailableBrowse = await executeLandProjectsBrowse(provider.browse, { cursor: "not-a-real-cursor-value" });
  assert.equal(unavailableBrowse.availability, "unavailable");
  assert.equal(unavailableBrowse.results, null);
  assert.equal(unavailableBrowse.error, "unavailable");

  // Stale vs fresh: only meaningful (non-null) for an exact observation.
  // A fixed fixture clock, not the live wall clock: freshness is relative to
  // ZAP_OUTCOMES_MAX_AGE_MS (24h), never to whenever this suite happens to run.
  const FIXTURE_NOW = Date.parse("2026-08-24T00:00:00.000Z");
  const fresh = await executeLandProjectGet(
    workerLandProjects(
      { LAND_PROJECT_RECORDS: { "2024Q0356": exactRecord("2024Q0356", { generated_at: "2026-08-23T12:00:00.000Z" }) } },
      { nowMs: FIXTURE_NOW },
    ).get,
    { projectId: "2024Q0356" },
  );
  assert.equal(fresh.project.freshness.stale, false);
  const stale = await executeLandProjectGet(
    workerLandProjects(
      { LAND_PROJECT_RECORDS: { "2024Q0356": exactRecord("2024Q0356", { generated_at: "2020-01-01T00:00:00.000Z" }) } },
      { nowMs: FIXTURE_NOW },
    ).get,
    { projectId: "2024Q0356" },
  );
  assert.equal(stale.project.freshness.stale, true);
  const openDataOnly = await executeLandProjectGet(provider.get, { projectId: "2024Q0356" });
  assert.equal(openDataOnly.project.freshness.stale, null);
});

test("A9 HTTP and MCP adapters delegate to the same capability semantics for get and browse", async () => {
  const directGet = await executeLandProjectGet(workerLandProjects({}).get, { projectId: "2024Q0356" });
  const httpGet = await handleLandProject(new Request("https://api.cityscroll.org/land-project?id=2024Q0356"), {});
  assert.equal(httpGet.status, 200);
  assert.deepEqual(await httpGet.json(), directGet);

  const directBrowse = await executeLandProjectsBrowse(workerLandProjects({}).browse, { corpus: "historical", procedure: "elurp" });
  const httpBrowse = await handleLandProjectsBrowse(
    new Request("https://api.cityscroll.org/land-projects?corpus=historical&procedure=elurp"),
    {},
  );
  assert.equal(httpBrowse.status, 200);
  assert.deepEqual(await httpBrowse.json(), directBrowse);

  // The MCP side of this equivalence is proven at runtime in worker/test/
  // (mcp_streamable_http_interop.test.mjs's CS-10 canary and
  // mcp_capability_adapter.test.mjs), which this root test family cannot
  // exercise directly — see the import-site note above. Here we confirm the
  // dispatcher's tool cases route to the identical capability entry points
  // this test just called directly, by source rather than by execution.
  const mcpSource = readFileSync(new URL("../worker/src/mcp.mjs", import.meta.url), "utf8");
  const getCase = mcpSource.slice(mcpSource.indexOf('case "get_land_project"'), mcpSource.indexOf('case "browse_land_projects"'));
  assert.match(getCase, /executeLandProjectGet\(workerLandProjectGet\(env\)/);
  const browseCase = mcpSource.slice(mcpSource.indexOf('case "browse_land_projects"'));
  assert.match(browseCase, /executeLandProjectsBrowse\(workerLandProjectsBrowse\(env\)/);
});

test("A4/A9 missing objects retain not-yet-public state across capability and HTTP", async () => {
  const direct = await executeLandProjectGet(workerLandProjects({}).get, { projectId: "notarealproject" });
  assert.deepEqual(direct, {
    capability_reference: LAND_PROJECT_GET_CAPABILITY_REFERENCE,
    availability: "not_yet_public",
    project: null,
    error: "not-found",
  });
  const response = await handleLandProject(new Request("https://api.cityscroll.org/land-project?id=notarealproject"), {});
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), direct);
});

test("A11 no request-time publisher call or rendered-page scraping is introduced", async () => {
  const capabilitySource = readFileSync(new URL("../capabilities/land_projects.mjs", import.meta.url), "utf8");
  const workerSource = readFileSync(new URL("../worker/src/land_projects.mjs", import.meta.url), "utf8");
  for (const source of [capabilitySource, workerSource]) {
    assert.doesNotMatch(source, /zap-api-production|planning\.nyc\.gov\/api|data\.cityofnewyork\.us|cheerio|puppeteer|playwright/i);
  }
  assert.doesNotMatch(workerSource, /\bfetch\(/);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("land project capabilities must not fetch at request time"); };
  try {
    const provider = workerLandProjects({});
    await executeLandProjectGet(provider.get, { projectId: "2024Q0356" });
    await executeLandProjectsBrowse(provider.browse, { corpus: "historical" });
    await executeLandProjectsBrowse(provider.browse, { procedure: "elurp", limit: 5 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("A12 the capability provider composes the same resident Land route and read-model modules the UI uses, unmodified", () => {
  // A structural guard, not a UI regression suite: it proves this capability
  // reuses (rather than forks) the exact modules Land list/map/watch/detail
  // already depend on, so a UI regression is caught by those existing suites.
  const workerSource = readFileSync(new URL("../worker/src/land_projects.mjs", import.meta.url), "utf8");
  for (const specifier of [
    "../../site/land_action_procedure_resolution.mjs",
    "../../site/land_project_route.mjs",
    "../../site/resident_snapshot_queries.mjs",
  ]) {
    assert.ok(workerSource.includes(specifier), `expected land_projects.mjs to import ${specifier}`);
  }
  assert.equal(landProjectUrl("2024Q0356"), "https://cityscroll.org/browse/zoning/#land/2024Q0356");
});

test("adapter source remains delegated and cannot silently rebuild Land identity or procedure resolution", () => {
  const workerSource = readFileSync(new URL("../worker/src/land_projects.mjs", import.meta.url), "utf8");
  const mcpSource = readFileSync(new URL("../worker/src/mcp.mjs", import.meta.url), "utf8");
  assert.match(workerSource, /executeLandProjectGet/);
  assert.match(workerSource, /executeLandProjectsBrowse/);
  assert.match(mcpSource, /executeLandProjectGet/);
  assert.match(mcpSource, /executeLandProjectsBrowse/);
  assert.doesNotMatch(mcpSource, /resolveLandActionProcedures|LAND_PROCEDURE_PROFILE_REGISTRY/);
});

test("core capability file carries no runtime or transport dependency", () => {
  const source = readFileSync(new URL("../capabilities/land_projects.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from\s+["'][^"']*(?:mcp|worker\/src|cloudflare|site\/)[^"']*["']/i);
  assert.doesNotMatch(source, /\b(?:Request|Response)\s*\(/);
});
