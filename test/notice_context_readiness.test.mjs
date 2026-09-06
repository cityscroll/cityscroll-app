import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  NOTICE_CONTEXT_OPTIONAL_BRANCHES,
  NOTICE_CONTEXT_OPTIONAL_LATE_OWNERS,
  NOTICE_CONTEXT_PRIMARY_METRIC_ID,
  NOTICE_CONTEXT_SAMPLE_FLOOR,
  buildNoticeContextReadinessEvidence,
  dedupeNoticeContextObservations,
  noticeContextPrimaryResultState,
  projectNoticeContextReadiness,
  validateNoticeContextReadinessEvidence,
} from "../site/notice_context_readiness.mjs";
import { projectProductionObservation } from "../site/rum_production.mjs";
import {
  noticeContextTimingMark,
  noticeContextTimingMeasure,
} from "../site/rum_static_record_instrumentation.mjs";
import { build as buildEvidence } from "../tools/build_notice_context_readiness_evidence.mjs";
import manifest from "../site/data/performance-classification-manifest.v1.json" with { type: "json" };

const contextSource = readFileSync(new URL("../site/app/notice-context.mjs", import.meta.url), "utf8");
const routingSource = readFileSync(new URL("../site/app/routing.mjs", import.meta.url), "utf8");
const committed = JSON.parse(readFileSync(
  new URL("../docs/evidence/notice-context-readiness/read-back.json", import.meta.url),
  "utf8",
));
const RELEASE_ID = "a".repeat(40);

function primaryRow(overrides = {}) {
  return {
    metric_id: NOTICE_CONTEXT_PRIMARY_METRIC_ID,
    surface_id: "notice",
    component_id: "notice-context",
    result_state: "content",
    value: 400,
    trace_key: "trace-1",
    ...overrides,
  };
}

