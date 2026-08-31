/**
 * Source-qualified City Council committee proceeding traversal.
 *
 * Exact Legistar body id 34, City Record meeting 20260707021, and official
 * membership rows mint civic-institution role edges. Names, publisher labels,
 * and nearby dates never create a committee, meeting, chair, or matter join.
 */

import {
  buildCivicInstitutionRoleEdge,
  invertCivicInstitutionRoleEdge,
  resolveCivicInstitutionRoleEdges,
  sourceRecordObservation,
} from "../ontology/civic_institution.mjs";
import defaultProceedings from "./data/council_committee_proceedings.json" with { type: "json" };

export const COUNCIL_CANONICAL_ID = "city-council";
export const ZONING_FRANCHISES_BODY_ID = "34";
export const ZONING_FRANCHISES_COMMITTEE_ID = `committee:${ZONING_FRANCHISES_BODY_ID}`;
export const SPECIMEN_MEETING_REQUEST_ID = "20260707021";
export const SPECIMEN_MEETING_ID = `meeting:city_record:${SPECIMEN_MEETING_REQUEST_ID}`;
export const TARGET_LAND_MATTER_ID = "LU-0120-2026";
export const TARGET_PROCEEDING_DATE = "2026-08-12";
export const COUNCIL_COMMITTEE_NEGATIVE_RULE = "Never connect a committee because its display name resembles Zoning and Franchises, because a City Record notice is published by Council, or because a meeting date is nearby. Do not infer chair status without valid dates and exact is_chair evidence.";
export const COMMITTEE_PROCEEDING_JOIN_METHOD = "exact_event_body_id";
export const MATTER_JOIN_UNAVAILABLE = "matter_join_unavailable";

const COMMITTEE_RELATIONS = Object.freeze(new Set([
  "has_committee",
  "part_of",
  "hosts_meeting",
  "hosted_by",
  "member_of",
  "has_member",
  "chairs",
  "chaired_by",
  "considers",
  "considered_at",
]));

const clean = (value, max = 500) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

function exactText(value, max = 500) {
  return clean(value, max);
}

function exactBodyId(value) {
  const id = exactText(value, 40).replace(/^committee:/, "");
  return /^\d+$/.test(id) ? id : "";
}

function exactOfficialId(value) {
  const id = exactText(value, 80).replace(/^official:/, "");
  return /^\d+$/.test(id) ? id : "";
}

function exactRequestId(value) {
  const id = exactText(value, 40);
  return /^\d{8,12}$/.test(id) ? id : "";
}

