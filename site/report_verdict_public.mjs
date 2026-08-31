// Opaque public seam for private report adjudication.
//
// The public repository and public serializers may receive only an id-keyed
// label. Private review UI, process, actors, and reasoning never cross this
// boundary. This module is self-contained so browser and Pages graphs never
// import the private review contract.

export const REPORT_VERDICT_LABEL_SCHEMA = "cityscroll.report_verdict_label.v1";
export const PUBLIC_VERDICT_LABELS = Object.freeze([
  "reviewed",
  "corrected",
  "unresolved",
  "duplicate",
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

const LABEL_SET = new Set(PUBLIC_VERDICT_LABELS);

function present(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text || null;
}

export function publicLabelFor(verdict, civicChanged) {
  if (verdict === "ambiguous-or-insufficient-evidence") return "unresolved";
  if (verdict === "duplicate") return "duplicate";
  if (verdict === "confirmed" && civicChanged) return "corrected";
  return "reviewed";
}

export function projectPublicVerdictLabel(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) return null;
  const id = present(state.report_id || state.claim_id || state.id);
  if (!id) return null;
  const label = PUBLIC_VERDICT_LABELS.includes(state.label)
    ? state.label
    : publicLabelFor(state.verdict, Boolean(state.civic_result_changed));
  if (!LABEL_SET.has(label)) return null;
  return Object.freeze({
    schema: REPORT_VERDICT_LABEL_SCHEMA,
    id,
    label,
  });
}

export function projectPublicVerdictSeam(states) {
  const rows = [];
  const seen = new Set();
  for (const state of Array.isArray(states) ? states : []) {
    const label = projectPublicVerdictLabel(state);
    if (!label || seen.has(label.id)) continue;
    seen.add(label.id);
    rows.push(label);
  }
  return Object.freeze(rows);
}

export function publicVerdictSeamLeaksPrivate(value) {
  if (!value) return false;
  const rows = Array.isArray(value) ? value : [value];
  for (const row of rows) {
    if (!row || typeof row !== "object") return true;
    const keys = Object.keys(row);
    if (keys.some((key) => key !== "schema" && key !== "id" && key !== "label")) return true;
    const serialized = JSON.stringify(row);
    if (PRIVATE_REVIEW_FIELDS.some((field) => new RegExp(`"${field}"\\s*:`).test(serialized))) {
      return true;
    }
  }
  return false;
}