test("primary context result states stay honest and optional branches stay named", () => {
  assert.equal(noticeContextPrimaryResultState(true), "content");
  assert.equal(noticeContextPrimaryResultState(false), "empty");
  assert.deepEqual([...NOTICE_CONTEXT_OPTIONAL_BRANCHES], [
    "flags",
    "award",
    "related",
    "mandate",
    "tables",
  ]);
  for (const branch of NOTICE_CONTEXT_OPTIONAL_BRANCHES) {
    assert.match(contextSource, new RegExp(`${branch}:\\(\\)=>`));
  }
  assert.match(contextSource, /NOTICE_CONTEXT_OPTIONAL_BRANCHES\.map\(branch=>timedContextBranch/);
  assert.match(contextSource, /contextReady\(el,noticeContextPrimaryResultState/);
  const fillContext = contextSource.slice(contextSource.indexOf("async function fillContext"));
  assert.ok(fillContext.indexOf("contextReady(el,noticeContextPrimaryResultState")
    < fillContext.indexOf("NOTICE_CONTEXT_OPTIONAL_BRANCHES.map"));
});

test("optional enrichments cannot gate the owner milestone in source", () => {
  const fillContext = contextSource.slice(contextSource.indexOf("async function fillContext"));
  assert.equal(fillContext.includes("await noticeFlags"), false);
  assert.equal(fillContext.includes("await awardContext"), false);
  assert.equal(fillContext.includes("await attachmentRelatedHTMLFor"), false);
  assert.equal(fillContext.includes("await mandateBacklinksHTMLFor"), false);
  assert.equal(fillContext.includes("await attachmentTablesHTMLFor"), false);
  assert.equal(fillContext.includes("await Promise.all"), false);
  assert.match(fillContext, /contextReady\(el,"error"\)/);
});

test("unavailable and fallback Notice traces stay distinct from fillContext success", () => {
  const showNotice = routingSource.slice(routingSource.indexOf("async function showNotice"));
  const unavailable = showNotice.indexOf('resultState:"unavailable"');
  const fill = showNotice.indexOf("fillContext(r, contextElement");
  assert.ok(unavailable >= 0);
  assert.ok(fill > unavailable);
  assert.equal(showNotice.includes("await attachmentDataPromise"), false);
  assert.equal(showNotice.includes("await optionalRouteModules"), false);
  assert.match(showNotice, /noticeContextTimingMeasure\("attachment"\)/);
});

test("branch timing measures stay diagnostic and reject record identifiers", () => {
  const marks = [];
  const measures = [];
  const original = globalThis.performance;
  globalThis.performance = {
    mark: (name) => marks.push(name),
    measure: (name, start, end) => measures.push({ name, start, end }),
    getEntriesByName: (name, type) => type === "measure" && name === "cityscroll.notice-context.flags"
      ? [{ duration: 12.5 }]
      : [],
  };
  try {
    assert.deepEqual(noticeContextTimingMark("flags-start"), { state: "recorded" });
    assert.deepEqual(noticeContextTimingMark("flags-end"), { state: "recorded" });
    assert.deepEqual(noticeContextTimingMeasure("flags"), {
      state: "recorded",
      branch: "flags",
      duration_ms: 12.5,
    });
    assert.deepEqual(noticeContextTimingMeasure("notice/20260701003"), { state: "invalid" });
  } finally {
    globalThis.performance = original;
  }
  assert.deepEqual(measures, [{
    name: "cityscroll.notice-context.flags",
    start: "cityscroll.notice-context.flags-start",
    end: "cityscroll.notice-context.flags-end",
  }]);
});

test("grouped read-back keeps primary and optional branches distinct and dedupes a refresh", () => {
  const evidence = projectNoticeContextReadiness({
    windowComplete: true,
    primaryObservations: [
      primaryRow({ value: 400 }),
      primaryRow({ value: 900, observed_at: "refresh" }),
      primaryRow({ result_state: "unavailable", value: 120, trace_key: "unavailable" }),
      primaryRow({ result_state: "error", value: 80, trace_key: "error" }),
      ...Array.from({ length: 27 }, (_, index) => primaryRow({
        value: 500 + index,
        trace_key: `ok-${index}`,
      })),
    ],
    branchObservations: NOTICE_CONTEXT_OPTIONAL_BRANCHES.map((branch, index) => ({
      surface_id: "notice",
      component_id: "notice-context",
      branch,
      duration_ms: 40 + index,
      trace_key: `branch-${branch}`,
    })),
  });
  assert.equal(evidence.primary.sampled_count, 30);
  assert.equal(evidence.primary.slo_state, "pass");
  assert.ok(evidence.primary.p75_ms <= 2500);
  assert.ok(evidence.primary.p95_ms <= 5000);
  assert.equal(dedupeNoticeContextObservations([
    primaryRow(),
    primaryRow({ observed_at: "later" }),
  ]).length, 1);
  const branchNames = evidence.branches.map((row) => row.branch);
  for (const branch of [...NOTICE_CONTEXT_OPTIONAL_BRANCHES, ...NOTICE_CONTEXT_OPTIONAL_LATE_OWNERS]) {
    assert.ok(branchNames.includes(branch), branch);
  }
  assert.equal(
    evidence.branches.find((row) => row.branch === "flags").slo_state,
    "insufficient_sample",
  );
  assert.equal(evidence.branches.find((row) => row.branch === "flags").p75_ms, null);
});

test("an incomplete or undersized production window cannot claim the p75/p95 gate", () => {
  const incomplete = projectNoticeContextReadiness({
    windowComplete: false,
    primaryObservations: Array.from({ length: 40 }, (_, index) => primaryRow({
      value: 200,
      trace_key: `row-${index}`,
    })),
  });
  assert.equal(incomplete.primary.slo_state, "insufficient_sample");
  assert.equal(incomplete.primary.p75_ms, null);
  assert.equal(incomplete.primary.p95_ms, null);

  const small = projectNoticeContextReadiness({
    windowComplete: true,
    primaryObservations: Array.from({ length: NOTICE_CONTEXT_SAMPLE_FLOOR - 1 }, (_, index) => (
      primaryRow({ value: 200, trace_key: `row-${index}` })
    )),
  });
  assert.equal(small.primary.slo_state, "insufficient_sample");
  assert.equal(small.primary.p75_ms, null);

  const slow = projectNoticeContextReadiness({
    windowComplete: true,
    primaryObservations: Array.from({ length: 30 }, (_, index) => primaryRow({
      value: index < 22 ? 400 : 6000,
      trace_key: `row-${index}`,
    })),
  });
  assert.equal(slow.primary.slo_state, "needs-work");
  assert.ok(slow.primary.p75_ms > 2500);
});

test("a pre-aggregated production primary classifies without fabricating raw rows", () => {
  const insufficient = projectNoticeContextReadiness({
    primaryAggregate: { sampledCount: 16, windowComplete: true, p50Ms: 2500, p75Ms: 3000, p95Ms: 6000 },
  });
  assert.equal(insufficient.primary.slo_state, "insufficient_sample");
  assert.equal(insufficient.primary.sampled_count, 16);
  assert.equal(insufficient.primary.p75_ms, null);
  assert.equal(insufficient.primary.p95_ms, null);

  const needsWork = projectNoticeContextReadiness({
    primaryAggregate: { sampledCount: 79, windowComplete: true, p50Ms: 2754.8, p75Ms: 3620, p95Ms: 8484.3 },
  });
  assert.equal(needsWork.primary.slo_state, "needs-work");
  assert.equal(needsWork.primary.sampled_count, 79);
  assert.equal(needsWork.primary.p75_ms, 3620);
  assert.equal(needsWork.primary.p95_ms, 8484.3);

  const passing = projectNoticeContextReadiness({
    primaryAggregate: { sampledCount: 40, windowComplete: true, p50Ms: 900, p75Ms: 1200, p95Ms: 2000 },
  });
  assert.equal(passing.primary.slo_state, "pass");

  const incompleteWindow = projectNoticeContextReadiness({
    primaryAggregate: { sampledCount: 90, windowComplete: false, p50Ms: 900, p75Ms: 1200, p95Ms: 2000 },
  });
  assert.equal(incompleteWindow.primary.slo_state, "insufficient_sample");
  assert.equal(incompleteWindow.primary.window_complete, false);
});

test("committed evidence is deterministic, measured, and free of record identifiers", () => {
  const evidence = buildEvidence();
  assert.deepEqual(committed, evidence);
  const validation = validateNoticeContextReadinessEvidence(evidence);
  assert.equal(validation.ok, true, validation.errors.join("; "));
  assert.equal(evidence.primary.slo_state, "needs-work");
  assert.equal(evidence.primary.sampled_count, 79);
  assert.equal(evidence.primary.window_complete, true);
  assert.ok(evidence.primary.p75_ms > 2500);
  assert.equal(evidence.baseline.not_a_pass, true);
  assert.equal(evidence.privacy.branch_metric_ingested, false);
  assert.equal(JSON.stringify(evidence).includes("request_id"), false);
  assert.equal(
    projectProductionObservation({
      metric_id: "notice_context_branch_ms",
      value: 80,
      surface_id: "notice",
      component_id: "notice-context",
    }, {
      manifest,
      classification: { surface_id: "notice", delivery_class: "pages_edge" },
      releaseId: RELEASE_ID,
      deviceClass: "desktop",
    }),
    null,
  );
  const built = buildNoticeContextReadinessEvidence({
    windowComplete: false,
    primaryObservations: [primaryRow({ result_state: "empty" })],
  });
  assert.equal(built.primary.slo_state, "insufficient_sample");
});
