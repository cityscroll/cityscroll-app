import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

export const SOURCE_VINTAGE_SCHEMA = "cityscroll.source_vintage_observations.v1";
export const VINTAGE_RETRIEVAL_STATUSES = Object.freeze([
  "unknown",
  "succeeded",
  "failed",
  "partial",
  "held",
]);

const IBO_SOURCE_ID = "ibo-fiscal-history";
const IBO_RECEIPT_SCHEMA = "cityscroll.ibo_fiscal_history_receipt.v1";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function validInstant(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value.trim())) return null;
  const text = value.trim();
  const epoch = Date.parse(
    /T/.test(text) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(text) ? `${text}Z` : text,
  );
  if (!Number.isFinite(epoch) || new Date(epoch).getUTCFullYear() <= 1970) return null;
  return new Date(epoch).toISOString();
}

function validFiscalYear(value) {
  const year = Number(value);
  return Number.isInteger(year) && year >= 1900 && year <= 2200 ? year : null;
}

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function stringOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sortedStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim()))].sort();
}

function newestReceipt(healthObservation) {
  return [...(healthObservation?.operator?.acquisition_receipts || [])]
    .filter((receipt) => validInstant(receipt?.observed_at))
    .sort((left, right) => Date.parse(right.observed_at) - Date.parse(left.observed_at))[0] || null;
}

function unknownRetrieval() {
  return {
    status: "unknown",
    retrieved_at: null,
    receipt_ref: null,
    receipt_schema: null,
    run_id: null,
  };
}

function retrievalFromHealth(healthObservation) {
  const receipt = newestReceipt(healthObservation);
  if (!receipt) return unknownRetrieval();
  return {
    status: VINTAGE_RETRIEVAL_STATUSES.includes(receipt.status) ? receipt.status : "unknown",
    retrieved_at: validInstant(receipt.observed_at),
    receipt_ref: stringOrNull(receipt.receipt_ref || null),
    receipt_schema: stringOrNull(receipt.schema || null),
    run_id: stringOrNull(receipt.run_id || null),
  };
}

function baseObservation(contract) {
  return {
    source_id: contract.id,
    source_family: contract.source_family ? {
      id: stringOrNull(contract.source_family.id),
      component_artifact_ids: sortedStrings(contract.source_family.component_artifact_ids),
    } : null,
    observed_coverage: {
      max_fiscal_year: null,
      max_date: null,
      fiscal_year_count: null,
      row_count: null,
      basis: null,
    },
    publisher_vintage: null,
    publisher_vintage_basis: null,
    publisher_last_updated_at: null,
    publisher_last_update_basis: null,
    cityscroll_retrieval: unknownRetrieval(),
    expected_cadence: stringOrNull(contract.publisher_cadence),
    expected_lag_tolerance_days: finiteNonNegative(contract?.freshness_contract?.max_stale_days),
    current_lag: {
      value: null,
      unit: null,
      basis: null,
    },
    downstream_consumer_ids: sortedStrings(contract.downstream_consumer_ids),
    alternate_source_ids: sortedStrings(contract.alternate_source_ids),
  };
}

function applyHealthObservation(target, healthObservation) {
  const receipt = newestReceipt(healthObservation);
  if (receipt) {
    target.cityscroll_retrieval = retrievalFromHealth(healthObservation);
    target.publisher_last_updated_at = validInstant(receipt.publisher_updated_at);
    target.publisher_last_update_basis = stringOrNull(receipt.publisher_clock_basis);
  }
}

