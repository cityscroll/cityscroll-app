// CS-10 · Verify the deployed MCP endpoint externally.
//
// This is the one test in the repository that is deliberately network-bound:
// it crosses public DNS to the deployed production MCP endpoint and proves
// production routing, protocol negotiation, the deployed tool inventory, two
// bounded reads, and a clean invalid-tool failure. Node's test runner gives
// each explicitly-named file its own process with no visibility into sibling
// files on the same command line, so this file cannot tell "invoked alone"
// apart from "swept up by `test/*.test.mjs`" on its own — CS10_SKIP_LIVE_CANARY
// is the explicit signal the fast, always-on sweep (ci.yml, the local
// preflight script, and the full-checkout evidence script) sets so this stays
// fast and network-independent there. It runs for real from
// .github/workflows/deploy-worker.yml's post-deploy smoke job and from a
// direct `node --test test/live_mcp_canary.test.mjs`, neither of which sets
// that variable. The card's negative rule ("do not exercise watch creation
// ...") and boundary rule ("no fetch override, no handleMcp() import, no
// fixture environment, no local Worker dispatch") are asserted below against
// this file's and the canary's own source text, not just against one run's
// behavior.
//
// Card: cityscroll-engineering/live-remote-mcp-canary
// Verify: node --test test/live_mcp_canary.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");

