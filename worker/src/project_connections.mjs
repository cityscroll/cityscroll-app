/** Server adapter for the pure ZAP-project constellation. */

import entityLookup from "./data/entity_intelligence_lookup.json" with { type: "json" };
import projectLookup from "./data/zap_projects_warehouse_lookup.json" with { type: "json" };
import bblLookup from "./data/zap_bbl_warehouse_lookup.json" with { type: "json" };
import outcomeReceipt from "../../site/data/zap_outcome_sources/verification_receipts/zap_api_outcomes_2026-07-30.json" with { type: "json" };
import {
  buildProjectConnectionEvidence,
  PROJECT_CONNECTIONS_SCHEMA_VERSION,
  PROJECT_CONNECTION_GROUPS,
} from "../../site/project_connections.mjs";

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const projectRows = Array.isArray(projectLookup?.rows) ? projectLookup.rows : [];
const bblRows = Array.isArray(bblLookup?.rows) ? bblLookup.rows : [];
const projectById = new Map(projectRows.map((row) => [clean(row?.project_id), row]).filter(([id]) => id));
const bblById = new Map(bblRows.map((row) => [clean(row?.project_id), row]).filter(([id]) => id));
const currentIds = new Set(projectById.keys());

function decoded(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

function entityLabel(ref) {
  const root = entityLookup?.by_ref?.[ref]?.root || {};
  if (root.display_name || root.canonical_name) return root.display_name || root.canonical_name;
  if (ref.startsWith("vendor:stem:")) return decoded(ref.slice("vendor:stem:".length)) || ref;
  return ref;
}

const objectBySubject = new Map();
const graphLinkByKey = new Map();
for (const dossier of Object.values(entityLookup?.by_ref || {})) {
  for (const block of Object.values(dossier?.domains || {})) {
    for (const object of block?.objects || []) {
      if (object?.subject_ref && !objectBySubject.has(object.subject_ref)) {
        objectBySubject.set(object.subject_ref, object);
      }
    }
  }
  for (const link of dossier?.links || []) {
    if (link?.type !== "decides_land_project" || !String(link?.to || "").startsWith("project:")) continue;
    const key = [link.type, link.from, link.to].join("|");
    graphLinkByKey.set(key, link);
  }
}
const graphLinks = [...graphLinkByKey.values()];
const graphProjectCount = new Set(graphLinks.map((link) => link.to)).size;
const currentBblProjectCount = new Set(
  bblRows.map((row) => clean(row?.project_id)).filter((id) => currentIds.has(id)),
).size;
const applicantCount = projectRows.filter((row) => clean(row?.primary_applicant)).length;
const outcomeRates = outcomeReceipt?.join_measurement?.rates || {};

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
    linked: graphProjectCount,
    rate: null,
    scope: "bounded_entity_materialization",
    vintage: entityLookup?.generated_at || null,
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
    vintage: entityLookup?.generated_at || null,
    gap: "eligible_denominator_not_measured",
  },
});

function entityLinksForProject(id) {
  return (entityLookup?.by_subject_ref?.[`project:${id}`] || []).map((link) => ({
    ...link,
    label: entityLabel(clean(link?.entity_ref)),
    evidence: "land_primary_applicant",
  }));
}

function graphLinksForProject(id) {
  const ref = `project:${id}`;
  return graphLinks.filter((link) => link.to === ref).map((link) => {
    const object = objectBySubject.get(link.from) || {};
    return {
      ...link,
      label: object.label || link.from,
      agency_name: object.root_ref ? entityLabel(object.root_ref) : null,
      when: object.when || link.provenance?.observed_at || null,
    };
  });
}

/** Decorate fresh or cached outcome records at serve time. */
export function attachProjectConnections(record) {
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
  return {
    ...record,
    project_connections: buildProjectConnectionEvidence({
      projectId: id,
      projectRows: [project],
      bblRows: bblRow ? [bblRow] : [],
      entityLinks: entityLinksForProject(id),
      graphLinks: graphLinksForProject(id),
      outcome: record,
      coverage: PROJECT_CONNECTION_COVERAGE,
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
export function attachProjectConnectionsSection(record, { attach = attachProjectConnections } = {}) {
  try {
    const decorated = attach(record);
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
