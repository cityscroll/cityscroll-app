/**
 * C6 Path B offline framing + matching proofs.
 * Fixtures are redacted classic `wrangler tail --format json` captures (and
 * shape-derived envelopes from that real health event). No provider writes.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  httpReceiptFromProviderEvent,
  normalizeWranglerTailEvent,
  parseWranglerTailJsonStream,
  providerEventsFromWranglerTailStream,
  selectOwnedHttpEvent,
} from "./lib/worker_cost_acquisition.mjs";
import { WAREHOUSE_EXPERIMENT_BASE_ROUTES } from "./lib/worker_cost_control.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "../test/fixtures/worker-cost");
const REAL_NDJSON = join(FIXTURES, "c6-wrangler-tail-redacted.ndjson");
const PRETTY = join(FIXTURES, "c6-wrangler-tail-pretty.jsonl-ish.txt");
const DERIVED = join(FIXTURES, "c6-path-b-shape-derived-cohorts.ndjson");

const OUTER_URL = "https://api.cityscroll.org/admin/cost-control-probe";

function loadNdjson(path) {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function receiptFromEvent(event) {
  for (const log of event.logs || []) {
    const message = Array.isArray(log.message) ? log.message[0] : log.message;
    if (typeof message !== "string") continue;
    const parsed = JSON.parse(message);
    if (parsed?.schema === "cityscroll.worker_cost_probe.v1") return parsed;
  }
  throw new Error("fixture event missing worker_cost_probe receipt");
}

function expectationFromOwnedEvent(event, {
  providerVersionId = event.scriptVersion?.id || event.$workers?.scriptVersion?.id,
} = {}) {
  const receipt = receiptFromEvent(event);
  const request = event.event?.request || event.$workers?.event?.request;
  return {
    header: request.headers["x-cityscroll-cost-probe"] || request.headers["X-Cityscroll-Cost-Probe"],
    series: receipt.series,
    probeCohort: receipt.cohort,
    workloadHash: receipt.workload_hash,
    outerUrl: request.url,
    providerVersionId,
    receipt: {
      result: {
        status: receipt.result.status,
        body_sha256: receipt.result.body_sha256,
        correctness: receipt.result.correctness,
      },
    },
  };
}

test("C6 pretty-printed wrangler tail stream: line JSON.parse yields zero; stream parser recovers events", () => {
  const pretty = readFileSync(PRETTY, "utf8");
  let lineOk = 0;
  let lineFail = 0;
  for (const line of pretty.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      JSON.parse(trimmed);
      lineOk += 1;
    } catch {
      lineFail += 1;
    }
  }
  assert.equal(lineOk, 0, "pretty-printed wrangler lines must not parse as complete JSON");
  assert.ok(lineFail > 0);

  const parsed = parseWranglerTailJsonStream(pretty);
  assert.equal(parsed.length, 2);
  const normalized = providerEventsFromWranglerTailStream(pretty);
  assert.equal(normalized.length, 2);
  for (const event of normalized) {
    assert.ok(event.$workers?.scriptVersion?.id);
    assert.equal(event.$workers.event.request.method, "POST");
    assert.equal(event.$workers.event.request.url, OUTER_URL);
  }
});

test("C6 redacted real health event matches selectOwnedHttpEvent after normalize", () => {
  const [raw] = loadNdjson(REAL_NDJSON);
  const event = normalizeWranglerTailEvent(raw);
  assert.ok(event);
  const expectation = expectationFromOwnedEvent(event);
  assert.equal(expectation.probeCohort, "health");
  assert.equal(expectation.outerUrl, OUTER_URL);
  const selected = selectOwnedHttpEvent([event], expectation, "health");
  assert.equal(selected.$workers.scriptVersion.id, expectation.providerVersionId);
  assert.equal(httpReceiptFromProviderEvent(selected, expectation).tag, expectation.header);
});

test("shape-derived C6 envelopes: positive match per warehouse cohort × arm", () => {
  const rawEvents = loadNdjson(DERIVED);
  assert.equal(rawEvents.length, WAREHOUSE_EXPERIMENT_BASE_ROUTES.length * 2);
  const seen = new Set();
  for (const raw of rawEvents) {
    const event = normalizeWranglerTailEvent(raw);
    const expectation = expectationFromOwnedEvent(event);
    const cohort = expectation.probeCohort;
    assert.ok(WAREHOUSE_EXPERIMENT_BASE_ROUTES.includes(cohort), cohort);
    const selected = selectOwnedHttpEvent([event], expectation, cohort);
    assert.equal(selected.$workers.scriptVersion.id, expectation.providerVersionId);
    seen.add(`${cohort}:${expectation.providerVersionId}`);
  }
  assert.equal(seen.size, WAREHOUSE_EXPERIMENT_BASE_ROUTES.length * 2);
});

test("negatives: foreign request, wrong version, missing probe header", () => {
  const [raw] = loadNdjson(REAL_NDJSON);
  const event = normalizeWranglerTailEvent(raw);
  const expectation = expectationFromOwnedEvent(event);

  assert.throws(
    () => selectOwnedHttpEvent([event], { ...expectation, header: "cost-foreign-header" }, "health"),
    /requires exactly one owned provider event/,
  );

  assert.throws(
    () => selectOwnedHttpEvent(
      [event],
      { ...expectation, providerVersionId: "00000000-0000-0000-0000-000000000000" },
      "health",
    ),
    /requires exactly one owned provider event/,
  );

  const missingHeader = structuredClone(event);
  delete missingHeader.event.request.headers["x-cityscroll-cost-probe"];
  delete missingHeader.$workers.event.request.headers["x-cityscroll-cost-probe"];
  assert.throws(
    () => selectOwnedHttpEvent([missingHeader], expectation, "health"),
    /requires exactly one owned provider event/,
  );
});

test("offline C6 replay: stream → normalize → per-cohort retained counts (non-zero where captured)", () => {
  const pretty = readFileSync(PRETTY, "utf8");
  const events = providerEventsFromWranglerTailStream(pretty);
  assert.equal(events.length, 2);

  const retained = Object.fromEntries(WAREHOUSE_EXPERIMENT_BASE_ROUTES.map((cohort) => [cohort, 0]));
  for (const event of events) {
    const expectation = expectationFromOwnedEvent(event);
    const cohort = expectation.probeCohort;
    try {
      selectOwnedHttpEvent([event], expectation, cohort);
      retained[cohort] += 1;
    } catch {
      /* not retained */
    }
  }

  // C6 diag only captured health probes; counts are below 100 by design.
  assert.ok(retained.health >= 1, `expected non-zero health retained, got ${retained.health}`);
  assert.equal(retained["zap-bbl"], 0);
  assert.equal(retained["zap-project"], 0);
  assert.equal(retained["doing-business"], 0);
  assert.equal(retained.browse, 0);

  // Persist replay receipt beside fixtures for the offline proof packet.
  const receipt = {
    schema: "cityscroll.cc06_path_b_offline_replay.v1",
    source: "test/fixtures/worker-cost/c6-wrangler-tail-pretty.jsonl-ish.txt",
    event_count: events.length,
    retained_by_cohort: retained,
    note: "C6 diag capture was health-only and brief; goal is non-zero correct matching after framing fix",
  };
  assert.equal(receipt.retained_by_cohort.health, 2);
});
