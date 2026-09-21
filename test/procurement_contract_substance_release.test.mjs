import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CLAIMS,
  EXAMPLES,
  FIXTURE_PATH,
  PRODUCTION_PATH,
  PROMOTION_PATH,
  PROMOTION_CLAIM_FAMILIES,
  PROMOTION_EXAMPLE_IDS,
  RELEASE_SCHEMA,
  PRODUCTION_SCHEMA,
  assertPromotionReceipt,
  assertReleasePacket,
  assertProductionPacket,
  buildFixturePacket,
  validatePromotionReceipt,
  validateReleasePacket,
} from "../tools/capture_procurement_contract_substance.mjs";

const packet = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
const production = JSON.parse(readFileSync(PRODUCTION_PATH, "utf8"));
const promotion = JSON.parse(readFileSync(PROMOTION_PATH, "utf8"));

function clone(value) {
  return structuredClone(value);
}

function mustReject(mutator, expectedText) {
  const candidate = clone(packet);
  mutator(candidate);
  const result = validateReleasePacket(candidate);
  assert.equal(result.ok, false, `mutation unexpectedly passed: ${expectedText}`);
  assert.match(result.errors.join("\n"), new RegExp(expectedText));
}

function mustRejectPromotion(mutator, expectedText) {
  const candidate = clone(promotion);
  mutator(candidate);
  const result = validatePromotionReceipt(candidate);
  assert.equal(result.ok, false, `promotion mutation unexpectedly passed: ${expectedText}`);
  assert.match(result.errors.join("\n"), new RegExp(expectedText));
}

function readyPromotionCell(claimFamily, receipt = promotion) {
  for (const example of receipt.examples) {
    const cell = example.cells.find((candidate) => candidate.claim_family === claimFamily && candidate.status === "ready");
    if (cell) return { example, cell };
  }
  throw new Error(`no ready promotion cell for ${claimFamily}`);
}

function readyPromotionBrowserCell(claimFamily, receipt = promotion) {
  for (const example of receipt.examples) {
    const cell = example.cells.find((candidate) => candidate.claim_family === claimFamily
      && candidate.status === "ready" && candidate.evidence?.evidence_type === "browser_dom");
    if (cell) return { example, cell };
  }
  throw new Error(`no ready browser promotion cell for ${claimFamily}`);
}

test("A1/A2: the committed matrix covers BHRAGS and all three named sub-$100k contracts", () => {
  assert.equal(packet.schema, RELEASE_SCHEMA);
  assert.deepEqual(packet.examples.map((row) => row.contract_id), Object.keys(EXAMPLES));
  const bhrags = packet.examples.find((row) => row.contract_id === "CT107120258801626");
  assert.equal(bhrags.amount, 10869881);
  assert.equal(bhrags.claims.amount.status, "ready");
  assert.equal(bhrags.claims.service_geography.status, "ready");
  assert.equal(bhrags.claims.service_geography.evidence.place_role, "facility_site");
  assert.match(bhrags.claims.service_geography.evidence.source.excerpt, /3218 Emmons Avenue/);
  assert.match(bhrags.claims.service_geography.evidence.source.identity_basis, /20240829105/);
  assert.equal(bhrags.access.executed_contract.access_state, "account_gated");
  assert.equal(bhrags.access.performance_evaluation.access_state, "not_located");

  for (const [id, expected] of Object.entries(EXAMPLES)) {
    const example = packet.examples.find((row) => row.contract_id === id);
    assert.ok(example);
    assert.ok(example.amount < 100000 || id === "CT107120258801626");
    assert.equal(example.amount, expected.amount);
    assert.deepEqual(Object.keys(example.claims), CLAIMS);
    for (const role of ["executed_contract", "statement_of_work", "pricing_schedule", "site_schedule", "performance_evaluation"]) {
      assert.ok(example.access[role], `${id}/${role}`);
      assert.ok(["account_gated", "not_located", "public_document", "metadata_only", "fetch_failed"].includes(example.access[role].access_state));
    }
  }
});