function isoObservedAt(value) {
  const raw = exactText(value, 80);
  if (!raw) return "2026-08-10T13:08:13.019Z";
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${raw}T00:00:00.000Z`;
  if (!Number.isNaN(Date.parse(raw))) return raw;
  return "2026-08-10T13:08:13.019Z";
}

export function isCouncilCommitteeRelation(relation) {
  return COMMITTEE_RELATIONS.has(exactText(relation, 80).toLowerCase());
}

export function isNameOnlyCommitteeIdentity(value) {
  const raw = exactText(value, 240);
  if (!raw) return false;
  if (exactBodyId(raw)) return false;
  return /zoning|franchises/i.test(raw);
}

function committeeNode(graph, bodyId) {
  const id = exactBodyId(bodyId);
  if (!id || graph?.publication !== "published") return null;
  return (Array.isArray(graph?.nodes) ? graph.nodes : []).find((node) =>
    node?.id === `committee:${id}`
    && node?.type === "committee"
    && exactBodyId(node?.properties?.body_id) === id
    && exactText(node?.name) === exactText(node?.properties?.body_name)
  ) || null;
}

function proceedingRows(proceedings) {
  const rows = Array.isArray(proceedings?.rows) ? proceedings.rows : [];
  return rows.filter(Boolean);
}

function gapRows(proceedings) {
  return (Array.isArray(proceedings?.gaps) ? proceedings.gaps : []).filter(Boolean);
}

function outcomeForNotice(outcomes, requestId) {
  const rec = outcomes?.by_notice?.[requestId];
  return rec && rec.snapshot_state === "present" ? rec : null;
}

/**
 * Accept a committee→meeting join only when exact body id, request id,
 * event id, and EventBodyId agree. Titles, publishers, and nearby dates
 * never satisfy this gate.
 */
export function verifyCommitteeMeetingJoin(row = {}, { meetingOutcomes = null } = {}) {
  const bodyId = exactBodyId(row.body_id || row.committee_id);
  const requestId = exactRequestId(row.request_id);
  const meetingId = exactText(row.meeting_id, 160);
  const eventId = exactText(row.event_id, 40);
  const eventBodyId = exactBodyId(row.event_body_id);
  if (!bodyId || !requestId || !eventId || !eventBodyId) {
    return Object.freeze({ accepted: false, reason: "exact_join_fields_missing" });
  }
  if (eventBodyId !== bodyId) {
    return Object.freeze({ accepted: false, reason: "event_body_id_mismatch" });
  }
  if (row.join_method !== COMMITTEE_PROCEEDING_JOIN_METHOD) {
    return Object.freeze({ accepted: false, reason: "join_method_not_exact_event_body_id" });
  }
  if (meetingId !== `meeting:city_record:${requestId}`) {
    return Object.freeze({ accepted: false, reason: "meeting_id_mismatch" });
  }
  if (isNameOnlyCommitteeIdentity(row.committee_name) && !bodyId) {
    return Object.freeze({ accepted: false, reason: "name_only_committee" });
  }
  if (meetingOutcomes) {
    const outcome = outcomeForNotice(meetingOutcomes, requestId);
    if (!outcome || exactText(outcome.event?.event_id, 40) !== eventId) {
      return Object.freeze({ accepted: false, reason: "event_receipt_missing" });
    }
  }
  return Object.freeze({
    accepted: true,
    body_id: bodyId,
    request_id: requestId,
    meeting_id: meetingId,
    event_id: eventId,
    event_body_id: eventBodyId,
    join_method: COMMITTEE_PROCEEDING_JOIN_METHOD,
  });
}

function observationFrom(fields) {
  return sourceRecordObservation({
    sourceSystem: fields.sourceSystem,
    sourceRecordId: fields.sourceRecordId,
    sourceField: fields.sourceField,
    sourceValue: fields.sourceValue,
    sourceUrl: fields.sourceUrl,
    sourceDataset: fields.sourceDataset,
    observedAt: fields.observedAt,
  });
}

function decorate(edge, extras = {}) {
  if (!edge) return null;
  return Object.freeze({ ...edge, ...extras });
}

function hasCommitteeCandidate(node, generatedAt) {
  const bodyId = exactBodyId(node?.properties?.body_id);
  const provenance = node?.provenance?.source || {};
  return {
    subject: `civic-institution:${COUNCIL_CANONICAL_ID}`,
    object: `committee:${bodyId}`,
    objectDisplayName: exactText(node?.name) || `Committee ${bodyId}`,
    objectHref: `/committees/${encodeURIComponent(bodyId)}/`,
    subjectHref: `/agencies/${COUNCIL_CANONICAL_ID}/`,
    relation: "has_committee",
    method: "exact_source_identifier",
    confidence: "strong",
    basis: "exact_legistar_body_id",
    resolutionStatus: "accepted",
    vintage: `committee:${bodyId}`,
    asOf: generatedAt,
    sourceObservation: observationFrom({
      sourceSystem: provenance.system || "nyc_legistar_office_records",
      sourceRecordId: bodyId,
      sourceField: "officerecordbodyid",
      sourceValue: bodyId,
      sourceUrl: provenance.url || "https://webapi.legistar.com/v1/nyc/persons",
      sourceDataset: "nyc_legistar_office_records",
      observedAt: node?.provenance?.observed_at || generatedAt,
    }),
    evidenceRefs: [`committee:${bodyId}`, `legistar:body:${bodyId}`],
  };
}

function hostsMeetingCandidate(row, join, generatedAt) {
  return {
    subject: `committee:${join.body_id}`,
    object: join.meeting_id,
    objectDisplayName: exactText(row.committee_name, 240)
      ? `${exactText(row.committee_name, 240)} · ${join.request_id}`
      : join.request_id,
    objectHref: `/meetings/${encodeURIComponent(join.meeting_id)}`,
    subjectHref: `/committees/${encodeURIComponent(join.body_id)}/`,
    relation: "hosts_meeting",
    method: "exact_source_identifier",
    confidence: "strong",
    basis: COMMITTEE_PROCEEDING_JOIN_METHOD,
    resolutionStatus: "accepted",
    vintage: join.meeting_id,
    asOf: row.event_date || generatedAt,
    sourceObservation: observationFrom({
      sourceSystem: row.source_system || "nyc_legistar_events",
      sourceRecordId: join.event_id,
      sourceField: row.source_field || "eventbodyid",
      sourceValue: join.event_body_id,
      sourceUrl: row.source_url,
      sourceDataset: "nyc_legistar_events",
      observedAt: row.observed_at || generatedAt,
    }),
    evidenceRefs: [
      join.meeting_id,
      `city_record:${join.request_id}`,
      row.source_receipt || `legistar:event:${join.event_id}:eventbodyid`,
    ],
  };
}

function membershipCandidate(edge, relation, generatedAt) {
  const officialId = exactOfficialId(edge.from);
  const bodyId = exactBodyId(edge.to);
  const provenance = edge.provenance?.source || {};
  return {
    subject: `official:${officialId}`,
    object: `committee:${bodyId}`,
    objectDisplayName: exactText(edge.title, 160) || "Committee member",
    objectHref: `/committees/${encodeURIComponent(bodyId)}/`,
    subjectHref: `/officials/${encodeURIComponent(officialId)}/`,
    relation,
    method: "exact_source_identifier",
    confidence: "strong",
    basis: relation === "chairs" ? "exact_is_chair_valid_time" : "exact_member_of_valid_time",
    resolutionStatus: "accepted",
    vintage: provenance.id || `officerecord:${officialId}:${bodyId}`,
    asOf: edge.valid_from || generatedAt,
    validFrom: edge.valid_from,
    validTo: edge.valid_to || null,
    sourceObservation: observationFrom({
      sourceSystem: provenance.system || "nyc_legistar_office_records",
      sourceRecordId: provenance.id || `${officialId}:${bodyId}:${edge.source_row_hash || "row"}`,
      sourceField: relation === "chairs" ? "officerecordtitle" : "officerecordpersonid",
      sourceValue: relation === "chairs" ? exactText(edge.title, 160) : officialId,
      sourceUrl: edge.source_url || provenance.url,
      sourceDataset: "nyc_legistar_office_records",
      observedAt: edge.provenance?.observed_at || edge.retrieved_at || generatedAt,
    }),
    evidenceRefs: [
      `official:${officialId}`,
      `committee:${bodyId}`,
      provenance.id || edge.source_row_hash,
    ].filter(Boolean),
  };
}

function nameOnlyCandidate(name) {
  return {
    subject: `civic-institution:${COUNCIL_CANONICAL_ID}`,
    object: name,
    objectDisplayName: name,
    relation: "has_committee",
    method: "exact_source_identifier",
    confidence: "strong",
    basis: "name_only_committee",
    resolutionStatus: "accepted",
    sourceObservation: observationFrom({
      sourceSystem: "city_record",
      sourceRecordId: "name-only",
      sourceField: "short_title",
      sourceValue: name,
      sourceUrl: "https://a856-cityrecord.nyc.gov/",
      sourceDataset: "city_record",
      observedAt: "2026-07-21T00:00:00.000Z",
    }),
    evidenceRefs: [name],
  };
}

function publisherOnlyCandidate() {
  return {
    subject: `committee:${ZONING_FRANCHISES_BODY_ID}`,
    object: SPECIMEN_MEETING_ID,
    relation: "hosts_meeting",
    method: "exact_source_identifier",
    confidence: "strong",
    basis: "council_publisher",
    resolutionStatus: "unresolved",
    reason: "council_publisher_not_join",
    sourceObservation: observationFrom({
      sourceSystem: "city_record",
      sourceRecordId: SPECIMEN_MEETING_REQUEST_ID,
      sourceField: "agency_name",
      sourceValue: "City Council",
      sourceUrl: `https://a856-cityrecord.nyc.gov/RequestDetail/${SPECIMEN_MEETING_REQUEST_ID}`,
      sourceDataset: "city_record",
      observedAt: "2026-07-21T00:00:00.000Z",
    }),
    evidenceRefs: ["agency_name:City Council"],
  };
}

