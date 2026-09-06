import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  NOTICE_EDGE_CACHE_OUTCOMES,
  NOTICE_EDGE_DOCUMENT_CACHE_OUTCOME,
  NOTICE_EDGE_RECORD_ORIGIN,
  noticeEdgeCacheOutcome,
  noticeEdgeSubrequestKind,
  noticeEdgeTimingHeader,
  parseNoticeEdgeTiming,
} from "../site/notice_edge_response.mjs";
import {
  NOTICE_EDGE_MEASUREMENT_ID,
  measureNoticeEdgeTerminals,
  main as measureMain,
} from "../tools/measure_notice_edge_response.mjs";
import { build as buildEdgeResponseEvidence } from "../tools/build_notice_edge_response_evidence.mjs";

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));

const ceilings = readJson("../architecture/notice-edge-response-budget.json");
const committed = readJson("../docs/evidence/notice-edge-response/read-back.json");
const routes = readJson("../site/_routes.json");

const terminals = await measureNoticeEdgeTerminals();

test("a cache outcome is drawn from a closed set and absence is never read as one", () => {
  assert.deepEqual(NOTICE_EDGE_CACHE_OUTCOMES, ["hit", "miss", "stale", "dynamic", "unknown"]);
  assert.equal(noticeEdgeCacheOutcome("HIT"), "hit");
  assert.equal(noticeEdgeCacheOutcome("hit"), "hit");
  assert.equal(noticeEdgeCacheOutcome(" MISS "), "miss");
  assert.equal(noticeEdgeCacheOutcome("EXPIRED"), "stale");
  assert.equal(noticeEdgeCacheOutcome("REVALIDATED"), "stale");
  assert.equal(noticeEdgeCacheOutcome("BYPASS"), "dynamic");
  assert.equal(noticeEdgeCacheOutcome("DYNAMIC"), "dynamic");
  // Absence and an unrecognized status are absence, never one of the four measured outcomes.
  for (const absent of [null, undefined, "", "   ", 0, {}, "SOMETHING_NEW"]) {
    assert.equal(noticeEdgeCacheOutcome(absent), "unknown");
  }
});

test("the response header carries durations and outcomes, and nothing else", () => {
  const header = noticeEdgeTimingHeader({
    documentMs: 41.26,
    recordMs: 33.4,
    assetsMs: 12,
    recordCacheOutcome: "hit",
  });
  assert.equal(
    header,
    'cs-doc;dur=41.3;desc="dynamic", cs-record;dur=33.4;desc="hit", cs-assets;dur=12',
  );
  const parsed = parseNoticeEdgeTiming(header);
  assert.equal(parsed["cs-doc"].outcome, NOTICE_EDGE_DOCUMENT_CACHE_OUTCOME);
  assert.equal(parsed["cs-record"].outcome, "hit");
  assert.equal(parsed["cs-record"].duration_ms, 33.4);
  assert.equal(parsed["cs-assets"].outcome, null);

  // An unmeasured duration is omitted rather than reported as zero, and an
  // outcome outside the closed set falls back to absence.
  const partial = noticeEdgeTimingHeader({ documentMs: null, recordMs: -1, recordCacheOutcome: "warm" });
  assert.equal(partial, 'cs-doc;desc="dynamic", cs-record;desc="unknown", cs-assets');
  assert.deepEqual(parseNoticeEdgeTiming(partial)["cs-record"], { duration_ms: null, outcome: "unknown" });
  assert.deepEqual(parseNoticeEdgeTiming(undefined), {});
});

test("subrequest kinds are a bounded vocabulary and an unknown target is not guessed at", () => {
  assert.equal(noticeEdgeSubrequestKind("/"), "shell");
  assert.equal(noticeEdgeSubrequestKind("/data/meeting_outcomes_snapshot.json"), "meeting-outcomes");
  assert.equal(noticeEdgeSubrequestKind("/data/notice_mandate_backlinks_lookup.json"), "mandate-backlinks");
  assert.equal(noticeEdgeSubrequestKind(`${NOTICE_EDGE_RECORD_ORIGIN}?id=123`), "record");
  assert.equal(noticeEdgeSubrequestKind("https://data.cityofnewyork.us/resource/dg92-zbpx.json"), "public-source");
  assert.equal(noticeEdgeSubrequestKind("/data/something_else.json"), "other");
  assert.equal(noticeEdgeSubrequestKind(null), "other");
});