test("A3: no account-gated observation is promoted as public contract substance", () => {
  for (const example of packet.examples) {
    for (const claimId of ["scope", "pricing", "promises"]) {
      assert.equal(example.claims[claimId].status, "not_ready", `${example.contract_id}/${claimId}`);
      assert.match(example.claims[claimId].reason, /account_gated|not_located/);
    }
  }
  assert.deepEqual(packet.admitted_public_executed_examples, []);
  assert.equal(packet.readiness.per_claim.promises.ready, false);
  assert.equal(packet.production_readiness.ready, false);
});

test("A4: amendment totals and project context remain bounded claims", () => {
  const firematic = packet.boundaries.find((row) => row.contract_id === "CT185720228800365");
  const tameer = packet.boundaries.find((row) => row.contract_id === "CT185020228802305");
  for (const row of [firematic, tameer]) {
    assert.equal(row.status, "bounded");
    assert.deepEqual(row.allowed_claims, ["amendment_total"]);
    assert.ok(row.disallowed_claims.includes("executed_scope"));
  }
  const museum = packet.boundaries.find((row) => row.example === "museum-project-context");
  assert.equal(museum.status, "context_only");
  assert.deepEqual(museum.allowed_claims, ["project_context"]);
  assert.ok(museum.disallowed_claims.includes("executed_contract_scope"));
});

test("A5: the receipt rejects missing and duplicate obligations and forbidden substitutions", () => {
  mustReject((candidate) => {
    candidate.obligations = candidate.obligations.slice(1);
  }, "missing obligation");
  mustReject((candidate) => {
    candidate.obligations.push({ ...candidate.obligations[0] });
  }, "duplicate obligations");
  mustReject((candidate) => {
    candidate.examples[0].claims.service_geography.evidence.evidence_type = "api_json";
  }, "API-for-DOM substitution");
  mustReject((candidate) => {
    candidate.examples[0].claims.service_geography.evidence.revision = "0".repeat(40);
  }, "claim stale served identity");
  mustReject((candidate) => {
    candidate.examples[0].claims.service_geography.evidence.initialization = "failed";
  }, "failed asynchronous initialization");
  mustReject((candidate) => {
    candidate.examples[0].claims.service_geography.evidence.place_role = "vendor_address";
  }, "wrong place role");
  mustReject((candidate) => {
    candidate.examples[0].claims.service_geography.evidence.source.url = "https://passport.cityofnewyork.us/login";
  }, "login-only or missing public URL");
  mustReject((candidate) => {
    candidate.examples[0].claims.service_geography.evidence.data_vintage = "1900-01-01";
  }, "claim date-basis mismatch");
});

test("A6: readiness is per example and per claim, never a passing-subset flag", () => {
  assert.equal(packet.readiness.whole_set_ready, false);
  assert.deepEqual(Object.keys(packet.readiness.per_example).sort(), Object.keys(EXAMPLES).sort());
  assert.deepEqual(Object.keys(packet.readiness.per_claim).sort(), [...CLAIMS].sort());
  assertReleasePacket(packet);
  const partial = clone(packet);
  partial.readiness.whole_set_ready = true;
  const result = validateReleasePacket(partial);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /readiness matrix is stale|passing subset/);
});

