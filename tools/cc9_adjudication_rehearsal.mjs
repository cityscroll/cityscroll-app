/**
 * CC-9: a bounded rehearsal of the private report adjudication loop.
 *
 * Each case walks report status → adjudication → optional named source-of-truth
 * change → guarded reprojection → optional reporter resolution. Unresolved
 * evidence leaves the civic result unchanged. The committed public artifact is
 * only an opaque id→label seam.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  HANDOFF_KINDS,
  recordReportAdjudication,
} from "../worker/src/lib/report_adjudication.mjs";
import {
  projectPublicVerdictSeam,
  publicVerdictSeamLeaksPrivate,
} from "../site/report_verdict_public.mjs";

export const REHEARSAL_SCHEMA = "cityscroll.report_adjudication_rehearsal.v1";
export const REHEARSAL_SCOPE = "seeded_fixture_rehearsal_only";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_LABELS = path.join(ROOT, "site/data/report_verdict_labels.json");
const RECEIPT = path.join(ROOT, "docs/evidence/cc9-adjudication/rehearsal.json");

function reportEnvelope({ id, targetId, sourceRecordIds, message, evidence }) {
  return {
    id,
    message,
    evidence,
    target_id: targetId,
    report_target: {
      target_id: targetId,
      provenance: { source_record_ids: sourceRecordIds },
    },
    report: { explanation: message, evidence },
  };
}

function confirmedCase() {
  const sourceRecordIds = ["cc9-contract-2001", "cc9-vendor-2001"];
  return {
    id: "CC9-CONFIRMED-001",
    class: "confirmed_named_source_change",
    report: reportEnvelope({
      id: "fb:cc9:confirmed",
      targetId: "procurement:contract:CC9-2001",
      sourceRecordIds,
      message: "This contract is connected to Harbor Maintenance, not Northstar Works.",
      evidence: "cc9-contract-2001 and cc9-vendor-2001 identify Harbor Maintenance.",
    }),
    input: {
      verdict: "confirmed",
      actor: "maintainer:rehearsal",
      at: "2026-08-31T12:00:00.000Z",
      command_id: "cc9-confirmed-001",
      evidence: sourceRecordIds,
      scope: { source_record_ids: sourceRecordIds },
      source_change: {
        id: "src-cc9-2001",
        source: "rehearsal fixture contract-vendor edge",
        path: "vendor_ref",
        before: "vendor:stem:NORTHSTAR-WORKS",
        after: "vendor:stem:HARBOR-MAINTENANCE",
        after_label: "Harbor Maintenance",
        label_path: "vendor_label",
        source_record_ids: sourceRecordIds,
      },
      reproject: true,
      reporter_resolution: true,
    },
    civic_result: {
      vendor_ref: "vendor:stem:NORTHSTAR-WORKS",
      vendor_label: "Northstar Works",
    },
    expect: { civic_changed: true, label: "corrected" },
  };
}

function correctAsDisplayedCase() {
  const sourceRecordIds = ["cc9-notice-3001"];
  return {
    id: "CC9-CORRECT-AS-DISPLAYED-001",
    class: "correct_as_displayed",
    report: reportEnvelope({
      id: "fb:cc9:correct",
      targetId: "meeting:city_record:cc9-3001",
      sourceRecordIds,
      message: "The hearing date looks wrong.",
      evidence: "cc9-notice-3001 publishes the same date shown on the page.",
    }),
    input: {
      verdict: "correct-as-displayed",
      actor: "maintainer:rehearsal",
      at: "2026-08-31T12:01:00.000Z",
      command_id: "cc9-correct-001",
      evidence: sourceRecordIds,
      scope: { source_record_ids: sourceRecordIds },
      reporter_resolution: true,
    },
    civic_result: { event_date: "2026-08-12" },
    expect: { civic_changed: false, label: "reviewed" },
  };
}

function ambiguousCase() {
  return {
    id: "CC9-AMBIGUOUS-001",
    class: "ambiguous_or_insufficient_evidence",
    report: reportEnvelope({
      id: "fb:cc9:ambiguous",
      targetId: "meeting:city_record:cc9-4001",
      sourceRecordIds: ["cc9-notice-4001"],
      message: "These notices look like they might be different hearings.",
      evidence: "",
    }),
    input: {
      verdict: "ambiguous-or-insufficient-evidence",
      actor: "maintainer:rehearsal",
      at: "2026-08-31T12:02:00.000Z",
      command_id: "cc9-ambiguous-001",
      evidence: [],
      scope: { source_record_ids: [] },
      reporter_resolution: true,
    },
    civic_result: { grouping_mode: "one_meeting" },
    expect: { civic_changed: false, label: "unresolved" },
  };
}

function upstreamErrorCase() {
  const sourceRecordIds = ["cc9-source-5001"];
  return {
    id: "CC9-UPSTREAM-001",
    class: "upstream_source_error",
    report: reportEnvelope({
      id: "fb:cc9:upstream",
      targetId: "procurement:contract:CC9-5001",
      sourceRecordIds,
      message: "The published amount is wrong.",
      evidence: "cc9-source-5001 publishes the same amount CityScroll displays.",
    }),
    input: {
      verdict: "upstream-source-error",
      actor: "maintainer:rehearsal",
      at: "2026-08-31T12:03:00.000Z",
      command_id: "cc9-upstream-001",
      evidence: sourceRecordIds,
      scope: { source_record_ids: sourceRecordIds },
      reporter_resolution: true,
    },
    civic_result: { amount: 120000 },
    expect: { civic_changed: false, label: "reviewed" },
  };
}

function duplicateCase() {
  const sourceRecordIds = ["cc9-contract-2001"];
  return {
    id: "CC9-DUPLICATE-001",
    class: "duplicate",
    report: reportEnvelope({
      id: "fb:cc9:duplicate",
      targetId: "procurement:contract:CC9-2001",
      sourceRecordIds,
      message: "This contract is connected to Harbor Maintenance, not Northstar Works.",
      evidence: "Same as the earlier report.",
    }),
    input: {
      verdict: "duplicate",
      actor: "maintainer:rehearsal",
      at: "2026-08-31T12:04:00.000Z",
      command_id: "cc9-duplicate-001",
      evidence: sourceRecordIds,
      scope: { source_record_ids: sourceRecordIds, original_report_id: "fb:cc9:confirmed" },
      reporter_resolution: true,
    },
    civic_result: { vendor_ref: "vendor:stem:NORTHSTAR-WORKS" },
    expect: { civic_changed: false, label: "duplicate" },
  };
}

export const REHEARSAL_CASES = Object.freeze([
  confirmedCase(),
  correctAsDisplayedCase(),
  ambiguousCase(),
  upstreamErrorCase(),
  duplicateCase(),
]);

export const REHEARSAL_NEGATIVE_CASES = Object.freeze([
  {
    id: "CC9-NEGATIVE-EVIDENCE-001",
    class: "missing_evidence",
    report: reportEnvelope({
      id: "fb:cc9:no-evidence",
      targetId: "procurement:contract:CC9-2001",
      sourceRecordIds: ["cc9-contract-2001"],
      message: "The vendor is wrong.",
      evidence: "",
    }),
    input: {
      verdict: "confirmed",
      actor: "maintainer:rehearsal",
      at: "2026-08-31T12:05:00.000Z",
      command_id: "cc9-no-evidence-001",
      evidence: [],
      scope: { source_record_ids: ["cc9-contract-2001"] },
      reproject: true,
      source_change: {
        path: "vendor_ref",
        before: "vendor:stem:NORTHSTAR-WORKS",
        after: "vendor:stem:HARBOR-MAINTENANCE",
        source_record_ids: ["cc9-contract-2001"],
      },
    },
    civic_result: { vendor_ref: "vendor:stem:NORTHSTAR-WORKS" },
    expect_error: "evidence_required",
  },
  {
    id: "CC9-NEGATIVE-SCOPE-001",
    class: "scope_violation",
    report: reportEnvelope({
      id: "fb:cc9:scope",
      targetId: "procurement:contract:CC9-2001",
      sourceRecordIds: ["cc9-contract-2001"],
      message: "The vendor is wrong.",
      evidence: "cc9-unrelated-999 is not on this report.",
    }),
    input: {
      verdict: "confirmed",
      actor: "maintainer:rehearsal",
      at: "2026-08-31T12:06:00.000Z",
      command_id: "cc9-scope-001",
      evidence: ["cc9-unrelated-999"],
      scope: { source_record_ids: ["cc9-unrelated-999"] },
    },
    civic_result: { vendor_ref: "vendor:stem:NORTHSTAR-WORKS" },
    expect_error: "scope_violation",
  },
  {
    id: "CC9-NEGATIVE-AUTO-001",
    class: "automatic_correction_forbidden",
    report: reportEnvelope({
      id: "fb:cc9:auto",
      targetId: "procurement:contract:CC9-2001",
      sourceRecordIds: ["cc9-contract-2001"],
      message: "The vendor is wrong.",
      evidence: "cc9-contract-2001",
    }),
    input: {
      verdict: "confirmed",
      actor: "maintainer:rehearsal",
      at: "2026-08-31T12:07:00.000Z",
      command_id: "cc9-auto-001",
      evidence: ["cc9-contract-2001"],
      scope: { source_record_ids: ["cc9-contract-2001"] },
      auto_apply: true,
    },
    civic_result: { vendor_ref: "vendor:stem:NORTHSTAR-WORKS" },
    expect_error: "automatic_correction_forbidden",
  },
]);

function publicSafeCase(pilotCase, recorded) {
  if (!recorded.ok) {
    return {
      id: pilotCase.id,
      class: pilotCase.class,
      ok: false,
      error: recorded.error,
      civic_result_changed: false,
      public_label: null,
      handoff_kinds: [],
    };
  }
  const label = projectPublicVerdictSeam([recorded.state])[0] || null;
  return {
    id: pilotCase.id,
    class: pilotCase.class,
    ok: true,
    error: null,
    civic_result_changed: recorded.state.civic_result_changed,
    public_label: label,
    handoff_kinds: recorded.state.handoffs.map((item) => item.kind),
    handoff_results: recorded.state.handoffs.map((item) => ({
      kind: item.kind,
      result: item.result,
    })),
    reporter_outcome: recorded.state.reporter_resolution?.outcome || null,
  };
}

export function replayRehearsalCase(pilotCase) {
  return recordReportAdjudication({
    ...pilotCase.input,
    report: { ...pilotCase.report, id: pilotCase.report.id },
    report_id: pilotCase.report.id,
    civic_result: pilotCase.civic_result,
  });
}

export function runRehearsal() {
  const positive = REHEARSAL_CASES.map((item) => {
    const recorded = replayRehearsalCase(item);
    return { fixture: item, recorded, public: publicSafeCase(item, recorded) };
  });
  const negative = REHEARSAL_NEGATIVE_CASES.map((item) => {
    const recorded = replayRehearsalCase(item);
    return { fixture: item, recorded, public: publicSafeCase(item, recorded) };
  });
  const publicLabels = projectPublicVerdictSeam(positive.map((item) => item.recorded.state));
  return {
    schema: REHEARSAL_SCHEMA,
    generated_for: "2026-08-31",
    rehearsal_scope: REHEARSAL_SCOPE,
    claim: "This is a bounded rehearsal of the private adjudication loop, not a public review process.",
    cases: positive.map((item) => item.public),
    negatives: negative.map((item) => item.public),
    public_labels: publicLabels,
    handoff_kinds: [...HANDOFF_KINDS],
    limitations: [
      "Corrections apply only to the named rehearsal civic envelope.",
      "Private actor, evidence, and reasoning stay off the public seam.",
      "Unresolved or skipped source changes leave the civic result unchanged.",
    ],
  };
}

export function publicLabelsDocument(rehearsal = runRehearsal()) {
  return {
    schema: "cityscroll.report_verdict_labels.v1",
    generated_for: rehearsal.generated_for,
    labels: rehearsal.public_labels,
  };
}

export function writeRehearsal({ labelsPath = PUBLIC_LABELS, receiptPath = RECEIPT } = {}) {
  const rehearsal = runRehearsal();
  if (publicVerdictSeamLeaksPrivate(rehearsal.public_labels)) {
    throw new Error("public rehearsal seam leaked private review fields");
  }
  fs.mkdirSync(path.dirname(labelsPath), { recursive: true });
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  const labels = publicLabelsDocument(rehearsal);
  fs.writeFileSync(labelsPath, `${JSON.stringify(labels, null, 2)}\n`);
  fs.writeFileSync(receiptPath, `${JSON.stringify({
    schema: rehearsal.schema,
    generated_for: rehearsal.generated_for,
    rehearsal_scope: rehearsal.rehearsal_scope,
    claim: rehearsal.claim,
    cases: rehearsal.cases,
    negatives: rehearsal.negatives,
    public_labels: rehearsal.public_labels,
    handoff_kinds: rehearsal.handoff_kinds,
    limitations: rehearsal.limitations,
  }, null, 2)}\n`);
  return { rehearsal, labelsPath, receiptPath };
}

export function checkRehearsal({ labelsPath = PUBLIC_LABELS, receiptPath = RECEIPT } = {}) {
  const expected = runRehearsal();
  const labels = publicLabelsDocument(expected);
  const wantedReceipt = {
    schema: expected.schema,
    generated_for: expected.generated_for,
    rehearsal_scope: expected.rehearsal_scope,
    claim: expected.claim,
    cases: expected.cases,
    negatives: expected.negatives,
    public_labels: expected.public_labels,
    handoff_kinds: expected.handoff_kinds,
    limitations: expected.limitations,
  };
  const liveLabels = JSON.parse(fs.readFileSync(labelsPath, "utf8"));
  const liveReceipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  if (JSON.stringify(liveLabels) !== JSON.stringify(labels)) {
    throw new Error("site/data/report_verdict_labels.json is stale; rebuild with tools/cc9_adjudication_rehearsal.mjs");
  }
  if (JSON.stringify(liveReceipt) !== JSON.stringify(wantedReceipt)) {
    throw new Error("docs/evidence/cc9-adjudication/rehearsal.json is stale; rebuild with tools/cc9_adjudication_rehearsal.mjs");
  }
  if (publicVerdictSeamLeaksPrivate(liveLabels.labels) || publicVerdictSeamLeaksPrivate(liveReceipt.public_labels)) {
    throw new Error("committed public seam leaked private review fields");
  }
  return { ok: true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--check")) {
    checkRehearsal();
    console.log("cc9 adjudication rehearsal artifacts match");
  } else {
    const written = writeRehearsal();
    console.log(`wrote ${path.relative(process.cwd(), written.labelsPath)}`);
    console.log(`wrote ${path.relative(process.cwd(), written.receiptPath)}`);
  }
}
