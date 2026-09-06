/**
 * Dated capital-project comparisons for the procurement research packet.
 *
 * Reads the acquisition-time materialization. This module never queries the
 * publisher and never recomputes a comparison: the difference was taken once,
 * during acquisition, against releases proven complete, and is replayed here so
 * the packet a reader exports and the panel a reader sees carry the same numbers.
 *
 * Amounts are whole-project budgets and recorded project spending; dates are
 * project forecast completions. None of them is a solicitation value, a bid
 * deadline, or a contract term, and the copy here says so wherever a number
 * appears.
 */

export const PROJECT_HISTORY_SCHEMA = "cityscroll.procurement_project_history.v1";
export const PROJECT_HISTORY_DATASET_ID = "fb86-vt7u";
export const PROJECT_HISTORY_SOURCE_CONTRACT_ID = "capital-projects-dashboard";
export const PROJECT_HISTORY_SOURCE_URL = "https://data.cityofnewyork.us/d/fb86-vt7u";
export const PROJECT_HISTORY_METRIC_METHOD = "capital_project_release_difference_v1";

const PROJECT_HISTORY_SIGNAL_SCHEMA = "cityscroll.investigation_comparative_signal.v1";
const PROJECT_HISTORY_RECEIPT_REFERENCE_SCHEMA = "cityscroll.comparative_fact_reference.v1";
const PROJECT_HISTORY_RECEIPT_SCHEMA = "cityscroll.comparative_fact.v1";

/** Release labels are the publisher's own "YYYYMM" reporting period. */
const PROJECT_HISTORY_MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Scope labels. Every rendered and exported number carries one of these. */
export const PROJECT_HISTORY_SCOPE_LABELS = Object.freeze({
  total_budget: "Whole-project budget",
  spend_to_date: "Recorded whole-project spending",
  forecast_completion: "Project forecast completion",
  current_phase: "Published project phase",
});

const PROJECT_HISTORY_BOUNDARY_NOTE =
  "Whole-project figures published by the capital projects dashboard. Not a solicitation value, "
  + "a bid deadline, or a contract term.";

export function projectHistoryReleaseLabel(period) {
  const text = String(period ?? "");
  if (!/^\d{6}$/.test(text)) return "";
  const month = PROJECT_HISTORY_MONTHS[Number(text.slice(4, 6)) - 1];
  return month ? `${month} ${text.slice(0, 4)}` : "";
}