test("A1/A2: the promotion matrix names seven real examples and their distinct stories", () => {
  assertPromotionReceipt(promotion);
  assert.deepEqual(promotion.assertions.map((assertion) => assertion.id), ["A1", "A2", "A3", "A4", "A5", "A6", "A7"]);
  assert.deepEqual(promotion.claim_families, PROMOTION_CLAIM_FAMILIES);
  assert.deepEqual(promotion.examples.map((example) => example.example_id), PROMOTION_EXAMPLE_IDS);
  for (const example of promotion.examples) {
    assert.ok(example.canonical_identity_basis, example.example_id);
    assert.ok(example.route, example.example_id);
    assert.ok(example.stories.length >= 1, example.example_id);
    assert.equal(example.cells.length, PROMOTION_CLAIM_FAMILIES.length, example.example_id);
    for (const cell of example.cells) assert.ok(cell.assertion, `${example.example_id}/${cell.claim_family}`);
  }
  assert.ok(promotion.examples.find((example) => example.example_id === "bhrags-CT107120258801626").stories[0].includes("payment"));
  assert.ok(promotion.examples.find((example) => example.example_id === "dcas-bid-tab-2000090").stories[0].includes("bid-tab"));
  assert.ok(promotion.examples.find((example) => example.example_id === "mocs-november-2024-fcrc").stories[0].includes("proposed"));
  assert.ok(promotion.examples.find((example) => example.example_id === "docgo-CT180620248801671").stories[0].includes("oversight"));
});

test("A3: vendor-promise cells stay red until an admitted executed passage exists", () => {
  assert.equal(promotion.boundary.status, "not_ready");
  assert.equal(promotion.boundary.claim_family, "vendor_promise");
  assert.ok(promotion.boundary.required_evidence.includes("executed agreement"));
  for (const example of promotion.examples) {
    const cell = example.cells.find((candidate) => candidate.claim_family === "vendor_promise");
    assert.equal(cell.status, "not_ready", example.example_id);
    assert.equal(cell.reason, "no_public_executed_agreement_or_sow", example.example_id);
  }
  for (const standIn of ["fixture", "draft", "bid", "audit quotation", "authenticated screen", "nonofficial repost", "narrative"]) {
    assert.ok(promotion.boundary.rejected_standins.includes(standIn), standIn);
  }
});

test("A4: completion, deployment, and editorial readiness remain separate", () => {
  assert.equal(promotion.completion.status, "complete");
  assert.equal(promotion.completion.publisher_event_required, false);
  assert.equal(promotion.completion.missing_claims_remain_red, true);
  assert.equal(promotion.engineering_status.state, "complete");
  assert.equal(promotion.deployment_status.state, "observed");
  assert.equal(promotion.editorial_readiness.state, "bounded");
  assert.deepEqual(promotion.editorial_readiness.blocked_claim_families, ["vendor_promise"]);
});

