/**
 * Source-qualified development and procurement role traversal.
 *
 * Exact ZAP applicant, contract party fields, and Borough Board passage
 * evidence mint civic-institution role edges. Mentions, publisher notices,
 * and company names never infer a role.
 *
 * The party mappings are keyed on the reviewed source field and its exact
 * retained value (site/civic_institution_party_spellings.mjs), never on a
 * record identifier, so every retained record carrying a reviewed party value
 * mints the same typed role. The specimen keys re-exported below remain the
 * named examples the contract tests pin; they are not the gate.
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
import {
  CIVIC_INSTITUTION_PARTY_CAPACITIES,
  civicInstitutionPartyFor,
} from "./civic_institution_party_spellings.mjs";

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

const APPLICANT = CIVIC_INSTITUTION_PARTY_CAPACITIES.applicant;
const CONTRACTOR = CIVIC_INSTITUTION_PARTY_CAPACITIES.contractor;
const CONTRACTING_AGENCY = CIVIC_INSTITUTION_PARTY_CAPACITIES.contracting_agency;

function rowList(single, many) {
  const rows = [
    ...(Array.isArray(many) ? many : []),
    ...(single ? [single] : []),
  ].filter(Boolean);
  const seen = new Set();
  return rows.filter((row) => {
    const key = exactText(row?.procurement_id || row?.project_id || row?.id || row?.pin);
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function projectHref(projectId) {
  return `/browse/zoning/#land/${encodeURIComponent(projectId)}`;
}

/**
 * Applicant role for any retained land-use project whose exact
 * `primary_applicant` value is a reviewed spelling. The project identifier
 * addresses the record; it never qualifies the mapping.
 */
function applicantCandidate(project) {
  const projectId = projectIdOf(project);
  const spelling = exactText(project?.primary_applicant);
  const party = civicInstitutionPartyFor(APPLICANT.source_field, spelling);
  if (!projectId || !party || party.capacity_id !== APPLICANT.capacity_id) return null;
  const observedAt = exactText(project.observed_at || project.materialized_at || project.current_milestone_date)
    || "2024-01-01";
  const displayName = exactText(project.project_name) || `Project ${projectId}`;
  const href = projectHref(projectId);
  return {
    subject: `civic-institution:${party.canonical_id}`,
    object: `project:${projectId}`,
    relation: APPLICANT.relation_id,
    objectDisplayName: displayName,
    objectHref: href,
    method: "exact_source_identifier",
    confidence: "strong",
    basis: APPLICANT.basis,
    resolutionStatus: "accepted",
    vintage: `project:${projectId}`,
    sourceObservation: observationFrom({
      sourceSystem: party.source_system,
      sourceRecordId: `zap-projects:${projectId}`,
      sourceField: APPLICANT.source_field,
      sourceValue: spelling,
      sourceUrl: href,
      sourceDataset: "hgx4-8ukb",
      observedAt,
    }),
    evidenceRefs: [
      `project:${projectId}`,
      `zap-projects:${projectId}`,
    ],
    record: {
      record_kind: "project",
      record_ref: `project:${projectId}`,
      record_id: projectId,
      label: displayName,
      href,
      when: exactText(project.current_milestone_date || project.observed_at) || null,
      // Not every retained land source publishes a date. The milestone label is
      // what the source does state, so a reader gets the stage rather than a
      // fabricated or borrowed date.
      milestone: exactText(project.current_milestone) || null,
    },
  };
}

function sourceSystemOfRef(ref, observation) {
  return exactText(observation?.source_system)
    || exactText(String(ref || "").split(":", 1)[0])
    || "shared_procurement_read_model";
}

/**
 * The exact retained party values for one contract row.
 *
 * A retained observation snapshot outranks the browse row: it is the source
 * record this edge cites. `field` records the retained key the value actually
 * came from, while the reviewed registry is always consulted under its own
 * canonical party-field name.
 */
function contractParties(procurement, observation) {
  const snapshot = observation?.snapshot || {};
  const agencyKey = snapshot.agency != null ? "agency"
    : snapshot.agency_name != null ? "agency_name" : "agency_name";
  const vendorKey = snapshot.vendor != null ? "vendor"
    : snapshot.vendor_name != null ? "vendor_name" : "vendor_name";
  return {
    agency: {
      field: agencyKey,
      value: exactText(snapshot.agency ?? snapshot.agency_name ?? procurement?.agency_name ?? procurement?.agency),
    },
    vendor: {
      field: vendorKey,
      value: exactText(snapshot.vendor ?? snapshot.vendor_name ?? procurement?.vendor_name ?? procurement?.vendor),
    },
  };
}

