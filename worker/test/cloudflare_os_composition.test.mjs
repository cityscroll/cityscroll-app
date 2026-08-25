import assert from "node:assert/strict";
import test from "node:test";

import {
  REQUIRED_TOOL_GRANT,
  renderEvidenceWorkbook,
} from "../../integrations/cloudflare-os-entity-research/src/gadget.mjs";
import {
  buildCloudflareOsProof,
  verifyCloudflareOsProof,
} from "../../tools/verify_cloudflare_os_proof.mjs";

test("CS-07 uses exactly four registered public-read tools", () => {
  assert.deepEqual(
    REQUIRED_TOOL_GRANT.map(({ name }) => name),
    ["get_entity_dossier", "get_entity_relationships", "search_notices", "retrieve_cited_passages"],
  );
  assert.equal(new Set(REQUIRED_TOOL_GRANT.map(({ name }) => name)).size, 4);
  assert.ok(REQUIRED_TOOL_GRANT.every(({ authority_class }) => authority_class === "public_read"));
});

test("CS-07 Gadget refuses incomplete composition", () => {
  assert.throws(
    () => renderEvidenceWorkbook([]),
    /exactly four capability results/,
  );
});

test("CS-07 executes the deterministic MCP composition and matches its receipt", async () => {
  const proof = await buildCloudflareOsProof();
  assert.equal(proof.status, "pass");
  assert.equal(proof.workflow.call_count, 4);
  assert.equal(proof.workflow.model_enabled, false);
  assert.equal(proof.deployment.raw_store_bindings, 0);
  assert.equal(proof.rollback.rehearsal, "pass");
  await verifyCloudflareOsProof();
});