test("A5: every green promotion cell carries complete real-source provenance", () => {
  const ready = promotion.examples.flatMap((example) => example.cells.filter((cell) => cell.status === "ready"));
  assert.ok(ready.length > 0);
  for (const cell of ready) {
    const evidence = cell.evidence;
    assert.ok(evidence.route || evidence.component);
    assert.match(evidence.served_build_revision, /^[a-f0-9]{40}$/i);
    assert.ok(evidence.data_vintage);
    assert.match(evidence.source_url, /^https:\/\//);
    assert.match(evidence.source_hash, /^sha256:[a-f0-9]{64}$/i);
    assert.ok(evidence.source_hash_basis);
    assert.ok(evidence.document_role);
    assert.ok(evidence.locator);
    assert.ok(evidence.assertion);
    assert.ok(evidence.identity_basis);
    assert.ok(evidence.viewport);
    assert.match(evidence.render_hash, /^[a-f0-9]{64}$/i);
    if (evidence.evidence_type === "source_document") assert.equal(evidence.content_hash, evidence.source_hash);
    assert.notEqual(evidence.provenance_class, "synthetic_fixture");
    assert.notEqual(evidence.provenance_class, "mutation");
  }
  assert.equal(promotion.provenance_counts.synthetic_fixture_cells, 0);
  assert.equal(promotion.provenance_counts.mutation_cells, 0);
  assert.equal(promotion.provenance_counts.real_source_cells, ready.length);
});

test("A6: the promotion receipt rejects substitutions, stale identity, role changes, and failed reads", () => {
  mustRejectPromotion((candidate) => {
    readyPromotionCell("access", candidate).cell.evidence.evidence_type = "api_json";
  }, "API-for-DOM substitution");
  mustRejectPromotion((candidate) => {
    readyPromotionCell("access", candidate).cell.evidence.served_build_revision = "0".repeat(40);
  }, "stale served identity");
  mustRejectPromotion((candidate) => {
    const { cell } = readyPromotionCell("pricing_role", candidate);
    cell.evidence.identity_basis = "unrelated contract CT000000000000000";
  }, "unrelated join|identity");
  mustRejectPromotion((candidate) => {
    const { cell } = readyPromotionCell("pricing_role", candidate);
    cell.evidence.document_role = "executed_agreement";
  }, "source-role change or wrong role");
  mustRejectPromotion((candidate) => {
    const { cell } = readyPromotionCell("access", candidate);
    cell.evidence.source_url = "https://passport.cityofnewyork.us/login";
  }, "login-only or missing source URL");
  mustRejectPromotion((candidate) => {
    const { cell } = readyPromotionBrowserCell("access", candidate);
    cell.evidence.initialization = "failed";
  }, "failed asynchronous initialization");
  mustRejectPromotion((candidate) => {
    const { cell } = readyPromotionCell("neighborhood", candidate);
    cell.evidence.place_role = "vendor_address";
  }, "wrong place role");
  mustRejectPromotion((candidate) => {
    const { example, cell } = readyPromotionCell("pricing_role", candidate);
    const vendorPromise = example.cells.find((entry) => entry.claim_family === "vendor_promise");
    vendorPromise.status = "ready";
    vendorPromise.evidence = structuredClone(cell.evidence);
    vendorPromise.evidence.document_role = "executed_agreement";
    vendorPromise.evidence.execution_evidence = { signature_present: false, effective_status_admitted: false };
  }, "blank signature or missing effective status");
  mustRejectPromotion((candidate) => {
    candidate.examples.pop();
  }, "matrix omits a named example");
});

test("A7: the editor packet separates safe-now statements from contract-disclosure blocks", () => {
  assert.ok(promotion.editor_packet.safe_to_send_now.length >= 5);
  assert.ok(promotion.editor_packet.blocked_by_contract_document_disclosure.length >= 1);
  assert.ok(promotion.editor_packet.safe_to_send_now.every((item) => item.claim_family && item.statement));
  assert.ok(promotion.editor_packet.blocked_by_contract_document_disclosure.some((item) => item.claim_family === "vendor_promise"));
});

test("fixture capture is reproducible from the real renderer and materialized data", async () => {
  const captured = await buildFixturePacket({ revision: packet.served_build.revision, captureClock: packet.captured_at });
  assert.deepEqual(captured, packet);
});

test("A1: the production artifact ties the named BHRAGS assertion to settled DOM observations", () => {
  assert.equal(production.schema, PRODUCTION_SCHEMA);
  assert.equal(production.mode, "production");
  assert.equal(production.evidence_class, "production-browser-dom");
  assert.equal(production.production_readiness.ready, true);
  assertProductionPacket(production);

  const example = production.examples[0];
  assert.deepEqual(example.facts, {
    authorized_total: 10869881,
    paid_total: 7385672.19,
    payment_count: 31,
    notice_id: "20240829105",
    address: "3218 Emmons Avenue, Brooklyn",
    units: 60,
    place_role: "facility_site",
    neighborhood: "Sheepshead Bay-Manhattan Beach-Gerritsen Beach",
  });
  assert.equal(example.claims.amount.evidence.evidence_type, "browser_dom");
  assert.equal(example.claims.service_geography.evidence.place_role, "facility_site");
  assert.deepEqual(example.viewport_observations.map((row) => row.viewport), ["desktop", "mobile"]);
  assert.equal(production.assertions[0].id, "A1");
  assert.match(production.assertions[0].artifact, /examples\[0\]/);
});

test("A1: production evidence rejects a stale served identity", () => {
  const stale = structuredClone(production);
  stale.examples[0].claims.amount.evidence.revision = "0".repeat(40);
  assert.throws(() => assertProductionPacket(stale), /stale served identity amount/);
});
