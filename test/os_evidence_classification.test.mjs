import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import {
  EVIDENCE_CLASSES,
  assertReceiptEvidenceClass,
  deriveMaximumProvableClass,
  evidenceClassRank,
  findDisqualifyingFlags,
  isMerelyShapedIdentifier,
  scanSourceForHandleMcpImport,
} from "../capabilities/evidence_classification.mjs";
import { buildCapabilitySpineState, writeCapabilitySpineState } from "../tools/build_capability_spine_state.mjs";

const ROOT = resolve(import.meta.dirname, "..");

function readJson(relativePath) {
  return JSON.parse(readFileSync(resolve(ROOT, relativePath), "utf8"));
}

function readSource(relativePath) {
  return readFileSync(resolve(ROOT, relativePath), "utf8");
}

const VALID_LIVE_ENDPOINT = {
  schema: "cityscroll.example_receipt.v1",
  card: "example",
  evidence_class: "external_live_endpoint",
  execution_environment: "external-network-observed",
  protocol: { transport: "Streamable HTTP", negotiated_version: "2025-06-18" },
  network_observation: {
    transport: "public-internet",
    dns_resolved: true,
    response_status: 200,
  },
  provider_issued_identifier: {
    kind: "worker_version",
    value: "3fa1c2b0-9e4d-4a2f-8b1a-6c0d5e7f9a11",
    verified_by: "cloudflare_api",
    verification_method: "GET /client/v4/accounts/{id}/workers/deployments",
  },
};

const VALID_OS_DEPLOYED = {
  ...VALID_LIVE_ENDPOINT,
  evidence_class: "cloudflare_os_deployed",
  execution_environment: "cloudflare-os-deployment",
  cloudflare_os_deployment: {
    control_plane_response: true,
    provider_receipt_sha256: "a".repeat(64),
  },
};

const VALID_AGENT_EXERCISED = {
  ...VALID_OS_DEPLOYED,
  evidence_class: "cloudflare_os_agent_exercised",
  cloudflare_os_agent_session: {
    provider_issued: true,
    session_id: "cf-os-session-abc123",
  },
};

test("evidence classes are exactly the five commissioned classes, in rank order", () => {
  assert.deepEqual(EVIDENCE_CLASSES, [
    "local_contract",
    "local_protocol_interop",
    "external_live_endpoint",
    "cloudflare_os_deployed",
    "cloudflare_os_agent_exercised",
  ]);
  for (let index = 1; index < EVIDENCE_CLASSES.length; index += 1) {
    assert.ok(evidenceClassRank(EVIDENCE_CLASSES[index]) > evidenceClassRank(EVIDENCE_CLASSES[index - 1]));
  }
});

const POSITIVE_CASES = [
  {
    name: "bare schema/card with no protocol facts proves local_contract",
    receipt: { schema: "x", card: "y" },
    expectMaxClass: "local_contract",
  },
  {
    name: "a real transport exchanged with a handler proves local_protocol_interop",
    receipt: { schema: "x", card: "y", protocol: { transport: "Streamable HTTP", negotiated_version: "2025-06-18" } },
    expectMaxClass: "local_protocol_interop",
  },
  {
    name: "network observation plus provider-issued identifier proves external_live_endpoint",
    receipt: VALID_LIVE_ENDPOINT,
    expectMaxClass: "external_live_endpoint",
  },
  {
    name: "a control-plane deployment attestation proves cloudflare_os_deployed",
    receipt: VALID_OS_DEPLOYED,
    expectMaxClass: "cloudflare_os_deployed",
  },
  {
    name: "a provider-issued agent session proves cloudflare_os_agent_exercised",
    receipt: VALID_AGENT_EXERCISED,
    expectMaxClass: "cloudflare_os_agent_exercised",
  },
];

for (const { name, receipt, expectMaxClass } of POSITIVE_CASES) {
  test(`positive: ${name}`, () => {
    const { maxClass } = deriveMaximumProvableClass(receipt);
    assert.equal(maxClass, expectMaxClass);
    assert.doesNotThrow(() => assertReceiptEvidenceClass({ ...receipt, evidence_class: expectMaxClass, execution_environment: receipt.execution_environment || "node-in-process-fixture" }));
  });
}

