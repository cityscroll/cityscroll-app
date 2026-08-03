/**
 * Notice-level ZAP / ULURP project spine join.
 *
 * Residual gap over Land detail (`#land/{id}` + `/zap-outcomes`): City Record
 * land notices should mount the same phase-grouped project timeline once a
 * strict ULURP (or explicit ZAP project id) join resolves.
 *
 * Pure view/join helpers only — no fetch. Browser loads:
 *   1. site/data/zap_projects_warehouse_lookup.json (build-time reverse index)
 *   2. GET /zap-outcomes?id= (edge-materialized spine + statutory clock + stats)
 *
 * Join strategies (strict only):
 *   exact_ulurp_token — normalized ULURP application token intersection
 *   exact_project_id  — explicit ZAP project id in body or pre-stamped field
 *
 * Wrong universe: Property Disposition notices are not ZAP ULURP projects.
 */

export {
  extractUlurpKeys,
  isPlausibleUlurpKey,
  isPlausibleUlurpSuffix,
  filterPlausibleUlurpKeys,
} from "./ulurp_tokens.mjs";

import {
  extractUlurpKeys,
  isPlausibleUlurpKey,
  filterPlausibleUlurpKeys,
} from "./ulurp_tokens.mjs";

export const NOTICE_LAND_SPINE_SCHEMA_VERSION = 1;

/** ZAP portal / API project ids: 2022M0258 or P2018X0210. */
const ZAP_PROJECT_ID_RE = /\b(P?\d{4}[A-Z]\d{3,6})\b/gi;
const ZAP_PORTAL_ID_RE = /zap\.planning\.nyc\.gov\/projects\/(P?\d{4}[A-Z]\d{3,6})/gi;

function clean(value) {
  if (value == null) return null;
  const s = String(value).replace(/\s+/g, " ").trim();
  return s || null;
}

/**
 * Extract ZAP project ids from free text (portal URLs + bare product ids).
 * @param {string|null|undefined} value
 * @returns {Set<string>}
 */
export function extractZapProjectIds(value) {
  const ids = new Set();
  if (value == null) return ids;
  const text = String(value);
  for (const m of text.matchAll(ZAP_PORTAL_ID_RE)) {
    const id = clean(m[1]);
    if (id) ids.add(id.toUpperCase());
  }
  for (const m of text.matchAll(ZAP_PROJECT_ID_RE)) {
    const id = clean(m[1]);
    if (id) ids.add(id.toUpperCase());
  }
  return ids;
}

/** City Record fields that may carry ULURP / ZAP refs (same bag as worker cityRecordBlob). */
export function cityRecordNoticeBlob(row) {
  if (!row || typeof row !== "object") return "";
  return [
    row.short_title,
    row.additional_description_1,
    row.additional_description_2,
    row.additional_description_3,
    row.other_info_1,
    row.other_info_2,
    row.other_info_3,
    row.printout_1,
    row.printout_2,
    row.printout_3,
    row.ulurp_numbers,
  ]
    .filter(Boolean)
    .join(" ")
    .replace(/<[^>]*>/g, " ");
}

/**
 * @param {object|null|undefined} notice
 * @returns {{ ulurp_keys: string[], zap_project_ids: string[], body_blob: string }}
 */
export function extractNoticeLandRefs(notice) {
  const body_blob = cityRecordNoticeBlob(notice || {});
  const ulurp = extractUlurpKeys(body_blob);
  const zap = extractZapProjectIds(body_blob);
  if (notice && typeof notice === "object") {
    // Pre-stamped keys must still pass the token rules (stale snapshots may
    // carry Zoom/phone false positives like 302621MEET).
    for (const k of filterPlausibleUlurpKeys(notice.ulurp_keys)) {
      ulurp.add(k);
    }
    for (const id of Array.isArray(notice.zap_project_ids) ? notice.zap_project_ids : []) {
      const cleanId = clean(id);
      if (cleanId) zap.add(cleanId.toUpperCase());
    }
    const explicit = clean(notice.project_id);
    if (explicit && /^P?\d{4}[A-Z]\d{3,6}$/i.test(explicit)) {
      zap.add(explicit.toUpperCase());
    }
  }
  return {
    ulurp_keys: [...ulurp].sort(),
    zap_project_ids: [...zap].sort(),
    body_blob,
  };
}

/**
 * Property Disposition is the wrong universe for ULURP/ZAP project spines.
 * Eligible when the notice carries at least one strict land ref (ULURP or project id).
 * @param {object|null|undefined} notice
 */
