/**
 * Bounded CEQR Projects + Milestones reconciliation over retained ZAP keys.
 *
 * Identity is deliberately narrow: a source row joins only when its normalized
 * CEQR value equals one exact, retained ZAP CEQR value. Descriptive and
 * geographic fields are evidence to retain after the join, never join inputs.
 */

export const CEQR_RECONCILIATION_SCHEMA =
  "cityscroll.ceqr_project_milestone_reconciliation.v1";
export const CEQR_JOIN_SCHEMA = "cityscroll.ceqr_project_milestone_join.v1";
export const CEQR_NORMALIZATION_VERSION = "ceqr_key_trim_upper_v1";
export const CEQR_PROJECTS_DATASET_ID = "gezn-7mgk";
export const CEQR_MILESTONES_DATASET_ID = "8fj8-3sgg";

export const CEQR_PROJECT_SOURCE_FIELDS = Object.freeze([
  "ceqr",
  "project_name",
  "project_description",
  "borough",
  "lead_agency",
  "url",
]);
export const CEQR_MILESTONE_SOURCE_FIELDS = Object.freeze([
  "ceqr",
  "project_name",
  "milestone_name",
  "milestone_date",
]);

// Historical CEQR keys include both 26DCP139X and legacy 11-123M forms.
const CEQR_KEY = /^(?:\d{2}[A-Z]{2,6}\d{2,4}[A-Z]|\d{2}-\d{3}[A-Z])$/;

export function normalizeCeqrKey(value) {
  if (value == null) return null;
  const normalized = String(value).trim().toUpperCase().replace(/\s+/g, "");
  return CEQR_KEY.test(normalized) ? normalized : null;
}

function groupByKey(rows, field = "ceqr") {
  const groups = new Map();
  const invalid = [];
  for (const row of rows || []) {
    const raw = row?.[field];
    const key = normalizeCeqrKey(raw);
    if (!key) {
      if (raw != null && String(raw).trim()) invalid.push(row);
      continue;
    }
    const bucket = groups.get(key) || [];
    bucket.push(row);
    groups.set(key, bucket);
  }
  return { groups, invalid };
}

function sourceId(row) {
  return row?.[":id"] || row?.source_record_id || null;
}

function projectSignature(row) {
  return JSON.stringify(CEQR_PROJECT_SOURCE_FIELDS.map((field) => row?.[field] ?? null));
}

function milestoneSignature(row) {
  return JSON.stringify(CEQR_MILESTONE_SOURCE_FIELDS.map((field) => row?.[field] ?? null));
}

function dateOnly(value) {
  return typeof value === "string" ? value.slice(0, 10) : null;
}

function milestoneExtendsZap(row, zap) {
  const sourceName = String(row?.milestone_name || "").trim();
  const zapName = String(zap?.environmental_milestone || "").trim();
  const sourceDate = dateOnly(row?.milestone_date);
  const zapDate = dateOnly(zap?.environmental_milestone_date);
  return sourceName !== zapName || sourceDate !== zapDate;
}

