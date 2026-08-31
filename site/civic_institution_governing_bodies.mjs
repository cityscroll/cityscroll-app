/**
 * Source-qualified governing board and committee traversal.
 *
 * NYCHA Board and Audit and Finance Committee mint civic-institution role
 * edges only from official governance records plus retained City Record
 * meetings. BERS Board of Trustees and Executive Committee stay unresolved
 * until parent identity and a retained meeting receipt exist together.
 * Generic board titles, OTI buckets, vendor/staffing rows, and calendar
 * targets never mint a governing edge.
 */

import {
  invertCivicInstitutionRoleEdge,
  resolveCivicInstitutionRoleEdges,
  sourceRecordObservation,
} from "../ontology/civic_institution.mjs";
import defaultProceedings from "./data/governing_body_proceedings.json" with { type: "json" };

export const NYCHA_CANONICAL_ID = "housing-authority";
export const NYCHA_BOARD_ID = "nycha-board";
export const NYCHA_BOARD_REF = `board:${NYCHA_BOARD_ID}`;
export const NYCHA_AUDIT_FINANCE_ID = "nycha-audit-finance";
export const NYCHA_AUDIT_FINANCE_REF = `committee:${NYCHA_AUDIT_FINANCE_ID}`;
export const NYCHA_BOARD_MEETING_ID = "20260624001";
export const NYCHA_AUDIT_MEETING_ID = "20260625034";
export const NYCHA_BOARD_MEETING_REF = `meeting:city_record:${NYCHA_BOARD_MEETING_ID}`;
export const NYCHA_AUDIT_MEETING_REF = `meeting:city_record:${NYCHA_AUDIT_MEETING_ID}`;
export const BERS_CROSSWALK_ID = "board-of-education-retirement-system";
export const BERS_ROUTE_ID = "employees-retirement-system";
export const BERS_BOARD_ID = "bers-board-of-trustees";
export const BERS_EXECUTIVE_ID = "bers-executive";
export const BERS_TARGET_MEETING_DATE = "2026-07-15";
export const GOVERNING_MEETING_JOIN_METHOD = "exact_official_body_and_publisher_meeting";
export const GOVERNING_BODY_JOIN_METHOD = "exact_official_governance_record";
export const GOVERNING_BODY_NEGATIVE_RULE = "Never infer a NYCHA Board from a housing-authority contract, a BERS committee from a similarly named NYCHA notice, or a July 15 meeting from an expected calendar target without a retained record. Do not merge BERS with NYCHA because OTI assigns both to a public-benefit or pension bucket. Generic board titles, route spelling, vendor evidence, and staffing evidence never mint a governing edge.";
export const NYCHA_BOARD_SOURCE_URL = "https://www.nyc.gov/site/nycha/about/board-meetings.page";
export const NYCHA_AUDIT_SOURCE_URL = "https://www.nyc.gov/site/nycha/about/audit-committee-meetings.page";
export const BERS_BOARD_SOURCE_URL = "https://www.bers.nyc.gov/site/bers/about/board-of-trustees.page";

const GOVERNANCE_RELATIONS = Object.freeze(new Set([
  "governed_by",
  "governing_body_of",
  "has_committee",
  "part_of",
  "hosts_meeting",
  "hosted_by",
]));