export function isNoticeLandSpineEligible(notice) {
  if (!notice || typeof notice !== "object") return false;
  if (notice.section_name === "Property Disposition") return false;
  const refs = extractNoticeLandRefs(notice);
  return refs.ulurp_keys.length > 0 || refs.zap_project_ids.length > 0;
}

/**
 * Build reverse ULURP → project rows index from warehouse (or similar) lookup doc.
 * @param {{ rows?: object[] }|null|undefined} lookupDoc
 * @returns {{ byUlurp: Map<string, object[]>, byProjectId: Map<string, object> }}
 */
export function buildZapProjectJoinIndex(lookupDoc) {
  /** @type {Map<string, object[]>} */
  const byUlurp = new Map();
  /** @type {Map<string, object>} */
  const byProjectId = new Map();
  const rows = Array.isArray(lookupDoc?.rows) ? lookupDoc.rows : [];
  for (const row of rows) {
    const projectId = clean(row?.project_id);
    if (!projectId) continue;
    const normId = projectId.toUpperCase();
    const slim = {
      project_id: projectId,
      project_name: clean(row.project_name),
      public_status: clean(row.public_status),
      ulurp_numbers: clean(row.ulurp_numbers),
      borough: clean(row.borough),
      primary_applicant: clean(row.primary_applicant),
      current_milestone: clean(row.current_milestone),
    };
    byProjectId.set(normId, slim);
    for (const key of extractUlurpKeys(row.ulurp_numbers)) {
      if (!byUlurp.has(key)) byUlurp.set(key, []);
      const list = byUlurp.get(key);
      if (!list.some((r) => String(r.project_id).toUpperCase() === normId)) {
        list.push(slim);
      }
    }
  }
  return { byUlurp, byProjectId };
}

/**
 * Resolve a City Record notice to zero-or-one ZAP project via strict keys.
 * Ambiguous multi-project hits stay unresolved (no invent).
 *
 * @param {object|null|undefined} notice
 * @param {{ byUlurp: Map, byProjectId: Map }|null|undefined} index
 * @returns {{
 *   matched: boolean,
 *   method: string|null,
 *   keys: string[],
 *   project_id: string|null,
 *   project: object|null,
 *   candidates: object[],
 *   refs: { ulurp_keys: string[], zap_project_ids: string[] },
 *   reason: string|null
 * }}
 */
export function resolveZapProjectForNotice(notice, index) {
  const refs = extractNoticeLandRefs(notice);
  const empty = {
    matched: false,
    method: null,
    keys: [],
    project_id: null,
    project: null,
    candidates: [],
    refs: {
      ulurp_keys: refs.ulurp_keys,
      zap_project_ids: refs.zap_project_ids,
    },
    reason: null,
  };
  if (!index?.byProjectId) {
    return { ...empty, reason: "no_index" };
  }
  if (!refs.ulurp_keys.length && !refs.zap_project_ids.length) {
    return { ...empty, reason: "no_land_refs" };
  }

  /** @type {Map<string, { project: object, method: string, keys: string[] }>} */
  const hits = new Map();

  for (const id of refs.zap_project_ids) {
    const project = index.byProjectId.get(String(id).toUpperCase());
    if (!project) continue;
    const pid = String(project.project_id);
    const cur = hits.get(pid) || {
      project,
      method: "exact_project_id",
      keys: [],
    };
    if (!cur.keys.includes(id)) cur.keys.push(id);
    hits.set(pid, cur);
  }

  for (const key of refs.ulurp_keys) {
    const list = index.byUlurp.get(key) || [];
    for (const project of list) {
      const pid = String(project.project_id);
      const cur = hits.get(pid) || {
        project,
        method: "exact_ulurp_token",
        keys: [],
      };
      // Prefer explicit project-id method when both fire.
      if (cur.method !== "exact_project_id") cur.method = "exact_ulurp_token";
      if (!cur.keys.includes(key)) cur.keys.push(key);
      hits.set(pid, cur);
    }
  }

  const candidates = [...hits.values()].map((h) => ({
    project_id: h.project.project_id,
    project_name: h.project.project_name,
    public_status: h.project.public_status,
    method: h.method,
    keys: h.keys.slice().sort(),
  }));

  if (!candidates.length) {
    return {
      ...empty,
      reason: "no_warehouse_match",
    };
  }
  if (candidates.length > 1) {
    return {
      matched: false,
      method: null,
      keys: [...new Set(candidates.flatMap((c) => c.keys))].sort(),
      project_id: null,
      project: null,
      candidates,
      refs: empty.refs,
      reason: "ambiguous_project",
    };
  }

  const only = hits.values().next().value;
  return {
    matched: true,
    method: only.method,
    keys: only.keys.slice().sort(),
    project_id: only.project.project_id,
    project: only.project,
    candidates,
    refs: empty.refs,
    reason: null,
  };
}