function nearbyDateCandidate() {
  return {
    subject: `committee:${ZONING_FRANCHISES_BODY_ID}`,
    object: SPECIMEN_MEETING_ID,
    relation: "hosts_meeting",
    method: "exact_source_identifier",
    confidence: "strong",
    basis: "nearby_date",
    resolutionStatus: "unresolved",
    reason: "nearby_date_not_join",
    sourceObservation: observationFrom({
      sourceSystem: "city_record",
      sourceRecordId: "nearby-date",
      sourceField: "event_date",
      sourceValue: "2026-07-22",
      sourceUrl: `https://a856-cityrecord.nyc.gov/RequestDetail/${SPECIMEN_MEETING_REQUEST_ID}`,
      sourceDataset: "city_record",
      observedAt: "2026-07-22T00:00:00.000Z",
    }),
    evidenceRefs: ["event_date:2026-07-22"],
  };
}

function considersGapCandidate(gap, generatedAt) {
  const meetingId = exactText(gap.meeting_id, 160) || SPECIMEN_MEETING_ID;
  const matterId = exactText(gap.target, 40) || TARGET_LAND_MATTER_ID;
  return {
    subject: meetingId,
    object: `land-matter:${matterId}`,
    objectDisplayName: matterId.replace("-", " "),
    relation: "considers",
    method: "exact_source_identifier",
    confidence: "strong",
    basis: gap.reason || MATTER_JOIN_UNAVAILABLE,
    resolutionStatus: "unresolved",
    reason: gap.reason || MATTER_JOIN_UNAVAILABLE,
    vintage: matterId,
    asOf: generatedAt,
    sourceObservation: observationFrom({
      sourceSystem: "cityscroll_proceeding_gaps",
      sourceRecordId: matterId,
      sourceField: "land_matter_id",
      sourceValue: matterId,
      sourceUrl: null,
      sourceDataset: "council_committee_proceedings",
      observedAt: generatedAt,
    }),
    evidenceRefs: [meetingId, `land-matter:${matterId}`],
  };
}