function procurementPartyCandidate({
  procurement,
  observation,
  sourceRef,
  relation,
  subject,
  object,
  objectDisplayName,
  objectHref,
  basis,
  party,
  record,
}) {
  const procurementId = exactText(procurement?.procurement_id) || SBS_MASTER_PROCUREMENT_ID;
  const observedAt = exactText(observation?.ingested_at || observation?.observed_at)
    || exactText(procurement?.start_date)
    || "2026-08-18T04:05:51.552Z";
  const epin = epinOf(procurement, observation);
  const sourceSystem = sourceSystemOfRef(sourceRef, observation);
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
      sourceSystem,
      sourceRecordId: sourceRef,
      sourceField: party.field,
      sourceValue: party.value,
      sourceUrl: objectHref || `/procurements/${encodeURIComponent(procurementId)}`,
      sourceDataset: sourceSystem,
      observedAt,
    }),
    evidenceRefs: [sourceRef, procurementId, ...(epin ? [`epin:${epin}`] : [])],
    record,
  };
}

/**
 * Contract party roles for one retained contract row.
 *
 * Both parties must resolve through the reviewed registry before either edge
 * is minted, so a row can never publish a contractor without naming the
 * institution that contracted it, or the reverse.
 */
function contractPartyCandidates(procurement, observation) {
  const sourceRef = exactText(observation?.source_observation_ref || observation?.source_record_ref);
  if (!procurement || !sourceRef) return [];
  const parties = contractParties(procurement, observation);
  const vendorParty = civicInstitutionPartyFor(CONTRACTOR.source_field, parties.vendor.value);
  const agencyParty = civicInstitutionPartyFor(CONTRACTING_AGENCY.source_field, parties.agency.value);
  if (!vendorParty || vendorParty.capacity_id !== CONTRACTOR.capacity_id) return [];
  if (!agencyParty || agencyParty.capacity_id !== CONTRACTING_AGENCY.capacity_id) return [];
  if (vendorParty.canonical_id === agencyParty.canonical_id) return [];
  const procurementId = exactText(procurement?.procurement_id) || SBS_MASTER_PROCUREMENT_ID;
  const label = exactText(observation?.snapshot?.title || procurement?.short_title)
    || `Contract ${procurementId}`;
  const href = exactText(procurement?.canonical_href)
    || `/procurements/${encodeURIComponent(procurementId)}`;
  const when = exactText(procurement?.start_date || observation?.ingested_at) || null;
  const record = {
    record_kind: "procurement",
    record_ref: procurementId,
    record_id: exactText(procurement?.contract_id) || procurementId,
    label,
    href,
    when,
    epin: epinOf(procurement, observation) || null,
    amount: Number.isFinite(Number(procurement?.contract_amount)) ? Number(procurement.contract_amount) : null,
    contracting_agency_id: agencyParty.canonical_id,
    contractor_id: vendorParty.canonical_id,
  };
  return [
    procurementPartyCandidate({
      procurement,
      observation,
      sourceRef,
      relation: CONTRACTOR.relation_id,
      subject: `civic-institution:${vendorParty.canonical_id}`,
      object: procurementId,
      objectDisplayName: label,
      objectHref: href,
      basis: CONTRACTOR.basis,
      party: { field: parties.vendor.field, value: parties.vendor.value },
      record,
    }),
    procurementPartyCandidate({
      procurement,
      observation,
      sourceRef,
      relation: CONTRACTING_AGENCY.relation_id,
      subject: `civic-institution:${agencyParty.canonical_id}`,
      object: `civic-institution:${vendorParty.canonical_id}`,
      objectDisplayName: vendorParty.canonical_id === NYCEDC_CANONICAL_ID
        ? "Economic Development Corporation"
        : vendorParty.canonical_id,
      objectHref: `/agencies/${vendorParty.canonical_id}/`,
      basis: CONTRACTING_AGENCY.basis,
      party: { field: parties.agency.field, value: parties.agency.value },
      record,
    }),
  ];
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

/**
 * The retained source observation this contract row cites.
 *
 * A supplied observation object wins when the row names its ref. Otherwise the
 * row's own first retained ref is used to describe the record it came from —
 * that is what lets a reviewed party mapping reach every retained contract,
 * not only the rows a caller happened to hydrate. A row with no retained ref
 * at all mints nothing.
 */
function contractObservation(procurement, observations = []) {
  const rows = Array.isArray(observations) ? observations : [];
  const refs = (procurement?.source_observation_refs || []).map((ref) => exactText(ref)).filter(Boolean);
  for (const ref of refs) {
    const match = rows.find((row) => exactText(row?.source_observation_ref) === ref);
    if (match) return match;
  }
  const orphan = rows.find((row) => exactText(row?.source_observation_ref) && !refs.length);
  if (orphan) return orphan;
  const fallbackRef = refs[0];
  if (!fallbackRef) return null;
  return {
    source_observation_ref: fallbackRef,
    source_system: sourceSystemOfRef(fallbackRef, null),
    snapshot: {
      epin: procurement?.pin,
      agency: procurement?.agency_name,
      vendor: procurement?.vendor_name,
      title: procurement?.short_title,
    },
    ingested_at: procurement?.start_date,
  };
}

/**
 * Build fail-closed role candidates from retained source rows.
 * Incomplete party or Borough Board passage evidence stays non-linking.
 *
 * `project`/`procurement` remain the single-row entry points; `projects` and
 * `procurements` carry the full retained set a profile materializes.
 */
export function buildNycEdcDevelopmentRoleCandidates({
  project = null,
  projects = [],
  procurement = null,
  procurements = [],
  procurementObservations = [],
  boroughBoardMeeting = null,
  boroughBoardPassage = null,
} = {}) {
  const candidates = [];
  for (const row of rowList(project, projects)) {
    const applicant = applicantCandidate(row);
    if (applicant) candidates.push(applicant);
  }
  for (const row of rowList(procurement, procurements)) {
    const observation = contractObservation(row, procurementObservations);
    candidates.push(...contractPartyCandidates(row, observation));
  }
  candidates.push(boroughBoardCandidate(boroughBoardMeeting, boroughBoardPassage));
  return Object.freeze(candidates);
}

/**
 * Record context keyed by resolved edge id.
 *
 * The envelope truncates `vintage`, so a source ref is not a usable key. The
 * edge id is derived from the same relation, endpoints, and observation, so it
 * addresses exactly the edge this record context belongs to. Ids change under
 * inversion, so a caller looks up before orienting.
 */
export function developmentRoleRecordIndex(inputs = {}) {
  const index = new Map();
  for (const candidate of buildNycEdcDevelopmentRoleCandidates(inputs)) {
    if (!candidate?.record) continue;
    const edge = buildCivicInstitutionRoleEdge(candidate);
    if (edge?.status !== "accepted" || !edge.id) continue;
    index.set(edge.id, candidate.record);
  }
  return index;
}

export function resolveNycEdcDevelopmentRoles(inputs = {}) {
  return resolveCivicInstitutionRoleEdges(buildNycEdcDevelopmentRoleCandidates(inputs));
}

function belongsToInstitution(edge, canonicalId) {
  return edge?.subject_canonical_id === canonicalId || edge?.object_canonical_id === canonicalId;
}

/**
 * Parcel trails keyed by project id.
 *
 * `projectBbls` stays the flat list for the single `project` input;
 * `projectBblsById` carries the retained set for a generalized project list.
 */
function parcelTrailsByProject(inputs) {
  const trails = new Map();
  const byId = inputs?.projectBblsById && typeof inputs.projectBblsById === "object"
    ? inputs.projectBblsById
    : {};
  for (const [projectId, bbls] of Object.entries(byId)) {
    const trail = projectParcelTrail(bbls);
    if (trail.length) trails.set(exactText(projectId), trail);
  }
  const flat = projectParcelTrail(inputs?.projectBbls);
  const singleId = projectIdOf(inputs?.project);
  if (flat.length && singleId && !trails.has(singleId)) trails.set(singleId, flat);
  return trails;
}

/** Profile-facing edges for one civic institution, with visible inverses. */
export function developmentRolesForInstitution(canonicalId, inputs = {}) {
  const resolved = resolveNycEdcDevelopmentRoles(inputs);
  const trails = parcelTrailsByProject(inputs);
  const records = developmentRoleRecordIndex(inputs);
  const accepted = [];
  for (const edge of resolved.accepted) {
    if (!belongsToInstitution(edge, canonicalId)) continue;
    const record = records.get(edge.id) || null;
    const oriented = edge.subject_canonical_id === canonicalId ? edge : invertCivicInstitutionRoleEdge(edge);
    const parcels = oriented.relation_id === "applicant_on"
      ? trails.get(exactText(oriented.object_canonical_id)) || null
      : null;
    accepted.push(parcels || record
      ? Object.freeze({
        ...oriented,
        ...(parcels ? { parcel_trail: parcels } : {}),
        ...(record ? { record } : {}),
      })
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
