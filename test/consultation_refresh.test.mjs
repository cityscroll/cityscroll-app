import assert from "node:assert/strict";
import { test } from "node:test";
import { acquireConsultationSources, consultationRefreshDisabled, runConsultationRefresh } from "../site/consultation_acquisition.mjs";

const response = (status, body = "ok") => ({
  status,
  headers: { get: (name) => name === "content-type" ? "text/html" : null },
  body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(body)); controller.close(); } }),
});

test("refresh preserves the last good materialization and its observed timestamp on partial failure", async () => {
  const previous = (await acquireConsultationSources({ fetchImpl: async () => response(200), asOf: "2026-09-14T00:00:00.000Z", transportOptions: { minOriginIntervalMs: 0 } })).materialization;
  const result = await acquireConsultationSources({ previous, fetchImpl: async () => response(503, "busy"), asOf: "2026-09-15T00:00:00.000Z", transportOptions: { minOriginIntervalMs: 0 } });
  assert.equal(result.receipt.last_good_preserved, true);
  assert.equal(result.materialization.observed_at, "2026-09-14T00:00:00.000Z");
  assert.deepEqual(result.materialization, previous);
  assert.ok(result.observations.every((row) => row.failure));
  assert.ok(result.materialization.consultations.every((row) => row.channels.every((channel) => channel.open_now === false)));
});

test("refresh kill switch is explicit and leaves the retained artifact untouched", async () => {
  assert.equal(consultationRefreshDisabled({ env: { CITYSCROLL_CONSULTATIONS_REFRESH: "off" }, root: "/does-not-exist" }), true);
  const result = await runConsultationRefresh({ root: "/tmp/cityscroll-consultation-refresh-test", env: { CITYSCROLL_CONSULTATIONS_REFRESH: "disabled" } });
  assert.equal(result.status, "skipped");
  assert.equal(result.receipt.kill_switch, true);
});

test("the source contract and scheduled builder are wired to the consultation materialization", async () => {
  const contract = JSON.parse(await (await import("node:fs/promises")).readFile("site/data/source_contracts.json", "utf8"));
  const row = contract.first_class_artifacts.find((entry) => entry.id === "public-consultations");
  assert.deepEqual(row.acquisition_command, ["node", "site/consultation_acquisition.mjs"]);
  assert.equal(row.normal_refresh_cadence_hours, 24);
  assert.ok(row.dependent_materializers.includes("tools/build_primary_documents.mjs"));
  assert.ok(row.dependent_materializers.includes("tools/build_keyword_search_index.mjs"));
});
