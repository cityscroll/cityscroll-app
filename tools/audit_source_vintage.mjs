#!/usr/bin/env node

// Source-vintage proving-case audit. Recomputes a source family's measured
// coverage from the checked-in materialization, classifies retrieval health
// separately from publisher vintage through the SV-1 classifier, resolves the
// newer official context through the SV-2 alternate registry, and locks the
// whole result against a tracked golden receipt. The audit is read-only over
// the observation corpus; only the golden receipt is ever written, and only
// through --write.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadSourceContracts } from "./source_contracts.mjs";
import {
  loadSourceVintageAlternates,
  validateSourceVintageAlternates,
} from "./source_vintage_alternates.mjs";
import { classifySourceVintage } from "./source_vintage_status.mjs";
import { buildSourceVintageObservations } from "./source_vintage_observations.mjs";

export const SOURCE_VINTAGE_AUDIT_SCHEMA = "cityscroll.source_vintage_audit.v1";
export const AUDIT_KIND = "source-vintage-proving-case";
const IBO_RECEIPT_SCHEMA = "cityscroll.ibo_fiscal_history_receipt.v1";
const VINTAGE_LABEL_PATTERN = /^FY(\d{4})$/;

export const ROOT = fileURLToPath(new URL("../", import.meta.url));

function goldenPath(root, sourceId) {
  return join(root, "warehouse/sources", sourceId, "audit", "source_vintage_audit.json");
}

