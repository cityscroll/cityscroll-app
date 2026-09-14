/** Materialize accepted procurement site evidence as reusable parcel relations. */
import {
  procurementParcelLinksForObservation,
  procurementContractLinksForObservations,
} from "../../entity_resolution/cross_domain/object_links.mjs";

export const PROCUREMENT_PARCEL_RELATION_SCHEMA = "cityscroll.procurement_parcel_relations.v1";

const clean = (value) => String(value ?? "").trim();

function acceptedEvidence(record) {
  if (record?.classification !== "accepted") return [];
  return (Array.isArray(record.evidence) ? record.evidence : []).filter((item) =>
    item?.resolution?.status === "resolved" && item?.resolved_bbl,
  );
}

function observationForRecord(record, observations) {
  const list = Array.isArray(observations) ? observations : [];
  return list.find((obs) =>
    obs?.source_record_id === `${record.source_system}:${record.request_id}`
      || (obs?.request_id && obs.request_id === record.request_id),
  ) || {
    domain: "money",
    object_kind: "award",
    source_system: record.source_system,
    source_record_id: `${record.source_system}:${record.request_id}`,
    request_id: record.request_id,
    epin: record.epin,
    subject_ref: record.source_system === "city_record_online"
      ? `notice:${record.request_id}`
      : `notice:${record.request_id}`,
  };
}

function edgeKey(edge) {
  return `${edge.type}|${edge.from}|${edge.to}|${edge.domain || ""}`;
}

/**
 * Build current procurement→parcel edges from the retained evidence document.
 * Re-running with a refreshed document is replacement semantics: withdrawn or
 * unresolved evidence is absent from `relations`, while the input records stay
 * available to callers as historical observations.
 */
export function buildProcurementParcelRelations({ siteEvidence, observations = [] } = {}) {
  const records = Array.isArray(siteEvidence?.records) ? siteEvidence.records : [];
  const obs = [...(Array.isArray(observations) ? observations : [])];
  const direct = [];
  for (const record of records) {
    const evidence = acceptedEvidence(record);
    if (!evidence.length) continue;
    const observation = observationForRecord(record, obs);
    if (!observation.subject_ref) continue;
    direct.push(...procurementParcelLinksForObservation({
      ...observation,
      site_evidence: evidence,
    }));
  }

  // Exact notice→contract lineage is the only propagation path. The hearing's
  // section EPIN remains scoped to its own notice; no parent-notice fan-out.
  const allObservations = [...obs];
  for (const edge of direct) {
    if (!allObservations.some((item) => item.subject_ref === edge.from)) {
      allObservations.push({
        domain: "money",
        object_kind: "award",
        source_record_id: edge.provenance?.source_record_id,
        subject_ref: edge.from,
      });
    }
  }
  const lineage = procurementContractLinksForObservations(allObservations);
  const byNotice = new Map(direct.map((edge) => [edge.from, []]));
  for (const edge of direct) byNotice.get(edge.from)?.push(edge);
  const propagated = [];
  for (const [sourceId, links] of lineage.entries()) {
    const sourceObs = allObservations.find((item) => item.source_record_id === sourceId);
    if (!sourceObs) continue;
    const sites = byNotice.get(sourceObs.subject_ref) || [];
    for (const lineageEdge of links) {
      if (lineageEdge.type !== "references_contract") continue;
      for (const site of sites) {
        propagated.push({
          ...site,
          from: lineageEdge.to,
          provenance: {
            ...site.provenance,
            related_source_system: lineageEdge.provenance?.related_source_system || sourceObs.source_system,
            related_source_record_id: lineageEdge.provenance?.related_source_record_id || sourceObs.source_record_id,
            lineage: lineageEdge.provenance,
          },
        });
      }
    }
  }

  const grouped = new Map();
  for (const edge of [...direct, ...propagated]) {
    const key = edgeKey(edge);
    const current = grouped.get(key);
    const evidenceId = clean(edge.provenance?.evidence_id);
    if (current) {
      current.provenance.evidence_refs = [...new Set([
        ...(current.provenance.evidence_refs || []),
        ...(evidenceId ? [evidenceId] : []),
      ])].sort();
    } else {
      grouped.set(key, {
        ...edge,
        provenance: {
          ...edge.provenance,
          evidence_refs: evidenceId ? [evidenceId] : [],
        },
      });
    }
  }
  const relations = [...grouped.values()].sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)));
  return {
    schema: PROCUREMENT_PARCEL_RELATION_SCHEMA,
    method: "accepted_procurement_site_evidence_v1",
    relations,
    records,
    population: { current_relations: relations.length, source_records: records.length },
  };
}

export function validateProcurementParcelRelations(doc) {
  if (doc?.schema !== PROCUREMENT_PARCEL_RELATION_SCHEMA) throw new Error("procurement parcel relation schema mismatch");
  if (!Array.isArray(doc.relations)) throw new Error("procurement parcel relations missing relations");
  for (const edge of doc.relations) {
    if (edge.type !== "procurement_sited_on_parcel" || !edge.from.startsWith("notice:") && !edge.from.startsWith("contract:")) {
      throw new Error("invalid procurement parcel relation");
    }
  }
  return doc;
}
