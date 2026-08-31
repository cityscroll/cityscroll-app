import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  HANDOFF_KINDS,
  REPORT_VERDICTS,
  applyGuardedReprojection,
  recordReportAdjudication,
  replayMatches,
} from "../worker/src/lib/report_adjudication.mjs";
import {
  persistReportAdjudication,
} from "../worker/src/lib/report_adjudication_store.mjs";
import {
  projectPublicVerdictLabel,
  projectPublicVerdictSeam,
  publicVerdictSeamLeaksPrivate,
} from "../site/report_verdict_public.mjs";
import {
  REHEARSAL_CASES,
  REHEARSAL_NEGATIVE_CASES,
  checkRehearsal,
  replayRehearsalCase,
  runRehearsal,
} from "../tools/cc9_adjudication_rehearsal.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function memoryStore(map = {}) {
  return {
    get: async (key) => map[key] ?? null,
    put: async (key, value) => { map[key] = value; },
    list: async ({ prefix = "" } = {}) => ({
      keys: Object.keys(map).filter((name) => name.startsWith(prefix)).map((name) => ({ name })),
      list_complete: true,
    }),
    _map: map,
  };
}

function report(sourceRecordIds = ["src-1"]) {
  return {
    id: "fb:1:aaaa",
    message: "The displayed vendor does not match the source record.",
    evidence: "src-1 identifies Harbor Maintenance.",
    target_id: "procurement:contract:CC9",
    report_target: {
      target_id: "procurement:contract:CC9",
      provenance: { source_record_ids: sourceRecordIds },
    },
  };
}

test("every bounded verdict can be recorded with actor, time, evidence, and scope", () => {
  const at = "2026-08-31T15:00:00.000Z";
  const cases = [
    {
      verdict: "confirmed",
      evidence: ["src-1"],
      scope: { source_record_ids: ["src-1"] },
      source_change: {
        path: "vendor_ref",
        before: "A",
        after: "B",
        source_record_ids: ["src-1"],
      },
      reproject: true,
    },
    {
      verdict: "correct-as-displayed",
      evidence: ["src-1"],
      scope: { source_record_ids: ["src-1"] },
    },
    {
      verdict: "ambiguous or insufficient-evidence",
      evidence: [],
      scope: { source_record_ids: [] },
    },
    {
      verdict: "upstream-source-error",
      evidence: ["src-1"],
      scope: { source_record_ids: ["src-1"] },
    },
    {
      verdict: "duplicate",
      evidence: ["src-1"],
      scope: { source_record_ids: ["src-1"], original_report_id: "fb:0:zzzz" },
    },
  ];
  assert.equal(cases.length, REPORT_VERDICTS.length);
  for (const item of cases) {
    const recorded = recordReportAdjudication({
      report: report(),
      report_id: "fb:1:aaaa",
      actor: "maintainer:desk",
      at,
      command_id: `cmd-${item.verdict}`.replace(/\s+/g, "-"),
      civic_result: { vendor_ref: "A" },
      ...item,
    });
    assert.equal(recorded.ok, true, recorded.error);
    assert.equal(recorded.state.actor, "maintainer:desk");
    assert.equal(recorded.state.recorded_at, at);
    assert.ok(Array.isArray(recorded.state.evidence));
    assert.ok(recorded.state.scope);
    assert.deepEqual(recorded.state.handoffs.map((row) => row.kind).slice(0, 4), HANDOFF_KINDS.slice(0, 4));
  }
});

test("missing evidence cannot confirm or change the civic result", () => {
  const recorded = recordReportAdjudication({
    report: report(),
    report_id: "fb:1:aaaa",
    actor: "maintainer:desk",
    at: "2026-08-31T15:00:00.000Z",
    verdict: "confirmed",
    evidence: [],
    scope: { source_record_ids: ["src-1"] },
    source_change: {
      path: "vendor_ref",
      before: "A",
      after: "B",
      source_record_ids: ["src-1"],
    },
    reproject: true,
    civic_result: { vendor_ref: "A" },
  });
  assert.equal(recorded.ok, false);
  assert.equal(recorded.error, "evidence_required");
  assert.equal(recorded.civic_result_changed, false);
});

test("scope that names records outside the report fails closed", () => {
  const recorded = recordReportAdjudication({
    report: report(["src-1"]),
    report_id: "fb:1:aaaa",
    actor: "maintainer:desk",
    at: "2026-08-31T15:00:00.000Z",
    verdict: "confirmed",
    evidence: ["src-999"],
    scope: { source_record_ids: ["src-999"] },
  });
  assert.equal(recorded.ok, false);
  assert.equal(recorded.error, "scope_violation");
});

test("automatic correction acceptance is forbidden", () => {
  const recorded = recordReportAdjudication({
    report: report(),
    actor: "maintainer:desk",
    verdict: "confirmed",
    evidence: ["src-1"],
    scope: { source_record_ids: ["src-1"] },
    auto_apply: true,
    civic_result: { vendor_ref: "A" },
  });
  assert.equal(recorded.ok, false);
  assert.equal(recorded.error, "automatic_correction_forbidden");
});

test("guarded reprojection requires a named source change and leaves unresolved results unchanged", () => {
  const civic = { vendor_ref: "A" };
  const skipped = applyGuardedReprojection({
    civic_result: civic,
    source_change: null,
    verdict: "ambiguous-or-insufficient-evidence",
    evidence_complete: false,
    scope: { source_record_ids: [] },
  });
  assert.equal(skipped.applied, false);
  assert.equal(skipped.changed, false);
  assert.deepEqual(skipped.after, civic);

  const applied = applyGuardedReprojection({
    civic_result: civic,
    source_change: {
      status: "named",
      path: "vendor_ref",
      before: "A",
      after: "B",
      source_record_ids: ["src-1"],
    },
    verdict: "confirmed",
    evidence_complete: true,
    scope: { source_record_ids: ["src-1"] },
  });
  assert.equal(applied.applied, true);
  assert.equal(applied.after.vendor_ref, "B");
});

