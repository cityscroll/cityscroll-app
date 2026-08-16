/**
 * Shared adapter from accepted mandate bridge edges to Process Conformance.
 *
 * Bridge modules continue to own relation-specific evidence and publication
 * gates. This module only projects their public results into one observation
 * vocabulary and one data-as-of boundary.
 */

import {
  OBSERVATION_LABELS,
  OBSERVATION_STATUS,
  PROCESS_CONFORMANCE_METHOD,
} from "./process_conformance.mjs";
import { isProcurementMandate } from "./mandate_contracts_bridge.mjs";
import { mandateRequiresMeeting } from "./mandate_meetings_bridge.mjs";
import { mandateLandUseKinds } from "./mandate_land_use_bridge.mjs";
import { mandateSubjectRef } from "./mandate_subject_ref.mjs";

export const OBSERVATION_STATE = Object.freeze({
  APPEARED: "appeared",
  NOT_YET_OBSERVED: "not_yet_observed",
  DATA_INCOMPLETE: "data_incomplete",
});

export const OBSERVATION_STATE_LABELS = Object.freeze({
  [OBSERVATION_STATE.APPEARED]: "Appeared",
  [OBSERVATION_STATE.NOT_YET_OBSERVED]: "Not yet observed",
  [OBSERVATION_STATE.DATA_INCOMPLETE]: "Data incomplete",
});

const clean = (value, max = 500) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