function sourcePaths(root, sourceId) {
  const base = join(root, "warehouse/sources", sourceId);
  return {
    base,
    manifest: join(base, "source_manifest.json"),
    receipt: join(base, "materialized", "receipt.json"),
    observations: join(base, "materialized", "observations.jsonl"),
  };
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

function vintageYear(label) {
  const match = VINTAGE_LABEL_PATTERN.exec(typeof label === "string" ? label.trim() : "");
  return match ? Number(match[1]) : null;
}

function sortedCounts(counts) {
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function measureObservations(observationsText) {
  const years = new Map();
  const workbooks = new Map();
  const malformed = [];
  let rowCount = 0;
  const lines = observationsText.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    rowCount += 1;
    let row = null;
    try {
      row = JSON.parse(line);
    } catch {
      malformed.push(`line ${index + 1}: not valid JSON`);
      continue;
    }
    const year = validFiscalYear(row?.fiscal_year);
    if (year === null) malformed.push(`line ${index + 1}: fiscal_year is not a fiscal year`);
    else years.set(year, (years.get(year) || 0) + 1);
    const workbook = typeof row?.source_workbook_id === "string" ? row.source_workbook_id.trim() : "";
    if (!workbook) malformed.push(`line ${index + 1}: missing source_workbook_id`);
    else workbooks.set(workbook, (workbooks.get(workbook) || 0) + 1);
  }
  const sorted = [...years.keys()].sort((left, right) => left - right);
  const contiguous = sorted.length > 0
    && sorted.every((year, position) => position === 0 || year === sorted[position - 1] + 1);
  return {
    row_count: rowCount,
    fiscal_years: sorted,
    fiscal_year_min: sorted[0] ?? null,
    fiscal_year_max: sorted.at(-1) ?? null,
    fiscal_year_count: sorted.length,
    fiscal_years_contiguous: contiguous,
    row_count_by_workbook: sortedCounts(Object.fromEntries(workbooks)),
    malformed,
  };
}

function sameYearList(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  const normalizedLeft = [...left].map(validFiscalYear).sort((a, b) => a - b);
  const normalizedRight = [...right].map(validFiscalYear).sort((a, b) => a - b);
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((year, index) => year === normalizedRight[index])
    && normalizedLeft.every((year) => year !== null);
}

export function auditSourceVintage({
  sourceId,
  root = ROOT,
  inputs = {},
} = {}) {
  const findings = [];
  const paths = sourcePaths(root, sourceId);

  if (!existsSync(paths.base)) {
    return { findings: ["source-family-missing"], receipt: null, measured: null };
  }

  const readJson = (path, missingCode, malformedCode) => {
    if (!existsSync(path)) {
      findings.push(missingCode);
      return null;
    }
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      findings.push(malformedCode);
      return null;
    }
  };
  const manifest = inputs.manifest !== undefined
    ? inputs.manifest
    : readJson(paths.manifest, "manifest-missing", "manifest-malformed");
  const receipt = inputs.receipt !== undefined
    ? inputs.receipt
    : readJson(paths.receipt, "receipt-missing", "receipt-malformed");
  let observationsText = null;
  if (inputs.observationsText !== undefined) {
    observationsText = inputs.observationsText;
  } else if (!existsSync(paths.observations)) {
    findings.push("observations-missing");
  } else {
    observationsText = readFileSync(paths.observations, "utf8");
  }

  if (!manifest || !receipt || observationsText === null) {
    return { findings, receipt: null, measured: null };
  }
  if (receipt.schema !== IBO_RECEIPT_SCHEMA) {
    findings.push("unsupported-source-family");
    return { findings, receipt: null, measured: null };
  }

  const manifestWorkbooks = Array.isArray(manifest?.workbooks) ? manifest.workbooks : [];
  const workbookIds = manifestWorkbooks
    .map((workbook) => typeof workbook?.id === "string" ? workbook.id.trim() : "")
    .filter(Boolean);
  if (!manifest?.publisher || !manifest?.source_page_url || !manifestWorkbooks.length
    || workbookIds.length !== manifestWorkbooks.length) {
    findings.push("source-identity-missing");
  }

  // Measured coverage is recomputed from the observation corpus, never copied
  // from the receipt or the card.
  const measured = measureObservations(observationsText);
  if (measured.malformed.length) {
    findings.push("observations-malformed");
  }
  if (measured.row_count === 0) {
    findings.push("observations-empty");
  }

  const receiptCoverage = receipt?.coverage || {};
  if (receiptCoverage.row_count !== measured.row_count) {
    findings.push("row-count-drift");
  }
  if (!sameYearList(receiptCoverage.fiscal_years, measured.fiscal_years)) {
    findings.push("fiscal-year-drift");
  }
  const receiptWorkbookCounts = receiptCoverage.row_count_by_workbook;
  const measuredWorkbookCounts = measured.row_count_by_workbook;
  const workbookKeys = new Set([
    ...Object.keys(receiptWorkbookCounts || {}),
    ...Object.keys(measuredWorkbookCounts),
  ]);
  if (![...workbookKeys].every((key) => (receiptWorkbookCounts || {})[key] === measuredWorkbookCounts[key])) {
    findings.push("workbook-row-count-drift");
  }

  // Retrieval health, measured separately from publisher vintage.
  const manifestRetrievalAt = validInstant(manifest?.retrieval_timestamp);
  const receiptRetrievalAt = validInstant(receipt?.retrieval_timestamp);
  if (!manifestRetrievalAt || !receiptRetrievalAt) findings.push("retrieval-timestamp-missing");
  else if (manifestRetrievalAt !== receiptRetrievalAt) findings.push("retrieval-timestamp-disagreement");
  if (receipt?.materialization?.duckdb?.status !== "materialized") findings.push("retrieval-not-materialized");

  // Publisher vintage must agree across manifest and receipt and must match the
  // measured year frontier; a healthy retrieval is never evidence of coverage.
  const manifestVintage = typeof manifest?.publisher_vintage === "string" ? manifest.publisher_vintage.trim() : "";
  const receiptVintage = typeof receipt?.publisher_vintage === "string" ? receipt.publisher_vintage.trim() : "";
  if (!manifestVintage || !receiptVintage) findings.push("publisher-vintage-missing");
  else if (manifestVintage !== receiptVintage) findings.push("publisher-vintage-mismatch");
  const vintageFiscalYear = vintageYear(receiptVintage || manifestVintage);
  if (vintageFiscalYear === null) findings.push("publisher-vintage-unparseable");
  else if (measured.fiscal_year_max !== null && measured.fiscal_year_max !== vintageFiscalYear) {
    findings.push("publisher-vintage-frontier-mismatch");
  }

  // Checkpoint integrity: the receipt must still vouch for the manifest bytes.
  const workbookHashes = receipt?.generated_from?.source_hashes || {};
  for (const workbook of manifestWorkbooks) {
    if (workbook?.id && workbookHashes[workbook.id] !== workbook.sha256) {
      findings.push("source-hash-mismatch");
    }
  }

  // Boundary: the audit never extends the series. Any observation beyond the
  // publisher vintage year is an attempted cross-series extension.
  if (vintageFiscalYear !== null && measured.fiscal_years.some((year) => year > vintageFiscalYear)) {
    findings.push("cross-series-extension");
  }

  // Canonical contract and the SV-2 alternate registry.
  const contracts = inputs.contracts !== undefined ? inputs.contracts : loadSourceContracts();
  const contract = (contracts?.contracts || []).find((row) => row.id === sourceId) || null;
  if (!contract) findings.push("source-contract-missing");

  let newerContext = [];
  const alternates = inputs.alternates !== undefined
    ? inputs.alternates
    : (existsSync(join(root, "site/data/source_vintage_alternates.json"))
      ? loadSourceVintageAlternates()
      : null);
  if (!alternates) {
    findings.push("alternate-registry-missing");
  } else if (contract) {
    const registryErrors = validateSourceVintageAlternates(alternates, contracts);
    if (registryErrors.length) findings.push("alternate-registry-invalid");
    const records = Array.isArray(alternates?.alternates) ? alternates.alternates : [];
    const byId = new Map(records.map((row) => [row?.alternate_id, row]));
    const declared = Array.isArray(contract.alternate_source_ids) ? contract.alternate_source_ids : [];
    if (declared.length === 0) findings.push("alternate-missing");
    const newer = [];
    for (const id of declared) {
      const alternate = byId.get(id);
      if (!alternate) {
        findings.push("alternate-missing");
        continue;
      }
      if (alternate.verification_state !== "verified") findings.push("alternate-unverified");
      const alternateFrontier = validFiscalYear(alternate?.observed_coverage?.max_fiscal_year);
      if (alternateFrontier === null
        || measured.fiscal_year_max === null
        || alternateFrontier <= measured.fiscal_year_max) {
        findings.push("alternate-not-newer");
      } else {
        newer.push(auditAlternateSummary(alternate));
      }
    }
    newerContext = newer;
  }

  // Classification through the canonical SV-0 observation derivation and the
  // SV-1 classifier, computed from the audited evidence itself.
  let classification = null;
  if (contract && alternates) {
    const healthObservations = inputs.healthObservations !== undefined
      ? inputs.healthObservations
      : (existsSync(join(root, "site/data/source_health_observations.json"))
        ? JSON.parse(readFileSync(join(root, "site/data/source_health_observations.json"), "utf8"))
        : { observations: [], generated_at: null });
    const projection = buildSourceVintageObservations(contracts, {
      iboManifest: manifest,
      iboReceipt: receipt,
      healthObservations,
      root,
    });
    const observationRow = projection.observations.find((row) => row.source_id === sourceId) || null;
    if (!observationRow) {
      findings.push("source-contract-missing");
    } else {
      const healthRow = (healthObservations?.observations || [])
        .find((row) => row.source_id === sourceId) || null;
      classification = classifySourceVintage({
        contract,
        source: observationRow,
        healthObservation: healthRow,
        alternateRegistry: alternates,
        asOf: null,
      });
      if (classification.ingestion_stale) findings.push("ingestion-failure-classified");

      // The resident SV-0 projection must agree with the audited evidence.
      const trackedProjection = inputs.trackedProjection !== undefined
        ? inputs.trackedProjection
        : (existsSync(join(root, "site/data/source_vintage_observations.json"))
          ? JSON.parse(readFileSync(join(root, "site/data/source_vintage_observations.json"), "utf8"))
          : null);
      const trackedRow = (trackedProjection?.observations || [])
        .find((row) => row.source_id === sourceId) || null;
      if (!trackedRow) {
        findings.push("projection-drift");
      } else {
        const trackedRetrievalAt = validInstant(trackedRow?.cityscroll_retrieval?.retrieved_at);
        const drifts = [
          trackedRow?.observed_coverage?.max_fiscal_year !== measured.fiscal_year_max,
          trackedRow?.observed_coverage?.fiscal_year_count !== measured.fiscal_year_count,
          trackedRow?.observed_coverage?.row_count !== measured.row_count,
          (trackedRow?.publisher_vintage || null) !== (receiptVintage || null),
          trackedRetrievalAt !== receiptRetrievalAt,
        ];
        if (drifts.some(Boolean)) findings.push("projection-drift");
      }
    }
  }

  const receiptOut = {
    schema: SOURCE_VINTAGE_AUDIT_SCHEMA,
    audit_kind: AUDIT_KIND,
    source_id: sourceId,
    source_identity: {
      publisher: typeof manifest?.publisher === "string" ? manifest.publisher.trim() || null : null,
      source_page_url: typeof manifest?.source_page_url === "string"
        ? manifest.source_page_url.trim() || null
        : null,
      workbook_ids: workbookIds,
    },
    materialization_health: {
      ingestion_stale: classification ? classification.ingestion_stale : null,
      retrieval: {
        status: receipt?.materialization?.duckdb?.status === "materialized" ? "succeeded" : "not-materialized",
        retrieved_at: receiptRetrievalAt,
      },
      measured_coverage: {
        row_count: measured.row_count,
        fiscal_year_min: measured.fiscal_year_min,
        fiscal_year_max: measured.fiscal_year_max,
        fiscal_year_count: measured.fiscal_year_count,
        fiscal_years_contiguous: measured.fiscal_years_contiguous,
        row_count_by_workbook: measured.row_count_by_workbook,
      },
    },
    publisher_vintage: {
      label: receiptVintage || null,
      fiscal_year: vintageFiscalYear,
      basis: "warehouse/sources/ibo-fiscal-history/source_manifest.json publisher_vintage, agreed by the materialized receipt",
    },
    classification,
    newer_context_alternates: newerContext || [],
    boundary: {
      observations_beyond_publisher_vintage: vintageFiscalYear === null
        ? null
        : measured.fiscal_years.filter((year) => year > vintageFiscalYear).length,
      series_extension: "out-of-scope-follow-on",
    },
  };

  return { findings: [...new Set(findings)].sort(), receipt: receiptOut, measured };
}