// Always-on offline guard: discovery reads must use the published MCP wire
// argument names (snake_case). PR #2073 initially called get_contract /
// get_land_project with capability-layer camelCase keys; the live tools
// correctly rejected those calls as missing required fields.
test("A0: discovery-read argument keys match the published MCP input schemas", () => {
  const catalog = JSON.parse(readFileSync(resolve(ROOT, "site/data/mcp_tool_catalog.json"), "utf8"));
  const canarySource = readFileSync(resolve(ROOT, "tools/verify_live_remote_mcp_canary.mjs"), "utf8");
  const byName = new Map(catalog.tools.map((tool) => [tool.name, tool]));

  const contractSchema = byName.get("get_contract")?.input_schema;
  const landSchema = byName.get("get_land_project")?.input_schema;
  assert.ok(contractSchema?.properties?.procurement_id, "catalog must declare get_contract.procurement_id");
  assert.ok(landSchema?.properties?.project_id, "catalog must declare get_land_project.project_id");
  assert.equal(Object.hasOwn(contractSchema.properties, "procurementId"), false);
  assert.equal(Object.hasOwn(landSchema.properties, "projectId"), false);

  assert.match(
    canarySource,
    /tool:\s*["']get_contract["'][\s\S]*?arguments:\s*\{\s*procurement_id:/,
    "canary get_contract must send procurement_id (MCP wire name), not procurementId",
  );
  assert.match(
    canarySource,
    /tool:\s*["']get_land_project["'][\s\S]*?arguments:\s*\{\s*project_id:/,
    "canary get_land_project must send project_id (MCP wire name), not projectId",
  );
  assert.doesNotMatch(
    canarySource,
    /tool:\s*["']get_contract["'][\s\S]*?arguments:\s*\{\s*procurementId:/,
  );
  assert.doesNotMatch(
    canarySource,
    /tool:\s*["']get_land_project["'][\s\S]*?arguments:\s*\{\s*projectId:/,
  );
});

if (process.env.CS10_SKIP_LIVE_CANARY) {
  test("CS-10 live MCP canary skipped: CS10_SKIP_LIVE_CANARY is set (fast, network-independent sweep)", () => {});
} else {
  const { EVIDENCE_CLASSES, EXECUTION_ENVIRONMENTS, scanSourceForHandleMcpImport } = await import("../capabilities/evidence_classification.mjs");
  const { runLiveMcpCanary } = await import("../tools/verify_live_remote_mcp_canary.mjs");

  const CANARY_SOURCE_PATH = resolve(ROOT, "tools/verify_live_remote_mcp_canary.mjs");
  const canarySource = readFileSync(CANARY_SOURCE_PATH, "utf8");
  const thisFileSource = readFileSync(resolve(import.meta.dirname, "live_mcp_canary.test.mjs"), "utf8");

  // One live network round trip for every assertion below — the card's Implementation
  // section lists initialize, tools/list, ping, one bounded static read, one bounded
  // database-backed read, and one deliberately invalid call, all in one session.
  const receipt = await runLiveMcpCanary();

  test("A1: test traffic crosses public DNS and reaches the deployed Worker", () => {
    assert.equal(receipt.network_observation.transport, "public-internet");
    assert.equal(receipt.network_observation.dns_resolved, true);
    assert.equal(receipt.network_observation.response_status, 200);
    assert.equal(receipt.protocol.raw_ping.response_status, 200);
    // A plausible cf-ray header is itself evidence the response actually
    // transited Cloudflare's edge, not a local or fixture handler.
    assert.match(receipt.server_identity.cf_ray || "", /^[0-9a-f]{16}-[A-Z]{3}$/i);
  });

  test("A2: the canary contains no fetch override, handleMcp() import, fixture environment, or local Worker dispatch", () => {
    // The self-check regexes below quote the exact forbidden identifiers, so
    // running them against this meta-test file's own source would trivially
    // self-match; only the canary implementation's source is scanned for the
    // boundary patterns themselves. Both files are checked for a direct
    // handleMcp() import, which is a real, non-self-referential structural check.
    assert.equal(scanSourceForHandleMcpImport(canarySource).imports, false, "must never import handleMcp()");
    assert.equal(scanSourceForHandleMcpImport(thisFileSource).imports, false, "must never import handleMcp()");
    assert.doesNotMatch(canarySource, /from\s+["'][^"']*worker\/src\//, "must never import a Worker module");
    assert.doesNotMatch(canarySource, /from\s+["'][^"']*\bcapabilities\/(?!evidence_classification\.mjs)/, "must never import a capability provider module");
    assert.doesNotMatch(canarySource, /createRemoteMcpFixtureEnv|remote_mcp_fixture\.mjs/, "must never open a fixture environment");
    assert.doesNotMatch(canarySource, /StreamableHTTPClientTransport\s*\([^)]*\{\s*fetch\s*:/s, "must never override the transport's fetch");
    assert.equal(receipt.client.fetch_overridden, false);
    assert.equal(receipt.network_observation.fetch_override, false);
    assert.equal(receipt.network_observation.transport_intercepted, false);
  });

  test("A3: initialize negotiates the production protocol successfully", () => {
    assert.equal(typeof receipt.protocol.negotiated_version, "string");
    assert.match(receipt.protocol.negotiated_version, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(receipt.protocol.sdk_ping.well_formed_result, true);
    assert.equal(receipt.protocol.raw_ping.well_formed_jsonrpc_result, true);
  });

  test("A4: tools/list matches the generated deployed inventory", () => {
    assert.equal(receipt.tool_inventory_drift.matches, true, JSON.stringify(receipt.tool_inventory_drift));
    assert.deepEqual(receipt.tool_inventory_drift.missing_from_live, []);
    assert.deepEqual(receipt.tool_inventory_drift.unexpected_on_live, []);
    assert.deepEqual(receipt.tool_inventory_drift.drifted_tools, []);
    assert.ok(receipt.tool_inventory_drift.generated_tool_count > 0);
    assert.equal(receipt.tool_inventory_drift.generated_tool_count, receipt.tool_inventory_drift.live_tool_count);
  });

  test("A5: both read calls return valid structured capability envelopes", () => {
    assert.equal(receipt.reads.length, 2);
    for (const read of receipt.reads) {
      assert.equal(read.envelope_well_formed, true, `${read.tool} envelope was not well-formed`);
      assert.equal(read.is_error, false, `${read.tool} returned a tool error`);
    }
    const staticRead = receipt.reads.find((read) => read.role === "static_read");
    const databaseRead = receipt.reads.find((read) => read.role === "database_backed_read");
    assert.ok(staticRead, "static read is missing");
    assert.ok(databaseRead, "database-backed read is missing");
    assert.equal(staticRead.tool, "get_meeting");
    assert.equal(databaseRead.tool, "search_notices");
    assert.equal(databaseRead.store_access, "worker-d1.notice-search");
  });

  test("A6: the receipt records an actual deployed Git commit", () => {
    assert.equal(receipt.deployment.commit_shape_valid, true);
    assert.equal(receipt.deployment.health_response_status, 200);
    // Never trust a self-reported commit on its own: it must resolve to a real
    // object in this checkout's own git history.
    assert.equal(receipt.deployment.commit_verified_in_git_history, true, `reported commit ${receipt.deployment.commit} is not a known object in this repository's history`);
  });

  test("A7: a deliberately invalid tool call fails without server exception or data leakage", () => {
    assert.equal(receipt.invalid_call.is_error, true);
    assert.equal(receipt.invalid_call.response_looks_like_a_leak, false);
    // The failure travelled as an ordinary JSON-RPC result, not a transport-level crash.
    assert.equal(receipt.network_observation.response_status, 200);
  });

  test("A8: the deploy workflow runs this canary as a required, non-skippable post-deploy gate", () => {
    const workflow = readFileSync(resolve(ROOT, ".github/workflows/deploy-worker.yml"), "utf8");
    const smokeJobIndex = workflow.indexOf("\n  smoke:");
    assert.ok(smokeJobIndex >= 0, "deploy-worker.yml must define a post-deploy smoke job");
    const smokeJob = workflow.slice(smokeJobIndex);
    assert.match(smokeJob, /node --test test\/live_mcp_canary\.test\.mjs/, "the smoke job must run the CS-10 canary");
    assert.doesNotMatch(smokeJob, /CS10_SKIP_LIVE_CANARY/, "the smoke job must not skip the canary it exists to run");
    const canaryStepIndex = smokeJob.indexOf("test/live_mcp_canary.test.mjs");
    const stepText = smokeJob.slice(Math.max(0, canaryStepIndex - 400), canaryStepIndex + 40);
    assert.doesNotMatch(stepText, /continue-on-error:\s*true/, "the canary step must not be allowed to fail silently");
  });

  test("A9: local protocol tests remain fast and independent of the network", () => {
    const ciWorkflow = readFileSync(resolve(ROOT, ".github/workflows/ci.yml"), "utf8");
    const stepIndex = ciWorkflow.indexOf("name: Site unit tests");
    assert.ok(stepIndex >= 0, "expected a 'Site unit tests' step in ci.yml");
    const nextStepIndex = ciWorkflow.indexOf("- name:", stepIndex);
    const stepBlock = ciWorkflow.slice(stepIndex, nextStepIndex > -1 ? nextStepIndex : undefined);
    assert.match(stepBlock, /run: node --test test\/\*\.test\.mjs/, "expected the existing fast test/*.test.mjs sweep in ci.yml");
    assert.match(stepBlock, /CS10_SKIP_LIVE_CANARY:\s*"true"/, "the fast sweep must tell the live canary to no-op");

    // CS-06's local interop test names the same production URL, but only as a
    // placeholder for its overridden, in-process transport — confirm it still
    // dispatches to handleMcp() in-process rather than the network.
    const localInteropSource = readFileSync(resolve(ROOT, "worker/test/mcp_streamable_http_interop.test.mjs"), "utf8");
    assert.equal(scanSourceForHandleMcpImport(localInteropSource).imports, true, "the local protocol interop test must stay fixture-only, dispatching to handleMcp() in-process");
  });

  test("A10: the receipt is classified external_live_endpoint, not cloudflare_os_deployed", () => {
    assert.equal(receipt.evidence_class, "external_live_endpoint");
    assert.notEqual(receipt.evidence_class, "cloudflare_os_deployed");
    assert.ok(EVIDENCE_CLASSES.includes(receipt.evidence_class));
    assert.ok(EXECUTION_ENVIRONMENTS.includes(receipt.execution_environment));
  });

  test("A11: discovery reads exercise unauthenticated contract, land, and cited tools with cited links", () => {
    assert.equal(receipt.discovery_reads.length, 3);
    const contract = receipt.discovery_reads.find((read) => read.role === "contract_read");
    const land = receipt.discovery_reads.find((read) => read.role === "land_read");
    const cited = receipt.discovery_reads.find((read) => read.role === "cited_read");
    assert.ok(contract);
    assert.ok(land);
    assert.ok(cited);
    assert.equal(contract.tool, "get_contract");
    assert.equal(land.tool, "get_land_project");
    assert.equal(cited.tool, "retrieve_cited_passages");
    assert.equal(contract.envelope_well_formed, true, JSON.stringify(contract));
    assert.equal(land.envelope_well_formed, true, JSON.stringify(land));
    assert.equal(cited.envelope_well_formed, true, JSON.stringify(cited));
    assert.equal(contract.is_error, false);
    assert.equal(land.is_error, false);
    assert.equal(cited.is_error, false);
    assert.ok(["available", "not_yet_public", "unavailable"].includes(contract.availability));
    assert.ok(["available", "not_yet_public", "unavailable"].includes(land.availability));
    assert.ok(Array.isArray(cited.cited_links));
    for (const link of cited.cited_links) {
      assert.match(link, /^https?:\/\//i);
    }
  });

  test("A12: transport failures are classified as network, Cloudflare denial, or 429", async () => {
    const { classifyLiveTransportFailure } = await import("../tools/verify_live_remote_mcp_canary.mjs");
    assert.equal(classifyLiveTransportFailure(new Error("fetch failed")).class, "network_error");
    assert.equal(classifyLiveTransportFailure(new Error("HTTP 429"), { status: 429 }).class, "http_429");
    assert.equal(
      classifyLiveTransportFailure(new Error("Forbidden"), { status: 403, bodyText: "cf-ray challenge-platform" }).class,
      "cloudflare_denial",
    );
    assert.equal(receipt.network_observation.transport_failure, null);
  });

  test("negative rule: the canary never exercises watch creation or preview", () => {
    for (const source of [canarySource, thisFileSource]) {
      assert.doesNotMatch(source, /callTool\(\{\s*name:\s*["'](?:create_watch|preview_watch)["']/s);
    }
    for (const read of [...receipt.reads, ...receipt.discovery_reads]) {
      assert.notEqual(read.tool, "create_watch");
      assert.notEqual(read.tool, "preview_watch");
    }
    assert.equal(receipt.status, "pass");
  });
}
