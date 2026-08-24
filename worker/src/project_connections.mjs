/** Server adapter for the pure ZAP-project constellation. */

import projectLookup from "./data/zap_projects_warehouse_lookup.json" with { type: "json" };
import bblLookup from "./data/zap_bbl_warehouse_lookup.json" with { type: "json" };
import outcomeReceipt from "../../site/data/zap_outcome_sources/verification_receipts/zap_api_outcomes_2026-07-30.json" with { type: "json" };
import mihLookup from "../../site/data/mih_project_lookup.json" with { type: "json" };
import {
  buildProjectConnectionEvidence,
  PROJECT_CONNECTIONS_SCHEMA_VERSION,
  PROJECT_CONNECTION_GROUPS,
} from "../../site/project_connections.mjs";
import {
  entityLinksForProjectFromD1,
  graphLinksForProjectFromD1,
  loadEntityIntelligenceMeta,
} from "./lib/entity_intelligence_read_model.mjs";

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const projectRows = Array.isArray(projectLookup?.rows) ? projectLookup.rows : [];
const bblRows = Array.isArray(bblLookup?.rows) ? bblLookup.rows : [];
const projectById = new Map(projectRows.map((row) => [clean(row?.project_id), row]).filter(([id]) => id));
const bblById = new Map(bblRows.map((row) => [clean(row?.project_id), row]).filter(([id]) => id));
const currentIds = new Set(projectById.keys());

const currentBblProjectCount = new Set(
  bblRows.map((row) => clean(row?.project_id)).filter((id) => currentIds.has(id)),
).size;
const applicantCount = projectRows.filter((row) => clean(row?.primary_applicant)).length;
const outcomeRates = outcomeReceipt?.join_measurement?.rates || {};
const mihRows = Array.isArray(mihLookup?.rows) ? mihLookup.rows : [];

export const PROJECT_CONNECTION_COVERAGE = Object.freeze({
  applicant: {
    eligible: projectRows.length,
    linked: applicantCount,
    rate: projectRows.length ? applicantCount / projectRows.length : null,
    scope: "current_zap_snapshot",
    vintage: projectLookup?.materialized_at || null,
  },
  parcels: {
    eligible: projectRows.length,
    linked: currentBblProjectCount,
    rate: projectRows.length ? currentBblProjectCount / projectRows.length : null,
    scope: "current_zap_snapshot",
    vintage: bblLookup?.materialized_at || null,
  },
  meetings: {
    eligible: null,
    linked: null,
    rate: null,
    scope: "bounded_entity_materialization",
    vintage: null,
    gap: "eligible_denominator_not_measured",
  },
  decisions: {
    eligible: outcomeRates?.ulurp_complete_disposition_vote?.total ?? null,
    linked: outcomeRates?.ulurp_complete_disposition_vote?.joined ?? null,
    rate: outcomeRates?.ulurp_complete_disposition_vote?.rate ?? null,
    scope: "fixed_completed_project_sample",
    vintage: outcomeReceipt?.join_measurement?.observed_on || null,
  },
  notices: {
    eligible: null,
    linked: null,
    rate: null,
    scope: "this_project",
    vintage: null,
    gap: "eligible_denominator_not_measured",
  },
  mih: {
    eligible: mihLookup?.join_measurement?.eligible ?? null,
    linked: mihLookup?.join_measurement?.linked ?? null,
    rate: mihLookup?.join_measurement?.rate ?? null,
    scope: "mih_rows_to_zap_project_id",
    vintage: mihLookup?.materialized_at || null,
    gap: mihLookup?.join_measurement?.gap || null,
  },
});

async function coverageForRequest(db) {
  if (!db) return PROJECT_CONNECTION_COVERAGE;
  const meta = await loadEntityIntelligenceMeta(db);
  const overlay = meta?.project_connection_coverage;
  if (!overlay) return PROJECT_CONNECTION_COVERAGE;
  return {
    ...PROJECT_CONNECTION_COVERAGE,
    meetings: { ...PROJECT_CONNECTION_COVERAGE.meetings, ...overlay.meetings },
    notices: { ...PROJECT_CONNECTION_COVERAGE.notices, ...overlay.notices },
  };
}

/** Decorate fresh or cached outcome records at serve time. */
export async function attachProjectConnections(record, { db = null } = {}) {
  if (!record?.project_id) return record;
  const id = clean(record.project_id);
  const project = projectById.get(id)
    || (clean(record?.open_data?.project_id) === id ? record.open_data : null)
    || {
      project_id: id,
      project_name: record.project_name || null,
      primary_applicant: record.primary_applicant || null,
    };
  const bblRow = bblById.get(id)
    || (Array.isArray(record.bbls) ? { project_id: id, bbls: record.bbls } : null);
  const [entityLinks, graphLinks, coverage] = await Promise.all([
    entityLinksForProjectFromD1(db, id),
    graphLinksForProjectFromD1(db, id),
    coverageForRequest(db),
  ]);
  return {
    ...record,
    project_connections: buildProjectConnectionEvidence({
      projectId: id,
      projectRows: [project],
      bblRows: bblRow ? [bblRow] : [],
      entityLinks,
      graphLinks,
      outcome: record,
      mihRows,
      coverage,
    }),
  };
}

function unavailableRecord(record, reason) {
  const id = clean(record?.project_id);
  return {
    ...record,
    project_connections: {
      schema_version: PROJECT_CONNECTIONS_SCHEMA_VERSION,
      status: "unavailable",
      reason,
      project_id: id || null,
      project_ref: id ? `project:${id}` : null,
      groups: [],
    },
  };
}

/** Attach the read model and always return an explicit section availability contract. */
export async function attachProjectConnectionsSection(
  record,
  { attach = attachProjectConnections, db = null } = {},
) {
  try {
    const decorated = await attach(record, { db });
    const evidence = decorated?.project_connections;
    const groupIds = new Set((evidence?.groups || []).map((group) => group?.id));
    if (evidence?.schema_version === PROJECT_CONNECTIONS_SCHEMA_VERSION
        && evidence?.status === "bounded"
        && PROJECT_CONNECTION_GROUPS.every(({ id }) => groupIds.has(id))) {
      return {
        record: decorated,
        section: { schema_version: PROJECT_CONNECTIONS_SCHEMA_VERSION, status: "available" },
      };
    }
    return {
      record: unavailableRecord(decorated || record, "read_model_incomplete"),
      section: {
        schema_version: PROJECT_CONNECTIONS_SCHEMA_VERSION,
        status: "unavailable",
        reason: "read_model_incomplete",
      },
    };
  } catch (_error) {
    return {
      record: unavailableRecord(record, "read_model_unavailable"),
      section: {
        schema_version: PROJECT_CONNECTIONS_SCHEMA_VERSION,
        status: "unavailable",
        reason: "read_model_unavailable",
      },
    };
  }
}
