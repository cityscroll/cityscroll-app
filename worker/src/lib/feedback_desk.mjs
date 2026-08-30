// Allowlisted operator-desk projection of stored FEEDBACK rows.
//
// `/admin/feedback` is a faithful read of durable `fb:` records: target, report
// metadata, evidence, provenance, canonical URL, and target identity round-trip
// when they were stored, and missing/malformed context stays explicit. Reporter
// email, IP, user-agent, and operator adjudication notes never enter the
// response. The projector does not infer a claim from free-text explanation.

import { resolveReportTarget } from "../../../site/report_target.mjs";

export const FEEDBACK_DESK_ITEM_SCHEMA = "cityscroll.feedback_desk_item.v1";

export const FEEDBACK_DESK_EXCLUDED_FIELDS = Object.freeze([
  "email",
  "ip",
  "ua",
  "user_agent",
  "userAgent",
  "adjudication",
  "notes",
  "operator_notes",
  "internal_notes",
  "verdict",
  "decision",
  "review",
]);

const TARGET_MISSING = Object.freeze({
  status: "missing",
  target: null,
  target_id: null,
  canonical_url: null,
  provenance: null,
});

function presentString(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function storedIdentityField(raw, key) {
  if (!raw || typeof raw !== "object") return null;
  return presentString(raw[key]);
}

function projectStoredTarget(stored) {
  if (!hasOwn(stored, "report_target") || stored.report_target == null) {
    return TARGET_MISSING;
  }
  const raw = stored.report_target;
  const storedId = storedIdentityField(raw, "target_id");
  const storedUrl = storedIdentityField(raw, "canonical_url");
  const malformed = {
    status: "malformed",
    target: null,
    target_id: storedId,
    canonical_url: storedUrl,
    provenance: null,
  };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return malformed;

  let resolved = null;
  try {
    resolved = resolveReportTarget(raw);
  } catch {
    return malformed;
  }
  if (!resolved) return malformed;
  if (storedId && storedId !== resolved.target_id) return malformed;

  return Object.freeze({
    status: "present",
    target: resolved,
    target_id: resolved.target_id,
    canonical_url: resolved.canonical_url,
    provenance: resolved.provenance ?? null,
  });
}

function projectStoredReport(stored) {
  if (!hasOwn(stored, "report")) return null;
  const report = stored.report;
  if (!report || typeof report !== "object" || Array.isArray(report)) return null;
  return Object.freeze({
    category: presentString(report.category),
    explanation: presentString(report.explanation),
    evidence: hasOwn(report, "evidence") ? presentString(report.evidence) : null,
  });
}

/** True when a serialized desk item contains excluded private keys or values. */
export function deskItemLeaksPrivateFields(item, extras = []) {
  const serialized = JSON.stringify(item);
  if (FEEDBACK_DESK_EXCLUDED_FIELDS.some((field) => hasOwn(item || {}, field))) return true;
  for (const field of FEEDBACK_DESK_EXCLUDED_FIELDS) {
    if (new RegExp(`"${field}"\\s*:`).test(serialized)) return true;
  }
  return extras.some((value) => value && serialized.includes(String(value)));
}

/**
 * Project one stored feedback/report row into the authenticated desk item.
 * `id` is the durable KV key (`fb:<ts>:<rand>`). Unknown/legacy fields stay
 * explicit nulls; extra stored keys are dropped.
 */
export function projectFeedbackDeskItem(id, record) {
  const stored = record && typeof record === "object" && !Array.isArray(record) ? record : {};
  const target = projectStoredTarget(stored);
  return Object.freeze({
    schema: FEEDBACK_DESK_ITEM_SCHEMA,
    id: presentString(id),
    category: presentString(stored.category),
    message: presentString(stored.message),
    at: presentString(stored.at),
    evidence: hasOwn(stored, "evidence") ? presentString(stored.evidence) : null,
    report: projectStoredReport(stored),
    report_target: target.target,
    target_id: target.target_id,
    canonical_url: target.canonical_url,
    provenance: target.provenance,
    target_status: target.status,
  });
}
