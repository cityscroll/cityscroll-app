// Private, evidence-bearing report adjudication contract.
//
// A contextual report remains evidence of disagreement. A bounded private
// verdict names actor, time, evidence, and scope. Only an explicit named
// source-of-truth change may drive guarded reprojection. Unresolved or
// out-of-scope evidence leaves the civic result unchanged. This module is
// storage-neutral; persistence lives in report_adjudication_store.mjs.

import { publicLabelFor } from "../../../site/report_verdict_public.mjs";

export { publicLabelFor };

export const REPORT_ADJUDICATION_SCHEMA = "cityscroll.report_adjudication.v1";
export const REPORT_ADJUDICATION_HANDOFF_SCHEMA = "cityscroll.report_adjudication_handoff.v1";
export const NAMED_SOURCE_CHANGE_SCHEMA = "cityscroll.named_source_change.v1";
export const REPORTER_RESOLUTION_SCHEMA = "cityscroll.reporter_resolution.v1";
export const REPORT_ADJUDICATION_COMMAND_SCHEMA = "cityscroll.report_adjudication_command.v1";

export const REPORT_VERDICTS = Object.freeze([
  "confirmed",
  "correct-as-displayed",
  "ambiguous-or-insufficient-evidence",
  "upstream-source-error",
  "duplicate",
]);

export const HANDOFF_KINDS = Object.freeze([
  "report_status",
  "adjudication",
  "source_of_truth_change",
  "reprojection",
  "reporter_resolution",
]);

export const PRIVATE_REVIEW_FIELDS = Object.freeze([
  "actor",
  "actor_ref",
  "rationale",
  "reasoning",
  "notes",
  "operator_notes",
  "internal_notes",
  "internal_reasoning",
  "process",
  "review",
  "review_session",
  "review_ui",
  "ui",
  "decision",
]);

const VERDICT_ALIASES = Object.freeze({
  confirmed: "confirmed",
  "correct-as-displayed": "correct-as-displayed",
  correct_as_displayed: "correct-as-displayed",
  "ambiguous-or-insufficient-evidence": "ambiguous-or-insufficient-evidence",
  "ambiguous or insufficient-evidence": "ambiguous-or-insufficient-evidence",
  ambiguous: "ambiguous-or-insufficient-evidence",
  "insufficient-evidence": "ambiguous-or-insufficient-evidence",
  insufficient_evidence: "ambiguous-or-insufficient-evidence",
  "upstream-source-error": "upstream-source-error",
  upstream_source_error: "upstream-source-error",
  duplicate: "duplicate",
});

const VERDICTS_REQUIRING_EVIDENCE = new Set([
  "confirmed",
  "correct-as-displayed",
  "upstream-source-error",
]);

const SOURCE_CHANGE_VERDICTS = new Set(["confirmed"]);

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const COMMAND_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function present(value) {
  const text = clean(value);
  return text || null;
}

function isoTimestamp(value) {
  const text = clean(value);
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(values) ? values : []) {
    const id = present(raw);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function normalizeVerdict(value) {
  const key = clean(value).toLowerCase();
  return VERDICT_ALIASES[key] || null;
}

export function normalizeEvidence(value) {
  const seen = new Set();
  const refs = [];
  for (const raw of Array.isArray(value) ? value : value == null || value === "" ? [] : [value]) {
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const kind = present(raw.kind) || "source_record";
      const id = present(raw.id || raw.source_record_id);
      if (!id || !TOKEN.test(id)) continue;
      const key = `${kind}\0${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push({ kind, id });
      continue;
    }
    const id = present(raw);
    if (!id || !TOKEN.test(id)) continue;
    const key = `source_record\0${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ kind: "source_record", id });
  }
  return refs;
}

export function evidenceIds(evidence) {
  return uniqueStrings((Array.isArray(evidence) ? evidence : []).map((item) => item?.id));
}

export function reportSourceRecordIds(report) {
  const target = report?.report_target || report?.target || {};
  const provenance = target.provenance || report?.provenance || {};
  return uniqueStrings([
    ...(Array.isArray(provenance.source_record_ids) ? provenance.source_record_ids : []),
    ...(Array.isArray(report?.source_record_ids) ? report.source_record_ids : []),
  ]);
}

