/**
 * Host-side retention + kill-sample measurement for person-hub constellation
 * publisher rows (Council Members, eLobbyist, CFB contributions).
 *
 * Product joins already ship on person hub / influence lookups. This layer
 * retains immutable source_records-shaped snapshots and re-measures the
 * hub join so dual-write coverage can clear the repository gates.
 */

import {
  councilMemberSourceSystemId,
  elobbyistSourceSystemId,
  cfbContributionSourceSystemId,
  NYC_COUNCIL_MEMBERS_SOURCE_SYSTEM,
  CITY_CLERK_ELOBBYIST_SOURCE_SYSTEM,
  CFB_CAMPAIGN_CONTRIBUTIONS_SOURCE_SYSTEM,
} from "../../worker/src/lib/person_hub_source_records.mjs";
import {
  measureLobbyTargetJoin,
  measureCfbRecipientJoin,
} from "../../site/official_influence.mjs";
import { buildPersonHubLookup } from "../../site/person_hub.mjs";

export const USEFULNESS_FLOOR = 0.3;
export const PRECISION_FLOOR = 0.95;

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

/**
 * Normalize one Council Members term row for retention.
 * Source-null fields stay null. Drops rows without a numeric person id.
 */
export function normalizeCouncilMemberRow(row) {
  if (!row || typeof row !== "object") return null;
  const personId = clean(row.council_member_id ?? row.person_id);
  if (!personId || !/^\d+$/.test(personId)) return null;
  const name = clean(row.name ?? row.person_name);
  if (!name) return null;
  const termStart = clean(row.term_start).slice(0, 10) || null;
  const termEnd = clean(row.term_end).slice(0, 10) || null;
  const district = clean(row.district) || null;
  const officeId = clean(row.office_id) || null;
  const parsed = {
    name,
    council_member_id: personId,
    term_start: termStart,
    term_end: termEnd,
    district,
    office_id: officeId,
  };
  return {
    ...parsed,
    source_system: NYC_COUNCIL_MEMBERS_SOURCE_SYSTEM,
    source_system_id: councilMemberSourceSystemId(parsed),
  };
}

/**
 * Normalize one eLobbyist row for retention.
 * Keeps free-text targets; never invents a registration id.
 */
export function normalizeElobbyistRow(row) {
  if (!row || typeof row !== "object") return null;
  const registrationId = clean(row.registration_id);
  const client = clean(row.client_name);
  const lobbyist = clean(row.lobbyist_name);
  const targets = clean(row.lobbyist_targets);
  if (!registrationId && !client && !lobbyist) return null;
  if (!targets && !client) return null;
  const parsed = {
    registration_id: registrationId || null,
    client_name: client || null,
    lobbyist_name: lobbyist || null,
    lobbyist_targets: targets || null,
    report_year: clean(row.report_year) || null,
  };
  return {
    ...parsed,
    source_system: CITY_CLERK_ELOBBYIST_SOURCE_SYSTEM,
    source_system_id: elobbyistSourceSystemId(parsed),
  };
}

/**
 * Normalize one CFB contribution row for retention.
 * City Council office code (5) is preferred but not required for retention —
 * product measurement filters officecd=5 at sample time.
 */
export function normalizeCfbContributionRow(row) {
  if (!row || typeof row !== "object") return null;
  const recipId = clean(row.recipid);
  const recipName = clean(row.recipname);
  const donor = clean(row.name);
  if (!recipId && !recipName) return null;
  const amountRaw = row.amnt != null && row.amnt !== ""
    ? Number(String(row.amnt).replace(/[$,]/g, ""))
    : null;
  const parsed = {
    name: donor || null,
    recipid: recipId || null,
    recipname: recipName || null,
    amnt: Number.isFinite(amountRaw) ? amountRaw : null,
    election: clean(row.election) || null,
    officecd: clean(row.officecd) || null,
    candfirst: clean(row.candfirst) || null,
  };
  return {
    ...parsed,
    source_system: CFB_CAMPAIGN_CONTRIBUTIONS_SOURCE_SYSTEM,
    source_system_id: cfbContributionSourceSystemId(parsed),
  };
}

function retainNormalized(inputRows, normalizeFn) {
  const rows = [];
  const blocked = { missing_identity: 0, duplicate_source_ids: 0 };
  const seen = new Set();
  for (const row of Array.isArray(inputRows) ? inputRows : []) {
    const normalized = normalizeFn(row);
    if (!normalized) {
      blocked.missing_identity += 1;
      continue;
    }
    if (seen.has(normalized.source_system_id)) {
      blocked.duplicate_source_ids += 1;
      continue;
    }
    seen.add(normalized.source_system_id);
    rows.push(normalized);
  }
  return {
    rows,
    counts: {
      input_rows: (Array.isArray(inputRows) ? inputRows : []).length,
      retained: rows.length,
    },
    blocked,
  };
}

