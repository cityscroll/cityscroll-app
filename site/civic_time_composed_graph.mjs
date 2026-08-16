/**
 * Bounded bitemporal projection for one composed civic-graph case family.
 *
 * The input is retained append-only history: civic-time event envelopes plus
 * versioned typed subject-link observations. A query chooses the latest
 * observation CityScroll had retained at beliefTime. World-valid clocks remain
 * on the selected objects; processingTime is receipt provenance only and never
 * changes membership.
 */

import {
  buildEdgeProvenanceClaim,
  isStandablePublicClaim,
} from "./graph_edge_provenance.mjs";
import {
  CIVIC_TIME_FOUR_CLOCK_BITEMPORAL_MAP,
  CIVIC_TIME_LEDGER_SCHEMA,
} from "./civic_time_ledger.mjs";
import {
  makeSubjectLink,
  parseSubjectRef,
} from "../worker/src/lib/subject_registry.mjs";

export const CIVIC_TIME_COMPOSED_GRAPH_SCHEMA = "cityscroll.civic_time_composed_graph.v1";
export const CIVIC_TIME_COMPOSED_GRAPH_HISTORY_SCHEMA = "cityscroll.civic_time_composed_graph_history.v1";
export const CIVIC_TIME_GRAPH_AS_OF_RECEIPT_SCHEMA = "cityscroll.civic_time_graph_as_of_receipt.v1";
export const CIVIC_TIME_COMPOSED_GRAPH_METHOD = "civic_time_composed_graph_as_of_v1";
export const CIVIC_TIME_COMPOSED_GRAPH_CASE_FAMILIES = Object.freeze([
  "procurement_notice",
]);

const PROVISIONAL_PUBLICATION_TIERS = new Set([
  "evidence_only",
  "no_edge",
  "provisional",
  "review",
  "shadow",
]);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function clean(value, max = 500) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

function immutableCopy(value) {
  if (Array.isArray(value)) return value.map(immutableCopy);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, immutableCopy(nested)]));
}

function retainedPayload(row, jsonField) {
  if (!row || typeof row !== "object") return null;
  if (typeof row[jsonField] === "string") {
    try {
      const parsed = JSON.parse(row[jsonField]);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      return null;
    }
  }
  return row;
}

/** Adapt retained D1 rows (or already-decoded envelopes) to the query input. */
export function buildCivicTimeComposedGraphHistory({
  rootRef,
  eventRows = [],
  identityObservationRows = [],
} = {}) {
  const root = subjectObject(rootRef);
  if (!root || root.object_type !== "notice") {
    throw new TypeError("composed graph history requires an exact notice rootRef");
  }
  const events = (Array.isArray(eventRows) ? eventRows : []).flatMap((row) => {
    const payload = retainedPayload(row, "envelope_json");
    if (!payload) return [];
    return [{
      ...immutableCopy(payload),
      written_at: payload.written_at ?? row?.written_at ?? null,
    }];
  });
  const identityLinkHistory = (Array.isArray(identityObservationRows) ? identityObservationRows : [])
    .flatMap((row) => {
      const payload = retainedPayload(row, "observation_json");
      if (!payload || payload.case_family !== "procurement_notice" || payload.root_ref !== root.object_ref) return [];
      return [{
        ...immutableCopy(payload),
        written_at: payload.written_at ?? row?.written_at ?? null,
      }];
    });
  return deepFreeze({
    schema: CIVIC_TIME_COMPOSED_GRAPH_HISTORY_SCHEMA,
    case_family: "procurement_notice",
    root_ref: root.object_ref,
    events,
    identity_link_history: identityLinkHistory,
  });
}