export function auditAlternateSummary(alternate) {
  return {
    alternate_source_id: alternate.alternate_id,
    relation: alternate.relation,
    replacement_eligible: alternate.replacement_eligible === true,
    publisher: alternate.publisher,
    index_url: alternate.url || null,
    artifact_url: alternate.artifact_url || null,
    observed_coverage: {
      max_fiscal_year: validFiscalYear(alternate?.observed_coverage?.max_fiscal_year),
      basis: alternate?.observed_coverage?.basis || null,
    },
    publisher_vintage: alternate.publisher_vintage || null,
    evidence_at: validInstant(alternate.evidence_at),
    evidence_basis: alternate.evidence_basis || null,
    verification_state: alternate.verification_state || null,
  };
}

export function auditReceiptText(receipt) {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

export function goldenReceiptText(root, sourceId) {
  const path = goldenPath(root, sourceId);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function main(argv = process.argv.slice(2)) {
  const flags = new Set(["--write", "--json"]);
  let sourceId = null;
  const unexpected = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--source") {
      sourceId = argv[index + 1] || null;
      index += 1;
    } else if (flags.has(arg)) {
      // consumed below
    } else {
      unexpected.push(arg);
    }
  }
  const write = argv.includes("--write");
  const json = argv.includes("--json");
  if (!sourceId || unexpected.length) {
    console.error("usage: node tools/audit_source_vintage.mjs --source <source-id> [--write] [--json]");
    process.exitCode = 1;
    return;
  }

  const { findings, receipt } = auditSourceVintage({ sourceId });
  const allFindings = [...findings];
  if (!write && !findings.length && receipt) {
    const golden = goldenReceiptText(ROOT, sourceId);
    if (golden === null) allFindings.push("golden-receipt-missing");
    else if (golden !== auditReceiptText(receipt)) allFindings.push("golden-receipt-drift");
  }

  if (json && receipt) console.log(auditReceiptText(receipt).trimEnd());
  if (allFindings.length) {
    for (const finding of allFindings) console.error(`source vintage audit ${sourceId}: ${finding}`);
    process.exitCode = 1;
    return;
  }
  if (write) {
    mkdirSync(dirname(goldenPath(ROOT, sourceId)), { recursive: true });
    writeFileSync(goldenPath(ROOT, sourceId), auditReceiptText(receipt));
    console.log(`wrote ${goldenPath(ROOT, sourceId)}`);
    return;
  }
  const coverage = receipt.materialization_health.measured_coverage;
  const vintage = receipt.publisher_vintage.label;
  const status = receipt.classification.status;
  console.log(
    `source vintage audit ${sourceId}: retrieval ${receipt.materialization_health.retrieval.status} at ${receipt.materialization_health.retrieval.retrieved_at}; publisher coverage through ${vintage} (${coverage.fiscal_year_count} fiscal years ${coverage.fiscal_year_min}-${coverage.fiscal_year_max}, ${coverage.row_count} rows); classification ${status} with ingestion_stale=${receipt.classification.ingestion_stale}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error?.stack || error);
    process.exitCode = 1;
  }
}
