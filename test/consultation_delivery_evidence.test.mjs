import assert from "node:assert/strict";
import { test } from "node:test";

import {
  checkConsultationDeployment,
  compareConsumerIdentities,
  REQUIRED_CONSUMER_KINDS,
  validateDeploymentReadback,
} from "../tools/check_consultation_deployment.mjs";
import { withPinnedClock } from "./helpers/test_clock.mjs";

const ids = [
  "dot-fast-buses-central-brooklyn",
  "dot-coney-island-transportation-study",
  "dot-secure-bike-parking",
  "dot-public-ebike-charging",
];
const page = (extra = "") => `<main>${ids.map((id) => `<a href="/consultations/${id}/">${id}</a>`).join(" ")}${extra}</main>`;
const DAY = "2026-09-15T00:00:00.000Z";
const REVISION = "a".repeat(40);

test("A3 deployment checker is bounded and records the six named delivery fields", async () => {
  await withPinnedClock(DAY, async () => {
    const seen = [];
    const receipt = await checkConsultationDeployment({
      baseUrl: "https://cityscroll.example",
      revision: REVISION,
      dataVintage: DAY,
      fetchImpl: async (url) => {
        seen.push(url);
        return new Response(page(), { status: 200 });
      },
    });
    assert.equal(receipt.status, "pass");
    assert.equal(seen.length, 4);
    assert.deepEqual(receipt.consumers.map((row) => row.kind), [...REQUIRED_CONSUMER_KINDS]);
    assert.equal(receipt.source_observation.observation_ids.length, 4);

    // Named assertions for each of the six recorded fields.
    assert.ok(receipt.source_observation?.observation_ids?.length, "source observation");
    assert.equal(receipt.data_vintage, DAY, "data vintage");
    assert.equal(receipt.code_revision, REVISION, "code revision");
    assert.ok(receipt.consumers.some((row) => row.kind === "canonical_detail"), "canonical detail");
    assert.ok(receipt.consumers.some((row) => row.kind === "search"), "search");
    assert.ok(
      receipt.consumers.some((row) => row.kind === "local")
        && receipt.consumers.some((row) => row.kind === "now"),
      "applicable local/Now",
    );
    assert.deepEqual(validateDeploymentReadback(receipt), []);
  });
});

test("A3 validator rejects a receipt that omits any of the six named fields", () => {
  const base = {
    schema: "cityscroll.consultation_deployment_readback.v1",
    evidence_class: "live-production-read",
    code_revision: REVISION,
    data_vintage: DAY,
    source_observation: { observation_ids: ids.map((id) => `${id}:deployment-readback`) },
    consumers: REQUIRED_CONSUMER_KINDS.map((kind) => ({
      kind,
      path: `/${kind}`,
      status: 200,
      admitted_round_ids: kind === "canonical_detail" ? [ids[0]] : ids,
      all_expected_present: true,
    })),
    comparison: { same_admitted_rounds: true },
    bounds: { max_requests: 6, max_bytes: 2_000_000, requests: 4, bytes: 100 },
  };
  assert.deepEqual(validateDeploymentReadback(base), []);
  assert.ok(validateDeploymentReadback({ ...base, source_observation: { observation_ids: [] } }).includes("source observation identity is required"));
  assert.ok(validateDeploymentReadback({ ...base, data_vintage: null }).includes("data vintage is required"));
  assert.ok(validateDeploymentReadback({ ...base, code_revision: null }).includes("code revision is required"));
  assert.ok(validateDeploymentReadback({
    ...base,
    consumers: base.consumers.filter((row) => row.kind !== "canonical_detail"),
  }).some((error) => error.includes("canonical_detail")));
  assert.ok(validateDeploymentReadback({
    ...base,
    consumers: base.consumers.filter((row) => row.kind !== "search"),
  }).some((error) => error.includes("search")));
  assert.ok(validateDeploymentReadback({
    ...base,
    consumers: base.consumers.filter((row) => row.kind !== "now"),
  }).some((error) => error.includes("now")));
});

test("delivery evidence rejects a consumer that drops an admitted round", () => {
  const consumers = ids.map((id, index) => ({
    path: `/${index}`,
    status: 200,
    admitted_round_ids: index === 2 ? ids.slice(0, -1) : ids,
    all_expected_present: index !== 2,
  }));
  const comparison = compareConsumerIdentities(consumers, ids);
  assert.equal(comparison.status, "fail");
  assert.equal(comparison.same_admitted_rounds, false);
});
