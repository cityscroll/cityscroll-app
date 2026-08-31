/**
 * Source-qualified Borough President office, officeholder, proceeding, and
 * Community Board appointment-authority traversal.
 *
 * The Brooklyn office, Antonio Reynoso person-leader key, and City Record
 * proceedings mint civic-institution role edges. Geography, titles, board
 * rosters, and generic appointed-member wording never mint appointment.
 */

import {
  invertCivicInstitutionRoleEdge,
  resolveCivicInstitutionRoleEdges,
  sourceRecordObservation,
} from "../ontology/civic_institution.mjs";
import { renderNodeSection } from "./civic_document_chrome.mjs";

export const BROOKLYN_OFFICE_CANONICAL_ID = "borough-president-brooklyn";
export const BROOKLYN_OFFICE_SUBJECT = `civic-institution:${BROOKLYN_OFFICE_CANONICAL_ID}`;
export const BROOKLYN_OFFICE_AGENCY_REF = `agency:id:${BROOKLYN_OFFICE_CANONICAL_ID}`;
export const BROOKLYN_OFFICEHOLDER_NAME = "Antonio Reynoso";
export const BROOKLYN_CB15_BODY_ID = "brooklyn-cb-15";
export const BROOKLYN_CB15_SUBJECT = `community-board:${BROOKLYN_CB15_BODY_ID}`;
export const SPECIMEN_ULURP_NOTICE_IDS = Object.freeze(["20260618050", "20260601042"]);
export const SPECIMEN_BOROUGH_BOARD_NOTICE_ID = "20260518003";
export const SPECIMEN_OFFICE_NOTICE_IDS = Object.freeze([
  ...SPECIMEN_ULURP_NOTICE_IDS,
  SPECIMEN_BOROUGH_BOARD_NOTICE_ID,
]);
export const OFFICE_PROCEEDING_JOIN_METHOD = "exact_publisher_agency_identity";
export const BROOKLYN_OFFICE_NEGATIVE_RULE = "Never infer an appointment from a Borough President title, board geography, a person on a board roster, a publisher label, or generic appointed-member wording. Do not re-key a Community Board as an agency or mint a parent-child agency edge.";
export const APPOINTMENT_SOURCE_MISSING = "appointment_source_missing";
export const BROOKLYN_JURISDICTION = "Brooklyn";
export const OTI_CROSSWALK_URL = "https://data.cityofnewyork.us/d/t3jq-9nkf";
export const BROOKLYN_CB15_HOMEPAGE_URL = "https://www.nyc.gov/site/brooklyncb15/index.page";
export const BROOKLYN_CB15_MINUTES_URL = "https://www.nyc.gov/site/brooklyncb15/calendar/board-meeting-minutes.page";
export const BROOKLYN_CB15_DIRECTORY_URL = "https://www.nyc.gov/site/communityboards/about/brooklyn-boards.page";

const OFFICE_RELATIONS = Object.freeze(new Set([
  "holds_office",
  "officeholder_of",
  "hosts_meeting",
  "hosted_by",
  "appoints_members_of",
  "members_appointed_by",
]));

const OFFICIAL_APPOINTMENT_SOURCES = Object.freeze(new Set([
  "brooklyn_borough_president",
  "nyc_borough_president",
  "city_appointment",
  "mayor_community_board_appointments",
]));

const clean = (value, max = 500) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

function exactText(value, max = 500) {
  return clean(value, max);
}