/**
 * Compact join receipt for UI provenance (no secrets).
 * @param {ReturnType<typeof resolveZapProjectForNotice>} resolution
 */
export function noticeLandJoinReceipt(resolution) {
  if (!resolution) {
    return {
      schema_version: NOTICE_LAND_SPINE_SCHEMA_VERSION,
      matched: false,
      method: null,
      keys: [],
      project_id: null,
      candidate_count: 0,
      reason: "missing",
    };
  }
  return {
    schema_version: NOTICE_LAND_SPINE_SCHEMA_VERSION,
    matched: !!resolution.matched,
    method: resolution.method,
    keys: resolution.keys || [],
    project_id: resolution.project_id,
    candidate_count: (resolution.candidates || []).length,
    reason: resolution.reason,
  };
}

/**
 * Classify extracted ULURP tokens as plausible vs malformed (for class measurement).
 * @param {Iterable<string>|null|undefined} keys
 */
export function classifyUlurpKeySet(keys) {
  const all = [...(keys || [])].map((k) => String(k || "").toUpperCase()).filter(Boolean);
  const plausible = [];
  const malformed = [];
  for (const k of all) {
    if (isPlausibleUlurpKey(k)) plausible.push(k);
    else malformed.push(k);
  }
  return {
    keys: all.sort(),
    plausible: plausible.sort(),
    malformed: malformed.sort(),
    has_malformed: malformed.length > 0,
    has_plausible: plausible.length > 0,
  };
}

/**
 * Named join-resolution scorecard over a notice corpus + ZAP reverse index.
 * Separates malformed extracted ids (extractor bug class) from genuine
 * portal-misses (plausible ULURP, no unique warehouse row).
 *
 * @param {Iterable<object>} notices
 * @param {{ byUlurp: Map, byProjectId: Map }|null|undefined} index
 * @returns {object}
 */
export function measureNoticeLandJoinResolution(notices, index) {
  let eligible = 0;
  let matched = 0;
  let unmatched_plausible = 0;
  let unmatched_malformed_only = 0;
  let ambiguous = 0;
  let no_index = 0;
  let not_eligible = 0;
  const malformed_examples = [];

  for (const notice of notices || []) {
    const stamped = Array.isArray(notice?.ulurp_keys) ? notice.ulurp_keys : [];
    const stampedClass = classifyUlurpKeySet(stamped);
    // Inspect raw stamps even when the strict extractor drops them from eligibility
    // so Zoom/phone false positives remain a measurable class.
    if (!isNoticeLandSpineEligible(notice)) {
      if (stampedClass.has_malformed && !stampedClass.has_plausible) {
        unmatched_malformed_only += 1;
        if (malformed_examples.length < 12) {
          malformed_examples.push({
            request_id: notice?.request_id || null,
            keys: stampedClass.malformed,
          });
        }
      } else {
        not_eligible += 1;
      }
      continue;
    }

    eligible += 1;
    const resolution = resolveZapProjectForNotice(notice, index);
    if (resolution?.reason === "no_index") {
      no_index += 1;
      continue;
    }
    if (resolution?.matched) {
      matched += 1;
      continue;
    }
    if (resolution?.reason === "ambiguous_project") {
      ambiguous += 1;
      continue;
    }
    unmatched_plausible += 1;
  }

  const join_resolution_rate = eligible
    ? Number((matched / eligible).toFixed(4))
    : null;
  const malformed_share_of_unresolved = (unmatched_plausible + unmatched_malformed_only + ambiguous) > 0
    ? Number(
      (
        unmatched_malformed_only
        / (unmatched_plausible + unmatched_malformed_only + ambiguous)
      ).toFixed(4),
    )
    : 0;

  return {
    metric: "notice_land_join_resolution_rate",
    eligible,
    matched,
    unmatched_plausible,
    unmatched_malformed_only,
    ambiguous,
    no_index,
    not_eligible,
    join_resolution_rate,
    malformed_share_of_unresolved,
    malformed_examples,
  };
}