function applyIboReceipt(target, manifest, receipt, root) {
  const fiscalYears = (receipt?.coverage?.fiscal_years || [])
    .map(validFiscalYear)
    .filter((year) => year !== null)
    .sort((left, right) => left - right);
  const workbooks = Array.isArray(manifest?.workbooks) ? manifest.workbooks : [];
  const lastModified = workbooks
    .map((workbook) => validInstant(workbook?.http_last_modified || workbook?.publisher_file_last_modified))
    .filter(Boolean)
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] || null;
  const retrievalAt = validInstant(receipt?.retrieval_timestamp || manifest?.retrieval_timestamp);
  const receiptRef = relative(root, join(root, "warehouse/sources/ibo-fiscal-history/materialized/receipt.json"));

  target.source_family = {
    id: IBO_SOURCE_ID,
    component_artifact_ids: sortedStrings(workbooks.map((workbook) => workbook.id)),
  };
  target.observed_coverage = {
    max_fiscal_year: fiscalYears.at(-1) ?? null,
    max_date: null,
    fiscal_year_count: fiscalYears.length || null,
    row_count: finiteNonNegative(receipt?.coverage?.row_count),
    basis: receipt?.coverage?.fiscal_years ? "ibo_fiscal_history_receipt.coverage.fiscal_years" : null,
  };
  target.publisher_vintage = stringOrNull(receipt?.publisher_vintage || manifest?.publisher_vintage);
  target.publisher_vintage_basis = target.publisher_vintage
    ? "ibo_fiscal_history_source_manifest.publisher_vintage"
    : null;
  target.publisher_last_updated_at = lastModified;
  target.publisher_last_update_basis = lastModified
    ? "workbook http_last_modified (latest retained component)"
    : null;
  target.cityscroll_retrieval = {
    status: receipt?.materialization?.duckdb?.status === "materialized" ? "succeeded" : "unknown",
    retrieved_at: retrievalAt,
    receipt_ref: receipt?.schema === IBO_RECEIPT_SCHEMA ? receiptRef : null,
    receipt_schema: stringOrNull(receipt?.schema),
    run_id: retrievalAt ? `${IBO_SOURCE_ID}:${retrievalAt}` : null,
  };
  target.current_lag = {
    value: null,
    unit: "fiscal_years",
    basis: "not-computed-in-sv-0",
  };
}

function maxDate(values) {
  return values
    .map(validInstant)
    .filter(Boolean)
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] || null;
}

export function loadSourceVintageInputs(root, registry, options = {}) {
  const healthPath = options.healthPath || join(root, "site/data/source_health_observations.json");
  const manifestPath = options.iboManifestPath
    || join(root, "warehouse/sources/ibo-fiscal-history/source_manifest.json");
  const receiptPath = options.iboReceiptPath
    || join(root, "warehouse/sources/ibo-fiscal-history/materialized/receipt.json");
  return {
    healthObservations: options.healthObservations
      || (existsSync(healthPath) ? readJson(healthPath) : null),
    iboManifest: options.iboManifest
      || (existsSync(manifestPath) ? readJson(manifestPath) : null),
    iboReceipt: options.iboReceipt
      || (existsSync(receiptPath) ? readJson(receiptPath) : null),
    asOf: options.asOf || null,
    root,
    registry,
  };
}

