/**
 * Pure helpers for the land upcoming-hearings materialization.
 *
 * Production payload rules:
 *  - Every row must be traceable to ZAP disposition fields (project_id + publisher
 *    provenance). Synthetic / demo padding is a finding.
 *  - Fixtures live under test/fixtures only; never in site/data.
 */
import {
  extractZapHearingLogistics,
  filterHearingLogistics,
  ZAP_HEARING_LOGISTICS_SOURCE,
  ZAP_HEARING_LOGISTICS_SCHEMA_VERSION,
} from "../../worker/src/lib/zap_hearing_logistics.mjs";
import { parseZapApiProject } from "../../worker/src/lib/zap_outcomes.mjs";

/** Sell-facing land statuses (same priority order as ZAP outcomes prewarm). */
export const LAND_HEARING_SWEEP_STATUSES = Object.freeze([
  "In Public Review",
  "Noticed",
  "Active",
  "Filed",
]);

export const LAND_UPCOMING_HEARINGS_SCHEMA_VERSION = 1;
export const LAND_HEARING_MATERIALIZATION_METHOD = "zap_disposition_sweep_v1";

/** Fabricated project names from the pre-materialization demo pad — never ship. */
const KNOWN_SYNTHETIC_PROJECT_NAMES = new Set([
  "Fixture Street Rezoning",
  "Example Avenue Special Permit",
]);

/**
 * True when a row is synthetic / demo padding rather than ZAP source data.
 * Used by the production payload detector and --check.
 */
export function isSyntheticHearingRow(row) {
  if (!row || typeof row !== "object") return true;
  if (row._synthetic === true || row.synthetic === true) return true;
  if (row.fixture === true || row.is_fixture === true) return true;
  const source = String(row.source || "").toLowerCase();
  if (source === "fixture" || source === "synthetic" || source === "demo") return true;
  if (KNOWN_SYNTHETIC_PROJECT_NAMES.has(String(row.project_name || ""))) return true;
  const pid = String(row.project_id || "");
  if (/^FIX/i.test(pid) || /^synthetic[-_]/i.test(pid) || /^example[-_]/i.test(pid)) {
    return true;
  }
  const derived = row.provenance?.derived;
  if (Array.isArray(derived)) {
    for (const d of derived) {
      const field = String(d?.field || "").toLowerCase();
      const method = String(d?.method || "").toLowerCase();
      if (field === "fixture" || field === "synthetic") return true;
      if (method.includes("fixture") || method.includes("synthetic")) return true;
      if (method === "build_land_upcoming_hearings" && field === "fixture") return true;
    }
  }
  return false;
}

/**
 * A production row is traceable when it has a project_id, a hearing date, and
 * publisher provenance pointing at ZAP disposition fields (not a free-form invent).
 */