function isoObservedAt(value) {
  const raw = exactText(value, 80);
  if (!raw) return "2026-08-09T00:00:00.000Z";
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${raw}T00:00:00.000Z`;
  if (!Number.isNaN(Date.parse(raw))) return raw;
  return "2026-08-09T00:00:00.000Z";
}

function dateOnly(value) {
  const match = exactText(value, 20).match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] || null;
}

function exactRequestId(value) {
  const id = exactText(value, 40);
  return /^\d{8,12}$/.test(id) ? id : "";
}

function exactBoardId(value) {
  const id = exactText(value, 80).toLowerCase().replace(/^community-board:/, "");
  return /^[a-z]+(?:-[a-z]+)*-cb-\d{2}$/.test(id) ? id : "";
}

function exactOfficeId(value) {
  return exactText(value, 160)
    .toLowerCase()
    .replace(/^civic-institution:/, "")
    .replace(/^agency:id:/, "");
}

function normalizeName(value) {
  return exactText(value, 240)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’']/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function personLeaderKey(agencyId, personName) {
  const agency = exactOfficeId(agencyId);
  const name = normalizeName(personName);
  return agency && name ? `person-leader:${agency}:name:${encodeURIComponent(name)}` : "";
}

export const BROOKLYN_OFFICEHOLDER_ID = personLeaderKey(
  BROOKLYN_OFFICE_CANONICAL_ID,
  BROOKLYN_OFFICEHOLDER_NAME,
);

export function isBoroughOfficeRelation(relation) {
  return OFFICE_RELATIONS.has(exactText(relation, 80).toLowerCase());
}

export function isGenericAppointedLabel(value) {
  const raw = normalizeName(value);
  if (!raw) return false;
  if (/appoints members of community board/.test(raw)) return false;
  if (/appointment authority/.test(raw) && /community board/.test(raw)) return false;
  return /^(appointed member|board member|member)$/.test(raw)
    || raw === "appointed"
    || raw === "appointed members";
}

function publisherNames(row) {
  const names = [
    exactText(row?.canonical_name, 240),
    ...(Array.isArray(row?.variants) ? row.variants.map((item) => exactText(item, 240)) : []),
  ].filter(Boolean);
  return new Set(names.map(normalizeName));
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

/**
 * Accept an office→meeting join only when the retained publisher identity
 * matches the notice agency_name and the request id is exact. Titles never
 * satisfy this gate.
 */
export function verifyOfficeMeetingJoin(row = {}, officeRow = {}) {
  const requestId = exactRequestId(row.request_id || row.publisher_identifier);
  const meetingId = exactText(row.meeting_id, 160) || (requestId ? `meeting:city_record:${requestId}` : "");
  const agencyName = exactText(row.agency_name, 240);
  if (!requestId || !meetingId) {
    return Object.freeze({ accepted: false, reason: "exact_join_fields_missing" });
  }
  if (!agencyName) {
    return Object.freeze({ accepted: false, reason: "title_only_not_join" });
  }
  const names = publisherNames(officeRow);
  if (!names.size || !names.has(normalizeName(agencyName))) {
    return Object.freeze({ accepted: false, reason: "publisher_identity_mismatch" });
  }
  if (meetingId !== `meeting:city_record:${requestId}`) {
    return Object.freeze({ accepted: false, reason: "meeting_id_mismatch" });
  }
  return Object.freeze({
    accepted: true,
    request_id: requestId,
    meeting_id: meetingId,
    join_method: OFFICE_PROCEEDING_JOIN_METHOD,
  });
}

function officialAppointmentSource(record) {
  const system = exactText(record?.source_system, 80).toLowerCase().replace(/[\s/:]+/g, "_");
  return OFFICIAL_APPOINTMENT_SOURCES.has(system);
}

/**
 * Board-level appointment authority requires an official source that names
 * the office, the exact Community Board body id, and the appointment scope.
 */
export function verifyAppointmentAuthority(record = {}, {
  officeId = BROOKLYN_OFFICE_CANONICAL_ID,
  boardId = BROOKLYN_CB15_BODY_ID,
} = {}) {
  if (!record || typeof record !== "object") {
    return Object.freeze({ accepted: false, reason: APPOINTMENT_SOURCE_MISSING });
  }
  if (record.inference === "geography" || record.basis === "geography" || record.basis === "geography_only") {
    return Object.freeze({ accepted: false, reason: "geography_not_appointment" });
  }
  if (record.inference === "title" || record.basis === "title_only") {
    return Object.freeze({ accepted: false, reason: "title_only_not_appointment" });
  }
  if (record.inference === "roster" || record.basis === "roster" || record.member_id || record.roster_only) {
    return Object.freeze({ accepted: false, reason: "roster_not_board_authority" });
  }
  const namedBoard = exactBoardId(record.board_id || record.body_id);
  const namedOffice = exactOfficeId(record.office_id || record.appointing_office || record.canonical_id);
  const wording = exactText(record.appointment_wording || record.source_value, 500);
  const scope = exactText(record.appointment_scope, 500);
  if (!namedBoard && !namedOffice && !wording) {
    return Object.freeze({ accepted: false, reason: APPOINTMENT_SOURCE_MISSING });
  }
  if (isGenericAppointedLabel(wording) || isGenericAppointedLabel(record.role_label)) {
    return Object.freeze({ accepted: false, reason: "generic_appointed_label" });
  }
  if (!officialAppointmentSource(record)) {
    return Object.freeze({ accepted: false, reason: "source_not_official_appointment" });
  }
  if (namedOffice && namedOffice !== exactOfficeId(officeId)) {
    return Object.freeze({ accepted: false, reason: "office_scope_mismatch" });
  }
  if (!namedBoard) {
    return Object.freeze({ accepted: false, reason: "board_scope_missing" });
  }
  if (namedBoard !== exactBoardId(boardId)) {
    return Object.freeze({ accepted: false, reason: "wrong_board" });
  }
  const scopeHay = scope.toLowerCase();
  const namesBoard = scopeHay.includes(namedBoard) || /\b15\b/.test(scopeHay);
  if (!scope || !/community board/i.test(scopeHay) || !namesBoard) {
    return Object.freeze({ accepted: false, reason: "scope_does_not_name_board" });
  }
  if (!wording || !/appoint/i.test(wording) || !/community board/i.test(wording)) {
    return Object.freeze({ accepted: false, reason: "appointment_wording_missing" });
  }
  return Object.freeze({
    accepted: true,
    office_id: exactOfficeId(officeId),
    board_id: namedBoard,
    join_method: "official_appointment_record",
  });
}

function publisherRowFrom(inputs) {
  return inputs.publisherRow
    || inputs.crosswalk?.entries?.[BROOKLYN_OFFICE_CANONICAL_ID]
    || inputs.crosswalk?.[BROOKLYN_OFFICE_CANONICAL_ID]
    || null;
}

function meetingRows(inputs) {
  const raw = inputs.meetings
    || inputs.meetingObservations
    || inputs.meetingsDomain?.meetings
    || inputs.meetingsDomain?.rows
    || [];
  return (Array.isArray(raw) ? raw : []).filter(Boolean);
}

function appointmentRecords(inputs) {
  const raw = inputs.appointmentRecords || inputs.appointments || [];
  return (Array.isArray(raw) ? raw : []).filter(Boolean);
}

function holdsOfficeCandidate(officeRow, generatedAt) {
  const name = exactText(officeRow?.head_name, 160);
  const personId = personLeaderKey(BROOKLYN_OFFICE_CANONICAL_ID, name);
  if (!name || !personId) return null;
  return {
    subject: BROOKLYN_OFFICE_SUBJECT,
    object: personId,
    objectDisplayName: name,
    objectHref: `/agencies/${BROOKLYN_OFFICE_CANONICAL_ID}/#agency-institution-office-roles`,
    subjectHref: `/agencies/${BROOKLYN_OFFICE_CANONICAL_ID}/`,
    relation: "holds_office",
    method: "exact_source_identifier",
    confidence: "strong",
    basis: "agency_crosswalk_head_v1",
    resolutionStatus: "accepted",
    vintage: personId,
    asOf: generatedAt,
    validFrom: dateOnly(officeRow.head_valid_from || officeRow.valid_from),
    validTo: dateOnly(officeRow.head_valid_to || officeRow.valid_to),
    sourceObservation: observationFrom({
      sourceSystem: "oti",
      sourceRecordId: BROOKLYN_OFFICE_CANONICAL_ID,
      sourceField: "head_name",
      sourceValue: name,
      sourceUrl: officeRow.url || OTI_CROSSWALK_URL,
      sourceDataset: "t3jq-9nkf",
      observedAt: generatedAt,
    }),
    evidenceRefs: [
      BROOKLYN_OFFICE_SUBJECT,
      personId,
      `oti:${BROOKLYN_OFFICE_CANONICAL_ID}:head_name`,
    ],
  };
}