const NEGATIVE_CASES = [
  {
    name: "intercepted/local handleMcp() execution cannot pass external_live_endpoint",
    receipt: VALID_LIVE_ENDPOINT,
    sourceText: 'import { handleMcp } from "../src/mcp.mjs";',
    expectMaxClassAtMost: "local_protocol_interop",
  },
  {
    name: "isolated-rehearsal mode disqualifies a live/deployed claim",
    receipt: { ...VALID_LIVE_ENDPOINT, deployment: { mode: "isolated-rehearsal" } },
    expectMaxClassAtMost: "local_protocol_interop",
  },
  {
    name: "live: false anywhere in the receipt disqualifies a live/deployed claim",
    receipt: { ...VALID_LIVE_ENDPOINT, model: { live: false } },
    expectMaxClassAtMost: "local_protocol_interop",
  },
  {
    name: "dynamic_worker_loader: false disqualifies a live/deployed claim",
    receipt: { ...VALID_LIVE_ENDPOINT, code_mode: { dynamic_worker_loader: false } },
    expectMaxClassAtMost: "local_protocol_interop",
  },
  {
    name: "a workers.dev-shaped URL alone cannot satisfy live evidence",
    receipt: {
      schema: "x",
      card: "y",
      protocol: { transport: "Streamable HTTP" },
      network_observation: { transport: "public-internet", dns_resolved: true, response_status: 200 },
      url: "https://cs10-canary.workers.dev",
    },
    expectMaxClassAtMost: "local_protocol_interop",
  },
  {
    name: "a plausible deployment id alone cannot satisfy a deployment receipt",
    receipt: {
      schema: "x",
      card: "y",
      protocol: { transport: "Streamable HTTP" },
      network_observation: { transport: "public-internet", dns_resolved: true, response_status: 200 },
      deployment_id: "cs12-cloudflare-os-router-v1",
    },
    expectMaxClassAtMost: "local_protocol_interop",
  },
  {
    name: "network observation without a provider-issued identifier cannot prove external_live_endpoint",
    receipt: {
      schema: "x",
      card: "y",
      protocol: { transport: "Streamable HTTP" },
      network_observation: { transport: "public-internet", dns_resolved: true, response_status: 200 },
    },
    expectMaxClassAtMost: "local_protocol_interop",
  },
  {
    name: "a provider-issued identifier without network observation cannot prove external_live_endpoint",
    receipt: {
      schema: "x",
      card: "y",
      protocol: { transport: "Streamable HTTP" },
      provider_issued_identifier: VALID_LIVE_ENDPOINT.provider_issued_identifier,
    },
    expectMaxClassAtMost: "local_protocol_interop",
  },
  {
    name: "a workers.dev URL and plausible id do not upgrade to cloudflare_os_deployed without control-plane attestation",
    receipt: {
      ...VALID_LIVE_ENDPOINT,
      url: "https://cs12-router.workers.dev",
      deployment_id: "cs12-cloudflare-os-router-v1",
    },
    expectMaxClassAtMost: "external_live_endpoint",
  },
  {
    name: "an agent session claim without deployment attestation cannot skip to agent_exercised",
    receipt: {
      ...VALID_LIVE_ENDPOINT,
      cloudflare_os_agent_session: { provider_issued: true, session_id: "cf-os-session-abc123" },
    },
    expectMaxClassAtMost: "external_live_endpoint",
  },
];

for (const { name, receipt, sourceText, expectMaxClassAtMost } of NEGATIVE_CASES) {
  test(`negative: ${name}`, () => {
    const { maxClass } = deriveMaximumProvableClass(receipt, { sourceText });
    assert.ok(
      evidenceClassRank(maxClass) <= evidenceClassRank(expectMaxClassAtMost),
      `expected at most ${expectMaxClassAtMost}, got ${maxClass}`,
    );
    const nextClass = EVIDENCE_CLASSES[evidenceClassRank(expectMaxClassAtMost) + 1];
    assert.throws(() => assertReceiptEvidenceClass({
      ...receipt,
      evidence_class: nextClass,
      execution_environment: "external-network-observed",
    }, { sourceText }));
  });
}

test("missing/unknown proof stays unknown rather than false-green", () => {
  const { maxClass } = deriveMaximumProvableClass({});
  assert.equal(maxClass, "unknown");
  assert.throws(() => assertReceiptEvidenceClass({ evidence_class: "local_contract", execution_environment: "node-in-process-fixture" }));
});

test("isMerelyShapedIdentifier flags shape-only identifiers as insufficient on their own", () => {
  assert.ok(isMerelyShapedIdentifier("https://cs07-entity-research-gadget.workers.dev"));
  assert.ok(isMerelyShapedIdentifier("cs07-entity-research-gadget-rehearsal-v1"));
  assert.ok(!isMerelyShapedIdentifier(""));
});

test("scanSourceForHandleMcpImport finds a direct handleMcp import", () => {
  assert.equal(scanSourceForHandleMcpImport('import { handleMcp } from "../src/mcp.mjs";').imports, true);
  assert.equal(scanSourceForHandleMcpImport('import { listTools } from "../src/mcp.mjs";').imports, false);
  assert.equal(scanSourceForHandleMcpImport(undefined).imports, false);
});

test("findDisqualifyingFlags locates nested rehearsal/live/loader markers", () => {
  const flags = findDisqualifyingFlags({
    a: { mode: "isolated-rehearsal" },
    b: [{ live: false }, { dynamic_worker_loader: false }],
  });
  const reasons = flags.map(({ reason }) => reason);
  assert.ok(reasons.includes("mode: isolated-rehearsal"));
  assert.ok(reasons.includes("live: false"));
  assert.ok(reasons.includes("dynamic_worker_loader: false"));
});

