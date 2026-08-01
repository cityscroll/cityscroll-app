// Deterministic, inclusion-probability-aware sampling of resolved entities.

import { createHash } from "node:crypto";

export const ENTITY_AUDIT_SCHEMA_VERSION = 1;
export const ENTITY_AUDIT_STRATA = Object.freeze([
  "false_split",
  "large_cluster",
  "singleton",
  "low_confidence",
  "authority_key",
  "other_cluster",
]);

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const sha256 = (value) => createHash("sha256").update(String(value)).digest("hex");

function validatePopulation(population) {
  if (!Array.isArray(population)) throw new Error("audit_population must be an array");
  const ids = new Set();
  for (const [index, entity] of population.entries()) {
    if (!clean(entity?.audit_id)) throw new Error(`audit_population[${index}] requires audit_id`);
    if (ids.has(entity.audit_id)) throw new Error(`duplicate audit_id ${entity.audit_id}`);
    ids.add(entity.audit_id);
    if (!Number.isInteger(entity.record_count) || entity.record_count < 1) {
      throw new Error(`${entity.audit_id} requires a positive integer record_count`);
    }
  }
}

export function entityAuditStratum(entity, opts = {}) {
  const largeClusterMin = Number(opts.largeClusterMin ?? 4);
  const lowConfidenceMin = Number(opts.lowConfidenceMin ?? 0.6);
  if (entity.false_split_callout) return "false_split";
  if (entity.record_count >= largeClusterMin) return "large_cluster";
  if (entity.record_count === 1) return "singleton";
  if (Number(entity.max_boundary_unresolved_confidence) >= lowConfidenceMin) return "low_confidence";
  if (entity.authority_key_case) return "authority_key";
  return "other_cluster";
}

function allocateSample(strata, sampleSize) {
  const allocation = Object.fromEntries(ENTITY_AUDIT_STRATA.map((stratum) => [stratum, 0]));
  let remaining = Math.min(sampleSize, [...strata.values()].reduce((sum, rows) => sum + rows.length, 0));

  // Breadth first: every non-empty named stratum gets a review before controls fill.
  for (const stratum of ENTITY_AUDIT_STRATA) {
    if (remaining === 0) break;
    if ((strata.get(stratum)?.length || 0) === 0) continue;
    allocation[stratum] += 1;
    remaining -= 1;
  }

  // Depth second: fragmented entities receive three turns per control turn.
  const weightedOrder = [
    "false_split", "false_split", "false_split",
    "large_cluster", "singleton", "low_confidence", "authority_key", "other_cluster",
  ];
  while (remaining > 0) {
    let added = false;
    for (const stratum of weightedOrder) {
      if (remaining === 0) break;
      const eligible = strata.get(stratum)?.length || 0;
      if (allocation[stratum] >= eligible) continue;
      allocation[stratum] += 1;
      remaining -= 1;
      added = true;
    }
    if (!added) break;
  }
  return allocation;
}

/** Select entities without replacement and retain each unit's first-order probability. */
export function buildEntityAuditSample(population, opts = {}) {
  validatePopulation(population);
  const sampleSize = Number(opts.sampleSize ?? 30);
  const seed = clean(opts.seed || "entity-audit-v1");
  if (!Number.isInteger(sampleSize) || sampleSize < 1) throw new Error("sampleSize must be a positive integer");
  if (!seed) throw new Error("seed is required");

  const parameters = {
    sample_size: sampleSize,
    seed,
    large_cluster_min: Number(opts.largeClusterMin ?? 4),
    low_confidence_min: Number(opts.lowConfidenceMin ?? 0.6),
    sampling_unit: "whole_entity",
  };
  const strata = new Map(ENTITY_AUDIT_STRATA.map((stratum) => [stratum, []]));
  for (const entity of population) {
    const stratum = entityAuditStratum(entity, {
      largeClusterMin: parameters.large_cluster_min,
      lowConfidenceMin: parameters.low_confidence_min,
    });
    strata.get(stratum).push(entity);
  }
  for (const [stratum, entities] of strata) {
    entities.sort((left, right) => (
      sha256(`${seed}\0${stratum}\0${left.audit_id}`).localeCompare(
        sha256(`${seed}\0${stratum}\0${right.audit_id}`),
      ) || left.audit_id.localeCompare(right.audit_id)
    ));
  }
  const allocation = allocateSample(strata, sampleSize);
  const sample = [];
  const composition = {};
  for (const stratum of ENTITY_AUDIT_STRATA) {
    const eligible = strata.get(stratum).length;
    const sampled = allocation[stratum];
    const probability = eligible === 0 ? 0 : sampled / eligible;
    composition[stratum] = { eligible, sampled, inclusion_probability: probability };
    sample.push(...strata.get(stratum).slice(0, sampled).map((entity) => ({
      ...entity,
      stratum,
      stratum_eligible: eligible,
      stratum_sampled: sampled,
      inclusion_probability: probability,
      base_weight: 1 / probability,
      judgment: "",
      reviewer: "",
      reviewed_at: "",
      notes: "",
    })));
  }
  return {
    sample,
    receipt: {
      kind: "entity_centric_audit_receipt",
      schema_version: ENTITY_AUDIT_SCHEMA_VERSION,
      primary_signal: "false_split",
      population_size: population.length,
      sample_size: sample.length,
      parameters,
      strata: composition,
      selection: "seeded_sha256_rank_without_replacement",
      sample_sha256: sha256(JSON.stringify(sample)),
    },
  };
}