function hostsMeetingCandidate(row, join, generatedAt) {
  return {
    subject: BROOKLYN_OFFICE_SUBJECT,
    object: join.meeting_id,
    objectDisplayName: exactText(row.short_title || row.title, 240) || join.request_id,
    objectHref: `/meetings/${encodeURIComponent(join.meeting_id)}`,
    subjectHref: `/agencies/${BROOKLYN_OFFICE_CANONICAL_ID}/`,
    relation: "hosts_meeting",
    method: "exact_source_identifier",
    confidence: "strong",
    basis: OFFICE_PROCEEDING_JOIN_METHOD,
    resolutionStatus: "accepted",
    vintage: join.meeting_id,
    asOf: row.event_date || row.start_date || generatedAt,
    sourceObservation: observationFrom({
      sourceSystem: row.source_system || "city_record",
      sourceRecordId: join.request_id,
      sourceField: "agency_name",
      sourceValue: exactText(row.agency_name, 240),
      sourceUrl: row.source_url || `https://a856-cityrecord.nyc.gov/RequestDetail/${join.request_id}`,
      sourceDataset: "city_record",
      observedAt: row.observed_at || row.start_date || generatedAt,
    }),
    evidenceRefs: [
      join.meeting_id,
      `city_record:${join.request_id}`,
      row.source_receipt || `city_record:${join.request_id}:agency_name`,
    ],
  };
}

