/**
 * Agency scope for the Staffing lens.
 *
 * Personnel appointments carry City Record agency_name spellings that often
 * differ from the canonical agency:id:* edge used in Browse facets. Exams are
 * citywide by default and only join an agency through publisher certification
 * edges — never treat the full exam guide as agency-scoped without that join.
 */

import { resolveAgencyIdentity } from "./agency_identity.mjs";

/** Resolve every source spelling that should match an agency scope filter. */
export function agencyScopeNames(agencyFilter) {
  const raw = String(agencyFilter || "").trim();
  if (!raw) return [];
  const identity = resolveAgencyIdentity(raw);
  const names = new Set(
    [identity.canonical_name, raw, ...(identity.variants || [])]
      .map((value) => String(value || "").trim())
      .filter(Boolean),
  );
  return [...names];
}

/** True when a hire notice's agency_name belongs to the active agency scope. */
export function hireMatchesAgencyScope(agencyName, agencyFilter) {
  const filter = String(agencyFilter || "").trim();
  if (!filter) return true;
  const row = String(agencyName || "").trim();
  if (!row) return false;
  if (row === filter) return true;
  const filterId = resolveAgencyIdentity(filter).canonical_id;
  const rowId = resolveAgencyIdentity(row).canonical_id;
  return Boolean(filterId && rowId && filterId === rowId);
}

/**
 * SODA `$where` fragment for Changes in Personnel rows under an agency scope.
 * Uses exact source spellings so City Record free-text matches.
 */
export function sodaAgencyNameClause(agencyFilter) {
  const names = agencyScopeNames(agencyFilter);
  if (!names.length) return "";
  const quoted = names
    .map((name) => `'${String(name).replace(/'/g, "''")}'`)
    .join(",");
  return `agency_name in(${quoted})`;
}

/** Extract exam numbers certified to an agency from the certification artifact. */
export function examNumbersForAgency(certificationPayload, agencyFilter) {
  const identity = resolveAgencyIdentity(agencyFilter || "");
  const agencyId = identity.canonical_id;
  if (!agencyId) return new Set();
  const rows = Array.isArray(certificationPayload?.by_agency)
    ? certificationPayload.by_agency
    : [];
  const row = rows.find((entry) => String(entry?.agency_id || "").trim() === agencyId)
    || rows.find((entry) => String(entry?.ref || "").trim() === `agency:id:${agencyId}`);
  const numbers = new Set();
  for (const edge of row?.edge_refs || []) {
    const match = String(edge || "").match(/^exam:(\d+)\|/);
    if (match) numbers.add(match[1]);
  }
  return numbers;
}

/** Keep only exams that the publisher certified to the scoped agency. */
export function filterExamsByAgencyScope(exams, examNumbers) {
  if (!(examNumbers instanceof Set)) return Array.isArray(exams) ? [...exams] : [];
  return (exams || []).filter((exam) => examNumbers.has(String(exam?.exam_number || "")));
}

/**
 * Presentation policy under an agency scope: appointments lead; exams only when
 * they carry a publisher certification edge to that agency.
 */
export function staffingAgencyScopePresentation(agencyFilter, examNumbers = null) {
  const scoped = Boolean(String(agencyFilter || "").trim());
  if (!scoped) {
    return {
      scoped: false,
      leadWithAppointments: false,
      showExamGuide: true,
      examFilterActive: false,
    };
  }
  const known = examNumbers instanceof Set;
  return {
    scoped: true,
    leadWithAppointments: true,
    // Hide the citywide guide until certification edges load; then show only
    // agency-matched exams (or stay hidden when the agency has none).
    showExamGuide: known ? examNumbers.size > 0 : false,
    examFilterActive: known,
  };
}