export function normalizeScope(value, report) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const named = uniqueStrings([
    ...(Array.isArray(raw.source_record_ids) ? raw.source_record_ids : []),
    ...(Array.isArray(raw.source_records) ? raw.source_records : []),
  ]);
  const admitted = reportSourceRecordIds(report);
  const admittedSet = new Set(admitted);
  const unknown = named.filter((id) => admitted.length && !admittedSet.has(id));
  return {
    source_record_ids: named,
    original_report_id: present(raw.original_report_id || raw.duplicate_of),
    original_claim_id: present(raw.original_claim_id),
    admitted_source_record_ids: admitted,
    unknown_source_record_ids: unknown,
  };
}

function normalizeSourceChange(value) {
  if (value == null || value === false) return null;
  if (typeof value !== "object" || Array.isArray(value)) return { error: "source_change_malformed" };
  const path = present(value.path || value.field_path);
  const sourceRecordIds = uniqueStrings(value.source_record_ids || value.source_records);
  if (!path) return { error: "source_change_path_required" };
  if (!sourceRecordIds.length) return { error: "source_change_scope_required" };
  return {
    schema: NAMED_SOURCE_CHANGE_SCHEMA,
    status: "named",
    id: present(value.id),
    source: present(value.source),
    path,
    before: Object.prototype.hasOwnProperty.call(value, "before") ? value.before : null,
    after: Object.prototype.hasOwnProperty.call(value, "after") ? value.after : null,
    after_label: present(value.after_label),
    label_path: present(value.label_path),
    source_record_ids: sourceRecordIds,
  };
}

function handoff({ kind, reportId, commandId, at, fromStatus, toStatus, result, reason, payload }) {
  return Object.freeze({
    schema: REPORT_ADJUDICATION_HANDOFF_SCHEMA,
    id: `handoff:${reportId}:${kind}:${commandId}`,
    kind,
    report_id: reportId,
    command_id: commandId,
    at,
    from_status: fromStatus,
    to_status: toStatus,
    result,
    reason: reason || null,
    payload: payload ? Object.freeze(payload) : null,
  });
}

export function reporterResolutionCopy(verdict, civicChanged) {
  if (verdict === "correct-as-displayed") {
    return "The displayed information matches the source record.";
  }
  if (verdict === "ambiguous-or-insufficient-evidence") {
    return "There is not enough evidence to change the displayed information.";
  }
  if (verdict === "upstream-source-error") {
    return "The displayed information matches the published source. The source record itself appears to be the issue.";
  }
  if (verdict === "duplicate") {
    return "This report matches an earlier report.";
  }
  if (verdict === "confirmed" && civicChanged) {
    return "The displayed information was updated from the named source record.";
  }
  if (verdict === "confirmed") {
    return "This report was reviewed. The displayed information was not changed.";
  }
  return "This report was reviewed.";
}

function fail(error, extras = {}) {
  return {
    ok: false,
    error,
    civic_result_changed: false,
    ...extras,
  };
}

export function applyGuardedReprojection({ civic_result, source_change, verdict, evidence_complete, scope }) {
  const before = clone(civic_result) ?? null;
  if (verdict !== "confirmed") {
    return { applied: false, changed: false, before, after: before, reason: "verdict_does_not_authorize_change" };
  }
  if (!evidence_complete) {
    return { applied: false, changed: false, before, after: before, reason: "evidence_incomplete" };
  }
  if (!source_change || source_change.status !== "named") {
    return { applied: false, changed: false, before, after: before, reason: "source_change_not_named" };
  }
  const scoped = new Set(scope?.source_record_ids || []);
  if (!source_change.source_record_ids.every((id) => scoped.has(id))) {
    return { applied: false, changed: false, before, after: before, reason: "source_change_outside_scope" };
  }
  if (!before || typeof before !== "object" || Array.isArray(before)) {
    return { applied: false, changed: false, before, after: before, reason: "civic_result_missing" };
  }
  if (before[source_change.path] !== source_change.before) {
    return { applied: false, changed: false, before, after: before, reason: "source_truth_mismatch" };
  }
  const after = clone(before);
  after[source_change.path] = source_change.after;
  if (source_change.after_label && source_change.label_path) {
    after[source_change.label_path] = source_change.after_label;
  }
  const changed = JSON.stringify(before) !== JSON.stringify(after);
  return { applied: true, changed, before, after, reason: null };
}