function appointmentCandidate(record, join, generatedAt) {
  const sourceUrl = exactText(record.source_url, 2_000) || BROOKLYN_CB15_HOMEPAGE_URL;
  return {
    subject: BROOKLYN_OFFICE_SUBJECT,
    object: BROOKLYN_CB15_SUBJECT,
    objectDisplayName: "Brooklyn Community Board 15",
    objectHref: `/community-boards/${BROOKLYN_CB15_BODY_ID}/`,
    subjectHref: `/agencies/${BROOKLYN_OFFICE_CANONICAL_ID}/`,
    relation: "appoints_members_of",
    method: "exact_source_identifier",
    confidence: "strong",
    basis: join.join_method,
    resolutionStatus: "accepted",
    vintage: `community-board:${join.board_id}`,
    asOf: record.observed_at || generatedAt,
    validFrom: dateOnly(record.valid_from),
    validTo: dateOnly(record.valid_to),
    sourceObservation: observationFrom({
      sourceSystem: record.source_system,
      sourceRecordId: exactText(record.source_record_id, 240) || join.board_id,
      sourceField: exactText(record.source_field, 80) || "appointment_authority",
      sourceValue: exactText(record.source_value || record.appointment_wording, 500),
      sourceUrl,
      sourceDataset: exactText(record.source_system, 80),
      observedAt: record.observed_at || generatedAt,
    }),
    evidenceRefs: [
      BROOKLYN_OFFICE_SUBJECT,
      BROOKLYN_CB15_SUBJECT,
      exactText(record.source_record_id, 240) || sourceUrl,
    ],
  };
}

