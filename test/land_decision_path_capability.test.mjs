import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  LAND_DECISION_PATH_GET_CAPABILITY_REFERENCE,
  executeLandDecisionPathGet,
  validateLandDecisionPathGetOutput,
} from "../capabilities/land_decision_path.mjs";
import {
  MCP_LAND_DECISION_PATH_GET_ADAPTER,
  MCP_TOOL_BINDINGS,
  MCP_TOOLS,
} from "../capabilities/mcp_tool_declarations.mjs";
import { buildLandDecisionPathView, publicLandDecisionPathView } from "../site/land_decision_path.mjs";
import { buildLandPhaseView } from "../site/land_phase_spine.mjs";
import { landMapAuthorityHandoff } from "../site/land_map_authority_handoff.mjs";
import {
  LAND_DECISION_PATH_GET_HTTP_ADAPTER,
  handleLandDecisionPath,
  workerLandDecisionPathGet,
} from "../worker/src/land_projects.mjs";

const CORPUS = JSON.parse(readFileSync(
  new URL("../worker/src/data/land_expedited_corpus.json", import.meta.url),
  "utf8",
));
const FIXTURE_SET = JSON.parse(readFileSync(
  new URL("../worker/src/data/land_expedited_decision_path_fixtures.json", import.meta.url),
  "utf8",
));

function fixtureRecord(fixture) {
  const row = CORPUS.rows.find((candidate) => candidate.project_id === fixture.project_id);
  assert.ok(row, `fixture corpus row missing: ${fixture.project_id}`);
  return {
    project_id: row.project_id,
    generated_at: CORPUS.captured_at,
    actions: row.actions,
    open_data: row.open_data,
    spine: row.spine,
    ...(fixture.variant_evidence ? { variant_evidence: fixture.variant_evidence } : {}),
  };
}

function fixtureProvider(fixture) {
  return workerLandDecisionPathGet({ LAND_PROJECT_RECORDS: { [fixture.project_id]: fixtureRecord(fixture) } });
}

function getPath(fixture) {
  return executeLandDecisionPathGet(fixtureProvider(fixture), { projectId: fixture.project_id });
}

test("the typed capability is registered with HTTP and MCP adapters", () => {
  assert.equal(LAND_DECISION_PATH_GET_HTTP_ADAPTER.capabilityReference, LAND_DECISION_PATH_GET_CAPABILITY_REFERENCE);
  assert.equal(MCP_LAND_DECISION_PATH_GET_ADAPTER.capabilityReference, LAND_DECISION_PATH_GET_CAPABILITY_REFERENCE);
  assert.equal(MCP_TOOLS.find((tool) => tool.name === "get_land_decision_path")?.name, "get_land_decision_path");
  assert.equal(MCP_TOOL_BINDINGS.find((binding) => binding.name === "get_land_decision_path")?.adapterId, MCP_LAND_DECISION_PATH_GET_ADAPTER.id);
});

test("A1/A6 every fixture shares procedure resolution and stage topology with the resident detail view", async () => {
  for (const fixture of FIXTURE_SET.fixtures) {
    const record = fixtureRecord(fixture);
    const result = await getPath(fixture);
    assert.equal(result.availability, "available");
    const path = result.decision_path;
    const detail = buildLandPhaseView(record.spine, {
      open_data: record.open_data,
      actions: record.actions,
      project_id: record.project_id,
      variant_evidence: record.variant_evidence || null,
    });
    assert.equal(path.project_id, record.project_id);
    assert.equal(path.procedure.resolution, detail.procedure_resolution, fixture.id);
    assert.equal(path.procedure.profile_id, detail.procedure_profile.profile_id, fixture.id);
    assert.deepEqual(
      path.normative.stages.filter((stage) => stage.status === "present").map((stage) => stage.stage_id),
      detail.procedure_profile.stages.map((stage) => stage.stage_id),
      fixture.id,
    );
    assert.deepEqual(path.observed.current_phase.phase_id, detail.current.phase_id, fixture.id);
  }
});

test("A2 parallel review remains a group, never an ordered pair", async () => {
  const fixture = FIXTURE_SET.fixtures.find((entry) => entry.id === "ordinary");
  const path = (await getPath(fixture)).decision_path;
  assert.equal(path.normative.parallel_review_groups.length, 1);
  assert.deepEqual(path.normative.parallel_review_groups[0].stages.map((stage) => stage.phase_id), [
    "community_board",
    "borough_president",
  ]);
  assert.equal(path.normative.expected_next_transition.kind, "parallel_group");
  assert.deepEqual(path.normative.expected_next_transition.stages.map((stage) => stage.phase_id), [
    "community_board",
    "borough_president",
  ]);
});

test("A3 the general expedited path and retained exceptional variant do not leak fields", async () => {
  const ordinary = (await getPath(FIXTURE_SET.fixtures.find((entry) => entry.id === "ordinary"))).decision_path;
  const exceptional = (await getPath(FIXTURE_SET.fixtures.find((entry) => entry.id === "exceptional-path"))).decision_path;
  assert.equal(ordinary.procedure.profile_id, "elurp_197e");
  assert.equal(ordinary.procedure.variant_id, null);
  assert.equal(ordinary.normative.stages.some((stage) => stage.phase_id === "city_council" && stage.status === "present"), false);
  assert.equal(exceptional.procedure.profile_id, "elurp_197e_k");
  assert.equal(exceptional.procedure.broad_profile_id, "elurp_197e");
  assert.equal(exceptional.procedure.variant_status, "resolved");
  assert.equal(exceptional.normative.stages.some((stage) => stage.phase_id === "city_council" && stage.status === "present"), true);
  assert.equal(exceptional.normative.stages.some((stage) => stage.stage_id === "elurp_197e.city_planning_commission_review"), false);
});