function sortedObject(value) {
  return Object.fromEntries([...value.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

export function inspectCeqrRows(projectRows = [], milestoneRows = []) {
  const projects = groupByKey(projectRows);
  const milestones = groupByKey(milestoneRows);
  const projectDuplicates = [...projects.groups].filter(([, rows]) => rows.length > 1);
  const milestoneDuplicates = [...milestones.groups].filter(([, rows]) => {
    return new Set(rows.map(milestoneSignature)).size < rows.length;
  });
  const projectRevisions = projectDuplicates.filter(([, rows]) => {
    return new Set(rows.map(projectSignature)).size > 1;
  });
  const milestoneRevisions = [...milestones.groups].filter(([, rows]) => {
    const byName = new Map();
    for (const row of rows) {
      const name = String(row?.milestone_name || "").trim();
      const dates = byName.get(name) || new Set();
      dates.add(dateOnly(row?.milestone_date));
      byName.set(name, dates);
    }
    return [...byName.values()].some((dates) => dates.size > 1);
  });
  return {
    projects: {
      retained_rows: projectRows.length,
      valid_key_rows: projectRows.length - projects.invalid.length,
      invalid_key_rows: projects.invalid.length,
      unique_keys: projects.groups.size,
      duplicate_keys: projectDuplicates.length,
      duplicate_rows: projectDuplicates.reduce((sum, [, rows]) => sum + rows.length, 0),
      revision_keys: projectRevisions.length,
    },
    milestones: {
      retained_rows: milestoneRows.length,
      valid_key_rows: milestoneRows.length - milestones.invalid.length,
      invalid_key_rows: milestones.invalid.length,
      unique_keys: milestones.groups.size,
      exact_duplicate_keys: milestoneDuplicates.length,
      revision_keys: milestoneRevisions.length,
    },
  };
}

/**
 * Reconcile source observations against the retained ZAP projection.
 * `datasetInventory` may carry full-source counts measured during acquisition;
 * source arrays themselves remain bounded to keys present in ZAP.
 */
export function reconcileCeqrProjectMilestones({
  zapRows = [],
  projectRows = [],
  milestoneRows = [],
  sources = {},
  datasetInventory = null,
  materializedAt,
} = {}) {
  if (!materializedAt || !Number.isFinite(Date.parse(materializedAt))) {
    throw new Error("materializedAt must be an ISO timestamp");
  }
  const zap = groupByKey(zapRows, "ceqr_number");
  const projects = groupByKey(projectRows);
  const milestones = groupByKey(milestoneRows);
  const retainedInspection = inspectCeqrRows(projectRows, milestoneRows);

  const ambiguousZapKeys = [...zap.groups].filter(([, rows]) => rows.length !== 1);
  const eligibleKeys = [...zap.groups].filter(([, rows]) => rows.length === 1).map(([key]) => key);
  const exactKeys = eligibleKeys.filter((key) => projects.groups.get(key)?.length === 1);
  const unresolvedKeys = eligibleKeys.filter((key) => !projects.groups.has(key));
  const revisionConflictedKeys = eligibleKeys.filter((key) => (projects.groups.get(key)?.length || 0) > 1);

  const joinedProjects = exactKeys.sort().map((key) => {
    const zapRow = zap.groups.get(key)[0];
    const project = projects.groups.get(key)[0];
    const milestoneSourceRows = milestones.groups.get(key) || [];
    const seen = new Set();
    const checklist = milestoneSourceRows.map((row) => {
      const signature = milestoneSignature(row);
      const duplicate = seen.has(signature);
      seen.add(signature);
      return {
        source_record_id: sourceId(row),
        source_fields: CEQR_MILESTONE_SOURCE_FIELDS,
        milestone_name: row.milestone_name ?? null,
        milestone_date: row.milestone_date ?? null,
        exact_duplicate: duplicate,
        extends_zap_milestone: milestoneExtendsZap(row, zapRow),
      };
    });
    const projectSourceUrl = project.url || `https://data.cityofnewyork.us/resource/${CEQR_PROJECTS_DATASET_ID}.json`;
    return {
      schema: CEQR_JOIN_SCHEMA,
      zap_project_id: zapRow.project_id,
      ceqr_key: key,
      join: {
        method: "normalized_ceqr_key_equality",
        normalization_version: CEQR_NORMALIZATION_VERSION,
        zap_source_field: "ceqr_number",
        ceqr_source_field: "ceqr",
      },
      project: {
        source_dataset_id: CEQR_PROJECTS_DATASET_ID,
        source_record_id: sourceId(project),
        source_fields: CEQR_PROJECT_SOURCE_FIELDS,
        source_url: projectSourceUrl,
        source_vintage: sources.projects?.rows_updated_at || null,
        project_name: project.project_name ?? null,
        borough: project.borough ?? null,
        lead_agency: project.lead_agency ?? null,
      },
      milestones: {
        source_dataset_id: CEQR_MILESTONES_DATASET_ID,
        source_url: `https://data.cityofnewyork.us/d/${CEQR_MILESTONES_DATASET_ID}`,
        source_vintage: sources.milestones?.rows_updated_at || null,
        source_fields: CEQR_MILESTONE_SOURCE_FIELDS,
        rows: checklist,
      },
      zap_comparison: {
        environmental_milestone: zapRow.environmental_milestone ?? null,
        environmental_milestone_date: zapRow.environmental_milestone_date ?? null,
        incremental_milestone_rows: checklist.filter((row) => row.extends_zap_milestone).length,
      },
      materialized_at: materializedAt,
    };
  });

  const withMilestones = joinedProjects.filter((row) => row.milestones.rows.length > 0);
  const withIncrement = joinedProjects.filter((row) => row.zap_comparison.incremental_milestone_rows > 0);
  const joinedMilestoneRows = joinedProjects.flatMap((row) => row.milestones.rows);
  const exactMatchRate = eligibleKeys.length ? exactKeys.length / eligibleKeys.length : 0;
  const incrementRate = joinedProjects.length ? withIncrement.length / joinedProjects.length : 0;
  const go = exactKeys.length > 0 && exactMatchRate >= 0.5 && withIncrement.length > 0 && incrementRate >= 0.5;

  return {
    schema: CEQR_RECONCILIATION_SCHEMA,
    materialized_at: materializedAt,
    normalization: {
      version: CEQR_NORMALIZATION_VERSION,
      operation: "trim, uppercase, remove whitespace, validate CEQR grammar",
      accepted_examples: ["26DCP139X", "11-123M"],
      rejected_join_inputs: ["title", "description", "address", "borough", "applicant", "geography", "EAS action text"],
    },
    sources,
    source_schema: {
      projects: CEQR_PROJECT_SOURCE_FIELDS,
      milestones: CEQR_MILESTONE_SOURCE_FIELDS,
    },
    source_inventory: datasetInventory || retainedInspection,
    retained_source_inspection: retainedInspection,
    zap_eligibility: {
      total_rows: zapRows.length,
      rows_with_valid_ceqr_key: [...zap.groups.values()].reduce((sum, rows) => sum + rows.length, 0),
      unique_ceqr_keys: zap.groups.size,
      eligible_unique_keys: eligibleKeys.length,
      eas_action_rows_without_ceqr: zapRows.filter((row) => {
        return normalizeCeqrKey(row.ceqr_number) == null
          && /(?:^|;)\s*EAS\s*(?:;|$)/i.test(row?.actions || "");
      }).length,
      ambiguous_keys: ambiguousZapKeys.map(([key, rows]) => ({ key, zap_project_ids: rows.map((row) => row.project_id) })),
      specimens: {
        no_retained_ceqr: zapRows.find((row) => row.project_id === "2025K0305")?.ceqr_number ?? null,
        eas_never_supplies_key: true,
        project_2026K0123: (() => {
          const row = zapRows.find((candidate) => candidate.project_id === "2026K0123");
          return row ? {
            actions: row.actions ?? null,
            ulurp_numbers: row.ulurp_numbers ?? null,
            retained_ceqr_key: normalizeCeqrKey(row.ceqr_number),
            key_basis: normalizeCeqrKey(row.ceqr_number) ? "exact_retained_zap_ceqr_number" : "absent",
            exact_ceqr_project_join: exactKeys.includes(normalizeCeqrKey(row.ceqr_number)),
            inferred_from_eas: false,
          } : null;
        })(),
      },
    },
    reconciliation: {
      exact_project_matches: exactKeys.length,
      exact_match_rate: Number(exactMatchRate.toFixed(6)),
      unresolved_keys: unresolvedKeys,
      revision_conflicted_keys: revisionConflictedKeys,
      joined_projects_with_milestones: withMilestones.length,
      joined_projects_without_milestones: joinedProjects.length - withMilestones.length,
      joined_milestone_rows: joinedMilestoneRows.length,
      milestone_rows_with_dates: joinedMilestoneRows.filter((row) => row.milestone_date).length,
      milestone_rows_missing_dates: joinedMilestoneRows.filter((row) => !row.milestone_date).length,
      milestone_exact_duplicate_rows: joinedMilestoneRows.filter((row) => row.exact_duplicate).length,
      projects_with_incremental_milestones: withIncrement.length,
      incremental_project_rate: Number(incrementRate.toFixed(6)),
      rows_per_key: sortedObject(new Map([...projects.groups].map(([key, rows]) => [key, rows.length]))),
    },
    gate: {
      result: go ? "GO" : "STOP",
      thresholds: {
        minimum_exact_project_matches: 1,
        minimum_exact_match_rate: 0.5,
        minimum_incremental_projects: 1,
        minimum_incremental_project_rate: 0.5,
      },
      rationale: go
        ? `${exactKeys.length} exact project joins were established and ${withIncrement.length} add milestone history beyond the retained ZAP environmental milestone/date; only bounded joined facts are retained.`
        : "Exact CEQR coverage or measured milestone increment did not pass the usefulness thresholds; current ZAP behavior remains unchanged.",
      resident_ingestion_committed: false,
      current_zap_behavior_changed: false,
    },
    joined_projects: joinedProjects,
  };
}