function projectHistoryText(value, max = 300) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Format an exact decimal string as US currency without going through a float. */
export function projectHistoryAmount(value) {
  const text = String(value ?? "").trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
  const negative = text.startsWith("-");
  const [whole, fraction = ""] = text.replace("-", "").split(".");
  const cents = `${fraction}00`.slice(0, 2);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}$${grouped}.${cents}`;
}

/** Signed currency, used only where a delta is genuinely comparable. */
export function projectHistorySignedAmount(value) {
  const formatted = projectHistoryAmount(value);
  if (formatted === null) return null;
  return formatted.startsWith("-") ? formatted : `+${formatted}`;
}

/** Plain-language day movement. Direction is stated, never implied by sign alone. */
export function projectHistoryDayMovement(days) {
  if (!Number.isInteger(days)) return null;
  if (days === 0) return "unchanged";
  const magnitude = Math.abs(days);
  return `${magnitude} ${magnitude === 1 ? "day" : "days"} ${days > 0 ? "later" : "earlier"}`;
}

/**
 * One row per compared field, shared by the panel and the export.
 *
 * Both surfaces read this function so a displayed number and an exported number
 * cannot drift: there is one computation and two renderings of it.
 */
export function projectHistoryFieldRows(entry) {
  const changes = entry?.changes && typeof entry.changes === "object" ? entry.changes : {};
  const rows = [];
  for (const field of ["total_budget", "spend_to_date", "forecast_completion", "current_phase"]) {
    const change = changes[field];
    if (!change) continue;
    const row = {
      field,
      scope_label: PROJECT_HISTORY_SCOPE_LABELS[field],
      state: projectHistoryText(change.state, 40),
      before: change.before ?? null,
      after: change.after ?? null,
      delta: null,
      delta_label: null,
    };
    if (field === "total_budget" || field === "spend_to_date") {
      row.before_label = projectHistoryAmount(change.before);
      row.after_label = projectHistoryAmount(change.after);
      row.delta = change.delta ?? null;
      row.delta_label = change.state === "changed" ? projectHistorySignedAmount(change.delta) : null;
    } else if (field === "forecast_completion") {
      row.before_label = change.before ?? null;
      row.after_label = change.after ?? null;
      row.delta = Number.isInteger(change.delta_days) ? change.delta_days : null;
      row.delta_label = change.state === "changed" ? projectHistoryDayMovement(change.delta_days) : null;
    } else {
      row.before_label = change.before ?? null;
      row.after_label = change.after ?? null;
    }
    rows.push(row);
  }
  return rows;
}

/**
 * What a reader is told when there is no comparison to show.
 *
 * Absence has several distinct causes and they are not interchangeable: a project
 * observed once has no earlier value to compare, while a project that stopped
 * being published has an earlier value and no later one. Neither is a change.
 */
export function projectHistoryAvailability(entry) {
  const state = projectHistoryText(entry?.identity_state, 40);
  if (state === "compared") {
    return entry?.changed
      ? { available: true, kind: "changed", note: "" }
      : {
        available: true,
        kind: "unchanged",
        note: "No published figure changed between these two releases.",
      };
  }
  if (state === "first_observed") {
    return {
      available: false,
      kind: "first_observed",
      note: "First published in the later release, so there is no earlier observation to compare.",
    };
  }
  if (state === "disappeared") {
    return {
      available: false,
      kind: "disappeared",
      note: "Published in the earlier release and absent from the later one. Absence is not a completed or cancelled project.",
    };
  }
  return {
    available: false,
    kind: "not_published",
    note: "Not published in either compared release.",
  };
}

/** The two original observations behind a comparison, with their dates kept apart. */
export function projectHistoryObservations(entry) {
  const observations = [];
  for (const [role, observation] of [["before", entry?.before], ["after", entry?.after]]) {
    if (!observation) continue;
    observations.push({
      role,
      reporting_period: observation.reporting_period ?? null,
      reporting_period_label: projectHistoryReleaseLabel(observation.reporting_period),
      agency_data_date: observation.agency_data_date ?? null,
      financial_data_date: observation.financial_data_date ?? null,
      managing_agency: observation.managing_agency ?? null,
      fms_id: observation.fms_id ?? null,
      pid: observation.pid ?? null,
      total_budget: observation.total_budget ?? null,
      spend_to_date: observation.spend_to_date ?? null,
      forecast_completion: observation.forecast_completion ?? null,
      current_phase: observation.current_phase ?? null,
    });
  }
  return observations;
}

/** One sentence stating the movement, its scope, and what it is not. */
export function projectHistoryClaim(entry, { before, after } = {}) {
  const identifier = entry?.fms_id || entry?.pid || "";
  const agency = entry?.managing_agency || "";
  const window = `${projectHistoryReleaseLabel(before)} to ${projectHistoryReleaseLabel(after)}`;
  const availability = projectHistoryAvailability(entry);
  if (!availability.available) {
    return `${agency} capital project ${identifier}: no published comparison between ${window}. ${availability.note}`;
  }
  const parts = [];
  for (const row of projectHistoryFieldRows(entry)) {
    if (row.state !== "changed") continue;
    if (row.field === "total_budget") parts.push(`whole-project budget ${row.delta_label}`);
    if (row.field === "spend_to_date") parts.push(`recorded whole-project spending ${row.delta_label}`);
    if (row.field === "forecast_completion") parts.push(`project forecast completion ${row.delta_label}`);
    if (row.field === "current_phase") parts.push(`published phase ${row.before} to ${row.after}`);
  }
  if (!parts.length) {
    return `${agency} capital project ${identifier}: no published figure changed between ${window}. ${PROJECT_HISTORY_BOUNDARY_NOTE}`;
  }
  return `${agency} capital project ${identifier}, ${window}: ${parts.join("; ")}. ${PROJECT_HISTORY_BOUNDARY_NOTE}`;
}

function projectHistoryWindowDay(observation) {
  return observation?.financial_data_date || observation?.agency_data_date || null;
}

/**
 * Project one comparison into the Investigation comparative-signal contract.
 *
 * The research package projects admitted signals; it does not run comparisons.
 * This builds the signal from the already-materialized difference so the packet
 * carries the same numbers the panel shows.
 */
export function projectHistoryComparativeSignal(entry, history, { rank = 1 } = {}) {
  if (!entry || history?.schema !== PROJECT_HISTORY_SCHEMA) return null;
  const availability = projectHistoryAvailability(entry);
  if (!availability.available) return null;

  const identifier = projectHistoryText(entry.fms_id || entry.pid, 160);
  const agency = projectHistoryText(entry.managing_agency, 160);
  if (!identifier || !agency) return null;

  const before = history?.transition?.before;
  const after = history?.transition?.after;
  const windowStart = projectHistoryWindowDay(entry.before);
  const windowEnd = projectHistoryWindowDay(entry.after);
  if (!windowStart || !windowEnd) return null;

  const identityGate = entry.fms_id
    ? "managing agency + FMS identifier"
    : "managing agency + nonempty project identifier";
  const receiptId = `capital_project_history.${agency}.${identifier}.${before}-${after}`;
  const materializedAt = projectHistoryText(history.materialized_at || history.generated_at, 40)
    || `${after.slice(0, 4)}-${after.slice(4, 6)}-01T00:00:00.000Z`;
  const vintages = [{
    source_contract_id: PROJECT_HISTORY_SOURCE_CONTRACT_ID,
    source_contract_schema_version: 1,
    dataset_id: PROJECT_HISTORY_DATASET_ID,
    materialized_at: materializedAt,
    row_count: history?.counts?.admitted_agency_rows ?? null,
  }];
  const comparedCount = entry.fms_id
    ? history?.counts?.financial?.compared
    : history?.counts?.schedule?.compared;

  return {
    schema: PROJECT_HISTORY_SIGNAL_SCHEMA,
    t: "signal",
    id: `story_signal:${receiptId}`,
    title: `${agency} capital project ${identifier}`,
    meta: `${PROJECT_HISTORY_METRIC_METHOD} · 2 compared observations`,
    claim: projectHistoryClaim(entry, { before, after }),
    subject: {
      type: "capital_project",
      id: identifier,
      ref: `capital_project:${agency}:${identifier}`,
      label: `${agency} capital project ${identifier}`,
    },
    subject_href: `/procurement/projects/${encodeURIComponent(identifier)}/`,
    peer_set_href: `/procurement/projects/?agency=${encodeURIComponent(agency)}`,
    comparison: {
      population: {
        object_type: "capital_project",
        source_family: "capital_projects_dashboard",
        agency_id: agency,
        agency_name: agency,
      },
      eligible_count: Number.isInteger(comparedCount) ? comparedCount : 0,
      observed_count: projectHistoryObservations(entry).length,
      window: { start: windowStart, end: windowEnd, end_inclusive: true },
      rank,
    },
    comparison_receipt: {
      schema: PROJECT_HISTORY_RECEIPT_REFERENCE_SCHEMA,
      receipt_schema: PROJECT_HISTORY_RECEIPT_SCHEMA,
      receipt_id: receiptId,
      metric_method: PROJECT_HISTORY_METRIC_METHOD,
      peer_basis: {
        class_id: `capital_project_history:${agency}`,
        observability_basis: "published_release",
        source_contract_versions: [`${PROJECT_HISTORY_SOURCE_CONTRACT_ID}@1`],
        source_vintages: vintages,
        inclusion_rule: `Releases retained completely at or after ${history?.release_reconciliation?.release_floor ?? ""}, compared at ${identityGate}.`,
        identity_gate: identityGate,
        observation_quality_class: "published_release_observation",
        censoring_class: "absent_release_not_treated_as_change",
        selected_level: "whole_project",
        small_n_policy_id: "two_release_difference",
      },
      generated_at: materializedAt,
    },
    evidence: [{
      kind: "published_release",
      source_contract_id: PROJECT_HISTORY_SOURCE_CONTRACT_ID,
      source_row_id: identifier,
      href: PROJECT_HISTORY_SOURCE_URL,
    }],
    note: "",
    added: "",
  };
}

/**
 * The exported view of one comparison.
 *
 * Built from the same field rows and observations the panel renders, so
 * display/export parity is a property of the code path rather than a convention
 * two call sites are expected to keep.
 */
export function projectHistoryExport(entry, history) {
  if (!entry) return null;
  const before = history?.transition?.before ?? null;
  const after = history?.transition?.after ?? null;
  return {
    schema: PROJECT_HISTORY_SCHEMA,
    managing_agency: entry.managing_agency ?? null,
    fms_id: entry.fms_id ?? null,
    pid: entry.pid ?? null,
    identity_rule: entry.fms_id ? history?.financial_identity_rule ?? null : history?.schedule_identity_rule ?? null,
    source_contract_id: PROJECT_HISTORY_SOURCE_CONTRACT_ID,
    dataset_id: PROJECT_HISTORY_DATASET_ID,
    source_url: PROJECT_HISTORY_SOURCE_URL,
    scope_note: PROJECT_HISTORY_BOUNDARY_NOTE,
    transition: { before, after },
    availability: projectHistoryAvailability(entry),
    observations: projectHistoryObservations(entry),
    calculations: projectHistoryFieldRows(entry),
    claim: projectHistoryClaim(entry, { before, after }),
  };
}

/** Look one project up by its native published identity. */
export function projectHistoryFind(history, { fmsId = "", pid = "" } = {}) {
  if (history?.schema !== PROJECT_HISTORY_SCHEMA) return null;
  if (fmsId) {
    return (history.financial_projects || []).find((entry) => entry.fms_id === fmsId) || null;
  }
  if (pid) {
    return (history.schedule_projects || []).find((entry) => entry.pid === pid) || null;
  }
  return null;
}

/**
 * A failed export keeps the comparison on screen and offers the same request again.
 *
 * The packet is a research artifact, so a failure has to say what did not happen
 * rather than leave a half-written export looking complete.
 */
export function projectHistoryExportFailure(error, { retry = null } = {}) {
  return {
    ok: false,
    kind: "export_failed",
    message: "The research packet could not be exported. The project comparison below is unchanged.",
    detail: projectHistoryText(error?.message || error, 300),
    retry_label: "Try the export again",
    can_retry: typeof retry === "function",
    retry,
  };
}
