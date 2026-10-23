/**
 * C6 Path B offline framing + matching proofs.
 * Fixtures are redacted classic `wrangler tail --format json` captures (and
 * shape-derived envelopes from that real health event). No provider writes.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  accumulateOwnedHttpMatcherRejectionCounters,
  evaluateOwnedHttpEventPredicates,
  firstFailingOwnedHttpMatchPredicate,
  httpReceiptFromProviderEvent,
  normalizeWranglerTailEvent,
  parseWranglerTailJsonStream,
  providerEventsFromWranglerTailStream,
  selectOwnedHttpEvent,
} from "./lib/worker_cost_acquisition.mjs";
import { WAREHOUSE_EXPERIMENT_BASE_ROUTES } from "./lib/worker_cost_control.mjs";
import {
  beginCostControlProbe,
  canonicalCostProbeWorkload,
  logCostControlProbe,
} from "../worker/src/lib/cost_control_probe.mjs";

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

/**
 * Build a classic wrangler-tail --format json event exactly as the d036 Worker
 * emits for an accepted /admin/cost-control-probe (console.log(JSON.stringify(snapshot))).
 * Uses beginCostControlProbe.snapshot + the same log shape wrangler delivers.
 */
function d036WorkerShapedZapBblTailEvent({
  versionId = "aeca41e6-ef83-45f4-bcd4-076beb603c84",
  header = "cost-baseline-zap-bbl-0",
  series = "fixed-warehouse-synthseries01",
  useCapitalLogsKey = false,
} = {}) {
  const body = {
    kind: "http",
    route: "zap-bbl",
    method: "GET",
    url: "https://api.cityscroll.org/land-project?id=2018X0438",
  };
  // Mirror worker handleCostControlProbe: hash the request body with the same
  // canonicalCostProbeWorkload the Worker module exports.
  const workloadHash = createHash("sha256")
    .update(canonicalCostProbeWorkload(body))
    .digest("hex");
  const request = new Request("https://api.cityscroll.org/admin/cost-control-probe", {
    method: "POST",
    headers: {
      Authorization: "Bearer synthetic-admin-key",
      "Content-Type": "application/json",
      "x-cityscroll-cost-probe": header,
      "x-cityscroll-cost-cohort": "zap-bbl",
      "x-cityscroll-cost-workload": workloadHash,
      "x-cityscroll-cost-series": series,
    },
    body: JSON.stringify(body),
  });
  const probe = beginCostControlProbe(request, { ADMIN_KEY: "synthetic-admin-key" }, {
    workloadHash,
  });
  assert.equal(probe?.denied, null);
  probe.accept();
  const result = {
    status: 200,
    body_sha256: "11".repeat(32),
    correctness: {
      input_digest: workloadHash,
      joins_digest: "22".repeat(32),
      provenance_digest: "33".repeat(32),
      miss_digest: "44".repeat(32),
      freshness_digest: "33".repeat(32),
    },
  };
  // Same call site as worker.mjs: logCostControlProbe(probe, { result })
  const logged = [];
  const originalLog = console.log;
  console.log = (value) => { logged.push(value); };
  try {
    logCostControlProbe(probe, { result });
  } finally {
    console.log = originalLog;
  }
  assert.equal(logged.length, 1);
  assert.equal(typeof logged[0], "string");
  const snapshot = JSON.parse(logged[0]);
  assert.equal(snapshot.schema, "cityscroll.worker_cost_probe.v1");
  assert.equal(snapshot.cohort, "zap-bbl");
  assert.equal(snapshot.tag, header);
  assert.equal(snapshot.workload_hash, workloadHash);

  const raw = {
    cpuTime: 3,
    wallTime: 12,
    outcome: "ok",
    scriptName: "cityscroll-worker",
    executionModel: "stateless",
    truncated: false,
    eventTimestamp: 1_700_000_000_000,
    scriptVersion: { id: versionId },
    event: {
      request: {
        method: "POST",
        url: OUTER_URL,
        headers: {
          authorization: "[redacted]",
          "content-type": "application/json",
          "x-cityscroll-cost-probe": header,
          "x-cityscroll-cost-cohort": "zap-bbl",
          "x-cityscroll-cost-workload": workloadHash,
          "x-cityscroll-cost-series": series,
          "cloudflare-workers-version-overrides": `cityscroll-worker="${versionId}"`,
        },
      },
      response: { status: 200 },
    },
    exceptions: [],
  };
  // wrangler delivers console.log string as logs[].message string array.
  const logEntry = {
    message: [logged[0]],
    level: "log",
    timestamp: 1_700_000_000_001,
  };
  if (useCapitalLogsKey) raw.Logs = [logEntry];
  else raw.logs = [logEntry];
  return { raw, snapshot, expectation: {
    header,
    series,
    probeCohort: "zap-bbl",
    workloadHash,
    outerUrl: OUTER_URL,
    providerVersionId: versionId,
    receipt: {
      result: {
        status: result.status,
        body_sha256: result.body_sha256,
        correctness: result.correctness,
      },
    },
  } };
}