test("A4 observed and normative layers reject cross-layer event/stage placement", async () => {
  const valid = (await getPath(FIXTURE_SET.fixtures[0])).decision_path;
  const observedUnderNormative = structuredClone(valid);
  observedUnderNormative.normative.events = [{ layer: "observed", id: "bad" }];
  assert.throws(() => validateLandDecisionPathGetOutput({
    capability_reference: LAND_DECISION_PATH_GET_CAPABILITY_REFERENCE,
    availability: "available",
    project_id: valid.project_id,
    decision_path: observedUnderNormative,
    error: null,
  }, { projectId: valid.project_id }), /observed event appeared under normative/);

  const normativeUnderObserved = structuredClone(valid);
  normativeUnderObserved.observed.events[0].stage_id = "elurp_197e.city_planning_commission_review";
  assert.throws(() => validateLandDecisionPathGetOutput({
    capability_reference: LAND_DECISION_PATH_GET_CAPABILITY_REFERENCE,
    availability: "available",
    project_id: valid.project_id,
    decision_path: normativeUnderObserved,
    error: null,
  }, { projectId: valid.project_id }), /observed event contains normative/);
});

test("A5 source conflict keeps the unresolved variant explicit instead of defaulting to an ordinary path", async () => {
  const fixture = FIXTURE_SET.fixtures.find((entry) => entry.id === "source-conflict");
  const path = (await getPath(fixture)).decision_path;
  assert.equal(path.procedure.profile_id, fixture.expected.procedure.profile_id);
  assert.equal(path.procedure.variant_status, "unresolved");
  assert.equal(path.procedure.variant_id, null);
  assert.ok(path.normative.stages.some((stage) => stage.status === "absent"));
  assert.ok(path.procedure.actions[0].evidence.rejected.some((entry) => entry.value === fixture.expected.procedure.rejected_inference));
});

test("A7 all four fixtures match their expected output and pass the negative text rule", async () => {
  for (const fixture of FIXTURE_SET.fixtures) {
    const result = await getPath(fixture);
    const path = result.decision_path;
    const expected = fixture.expected;
    assert.equal(path.procedure.resolution, expected.procedure.resolution, fixture.id);
    assert.equal(path.procedure.profile_id, expected.procedure.profile_id, fixture.id);
    assert.equal(path.procedure.variant_status, expected.procedure.variant_status, fixture.id);
    if (expected.procedure.broad_profile_id) assert.equal(path.procedure.broad_profile_id, expected.procedure.broad_profile_id, fixture.id);
    assert.equal(path.observed.current_phase.phase_id, expected.observed_current_phase, fixture.id);
    assert.equal(path.normative.current_stage.stage_id, expected.normative_current_stage, fixture.id);
    assert.equal(path.normative.expected_next_transition?.kind || null, expected.expected_next_kind, fixture.id);
    assert.deepEqual(path.normative.expected_next_transition?.stages.map((stage) => stage.stage_id) || [], expected.expected_next_stage_ids, fixture.id);

    const serialized = JSON.stringify(path).toLowerCase();
    for (const forbidden of [
      "ordinary council review",
      "ordinary mayoral",
      "ordinary statutory deadline",
      "unknown authority",
      "active calendar",
      "elurp_197e.city_council_review",
      "elurp_197e.mayoral_appeals",
    ]) {
      assert.equal(serialized.includes(forbidden), false, `${fixture.id} contains unsupported phrase: ${forbidden}`);
    }
  }
});

test("A6 HTTP and map handoff preserve the same identity and decision-path fields", async () => {
  const fixture = FIXTURE_SET.fixtures.find((entry) => entry.id === "ordinary");
  const record = fixtureRecord(fixture);
  const env = { LAND_PROJECT_RECORDS: { [fixture.project_id]: record } };
  const response = await handleLandDecisionPath(new Request(`https://cityscroll.test/land-decision-path?id=${fixture.project_id}`), env);
  assert.equal(response.status, 200);
  const http = await response.json();
  const direct = await getPath(fixture);
  assert.equal(http.project_id, direct.project_id);
  assert.deepEqual(http.decision_path.procedure, direct.decision_path.procedure);
  assert.deepEqual(http.decision_path.normative.expected_next_transition, direct.decision_path.normative.expected_next_transition);

  const handoff = landMapAuthorityHandoff({
    projectId: fixture.project_id,
    row: { project_id: fixture.project_id, decision_path: direct.decision_path },
    decisionPath: direct.decision_path,
  });
  assert.equal(handoff.project_id, fixture.project_id);
  assert.deepEqual(handoff.decision_path.procedure, direct.decision_path.procedure);
  assert.deepEqual(handoff.decision_path.normative.current_stage, direct.decision_path.normative.current_stage);
});

test("the public projection does not carry resident-only view models", async () => {
  const fixture = FIXTURE_SET.fixtures[0];
  const record = fixtureRecord(fixture);
  const publicView = publicLandDecisionPathView(buildLandDecisionPathView(record, { generatedAt: CORPUS.captured_at }));
  assert.equal(Object.hasOwn(publicView, "_resident"), false);
  assert.equal(JSON.stringify(publicView).includes("raw_snapshot"), false);
});