test("the Notice document is produced per request and never served from an edge cache entry", () => {
  // Both halves of the claim: the route reaches the function, and the serving
  // path never reads or writes the Cache API. Either one changing makes the
  // document's `dynamic` outcome a measurement question again.
  assert.ok(routes.include.includes("/notices/*"));
  const edgeSource = readFileSync(new URL("../site/pages_edge.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(edgeSource, /caches\s*\.\s*(default|open)\b/);
  assert.equal(committed.delivery.route_included_in_edge_function, true);
  assert.equal(committed.delivery.cache_api_used_by_serving_path, false);
  assert.equal(committed.delivery.document_cache_outcome, "dynamic");
  assert.equal(committed.delivery.document_cache_outcome_basis, "structural");
});

test("every Notice terminal stays inside its committed response-path ceilings", () => {
  for (const [name, ceiling] of Object.entries(ceilings.terminals)) {
    const measured = terminals[name];
    assert.ok(measured, `${name} terminal is measured`);
    assert.equal(measured.status, ceiling.status, `${name} status`);
    assert.ok(
      measured.subrequests <= ceiling.maxSubrequests,
      `${name} makes ${measured.subrequests} subrequests, ceiling ${ceiling.maxSubrequests}`,
    );
    assert.ok(
      measured.dependentStages <= ceiling.maxDependentStages,
      `${name} walks ${measured.dependentStages} dependent stages, ceiling ${ceiling.maxDependentStages}`,
    );
  }
  // The record read depends only on the requested id, so it is issued with the
  // resident reads rather than queued behind them. Re-serializing it would put
  // a round trip back on every Notice response.
  assert.equal(terminals.available.dependentStages, 1);
  assert.equal(terminals.absent.dependentStages, 1);
  assert.deepEqual(terminals.available.stages[0].subrequests, [
    "mandate-backlinks",
    "meeting-outcomes",
    "record",
    "shell",
  ]);
  // The degradation path is genuinely dependent: it runs only once the record
  // read has failed, so it stays a second stage rather than a speculative fetch.
  assert.equal(terminals.unavailable.dependentStages, 2);
  assert.deepEqual(terminals.unavailable.stages[1].subrequests, ["public-source"]);
});

test("the record served is the record requested, and an unproducible record reaches its honest terminal", () => {
  for (const measured of Object.values(terminals)) {
    assert.equal(measured.requestedRecordId, NOTICE_EDGE_MEASUREMENT_ID);
  }
  // A produced record is cacheable downstream for a day; a record that could not
  // be produced is not, so a failure is never held out as a current record.
  assert.equal(terminals.available.status, 200);
  assert.match(terminals.available.cacheControl, /s-maxage=86400/);
  assert.equal(terminals.absent.status, 404);
  assert.equal(terminals.unavailable.status, 503);
  for (const measured of [terminals.absent, terminals.unavailable]) {
    assert.equal(
      measured.cacheControl,
      "public, max-age=60, s-maxage=60, stale-while-revalidate=60, stale-if-error=60",
    );
  }
});

test("the response header reports how the response was produced and identifies nobody", () => {
  for (const measured of Object.values(terminals)) {
    const parsed = parseNoticeEdgeTiming(measured.serverTiming);
    assert.deepEqual(Object.keys(parsed).sort(), ["cs-assets", "cs-doc", "cs-record"]);
    assert.equal(parsed["cs-doc"].outcome, "dynamic");
    assert.ok(NOTICE_EDGE_CACHE_OUTCOMES.includes(parsed["cs-record"].outcome));
    // Nothing about the record or the reader travels on the header.
    assert.doesNotMatch(measured.serverTiming, new RegExp(NOTICE_EDGE_MEASUREMENT_ID));
    assert.doesNotMatch(measured.serverTiming, /notices|id=/i);
  }
});

test("the committed evidence matches what the response path and the read-backs say now", async () => {
  assert.deepEqual(buildEdgeResponseEvidence({ terminals }), committed);
  assert.equal(committed.claims_latency_improvement, false);
  assert.equal(committed.privacy.new_rum_identity, false);
  assert.equal(committed.privacy.record_identifiers, false);
  assert.equal(committed.privacy.reader_identifiers, false);
  assert.equal(await measureMain(["--check"]), 0);
});

test("a published tail states the sample behind it and names what is not retained", () => {
  const notice = committed.field_first_byte.notice;
  assert.equal(notice.sampled_count, 100);
  assert.equal(notice.p95_ms, 2012.1);
  assert.equal(notice.p95_tail_support.retained_rows_at_or_above_p95, 5);
  assert.equal(committed.field_first_byte.home.sampled_count, 150);
  assert.equal(committed.field_first_byte.home.p95_tail_support.retained_rows_at_or_above_p95, 8);
  // Devices are absent from the retained rows at both granularities, and are
  // reported as absent rather than estimated.
  const devices = committed.field_first_byte.notice_devices;
  assert.equal(devices.distinct_devices, null);
  assert.equal(devices.distinct_devices_state, "unmeasured");
  assert.equal(devices.device_class_breakdown_state, "not_retained");
  assert.deepEqual(devices.device_classes_with_data, []);
  // The readiness metrics do carry a device dimension, so the absence above is
  // this metric's, not the read-back's in general.
  assert.equal(
    committed.field_first_byte.notice_context_readiness_devices.device_class_breakdown_state,
    "retained",
  );
  assert.equal(committed.field_first_byte.percentile_composition.separable, false);
  assert.deepEqual(committed.unmeasured.map((entry) => entry.component), [
    "isolate_render_time",
    "document_edge_cache_hit_rate",
    "distinct_devices_behind_a_percentile",
    "share_of_the_readiness_tail_owned_by_the_first_byte",
    "record_cache_hit_rate",
    "device_class_composition_of_the_first_byte_tail",
  ]);
});

test("the two committed tails are reconciled by their window rule, and the gate reads one of them", () => {
  const reconciliation = committed.tail_reconciliation;
  const [anchored, rolling] = reconciliation.artifacts;

  assert.equal(anchored.selection_rule, "delivery-anchored");
  assert.equal(anchored.sampled_count, 79);
  assert.equal(anchored.p95_ms, 8484.3);
  assert.equal(rolling.selection_rule, "fixed-rolling-window");
  assert.equal(rolling.sampled_count, 85);
  assert.equal(rolling.p95_ms, 8001.9);

  // Exactly one of them is a budget artifact, and it is the one the gate reads.
  assert.deepEqual(
    reconciliation.artifacts.filter((entry) => entry.read_by_the_gate).map((entry) => entry.path),
    ["docs/evidence/notice-context-readiness/read-back.json"],
  );
  assert.equal(anchored.carries_budget, true);
  assert.equal(rolling.carries_budget, false);

  // The gate is the readiness classifier, and the artifact it reads is the one
  // its own builder writes.
  const readiness = readJson("../docs/evidence/notice-context-readiness/read-back.json");
  assert.equal(readiness.primary.p95_ms, anchored.p95_ms);
  assert.equal(readiness.primary.sampled_count, anchored.sampled_count);
  assert.ok(Number.isFinite(readiness.primary.p95_budget_ms));
  const lattice = readJson("../docs/evidence/field-coverage-lattice-read-back/read-back.json");
  const latticeCell = lattice.readiness_by_surface.notice.cells
    .find((cell) => cell.metric_id === "component_ready_ms" && cell.component_id === "notice-context");
  assert.equal(Math.round(latticeCell.percentiles.p95 * 10) / 10, rolling.p95_ms);
  assert.equal(latticeCell.slo_state, undefined, "the coverage read-back states no SLO");

  // The rolling window strictly contains the delivery-anchored one, which is why
  // it can admit observations the anchored window excludes. The anchored window
  // is read from the readiness builder's own input rather than restated here.
  const anchoredInput = readJson("../test/fixtures/notice-context-readiness/read-back-input.json");
  const [anchoredStart, anchoredEnd] = anchoredInput.primaryAggregate.window.split("/");
  assert.equal(anchoredInput.primaryAggregate.sampledCount, anchored.sampled_count);
  assert.ok(Date.parse(lattice.window.start) < Date.parse(anchoredStart));
  assert.ok(Date.parse(lattice.window.end) > Date.parse(anchoredEnd));
  assert.ok(rolling.sampled_count > anchored.sampled_count);
  assert.equal(reconciliation.separable, false);
  assert.equal(reconciliation.difference_sources.length, 2);
});