function appointmentGapCandidate(reason, generatedAt, extras = {}) {
  return {
    subject: BROOKLYN_OFFICE_SUBJECT,
    object: extras.object || BROOKLYN_CB15_SUBJECT,
    objectDisplayName: extras.objectDisplayName || "Brooklyn Community Board 15",
    objectHref: `/community-boards/${BROOKLYN_CB15_BODY_ID}/`,
    subjectHref: `/agencies/${BROOKLYN_OFFICE_CANONICAL_ID}/`,
    relation: "appoints_members_of",
    method: "exact_source_identifier",
    confidence: "strong",
    basis: reason,
    resolutionStatus: "unresolved",
    reason,
    vintage: BROOKLYN_CB15_SUBJECT,
    asOf: generatedAt,
    sourceObservation: observationFrom({
      sourceSystem: extras.sourceSystem || "community_board_source_registry",
      sourceRecordId: extras.sourceRecordId || BROOKLYN_CB15_BODY_ID,
      sourceField: extras.sourceField || "body_id",
      sourceValue: extras.sourceValue || BROOKLYN_CB15_BODY_ID,
      sourceUrl: extras.sourceUrl || BROOKLYN_CB15_HOMEPAGE_URL,
      sourceDataset: extras.sourceDataset || "community_board_source_registry",
      observedAt: generatedAt,
    }),
    evidenceRefs: [BROOKLYN_OFFICE_SUBJECT, extras.object || BROOKLYN_CB15_SUBJECT],
  };
}

function titleOnlyMeetingCandidate(generatedAt) {
  return {
    subject: BROOKLYN_OFFICE_SUBJECT,
    object: `meeting:city_record:${SPECIMEN_BOROUGH_BOARD_NOTICE_ID}`,
    relation: "hosts_meeting",
    method: "exact_source_identifier",
    confidence: "strong",
    basis: "title_only_not_join",
    resolutionStatus: "unresolved",
    reason: "title_only_not_join",
    sourceObservation: observationFrom({
      sourceSystem: "city_record",
      sourceRecordId: SPECIMEN_BOROUGH_BOARD_NOTICE_ID,
      sourceField: "short_title",
      sourceValue: "Brooklyn Borough President ULURP Public Hearing",
      sourceUrl: `https://a856-cityrecord.nyc.gov/RequestDetail/${SPECIMEN_BOROUGH_BOARD_NOTICE_ID}`,
      sourceDataset: "city_record",
      observedAt: generatedAt,
    }),
    evidenceRefs: ["short_title"],
  };
}

function publisherOnlyAppointmentCandidate(generatedAt) {
  return appointmentGapCandidate("source_not_official_appointment", generatedAt, {
    sourceSystem: "city_record",
    sourceRecordId: SPECIMEN_BOROUGH_BOARD_NOTICE_ID,
    sourceField: "agency_name",
    sourceValue: "Borough President - Brooklyn",
    sourceUrl: `https://a856-cityrecord.nyc.gov/RequestDetail/${SPECIMEN_BOROUGH_BOARD_NOTICE_ID}`,
    sourceDataset: "city_record",
  });
}