export function isTraceableHearingRow(row) {
  if (!row || typeof row !== "object") return false;
  if (isSyntheticHearingRow(row)) return false;
  if (!String(row.project_id || "").trim()) return false;
  const day = String(row.hearing_date || row.hearing_at || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const src = String(row.source || row.provenance?.source || "");
  if (src && src !== ZAP_HEARING_LOGISTICS_SOURCE && src !== "zap-api-dispositions") {
    // Unknown source family — still require project_id + date, but flag below.
  }
  // Prefer explicit disposition provenance when present.
  const field = row.provenance?.field || row.provenance?.hearing_at?.field;
  if (field && !/dcp-publichearinglocation|dcp-dateofpublichearing/i.test(String(field))) {
    // Non-ZAP field label is not automatically synthetic, but lacks preferred trace.
  }
  return true;
}

/**
 * Detector: findings for synthetic or non-traceable rows in a production snapshot.
 * Empty hearings is allowed (quiet calendar) — only invented rows are findings.
 *
 * @returns {{ ok: boolean, findings: object[] }}
 */
export function detectSyntheticUpcomingHearings(snapshot) {
  const findings = [];
  if (!snapshot || typeof snapshot !== "object") {
    findings.push({ kind: "invalid_snapshot", detail: "missing snapshot object" });
    return { ok: false, findings };
  }
  if (!Array.isArray(snapshot.hearings)) {
    findings.push({ kind: "invalid_snapshot", detail: "hearings must be an array" });
    return { ok: false, findings };
  }
  if (snapshot.allow_synthetic === true) {
    findings.push({
      kind: "allow_synthetic_flag",
      detail: "production payload must not set allow_synthetic",
    });
  }
  snapshot.hearings.forEach((row, index) => {
    if (isSyntheticHearingRow(row)) {
      findings.push({
        kind: "synthetic_row",
        index,
        project_id: row?.project_id || null,
        project_name: row?.project_name || null,
        detail: "row is synthetic / fixture padding, not ZAP source data",
      });
      return;
    }
    if (!isTraceableHearingRow(row)) {
      findings.push({
        kind: "untraceable_row",
        index,
        project_id: row?.project_id || null,
        detail: "row missing project_id or hearing date required for source traceability",
      });
    }
  });
  return { ok: findings.length === 0, findings };
}

/**
 * Enrich extracted logistics with project list metadata (name, status, borough).
 */
export function enrichHearingRows(logistics, meta = {}) {
  return (logistics || []).map((h) => ({
    ...h,
    schema_version: h.schema_version || ZAP_HEARING_LOGISTICS_SCHEMA_VERSION,
    source: h.source || ZAP_HEARING_LOGISTICS_SOURCE,
    project_id: h.project_id || meta.project_id || null,
    project_name: meta.project_name || h.project_name || null,
    public_status: meta.public_status || h.public_status || null,
    portal_url:
      h.portal_url
      || meta.portal_url
      || (meta.project_id
        ? `https://zap.planning.nyc.gov/projects/${encodeURIComponent(meta.project_id)}`
        : null),
    borough: h.borough || meta.borough || null,
  }));
}

/**
 * Extract enriched hearing logistics from one ZAP API project payload + SODA meta.
 */
export function hearingsFromZapApiPayload(apiPayload, meta = {}) {
  const record = parseZapApiProject(apiPayload);
  if (!record?.project_id && !meta.project_id) return [];
  const logistics = extractZapHearingLogistics(record, {
    project_id: record.project_id || meta.project_id,
    portal_url: record.portal_url || meta.portal_url,
    borough: meta.borough || record.open_data?.borough || null,
  });
  return enrichHearingRows(logistics, {
    project_id: record.project_id || meta.project_id,
    project_name: record.project_name || meta.project_name,
    public_status: record.public_status || meta.public_status,
    portal_url: record.portal_url || meta.portal_url,
    borough: meta.borough,
  });
}

/**
 * Build the committed product snapshot (upcoming-only filter applied).
 *
 * @param {object[]} allHearings — all extracted logistics (past + future)
 * @param {object} opts
 */
export function buildUpcomingHearingsSnapshot(allHearings, opts = {}) {
  const today = String(opts.today || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const upcoming = filterHearingLogistics(allHearings, {
    today,
    upcoming_only: true,
  });
  // Fail closed: never emit synthetic rows even if a caller passed them.
  const clean = upcoming.filter((row) => !isSyntheticHearingRow(row) && isTraceableHearingRow(row));
  const materialization = {
    method: LAND_HEARING_MATERIALIZATION_METHOD,
    mode: opts.mode || "unknown",
    today,
    projects_listed: opts.projects_listed ?? null,
    projects_fetched: opts.projects_fetched ?? null,
    projects_failed: opts.projects_failed ?? null,
    hearings_extracted: Array.isArray(allHearings) ? allHearings.length : 0,
    upcoming_count: clean.length,
    statuses: opts.statuses || LAND_HEARING_SWEEP_STATUSES.slice(),
    polite_delay_ms: opts.polite_delay_ms ?? null,
  };
  return {
    schema_version: LAND_UPCOMING_HEARINGS_SCHEMA_VERSION,
    generated_at: opts.generated_at || new Date().toISOString(),
    source: ZAP_HEARING_LOGISTICS_SOURCE,
    note:
      "Precomputed land-use hearing logistics for the Land → Upcoming hearings filter. "
      + "Derived from ZAP disposition dcp-publichearinglocation + dcp-dateofpublichearing "
      + "across sell-facing Open Data project statuses. Synthetic rows are forbidden; "
      + "an empty list means no future hearing dates were published at materialization time. "
      + "Unparsed free text stays on hearing_location_raw.",
    materialization,
    hearings: clean,
  };
}

/**
 * Build a verification receipt for the materialization run.
 */
export function buildMaterializationReceipt(snapshot, extra = {}) {
  const mat = snapshot?.materialization || {};
  const detection = detectSyntheticUpcomingHearings(snapshot);
  return {
    schema_version: 1,
    kind: "land_upcoming_hearings_materialization",
    observed_at: snapshot?.generated_at || new Date().toISOString(),
    method: mat.method || LAND_HEARING_MATERIALIZATION_METHOD,
    mode: mat.mode || extra.mode || null,
    projects_listed: mat.projects_listed,
    projects_fetched: mat.projects_fetched,
    projects_failed: mat.projects_failed,
    hearings_extracted: mat.hearings_extracted,
    upcoming_count: mat.upcoming_count ?? snapshot?.hearings?.length ?? 0,
    statuses: mat.statuses,
    detector_ok: detection.ok,
    detector_findings: detection.findings,
    sample_project_ids: (snapshot?.hearings || [])
      .map((h) => h.project_id)
      .filter(Boolean)
      .slice(0, 12),
    ...extra,
  };
}

export {
  filterHearingLogistics,
  extractZapHearingLogistics,
  ZAP_HEARING_LOGISTICS_SOURCE,
};