// --- Existing CS-06/07/08 receipts: honestly classified, contract checks preserved. ---

const EXISTING_RECEIPTS = [
  { card: "cs-06-remote-mcp-public-adapter", path: "artifacts/capability-spine/cs-06-remote-mcp.json", sourcePath: "worker/scripts/build_remote_mcp_evidence.mjs" },
  { card: "cs-07-cloudflare-os-composition-proof", path: "artifacts/capability-spine/cs-07-cloudflare-os-proof.json", sourcePath: "tools/verify_cloudflare_os_proof.mjs" },
  { card: "cs-08-code-mode-measurement", path: "artifacts/capability-spine/cs-08-code-mode.json", sourcePath: "integrations/cloudflare-os-code-mode/src/experiment.mjs" },
];

for (const { card, path, sourcePath } of EXISTING_RECEIPTS) {
  test(`A4: ${card} receipt carries evidence_class and execution_environment`, () => {
    const receipt = readJson(path);
    assert.equal(receipt.card, card);
    assert.equal(receipt.evidence_class, "local_protocol_interop");
    assert.equal(receipt.execution_environment, "node-intercepted-transport-fixture");
  });

  test(`A1/A2/A3/A9: ${card}'s own facts prove at most local_protocol_interop, and its producing source imports handleMcp()`, () => {
    const receipt = readJson(path);
    const sourceText = readSource(sourcePath);
    assert.equal(scanSourceForHandleMcpImport(sourceText).imports, true);
    const { maxClass } = deriveMaximumProvableClass(receipt, { sourceText });
    assert.equal(maxClass, "local_protocol_interop");
    assert.doesNotThrow(() => assertReceiptEvidenceClass(receipt, { sourceText }));
    // A9: a verifier that imports handleMcp() must never be able to claim
    // external_live_endpoint for this receipt's facts.
    assert.throws(() => assertReceiptEvidenceClass(
      { ...receipt, evidence_class: "external_live_endpoint", execution_environment: "external-network-observed" },
      { sourceText },
    ));
  });
}

test("A5/A6: no existing receipt's rehearsal markers or identifier shapes satisfy a deployed/live claim", () => {
  for (const { path } of EXISTING_RECEIPTS) {
    const receipt = readJson(path);
    const { maxClass } = deriveMaximumProvableClass(receipt);
    assert.notEqual(maxClass, "external_live_endpoint");
    assert.notEqual(maxClass, "cloudflare_os_deployed");
    assert.notEqual(maxClass, "cloudflare_os_agent_exercised");
  }
});

test("A2: CS-07's receipt records the deterministic Gatekeeper/Gadget rehearsal mode honestly", () => {
  const receipt = readJson("artifacts/capability-spine/cs-07-cloudflare-os-proof.json");
  assert.equal(receipt.deployment.mode, "isolated-rehearsal");
  assert.match(receipt.evidence_notes, /rehearsal/i);
});

test("A3: CS-08's receipt records the synthetic experiment harness honestly", () => {
  const receipt = readJson("artifacts/capability-spine/cs-08-code-mode.json");
  assert.equal(receipt.versions.model_live, false);
  assert.match(receipt.evidence_notes, /synthetic/i);
});

test("OS-deployed, Gatekeeper-connected, and agent-exercised remain mechanically distinct", () => {
  assert.notEqual(deriveMaximumProvableClass(VALID_LIVE_ENDPOINT).maxClass, deriveMaximumProvableClass(VALID_OS_DEPLOYED).maxClass);
  assert.notEqual(deriveMaximumProvableClass(VALID_OS_DEPLOYED).maxClass, deriveMaximumProvableClass(VALID_AGENT_EXERCISED).maxClass);
});

// --- A8: the generated capability-spine state reports five separate states. ---

test("A8: capability-spine state reports capability-ready, live-MCP-verified, OS-deployed, Gatekeeper-connected, and agent-proven as separate states", () => {
  const state = buildCapabilitySpineState();
  assert.deepEqual(Object.keys(state.states), [
    "capability_ready",
    "live_mcp_verified",
    "os_deployed",
    "gatekeeper_connected",
    "agent_proven",
  ]);
  assert.equal(state.states.capability_ready.satisfied, true);
  // None of CS-10/CS-12/CS-13/CS-14 exist yet, so none of these can be
  // false-green: unproven stays unproven, and none is inferred from another.
  for (const key of ["live_mcp_verified", "os_deployed", "gatekeeper_connected", "agent_proven"]) {
    assert.equal(state.states[key].satisfied, false, `${key} must not be false-green before its receipt exists`);
    assert.equal(state.states[key].state, "not_yet_proven");
  }
});

test("generated capability-spine state and report cannot drift from receipt classification", () => {
  assert.doesNotThrow(() => writeCapabilitySpineState({ check: true }));
});