test("d036 Worker-shaped zap-bbl tail event: matcher accepts after normalize", () => {
  const { raw, expectation, snapshot } = d036WorkerShapedZapBblTailEvent();
  assert.equal(snapshot.cohort, "zap-bbl");
  assert.ok(snapshot.operation_counts?.kv_reads);
  const event = normalizeWranglerTailEvent(raw);
  assert.ok(event?.$workers?.scriptVersion?.id);
  const predicates = evaluateOwnedHttpEventPredicates(event, expectation, "zap-bbl");
  assert.equal(firstFailingOwnedHttpMatchPredicate(predicates), null);
  assert.equal(predicates.accepted, true);
  const selected = selectOwnedHttpEvent([event], expectation, "zap-bbl");
  assert.equal(httpReceiptFromProviderEvent(selected, expectation).cohort, "zap-bbl");
});

test("normalize must not let empty logs[] shadow legacy Logs (capital-key harden)", () => {
  const { raw, expectation } = d036WorkerShapedZapBblTailEvent({
    header: "cost-baseline-zap-bbl-capital-logs",
    useCapitalLogsKey: true,
  });
  assert.equal(Array.isArray(raw.Logs), true);
  assert.equal(raw.logs, undefined);
  const event = normalizeWranglerTailEvent(raw);
  assert.ok(Array.isArray(event.logs) && event.logs.length === 1);
  const predicates = evaluateOwnedHttpEventPredicates(event, expectation, "zap-bbl");
  assert.equal(
    firstFailingOwnedHttpMatchPredicate(predicates),
    null,
    "legacy Logs must survive normalize into logs for structured_log_receipt_present",
  );
  assert.equal(predicates.accepted, true);
  assert.ok(selectOwnedHttpEvent([event], expectation, "zap-bbl"));
});

test("matcher rejection counters: no_events_for_header vs structured_log_receipt_absent", () => {
  const { raw, expectation } = d036WorkerShapedZapBblTailEvent({
    header: "cost-baseline-zap-bbl-7",
  });
  const event = normalizeWranglerTailEvent(raw);
  const index = new Map([[expectation.header, [event]]]);
  const ok = accumulateOwnedHttpMatcherRejectionCounters(index, [expectation], "zap-bbl");
  assert.equal(ok.matched, 1);
  assert.equal(ok.no_events_for_header, 0);

  const missing = accumulateOwnedHttpMatcherRejectionCounters(
    new Map(),
    [expectation],
    "zap-bbl",
  );
  assert.equal(missing.no_events_for_header, 1);
  assert.equal(missing.matched, 0);

  const noLogsRaw = structuredClone(raw);
  delete noLogsRaw.logs;
  const noLogsEvent = normalizeWranglerTailEvent(noLogsRaw);
  const noLogsIndex = new Map([[expectation.header, [noLogsEvent]]]);
  const noLogs = accumulateOwnedHttpMatcherRejectionCounters(
    noLogsIndex,
    [expectation],
    "zap-bbl",
  );
  assert.equal(noLogs.reject_structured_log_receipt_present, 1);
  assert.equal(noLogs.matched, 0);

  const wrongCohort = {
    ...expectation,
    probeCohort: "health",
  };
  const cohortReject = accumulateOwnedHttpMatcherRejectionCounters(
    index,
    [wrongCohort],
    "health",
  );
  assert.equal(cohortReject.reject_cohort_matches, 1);
});

test("d036 Worker emission proof: logCostControlProbe writes cityscroll.worker_cost_probe.v1 with cohort", () => {
  const { snapshot } = d036WorkerShapedZapBblTailEvent();
  assert.equal(snapshot.schema, "cityscroll.worker_cost_probe.v1");
  assert.equal(snapshot.cohort, "zap-bbl");
  assert.equal(snapshot.execution_mode, "production-request");
  assert.ok(typeof snapshot.tag === "string" && snapshot.tag.startsWith("cost-"));
  assert.ok(/^[a-f0-9]{64}$/.test(snapshot.workload_hash));
  assert.equal(snapshot.result.status, 200);
});
