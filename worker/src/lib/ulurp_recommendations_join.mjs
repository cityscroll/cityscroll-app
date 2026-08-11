// Strict ULURP-number join: ZAP projects (hgx4-8ukb) ↔ Open Data ULURP
// recommendations (Borough President positions + PDF companion letters).
//
// Measured 2026-07-30; usefulness re-gated 2026-08-11 on the joinable-candidate
// denominator (see verification receipts + ontology/join_gate_policy.mjs):
//
//   Catalog coverage contrast (ZAP projects with non-null ulurp_numbers):
//     either recommendations or PDFs: 0.54% (152 / 27,971)
//     recommendations alone (4j6i-9rmr): 0.29% (81 / 27,971)
//     PDFs alone (gt5i-dmde): 0.25% (71 / 27,971)
//
//   Gate denominator (recommendation/PDF rows that hit some ZAP project):
//     recommendations 80/91 ≈ 87.91%; PDFs 73/88 ≈ 82.95%
//
// Accepted strategies (strict only):
//   exact_ulurp_token — normalized ULURP application token (optional type letter
//                       + 6-digit body + letter suffix) exact-set intersection
//
// Rejected as weak:
//   bare 6-digit body without suffix (collides across action types)
//   title/project-name only
//   Property Disposition notice sample as success metric (wrong universe —
//   disposition notices are not ZAP ULURP projects)
//
// Verdict (2026-08-11): ship a sparse Borough President recommendation panel
// gated on recommendation_rows_hit_zap. ZAP-universe catalog coverage remains
// contrast-only and must not re-kill the join.

// Shared with site notice-land join — isolated 6-digit body + whole-word
// action-code suffix (rejects Zoom "…302621 Meeting" → 302621MEET).
export {
  extractUlurpKeys,
  isPlausibleUlurpKey,
  isPlausibleUlurpSuffix,
  filterPlausibleUlurpKeys,
} from "../../../site/ulurp_tokens.mjs";

import { extractUlurpKeys } from "../../../site/ulurp_tokens.mjs";

/**
 * Build a recommendation index keyed by every strict ULURP token found on a row.
 * @param {Iterable<{ ulurp_field?: string, row?: object }>} rows
 *   Each item: { ulurp_field: raw number string, row: original record }
 * @returns {Map<string, object[]>}
 */
export function buildUlurpRecommendationIndex(rows) {
  const index = new Map();
  for (const item of rows || []) {
    const field = item?.ulurp_field ?? item?.ulurp_numbers ?? item?.ulurp_number_s
      ?? item?.ulurp_application_number;
    const row = item?.row ?? item;
    for (const key of extractUlurpKeys(field)) {
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(row);
    }
  }
  return index;
}

/**
 * Strict join: any extracted key on the ZAP ulurp_numbers field hits the index.
 * @returns {{ method: string, keys: string[], rows: object[] } | null}
 */
export function joinZapUlurpToRecommendations(ulurpNumbers, index) {
  if (!(index instanceof Map) || index.size === 0) return null;
  const zkeys = extractUlurpKeys(ulurpNumbers);
  if (!zkeys.size) return null;
  const hitKeys = [];
  const seen = new Set();
  const rows = [];
  for (const k of zkeys) {
    const list = index.get(k);
    if (!list?.length) continue;
    hitKeys.push(k);
    for (const row of list) {
      const id = rowIdentity(row);
      if (seen.has(id)) continue;
      seen.add(id);
      rows.push(row);
    }
  }
  if (!rows.length) return null;
  return { method: "exact_ulurp_token", keys: hitKeys.sort(), rows };
}

function rowIdentity(row) {
  if (!row || typeof row !== "object") return String(row);
  return [
    row.ulurp_number_s || row.ulurp_application_number || "",
    row.recommendation_date || row.date || "",
    row.borough_president || row.pdf_download || row.project || "",
  ].join("|");
}

/**
 * Normalize a recommendation/PDF row for product-facing display (no edge use yet).
 */
export function summarizeUlurpRecommendation(row, { kind = "recommendation" } = {}) {
  if (!row || typeof row !== "object") {
    return { kind, ulurp_numbers: null, position: null, date: null, pdf_url: null, project: null };
  }
  if (kind === "pdf" || row.pdf_download) {
    return {
      kind: "pdf",
      ulurp_numbers: clean(row.ulurp_application_number),
      position: null,
      date: isoDate(row.date),
      pdf_url: cleanUrl(row.pdf_download),
      project: clean(row.project),
      community_board: null,
      council_district: null,
    };
  }
  return {
    kind: "recommendation",
    ulurp_numbers: clean(row.ulurp_number_s),
    position: clean(row.borough_president),
    date: isoDate(row.recommendation_date),
    pdf_url: null,
    project: clean(row.ulurp_application_name),
    community_board: clean(row.community_board_s),
    council_district: clean(row.council_district_s),
  };
}

function clean(value) {
  if (value == null) return null;
  const s = String(value).replace(/\s+/g, " ").trim();
  return s || null;
}

function isoDate(value) {
  if (!value) return null;
  const s = String(value);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

/** Prefer the direct PDF URL; never the dataset landing page. */
export function cleanUrl(value) {
  const s = clean(value);
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}
