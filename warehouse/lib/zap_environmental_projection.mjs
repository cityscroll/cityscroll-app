/**
 * Cutoff-aware environmental/CEQR projection over retained ZAP Open Data rows.
 *
 * Source fields are the published hgx4-8ukb columns. Missing facts stay explicit
 * absences. Titles, action codes, addresses, applicant names, and land-use
 * milestones never fill a CEQR or environmental value.
 */

export const ZAP_ENVIRONMENTAL_PROJECTION_SCHEMA =
  "cityscroll.zap_environmental_projection.v1";
export const ZAP_ENVIRONMENTAL_DATASET_ID = "hgx4-8ukb";

/** Publisher columns selected from ZAP Open Data / warehouse for this projection. */
export const ZAP_ENVIRONMENTAL_SOURCE_COLS = Object.freeze([
  "ceqr_number",
  "ceqr_type",
  "ceqr_leadagency",
  "eas_eis",
  "current_envmilestone",
  "current_envmilestone_date",
]);

/**
 * Product field → publisher column. `environmental_status` has no ZAP column;
 * the projection records that gap instead of parsing milestone text.
 */
export const ZAP_ENVIRONMENTAL_FIELD_MAP = Object.freeze({
  ceqr_number: "ceqr_number",
  ceqr_type: "ceqr_type",
  ceqr_lead_agency: "ceqr_leadagency",
  environmental_review_type: "eas_eis",
  environmental_status: null,
  environmental_milestone: "current_envmilestone",
  environmental_milestone_date: "current_envmilestone_date",
});

export const ZAP_ENVIRONMENTAL_PRODUCT_FIELDS = Object.freeze(
  Object.keys(ZAP_ENVIRONMENTAL_FIELD_MAP),
);

export const ZAP_ENVIRONMENTAL_STATUS_GAP =
  "zap_projects_hgx4-8ukb_has_no_environmental_status_column";

const CEQR_ID = /^(?:\d{2}[A-Z]{2,6}\d{2,4}[A-Z]|\d{2}-\d{3}[A-Z])$/i;
const EMPTY_TOKENS = new Set([
  "n/a",
  "na",
  "none",
  "null",
  "unknown",
  "tbd",
  "pending",
  "not applicable",
]);

export function cleanZapSourceCell(value) {
  if (value == null) return null;
  if (typeof value === "boolean") return value ? "true" : "false";
  const text = String(value).replace(/\s+/g, " ").trim();
  return text || null;
}

