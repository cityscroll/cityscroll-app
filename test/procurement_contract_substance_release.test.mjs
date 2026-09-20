import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CLAIMS,
  EXAMPLES,
  FIXTURE_PATH,
  PRODUCTION_PATH,
  RELEASE_SCHEMA,
  PRODUCTION_SCHEMA,
  assertReleasePacket,
  assertProductionPacket,
  buildFixturePacket,
  validateReleasePacket,
} from "../tools/capture_procurement_contract_substance.mjs";

const packet = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
const production = JSON.parse(readFileSync(PRODUCTION_PATH, "utf8"));

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
