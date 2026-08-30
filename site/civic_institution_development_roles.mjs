/**
 * Source-qualified NYCEDC development and procurement role traversal.
 *
 * Exact ZAP applicant, SBS/NYCEDC party fields, and Borough Board passage
 * evidence mint civic-institution role edges. Mentions, publisher notices,
 * and company names never infer a role.
 */

import {
  buildCivicInstitutionRoleEdge,
  invertCivicInstitutionRoleEdge,
  resolveCivicInstitutionRoleEdges,
  sourceRecordObservation,
} from "../ontology/civic_institution.mjs";
import {
  BOROUGH_BOARD_NOTICE_ID,
  NYCEDC_CANONICAL_ID,
  NYCEDC_ZAP_APPLICANT_SPELLING,
  SBS_CANONICAL_ID,
  SBS_MASTER_EPIN,
  SBS_MASTER_PROCUREMENT_ID,
  SBS_MASTER_SOURCE_REF,
  WILLETS_POINT_PARCEL_BBL,
  WILLETS_POINT_PROJECT_ID,
  isNycEdcApplicantSpelling,
} from "./civic_institution_development_specimens.mjs";

export {
  BOROUGH_BOARD_NOTICE_ID,
  NYCEDC_CANONICAL_ID,
  NYCEDC_ZAP_APPLICANT_SPELLING,
  SBS_CANONICAL_ID,
  SBS_MASTER_EPIN,
  SBS_MASTER_PROCUREMENT_ID,
  SBS_MASTER_SOURCE_REF,
  WILLETS_POINT_PARCEL_BBL,
  WILLETS_POINT_PROJECT_ID,
  isNycEdcApplicantSpelling,
};

const NYCEDC_VENDOR_SPELLINGS = Object.freeze(new Set([
  "NEW YORK CITY ECONOMIC DEVELOPMENT CORPORATION",
  "New York City Economic Development Corporation",
]));
const SBS_AGENCY_SPELLINGS = Object.freeze(new Set([
  "DEPARTMENT OF SMALL BUSINESS SERVICES",
  "Small Business Services",
]));

const clean = (value, max = 500) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

function exactText(value) {
  return clean(value, 1_000);
}

function projectIdOf(row) {
  return exactText(row?.project_id || row?.id);
}

function epinOf(row, observation) {
  return exactText(
    row?.pin
    || row?.identity_keys?.epins?.[0]
    || observation?.snapshot?.epin
    || observation?.snapshot?.epin_norm
    || observation?.snapshot?.pin,
  );
}

function partyFields(row, observation) {
  const snapshot = observation?.snapshot || {};
  return {
    agency: exactText(snapshot.agency || snapshot.agency_name || row?.agency_name || row?.agency),
    vendor: exactText(snapshot.vendor || snapshot.vendor_name || row?.vendor_name || row?.vendor),
  };
}

function observationFrom(row) {
  if (!row) return null;
  if (row.source_system && (row.source_record_id || row.source_record_ref) && row.source_field) {
    return sourceRecordObservation(row);
  }
  return sourceRecordObservation({
    sourceSystem: row.sourceSystem || row.source_system,
    sourceRecordId: row.sourceRecordId || row.source_record_id || row.source_record_ref,
    sourceField: row.sourceField || row.source_field,
    sourceValue: row.sourceValue || row.source_value,
    sourceUrl: row.sourceUrl || row.source_url,
    sourceDataset: row.sourceDataset || row.source_dataset,
    observedAt: row.observedAt || row.observed_at || row.ingested_at,
  });
}

function applicantCandidate(project) {
  if (!project || projectIdOf(project) !== WILLETS_POINT_PROJECT_ID) return null;
  const spelling = exactText(project.primary_applicant);
  if (spelling !== NYCEDC_ZAP_APPLICANT_SPELLING) return null;
  const observedAt = exactText(project.observed_at || project.materialized_at || project.current_milestone_date)
    || "2024-01-01";
  return {
    subject: `civic-institution:${NYCEDC_CANONICAL_ID}`,
    object: `project:${WILLETS_POINT_PROJECT_ID}`,
    relation: "applicant_on",
    objectDisplayName: exactText(project.project_name) || "Willets Point Phase II Mapping Actions",
    objectHref: `/browse/zoning/#land/${encodeURIComponent(WILLETS_POINT_PROJECT_ID)}`,
    method: "exact_source_identifier",
    confidence: "strong",
    basis: "exact_zap_primary_applicant",
    resolutionStatus: "accepted",
    vintage: `project:${WILLETS_POINT_PROJECT_ID}`,
    sourceObservation: observationFrom({
      sourceSystem: "zap_projects",
      sourceRecordId: `zap-projects:${WILLETS_POINT_PROJECT_ID}`,
      sourceField: "primary_applicant",
      sourceValue: spelling,
      sourceUrl: `/browse/zoning/#land/${encodeURIComponent(WILLETS_POINT_PROJECT_ID)}`,
      sourceDataset: "hgx4-8ukb",
      observedAt,
    }),
    evidenceRefs: [
      `project:${WILLETS_POINT_PROJECT_ID}`,
      `zap-projects:${WILLETS_POINT_PROJECT_ID}`,
    ],
  };
}

