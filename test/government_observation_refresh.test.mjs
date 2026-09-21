import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  GOVERNMENT_RECEIPT_SCHEMA,
  GOVERNMENT_REFRESH_BOUNDS,
  GOVERNMENT_SOURCE_DEFINITIONS,
  buildGovernmentReadback,
  buildGovernmentScheduledReceipt,
  guidePolicyReviewState,
  readGovernmentScheduledReceipt,
  refreshGovernmentSource,
  runGovernmentObservationRefresh,
  scheduleFreshnessGuidance,
  writeGovernmentScheduledReceipt,
} from "../site/government_observation_refresh.mjs";

const source = GOVERNMENT_SOURCE_DEFINITIONS[0];
const asOf = "2026-09-15T12:00:00.000Z";
const response = (status, body, headers = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: (name) => headers[name.toLowerCase()] || null },
  async arrayBuffer() { return new TextEncoder().encode(body).buffer; },
});
const previous = {
  materialization: { schema: "pdc.v1", records: [{ id: "kept" }], observed_at: "2026-09-14T12:00:00.000Z" },
  receipt: { source_hash: "old-hash", materialization_hash: "old-materialization", cursor: "cursor-1", etag: "etag-1" },
};
const parse = (bytes) => JSON.parse(new TextDecoder().decode(bytes));

test("registers the three observer sources with daily cadence and shared bounds", () => {
  assert.deepEqual(GOVERNMENT_SOURCE_DEFINITIONS.map((item) => item.id), ["pdc-calendar", "bsa-calendar", "oath-trial-calendar"]);
  assert.ok(GOVERNMENT_SOURCE_DEFINITIONS.every((item) => item.cadenceHours <= 24 && item.cursor));
  assert.deepEqual(GOVERNMENT_REFRESH_BOUNDS, {
    maxRequests: 100, maxResponseBytes: 5 * 1024 * 1024, maxAggregateBytes: 25 * 1024 * 1024,
    timeoutMs: 25_000, maxRedirects: 3, retries: 2, minOriginIntervalMs: 2_000,
  });
});

