import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { acquireConsultationSources, DOT_PILOT_SEEDS } from "../site/consultation_acquisition.mjs";
import { consultationRefreshDisabled, runConsultationRefresh } from "../tools/refresh_consultations.mjs";
import { withPinnedClock } from "./helpers/test_clock.mjs";
import {
  buildConsultationRepairObservations,
  repairObservationSet,
} from "../tools/repair_observations.mjs";

const DAY_ONE = "2026-09-14T00:00:00.000Z";
const DAY_TWO = "2026-09-15T00:00:00.000Z";
const TRANSPORT = { minOriginIntervalMs: 0, maxRetries: 0 };

const response = (status, body = "ok") => ({
  status,
  headers: { get: (name) => (name === "content-type" ? "text/html" : null) },
  body: new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  }),
});

async function goodMaterialization(asOf = DAY_ONE) {
  const result = await acquireConsultationSources({
    fetchImpl: async () => response(200),
    asOf,
    transportOptions: TRANSPORT,
  });
  return result.materialization;
}

test("A1 registration lists browse, search, and district dependents as a whole", async () => {
  const contract = JSON.parse(await (await import("node:fs/promises")).readFile("site/data/source_contracts.json", "utf8"));
  const row = contract.first_class_artifacts.find((entry) => entry.id === "public-consultations");
  assert.deepEqual(row.acquisition_command, ["node", "tools/refresh_consultations.mjs"]);
  assert.equal(row.normal_refresh_cadence_hours, 24);
  assert.deepEqual(row.dependent_materializers, [
    "tools/build_primary_documents.mjs",
    "tools/build_keyword_search_index.mjs",
    "tools/build_district_activity.mjs",
  ]);
});

test("A2 total source failure preserves the last-good artifact identically", async () => {
  await withPinnedClock(DAY_TWO, async () => {
    const previous = await goodMaterialization(DAY_ONE);
    const result = await acquireConsultationSources({
      previous,
      fetchImpl: async () => response(503, "busy"),
      asOf: DAY_TWO,
      transportOptions: TRANSPORT,
    });
    assert.equal(result.receipt.last_good_preserved, true);
    assert.equal(result.materialization.observed_at, DAY_ONE);
    assert.deepEqual(result.materialization, previous);
    assert.ok(result.observations.every((row) => row.failure));
    assert.ok(result.materialization.consultations.every((row) => row.channels.every((channel) => channel.open_now === false)));
  });
});

test("A2 partial-source failure retains last good and suppresses open-now on every channel", async () => {
  await withPinnedClock(DAY_TWO, async () => {
    const previous = await goodMaterialization(DAY_ONE);
    const failingUrl = DOT_PILOT_SEEDS[0].sources[0].url;
    let sawSuccess = false;
    let sawFailure = false;
    const result = await acquireConsultationSources({
      previous,
      fetchImpl: async (url) => {
        if (url === failingUrl) {
          sawFailure = true;
          return response(503, "busy");
        }
        sawSuccess = true;
        return response(200);
      },
      asOf: DAY_TWO,
      transportOptions: TRANSPORT,
    });
    assert.equal(sawSuccess, true);
    assert.equal(sawFailure, true);
    assert.ok(result.observations.some((row) => row.ok));
    assert.ok(result.observations.some((row) => !row.ok));
    assert.equal(result.receipt.last_good_preserved, true);
    assert.deepEqual(result.materialization, previous);
    assert.ok(result.materialization.consultations.every((row) => row.channels.every((channel) => channel.open_now === false)));
  });
});

test("A2 retry exhaustion retains last good after the transport budget is spent", async () => {
  await withPinnedClock(DAY_TWO, async () => {
    const previous = await goodMaterialization(DAY_ONE);
    let attempts = 0;
    const result = await acquireConsultationSources({
      previous,
      fetchImpl: async () => {
        attempts += 1;
        return response(503, "busy");
      },
      asOf: DAY_TWO,
      transportOptions: { minOriginIntervalMs: 0, maxRetries: 2 },
    });
    const sourceCount = DOT_PILOT_SEEDS.reduce((count, row) => count + row.sources.length, 0);
    assert.equal(attempts, sourceCount * (2 + 1));
    assert.ok(result.observations.every((row) => row.receipt?.retries === 2));
    assert.equal(result.receipt.last_good_preserved, true);
    assert.deepEqual(result.materialization, previous);
  });
});

test("A2 kill switch leaves the retained artifact untouched on disk", async () => {
  await withPinnedClock(DAY_TWO, async () => {
    assert.equal(consultationRefreshDisabled({ env: { CITYSCROLL_CONSULTATIONS_REFRESH: "off" }, root: "/does-not-exist" }), true);
    const root = mkdtempSync(join(tmpdir(), "consultation-kill-"));
    try {
      mkdirSync(join(root, "site/data"), { recursive: true });
      const output = join(root, "site/data/consultations.json");
      const retained = await goodMaterialization(DAY_ONE);
      const serialized = `${JSON.stringify(retained, null, 2)}\n`;
      writeFileSync(output, serialized);
      let calls = 0;
      const result = await runConsultationRefresh({
        root,
        asOf: DAY_TWO,
        env: { CITYSCROLL_CONSULTATIONS_REFRESH: "disabled" },
        fetchImpl: async () => {
          calls += 1;
          return response(200);
        },
      });
      assert.equal(calls, 0);
      assert.equal(result.status, "skipped");
      assert.equal(result.receipt.kill_switch, true);
      assert.equal(readFileSync(output, "utf8"), serialized);
      assert.deepEqual(result.materialization, retained);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("A2 failed sources expose source-specific repair evidence for authenticated Desk", async () => {
  await withPinnedClock(DAY_TWO, async () => {
    const previous = await goodMaterialization(DAY_ONE);
    const result = await acquireConsultationSources({
      previous,
      fetchImpl: async () => response(503, "busy"),
      asOf: DAY_TWO,
      transportOptions: TRANSPORT,
    });
    const contract = {
      id: "public-consultations",
      owner: "New York City public agencies and community boards",
      code_references: [{ path: "site/consultation_acquisition.mjs" }],
    };
    const rows = buildConsultationRepairObservations({
      observations: result.observations,
      contract,
      codeRevision: "a".repeat(40),
      observedAt: DAY_TWO,
    });
    assert.ok(rows.length >= 1);
    assert.ok(rows.every((row) => row.condition.id === "source-retrieval-failed"));
    assert.ok(rows.every((row) => row.source.contract_id === "public-consultations"));
    assert.equal(new Set(rows.map((row) => row.source.id)).size, rows.length);
    const set = repairObservationSet(rows, { observedAt: DAY_TWO, sourceVintage: DAY_ONE });
    assert.equal(set.consumer, "authenticated desk");
    assert.equal(set.visibility, "private");
    assert.equal(set.counts.repair, rows.length);
  });
});