export function resolveBoroughOfficeRoles(inputs = {}) {
  const officeRow = publisherRowFrom(inputs);
  const generatedAt = isoObservedAt(inputs.generatedAt || officeRow?.observed_at);
  const candidates = [];
  const extras = new Map();

  if (officeRow?.head_name) {
    const candidate = holdsOfficeCandidate(officeRow, generatedAt);
    if (candidate) {
      candidates.push(candidate);
      extras.set(`holds_office:${candidate.object}`, {
        person_leader_id: candidate.object,
        officeholder_name: candidate.objectDisplayName,
        jurisdiction: BROOKLYN_JURISDICTION,
        head_title: exactText(officeRow.head_title, 160),
        join_method: "agency_crosswalk_head_v1",
        source_receipt: `oti:${BROOKLYN_OFFICE_CANONICAL_ID}:head_name`,
      });
    }
  }

  for (const row of meetingRows(inputs)) {
    const requestId = exactRequestId(row.request_id || row.publisher_identifier);
    if (requestId && !SPECIMEN_OFFICE_NOTICE_IDS.includes(requestId)) continue;
    const join = verifyOfficeMeetingJoin(row, officeRow || {});
    if (!join.accepted) {
      candidates.push({
        subject: BROOKLYN_OFFICE_SUBJECT,
        object: exactText(row.meeting_id, 160) || `meeting:city_record:${requestId || SPECIMEN_BOROUGH_BOARD_NOTICE_ID}`,
        relation: "hosts_meeting",
        method: "exact_source_identifier",
        confidence: "strong",
        basis: join.reason,
        resolutionStatus: "unresolved",
        reason: join.reason,
        sourceObservation: observationFrom({
          sourceSystem: "city_record",
          sourceRecordId: requestId || "meeting-missing",
          sourceField: row.agency_name ? "agency_name" : "short_title",
          sourceValue: exactText(row.agency_name || row.short_title || row.title, 240) || "missing",
          sourceUrl: row.source_url || null,
          sourceDataset: "city_record",
          observedAt: row.observed_at || generatedAt,
        }),
        evidenceRefs: [requestId || "request-missing"],
      });
      extras.set(`hosts_meeting:${requestId || "missing"}`, { join_method: join.reason });
      continue;
    }
    const candidate = hostsMeetingCandidate(row, join, generatedAt);
    candidates.push(candidate);
    extras.set(`hosts_meeting:${join.meeting_id}`, {
      request_id: join.request_id,
      join_method: join.join_method,
      jurisdiction: BROOKLYN_JURISDICTION,
      source_receipt: row.source_receipt || `city_record:${join.request_id}:agency_name`,
      notice_href: `/notices/${encodeURIComponent(join.request_id)}`,
    });
  }

  const records = appointmentRecords(inputs);
  let appointmentAccepted = false;
  for (const record of records) {
    const join = verifyAppointmentAuthority(record, {
      officeId: BROOKLYN_OFFICE_CANONICAL_ID,
      boardId: BROOKLYN_CB15_BODY_ID,
    });
    if (!join.accepted) {
      candidates.push(appointmentGapCandidate(join.reason, generatedAt, {
        object: exactBoardId(record.board_id || record.body_id)
          ? `community-board:${exactBoardId(record.board_id || record.body_id)}`
          : BROOKLYN_CB15_SUBJECT,
        sourceSystem: record.source_system || "community_board_source_registry",
        sourceRecordId: exactText(record.source_record_id, 240) || BROOKLYN_CB15_BODY_ID,
        sourceField: exactText(record.source_field, 80) || "body_id",
        sourceValue: exactText(record.source_value || record.appointment_wording || record.board_id, 500)
          || BROOKLYN_CB15_BODY_ID,
        sourceUrl: record.source_url || BROOKLYN_CB15_HOMEPAGE_URL,
        sourceDataset: exactText(record.source_system, 80) || "community_board_source_registry",
      }));
      extras.set(`appoints_members_of:${join.reason}`, {
        join_method: join.reason,
        jurisdiction: BROOKLYN_JURISDICTION,
        body_id: exactBoardId(record.board_id || record.body_id) || BROOKLYN_CB15_BODY_ID,
      });
      continue;
    }
    if (join.board_id !== BROOKLYN_CB15_BODY_ID) continue;
    const candidate = appointmentCandidate(record, join, generatedAt);
    candidates.push(candidate);
    appointmentAccepted = true;
    extras.set(`appoints_members_of:${BROOKLYN_CB15_SUBJECT}`, {
      body_id: BROOKLYN_CB15_BODY_ID,
      join_method: join.join_method,
      jurisdiction: BROOKLYN_JURISDICTION,
      appointment_scope: exactText(record.appointment_scope, 500),
      source_receipt: exactText(record.source_record_id, 240) || record.source_url,
    });
  }
  if (!appointmentAccepted && !records.length) {
    candidates.push(appointmentGapCandidate(APPOINTMENT_SOURCE_MISSING, generatedAt));
    extras.set(`appoints_members_of:${BROOKLYN_CB15_SUBJECT}`, {
      body_id: BROOKLYN_CB15_BODY_ID,
      join_method: APPOINTMENT_SOURCE_MISSING,
      jurisdiction: BROOKLYN_JURISDICTION,
      source_receipt: BROOKLYN_CB15_HOMEPAGE_URL,
    });
  }

  if (inputs.includeNegativeProbes) {
    candidates.push(titleOnlyMeetingCandidate(generatedAt));
    candidates.push(publisherOnlyAppointmentCandidate(generatedAt));
    candidates.push(appointmentGapCandidate("geography_not_appointment", generatedAt, {
      sourceField: "borough",
      sourceValue: "Brooklyn",
    }));
    candidates.push(appointmentGapCandidate("roster_not_board_authority", generatedAt, {
      sourceSystem: "community_board_roster",
      sourceRecordId: "roster-member-1",
      sourceField: "role_label",
      sourceValue: "appointed member",
    }));
    candidates.push(appointmentGapCandidate("generic_appointed_label", generatedAt, {
      sourceField: "role_label",
      sourceValue: "appointed member",
    }));
    candidates.push(appointmentGapCandidate("wrong_board", generatedAt, {
      object: "community-board:brooklyn-cb-01",
      objectDisplayName: "Brooklyn Community Board 1",
      sourceRecordId: "brooklyn-cb-01",
      sourceValue: "brooklyn-cb-01",
    }));
  }

  const resolved = resolveCivicInstitutionRoleEdges(candidates);
  const stamp = (edge) => {
    const key = `${edge.relation_id}:${edge.to}`;
    const extra = extras.get(key) || extras.get(`${edge.relation_id}:${edge.reason}`) || {};
    return decorate(edge, extra);
  };
  return Object.freeze({
    accepted: Object.freeze(resolved.accepted.map(stamp)),
    held: Object.freeze(resolved.held.map(stamp)),
    unknown: Object.freeze(resolved.unknown.map(stamp)),
    unresolved: Object.freeze(resolved.unresolved.map(stamp)),
  });
}