export function retainCouncilMemberRows(inputRows) {
  return retainNormalized(inputRows, normalizeCouncilMemberRow);
}

export function retainElobbyistRows(inputRows) {
  return retainNormalized(inputRows, normalizeElobbyistRow);
}

export function retainCfbContributionRows(inputRows) {
  return retainNormalized(inputRows, normalizeCfbContributionRow);
}

/**
 * Project a retained row into the immutable source_records envelope
 * used by Worker dual-write (snapshot payload only — no DB write).
 */
export function rowToSourceRecord(row, ingestedAt) {
  if (!row) return null;
  const {
    source_system,
    source_system_id,
    ...payload
  } = row;
  return {
    source_system: source_system || null,
    source_system_id: source_system_id || null,
    payload_json: payload,
    normalized_json: payload,
    ingested_at: ingestedAt || null,
  };
}

/**
 * Kill-sample measurement for Council Members retention → person hub.
 *
 * Usefulness: share of retained term rows whose council_member_id lands in the
 * person hub (exact PersonId). Precision: reviewed same/reject among joined
 * rows (exact id identity → mechanical same when name is non-empty).
 */
export function measureCouncilMemberHubJoin(retainedRows, personHubLookup = {}) {
  const byId = personHubLookup?.by_person_id || {};
  const rows = Array.isArray(retainedRows) ? retainedRows : [];
  let joined = 0;
  let miss = 0;
  const reviewed = [];
  for (const row of rows) {
    const id = clean(row.council_member_id);
    const hub = byId[id];
    if (!hub) {
      miss += 1;
      if (reviewed.length < 40) {
        reviewed.push({
          council_member_id: id,
          name: row.name || null,
          label: "miss",
        });
      }
      continue;
    }
    joined += 1;
    // Exact PersonId join: accept when hub name is non-empty.
    const label = clean(hub.person_name) ? "same" : "reject";
    if (reviewed.filter((r) => r.label === "same" || r.label === "reject").length < 40) {
      reviewed.push({
        council_member_id: id,
        name: row.name || null,
        hub_name: hub.person_name || null,
        label,
        review_reason: label === "same" ? "exact_person_id" : "empty_hub_name",
      });
    }
  }
  const same = reviewed.filter((r) => r.label === "same");
  const rejects = reviewed.filter((r) => r.label === "reject");
  const precisionDenom = same.length + rejects.length;
  const total = rows.length;
  const usefulness = total ? Number((joined / total).toFixed(4)) : null;
  const precision = precisionDenom
    ? Number((same.length / precisionDenom).toFixed(4))
    : null;
  const gates = {
    usefulness_floor: USEFULNESS_FLOOR,
    precision_floor: PRECISION_FLOOR,
    usefulness_cleared: usefulness != null && usefulness >= USEFULNESS_FLOOR,
    precision_cleared: precision != null && precision >= PRECISION_FLOOR,
    materialize: false,
  };
  gates.materialize = Boolean(gates.usefulness_cleared && gates.precision_cleared);
  return {
    source: "uvw5-9znb",
    usefulness: {
      joined,
      total,
      rate: usefulness,
      floor: USEFULNESS_FLOOR,
      denominator: "retained Council Members term rows",
      numerator: "rows whose council_member_id is present in the person hub",
    },
    precision: {
      true_positives: same.length,
      false_positives: rejects.length,
      attempts: precisionDenom,
      rate: precision,
      floor: PRECISION_FLOOR,
      basis: "exact council_member_id = Legistar PersonId with non-empty hub name",
    },
    miss,
    reviewed,
    gates,
  };
}

/**
 * Wrap influence measurements into the retention gate shape.
 */