const LABEL_COLUMNS = [
  "audit_id", "stratum", "stratum_eligible", "stratum_sampled",
  "inclusion_probability", "base_weight", "unit_kind",
  "corpus", "entity_type", "component_id", "record_count", "source_count",
  "false_split_callout", "over_merge_callout", "authority_key_case", "min_link_confidence",
  "max_boundary_unresolved_confidence", "judgment", "reviewer", "reviewed_at", "notes",
];

function csvValue(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function formatEntityAuditLabelSheet(sample = []) {
  const lines = [LABEL_COLUMNS.join(",")];
  for (const item of sample) {
    lines.push(LABEL_COLUMNS.map((column) => csvValue(item[column])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

/** Minimal RFC 4180 parser for the generated label sheet. */
export function parseEntityAuditLabelSheet(text) {
  const table = [];
  let row = [];
  let field = "";
  let quoted = false;
  const input = String(text || "");
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      table.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  if (quoted) throw new Error("label sheet has an unterminated quoted field");
  if (field || row.length) table.push([...row, field.replace(/\r$/, "")]);
  const [header, ...body] = table.filter((cells) => cells.some(Boolean));
  if (!header) throw new Error("label sheet is empty");
  for (const required of LABEL_COLUMNS) {
    if (!header.includes(required)) throw new Error(`label sheet missing column ${required}`);
  }
  return body.map((cells, index) => {
    if (cells.length !== header.length) {
      throw new Error(`label sheet row ${index + 2} has ${cells.length} columns; expected ${header.length}`);
    }
    return Object.fromEntries(header.map((column, columnIndex) => [column, cells[columnIndex]]));
  });
}

/** Hájek weighted error rates; small reviewed strata are reported as insufficient. */
export function summarizeEntityAuditRates(labelSheetText, opts = {}) {
  const minReviewedPerStratum = Number(opts.minReviewedPerStratum ?? 2);
  const allowed = new Set(["correct", "false_split", "false_merge", "both", "uncertain"]);
  const rows = parseEntityAuditLabelSheet(labelSheetText);
  const reviewed = rows.filter((row) => clean(row.judgment));
  for (const row of reviewed) {
    if (!allowed.has(row.judgment)) throw new Error(`audit ${row.audit_id} has invalid judgment ${row.judgment}`);
    if (!clean(row.reviewer) || !clean(row.reviewed_at)) {
      throw new Error(`audit ${row.audit_id} requires reviewer and reviewed_at`);
    }
    const probability = Number(row.inclusion_probability);
    if (!(probability > 0 && probability <= 1)) throw new Error(`audit ${row.audit_id} has invalid inclusion_probability`);
  }
  const ratesByStratum = {};
  for (const stratum of ENTITY_AUDIT_STRATA) {
    const sampledRows = rows.filter((row) => row.stratum === stratum);
    const stratumRows = reviewed.filter((row) => row.stratum === stratum && row.judgment !== "uncertain");
    const eligible = Number(sampledRows[0]?.stratum_eligible || 0);
    const censusReviewed = eligible > 0 && stratumRows.length === eligible;
    const sufficient = stratumRows.length >= minReviewedPerStratum || censusReviewed;
    const weight = (row) => 1 / Number(row.inclusion_probability);
    const denominator = stratumRows.reduce((sum, row) => sum + weight(row), 0);
    const rate = (kind) => sufficient
      ? stratumRows.reduce((sum, row) => sum + (
        [kind, "both"].includes(row.judgment) ? weight(row) : 0
      ), 0) / denominator
      : null;
    ratesByStratum[stratum] = {
      status: sufficient ? "sufficient" : "insufficient",
      eligible,
      sampled: Number(sampledRows[0]?.stratum_sampled || 0),
      reviewed: stratumRows.length,
      minimum_reviewed: minReviewedPerStratum,
      false_split_rate: rate("false_split"),
      false_merge_rate: rate("false_merge"),
    };
  }
  const usable = reviewed.filter((row) => row.judgment !== "uncertain");
  const allSufficient = ENTITY_AUDIT_STRATA
    .filter((stratum) => rows.some((row) => row.stratum === stratum))
    .every((stratum) => ratesByStratum[stratum].status === "sufficient");
  const totalWeight = usable.reduce((sum, row) => sum + (1 / Number(row.inclusion_probability)), 0);
  const overallRate = (kind) => allSufficient && totalWeight > 0
    ? usable.reduce((sum, row) => sum + (
      [kind, "both"].includes(row.judgment) ? 1 / Number(row.inclusion_probability) : 0
    ), 0) / totalWeight
    : null;
  return {
    kind: "entity_centric_audit_rates",
    schema_version: ENTITY_AUDIT_SCHEMA_VERSION,
    status: allSufficient ? "sufficient" : "insufficient",
    reviewed: reviewed.length,
    false_split_rate: overallRate("false_split"),
    false_merge_rate: overallRate("false_merge"),
    strata: ratesByStratum,
  };
}

export function formatEntityAuditJsonl(sample = [], receipt = {}) {
  const meta = {
    _meta: true,
    kind: "entity_centric_audit_sample",
    schema_version: ENTITY_AUDIT_SCHEMA_VERSION,
    observed_on: receipt.observed_on,
    case_count: sample.length,
    sample_sha256: receipt.sample_sha256,
  };
  return `${[meta, ...sample].map((item) => JSON.stringify(item)).join("\n")}\n`;
}
