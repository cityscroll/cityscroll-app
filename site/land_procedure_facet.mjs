/**
 * Land review-procedure facet.
 *
 * Publisher `ulurp_non` is ULURP / ELURP / Non-ULURP. Top-level can be null;
 * assembled zap-outcomes rows often park the field on `open_data.ulurp_non`.
 *
 * Default `review` admits ULURP + ELURP so expedited records are findable and
 * followable. ULURP-only remains an explicit preset. Non-ULURP is offered but
 * stays out of the default so the list is not flooded.
 */

const cleanLandProcedureValue = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

export const LAND_PROCEDURE_ULURP = "ULURP";
export const LAND_PROCEDURE_ELURP = "ELURP";
export const LAND_PROCEDURE_NON_ULURP = "Non-ULURP";

export const DEFAULT_LAND_PROCEDURE = "review";

export const LAND_PROCEDURE_OPTIONS = Object.freeze([
  {
    id: "review",
    label_key: "land_procedure_review",
    values: Object.freeze([LAND_PROCEDURE_ULURP, LAND_PROCEDURE_ELURP]),
  },
  {
    id: "ulurp",
    label_key: "land_procedure_ulurp",
    values: Object.freeze([LAND_PROCEDURE_ULURP]),
  },
  {
    id: "elurp",
    label_key: "land_procedure_elurp",
    values: Object.freeze([LAND_PROCEDURE_ELURP]),
  },
  {
    id: "non_ulurp",
    label_key: "land_procedure_non_ulurp",
    values: Object.freeze([LAND_PROCEDURE_NON_ULURP]),
  },
]);

const LAND_PROCEDURE_IDS = new Set(LAND_PROCEDURE_OPTIONS.map((option) => option.id));
const LAND_PROCEDURE_BY_ID = new Map(LAND_PROCEDURE_OPTIONS.map((option) => [option.id, option]));

function openDataBag(row = {}) {
  return row.open_data && typeof row.open_data === "object" ? row.open_data : {};
}

/** Publisher procedure label, reading open_data when the top-level field is empty. */
export function resolveLandProcedure(row = {}) {
  const raw = cleanLandProcedureValue(row.ulurp_non) || cleanLandProcedureValue(openDataBag(row).ulurp_non);
  if (!raw) return null;
  const upper = raw.toUpperCase().replace(/_/g, "-");
  if (upper === "ELURP") return LAND_PROCEDURE_ELURP;
  if (upper === "NON-ULURP") return LAND_PROCEDURE_NON_ULURP;
  if (upper === "ULURP") return LAND_PROCEDURE_ULURP;
  return null;
}

export function normalizeLandProcedure(value, fallback = DEFAULT_LAND_PROCEDURE) {
  const id = cleanLandProcedureValue(value).toLowerCase();
  return LAND_PROCEDURE_IDS.has(id) ? id : fallback;
}

export function landProcedureValues(procedure = DEFAULT_LAND_PROCEDURE) {
  const selected = normalizeLandProcedure(procedure);
  return LAND_PROCEDURE_BY_ID.get(selected)?.values || LAND_PROCEDURE_BY_ID.get(DEFAULT_LAND_PROCEDURE).values;
}

/**
 * Missing procedure is treated as ULURP-admissible — the historical silent
 * filter only dropped rows that *declared* a non-ULURP label.
 */
export function landRowMatchesProcedure(row, procedure = DEFAULT_LAND_PROCEDURE) {
  const allowed = landProcedureValues(procedure);
  const resolved = resolveLandProcedure(row);
  if (!resolved) return allowed.includes(LAND_PROCEDURE_ULURP);
  return allowed.includes(resolved);
}

export function landProcedureSodaWhere(procedure = DEFAULT_LAND_PROCEDURE) {
  const values = landProcedureValues(procedure);
  if (values.length === 1) return `ulurp_non='${values[0]}'`;
  return `ulurp_non IN (${values.map((value) => `'${value}'`).join(",")})`;
}

export function landProcedureLabelKey(row = {}) {
  const resolved = resolveLandProcedure(row);
  if (resolved === LAND_PROCEDURE_ELURP) return "land_procedure_elurp";
  if (resolved === LAND_PROCEDURE_NON_ULURP) return "land_procedure_non_ulurp";
  if (resolved === LAND_PROCEDURE_ULURP) return "land_procedure_ulurp";
  return null;
}

function isoDay(value) {
  const matched = cleanLandProcedureValue(value).match(/^(\d{4}-\d{2}-\d{2})/);
  return matched ? matched[1] : null;
}

function observedKind(action = {}) {
  if (action.action_kind) return action.action_kind;
  const eventClass = cleanLandProcedureValue(action.event_class).toLowerCase();
  const title = `${cleanLandProcedureValue(action.milestone_source_title)} ${cleanLandProcedureValue(action.milestone_title)}`.toLowerCase();
  if (/deadline/.test(eventClass) || /comment|review deadline/.test(title)) return "deadline";
  if (/public_hearing|public hearing/.test(eventClass) || /public hearing/.test(title)) return "hearing";
  return null;
}

/**
 * Published hearing / comment dates are observed facts, not statutory projections.
 * Past dates remain visible. Does not invent §197-e windows.
 */
export function landObservedDates(row = {}, actionRows = []) {
  let hearing = isoDay(
    row.hearing_date
    || row.hearing_at
    || row["dcp-dateofpublichearing"]
    || openDataBag(row)["dcp-dateofpublichearing"],
  );
  let comment = isoDay(
    row.comment_deadline
    || row.comment_close
    || row.comment_date
    || openDataBag(row).comment_deadline,
  );
  for (const action of Array.isArray(actionRows) ? actionRows : []) {
    const kind = observedKind(action);
    const actionDay = isoDay(
      action.action_date
      || action.deadline_date
      || action.hearing_date
      || action.hearing_at
      || action.event_date,
    );
    if (!actionDay) continue;
    if (kind === "hearing" && (!hearing || actionDay < hearing)) hearing = actionDay;
    if (kind === "deadline" && (!comment || actionDay < comment)) comment = actionDay;
  }
  return {
    hearing_date: hearing,
    comment_deadline: comment,
  };
}
