import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { validateJsonSchema } from "../../integrations/generated-client/index.mjs";
import { createRemoteMcpFixtureEnv, directCapabilityResults } from "./remote_mcp_fixture.mjs";
import { workerD1EntityRelationships } from "../src/public_relationship_graph.mjs";
import { executeEntityRelationships } from "../../capabilities/entity_relationships.mjs";

const legacy = JSON.parse(readFileSync(new URL("./fixtures/research_read_output_schemas.v1.json", import.meta.url), "utf8"));

test("research additions are accepted by the existing closed output schemas", async () => {
  const fixture = createRemoteMcpFixtureEnv();
  try {
    const results = await directCapabilityResults(fixture.env);
    results.set("get_entity_relationships", await executeEntityRelationships(workerD1EntityRelationships(null), { entityId: "agency:id:buildings" }));
    for (const [tool, schema] of [
      ["analyze_contracts", "contracts_analysis"],
      ["get_entity_relationships", "entity_relationships_get"],
      ["get_meeting", "meeting_get"],
      ["retrieve_cited_passages", "cited_passages_retrieve"],
    ]) {
      const result = results.get(tool);
      assert.ok(result);
      assert.doesNotThrow(() => validateJsonSchema(result, legacy.schemas[schema]), tool);
      assert.throws(() => validateJsonSchema({ ...result, undeclared_top_level_field: true }, legacy.schemas[schema]), /not a declared property/);
    }
    assert.ok(results.get("analyze_contracts").filters.discovery.agency.accepted_labels.length);
    assert.ok(results.get("retrieve_cited_passages").hard_scope.corpus.source_families.length);
    assert.equal(results.get("get_meeting").meeting.source_presence.status, "present");
    assert.ok(results.get("get_entity_relationships").graph.nodes.some((node) => node.available_detail));
  } finally {
    fixture.close();
  }
});
