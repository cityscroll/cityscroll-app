// Host retention and graph-edge gate for the committed real ZAP project corpus.

import {
  normalizeZapProjectObservation,
  zapProjectRawSnapshot,
  ZAP_PROJECTS_SOURCE_SYSTEM,
} from "../../worker/src/lib/zap_project_source_records.mjs";
import {
  linkObservation,
  observationFromLandRow,
} from "../../entity_resolution/cross_domain/object_links.mjs";

export const USEFULNESS_FLOOR = 0.3;
export const PRECISION_FLOOR = 0.95;

function sourceRecord(normalized, raw, observedAt) {
  return {
    source_system: ZAP_PROJECTS_SOURCE_SYSTEM,
    source_system_id: normalized.source_system_id,
    payload_json: raw,
    normalized_json: normalized,
    ingested_at: observedAt,
  };
}

function edgeHasEbcgProvenance(edge, sourceRecordId) {
  return Boolean(
    edge?.provenance?.source_system === ZAP_PROJECTS_SOURCE_SYSTEM
    && edge.provenance.source_record_id === sourceRecordId
    && edge.provenance.observed_at
    && edge.method
    && edge.method_version
    && edge.confidence,
  );
}

export function retainZapProjectSourceRecords(rows = [], { observedAt } = {}) {
  const at = String(observedAt || "").trim();
  const retained = [];
  const records = [];
  const edges = [];
  const seen = new Set();
  const blocked = { missing_identity_or_evidence: 0, duplicate_source_ids: 0 };

  for (const row of Array.isArray(rows) ? rows : []) {
    const normalized = normalizeZapProjectObservation(row, { observedAt: at });
    const raw = zapProjectRawSnapshot(row);
    if (!normalized || !raw || !at) {
      blocked.missing_identity_or_evidence += 1;
      continue;
    }
    if (seen.has(normalized.source_system_id)) {
      blocked.duplicate_source_ids += 1;
      continue;
    }
    seen.add(normalized.source_system_id);
    retained.push(normalized);
    records.push(sourceRecord(normalized, raw, at));

    const observation = observationFromLandRow(normalized, {
      sourceSystem: ZAP_PROJECTS_SOURCE_SYSTEM,
    });
    const linked = observation ? linkObservation(observation) : { links: [] };
    // Some publisher rows have no civic event date. The retention clock is an
    // observation clock, not a fabricated milestone, and completes provenance
    // only on this shadow edge projection.
    edges.push(...linked.links.map((edge) => ({
      ...edge,
      provenance: {
        ...edge.provenance,
        observed_at: edge.provenance?.observed_at || at,
      },
    })));
  }

  const linkedRecordIds = new Set(edges.map((edge) => edge?.provenance?.source_record_id));
  const joined = records.filter((record) =>
    linkedRecordIds.has(`${record.source_system}:${record.source_system_id}`)).length;
  const verifiedEdges = edges.filter((edge) => edgeHasEbcgProvenance(
    edge,
    edge?.provenance?.source_record_id,
  )).length;
  const usefulnessRate = records.length ? joined / records.length : null;
  const precisionRate = edges.length ? verifiedEdges / edges.length : null;
  const gates = {
    usefulness_floor: USEFULNESS_FLOOR,
    precision_floor: PRECISION_FLOOR,
    usefulness_cleared: usefulnessRate != null && usefulnessRate >= USEFULNESS_FLOOR,
    precision_cleared: precisionRate != null && precisionRate >= PRECISION_FLOOR,
    materialize: false,
  };
  gates.materialize = Boolean(gates.usefulness_cleared && gates.precision_cleared);

  return {
    rows: retained,
    source_records: records,
    edges,
    blocked,
    counts: {
      input_rows: Array.isArray(rows) ? rows.length : 0,
      retained: records.length,
      joined,
      edges: edges.length,
      verified_edges: verifiedEdges,
    },
    measurement: {
      usefulness: {
        joined,
        total: records.length,
        rate: usefulnessRate,
        floor: USEFULNESS_FLOOR,
        denominator: "retained ZAP project source records",
        numerator: "records anchoring at least one graph edge by exact project source id",
      },
      precision: {
        true_positives: verifiedEdges,
        false_positives: edges.length - verifiedEdges,
        attempts: edges.length,
        rate: precisionRate,
        floor: PRECISION_FLOOR,
        basis: "exact project_id source anchor plus source/method/confidence/time provenance",
      },
    },
    gates,
  };
}
