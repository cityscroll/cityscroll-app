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

export const LAND_UPCOMING_HEARINGS_SCHEMA_VERSION = 2;
export const LAND_HEARING_MATERIALIZATION_METHOD = "zap_published_hearing_sweep_v2";
export const ZAP_MILESTONE_HEARING_SOURCE = "zap-api-milestones";

export const ZAP_HEARING_MILESTONE_CLASSES = Object.freeze({
  cpc_pre_hearing_review_session: Object.freeze({
    representing: "City Planning Commission",
    source_titles: Object.freeze([
      "Review Session - Pre-Hearing Review / Post Referral",
    ]),
  }),
  cpc_public_hearing: Object.freeze({
    representing: "City Planning Commission",
    source_titles: Object.freeze([
      "CPC Public Meeting - Public Hearing",
      "City Planning Commission Public Hearing",
    ]),
  }),
});

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
  const field = row.provenance?.field || row.provenance?.hearing_at?.field;
  if (src === ZAP_MILESTONE_HEARING_SOURCE) {
    if (field !== "dcp-reviewmeetingdate") return false;
    if (!Object.hasOwn(ZAP_HEARING_MILESTONE_CLASSES, String(row.event_class || ""))) {
      return false;
    }
    const classification = classifyZapHearingMilestone({
      source_title: row.milestone_source_title,
      title: row.milestone_title,
      time: { basis: "review_meeting" },
    });
    if (classification?.event_class !== row.event_class) return false;
    if (!String(row.milestone_id || "").trim()) return false;
    if (!String(row.portal_url || "").startsWith("https://zap.planning.nyc.gov/projects/")) {
      return false;
    }
  } else if (src && src !== ZAP_HEARING_LOGISTICS_SOURCE && src !== "zap-api-dispositions") {
    return false;
  } else if (field && !/dcp-publichearinglocation|dcp-dateofpublichearing/i.test(String(field))) {
    return false;
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

function normalizedMilestoneTitle(value) {
  return String(value || "")
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Return the accepted published milestone class, or null outside the narrow contract. */
export function classifyZapHearingMilestone(milestone) {
  if (milestone?.time?.basis !== "review_meeting") return null;
  const titles = [milestone.source_title, milestone.title]
    .map(normalizedMilestoneTitle)
    .filter(Boolean);
  for (const [eventClass, contract] of Object.entries(ZAP_HEARING_MILESTONE_CLASSES)) {
    const accepted = contract.source_titles.map(normalizedMilestoneTitle);
    if (titles.some((title) => accepted.includes(title))) {
      return { event_class: eventClass, representing: contract.representing };
    }
  }
  return null;
}

function isHearingShapedMilestone(milestone) {
  if (milestone?.time?.basis !== "review_meeting") return false;
  const publishedText = [milestone.source_title, milestone.title, milestone.description]
    .filter(Boolean)
    .join(" ");
  return /\bhearing\b|\breview session\b|\bpublic meeting\b/i.test(publishedText);
}

function milestoneHearingRow(milestone, classification, meta = {}) {
  const hearingDate = String(milestone?.time?.value || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(hearingDate)) return null;
  const hearingAt = String(milestone?.review_meeting_at || hearingDate);
  const projectId = String(meta.project_id || "").trim();
  if (!projectId) return null;
  const portalUrl = meta.portal_url
    || `https://zap.planning.nyc.gov/projects/${encodeURIComponent(projectId)}`;
  return {
    schema_version: ZAP_HEARING_LOGISTICS_SCHEMA_VERSION,
    source: ZAP_MILESTONE_HEARING_SOURCE,
    project_id: projectId,
    project_name: meta.project_name || null,
    public_status: meta.public_status || null,
    portal_url: portalUrl,
    borough: meta.borough || null,
    milestone_id: milestone.id || null,
    milestone_title: milestone.title || null,
    milestone_source_title: milestone.source_title || null,
    event_class: classification.event_class,
    representing: classification.representing,
    phase_id: "cpc",
    hearing_date: hearingDate,
    hearing_at: hearingAt,
    hearing_location_raw: null,
    venue_address: null,
    livestream_url: null,
    vote_location: null,
    attendance_modes: [],
    maps_url: null,
    parse_status: "published_date_only",
    provenance: {
      field: "dcp-reviewmeetingdate",
      source: ZAP_MILESTONE_HEARING_SOURCE,
      value: hearingAt,
      title: {
        field: milestone.source_title_field || "display-name",
        value: milestone.source_title || milestone.title || null,
      },
      classification: {
        method: "exact_published_title_v1",
        event_class: classification.event_class,
      },
      derived: [],
    },
  };
}

/**
 * Evaluate source-published ZAP meeting milestones against the accepted hearing-title contract.
 * Rows outside the contract are retained only as a bounded review sample, never as product data.
 */
export function reviewZapHearingMilestones(record, meta = {}) {
  const hearings = [];
  const reviewedFalsePositiveSample = [];
  let publishedMeetingDatesEvaluated = 0;
  let hearingShapedCandidatesReviewed = 0;
  const acceptedByClass = {};

  for (const milestone of record?.milestones || []) {
    if (milestone?.time?.basis !== "review_meeting") continue;
    publishedMeetingDatesEvaluated += 1;
    const classification = classifyZapHearingMilestone(milestone);
    if (isHearingShapedMilestone(milestone)) hearingShapedCandidatesReviewed += 1;
    if (classification) {
      const row = milestoneHearingRow(milestone, classification, meta);
      if (row) {
        hearings.push(row);
        acceptedByClass[classification.event_class] =
          (acceptedByClass[classification.event_class] || 0) + 1;
      }
      continue;
    }
    if (isHearingShapedMilestone(milestone) && reviewedFalsePositiveSample.length < 12) {
      reviewedFalsePositiveSample.push({
        project_id: meta.project_id || record?.project_id || null,
        milestone_id: milestone.id || null,
        source_title: milestone.source_title || milestone.title || null,
        display_title: milestone.title || null,
        meeting_date: milestone.time?.value || null,
        status: milestone.status || null,
        review_result: "outside_exact_title_contract",
      });
    }
  }
  return {
    hearings,
    published_meeting_dates_evaluated: publishedMeetingDatesEvaluated,
    hearing_shaped_candidates_reviewed: hearingShapedCandidatesReviewed,
    accepted_by_class: acceptedByClass,
    reviewed_false_positive_sample: reviewedFalsePositiveSample,
  };
}

/** Parse one ZAP API payload once and return disposition + accepted milestone rows. */
export function materializationRowsFromZapApiPayload(apiPayload, meta = {}) {
  const record = parseZapApiProject(apiPayload);
  if (!record?.project_id && !meta.project_id) {
    return {
      hearings: [],
      milestone_review: reviewZapHearingMilestones(null),
    };
  }
  const enrichedMeta = {
    project_id: record.project_id || meta.project_id,
    project_name: record.project_name || meta.project_name,
    public_status: record.public_status || meta.public_status,
    portal_url: record.portal_url || meta.portal_url,
    borough: meta.borough || record.open_data?.borough || null,
  };
  const dispositionRows = enrichHearingRows(
    extractZapHearingLogistics(record, enrichedMeta),
    enrichedMeta,
  );
  const milestoneReview = reviewZapHearingMilestones(record, enrichedMeta);
  return {
    hearings: [...dispositionRows, ...milestoneReview.hearings],
    milestone_review: milestoneReview,
  };
}

/**
 * Extract enriched hearing logistics from one ZAP API project payload + SODA meta.
 */
export function hearingsFromZapApiPayload(apiPayload, meta = {}) {
  return materializationRowsFromZapApiPayload(apiPayload, meta).hearings;
}

function countRowsByEventClass(rows) {
  const counts = {};
  for (const row of rows || []) {
    if (!row?.event_class) continue;
    counts[row.event_class] = (counts[row.event_class] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function dedupeUpcomingHearings(rows) {
  const byProjectDay = new Map();
  for (const row of rows || []) {
    const key = `${String(row.project_id || "").toUpperCase()}|${String(
      row.hearing_date || row.hearing_at || "",
    ).slice(0, 10)}`;
    const previous = byProjectDay.get(key);
    if (!previous || (
      previous.source === ZAP_MILESTONE_HEARING_SOURCE
      && row.source !== ZAP_MILESTONE_HEARING_SOURCE
    )) {
      byProjectDay.set(key, row);
    }
  }
  return [...byProjectDay.values()].sort((a, b) =>
    String(a.hearing_at || a.hearing_date || "").localeCompare(
      String(b.hearing_at || b.hearing_date || ""),
    )
    || String(a.project_id || "").localeCompare(String(b.project_id || ""))
  );
}

/**
 * Build the committed product snapshot (upcoming-only filter applied).
 *
 * @param {object[]} allHearings — all extracted logistics (past + future)
 * @param {object} opts
 */
export function buildUpcomingHearingsSnapshot(allHearings, opts = {}) {
  const today = String(opts.today || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const traceable = (allHearings || []).filter(
    (row) => !isSyntheticHearingRow(row) && isTraceableHearingRow(row),
  );
  const dispositionRows = traceable.filter((row) => row.source !== ZAP_MILESTONE_HEARING_SOURCE);
  const milestoneRows = traceable.filter((row) => row.source === ZAP_MILESTONE_HEARING_SOURCE);
  const dispositionUpcoming = filterHearingLogistics(dispositionRows, {
    today,
    upcoming_only: true,
  });
  const milestoneUpcoming = filterHearingLogistics(milestoneRows, {
    today,
    upcoming_only: true,
  });
  const clean = dedupeUpcomingHearings([...dispositionUpcoming, ...milestoneUpcoming]);
  const dispositionOnly = dedupeUpcomingHearings(dispositionUpcoming);
  const materialization = {
    method: LAND_HEARING_MATERIALIZATION_METHOD,
    mode: opts.mode || "unknown",
    today,
    projects_listed: opts.projects_listed ?? null,
    projects_fetched: opts.projects_fetched ?? null,
    projects_failed: opts.projects_failed ?? null,
    hearings_extracted: traceable.length,
    disposition_hearings_extracted: dispositionRows.length,
    milestone_hearings_extracted: milestoneRows.length,
    disposition_upcoming_count: dispositionOnly.length,
    milestone_upcoming_count: milestoneUpcoming.length,
    incremental_milestone_count: Math.max(0, clean.length - dispositionOnly.length),
    accepted_milestone_classes: countRowsByEventClass(milestoneUpcoming),
    published_meeting_dates_evaluated:
      opts.milestone_review?.published_meeting_dates_evaluated ?? null,
    hearing_shaped_candidates_reviewed:
      opts.milestone_review?.hearing_shaped_candidates_reviewed ?? null,
    upcoming_count: clean.length,
    statuses: opts.statuses || LAND_HEARING_SWEEP_STATUSES.slice(),
    polite_delay_ms: opts.polite_delay_ms ?? null,
  };
  return {
    schema_version: LAND_UPCOMING_HEARINGS_SCHEMA_VERSION,
    generated_at: opts.generated_at || new Date().toISOString(),
    sources: [ZAP_HEARING_LOGISTICS_SOURCE, ZAP_MILESTONE_HEARING_SOURCE],
    note:
      "Precomputed land-use hearing logistics for the Land → Upcoming hearings filter. "
      + "Derived from ZAP disposition dcp-publichearinglocation + dcp-dateofpublichearing "
      + "and exact hearing-shaped ZAP milestone titles with dcp-reviewmeetingdate "
      + "across sell-facing Open Data project statuses. Synthetic rows are forbidden; "
      + "an empty list means no future hearing dates were published at materialization time. "
      + "Unparsed free text stays on hearing_location_raw; absent venue and remote-mode fields remain null.",
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
  const {
    milestone_review: milestoneReview = null,
    ...receiptExtra
  } = extra;
  return {
    schema_version: 2,
    kind: "land_upcoming_hearings_materialization",
    observed_at: snapshot?.generated_at || new Date().toISOString(),
    method: mat.method || LAND_HEARING_MATERIALIZATION_METHOD,
    mode: mat.mode || extra.mode || null,
    projects_listed: mat.projects_listed,
    projects_fetched: mat.projects_fetched,
    projects_failed: mat.projects_failed,
    hearings_extracted: mat.hearings_extracted,
    disposition_hearings_extracted: mat.disposition_hearings_extracted,
    milestone_hearings_extracted: mat.milestone_hearings_extracted,
    before_upcoming_count: mat.disposition_upcoming_count,
    milestone_upcoming_count: mat.milestone_upcoming_count,
    incremental_milestone_count: mat.incremental_milestone_count,
    accepted_milestone_classes: mat.accepted_milestone_classes,
    published_meeting_dates_evaluated: mat.published_meeting_dates_evaluated,
    hearing_shaped_candidates_reviewed: mat.hearing_shaped_candidates_reviewed,
    upcoming_count: mat.upcoming_count ?? snapshot?.hearings?.length ?? 0,
    statuses: mat.statuses,
    detector_ok: detection.ok,
    detector_findings: detection.findings,
    sample_project_ids: [...new Set(
      (snapshot?.hearings || []).map((h) => h.project_id).filter(Boolean),
    )].slice(0, 12),
    reviewed_false_positive_sample:
      milestoneReview?.reviewed_false_positive_sample || [],
    ...receiptExtra,
  };
}

export {
  filterHearingLogistics,
  extractZapHearingLogistics,
  ZAP_HEARING_LOGISTICS_SOURCE,
};