export function validateSourceVintageProjection(registry, projection) {
  const errors = [];
  const contracts = Array.isArray(registry?.contracts) ? registry.contracts : [];
  const contractIds = new Set(contracts.map((contract) => contract.id));
  if (projection?.schema !== SOURCE_VINTAGE_SCHEMA) errors.push("schema must be cityscroll.source_vintage_observations.v1");
  if (!validInstant(projection?.generated_at)) errors.push("generated_at must be a valid timestamp");
  if (projection?.contract_count !== contracts.length) errors.push("contract_count must match canonical source contracts");
  const seen = new Set();
  for (const row of projection?.observations || []) {
    const id = row?.source_id || "(missing source_id)";
    if (seen.has(id)) errors.push(`${id}: duplicate source vintage observation`);
    seen.add(id);
    if (!contractIds.has(id)) errors.push(`${id}: source vintage observation has no canonical contract`);
    const coverage = row?.observed_coverage;
    if (!coverage || typeof coverage !== "object" || Array.isArray(coverage)) {
      errors.push(`${id}: observed_coverage must be an object`);
    } else {
      if (coverage.max_fiscal_year !== null && validFiscalYear(coverage.max_fiscal_year) === null) {
        errors.push(`${id}: observed_coverage.max_fiscal_year must be a fiscal year or null`);
      }
      if (coverage.max_date !== null && !validInstant(coverage.max_date)) {
        errors.push(`${id}: observed_coverage.max_date must be a valid timestamp or null`);
      }
      if (coverage.max_fiscal_year !== null && coverage.max_date !== null) {
        errors.push(`${id}: observed coverage must use max_fiscal_year or max_date, not both`);
      }
      if (coverage.fiscal_year_count !== null && finiteNonNegative(coverage.fiscal_year_count) === null) {
        errors.push(`${id}: observed_coverage.fiscal_year_count must be a non-negative number or null`);
      }
      if (coverage.row_count !== null && finiteNonNegative(coverage.row_count) === null) {
        errors.push(`${id}: observed_coverage.row_count must be a non-negative number or null`);
      }
    }
    if (row?.publisher_vintage !== null && typeof row?.publisher_vintage !== "string") {
      errors.push(`${id}: publisher_vintage must be a string or null`);
    }
    if (row?.publisher_vintage_basis !== null && typeof row?.publisher_vintage_basis !== "string") {
      errors.push(`${id}: publisher_vintage_basis must be a string or null`);
    }
    if (row?.publisher_last_updated_at !== null && !validInstant(row.publisher_last_updated_at)) {
      errors.push(`${id}: publisher_last_updated_at must be a valid timestamp or null`);
    }
    if (row?.publisher_last_update_basis !== null && typeof row?.publisher_last_update_basis !== "string") {
      errors.push(`${id}: publisher_last_update_basis must be a string or null`);
    }
    const retrieval = row?.cityscroll_retrieval;
    if (!retrieval || !VINTAGE_RETRIEVAL_STATUSES.includes(retrieval.status)) {
      errors.push(`${id}: cityscroll_retrieval.status must be an allowed status`);
    } else if (retrieval.retrieved_at !== null && !validInstant(retrieval.retrieved_at)) {
      errors.push(`${id}: cityscroll_retrieval.retrieved_at must be a valid timestamp or null`);
    }
    if (row?.expected_cadence !== null && typeof row?.expected_cadence !== "string") {
      errors.push(`${id}: expected_cadence must be a string or null`);
    }
    if (row?.expected_lag_tolerance_days !== null && finiteNonNegative(row.expected_lag_tolerance_days) === null) {
      errors.push(`${id}: expected_lag_tolerance_days must be non-negative or null`);
    }
    if (!row?.current_lag || typeof row.current_lag !== "object") errors.push(`${id}: current_lag must be an object`);
    for (const field of ["downstream_consumer_ids", "alternate_source_ids"]) {
      if (!Array.isArray(row?.[field]) || row[field].some((value) => typeof value !== "string" || !value.trim())) {
        errors.push(`${id}: ${field} must be an array of non-empty strings`);
      }
    }
    if (row?.source_family !== null) {
      if (row.source_family?.id !== id) errors.push(`${id}: source_family.id must match source_id`);
      if (!Array.isArray(row.source_family?.component_artifact_ids)) {
        errors.push(`${id}: source_family.component_artifact_ids must be an array`);
      }
    }
  }
  for (const id of contractIds) if (!seen.has(id)) errors.push(`${id}: missing source vintage observation`);
  return errors.sort();
}

export function buildSourceVintageObservations(registry, inputs = {}) {
  const contracts = [...(registry?.contracts || [])].sort((left, right) => left.id.localeCompare(right.id));
  const healthById = new Map((inputs.healthObservations?.observations || [])
    .map((row) => [row.source_id, row]));
  const rows = contracts.map((contract) => {
    const row = baseObservation(contract);
    applyHealthObservation(row, healthById.get(contract.id));
    if (contract.id === IBO_SOURCE_ID && inputs.iboReceipt) {
      applyIboReceipt(row, inputs.iboManifest, inputs.iboReceipt, inputs.root || process.cwd());
    }
    return row;
  });
  const generatedAt = validInstant(inputs.asOf)
    || maxDate([
      inputs.healthObservations?.generated_at,
      ...rows.map((row) => row.cityscroll_retrieval.retrieved_at),
    ]);
  if (!generatedAt) throw new Error("source vintage projection has no valid evaluation timestamp");
  const projection = {
    schema: SOURCE_VINTAGE_SCHEMA,
    generated_at: generatedAt,
    contract_count: contracts.length,
    observations: rows,
  };
  const errors = validateSourceVintageProjection(registry, projection);
  if (errors.length) throw new Error(errors.join("\n"));
  return projection;
}

export function sourceVintageProjectionText(projection) {
  return `${JSON.stringify(projection, null, 2)}\n`;
}