/** A calendar belief day includes everything retained through that UTC day. */
function normalizeQueryInstant(value, { endOfDay = false } = {}) {
  const raw = clean(value, 80);
  if (!raw) return null;
  const candidate = DAY.test(raw)
    ? `${raw}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`
    : raw;
  const millis = Date.parse(candidate);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

function retainedSystemInstant(observation) {
  return normalizeQueryInstant(
    observation?.written_at
      ?? observation?.clocks?.system_at
      ?? observation?.observed_at
      ?? observation?.provenance?.observed_at,
  );
}

function latestRetainedAsOf(rows, beliefTime, keyFor) {
  const selected = new Map();
  let missingSystemTime = 0;
  let retainedByBeliefTime = 0;
  for (const [index, row] of (Array.isArray(rows) ? rows : []).entries()) {
    const systemAt = retainedSystemInstant(row);
    if (!systemAt) {
      missingSystemTime += 1;
      continue;
    }
    if (systemAt > beliefTime) continue;
    retainedByBeliefTime += 1;
    const key = keyFor(row);
    if (!key) continue;
    const tie = clean(row?.event_id || row?.observation_id || index, 240);
    const previous = selected.get(key);
    if (!previous || systemAt > previous.system_at || (systemAt === previous.system_at && tie > previous.tie)) {
      selected.set(key, { row, system_at: systemAt, tie });
    }
  }
  return {
    selected: [...selected.values()].sort((left, right) =>
      left.system_at.localeCompare(right.system_at) || left.tie.localeCompare(right.tie)),
    missing_system_time: missingSystemTime,
    retained_by_belief_time: retainedByBeliefTime,
  };
}

function subjectObject(subjectRef) {
  const parsed = parseSubjectRef(subjectRef);
  if (!parsed) return null;
  const canonicalHref = parsed.kind === "notice"
    ? `/notices/${encodeURIComponent(parsed.id)}`
    : null;
  return {
    object_ref: parsed.ref,
    object_type: parsed.kind,
    object_id: parsed.id,
    canonical_href: canonicalHref,
  };
}

function eventIdentity(event) {
  const subjectRef = clean(event?.subject_ref, 320);
  const sourceRecordRef = clean(event?.source_record_ref, 320);
  const eventKind = clean(event?.event_kind, 160);
  if (!subjectRef || !sourceRecordRef || !eventKind) return null;
  return `${subjectRef}\u0000${sourceRecordRef}\u0000${eventKind}`;
}

function eventProjection(event, systemAt) {
  const eventId = clean(event?.event_id, 320);
  const eventKind = clean(event?.event_kind, 160);
  if (!eventId || !eventKind.startsWith("procurement.")) return null;
  const isObligation = eventKind === "procurement.solicitation_due";
  const objectRef = `civic-event:${eventId}`;
  const objectType = isObligation ? "procurement_obligation" : "procurement_event";
  const sourceRecordRef = clean(event?.source_record_ref, 320) || null;
  const sourceRevision = clean(event?.source_revision, 320) || null;
  const sourceSystem = sourceRecordRef?.split(":", 1)[0] || null;
  const sourceFields = [
    "event_kind",
    "source_revision",
    ...(event?.valid_at != null ? ["valid_at"] : []),
    ...(event?.valid_from != null ? ["valid_from"] : []),
    ...(event?.valid_to != null ? ["valid_to"] : []),
    ...(event?.published_at != null ? ["published_at"] : []),
    ...(event?.observed_at != null ? ["observed_at"] : []),
  ];
  const provenance = {
    source_system: sourceSystem,
    source_record_id: sourceRecordRef,
    source_fields: sourceFields,
    basis: "retained_source_event_exact",
    observed_at: event?.observed_at ?? systemAt,
  };
  const claim = buildEdgeProvenanceClaim({
    id: eventId,
    subject_ref: objectRef,
    label: eventKind,
    relation: isObligation ? "has_obligation" : "has_event",
    method: "retained_source_event_exact",
    confidence: "strong",
    provenance,
  }, {
    category_id: "civic-time",
    relation: isObligation ? "has_obligation" : "has_event",
    root_ref: event.subject_ref,
  });
  return {
    object: {
      object_ref: objectRef,
      object_type: objectType,
      object_id: eventId,
      event_kind: eventKind,
      obligation_kind: isObligation ? "response_due" : null,
      subject_ref: event.subject_ref,
      valid_interval: {
        at: event?.valid_at ?? null,
        from: event?.valid_from ?? null,
        to: event?.valid_to ?? null,
      },
      published_at: event?.published_at ?? null,
      retained_at: systemAt,
      provenance: {
        event_id: eventId,
        source_record_ref: sourceRecordRef,
        source_revision: sourceRevision,
        materializer_name: event?.materializer_name ?? null,
        materializer_version: event?.materializer_version ?? null,
        supersedes_event_id: event?.supersedes_event_id ?? null,
      },
    },
    edge: {
      type: isObligation ? "has_obligation" : "has_event",
      from: event.subject_ref,
      to: objectRef,
      valid_interval: {
        at: event?.valid_at ?? null,
        from: event?.valid_from ?? null,
        to: event?.valid_to ?? null,
      },
      retained_at: systemAt,
      provenance: claim,
    },
  };
}

function identityObservationKey(observation) {
  return clean(observation?.assertion_key, 320)
    || [observation?.type, observation?.from, observation?.to].map((value) => clean(value, 320)).join("|");
}

function identityProjection(observation, systemAt, rootRef) {
  const validated = makeSubjectLink(observation);
  if (!validated || (validated.from !== rootRef && validated.to !== rootRef)) return null;
  const rawProvenance = observation?.provenance && typeof observation.provenance === "object"
    ? observation.provenance
    : {};
  const rawEvidence = observation?.evidence && typeof observation.evidence === "object"
    ? observation.evidence
    : {};
  const provenanceInput = {
    ...rawProvenance,
    source_system: rawProvenance.source_system ?? rawEvidence.source_system ?? rawEvidence.source ?? null,
    source_record_id: rawProvenance.source_record_id ?? rawEvidence.source_record_id ?? null,
    source_fields: rawProvenance.source_fields ?? rawEvidence.source_fields ?? null,
    basis: rawProvenance.basis ?? rawEvidence.basis ?? null,
    observed_at: rawProvenance.observed_at ?? observation?.observed_at ?? systemAt,
  };
  const claim = buildEdgeProvenanceClaim({
    ...validated,
    id: observation?.observation_id || `${validated.type}:${validated.to}`,
    subject_ref: validated.to,
    label: observation?.label || validated.to,
    relation: validated.type,
    method: observation?.method || validated.method,
    confidence: observation?.confidence ?? validated.confidence,
    provenance: provenanceInput,
    cross_spine: observation?.cross_spine,
  }, {
    category_id: "identity",
    relation: validated.type,
    root_ref: rootRef,
  });
  const tier = clean(observation?.publication_tier || observation?.tier, 80).toLowerCase();
  const provisional = observation?.provisional === true
    || observation?.public === false
    || PROVISIONAL_PUBLICATION_TIERS.has(tier)
    || !isStandablePublicClaim(claim);
  if (provisional) return { state: "provisional", object: null, edge: null };
  const otherRef = validated.from === rootRef ? validated.to : validated.from;
  return {
    state: "public",
    object: subjectObject(otherRef),
    edge: {
      type: validated.type,
      from: validated.from,
      to: validated.to,
      valid_interval: {
        at: observation?.valid_at ?? null,
        from: observation?.valid_from ?? null,
        to: observation?.valid_to ?? null,
      },
      retained_at: systemAt,
      provenance: claim,
    },
  };
}

/**
 * Query the retained composed graph for one procurement notice at belief time.
 * Unsupported families and roots fail closed; missing system clocks never fall
 * back to processing time.
 */
export function projectCivicTimeComposedGraphAsOf(history = {}, options = {}) {
  const caseFamily = clean(history?.case_family, 80);
  if (!CIVIC_TIME_COMPOSED_GRAPH_CASE_FAMILIES.includes(caseFamily)) {
    throw new TypeError("projectCivicTimeComposedGraphAsOf supports procurement_notice only");
  }
  const root = subjectObject(history?.root_ref);
  if (!root || root.object_type !== "notice") {
    throw new TypeError("procurement_notice history requires an exact notice root_ref");
  }
  const beliefTime = normalizeQueryInstant(options?.beliefTime, { endOfDay: true });
  if (!beliefTime) throw new TypeError("beliefTime must be an ISO timestamp or YYYY-MM-DD");
  const processingTime = options?.processingTime == null
    ? null
    : normalizeQueryInstant(options.processingTime);
  if (options?.processingTime != null && !processingTime) {
    throw new TypeError("processingTime must be an ISO timestamp or YYYY-MM-DD");
  }

  const selectedLinks = latestRetainedAsOf(
    history?.identity_link_history,
    beliefTime,
    identityObservationKey,
  );

  let omittedProvisionalEdges = 0;
  const identityProjections = [];
  const connectedSubjectRefs = new Set([root.object_ref]);
  for (const selected of selectedLinks.selected) {
    const projection = identityProjection(selected.row, selected.system_at, root.object_ref);
    if (!projection) continue;
    if (projection.state === "provisional") {
      omittedProvisionalEdges += 1;
      continue;
    }
    identityProjections.push(projection);
    connectedSubjectRefs.add(projection.edge.from);
    connectedSubjectRefs.add(projection.edge.to);
  }
  const eventHistory = (Array.isArray(history?.events) ? history.events : [])
    .filter((event) => connectedSubjectRefs.has(event?.subject_ref)
      && String(event?.event_kind || "").startsWith("procurement."));
  const selectedEvents = latestRetainedAsOf(eventHistory, beliefTime, eventIdentity);

  const objects = [root];
  const edges = [];
  const objectRefs = new Set([root.object_ref]);
  const addObject = (object) => {
    if (!object?.object_ref || objectRefs.has(object.object_ref)) return;
    objectRefs.add(object.object_ref);
    objects.push(object);
  };

  for (const projection of identityProjections) {
    addObject(projection.object);
    edges.push(projection.edge);
  }

  for (const selected of selectedEvents.selected) {
    const projection = eventProjection(selected.row, selected.system_at);
    if (!projection) continue;
    addObject(projection.object);
    edges.push(projection.edge);
  }

  objects.sort((left, right) => left.object_ref.localeCompare(right.object_ref));
  edges.sort((left, right) => left.type.localeCompare(right.type)
    || left.from.localeCompare(right.from)
    || left.to.localeCompare(right.to));

  return deepFreeze({
    schema: CIVIC_TIME_COMPOSED_GRAPH_SCHEMA,
    method: CIVIC_TIME_COMPOSED_GRAPH_METHOD,
    case_family: caseFamily,
    root_ref: root.object_ref,
    objects,
    edges,
    receipt: {
      schema: CIVIC_TIME_GRAPH_AS_OF_RECEIPT_SCHEMA,
      method: CIVIC_TIME_COMPOSED_GRAPH_METHOD,
      case_family: caseFamily,
      root_ref: root.object_ref,
      temporal_contract: CIVIC_TIME_LEDGER_SCHEMA,
      belief_time: beliefTime,
      processing_time: processingTime,
      processing_time_used_for_membership: false,
      axes: {
        valid: {
          owner: CIVIC_TIME_FOUR_CLOCK_BITEMPORAL_MAP.civic.bitemporal_axis === "valid" ? "civic" : null,
          projection: "preserved_on_objects_and_edges",
        },
        system: {
          owner: CIVIC_TIME_FOUR_CLOCK_BITEMPORAL_MAP.observation.bitemporal_axis === "system" ? "observation" : null,
          projection: "retained_at_or_before_belief_time",
        },
        publication: { owner: null, role: "evidence_clock" },
        processing: { owner: null, role: "receipt_only" },
      },
      counts: {
        retained_event_observations: eventHistory.length,
        event_observations_at_belief_time: selectedEvents.retained_by_belief_time,
        selected_event_objects: edges.filter((edge) => edge.type === "has_event" || edge.type === "has_obligation").length,
        retained_identity_observations: Array.isArray(history?.identity_link_history)
          ? history.identity_link_history.length
          : 0,
        identity_observations_at_belief_time: selectedLinks.retained_by_belief_time,
        selected_public_identity_edges: edges.filter((edge) => edge.type !== "has_event" && edge.type !== "has_obligation").length,
        omitted_provisional_edges: omittedProvisionalEdges,
        omitted_missing_system_time: selectedEvents.missing_system_time + selectedLinks.missing_system_time,
      },
      selected_observation_ids: [
        ...selectedEvents.selected.map(({ row }) => row.event_id).filter(Boolean),
        ...selectedLinks.selected.map(({ row }) => row.observation_id).filter(Boolean),
      ],
    },
  });
}