function procurementPartyCandidate({ procurement, observation, relation, subject, object, objectDisplayName, objectHref, basis }) {
  const epin = epinOf(procurement, observation);
  const sourceRef = exactText(observation?.source_observation_ref || observation?.source_record_ref);
  if (epin !== SBS_MASTER_EPIN || sourceRef !== SBS_MASTER_SOURCE_REF) return null;
  const parties = partyFields(procurement, observation);
  if (!SBS_AGENCY_SPELLINGS.has(parties.agency) || !NYCEDC_VENDOR_SPELLINGS.has(parties.vendor)) {
    return null;
  }
  const procurementId = exactText(procurement?.procurement_id) || SBS_MASTER_PROCUREMENT_ID;
  const observedAt = exactText(observation?.ingested_at || observation?.observed_at) || "2026-08-18T04:05:51.552Z";
  const field = relation === "contractor_on" ? "vendor" : "agency";
  const value = field === "vendor" ? parties.vendor : parties.agency;
  return {
    subject,
    object,
    relation,
    objectDisplayName,
    objectHref,
    method: "exact_source_identifier",
    confidence: "strong",
    basis,
    resolutionStatus: "accepted",
    vintage: sourceRef,
    sourceObservation: observationFrom({
      sourceSystem: observation?.source_system || "passport_public_contracts",
      sourceRecordId: sourceRef,
      sourceField: observation?.snapshot?.vendor && field === "vendor" ? "vendor"
        : (observation?.snapshot?.agency && field === "agency" ? "agency" : field),
      sourceValue: value,
      sourceUrl: objectHref || `/procurements/${encodeURIComponent(procurementId)}`,
      sourceDataset: "passport_public_contracts",
      observedAt,
    }),
    evidenceRefs: [sourceRef, procurementId, `epin:${SBS_MASTER_EPIN}`],
  };
}

function contractorCandidate(procurement, observation) {
  const procurementId = exactText(procurement?.procurement_id) || SBS_MASTER_PROCUREMENT_ID;
  return procurementPartyCandidate({
    procurement,
    observation,
    relation: "contractor_on",
    subject: `civic-institution:${NYCEDC_CANONICAL_ID}`,
    object: procurementId,
    objectDisplayName: exactText(observation?.snapshot?.title || procurement?.short_title)
      || "FY26 NYCEDC Master Contract",
    objectHref: exactText(procurement?.canonical_href)
      || `/procurements/${encodeURIComponent(procurementId)}`,
    basis: "exact_contract_vendor_party",
  });
}

function contractedByCandidate(procurement, observation) {
  return procurementPartyCandidate({
    procurement,
    observation,
    relation: "contracted_by",
    subject: `civic-institution:${SBS_CANONICAL_ID}`,
    object: `civic-institution:${NYCEDC_CANONICAL_ID}`,
    objectDisplayName: "Economic Development Corporation",
    objectHref: `/agencies/${NYCEDC_CANONICAL_ID}/`,
    basis: "exact_contract_agency_party",
  });
}

function boroughBoardPassageProvesSelection(passage = {}) {
  const noticeId = exactText(passage.notice_id || passage.request_id);
  const quote = exactText(passage.quote);
  const date = exactText(passage.date || passage.event_date);
  const retained = exactText(passage.source_passage || passage.retained_source_passage);
  if (noticeId !== BOROUGH_BOARD_NOTICE_ID) return false;
  if (!quote || !date || !retained) return false;
  return /\brybak\b/i.test(`${quote} ${retained}`);
}

function boroughBoardCandidate(meeting, passage) {
  const noticeId = exactText(meeting?.request_id || meeting?.publisher_identifier || BOROUGH_BOARD_NOTICE_ID);
  const meetingMatches = noticeId === BOROUGH_BOARD_NOTICE_ID;
  const observedAt = exactText(meeting?.event_date || meeting?.start_date) || "2026-06-02";
  const observation = observationFrom({
    sourceSystem: "city_record",
    sourceRecordId: `city_record:${BOROUGH_BOARD_NOTICE_ID}`,
    sourceField: "short_title",
    sourceValue: exactText(meeting?.short_title || meeting?.title)
      || "BROOKLYN BOROUGH BOARD PUBLIC HEARING AND MEETING",
    sourceUrl: `/notices/${BOROUGH_BOARD_NOTICE_ID}`,
    sourceDataset: "dg92-zbpx",
    observedAt,
  });
  if (meetingMatches && boroughBoardPassageProvesSelection({
    ...passage,
    notice_id: noticeId,
    date: passage?.date || meeting?.event_date,
  })) {
    return {
      subject: `civic-institution:${NYCEDC_CANONICAL_ID}`,
      object: `meetings:notice:${BOROUGH_BOARD_NOTICE_ID}`,
      relation: "presents_transaction_at",
      objectDisplayName: exactText(meeting?.title || meeting?.short_title),
      objectHref: `/notices/${BOROUGH_BOARD_NOTICE_ID}`,
      method: "exact_source_identifier",
      confidence: "strong",
      basis: "exact_borough_board_selection_passage",
      resolutionStatus: "accepted",
      vintage: `meetings:notice:${BOROUGH_BOARD_NOTICE_ID}`,
      sourceObservation: observation,
      evidenceRefs: [
        `meetings:notice:${BOROUGH_BOARD_NOTICE_ID}`,
        `city_record:${BOROUGH_BOARD_NOTICE_ID}`,
      ],
    };
  }
  return {
    subject: `civic-institution:${NYCEDC_CANONICAL_ID}`,
    object: `meetings:notice:${BOROUGH_BOARD_NOTICE_ID}`,
    relation: "presents_transaction_at",
    objectDisplayName: exactText(meeting?.title || meeting?.short_title)
      || "BROOKLYN BOROUGH BOARD PUBLIC HEARING AND MEETING",
    method: "exact_source_identifier",
    confidence: "unknown",
    basis: "borough_board_notice_without_selection_passage",
    resolutionStatus: "unresolved",
    reason: "borough_board_selection_passage_missing",
    sourceObservation: observation,
    evidenceRefs: [`meetings:notice:${BOROUGH_BOARD_NOTICE_ID}`],
  };
}