function canonicalCommand(input) {
  return {
    schema: REPORT_ADJUDICATION_COMMAND_SCHEMA,
    report_id: input.report_id,
    claim_id: input.claim_id || null,
    verdict: input.verdict,
    evidence: input.evidence,
    scope: {
      source_record_ids: input.scope.source_record_ids,
      original_report_id: input.scope.original_report_id,
      original_claim_id: input.scope.original_claim_id,
    },
    source_change: input.source_change,
    reproject: Boolean(input.reproject),
    reporter_resolution: Boolean(input.reporter_resolution),
    auto_apply: Boolean(input.auto_apply),
  };
}

export function commandFingerprint(command) {
  return JSON.stringify(canonicalCommand(command));
}

/**
 * Record one private adjudication loop over a stored report.
 * Civic projection changes only when a confirmed verdict names a source
 * change, evidence and scope hold, and reprojection is explicitly requested.
 */
export function recordReportAdjudication(input = {}) {
  const report = input.report && typeof input.report === "object" ? input.report : {};
  const reportId = present(input.report_id || report.id);
  if (!reportId) return fail("report_id_required");

  const actor = present(input.actor);
  if (!actor || actor.length > 120) return fail("actor_required");

  const at = isoTimestamp(input.at || input.recorded_at) || new Date().toISOString();
  const commandId = present(input.command_id);
  if (commandId && !COMMAND_ID.test(commandId)) return fail("command_id_invalid");
  const resolvedCommandId = commandId || `cmd:${reportId}:${at}`;

  if (input.auto_apply) return fail("automatic_correction_forbidden");

  const verdict = normalizeVerdict(input.verdict);
  if (!verdict) return fail("verdict_invalid");

  const evidence = normalizeEvidence(input.evidence);
  const evidenceComplete = evidence.length > 0;
  if (VERDICTS_REQUIRING_EVIDENCE.has(verdict) && !evidenceComplete) {
    return fail("evidence_required", { verdict, evidence });
  }

  const scope = normalizeScope(input.scope, report);
  if (scope.unknown_source_record_ids.length) {
    return fail("scope_violation", {
      verdict,
      evidence,
      scope,
    });
  }
  if (verdict === "duplicate" && !scope.original_report_id && !scope.original_claim_id) {
    return fail("duplicate_target_required", { verdict, evidence, scope });
  }
  if (SOURCE_CHANGE_VERDICTS.has(verdict) && evidenceComplete && !scope.source_record_ids.length) {
    return fail("scope_required", { verdict, evidence, scope });
  }
  if (
    SOURCE_CHANGE_VERDICTS.has(verdict)
    && scope.source_record_ids.length
    && !scope.source_record_ids.every((id) => evidenceIds(evidence).includes(id))
  ) {
    return fail("scope_not_covered_by_evidence", { verdict, evidence, scope });
  }

  const namedChange = normalizeSourceChange(input.source_change);
  if (namedChange?.error) return fail(namedChange.error, { verdict, evidence, scope });
  if (namedChange && !SOURCE_CHANGE_VERDICTS.has(verdict)) {
    return fail("source_change_not_allowed", { verdict, evidence, scope });
  }
  if (input.reproject && !namedChange) {
    return fail("source_change_required_for_reprojection", { verdict, evidence, scope });
  }

  const civicBefore = clone(input.civic_result);
  const wantReproject = Boolean(input.reproject);
  const reprojection = wantReproject
    ? applyGuardedReprojection({
      civic_result: civicBefore,
      source_change: namedChange,
      verdict,
      evidence_complete: evidenceComplete,
      scope,
    })
    : {
      applied: false,
      changed: false,
      before: civicBefore,
      after: civicBefore,
      reason: namedChange ? "reprojection_not_requested" : "source_change_not_named",
    };

  if (wantReproject && !reprojection.applied) {
    return fail(reprojection.reason || "reprojection_rejected", {
      verdict,
      evidence,
      scope,
      source_change: namedChange,
    });
  }

  const civicChanged = Boolean(reprojection.applied && reprojection.changed);
  const reporterRequested = Boolean(input.reporter_resolution);
  const reporterOutcome = reporterRequested
    ? Object.freeze({
      schema: REPORTER_RESOLUTION_SCHEMA,
      outcome: publicLabelFor(verdict, civicChanged),
      summary: reporterResolutionCopy(verdict, civicChanged),
    })
    : null;

  const statusAfterAdjudication = "adjudicated";
  const statusAfterSource = namedChange
    ? (civicChanged ? "source_change_named" : "source_change_named")
    : statusAfterAdjudication;
  const statusAfterReproject = civicChanged
    ? "reprojected"
    : statusAfterSource;
  const finalStatus = reporterRequested ? "reporter_resolved" : statusAfterReproject;

  const command = {
    report_id: reportId,
    claim_id: present(input.claim_id || report.target_id || report.report_target?.target_id),
    verdict,
    evidence,
    scope,
    source_change: namedChange,
    reproject: wantReproject,
    reporter_resolution: reporterRequested,
    auto_apply: false,
  };

  const handoffs = [
    handoff({
      kind: "report_status",
      reportId,
      commandId: resolvedCommandId,
      at,
      fromStatus: null,
      toStatus: "received",
      result: "recorded",
      payload: { report_id: reportId },
    }),
    handoff({
      kind: "adjudication",
      reportId,
      commandId: resolvedCommandId,
      at,
      fromStatus: "received",
      toStatus: statusAfterAdjudication,
      result: "recorded",
      payload: { verdict, evidence_complete: evidenceComplete },
    }),
    handoff({
      kind: "source_of_truth_change",
      reportId,
      commandId: resolvedCommandId,
      at,
      fromStatus: statusAfterAdjudication,
      toStatus: namedChange ? "source_change_named" : statusAfterAdjudication,
      result: namedChange ? "named" : "skipped",
      reason: namedChange ? null : "source_change_not_named",
      payload: namedChange ? { path: namedChange.path, source_record_ids: namedChange.source_record_ids } : null,
    }),
    handoff({
      kind: "reprojection",
      reportId,
      commandId: resolvedCommandId,
      at,
      fromStatus: namedChange ? "source_change_named" : statusAfterAdjudication,
      toStatus: statusAfterReproject,
      result: civicChanged ? "applied" : "skipped",
      reason: civicChanged ? null : reprojection.reason,
      payload: { changed: civicChanged },
    }),
  ];
  if (reporterRequested) {
    handoffs.push(handoff({
      kind: "reporter_resolution",
      reportId,
      commandId: resolvedCommandId,
      at,
      fromStatus: statusAfterReproject,
      toStatus: "reporter_resolved",
      result: "recorded",
      payload: { outcome: reporterOutcome.outcome },
    }));
  }

  const state = Object.freeze({
    schema: REPORT_ADJUDICATION_SCHEMA,
    report_id: reportId,
    claim_id: command.claim_id,
    command_id: resolvedCommandId,
    command_fingerprint: commandFingerprint(command),
    verdict,
    actor,
    recorded_at: at,
    evidence: Object.freeze(evidence.map((item) => Object.freeze(item))),
    evidence_complete: evidenceComplete,
    scope: Object.freeze({
      source_record_ids: Object.freeze([...scope.source_record_ids]),
      original_report_id: scope.original_report_id,
      original_claim_id: scope.original_claim_id,
    }),
    source_change: namedChange ? Object.freeze(namedChange) : null,
    status: finalStatus,
    civic_result_changed: civicChanged,
    civic_result: Object.freeze({
      before: reprojection.before,
      after: reprojection.after,
    }),
    reporter_resolution: reporterOutcome,
    original_assertion: Object.freeze({
      message: present(report.message || report.report?.explanation) || null,
      evidence: present(report.evidence || report.report?.evidence) || null,
      target_id: present(report.target_id || report.report_target?.target_id) || null,
    }),
    handoffs: Object.freeze(handoffs),
  });

  return { ok: true, error: null, state };
}

export function replayMatches(stored, input) {
  if (!stored?.command_fingerprint) return false;
  const verdict = normalizeVerdict(input.verdict);
  const evidence = normalizeEvidence(input.evidence);
  const scope = normalizeScope(input.scope, input.report || {});
  const namedChange = normalizeSourceChange(input.source_change);
  if (namedChange?.error) return false;
  const command = {
    report_id: present(input.report_id || input.report?.id),
    claim_id: present(input.claim_id || input.report?.target_id || input.report?.report_target?.target_id),
    verdict,
    evidence,
    scope,
    source_change: namedChange,
    reproject: Boolean(input.reproject),
    reporter_resolution: Boolean(input.reporter_resolution),
    auto_apply: false,
  };
  return stored.command_fingerprint === commandFingerprint(command);
}

export function adjudicationLeaksIntoPublic(value) {
  const serialized = JSON.stringify(value);
  if (!serialized) return false;
  return PRIVATE_REVIEW_FIELDS.some((field) => new RegExp(`"${field}"\\s*:`).test(serialized));
}