test("successful capture records a source hash and extraction receipt", async () => {
  const result = await refreshGovernmentSource(source, {
    asOf, fetchImpl: async (url, init) => {
      assert.equal(url, source.url);
      assert.equal(init.headers.Accept, "text/html, application/json");
      return response(200, JSON.stringify({ schema: "pdc.v1", records: [{ id: "fresh" }] }), { etag: "etag-2" });
    }, parse,
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.materialization.records[0].id, "fresh");
  assert.match(result.receipt.source_hash, /^[0-9a-f]{64}$/);
  assert.equal(result.receipt.extraction_receipt.status, "ok");
  assert.equal(result.receipt.etag, "etag-2");
});

test("a scheduled run enforces request and aggregate byte budgets across sources", async () => {
  let calls = 0;
  const result = await runGovernmentObservationRefresh({
    asOf,
    sources: [source, { ...source, id: "bsa-calendar" }],
    bounds: { retries: 0, maxRequests: 2, maxAggregateBytes: 10 },
    fetchImpl: async () => { calls += 1; return response(200, JSON.stringify({ records: [{ id: "large-enough" }] })); },
    parse,
  });
  assert.equal(calls, 2);
  assert.equal(result.request_count, 2);
  assert.equal(result.status, "degraded");
  assert.ok(result.sources.every((row) => row.receipt.failure === "aggregate_byte_limit"));
});

test("network failure and retry exhaustion retain the last-good schedule", async () => {
  let attempts = 0;
  const result = await refreshGovernmentSource(source, { asOf, previous, fetchImpl: async () => { attempts += 1; throw new Error("offline"); } });
  assert.equal(attempts, GOVERNMENT_REFRESH_BOUNDS.retries + 1);
  assert.equal(result.status, "degraded");
  assert.equal(result.receipt.failure, "network_or_retry_exhaustion");
  assert.equal(result.receipt.last_good_preserved, true);
  assert.deepEqual(result.materialization.records, previous.materialization.records);
});

test("empty parse and schema drift are distinct failures and never become an empty schedule", async () => {
  const empty = await refreshGovernmentSource(source, { asOf, previous, fetchImpl: async () => response(200, "{}"), parse: () => ({ schema: "pdc.v1", records: [] }) });
  const drift = await refreshGovernmentSource(source, { asOf, previous, fetchImpl: async () => response(200, "{}"), parse: () => ({ schema: "changed.v9", items: [] }) });
  assert.equal(empty.receipt.failure, "empty_parse");
  assert.equal(drift.receipt.failure, "schema_drift");
  assert.equal(empty.materialization.records[0].id, "kept");
  assert.equal(drift.materialization.records[0].id, "kept");
});

test("kill switch skips acquisition and leaves retained materialization untouched", async () => {
  let calls = 0;
  const result = await refreshGovernmentSource(source, { asOf, previous, env: { CITYSCROLL_PDC_CALENDAR_REFRESH: "off" }, fetchImpl: async () => { calls += 1; } });
  assert.equal(calls, 0);
  assert.equal(result.status, "skipped");
  assert.equal(result.receipt.kill_switch, true);
  assert.deepEqual(result.materialization, previous.materialization);
});

test("conditional request and 304 preserve the prior successful materialization", async () => {
  let requestHeaders;
  const result = await refreshGovernmentSource(source, {
    asOf, previous, fetchImpl: async (_url, init) => { requestHeaders = init.headers; return response(304, "", {}); },
  });
  assert.equal(requestHeaders["If-None-Match"], "etag-1");
  assert.equal(result.status, "succeeded");
  assert.equal(result.receipt.not_modified, true);
  assert.deepEqual(result.materialization, previous.materialization);
});

test("freshness guidance appears only after 36 hours and points to the official source", () => {
  const fresh = scheduleFreshnessGuidance({ lastSuccessAt: "2026-09-14T12:00:00.000Z", asOf, officialUrl: source.url });
  const stale = scheduleFreshnessGuidance({ lastSuccessAt: "2026-09-13T00:00:00.000Z", asOf, officialUrl: source.url });
  assert.equal(fresh.stale, false);
  assert.equal(fresh.prompt, null);
  assert.equal(stale.stale, true);
  assert.match(stale.prompt, /official source/);
  assert.equal(stale.officialUrl, source.url);
});

test("scheduled receipt requires two successful cycles 24 hours apart and four readbacks", () => {
  const cycle1 = { status: "succeeded", observed_at: "2026-09-14T12:00:00.000Z", source_hash: "a" };
  const cycle2 = { status: "succeeded", observed_at: "2026-09-15T12:00:00.000Z", source_hash: "b" };
  const readback = buildGovernmentReadback({
    sourceId: source.id, cycle: cycle2, materializationHash: "m", buildRevision: "rev", publicationId: "pub",
    surfaces: Object.fromEntries(["canonical", "observer", "search", "ics"].map((key) => [key, { ok: true, content_hash: `${key}-hash` }])),
  });
  const receipt = buildGovernmentScheduledReceipt({ cycles: [cycle2, cycle1], readbacks: [readback], now: asOf });
  assert.equal(receipt.two_cycles_24h_apart, true);
  assert.equal(receipt.readbacks_passed, true);
  assert.equal(readback.assertions.ics, "passed");
  assert.equal(readback.success, true);
});

test("scheduled receipts are machine-readable and round-trip without images", () => {
  const directory = mkdtempSync(join(process.env.FM_TASK_SCRATCH || process.cwd(), "government-refresh-"));
  try {
    const path = join(directory, "receipt.json");
    const receipt = buildGovernmentScheduledReceipt({ now: asOf });
    writeGovernmentScheduledReceipt(path, receipt);
    assert.deepEqual(readGovernmentScheduledReceipt(path), receipt);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("guide policy review is a separate 30-day record, independent of the 36-hour schedule prompt", () => {
  const sameInstant = "2026-09-13T23:00:00.000Z";
  const staleSchedule = scheduleFreshnessGuidance({ lastSuccessAt: sameInstant, asOf, officialUrl: source.url });
  const currentReview = guidePolicyReviewState({ lastReviewAt: sameInstant, asOf });
  assert.equal(staleSchedule.stale, true);
  assert.equal(currentReview.due, false);
  const freshSchedule = scheduleFreshnessGuidance({ lastSuccessAt: "2026-09-15T10:00:00.000Z", asOf, officialUrl: source.url });
  const overdueReview = guidePolicyReviewState({ lastReviewAt: "2026-08-15T00:00:00.000Z", asOf });
  assert.equal(freshSchedule.stale, false);
  assert.equal(overdueReview.due, true);
  assert.equal(overdueReview.kind, "guide_policy_review");
  assert.equal(overdueReview.interval_days, 30);
  assert.equal("prompt" in overdueReview, false);
  assert.equal("stale" in overdueReview, false);
  assert.equal("due" in staleSchedule, false);
  assert.equal(guidePolicyReviewState({ asOf }).due, true);
});

test("resident reads make zero publisher requests over a poisoned global fetch", async () => {
  const originalFetch = globalThis.fetch;
  let poisonedCalls = 0;
  globalThis.fetch = async (requested) => {
    poisonedCalls += 1;
    throw new Error(`resident read attempted a publisher request: ${requested}`);
  };
  const directory = mkdtempSync(join(process.env.FM_TASK_SCRATCH || process.cwd(), "government-resident-"));
  try {
    const cycle = { status: "succeeded", observed_at: "2026-09-15T11:00:00.000Z", source_hash: "hash" };
    const readback = buildGovernmentReadback({
      sourceId: source.id, cycle, materializationHash: "m", buildRevision: "rev", publicationId: "pub",
      surfaces: Object.fromEntries(["canonical", "observer", "search", "ics"].map((key) => [key, { ok: true, content_hash: `${key}-hash` }])),
    });
    const receipt = buildGovernmentScheduledReceipt({ cycles: [cycle], readbacks: [readback], now: asOf });
    writeGovernmentScheduledReceipt(join(directory, "receipt.json"), receipt);
    assert.equal(readGovernmentScheduledReceipt(join(directory, "receipt.json")).schema, GOVERNMENT_RECEIPT_SCHEMA);
    const guidance = scheduleFreshnessGuidance({ lastSuccessAt: "2026-09-13T00:00:00.000Z", asOf, officialUrl: source.url });
    assert.equal(guidance.stale, true);
    assert.equal(poisonedCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("cycle spacing fails closed for cycles closer than 24 hours and for a failed cycle", () => {
  const closeCycles = buildGovernmentScheduledReceipt({
    cycles: [
      { status: "succeeded", observed_at: "2026-09-14T12:00:00.000Z", source_hash: "a" },
      { status: "succeeded", observed_at: "2026-09-15T11:59:00.000Z", source_hash: "b" },
    ],
    now: asOf,
  });
  assert.equal(closeCycles.consecutive_successful_cycles, 2);
  assert.equal(closeCycles.two_cycles_24h_apart, false);
  const withFailedCycle = buildGovernmentScheduledReceipt({
    cycles: [
      { status: "succeeded", observed_at: "2026-09-13T12:00:00.000Z", source_hash: "a" },
      { status: "failed", observed_at: "2026-09-14T12:00:00.000Z", source_hash: "b" },
    ],
    now: asOf,
  });
  assert.equal(withFailedCycle.consecutive_successful_cycles, 1);
  assert.equal(withFailedCycle.two_cycles_24h_apart, false);
});

test("scheduled receipt does not skip a failed cycle when counting consecutive successes", () => {
  const receipt = buildGovernmentScheduledReceipt({
    cycles: [
      { status: "succeeded", observed_at: "2026-09-13T12:00:00.000Z", source_hash: "a" },
      { status: "failed", observed_at: "2026-09-14T12:00:00.000Z", source_hash: "b" },
      { status: "succeeded", observed_at: "2026-09-15T12:00:00.000Z", source_hash: "c" },
    ],
    now: asOf,
  });
  assert.equal(receipt.consecutive_successful_cycles, 1);
  assert.equal(receipt.two_cycles_24h_apart, false);
});

test("a source that returns after a failed cycle recovers to a fresh capture", async () => {
  let failing = true;
  const fetchImpl = async () => {
    if (failing) throw new Error("offline");
    return response(200, JSON.stringify({ schema: "pdc.v1", records: [{ id: "recovered" }] }), { etag: "etag-3" });
  };
  const degraded = await refreshGovernmentSource(source, { asOf, previous, fetchImpl, parse });
  assert.equal(degraded.status, "degraded");
  assert.equal(degraded.receipt.last_good_preserved, true);
  assert.deepEqual(degraded.materialization.records, previous.materialization.records);
  failing = false;
  const recovered = await refreshGovernmentSource(source, { asOf, previous, fetchImpl, parse });
  assert.equal(recovered.status, "succeeded");
  assert.equal(recovered.receipt.failure, undefined);
  assert.equal(recovered.receipt.last_good_preserved, false);
  assert.equal(recovered.materialization.records[0].id, "recovered");
  assert.equal(recovered.materialization.retained_after_failure, undefined);
  assert.match(recovered.receipt.source_hash, /^[0-9a-f]{64}$/);
  assert.equal(recovered.receipt.extraction_receipt.status, "ok");
});