function passportObservation(procurement, observations = []) {
  const rows = Array.isArray(observations) ? observations : [];
  const fromObject = (procurement?.source_observation_refs || [])
    .map((ref) => rows.find((row) => exactText(row?.source_observation_ref) === exactText(ref)))
    .filter(Boolean);
  return fromObject.find((row) => exactText(row.source_observation_ref) === SBS_MASTER_SOURCE_REF)
    || rows.find((row) => exactText(row?.source_observation_ref) === SBS_MASTER_SOURCE_REF)
    || (epinOf(procurement) === SBS_MASTER_EPIN ? {
      source_observation_ref: SBS_MASTER_SOURCE_REF,
      source_system: "passport_public_contracts",
      snapshot: {
        epin: procurement?.pin,
        agency: procurement?.agency_name,
        vendor: procurement?.vendor_name,
        title: procurement?.short_title,
      },
      ingested_at: procurement?.start_date,
    } : null);
}

/**
 * Build fail-closed role candidates from retained source rows.
 * Incomplete party or Borough Board passage evidence stays non-linking.
 */
export function buildNycEdcDevelopmentRoleCandidates({
  project = null,
  procurement = null,
  procurementObservations = [],
  boroughBoardMeeting = null,
  boroughBoardPassage = null,
} = {}) {
  const candidates = [];
  const applicant = applicantCandidate(project);
  if (applicant) candidates.push(applicant);
  const observation = passportObservation(procurement, procurementObservations);
  const contractor = contractorCandidate(procurement, observation);
  if (contractor) candidates.push(contractor);
  const contracted = contractedByCandidate(procurement, observation);
  if (contracted) candidates.push(contracted);
  candidates.push(boroughBoardCandidate(boroughBoardMeeting, boroughBoardPassage));
  return Object.freeze(candidates);
}

export function resolveNycEdcDevelopmentRoles(inputs = {}) {
  return resolveCivicInstitutionRoleEdges(buildNycEdcDevelopmentRoleCandidates(inputs));
}

function belongsToInstitution(edge, canonicalId) {
  return edge?.subject_canonical_id === canonicalId || edge?.object_canonical_id === canonicalId;
}

/** Profile-facing edges for one civic institution, with visible inverses. */
export function developmentRolesForInstitution(canonicalId, inputs = {}) {
  const resolved = resolveNycEdcDevelopmentRoles(inputs);
  const parcels = projectParcelTrail(inputs.projectBbls);
  const accepted = [];
  for (const edge of resolved.accepted) {
    if (!belongsToInstitution(edge, canonicalId)) continue;
    const oriented = edge.subject_canonical_id === canonicalId ? edge : invertCivicInstitutionRoleEdge(edge);
    accepted.push(oriented.relation_id === "applicant_on" && oriented.object_canonical_id === WILLETS_POINT_PROJECT_ID
      ? Object.freeze({ ...oriented, parcel_trail: parcels })
      : oriented);
  }
  const keepGap = (edge) => belongsToInstitution(edge, canonicalId);
  return Object.freeze({
    accepted: Object.freeze(accepted),
    held: Object.freeze(resolved.held.filter(keepGap)),
    unknown: Object.freeze(resolved.unknown.filter(keepGap)),
    unresolved: Object.freeze(resolved.unresolved.filter(keepGap)),
  });
}

export function projectParcelTrail(bbls = []) {
  const rows = Array.isArray(bbls) ? bbls.map((value) => exactText(value)).filter((id) => /^\d{10}$/.test(id)) : [];
  return Object.freeze(rows.map((bbl) => Object.freeze({
    bbl,
    ref: `bbl:${bbl}`,
    href: `/parcels/${encodeURIComponent(bbl)}/`,
    relation: "sited_on_parcel",
  })));
}

export { buildCivicInstitutionRoleEdge };