function belongsToOffice(edge, canonicalId) {
  return edge?.subject_canonical_id === canonicalId
    || exactOfficeId(edge?.from) === canonicalId
    || exactOfficeId(edge?.to) === canonicalId
    || (edge?.from_kind === "person-leader" && String(edge.from || "").includes(`:${canonicalId}:`))
    || (edge?.object_kind === "person-leader" && String(edge.to || "").includes(`:${canonicalId}:`));
}

function orientForOffice(edge, canonicalId) {
  if (exactOfficeId(edge.from) === canonicalId || edge.subject_canonical_id === canonicalId) return edge;
  if (exactOfficeId(edge.to) === canonicalId || edge.object_canonical_id === canonicalId) {
    return invertCivicInstitutionRoleEdge(edge);
  }
  if (edge.from_kind === "person-leader" && String(edge.from || "").includes(`:${canonicalId}:`)) return edge;
  return edge;
}

export function boroughOfficeRolesForInstitution(canonicalId, inputs = {}) {
  if (exactOfficeId(canonicalId) !== BROOKLYN_OFFICE_CANONICAL_ID) {
    return Object.freeze({
      accepted: Object.freeze([]),
      held: Object.freeze([]),
      unknown: Object.freeze([]),
      unresolved: Object.freeze([]),
    });
  }
  const resolved = resolveBoroughOfficeRoles(inputs);
  const keep = (edge) => belongsToOffice(edge, BROOKLYN_OFFICE_CANONICAL_ID);
  return Object.freeze({
    accepted: Object.freeze(resolved.accepted.filter(keep).map((edge) => orientForOffice(edge, BROOKLYN_OFFICE_CANONICAL_ID))),
    held: Object.freeze(resolved.held.filter(keep)),
    unknown: Object.freeze(resolved.unknown.filter(keep)),
    unresolved: Object.freeze(resolved.unresolved.filter(keep)),
  });
}