function parseClock(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.getTime();
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function afterCutoff(value, cutoffMs) {
  if (cutoffMs == null) return false;
  const ms = parseClock(value);
  return ms != null && ms > cutoffMs;
}

function splitIdentifiers(value) {
  return String(value)
    .split(/[;,/|]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function titleHoldsCeqrToken(row) {
  const haystack = [row?.project_name, row?.project_brief]
    .map((part) => String(part || ""))
    .join(" ");
  if (!haystack) return false;
  const tokens = haystack.match(/\b\d{2}[A-Z]{2,6}\d{2,4}[A-Z]\b|\b\d{2}-\d{3}[A-Z]\b/gi) || [];
  return tokens.some((token) => CEQR_ID.test(token));
}

function fieldResult({
  value = null,
  presence,
  sourceField,
  gap = null,
  raw = null,
}) {
  const out = {
    value: presence === "present" ? value : null,
    presence,
    source_field: sourceField,
  };
  if (gap) out.gap = gap;
  if (raw != null && presence !== "present") out.raw = raw;
  return out;
}

function projectCeqrNumber(raw, row, ctx) {
  const sourceField = "ceqr_number";
  if (ctx.observedStale) {
    return fieldResult({ presence: "stale", sourceField, raw });
  }
  if (raw == null) {
    if (titleHoldsCeqrToken(row)) {
      return fieldResult({ presence: "title_only", sourceField });
    }
    return fieldResult({ presence: "absent", sourceField });
  }
  const parts = splitIdentifiers(raw);
  const valid = [...new Set(parts.filter((part) => CEQR_ID.test(part)))];
  if (valid.length > 1) {
    return fieldResult({ presence: "conflicting", sourceField, raw });
  }
  if (valid.length === 1 && parts.length === 1) {
    return fieldResult({
      value: valid[0].toUpperCase(),
      presence: "present",
      sourceField,
    });
  }
  return fieldResult({ presence: "malformed", sourceField, raw });
}

function projectExactText(raw, sourceField, ctx, { dateField = false } = {}) {
  if (ctx.observedStale) {
    return fieldResult({ presence: "stale", sourceField, raw });
  }
  if (raw == null) {
    return fieldResult({ presence: "absent", sourceField });
  }
  if (EMPTY_TOKENS.has(raw.toLowerCase()) && sourceField !== "ceqr_type") {
    return fieldResult({ presence: "malformed", sourceField, raw });
  }
  if (dateField) {
    if (!/^\d{4}-\d{2}-\d{2}/.test(raw) || parseClock(raw) == null) {
      return fieldResult({ presence: "malformed", sourceField, raw });
    }
    if (afterCutoff(raw, ctx.cutoffMs)) {
      return fieldResult({ presence: "stale", sourceField, raw });
    }
  }
  return fieldResult({
    value: raw,
    presence: "present",
    sourceField,
  });
}

/**
 * Project environmental/CEQR facts from one retained ZAP source row.
 * @param {object} row
 * @param {{ asOf?: string, cutoff?: string, observedAt?: string, datasetId?: string }} [opts]
 */
export function projectZapEnvironmentalFields(row = {}, opts = {}) {
  const datasetId = opts.datasetId || ZAP_ENVIRONMENTAL_DATASET_ID;
  const sourceRecordId = cleanZapSourceCell(row.project_id);
  const asOf = opts.asOf || opts.now || null;
  const cutoff = opts.cutoff || asOf || null;
  const cutoffMs = parseClock(cutoff);
  const observedAt = opts.observedAt || row.observed_at || row.source_vintage || null;
  const observedStale = afterCutoff(observedAt, cutoffMs);
  const ctx = {
    datasetId,
    sourceRecordId,
    asOf,
    cutoff,
    cutoffMs,
    observedStale,
  };

  const fields = {
    ceqr_number: projectCeqrNumber(cleanZapSourceCell(row.ceqr_number), row, ctx),
    ceqr_type: projectExactText(cleanZapSourceCell(row.ceqr_type), "ceqr_type", ctx),
    ceqr_lead_agency: projectExactText(
      cleanZapSourceCell(row.ceqr_leadagency ?? row.ceqr_lead_agency),
      "ceqr_leadagency",
      ctx,
    ),
    environmental_review_type: projectExactText(
      cleanZapSourceCell(row.eas_eis),
      "eas_eis",
      ctx,
    ),
    environmental_status: fieldResult({
      presence: "source_field_absent",
      sourceField: null,
      gap: ZAP_ENVIRONMENTAL_STATUS_GAP,
    }),
    environmental_milestone: projectExactText(
      cleanZapSourceCell(row.current_envmilestone),
      "current_envmilestone",
      ctx,
    ),
    environmental_milestone_date: projectExactText(
      cleanZapSourceCell(row.current_envmilestone_date),
      "current_envmilestone_date",
      ctx,
      { dateField: true },
    ),
  };

  return {
    schema: ZAP_ENVIRONMENTAL_PROJECTION_SCHEMA,
    source_dataset_id: datasetId,
    source_record_id: sourceRecordId,
    as_of: asOf,
    cutoff,
    fields,
  };
}

export function overlayZapEnvironmentalSourceFields(row, source = {}) {
  if (!row || typeof row !== "object") return row;
  const out = { ...row };
  for (const col of ZAP_ENVIRONMENTAL_SOURCE_COLS) {
    if (Object.prototype.hasOwnProperty.call(source, col)) {
      const value = cleanZapSourceCell(source[col]);
      out[col] = value;
    } else if (!Object.prototype.hasOwnProperty.call(out, col)) {
      out[col] = null;
    }
  }
  return out;
}

/**
 * Stamp product aliases + provenance envelope onto a SODA-shaped ZAP row.
 * Existing identity, action, date, and geography keys are left unchanged.
 */
export function stampZapEnvironmentalProjection(row, opts = {}) {
  if (!row || typeof row !== "object") return row;
  for (const col of ZAP_ENVIRONMENTAL_SOURCE_COLS) {
    if (!Object.prototype.hasOwnProperty.call(row, col)) row[col] = null;
    else row[col] = cleanZapSourceCell(row[col]);
  }
  const projection = projectZapEnvironmentalFields(row, opts);
  row.ceqr_number = projection.fields.ceqr_number.value;
  row.ceqr_type = projection.fields.ceqr_type.value;
  row.ceqr_lead_agency = projection.fields.ceqr_lead_agency.value;
  row.environmental_review_type = projection.fields.environmental_review_type.value;
  row.environmental_status = projection.fields.environmental_status.value;
  row.environmental_milestone = projection.fields.environmental_milestone.value;
  row.environmental_milestone_date = projection.fields.environmental_milestone_date.value;
  row.environmental_projection = projection;
  return row;
}

export function summarizeZapEnvironmentalProjection(rows = []) {
  const counts = {
    row_count: rows.length,
    ceqr_number_present: 0,
    ceqr_type_present: 0,
    ceqr_lead_agency_present: 0,
    environmental_review_type_present: 0,
    environmental_milestone_present: 0,
    environmental_milestone_date_present: 0,
    ceqr_number_absent: 0,
    environmental_status_source_field_absent: 0,
  };
  for (const row of rows) {
    const fields = row?.environmental_projection?.fields || {};
    if (fields.ceqr_number?.presence === "present") counts.ceqr_number_present += 1;
    else counts.ceqr_number_absent += 1;
    if (fields.ceqr_type?.presence === "present") counts.ceqr_type_present += 1;
    if (fields.ceqr_lead_agency?.presence === "present") counts.ceqr_lead_agency_present += 1;
    if (fields.environmental_review_type?.presence === "present") {
      counts.environmental_review_type_present += 1;
    }
    if (fields.environmental_milestone?.presence === "present") {
      counts.environmental_milestone_present += 1;
    }
    if (fields.environmental_milestone_date?.presence === "present") {
      counts.environmental_milestone_date_present += 1;
    }
    if (fields.environmental_status?.presence === "source_field_absent") {
      counts.environmental_status_source_field_absent += 1;
    }
  }
  return {
    schema: ZAP_ENVIRONMENTAL_PROJECTION_SCHEMA,
    source_dataset_id: ZAP_ENVIRONMENTAL_DATASET_ID,
    unsupported_fields: [
      {
        field: "environmental_status",
        gap: ZAP_ENVIRONMENTAL_STATUS_GAP,
        note: "ZAP Open Data publishes CEQR type, EAS/EIS document flag, and the current environmental milestone; it does not publish a separate environmental-status column.",
      },
    ],
    counts,
  };
}

export function zapEnvironmentalProjectionFindings(doc = {}) {
  const findings = [];
  const rows = Array.isArray(doc.rows) ? doc.rows : [];
  if (!rows.length) findings.push("zap_environmental_projection: no rows");
  for (const row of rows) {
    const id = row?.project_id || "(missing project_id)";
    const projection = row?.environmental_projection;
    if (!projection || projection.schema !== ZAP_ENVIRONMENTAL_PROJECTION_SCHEMA) {
      findings.push(`${id}: missing environmental_projection envelope`);
      continue;
    }
    if (projection.source_dataset_id !== ZAP_ENVIRONMENTAL_DATASET_ID) {
      findings.push(`${id}: environmental_projection dataset is not hgx4-8ukb`);
    }
    if (projection.source_record_id !== row.project_id) {
      findings.push(`${id}: environmental_projection source_record_id mismatch`);
    }
    for (const field of ZAP_ENVIRONMENTAL_PRODUCT_FIELDS) {
      const cell = projection.fields?.[field];
      if (!cell || typeof cell !== "object") {
        findings.push(`${id}: missing environmental field ${field}`);
        continue;
      }
      if (cell.presence === "present" && (cell.value == null || cell.value === "")) {
        findings.push(`${id}: ${field} marked present without a value`);
      }
      if (cell.presence !== "present" && cell.value != null) {
        findings.push(`${id}: ${field} kept a value despite ${cell.presence}`);
      }
      if (field === "environmental_status" && cell.presence !== "source_field_absent") {
        findings.push(`${id}: environmental_status must stay source_field_absent`);
      }
    }
    const actions = String(row.actions || "");
    if (
      /\bEAS\b/i.test(actions)
      && row.eas_eis == null
      && row.environmental_review_type != null
    ) {
      findings.push(`${id}: inferred environmental_review_type from actions`);
    }
  }
  return findings;
}