export function resolveCouncilCommitteeRoles(inputs = {}) {
  const graph = inputs.committeeGraph || inputs.graph || null;
  const proceedings = inputs.proceedings || defaultProceedings;
  const meetingOutcomes = inputs.meetingOutcomes || null;
  const generatedAt = isoObservedAt(
    graph?.generated_at || proceedings.generated_at || inputs.generatedAt,
  );
  const candidates = [];
  const extras = new Map();

  const node = committeeNode(graph, ZONING_FRANCHISES_BODY_ID);
  if (node) {
    const candidate = hasCommitteeCandidate(node, generatedAt);
    candidates.push(candidate);
    extras.set(`has_committee:${ZONING_FRANCHISES_COMMITTEE_ID}`, {
      body_id: ZONING_FRANCHISES_BODY_ID,
      join_method: "exact_legistar_body_id",
    });
  }

  for (const row of proceedingRows(proceedings)) {
    const join = verifyCommitteeMeetingJoin(row, { meetingOutcomes });
    if (!join.accepted) {
      candidates.push({
        subject: `committee:${exactBodyId(row.body_id) || ZONING_FRANCHISES_BODY_ID}`,
        object: exactText(row.meeting_id, 160) || SPECIMEN_MEETING_ID,
        relation: "hosts_meeting",
        method: "exact_source_identifier",
        confidence: "strong",
        basis: join.reason,
        resolutionStatus: "unresolved",
        reason: join.reason,
        sourceObservation: observationFrom({
          sourceSystem: "nyc_legistar_events",
          sourceRecordId: exactText(row.event_id, 40) || "event-missing",
          sourceField: "eventbodyid",
          sourceValue: exactText(row.event_body_id || row.body_id, 40) || "missing",
          sourceUrl: row.source_url,
          sourceDataset: "nyc_legistar_events",
          observedAt: row.observed_at || generatedAt,
        }),
        evidenceRefs: [exactText(row.request_id, 40) || "request-missing"],
      });
      continue;
    }
    if (!committeeNode(graph, join.body_id)) continue;
    const candidate = hostsMeetingCandidate(row, join, generatedAt);
    candidates.push(candidate);
    extras.set(`hosts_meeting:${join.meeting_id}`, {
      body_id: join.body_id,
      request_id: join.request_id,
      event_id: join.event_id,
      join_method: join.join_method,
      source_receipt: row.source_receipt,
      event_date: row.event_date || null,
      notice_href: `/notices/${encodeURIComponent(join.request_id)}`,
    });
  }

  for (const edge of Array.isArray(graph?.public_edges) ? graph.public_edges : []) {
    if (edge?.type !== "member_of" || exactBodyId(edge.to) !== ZONING_FRANCHISES_BODY_ID) continue;
    const officialId = exactOfficialId(edge.from);
    if (!officialId || !edge.valid_from) continue;
    const member = membershipCandidate(edge, "member_of", generatedAt);
    candidates.push(member);
    extras.set(`member_of:${officialId}`, {
      body_id: ZONING_FRANCHISES_BODY_ID,
      title: exactText(edge.title, 160),
      is_chair: edge.is_chair === true,
    });
    if (edge.is_chair === true) {
      const chair = membershipCandidate(edge, "chairs", generatedAt);
      candidates.push(chair);
      extras.set(`chairs:${officialId}`, {
        body_id: ZONING_FRANCHISES_BODY_ID,
        title: exactText(edge.title, 160),
        is_chair: true,
      });
    }
  }

  for (const gap of gapRows(proceedings)) {
    if (exactBodyId(gap.body_id) !== ZONING_FRANCHISES_BODY_ID) continue;
    if (gap.kind === "land-matter") {
      candidates.push(considersGapCandidate(gap, generatedAt));
    }
  }

  if (inputs.includeNegativeProbes) {
    candidates.push(nameOnlyCandidate("Subcommittee on Zoning and Franchises"));
    candidates.push(publisherOnlyCandidate());
    candidates.push(nearbyDateCandidate());
  }

  const resolved = resolveCivicInstitutionRoleEdges(candidates);
  const stamp = (edge) => {
    const key = `${edge.relation_id}:${edge.to}`;
    const alt = `${edge.relation_id}:${exactOfficialId(edge.from)}`;
    const extra = extras.get(key) || extras.get(alt) || {};
    return decorate(edge, extra);
  };
  return Object.freeze({
    accepted: Object.freeze(resolved.accepted.map(stamp)),
    held: Object.freeze(resolved.held.map(stamp)),
    unknown: Object.freeze(resolved.unknown.map(stamp)),
    unresolved: Object.freeze(resolved.unresolved.map(stamp)),
    gaps: Object.freeze(gapRows(proceedings).filter((gap) => (
      exactBodyId(gap.body_id) === ZONING_FRANCHISES_BODY_ID
    )).map((gap) => Object.freeze({ ...gap }))),
  });
}

