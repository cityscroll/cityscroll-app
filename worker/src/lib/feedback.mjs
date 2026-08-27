// Pure validation for an inbound /feedback submission — no I/O, fully unit-testable.
//
// Mirrors the /subscribe posture: never trust the client. We reject rather than coerce, except
// for the safe normalizations (trim category/message, lowercase+trim an optional email). Email
// is OPTIONAL — a blank/missing address is valid (the sender just doesn't want a reply).

import { isValidEmail, normalizeEmail } from "./subscriptions.mjs";
import {
  REPORT_IDENTITY_INTENTS,
  REPORT_TARGET_SCHEMA,
  resolveReportTarget,
  reportTargetIdentity,
} from "../../../site/report_target.mjs";

export const FEEDBACK_CATEGORIES = ["bug", "feature", "general"];
export const REPORT_CATEGORIES = [
  "information_wrong", "connection_wrong", "same_thing", "different_things",
  "something_missing", "interpretation_wrong", "other",
];
const FIELD_REPORT_CATEGORIES = new Set(["information_wrong", "something_missing", "other"]);
const RELATIONSHIP_REPORT_CATEGORIES = new Set(["connection_wrong", "something_missing", "other"]);
export const MSG_MIN = 10;
export const MSG_MAX = 2000;
export const EVIDENCE_MAX = 4000;

// Returns { ok: true, value: { category, message, email } } or { ok: false, reason }.
// reason ∈ { "bad-category", "bad-message", "bad-email" }.
export function validateFeedback(body) {
  const b = body || {};

  const category = String(b.category == null ? "" : b.category).trim().toLowerCase();
  const isReport = Object.prototype.hasOwnProperty.call(b, "report_target");
  if ((!isReport && !FEEDBACK_CATEGORIES.includes(category))
    || (isReport && !REPORT_CATEGORIES.includes(category))) {
    return { ok: false, reason: isReport ? "bad-report-category" : "bad-category" };
  }

  const message = String(b.message == null ? "" : b.message).trim();
  if (message.length < MSG_MIN || message.length > MSG_MAX) return { ok: false, reason: "bad-message" };

  const rawEmail = String(b.email == null ? "" : b.email).trim();
  let email = "";
  if (rawEmail) {
    if (!isValidEmail(rawEmail)) return { ok: false, reason: "bad-email" };
    email = normalizeEmail(rawEmail);
  }

  if (!isReport) return { ok: true, value: { category, message, email } };
  const evidence = String(b.evidence == null ? "" : b.evidence).trim();
  if (evidence.length > EVIDENCE_MAX) return { ok: false, reason: "bad-evidence" };
  const target = normalizeReportTargetForFeedback(b.report_target);
  if (!target) return { ok: false, reason: "bad-report-target" };
  if (target.claim_anchor?.claim_type === "relationship"
    && !RELATIONSHIP_REPORT_CATEGORIES.has(category)) {
    return { ok: false, reason: "bad-report-category" };
  }
  if (target.claim_anchor?.claim_type !== "relationship"
    && target.claim_anchor?.field_or_semantic_key === "vendor"
    && !FIELD_REPORT_CATEGORIES.has(category)) {
    return { ok: false, reason: "bad-report-category" };
  }
  return {
    ok: true,
    value: {
      category: "report",
      message,
      email,
      evidence,
      report_target: target,
      report: { category, explanation: message, evidence },
    },
  };
}

function normalizeReportTargetForFeedback(value) {
  if (!value || typeof value !== "object" || value.schema !== REPORT_TARGET_SCHEMA) return null;
  let target;
  try { target = resolveReportTarget(value); } catch { return null; }
  if (!target || target.target_id !== value.target_id || reportTargetIdentity(target) !== value.target_id) return null;
  const isProcurement = target.object_type === "procurement"
    && target.object_id.startsWith("procurement:contract:")
    && target.canonical_url.startsWith("/procurements/");
  const isLandProject = target.object_type === "land_use_project"
    && /^project:[A-Za-z0-9][A-Za-z0-9_-]{2,24}$/.test(target.object_id)
    && target.canonical_url.startsWith("/browse/zoning/#land/");
  const isEntity = target.object_type === "entity"
    && isPublicEntityRef(target.object_id)
    && isEntityProfileHref(target.object_id, target.canonical_url);
  if (!isProcurement && !isLandProject && !isEntity) return null;
  const claim = target.claim_anchor;
  if (!claim) return target;
  if (claim.claim_type !== "relationship"
    && !(isEntity && claim.claim_type === "identity")) return isProcurement ? target : null;
  if (isEntity && claim.claim_type === "identity") {
    if (claim.field_or_semantic_key !== "identity"
      || claim.subject_id !== target.object_id
      || !isPublicEntityRef(claim.object_id)
      || claim.object_id === target.object_id
      || !REPORT_IDENTITY_INTENTS.includes(claim.identity_intent)
      || !claim.object_label) return null;
  } else if (!claim.relation_type || !claim.subject_id || !claim.object_id || !claim.field_or_semantic_key) return null;
  if (isProcurement) {
    if (claim.relation_type !== "named_vendor"
      || claim.field_or_semantic_key !== "vendor"
      || claim.subject_id !== target.object_id
      || !/^vendor:stem:[^\s]+$/.test(claim.object_id)) return null;
  }
  if (isLandProject) {
    if (!['sited_on_parcel', 'sits_on_parcel'].includes(claim.relation_type)
      || claim.field_or_semantic_key !== "parcel"
      || claim.subject_id !== target.object_id
      || !/^bbl:\d{10}$/.test(claim.object_id)) return null;
  }
  return target;
}

function isPublicEntityRef(value) {
  const ref = String(value || "");
  return /^entity:official:[^\s]+$/.test(ref)
    || /^agency:id:[a-z0-9][a-z0-9-]*$/i.test(ref)
    || /^vendor:stem:[^\s]+$/.test(ref);
}

function isEntityProfileHref(ref, href) {
  const value = String(href || "");
  if (!value.startsWith("/")) return false;
  if (ref.startsWith("entity:official:")) return value.startsWith("/officials/");
  if (ref.startsWith("agency:id:")) return value.startsWith("/agencies/");
  if (ref.startsWith("vendor:stem:")) return value.startsWith("/vendors/");
  return false;
}
