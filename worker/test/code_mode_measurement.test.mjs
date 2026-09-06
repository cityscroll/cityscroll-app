import assert from "node:assert/strict";
import test from "node:test";

import {
  INJECTED_FAILURE,
  createGrantedInvoker,
  modelInputTokens,
  runCodeModeMeasurement,
  serialized,
} from "../../integrations/cloudflare-os-code-mode/src/experiment.mjs";
import { createGrantedInvoker as sandboxInvoker } from "../../integrations/cloudflare-os-code-mode/src/sandbox.mjs";
import {
  buildCloudflareOsProof,
  verifyCloudflareOsProof,
} from "../../tools/verify_cloudflare_os_proof.mjs";
import {
  buildCodeModeMeasurementReceipt,
  verifyCodeModeMeasurementReceipt,
} from "../../tools/verify_code_mode_measurement.mjs";

test("CS-08 sandbox refuses ungranted tools before dispatch", async () => {
  let dispatched = 0;
  const invoke = sandboxInvoker(async () => {
    dispatched += 1;
    return { structuredContent: {} };
  });
  await assert.rejects(
    () => invoke("create_watch", { lens: "money" }),
    /ungranted tool/,
  );
  assert.equal(dispatched, 0);
  assert.equal(createGrantedInvoker, sandboxInvoker);
});

test("matched-arm token accounting ignores retrieval duration", () => {
  const fixture = {
    entity_id: "vendor:name:acme",
    notice_query: "acme",
    cited_query: "acme",
  };
  const record = (duration) => ({
    tool: "search_notices",
    arguments: { q: "acme", limit: 10 },
    structured_content: { retrieval: { method: "fts5_bm25", duration_ms: duration, rows_read: 2, result_count: 2 } },
  });
  assert.equal(
    modelInputTokens({
      arm: "ordinary_mcp",
      protocol: "ordinary-mcp",
      fixture,
      records: [record(0.5)],
      compactResult: { groups: {}, calls: [] },
    }),
    modelInputTokens({
      arm: "code_mode",
      protocol: "ordinary-mcp",
      fixture,
      records: [record(2.627)],
      compactResult: { groups: {}, calls: [] },
    }),
  );
});

test("CS-08 matched ordinary-MCP arms stay at parity and do not win", async () => {
  const cs07Proof = await buildCloudflareOsProof();
  const receipt = await runCodeModeMeasurement({
    repetitions: 2,
    warmups: 1,
    requireParity: true,
    maxP95Regression: 0.10,
    matchedArms: true,
    cs07Proof,
  });
  assert.equal(receipt.protocol.matched_arms, true);
  assert.equal(receipt.protocol.treatment_protocol, "ordinary-mcp");
  assert.equal(receipt.arms.ordinary_mcp.summary.semantic_parity_failures, 0);
  assert.equal(receipt.arms.code_mode.summary.semantic_parity_failures, 0);
  assert.equal(receipt.arms.ordinary_mcp.summary.provenance_parity_failures, 0);
  assert.equal(receipt.arms.code_mode.summary.provenance_parity_failures, 0);
  assert.equal(
    receipt.comparison.median_model_input_tokens.ordinary_mcp,
    receipt.comparison.median_model_input_tokens.code_mode,
  );
  assert.equal(receipt.comparison.median_external_round_trips.reduction, 0);
  assert.equal(receipt.comparison.median_store_reads.added, 0);
  assert.equal(receipt.gates.tokens_or_round_trips, false);
  assert.equal(receipt.verdict, "no-win");
});

test("CS-08 injected failure is fail-closed and identical on both arms", async () => {
  const cs07Proof = await buildCloudflareOsProof();
  const receipt = await runCodeModeMeasurement({
    repetitions: 1,
    warmups: 0,
    requireParity: true,
    maxP95Regression: 0.10,
    matchedArms: false,
    cs07Proof,
  });
  const ordinary = receipt.arms.ordinary_mcp.injected_failure;
  const codeMode = receipt.arms.code_mode.injected_failure;
  assert.equal(ordinary.ok, false);
  assert.equal(codeMode.ok, false);
  assert.equal(ordinary.fail_closed, true);
  assert.equal(codeMode.fail_closed, true);
  assert.equal(ordinary.failure_class, INJECTED_FAILURE.failure_class);
  assert.equal(codeMode.failure_class, INJECTED_FAILURE.failure_class);
  assert.equal(ordinary.workbook_present, false);
  assert.equal(codeMode.workbook_present, false);
  assert.equal(ordinary.store_reads, codeMode.store_reads);
  assert.equal(ordinary.ambient_egress, 0);
  assert.equal(codeMode.ambient_egress, 0);
  assert.equal(receipt.gates.fail_closed_identical, true);
});

test("CS-08 measurement receipt is isolated and matches the CS-07 frozen fixture", async () => {
  await verifyCloudflareOsProof();
  const receipt = await buildCodeModeMeasurementReceipt({
    repetitions: 30,
    warmups: 5,
    requireParity: true,
    maxP95Regression: 0.10,
  });
  assert.equal(receipt.schema, "cityscroll.code_mode_measurement_receipt.v1");
  assert.equal(receipt.card, "code-mode-measurement");
  assert.equal(receipt.prerequisite.status, "pass");
  assert.equal(receipt.prerequisite.raw_store_bindings, 0);
  assert.deepEqual(receipt.grant.capability_versions, [
    "cited.passages.retrieve@1",
    "entity.dossier.get@1",
    "entity.relationships.get@1",
    "notice.search@1",
  ]);
  assert.equal(receipt.isolation.raw_store_bindings, 0);
  assert.equal(receipt.isolation.credentials, 0);
  assert.equal(receipt.isolation.ambient_internet, false);
  assert.equal(receipt.grant.write_tools.length, 0);
  assert.equal(receipt.arms.ordinary_mcp.runs.length, 30);
  assert.equal(receipt.arms.code_mode.runs.length, 30);
  assert.equal(receipt.arms.code_mode.summary.semantic_parity_failures, 0);
  assert.equal(receipt.arms.code_mode.summary.provenance_parity_failures, 0);
  assert.ok(receipt.comparison.median_store_reads.added <= 0);
  assert.match(serialized(receipt), /"verdict": "(win|no-win)"/);
  assert.doesNotMatch(serialized(receipt), /api[_-]?key|bearer |password|secret/i);
  await verifyCodeModeMeasurementReceipt({
    repetitions: 30,
    warmups: 5,
    requireParity: true,
    maxP95Regression: 0.10,
  });
});