export function boroughOfficeRolesForBoard(bodyId, inputs = {}) {
  const id = exactBoardId(bodyId);
  if (id !== BROOKLYN_CB15_BODY_ID) {
    return Object.freeze({
      accepted: Object.freeze([]),
      held: Object.freeze([]),
      unknown: Object.freeze([]),
      unresolved: Object.freeze([]),
    });
  }
  const resolved = resolveBoroughOfficeRoles(inputs);
  const keep = (edge) => (
    edge.relation_id === "appoints_members_of"
    || edge.relation_id === "members_appointed_by"
  ) && (exactBoardId(edge.to) === id || exactBoardId(edge.from) === id || edge.object_canonical_id === id);
  const orient = (edge) => (
    exactBoardId(edge.from) === id ? edge : invertCivicInstitutionRoleEdge(edge)
  );
  return Object.freeze({
    accepted: Object.freeze(resolved.accepted.filter(keep).map(orient)),
    held: Object.freeze(resolved.held.filter(keep).map(orient)),
    unknown: Object.freeze(resolved.unknown.filter(keep)),
    unresolved: Object.freeze(resolved.unresolved.filter(keep).map(orient)),
  });
}

const esc = (value) => String(value ?? "").replace(/[<>&"']/g, (char) => ({
  "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
}[char]));

function appointmentRow(edge) {
  const href = edge.linking ? edge.href : "/agencies/borough-president-brooklyn/";
  const label = edge.linking
    ? (edge.object_display_name || "Office of the Borough President of Brooklyn")
    : "Office of the Borough President of Brooklyn";
  const details = [
    edge.status === "accepted"
      ? "Board-level appointment authority"
      : "No official appointment source names this board and scope yet",
    edge.jurisdiction ? `Jurisdiction ${edge.jurisdiction}` : "",
  ].filter(Boolean).join(" · ");
  return `<li class="node-record agency-role-edge-record" data-role-relation="${esc(edge.relation_id || "")}" data-role-status="${esc(edge.status || "")}" data-role-linking="${edge.linking ? "1" : "0"}" data-body-id="${esc(edge.body_id || BROOKLYN_CB15_BODY_ID)}" data-jurisdiction="${esc(edge.jurisdiction || "")}" data-join-method="${esc(edge.join_method || "")}">
    <div class="node-record-main"><a class="ui-constellation-link agency-edge-link" href="${esc(href)}">${esc(label)}</a></div>
    <span class="muted node-muted">${esc(details)}</span>
  </li>`;
}

export function renderBoroughOfficeAppointmentSection(roles = {}) {
  const rows = [
    ...(roles.accepted || []),
    ...(roles.unresolved || []),
  ].filter((edge) => (
    edge?.relation_id === "appoints_members_of" || edge?.relation_id === "members_appointed_by"
  ));
  if (!rows.length) return "";
  const body = `<p class="node-muted">Appointment authority is a role of the Borough President office. A board roster, shared geography, or a generic appointed-member label is not an individual appointment.</p>
    <ul class="node-record-list">${rows.map(appointmentRow).join("")}</ul>`;
  return renderNodeSection({
    heading: "Appointment authority",
    headingId: "community-board-appointment-authority-heading",
    exportClass: "object_role_edges",
    extraClass: "node-card civic-object-section community-board-appointment-authority",
    attrs: {
      id: "community-board-appointment-authority",
      "data-appointment-authority": "1",
      "data-role-schema": "cityscroll.civic_institution_role_edge.v1",
    },
    body,
  });
}

export function boroughOfficeSourcesFrom({
  publisherRow = null,
  meetings = [],
  appointmentRecords: records = [],
  generatedAt = null,
} = {}) {
  if (!publisherRow && !meetings.length && !records.length) return null;
  return {
    publisherRow,
    meetings,
    appointmentRecords: records,
    generatedAt,
  };
}

export { invertCivicInstitutionRoleEdge };
