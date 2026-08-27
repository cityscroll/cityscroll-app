import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  executePeopleGet,
  executeOrganizationsBrowse,
  PEOPLE_GET_CAPABILITY_REFERENCE,
  ORGANIZATIONS_BROWSE_CAPABILITY_REFERENCE,
  PEOPLE_GET_CAPABILITY,
  ORGANIZATIONS_BROWSE_CAPABILITY,
} from "../../capabilities/people_organizations.mjs";
import {
  handlePeopleOrganizations,
  workerPeopleOrganizations,
} from "../src/people_organizations.mjs";
import { handleMcp } from "../src/mcp.mjs";

const model = {
  schema: "cityscroll.people_organizations_read_model.v1",
  row_kinds: ["official", "agency"],
  relation_states: ["published", "empty", "unknown"],
  generated_at: "2026-08-18T20:00:00Z",
  counts: { official: 1, agency: 1 },
  rows: [
    { kind: "official", id: "official:42", label: "Ada Example", href: "/officials/42/", entity_ref: "entity:official:42", person_id: "42", relation_state: "published", detail: "Official profile", search_text: "Ada Example official" },
    { kind: "agency", id: "agency:id:parks", label: "Parks and Recreation", href: "/agencies/parks/", entity_ref: "agency:id:parks", relation_state: "published", detail: "4 linked record categories", search_text: "Parks and Recreation agency organization" },
  ],
};
const env = { PEOPLE_ORGANIZATIONS_READ_MODEL: model };

function post(body) {
  return new Request("https://api.cityscroll.org/mcp", { method: "POST", headers: { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.99" }, body: JSON.stringify(body) });
}
class MockKV { async get() { return null; } async put() {} }

test("metadata declares bounded exact get and browse adapters", () => {
  assert.equal(PEOPLE_GET_CAPABILITY.reference, PEOPLE_GET_CAPABILITY_REFERENCE);
  assert.equal(ORGANIZATIONS_BROWSE_CAPABILITY.reference, ORGANIZATIONS_BROWSE_CAPABILITY_REFERENCE);
  assert.equal(PEOPLE_GET_CAPABILITY.adapters.length, 2);
  assert.equal(ORGANIZATIONS_BROWSE_CAPABILITY.bounds.output.maximumResults, 100);
});

test("capability provider preserves exact identity, relation state, and freshness", async () => {
  const result = await executePeopleGet(workerPeopleOrganizations(env).get, { entityId: "official:42" });
  assert.equal(result.availability, "available");
  assert.equal(result.person_or_organization.id, "official:42");
  assert.equal(result.person_or_organization.relation_state, "published");
  assert.equal("search_text" in result.person_or_organization, false);
  const browse = await executeOrganizationsBrowse(workerPeopleOrganizations(env).browse, { kind: "agency", limit: 1 });
  assert.equal(browse.total_matches, 1);
  assert.equal(browse.freshness.as_of, model.generated_at);
  assert.equal(browse.coverage.state, "published");
  assert.equal("search_text" in browse.results[0], false);
});

test("HTTP and MCP adapters delegate to the same capability result", async () => {
  const direct = await executePeopleGet(workerPeopleOrganizations(env).get, { entityId: "official:42" });
  const http = await handlePeopleOrganizations(new Request("https://api.cityscroll.org/people-organizations?id=official%3A42"), env);
  assert.equal(http.status, 200);
  assert.deepEqual(await http.json(), direct);
  const browse = await executeOrganizationsBrowse(workerPeopleOrganizations(env).browse, { query: "parks", limit: 1 });
  const browseHttp = await handlePeopleOrganizations(new Request("https://api.cityscroll.org/people-organizations?q=parks&limit=1"), env);
  assert.deepEqual(await browseHttp.json(), browse);
  const mcp = await handleMcp(post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_person_or_organization", arguments: { entity_id: "official:42" } } }), { ...env, SUBS: new MockKV() });
  assert.deepEqual((await mcp.json()).result.structuredContent, direct);
  const mcpBrowse = await handleMcp(post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "browse_organizations", arguments: { query: "parks", limit: 1 } } }), { ...env, SUBS: new MockKV() });
  assert.deepEqual((await mcpBrowse.json()).result.structuredContent, browse);
});

test("unknown exact ids remain not-yet-public and invalid kinds fail closed", async () => {
  const missing = await executePeopleGet(workerPeopleOrganizations(env).get, { entityId: "agency:id:unknown" });
  assert.deepEqual(missing, { capability_reference: PEOPLE_GET_CAPABILITY_REFERENCE, availability: "not_yet_public", person_or_organization: null, error: "not-found" });
  await assert.rejects(() => executeOrganizationsBrowse(workerPeopleOrganizations(env).browse, { kind: "not-a-kind" }), /row kind/);
});

test("adapters call capability executors and do not reconstruct row identity", () => {
  const source = readFileSync(new URL("../src/people_organizations.mjs", import.meta.url), "utf8");
  const mcpSource = readFileSync(new URL("../src/mcp.mjs", import.meta.url), "utf8");
  assert.match(source, /executePeopleGet/);
  assert.match(source, /executeOrganizationsBrowse/);
  assert.match(mcpSource, /executePeopleGet/);
  assert.match(mcpSource, /executeOrganizationsBrowse/);
  assert.doesNotMatch(mcpSource, /search_text|relation_state|person_id/);
});