function belongsTo(edge, canonicalId) {
  return edge?.subject_canonical_id === canonicalId || edge?.object_canonical_id === canonicalId
    || exactBodyId(edge?.from) === canonicalId || exactBodyId(edge?.to) === canonicalId
    || exactOfficialId(edge?.from) === canonicalId;
}

function orientForCouncil(edge, canonicalId) {
  if (canonicalId === COUNCIL_CANONICAL_ID) {
    if (edge.subject_canonical_id === COUNCIL_CANONICAL_ID) return edge;
    if (edge.object_canonical_id === COUNCIL_CANONICAL_ID) return invertCivicInstitutionRoleEdge(edge);
  }
  return edge;
}

export function councilCommitteeRolesForInstitution(canonicalId, inputs = {}) {
  if (canonicalId !== COUNCIL_CANONICAL_ID) {
    return Object.freeze({
      accepted: Object.freeze([]),
      held: Object.freeze([]),
      unknown: Object.freeze([]),
      unresolved: Object.freeze([]),
      gaps: Object.freeze([]),
    });
  }
  const resolved = resolveCouncilCommitteeRoles(inputs);
  const keep = (edge) => (
    edge.relation_id === "has_committee"
    || edge.relation_id === "part_of"
  );
  return Object.freeze({
    accepted: Object.freeze(resolved.accepted.filter(keep).map((edge) => orientForCouncil(edge, canonicalId))),
    held: Object.freeze(resolved.held.filter(keep)),
    unknown: Object.freeze(resolved.unknown.filter(keep)),
    unresolved: Object.freeze(resolved.unresolved.filter(keep)),
    gaps: resolved.gaps,
  });
}

