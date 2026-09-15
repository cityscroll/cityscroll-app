import assert from "node:assert/strict";
import { test } from "node:test";
import { checkConsultationDeployment, compareConsumerIdentities, validateDeploymentReadback } from "../tools/check_consultation_deployment.mjs";

const ids = ["dot-fast-buses-central-brooklyn", "dot-coney-island-transportation-study", "dot-secure-bike-parking", "dot-public-ebike-charging"];
const page = (extra = "") => `<main>${ids.map((id) => `<a href="/consultations/${id}/">${id}</a>`).join(" ")}${extra}</main>`;

test("deployment checker is bounded and records source, vintage, revision, detail, search, local and Now consumers", async () => {
  const seen = [];
  const receipt = await checkConsultationDeployment({
    baseUrl: "https://cityscroll.example",
    revision: "a".repeat(40),
    dataVintage: "2026-09-15T00:00:00.000Z",
    fetchImpl: async (url) => { seen.push(url); return new Response(page(), { status: 200 }); },
  });
  assert.equal(receipt.status, "pass");
  assert.equal(seen.length, 4);
  assert.deepEqual(receipt.consumers.map((row) => row.kind), ["canonical_detail", "search", "local", "now"]);
  assert.equal(receipt.source_observation.observation_ids.length, 4);
  assert.deepEqual(validateDeploymentReadback(receipt), []);
});

test("delivery evidence rejects a consumer that drops an admitted round", () => {
  const consumers = ids.map((id, index) => ({ path: `/${index}`, status: 200, admitted_round_ids: index === 2 ? ids.slice(0, -1) : ids, all_expected_present: index !== 2 }));
  const comparison = compareConsumerIdentities(consumers, ids);
  assert.equal(comparison.status, "fail");
  assert.equal(comparison.same_admitted_rounds, false);
});

test("two consecutive scheduled cycles retain one admitted identity set", () => {
  const cycles = [
    { cycle: "2026-09-15", event: "schedule", status: "succeeded", admitted_round_ids: ids },
    { cycle: "2026-09-16", event: "schedule", status: "succeeded", admitted_round_ids: ids },
  ];
  assert.equal(cycles.length, 2);
  assert.deepEqual(cycles[0].admitted_round_ids, cycles[1].admitted_round_ids);
  assert.ok(cycles.every((cycle) => cycle.event === "schedule" && cycle.status === "succeeded"));
});