test("the public serializer exposes only an id-keyed label", () => {
  const recorded = recordReportAdjudication({
    report: report(),
    actor: "maintainer:desk",
    at: "2026-08-31T15:00:00.000Z",
    verdict: "confirmed",
    evidence: ["src-1"],
    scope: { source_record_ids: ["src-1"] },
    source_change: {
      path: "vendor_ref",
      before: "A",
      after: "B",
      source_record_ids: ["src-1"],
    },
    reproject: true,
    reporter_resolution: true,
    civic_result: { vendor_ref: "A" },
  });
  const label = projectPublicVerdictLabel(recorded.state);
  assert.deepEqual(Object.keys(label).sort(), ["id", "label", "schema"]);
  assert.equal(label.label, "corrected");
  assert.equal(publicVerdictSeamLeaksPrivate(label), false);
  assert.equal(JSON.stringify(label).includes("maintainer:desk"), false);
  assert.equal(JSON.stringify(label).includes("rationale"), false);
  const smuggled = projectPublicVerdictLabel({
    ...recorded.state,
    process: "internal review board",
    actor: "should-not-leak",
  });
  assert.equal(smuggled.actor, undefined);
  assert.equal(publicVerdictSeamLeaksPrivate(smuggled), false);
  assert.equal(publicVerdictSeamLeaksPrivate({
    schema: "cityscroll.report_verdict_label.v1",
    id: "fb:1",
    label: "reviewed",
    actor: "leaked",
  }), true);
});

test("optional reporter resolution is truthful and omits internal review", () => {
  const recorded = recordReportAdjudication({
    report: report(),
    actor: "maintainer:desk",
    verdict: "correct-as-displayed",
    evidence: ["src-1"],
    scope: { source_record_ids: ["src-1"] },
    reporter_resolution: true,
    civic_result: { vendor_ref: "A" },
  });
  assert.equal(recorded.state.reporter_resolution.summary.includes("matches the source record"), true);
  assert.equal(JSON.stringify(recorded.state.reporter_resolution).includes("maintainer:desk"), false);
  assert.equal(JSON.stringify(recorded.state.reporter_resolution).includes("process"), false);
});

test("durable handoff chain is complete and replay is idempotent", async () => {
  const store = memoryStore();
  const input = {
    report: report(),
    report_id: "fb:1:aaaa",
    actor: "maintainer:desk",
    at: "2026-08-31T15:00:00.000Z",
    command_id: "cmd-replay-1",
    verdict: "confirmed",
    evidence: ["src-1"],
    scope: { source_record_ids: ["src-1"] },
    source_change: {
      path: "vendor_ref",
      before: "A",
      after: "B",
      source_record_ids: ["src-1"],
    },
    reproject: true,
    reporter_resolution: true,
    civic_result: { vendor_ref: "A" },
  };
  const first = await persistReportAdjudication(store, input);
  const second = await persistReportAdjudication(store, input);
  assert.equal(first.ok, true);
  assert.equal(second.replayed, true);
  assert.deepEqual(second.state, first.state);
  assert.deepEqual(first.state.handoffs.map((row) => row.kind), HANDOFF_KINDS);
  assert.equal(replayMatches(first.state, input), true);

  const conflict = await persistReportAdjudication(store, { ...input, verdict: "correct-as-displayed", reproject: false, source_change: null });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error, "idempotency-key-conflict");
});

test("the controlled rehearsal covers every verdict and preserves unresolved civic results", () => {
  const rehearsal = runRehearsal();
  assert.deepEqual(rehearsal.cases.map((item) => item.class), [
    "confirmed_named_source_change",
    "correct_as_displayed",
    "ambiguous_or_insufficient_evidence",
    "upstream_source_error",
    "duplicate",
  ]);
  const confirmed = rehearsal.cases[0];
  assert.equal(confirmed.civic_result_changed, true);
  assert.equal(confirmed.public_label.label, "corrected");
  assert.deepEqual(confirmed.handoff_kinds, HANDOFF_KINDS);
  for (const item of rehearsal.cases.slice(1)) {
    assert.equal(item.civic_result_changed, false, item.id);
  }
  for (const item of REHEARSAL_NEGATIVE_CASES) {
    const recorded = replayRehearsalCase(item);
    assert.equal(recorded.ok, false, item.id);
    assert.equal(recorded.error, item.expect_error);
    assert.equal(recorded.civic_result_changed, false);
  }
  assert.equal(publicVerdictSeamLeaksPrivate(rehearsal.public_labels), false);
  for (const fixture of REHEARSAL_CASES) {
    const recorded = replayRehearsalCase(fixture);
    assert.equal(recorded.ok, true, fixture.id);
    assert.equal(recorded.state.civic_result_changed, fixture.expect.civic_changed);
    assert.equal(projectPublicVerdictSeam([recorded.state])[0].label, fixture.expect.label);
  }
});

test("committed public seam and rehearsal receipt match the current projector", () => {
  assert.equal(checkRehearsal().ok, true);
  const labels = JSON.parse(readFileSync(join(ROOT, "site/data/report_verdict_labels.json"), "utf8"));
  assert.equal(labels.schema, "cityscroll.report_verdict_labels.v1");
  assert.equal(publicVerdictSeamLeaksPrivate(labels.labels), false);
  assert.equal(JSON.stringify(labels).includes("maintainer:rehearsal"), false);
  assert.equal(JSON.stringify(labels).includes("rationale"), false);
});