export function measureLobbyRetentionJoin(retainedRows, personHubLookup) {
  const measured = measureLobbyTargetJoin(retainedRows, personHubLookup);
  const gates = {
    usefulness_floor: USEFULNESS_FLOOR,
    precision_floor: PRECISION_FLOOR,
    usefulness_cleared: Boolean(measured.gate?.usefulness_pass),
    precision_cleared: Boolean(measured.gate?.precision_pass),
    materialize: Boolean(measured.gate?.promoted),
  };
  return {
    source: "fmf3-knd8",
    usefulness: {
      joined: measured.joined_mentions,
      total: measured.person_shaped_mentions,
      rate: measured.usefulness,
      floor: USEFULNESS_FLOOR,
      denominator: "person-shaped lobbyist_targets mentions on retained rows",
      numerator: "mentions that resolve to a unique person-hub name key",
    },
    precision: {
      true_positives: (measured.reviewed || []).filter((r) => r.label === "same").length,
      false_positives: (measured.reviewed || []).filter((r) => r.label === "reject").length,
      attempts: measured.reviewed_sample_size,
      rate: measured.precision,
      floor: PRECISION_FLOOR,
      basis: "reviewed exact unique person-name key joins only",
    },
    reviewed: measured.reviewed,
    gates,
    raw: measured,
  };
}

export function measureCfbRetentionJoin(retainedRows, personHubLookup) {
  const measured = measureCfbRecipientJoin(retainedRows, personHubLookup);
  const gates = {
    usefulness_floor: USEFULNESS_FLOOR,
    precision_floor: PRECISION_FLOOR,
    usefulness_cleared: Boolean(measured.gate?.usefulness_pass),
    precision_cleared: Boolean(measured.gate?.precision_pass),
    materialize: Boolean(measured.gate?.promoted),
  };
  return {
    source: "rjkp-yttg",
    usefulness: {
      joined: measured.joined_recipients,
      total: measured.distinct_recipients,
      rate: measured.usefulness,
      floor: USEFULNESS_FLOOR,
      denominator: "distinct CFB City Council recipients on retained rows",
      numerator: "recipients that resolve to a unique person-hub name key",
    },
    precision: {
      true_positives: (measured.reviewed || []).filter((r) => r.label === "same").length,
      false_positives: (measured.reviewed || []).filter((r) => r.label === "reject").length,
      attempts: measured.reviewed_sample_size,
      rate: measured.precision,
      floor: PRECISION_FLOOR,
      basis: "reviewed exact unique person-name key joins only",
    },
    reviewed: measured.reviewed,
    gates,
    raw: measured,
  };
}

/**
 * Build person hub from retained council rows when a lookup is not supplied.
 */
export function hubFromCouncilRows(councilRows) {
  return buildPersonHubLookup(
    (Array.isArray(councilRows) ? councilRows : []).map((r) => ({
      name: r.name,
      council_member_id: r.council_member_id,
      term_start: r.term_start,
      term_end: r.term_end,
      district: r.district,
      office_id: r.office_id,
    })),
  );
}

/**
 * Full three-stream retention pass used by the host collector and tests.
 */
export function retainPersonHubConstellation({
  councilRows = [],
  lobbyRows = [],
  cfbRows = [],
  personHubLookup = null,
  ingestedAt = null,
} = {}) {
  const council = retainCouncilMemberRows(councilRows);
  const lobby = retainElobbyistRows(lobbyRows);
  const cfb = retainCfbContributionRows(cfbRows);
  const hub = personHubLookup || hubFromCouncilRows(council.rows);

  const councilMeasure = measureCouncilMemberHubJoin(council.rows, hub);
  const lobbyMeasure = measureLobbyRetentionJoin(lobby.rows, hub);
  const cfbMeasure = measureCfbRetentionJoin(cfb.rows, hub);

  const at = ingestedAt || new Date().toISOString();
  const sourceRecords = [
    ...council.rows.map((r) => rowToSourceRecord(r, at)),
    ...lobby.rows.map((r) => rowToSourceRecord(r, at)),
    ...cfb.rows.map((r) => rowToSourceRecord(r, at)),
  ].filter(Boolean);

  const materialize = Boolean(
    councilMeasure.gates.materialize
    && lobbyMeasure.gates.materialize
    && cfbMeasure.gates.materialize,
  );

  return {
    council,
    lobby,
    cfb,
    measurements: {
      council: councilMeasure,
      lobby: lobbyMeasure,
      cfb: cfbMeasure,
    },
    source_records: sourceRecords,
    counts: {
      council_retained: council.counts.retained,
      lobby_retained: lobby.counts.retained,
      cfb_retained: cfb.counts.retained,
      source_records: sourceRecords.length,
    },
    gates: {
      usefulness_floor: USEFULNESS_FLOOR,
      precision_floor: PRECISION_FLOOR,
      council_materialize: councilMeasure.gates.materialize,
      lobby_materialize: lobbyMeasure.gates.materialize,
      cfb_materialize: cfbMeasure.gates.materialize,
      materialize,
    },
  };
}
