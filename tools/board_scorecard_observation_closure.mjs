/**
 * Community-board minutes observation closure.
 *
 * Every one of the 59 boards is classified against actual detector scope.
 * An empty detector input is measurement unavailable: it never means no
 * minutes exist and it never means zero laggards.
 */

import { createHash } from "node:crypto";

export const BOARD_DISPOSITIONS = Object.freeze([
  "measured",
  "checked-no-dated-observation",
  "failed-collection",
  "unmeasured",
]);

export const DETECTOR_SCHEMA = "cityscroll.community_board_minutes_gap_detector.v1";

const FAILED_PROBE = new Set(["http_error", "failed", "error", "unavailable"]);

function dateOnly(value) {
  const text = String(value || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function boardObservationDisposition(probe = null, detectorRow = null, { detectorPresent = true } = {}) {
  if (!detectorPresent) return "unmeasured";
  if (detectorRow?.last_minutes_date) return "measured";
  if (probe && FAILED_PROBE.has(String(probe.status || ""))) return "failed-collection";
  if (probe && (probe.status === "ok" || probe.status === "empty" || Array.isArray(probe.observations))) {
    const dated = (probe.observations || []).some((row) => dateOnly(row?.meeting_date));
    if (dated) return "measured";
    return "checked-no-dated-observation";
  }
  if (detectorRow && Object.hasOwn(detectorRow, "last_minutes_date") && !detectorRow.last_minutes_date) {
    return "checked-no-dated-observation";
  }
  return "unmeasured";
}

export function detectorRowFromProbe(probe = {}, source = {}, asOf = null) {
  const dates = (probe.observations || []).map((row) => dateOnly(row.meeting_date)).filter(Boolean).sort();
  const lastDate = dates.at(-1) || null;
  const receipts = [];
  if (probe.fetched_at || probe.url) {
    receipts.push({
      kind: "publication-probe",
      path: "site/data/non_council_outcome_sources/verification_receipts/cb_minutes_publication_probes.json",
      observed_on: dateOnly(probe.fetched_at) || asOf || null,
      content_sha256: probe.content_sha256 || null,
    });
  }
  return {
    body_id: source.body_id || probe.body_id,
    last_minutes_date: lastDate,
    minutes_url: probe.url || source.source_url || null,
    notice_completeness: null,
    media_completeness: null,
    receipts,
  };
}

export function buildMinutesGapDetector({
  registry,
  probes = null,
  asOf = null,
  observedAt = null,
} = {}) {
  const boards = (registry?.sources || []).filter((row) => row.body_type === "community_board");
  if (!probes) {
    return {
      schema: DETECTOR_SCHEMA,
      as_of: asOf || null,
      measurement_available: false,
      evidence_revision: null,
      rows: [],
      missing_input: true,
    };
  }
  const probeList = Array.isArray(probes) ? probes : probes.probes || [];
  const byId = new Map(probeList.map((row) => [row.body_id, row]));
  const detectorAsOf = asOf || probes.as_of || dateOnly(probes.generated_at) || dateOnly(observedAt);
  const rows = boards.map((source) => detectorRowFromProbe(byId.get(source.body_id) || {}, source, detectorAsOf));
  const evidenceRevision = sha256(JSON.stringify({
    as_of: detectorAsOf,
    generated_at: probes.generated_at || observedAt || null,
    rows: rows.map((row) => ({ body_id: row.body_id, last_minutes_date: row.last_minutes_date })),
  }));
  return {
    schema: DETECTOR_SCHEMA,
    as_of: detectorAsOf,
    measurement_available: true,
    evidence_revision: evidenceRevision,
    generated_at: probes.generated_at || observedAt || null,
    rows,
    missing_input: false,
  };
}

export function classifyBoardDispositions({
  registry,
  detector = null,
  probes = null,
} = {}) {
  const boards = (registry?.sources || []).filter((row) => row.body_type === "community_board");
  const detectorPresent = Boolean(detector) && detector.missing_input !== true && Array.isArray(detector.rows);
  const detectorById = new Map((detector?.rows || []).map((row) => [row.body_id, row]));
  const probeById = new Map((Array.isArray(probes) ? probes : probes?.probes || []).map((row) => [row.body_id, row]));
  const rows = boards.map((source) => {
    const probe = probeById.get(source.body_id) || null;
    const detected = detectorById.get(source.body_id) || null;
    const inScope = detectorPresent && (detected != null || probe != null);
    const disposition = boardObservationDisposition(probe, detected, {
      detectorPresent: detectorPresent && inScope,
    });
    return {
      body_id: source.body_id,
      name: source.name,
      disposition: inScope ? disposition : "unmeasured",
      last_minutes_date: detected?.last_minutes_date || null,
      in_detector_scope: inScope,
    };
  });
  const counts = Object.fromEntries(BOARD_DISPOSITIONS.map((id) => [
    id,
    rows.filter((row) => row.disposition === id).length,
  ]));
  return {
    schema: "cityscroll.board_scorecard_observation_closure.v1",
    boards: rows.length,
    measurement_available: detectorPresent,
    evidence_revision: detector?.evidence_revision || null,
    counts,
    rows,
  };
}

export function scorecardRankings(rows, { measurementAvailable = true } = {}) {
  if (!measurementAvailable) {
    return { leaders: null, laggards: null, suppressed: true };
  }
  return {
    leaders: rows.leaders || [],
    laggards: rows.laggards || [],
    suppressed: false,
  };
}