export function councilCommitteeRolesForCommittee(bodyId, inputs = {}) {
  const id = exactBodyId(bodyId);
  if (id !== ZONING_FRANCHISES_BODY_ID) {
    return Object.freeze({
      accepted: Object.freeze([]),
      held: Object.freeze([]),
      unknown: Object.freeze([]),
      unresolved: Object.freeze([]),
      gaps: Object.freeze([]),
    });
  }
  const resolved = resolveCouncilCommitteeRoles(inputs);
  const keep = (edge) => (
    exactBodyId(edge.from) === id
    || exactBodyId(edge.to) === id
    || (edge.object_kind === "meeting" && edge.from_kind === "committee")
    || (edge.from_kind === "meeting" && edge.object_kind === "land-matter")
  );
  return Object.freeze({
    accepted: Object.freeze(resolved.accepted.filter(keep)),
    held: Object.freeze(resolved.held.filter(keep)),
    unknown: Object.freeze(resolved.unknown.filter(keep)),
    unresolved: Object.freeze(resolved.unresolved.filter(keep)),
    gaps: resolved.gaps,
  });
}

export function landMatterJoinState(roles) {
  const accepted = (roles?.accepted || []).find((edge) => edge.relation_id === "considers" && edge.status === "accepted");
  if (accepted) {
    return Object.freeze({
      status: "joined",
      matter_id: accepted.object_canonical_id,
      href: accepted.href,
      join_method: accepted.join_method || accepted.basis,
    });
  }
  const gap = (roles?.gaps || []).find((row) => row.kind === "land-matter")
    || { target: TARGET_LAND_MATTER_ID, reason: MATTER_JOIN_UNAVAILABLE, status: "unavailable" };
  return Object.freeze({
    status: "unavailable",
    matter_id: gap.target || TARGET_LAND_MATTER_ID,
    href: null,
    reason: gap.reason || MATTER_JOIN_UNAVAILABLE,
    label: gap.label || "Matter join unavailable",
  });
}

export { invertCivicInstitutionRoleEdge };
