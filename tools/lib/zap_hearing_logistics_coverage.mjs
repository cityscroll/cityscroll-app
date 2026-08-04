/**
 * Fixed-project coverage summary for individual ZAP hearing logistics.
 *
 * The denominator is the successfully fetched sample, never the whole city.
 * Only the disposition-derived shape accepted by /zap-outcomes counts.
 */

import { ZAP_HEARING_LOGISTICS_SOURCE } from "../../worker/src/lib/zap_hearing_logistics.mjs";

function exactProjectId(value) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function isExactDispositionHearingEvidence(row, projectId) {
  if (!row || typeof row !== "object") return false;
  if (row.source !== ZAP_HEARING_LOGISTICS_SOURCE) return false;
  if (!exactProjectId(projectId) || exactProjectId(row.project_id) !== exactProjectId(projectId)) {
    return false;
  }
  if (row.provenance?.field !== "dcp-publichearinglocation") return false;
  if (row.provenance?.hearing_at?.field !== "dcp-dateofpublichearing") return false;
  return Boolean(row.hearing_date || row.hearing_at || row.hearing_location_raw);
}

function rate(joined, total) {
  return total > 0 ? Number((joined / total).toFixed(4)) : null;
}

export function summarizeZapHearingLogisticsCoverage(sample = [], { today } = {}) {
  const day = String(today || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const projects = [];
  let fetched = 0;
  let failed = 0;
  let joinMismatch = 0;
  let withLogistics = 0;
  let withDated = 0;
  let withVenue = 0;
  let withLivestream = 0;
  let withVenueOrLivestream = 0;
  let withUpcomingDate = 0;
  let logisticsRows = 0;
  let invalidRows = 0;

  for (const item of sample) {
    const projectId = String(item?.project_id || "").trim();
    if (item?.status !== "ok" || !item.record) {
      failed += 1;
      projects.push({ project_id: projectId || null, status: "fetch_failed" });
      continue;
    }
    fetched += 1;
    const record = item.record;
    const joined = exactProjectId(record.project_id) === exactProjectId(projectId);
    if (!joined) joinMismatch += 1;
    const rawRows = Array.isArray(record.hearing_logistics) ? record.hearing_logistics : [];
    const rows = rawRows.filter((row) => isExactDispositionHearingEvidence(row, projectId));
    invalidRows += rawRows.length - rows.length;
    logisticsRows += rows.length;

    const hasLogistics = rows.length > 0;
    const hasDated = rows.some((row) => Boolean(row.hearing_date || row.hearing_at));
    const hasVenue = rows.some((row) => Boolean(row.venue_address));
    const hasLivestream = rows.some((row) => Boolean(row.livestream_url));
    const hasVenueOrLivestream = hasVenue || hasLivestream;
    const hasUpcomingDate = rows.some((row) => {
      const hearingDay = String(row.hearing_date || row.hearing_at || "").slice(0, 10);
      return /^\d{4}-\d{2}-\d{2}$/.test(hearingDay) && hearingDay >= day;
    });
    if (hasLogistics) withLogistics += 1;
    if (hasDated) withDated += 1;
    if (hasVenue) withVenue += 1;
    if (hasLivestream) withLivestream += 1;
    if (hasVenueOrLivestream) withVenueOrLivestream += 1;
    if (hasUpcomingDate) withUpcomingDate += 1;
    projects.push({
      project_id: projectId || null,
      status: joined ? "ok" : "join_mismatch",
      hearing_logistics: hasLogistics,
      logistics_rows: rows.length,
      dated: hasDated,
      venue: hasVenue,
      livestream: hasLivestream,
      upcoming_date: hasUpcomingDate,
    });
  }

  const rates = {
    hearing_logistics: { joined: withLogistics, total: fetched, rate: rate(withLogistics, fetched) },
    dated: { joined: withDated, total: fetched, rate: rate(withDated, fetched) },
    venue: { joined: withVenue, total: fetched, rate: rate(withVenue, fetched) },
    livestream: { joined: withLivestream, total: fetched, rate: rate(withLivestream, fetched) },
    venue_or_livestream: {
      joined: withVenueOrLivestream,
      total: fetched,
      rate: rate(withVenueOrLivestream, fetched),
    },
    upcoming_date: {
      joined: withUpcomingDate,
      total: fetched,
      rate: rate(withUpcomingDate, fetched),
    },
  };
  return {
    fixed_sample_total: sample.length,
    projects_fetched: fetched,
    projects_failed: failed,
    join_mismatches: joinMismatch,
    logistics_rows: logisticsRows,
    invalid_logistics_rows: invalidRows,
    honest_absent: Math.max(0, fetched - withLogistics),
    rates,
    projects,
  };
}