const GOVERNING_INSTITUTION_IDS = Object.freeze(new Set([
  NYCHA_CANONICAL_ID,
  BERS_CROSSWALK_ID,
  BERS_ROUTE_ID,
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
  if (!raw) return "2026-08-31T00:00:00.000Z";
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${raw}T00:00:00.000Z`;
  if (!Number.isNaN(Date.parse(raw))) return raw;
  return "2026-08-31T00:00:00.000Z";
}

function exactRequestId(value) {
  const id = exactText(value, 40);
  return /^\d{8,12}$/.test(id) ? id : "";
}

function exactSlug(value) {
  const id = exactText(value, 160)
    .toLowerCase()
    .replace(/^board:/, "")
    .replace(/^committee:/, "");
  return /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/.test(id) ? id : "";
}

function exactInstitutionId(value) {
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

export function isGoverningBodyRelation(relation) {
  return GOVERNANCE_RELATIONS.has(exactText(relation, 80).toLowerCase());
}

export function isGenericBoardTitle(value) {
  const raw = normalizeName(value);
  if (!raw) return false;
  return /^(board|the board|governing board|board of trustees|board meeting|committee|audit committee|executive committee)$/.test(raw);
}

export function isOtiBucketSimilarity(left, right) {
  const a = normalizeName(left);
  const b = normalizeName(right);
  if (!a || !b || a !== b) return false;
  return /public benefit|development organization|pension fund/.test(a);
}

function publisherNames(row) {
  const names = [
    exactText(row?.canonical_name, 240),
    exactText(row?.acronym, 40),
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

function bodyById(proceedings, bodyId) {
  const id = exactSlug(bodyId);
  return [...bodies(proceedings), ...committees(proceedings)].find((row) => exactSlug(row.body_id) === id) || null;
}

function bodies(proceedings) {
  return (Array.isArray(proceedings?.bodies) ? proceedings.bodies : []).filter(Boolean);
}

function committees(proceedings) {
  return (Array.isArray(proceedings?.committees) ? proceedings.committees : []).filter(Boolean);
}

function meetings(proceedings) {
  return (Array.isArray(proceedings?.meetings) ? proceedings.meetings : []).filter(Boolean);
}

function gapRows(proceedings) {
  return (Array.isArray(proceedings?.gaps) ? proceedings.gaps : []).filter(Boolean);
}

function identityRows(proceedings) {
  return (Array.isArray(proceedings?.identities) ? proceedings.identities : []).filter(Boolean);
}

export function parentIdentityIsVerified(row = {}, identities = []) {
  const parent = exactInstitutionId(row.parent_institution_id);
  if (!parent) return false;
  if (row.identity_status === "unresolved") return false;
  const match = identities.find((item) => (
    exactInstitutionId(item.crosswalk_key) === parent
    || exactInstitutionId(item.route_key) === parent
  ));
  if (!match) return parent === NYCHA_CANONICAL_ID && row.identity_status === "accepted";
  return match.status === "accepted" && exactInstitutionId(match.route_key) === exactInstitutionId(match.crosswalk_key);
}

/**
 * Accept a governing-body or committee meeting only when the official body
 * id, parent institution, publisher identity, and retained request id agree.
 * Titles, OTI buckets, and calendar dates never satisfy this gate.
 */
export function verifyGoverningMeetingJoin(row = {}, body = {}, publisherRow = {}) {
  const requestId = exactRequestId(row.request_id);
  const meetingId = exactText(row.meeting_id, 160) || (requestId ? `meeting:city_record:${requestId}` : "");
  const bodyId = exactSlug(row.body_id || body.body_id);
  const parentId = exactInstitutionId(row.parent_institution_id || body.parent_institution_id);
  if (row.basis === "calendar_target" || row.join_method === "calendar_target") {
    return Object.freeze({ accepted: false, reason: "calendar_target_not_join" });
  }
  if (row.basis === "oti_bucket" || row.join_method === "oti_bucket") {
    return Object.freeze({ accepted: false, reason: "oti_bucket_not_join" });
  }
  if (row.basis === "vendor_row" || row.basis === "staffing_row") {
    return Object.freeze({ accepted: false, reason: "record_category_not_governing_edge" });
  }
  if (!requestId || !meetingId || !bodyId || !parentId) {
    return Object.freeze({ accepted: false, reason: "exact_join_fields_missing" });
  }
  if (!exactText(row.agency_name, 240) || isGenericBoardTitle(row.title || row.agency_name)) {
    return Object.freeze({ accepted: false, reason: "title_only_not_join" });
  }
  if (row.join_method !== GOVERNING_MEETING_JOIN_METHOD) {
    return Object.freeze({ accepted: false, reason: "join_method_not_exact_official_body" });
  }
  if (meetingId !== `meeting:city_record:${requestId}`) {
    return Object.freeze({ accepted: false, reason: "meeting_id_mismatch" });
  }
  if (exactSlug(body.body_id) !== bodyId) {
    return Object.freeze({ accepted: false, reason: "body_id_mismatch" });
  }
  if (exactInstitutionId(body.parent_institution_id) !== parentId) {
    return Object.freeze({ accepted: false, reason: "parent_institution_mismatch" });
  }
  const names = publisherNames(publisherRow);
  if (!names.size || !names.has(normalizeName(row.agency_name))) {
    return Object.freeze({ accepted: false, reason: "publisher_identity_mismatch" });
  }
  return Object.freeze({
    accepted: true,
    request_id: requestId,
    meeting_id: meetingId,
    body_id: bodyId,
    parent_institution_id: parentId,
    join_method: GOVERNING_MEETING_JOIN_METHOD,
  });
}

function agencyHref(canonicalId) {
  return `/agencies/${encodeURIComponent(canonicalId)}/`;
}

function governanceHref(canonicalId, bodyId) {
  return `${agencyHref(canonicalId)}#governance-${encodeURIComponent(bodyId)}`;
}

function governedByCandidate(body, generatedAt) {
  const parentId = exactInstitutionId(body.parent_institution_id);
  const bodyId = exactSlug(body.body_id);
  return {
    subject: `civic-institution:${parentId}`,
    object: `board:${bodyId}`,
    objectDisplayName: exactText(body.name, 240) || "Board",
    objectHref: governanceHref(parentId, bodyId),
    subjectHref: agencyHref(parentId),
    relation: "governed_by",
    method: "exact_source_identifier",
    confidence: "strong",
    basis: GOVERNING_BODY_JOIN_METHOD,
    resolutionStatus: "accepted",
    vintage: `board:${bodyId}`,
    asOf: body.observed_at || generatedAt,
    sourceObservation: observationFrom({
      sourceSystem: body.source_system,
      sourceRecordId: body.source_record_id,
      sourceField: body.source_field,
      sourceValue: body.source_value,
      sourceUrl: body.source_url,
      sourceDataset: body.source_system,
      observedAt: body.observed_at || generatedAt,
    }),
    evidenceRefs: [
      `board:${bodyId}`,
      `civic-institution:${parentId}`,
      body.source_receipt || body.source_url,
    ].filter(Boolean),
  };
}

function hasCommitteeCandidate(committee, generatedAt) {
  const boardId = exactSlug(committee.parent_board_id);
  const bodyId = exactSlug(committee.body_id);
  const parentId = exactInstitutionId(committee.parent_institution_id);
  return {
    subject: `board:${boardId}`,
    object: `committee:${bodyId}`,
    objectDisplayName: exactText(committee.name, 240) || "Committee",
    objectHref: governanceHref(parentId, bodyId),
    subjectHref: governanceHref(parentId, boardId),
    relation: "has_committee",
    method: "exact_source_identifier",
    confidence: "strong",
    basis: "exact_official_committee_record",
    resolutionStatus: "accepted",
    vintage: `committee:${bodyId}`,
    asOf: committee.observed_at || generatedAt,
    sourceObservation: observationFrom({
      sourceSystem: committee.source_system,
      sourceRecordId: committee.source_record_id,
      sourceField: committee.source_field,
      sourceValue: committee.source_value,
      sourceUrl: committee.source_url,
      sourceDataset: committee.source_system,
      observedAt: committee.observed_at || generatedAt,
    }),
    evidenceRefs: [
      `board:${boardId}`,
      `committee:${bodyId}`,
      committee.source_receipt || committee.source_url,
    ].filter(Boolean),
  };
}

function hostsMeetingCandidate(row, join, generatedAt) {
  const kind = exactText(row.body_kind, 40) === "board" ? "board" : "committee";
  const parentId = join.parent_institution_id;
  return {
    subject: `${kind}:${join.body_id}`,
    object: join.meeting_id,
    objectDisplayName: exactText(row.title, 240) || join.request_id,
    objectHref: `/notices/${encodeURIComponent(join.request_id)}`,
    subjectHref: governanceHref(parentId, join.body_id),
    relation: "hosts_meeting",
    method: "exact_source_identifier",
    confidence: "strong",
    basis: GOVERNING_MEETING_JOIN_METHOD,
    resolutionStatus: "accepted",
    vintage: join.meeting_id,
    asOf: row.event_date || generatedAt,
    sourceObservation: observationFrom({
      sourceSystem: row.source_system || "city_record",
      sourceRecordId: join.request_id,
      sourceField: row.source_field || "request_id",
      sourceValue: join.request_id,
      sourceUrl: row.source_url,
      sourceDataset: "city_record",
      observedAt: row.observed_at || generatedAt,
    }),
    evidenceRefs: [
      join.meeting_id,
      `city_record:${join.request_id}`,
      row.source_receipt || `city_record:${join.request_id}:request_id`,
    ],
  };
}

function unresolvedCandidate({
  subject,
  object,
  relation,
  reason,
  sourceSystem,
  sourceRecordId,
  sourceField,
  sourceValue,
  sourceUrl,
  observedAt,
  evidenceRefs,
}) {
  return {
    subject,
    object,
    relation,
    method: "exact_source_identifier",
    confidence: "strong",
    basis: reason,
    resolutionStatus: "unresolved",
    reason,
    sourceObservation: observationFrom({
      sourceSystem,
      sourceRecordId,
      sourceField,
      sourceValue,
      sourceUrl,
      sourceDataset: sourceSystem,
      observedAt,
    }),
    evidenceRefs,
  };
}

function genericBoardCandidate() {
  return unresolvedCandidate({
    subject: `civic-institution:${NYCHA_CANONICAL_ID}`,
    object: "board:generic-board",
    relation: "governed_by",
    reason: "generic_board_title",
    sourceSystem: "city_record",
    sourceRecordId: "generic-board",
    sourceField: "short_title",
    sourceValue: "Board Meeting",
    sourceUrl: "https://a856-cityrecord.nyc.gov/",
    observedAt: "2026-07-16T00:00:00.000Z",
    evidenceRefs: ["Board Meeting"],
  });
}

function similarCommitteeCandidate() {
  return unresolvedCandidate({
    subject: `board:${BERS_BOARD_ID}`,
    object: NYCHA_AUDIT_FINANCE_REF,
    relation: "has_committee",
    reason: "similar_committee_name",
    sourceSystem: "city_record",
    sourceRecordId: NYCHA_AUDIT_MEETING_ID,
    sourceField: "short_title",
    sourceValue: "NYCHA Audit and Finance Committee Meeting.",
    sourceUrl: `https://a856-cityrecord.nyc.gov/RequestDetail/${NYCHA_AUDIT_MEETING_ID}`,
    observedAt: "2026-07-01T00:00:00.000Z",
    evidenceRefs: [NYCHA_AUDIT_MEETING_REF],
  });
}

function otiBucketCandidate() {
  return unresolvedCandidate({
    subject: `civic-institution:${BERS_CROSSWALK_ID}`,
    object: NYCHA_BOARD_REF,
    relation: "governed_by",
    reason: "oti_bucket_not_join",
    sourceSystem: "oti",
    sourceRecordId: BERS_CROSSWALK_ID,
    sourceField: "org_type",
    sourceValue: "Public Benefit or Development Organization",
    sourceUrl: "https://data.cityofnewyork.us/d/t3jq-9nkf",
    observedAt: "2026-08-31T00:00:00.000Z",
    evidenceRefs: ["oti:org_type"],
  });
}

function calendarTargetCandidate() {
  return unresolvedCandidate({
    subject: `committee:${BERS_EXECUTIVE_ID}`,
    object: "meeting:city_record:20260715000",
    relation: "hosts_meeting",
    reason: "calendar_target_not_join",
    sourceSystem: "bers_official",
    sourceRecordId: "bers-july-15-target",
    sourceField: "expected_meeting_date",
    sourceValue: BERS_TARGET_MEETING_DATE,
    sourceUrl: BERS_BOARD_SOURCE_URL,
    observedAt: "2026-08-31T00:00:00.000Z",
    evidenceRefs: [BERS_TARGET_MEETING_DATE],
  });
}

function vendorStaffingCandidate() {
  return unresolvedCandidate({
    subject: `civic-institution:${BERS_ROUTE_ID}`,
    object: NYCHA_BOARD_REF,
    relation: "governed_by",
    reason: "record_category_not_governing_edge",
    sourceSystem: "agency_constellation",
    sourceRecordId: "vendor:stem:GARTNER",
    sourceField: "vendors",
    sourceValue: "Gartner Inc.",
    sourceUrl: "/agencies/employees-retirement-system/",
    observedAt: "2026-08-31T00:00:00.000Z",
    evidenceRefs: ["vendor:stem:GARTNER"],
  });
}

function extrasForBody(body) {
  const parentId = exactInstitutionId(body.parent_institution_id);
  const bodyId = exactSlug(body.body_id);
  return {
    body_id: bodyId,
    parent_institution_id: parentId,
    join_method: GOVERNING_BODY_JOIN_METHOD,
    source_receipt: body.source_receipt,
    official_source_url: body.source_url,
  };
}

export function resolveGoverningBodyRoles(inputs = {}) {
  const proceedings = inputs.proceedings || defaultProceedings;
  const publisherById = inputs.publisherById || {};
  const generatedAt = isoObservedAt(proceedings.generated_at || inputs.generatedAt);
  const identities = identityRows(proceedings);
  const candidates = [];
  const extras = new Map();

  for (const body of bodies(proceedings)) {
    const parentId = exactInstitutionId(body.parent_institution_id);
    const bodyId = exactSlug(body.body_id);
    if (!parentId || !bodyId || !body.source_url) {
      candidates.push(unresolvedCandidate({
        subject: parentId ? `civic-institution:${parentId}` : "civic-institution:unresolved",
        object: bodyId ? `board:${bodyId}` : "Board",
        relation: "governed_by",
        reason: "exact_join_fields_missing",
        sourceSystem: body.source_system || "source",
        sourceRecordId: body.source_record_id || "body-missing",
        sourceField: body.source_field || "body_id",
        sourceValue: body.source_value || body.name || "missing",
        sourceUrl: body.source_url || "https://www.nyc.gov/",
        observedAt: body.observed_at || generatedAt,
        evidenceRefs: [body.source_receipt || "body-missing"],
      }));
      continue;
    }
    if (!parentIdentityIsVerified(body, identities)) {
      const candidate = governedByCandidate(body, generatedAt);
      candidates.push({
        ...candidate,
        resolutionStatus: "unresolved",
        reason: body.identity_reason || "parent_identity_unverified",
        basis: body.identity_reason || "parent_identity_unverified",
      });
      extras.set(`governed_by:board:${bodyId}`, extrasForBody(body));
      continue;
    }
    const candidate = governedByCandidate(body, generatedAt);
    candidates.push(candidate);
    extras.set(`governed_by:board:${bodyId}`, extrasForBody(body));
  }

  for (const committee of committees(proceedings)) {
    const board = bodies(proceedings).find((row) => exactSlug(row.body_id) === exactSlug(committee.parent_board_id));
    const parentVerified = parentIdentityIsVerified(committee, identities)
      && board
      && parentIdentityIsVerified(board, identities);
    if (!parentVerified) {
      candidates.push(unresolvedCandidate({
        subject: `board:${exactSlug(committee.parent_board_id) || BERS_BOARD_ID}`,
        object: `committee:${exactSlug(committee.body_id) || BERS_EXECUTIVE_ID}`,
        relation: "has_committee",
        reason: committee.identity_reason || "parent_identity_unverified",
        sourceSystem: committee.source_system || "source",
        sourceRecordId: committee.source_record_id || "committee-missing",
        sourceField: committee.source_field || "body_id",
        sourceValue: committee.source_value || committee.name || "missing",
        sourceUrl: committee.source_url || "https://www.nyc.gov/",
        observedAt: committee.observed_at || generatedAt,
        evidenceRefs: [committee.source_receipt || "committee-missing"],
      }));
      continue;
    }
    const candidate = hasCommitteeCandidate(committee, generatedAt);
    candidates.push(candidate);
    extras.set(`has_committee:committee:${exactSlug(committee.body_id)}`, {
      body_id: exactSlug(committee.body_id),
      parent_institution_id: exactInstitutionId(committee.parent_institution_id),
      parent_board_id: exactSlug(committee.parent_board_id),
      join_method: "exact_official_committee_record",
      source_receipt: committee.source_receipt,
      official_source_url: committee.source_url,
    });
  }

  for (const row of meetings(proceedings)) {
    const body = bodyById(proceedings, row.body_id);
    const publisher = publisherById[exactInstitutionId(row.parent_institution_id)]
      || inputs.publisherRow
      || {};
    const join = verifyGoverningMeetingJoin(row, body || {}, publisher);
    if (!join.accepted || !body || !parentIdentityIsVerified(body, identities)) {
      candidates.push(unresolvedCandidate({
        subject: `${exactText(row.body_kind, 40) === "board" ? "board" : "committee"}:${exactSlug(row.body_id) || NYCHA_BOARD_ID}`,
        object: exactText(row.meeting_id, 160) || row.request_id || BERS_TARGET_MEETING_DATE,
        relation: "hosts_meeting",
        reason: join.reason || "parent_identity_unverified",
        sourceSystem: row.source_system || "city_record",
        sourceRecordId: exactRequestId(row.request_id) || row.source_record_id || "meeting-missing",
        sourceField: row.source_field || "request_id",
        sourceValue: row.source_value || row.title || "missing",
        sourceUrl: row.source_url || "https://a856-cityrecord.nyc.gov/",
        observedAt: row.observed_at || generatedAt,
        evidenceRefs: [row.source_receipt || "meeting-missing"],
      }));
      continue;
    }
    const candidate = hostsMeetingCandidate(row, join, generatedAt);
    candidates.push(candidate);
    extras.set(`hosts_meeting:${join.meeting_id}`, {
      body_id: join.body_id,
      parent_institution_id: join.parent_institution_id,
      request_id: join.request_id,
      event_date: row.event_date || null,
      title: exactText(row.title, 240),
      join_method: join.join_method,
      source_receipt: row.source_receipt,
      notice_href: `/notices/${encodeURIComponent(join.request_id)}`,
    });
  }

  if (inputs.includeNegativeProbes) {
    candidates.push(genericBoardCandidate());
    candidates.push(similarCommitteeCandidate());
    candidates.push(otiBucketCandidate());
    candidates.push(calendarTargetCandidate());
    candidates.push(vendorStaffingCandidate());
  }

  const resolved = resolveCivicInstitutionRoleEdges(candidates);
  const stamp = (edge) => {
    const key = `${edge.relation_id}:${edge.to}`;
    const extra = extras.get(key) || extras.get(`${edge.relation_id}:${edge.from}`) || {};
    return decorate(edge, extra);
  };
  return Object.freeze({
    accepted: Object.freeze(resolved.accepted.map(stamp)),
    held: Object.freeze(resolved.held.map(stamp)),
    unknown: Object.freeze(resolved.unknown.map(stamp)),
    unresolved: Object.freeze(resolved.unresolved.map(stamp)),
    gaps: Object.freeze(gapRows(proceedings).map((gap) => Object.freeze({ ...gap }))),
    identity_states: Object.freeze(identityRows(proceedings).map((row) => Object.freeze({ ...row }))),
  });
}

function belongsToInstitution(edge, canonicalId) {
  const id = exactInstitutionId(canonicalId);
  return exactInstitutionId(edge.parent_institution_id) === id
    || exactInstitutionId(edge.subject_canonical_id) === id
    || exactInstitutionId(edge.object_canonical_id) === id;
}

function relatedIdentity(canonicalId, state) {
  const id = exactInstitutionId(canonicalId);
  return exactInstitutionId(state.route_key) === id || exactInstitutionId(state.crosswalk_key) === id;
}

function relatedGap(canonicalId, gap) {
  const id = exactInstitutionId(canonicalId);
  return exactInstitutionId(gap.institution_id) === id
    || exactInstitutionId(gap.route_key) === id
    || exactInstitutionId(gap.crosswalk_key) === id;
}

export function governingBodiesForInstitution(canonicalId, inputs = {}) {
  const id = exactInstitutionId(canonicalId);
  if (!GOVERNING_INSTITUTION_IDS.has(id)) {
    return Object.freeze({
      accepted: Object.freeze([]),
      held: Object.freeze([]),
      unknown: Object.freeze([]),
      unresolved: Object.freeze([]),
      gaps: Object.freeze([]),
      identity_states: Object.freeze([]),
    });
  }
  const resolved = resolveGoverningBodyRoles(inputs);
  const keepAccepted = (edge) => belongsToInstitution(edge, id) && edge.status === "accepted";
  // NYCERS may surface BERS identity/meeting gaps without inheriting accepted
  // NYCHA edges or silently merging the BERS parent.
  const keepUnresolved = (edge) => {
    if (belongsToInstitution(edge, id)) return true;
    if (id === BERS_ROUTE_ID) {
      return belongsToInstitution(edge, BERS_CROSSWALK_ID) && edge.status !== "accepted";
    }
    return false;
  };
  return Object.freeze({
    accepted: Object.freeze(resolved.accepted.filter(keepAccepted)),
    held: Object.freeze(resolved.held.filter(keepUnresolved)),
    unknown: Object.freeze(resolved.unknown.filter(keepUnresolved)),
    unresolved: Object.freeze(resolved.unresolved.filter(keepUnresolved)),
    gaps: Object.freeze(resolved.gaps.filter((gap) => relatedGap(id, gap))),
    identity_states: Object.freeze(resolved.identity_states.filter((state) => relatedIdentity(id, state))),
  });
}

export { invertCivicInstitutionRoleEdge };