function datePart(value) {
  const match = clean(value, 40).match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function publicHref(value) {
  const href = clean(value, 500);
  if (!href) return null;
  if (href.startsWith("/") || href.startsWith("https://") || href.startsWith("http://")) return href;
  return null;
}

export function observationStateForStatus(status) {
  if (status === OBSERVATION_STATUS.OBSERVED) return OBSERVATION_STATE.APPEARED;
  if (status === OBSERVATION_STATUS.ON_TRACK
    || status === OBSERVATION_STATUS.EXPECTED_NOT_YET_OBSERVED) {
    return OBSERVATION_STATE.NOT_YET_OBSERVED;
  }
  return OBSERVATION_STATE.DATA_INCOMPLETE;
}

export function conformanceCategoryForObservation(observation = {}) {
  const kind = clean(observation?.expected_event?.kind, 80);
  if (kind === "rule_filing") return "rules";
  if (kind === "report_or_study") return "reports";
  if (kind === "public_hearing" || kind === "public_meeting") return "meetings";
  if (kind === "procurement_contract") return "contracts";
  if (kind === "land_use_action") return "zoning";
  return null;
}

function mandateId(row) {
  return clean(row?.obligation_id || row?.mandate_id, 160) || null;
}

function edgeMandateId(row) {
  return clean(row?.mandate_id || row?.mandate?.mandate_id, 160) || null;
}

function genericEdge(row, edgeType) {
  const target = row?.target || {};
  const claim = row?.claim || null;
  const to = clean(target.subject_ref || row?.to, 240) || null;
  return {
    type: clean(row?.edge?.type || row?.relation || edgeType, 100) || edgeType,
    from: clean(row?.edge?.from || row?.from, 240)
      || mandateSubjectRef(edgeMandateId(row)),
    to,
    claim_id: clean(claim?.claim_id, 240) || null,
    claim_inspect_href: publicHref(claim?.inspect_href || claim?.share_href),
    warrant_class: clean(claim?.how?.warrant_class, 80) || null,
    method: clean(row?.edge?.method || row?.method || claim?.how?.method?.value, 160) || null,
    confidence: clean(row?.edge?.confidence || claim?.confidence?.band, 80) || null,
    publication_tier: clean(row?.edge_policy?.tier || row?.publication_tier, 80) || null,
    provenance: claim?.schema === "cityscroll.graph_edge_provenance.v1" ? claim : null,
  };
}

/** Build one category's expected-vs-observed rows from accepted bridge edges. */
export function buildMandateCategoryConformance({
  category,
  edgeType,
  expectedKind,
  expectedLabel,
  mandates = [],
  edges = [],
  asOf = null,
  sourceAvailable = false,
} = {}) {
  const dataAsOf = datePart(asOf);
  const edgesByMandate = new Map();
  for (const edge of edges || []) {
    const id = edgeMandateId(edge);
    if (!id) continue;
    if (!edgesByMandate.has(id)) edgesByMandate.set(id, []);
    edgesByMandate.get(id).push(edge);
  }
  const items = [];
  for (const mandate of mandates || []) {
    const id = mandateId(mandate);
    if (!id) continue;
    const matchedEdges = edgesByMandate.get(id) || [];
    const deadlineDate = datePart(mandate?.deadline?.computed_date || mandate?.deadline_date);
    const expected = {
      kind: clean(expectedKind, 80),
      label: clean(expectedLabel, 240),
      deliverable_type: clean(mandate?.deliverable_type, 80) || null,
      deadline_date: deadlineDate,
      deadline_text: clean(mandate?.deadline?.text || mandate?.deadline_text, 240) || null,
    };
    const base = {
      mandate_id: id,
      obligation_id: id,
      duty_text: clean(mandate?.duty_text || mandate?.label, 800),
      deliverable_type: clean(mandate?.deliverable_type, 80) || null,
      recurrence: clean(mandate?.recurrence, 80) || null,
      citation: clean(mandate?.citation, 240) || null,
      deadline_date: deadlineDate,
      deadline_text: expected.deadline_text,
      source: mandate?.source || null,
      source_href: publicHref(mandate?.source?.legistar_url || mandate?.href),
      category: clean(category, 80),
      edge_type: clean(edgeType, 100),
      data_as_of: dataAsOf,
    };
    if (matchedEdges.length) {
      for (const edge of matchedEdges) {
        const target = edge.target || {};
        const graphEdge = genericEdge(edge, edgeType);
        items.push({
          ...base,
          conformance_id: `${id}:${category}:${clean(target.subject_ref || graphEdge.to, 200)}`,
          observation: {
            status: OBSERVATION_STATUS.OBSERVED,
            observation_state: OBSERVATION_STATE.APPEARED,
            label: OBSERVATION_STATE_LABELS[OBSERVATION_STATE.APPEARED],
            expected_event: expected,
            observed_record: {
              subject_ref: clean(target.subject_ref || graphEdge.to, 240) || null,
              request_id: clean(target.request_id, 100) || null,
              label: clean(target.label, 320) || clean(target.subject_ref || graphEdge.to, 240),
              when: datePart(target.when),
              href: publicHref(target.href || graphEdge.claim_inspect_href),
              signal_kind: clean(expectedKind, 80),
            },
            edge: graphEdge,
            match: edge.match || edge.evidence || null,
            is_compliance_verdict: false,
            adjudication: "not_adjudicated",
            method: clean(edge?.process_conformance?.method || edge?.method, 120)
              || PROCESS_CONFORMANCE_METHOD,
          },
        });
      }
      continue;
    }
    const future = Boolean(deadlineDate && dataAsOf && deadlineDate > dataAsOf);
    const status = sourceAvailable
      ? (future ? OBSERVATION_STATUS.ON_TRACK : OBSERVATION_STATUS.EXPECTED_NOT_YET_OBSERVED)
      : OBSERVATION_STATUS.ENRICHMENT_PENDING;
    const state = observationStateForStatus(status);
    items.push({
      ...base,
      conformance_id: `${id}:${category}:expected`,
      observation: {
        status,
        observation_state: state,
        label: OBSERVATION_LABELS[status],
        expected_event: expected,
        observed_record: null,
        edge: {
          type: clean(edgeType, 100),
          from: mandateSubjectRef(id),
          to: null,
          claim_id: null,
          claim_inspect_href: null,
          warrant_class: null,
        },
        match: null,
        is_compliance_verdict: false,
        adjudication: "not_adjudicated",
        method: PROCESS_CONFORMANCE_METHOD,
      },
    });
  }
  return {
    category: clean(category, 80),
    edge_type: clean(edgeType, 100),
    as_of: dataAsOf,
    source_state: sourceAvailable ? "available" : "unknown",
    items,
  };
}

/** Normalize the three relation-specific bridge views into shared groups. */
export function mandateBridgeConformanceGroups({
  obligationsLookup = null,
  agencyId = null,
  meetingsView = null,
  contractsView = null,
  landUseView = null,
  meetingsSourceAvailable = false,
  contractsSourceAvailable = false,
  zoningSourceAvailable = false,
  asOf = null,
} = {}) {
  const mandates = obligationsLookup?.by_agency?.[agencyId]?.obligations || [];
  const meetings = (meetingsView?.edges || []).map((edge) => ({
    ...edge,
    mandate_id: edge.mandate?.mandate_id,
    target: {
      subject_ref: edge.meeting?.subject_ref,
      request_id: edge.meeting?.request_id,
      label: edge.meeting?.label,
      when: edge.meeting?.date,
      href: edge.meeting?.href,
    },
  }));
  const contracts = (contractsView?.edges || []).map((edge) => ({
    ...edge,
    target: {
      subject_ref: edge.contract?.subject_ref,
      request_id: edge.procurement_record?.request_id,
      label: edge.contract?.contract_id ? `Contract ${edge.contract.contract_id}` : edge.contract?.subject_ref,
      when: edge.procurement_record?.when,
      href: edge.claim?.inspect_href || edge.procurement_record?.href,
    },
  }));
  const directLand = (landUseView?.edges || []).map((edge) => ({
    ...edge,
    mandate_id: edge.mandate?.mandate_id,
    target: {
      subject_ref: edge.land_action?.subject_ref,
      label: edge.land_action?.label,
      when: edge.land_action?.date,
      href: edge.land_action?.href || edge.claim?.inspect_href,
    },
  }));
  const procedureLand = (landUseView?.procedure_paths || []).map((path) => ({
    mandate_id: clean(path.mandate_edge?.from, 200).replace(/^mandate:/, ""),
    relation: "composed_land_use_procedure_path",
    edge: { type: "composed_land_use_procedure_path", from: path.mandate_edge?.from, to: path.land_action?.subject_ref },
    target: {
      subject_ref: path.land_action?.subject_ref,
      label: path.land_action?.label || path.procedure?.label,
      when: path.land_action?.date,
      href: path.land_action?.href || path.claim?.inspect_href,
    },
    claim: path.claim,
    match: path.provenance,
  }));
  const dedupedLand = [...new Map([...directLand, ...procedureLand].map((edge) => [
    `${edge.mandate_id}|${edge.target?.subject_ref}`,
    edge,
  ])).values()];
  return [
    buildMandateCategoryConformance({
      category: "meetings",
      edgeType: "requires_public_hearing",
      expectedKind: "public_hearing",
      expectedLabel: "Public meeting or hearing",
      mandates: mandates.filter(mandateRequiresMeeting),
      edges: meetings,
      asOf,
      sourceAvailable: meetingsSourceAvailable && meetingsView?.publication_gate?.passed !== false,
    }),
    buildMandateCategoryConformance({
      category: "contracts",
      edgeType: "implemented_by_contract",
      expectedKind: "procurement_contract",
      expectedLabel: "Contract award or registration",
      mandates: mandates.filter(isProcurementMandate),
      edges: contracts,
      asOf,
      sourceAvailable: contractsSourceAvailable && contractsView?.publication_gate?.passed !== false,
    }),
    buildMandateCategoryConformance({
      category: "zoning",
      edgeType: "requires_land_use_action",
      expectedKind: "land_use_action",
      expectedLabel: "Land-use or zoning action",
      mandates: mandates.filter((row) => mandateLandUseKinds(row).length),
      edges: dedupedLand,
      asOf,
      sourceAvailable: zoningSourceAvailable && landUseView?.publication_gate?.passed !== false,
    }),
  ];
}

/** Merge category groups into the existing rules/reports conformance view. */
export function mergeMandateCategoryConformance(view, categoryGroups = [], { asOf = null } = {}) {
  if (!view) return view;
  const dataAsOf = datePart(asOf || view.as_of);
  const extensions = categoryGroups.flatMap((group) => group?.items || []);
  const extensionMandates = new Set(extensions.map((item) => item.mandate_id));
  const base = (view.items || [])
    .filter((item) => !(
      extensionMandates.has(item.mandate_id)
      && item.observation?.status === OBSERVATION_STATUS.ENRICHMENT_PENDING
    ))
    .map((item) => {
      const category = item.category || conformanceCategoryForObservation(item.observation);
      const state = observationStateForStatus(item.observation?.status);
      return {
        ...item,
        category,
        data_as_of: dataAsOf,
        observation: {
          ...item.observation,
          observation_state: state,
        },
      };
    });
  const items = [...base, ...extensions.map((item) => ({ ...item, data_as_of: dataAsOf }))];
  const rank = {
    [OBSERVATION_STATE.APPEARED]: 0,
    [OBSERVATION_STATE.NOT_YET_OBSERVED]: 1,
    [OBSERVATION_STATE.DATA_INCOMPLETE]: 2,
  };
  items.sort((left, right) => {
    const stateOrder = (rank[left.observation?.observation_state] ?? 9)
      - (rank[right.observation?.observation_state] ?? 9);
    if (stateOrder) return stateOrder;
    return `${left.category || "zz"}|${left.deadline_date || "9999"}|${left.mandate_id}`
      .localeCompare(`${right.category || "zz"}|${right.deadline_date || "9999"}|${right.mandate_id}`);
  });
  const counts = {
    total: new Set(items.map((item) => item.mandate_id).filter(Boolean)).size,
    observed: 0,
    expected_not_yet_observed: 0,
    on_track: 0,
    enrichment_pending: 0,
    evidence_only: 0,
    detectable: new Set(items.filter((item) => item.category).map((item) => item.mandate_id)).size,
    appeared: 0,
    not_yet_observed: 0,
    data_incomplete: 0,
  };
  const categoryCounts = Object.create(null);
  for (const item of items) {
    const status = item.observation?.status;
    const state = item.observation?.observation_state;
    if (status) counts[status] = (counts[status] || 0) + 1;
    if (state) counts[state] = (counts[state] || 0) + 1;
    if (item.category) {
      categoryCounts[item.category] ||= { total: 0, appeared: 0, not_yet_observed: 0, data_incomplete: 0 };
      categoryCounts[item.category].total += 1;
      if (state) categoryCounts[item.category][state] += 1;
    }
  }
  const categories = Object.keys(categoryCounts).sort();
  return {
    ...view,
    as_of: dataAsOf,
    data_as_of: dataAsOf,
    categories,
    category_counts: categoryCounts,
    counts,
    items,
    items_total: items.length,
    candidate_corpus: {
      ...(view.candidate_corpus || {}),
      sources: [...new Set([
        ...(view.candidate_corpus?.sources || []),
        ...categoryGroups.filter((group) => group?.items?.length).map((group) => `mandate_${group.category}_bridge`),
      ])],
    },
  };
}
