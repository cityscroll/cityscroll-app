/**
 * Statute-grounded DOC reporting-accountability traversal.
 *
 * Only obligation 63842-001 mints a duty-bearer edge and the two explicit
 * report-recipient edges. Generic DOC duties, generic "board" language,
 * Board of Correction meetings, and shared agency labels never infer
 * oversight.
 */

import {
  buildCivicInstitutionRoleEdge,
  invertCivicInstitutionRoleEdge,
  resolveCivicInstitutionRoleEdges,
  sourceRecordObservation,
} from "../ontology/civic_institution.mjs";

export const DOC_ACCOUNTABILITY_OBLIGATION_ID = "63842-001";
export const DOC_ACCOUNTABILITY_MATTER_ID = "63842";
export const DOC_CANONICAL_ID = "correction";
export const BOC_CANONICAL_ID = "board-of-correction";
export const COUNCIL_CANONICAL_ID = "city-council";
export const DOC_ACCOUNTABILITY_NEGATIVE_RULE = "Never infer a report-recipient or oversight edge from a generic DOC obligation, generic board language, a Board of Correction meeting, or a shared agency label.";

export const DOC_ACCOUNTABILITY_RECIPIENTS = Object.freeze([
  Object.freeze({
    phrase: "to the council",
    canonical_id: COUNCIL_CANONICAL_ID,
    display_name: "City Council",
  }),
  Object.freeze({
    phrase: "to the board of correction",
    canonical_id: BOC_CANONICAL_ID,
    display_name: "Board of Correction",
  }),
]);

const ACCOUNTABILITY_RELATIONS = Object.freeze(new Set([
  "must_report_to",
  "receives_report_from",
  "duty_bearer",
  "holds_duty",
]));

const OVERSIGHT_RELATIONS = Object.freeze(new Set(["oversees", "governed_by"]));

const clean = (value, max = 500) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

function exactText(value, max = 2_000) {
  return clean(value, max);
}

function isoObservedAt(value) {
  const raw = exactText(value, 80);
  if (!raw) return "2020-01-01T00:00:00.000Z";
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${raw}T00:00:00.000Z`;
  if (!Number.isNaN(Date.parse(raw))) return raw;
  return "2020-01-01T00:00:00.000Z";
}

function obligationIdOf(row) {
  return exactText(row?.obligation_id || row?.mandate_id || row?.id, 40);
}

export function isAccountabilityRelation(relation) {
  return ACCOUNTABILITY_RELATIONS.has(exactText(relation, 80).toLowerCase());
}

export function isOversightInferenceForbidden(relation) {
  return OVERSIGHT_RELATIONS.has(exactText(relation, 80).toLowerCase());
}

export function extractExplicitReportRecipients(dutyText) {
  const haystack = exactText(dutyText, 2_000).toLowerCase();
  if (!haystack) return Object.freeze([]);
  return Object.freeze(DOC_ACCOUNTABILITY_RECIPIENTS.filter((row) => haystack.includes(row.phrase)));
}

function quoteVerified(row) {
  return row?.certification?.quote_verified === true || row?.quote_verified === true;
}

function sourceUrlOf(row) {
  return exactText(row?.source?.legistar_url || row?.source_url || row?.href, 2_000) || null;
}

function citationOf(row) {
  return exactText(row?.citation || row?.source?.citation, 400) || null;
}

function observedDateOf(row) {
  return exactText(
    row?.deadline?.computed_date
    || row?.observed_date
    || row?.as_of
    || String(row?.deadline?.computed_date || "").slice(0, 10),
    20,
  ) || "2020-01-01";
}

function sourceReceiptOf(row, lookup = null) {
  return exactText(
    row?.source_receipt
    || row?.source?.law_text_url
    || lookup?.source_receipt?.extraction
    || `obligation:${DOC_ACCOUNTABILITY_OBLIGATION_ID}`,
    500,
  );
}

function observationFrom(fields) {
  return sourceRecordObservation({
    sourceSystem: fields.sourceSystem,
    sourceRecordId: fields.sourceRecordId,
    sourceField: fields.sourceField,
    sourceValue: fields.sourceValue,
    sourceUrl: fields.sourceUrl,
    sourceDataset: fields.sourceDataset || "agency_obligations",
    observedAt: fields.observedAt,
  });
}

export function findDocAccountabilityObligation(lookupOrRows) {
  const rows = Array.isArray(lookupOrRows)
    ? lookupOrRows
    : [
      ...(lookupOrRows?.by_agency?.[DOC_CANONICAL_ID]?.obligations || []),
      ...(lookupOrRows?.obligations || []),
    ];
  return rows.find((row) => obligationIdOf(row) === DOC_ACCOUNTABILITY_OBLIGATION_ID) || null;
}

function dutyPayload(row, lookup, recipients) {
  const obligationId = obligationIdOf(row);
  return Object.freeze({
    obligation_id: obligationId,
    matter_id: exactText(row.matter_id || DOC_ACCOUNTABILITY_MATTER_ID, 40),
    duty_text: exactText(row.duty_text, 2_000),
    citation: citationOf(row),
    source_url: sourceUrlOf(row),
    quote_verified: quoteVerified(row),
    observed_date: observedDateOf(row),
    source_receipt: sourceReceiptOf(row, lookup),
    mandate_href: `/mandates/${encodeURIComponent(obligationId)}`,
    recipients: Object.freeze(recipients.map((item) => Object.freeze({
      phrase: item.phrase,
      canonical_id: item.canonical_id,
      display_name: item.display_name,
      href: `/agencies/${item.canonical_id}/`,
    }))),
  });
}

function stampAccountability(edge, duty, extras = {}) {
  if (!edge) return edge;
  return Object.freeze({
    ...edge,
    obligation_id: duty.obligation_id,
    duty_text: duty.duty_text,
    citation: duty.citation,
    quote_verified: duty.quote_verified,
    recipient_phrase: extras.recipient_phrase || null,
    sibling_recipients: extras.sibling_recipients || duty.recipients,
    mandate_href: duty.mandate_href,
    source_url: duty.source_url,
    observed_date: duty.observed_date,
    source_receipt: duty.source_receipt,
    negative_rule: extras.negative_rule || edge.negative_rule || DOC_ACCOUNTABILITY_NEGATIVE_RULE,
  });
}

function dutyBearerCandidate(row, duty) {
  const agencyId = exactText(row.agency_id, 80);
  const verified = duty.quote_verified;
  const exactBearer = agencyId === DOC_CANONICAL_ID;
  const observedAt = isoObservedAt(row.deadline?.computed_date || duty.observed_date);
  const observation = observationFrom({
    sourceSystem: "legistar",
    sourceRecordId: `legistar:${duty.obligation_id}`,
    sourceField: "agency_raw",
    sourceValue: exactText(row.agency_raw || row.agency_name, 200) || "Department of Correction",
    sourceUrl: duty.source_url,
    observedAt,
  });
  return {
    subject: `obligation:${duty.obligation_id}`,
    object: `civic-institution:${DOC_CANONICAL_ID}`,
    objectDisplayName: "Department of Correction",
    objectHref: `/agencies/${DOC_CANONICAL_ID}/`,
    subjectHref: duty.mandate_href,
    relation: "duty_bearer",
    method: "exact_source_identifier",
    confidence: verified && exactBearer ? "strong" : "unknown",
    basis: verified && exactBearer ? "exact_statute_duty_bearer" : "duty_bearer_incomplete",
    resolutionStatus: verified && exactBearer ? "accepted" : "unresolved",
    reason: !verified
      ? "quote_verification_incomplete"
      : (exactBearer ? null : "duty_bearer_identity_incomplete"),
    vintage: `obligation:${duty.obligation_id}`,
    asOf: observedAt,
    sourceObservation: observation,
    evidenceRefs: [`obligation:${duty.obligation_id}`, `legistar:${duty.matter_id}`],
  };
}

function reportRecipientCandidate(row, duty, recipient) {
  const verified = duty.quote_verified;
  const observedAt = isoObservedAt(row.deadline?.computed_date || duty.observed_date);
  const observation = observationFrom({
    sourceSystem: "legistar",
    sourceRecordId: `legistar:${duty.obligation_id}`,
    sourceField: "duty_addressee",
    sourceValue: recipient.phrase,
    sourceUrl: duty.source_url,
    observedAt,
  });
  return {
    subject: `civic-institution:${DOC_CANONICAL_ID}`,
    object: `civic-institution:${recipient.canonical_id}`,
    objectDisplayName: recipient.display_name,
    objectHref: `/agencies/${recipient.canonical_id}/`,
    subjectHref: `/agencies/${DOC_CANONICAL_ID}/`,
    relation: "must_report_to",
    method: "exact_source_identifier",
    confidence: verified ? "strong" : "unknown",
    basis: verified ? "exact_statute_addressee" : "recipient_evidence_incomplete",
    resolutionStatus: verified ? "accepted" : "unresolved",
    reason: verified ? null : "quote_verification_incomplete",
    vintage: `obligation:${duty.obligation_id}`,
    asOf: observedAt,
    sourceObservation: observation,
    evidenceRefs: [`obligation:${duty.obligation_id}`, `legistar:${duty.matter_id}`],
  };
}

function missingRecipientCandidate(row, duty) {
  const observedAt = isoObservedAt(row.deadline?.computed_date || duty.observed_date);
  const observation = observationFrom({
    sourceSystem: "legistar",
    sourceRecordId: `legistar:${duty.obligation_id}`,
    sourceField: "duty_addressee",
    sourceValue: exactText(row.duty_text, 200) || "report",
    sourceUrl: duty.source_url,
    observedAt,
  });
  return {
    subject: `civic-institution:${DOC_CANONICAL_ID}`,
    object: `civic-institution:${BOC_CANONICAL_ID}`,
    objectDisplayName: "Board of Correction",
    relation: "must_report_to",
    method: "exact_source_identifier",
    confidence: "unknown",
    basis: "recipient_phrase_missing",
    resolutionStatus: "unresolved",
    reason: "recipient_phrase_missing",
    vintage: `obligation:${duty.obligation_id}`,
    sourceObservation: observation,
    evidenceRefs: [`obligation:${duty.obligation_id}`],
  };
}

/**
 * Build fail-closed role candidates from the exact retained obligation.
 * Other DOC rows, meetings, and generic board copy never enter this bag.
 */
export function buildDocAccountabilityRoleCandidates({
  lookup = null,
  obligation = null,
  obligations = [],
  meetings = [],
} = {}) {
  void meetings;
  const row = obligation
    || findDocAccountabilityObligation(lookup)
    || findDocAccountabilityObligation(obligations);
  if (!row || obligationIdOf(row) !== DOC_ACCOUNTABILITY_OBLIGATION_ID) {
    return Object.freeze([]);
  }
  const recipients = extractExplicitReportRecipients(row.duty_text);
  const duty = dutyPayload(row, lookup, recipients);
  const candidates = [dutyBearerCandidate(row, duty)];
  if (!recipients.length) candidates.push(missingRecipientCandidate(row, duty));
  for (const recipient of recipients) {
    candidates.push(reportRecipientCandidate(row, duty, recipient));
  }
  return Object.freeze(candidates.map((candidate) => Object.freeze({
    ...candidate,
    _duty: duty,
  })));
}

function stampResolved(resolved, dutyById) {
  const stampBag = (rows) => Object.freeze(rows.map((edge) => {
    const duty = dutyById.get(edge.vintage) || dutyById.get(`obligation:${edge.obligation_id}`) || null;
    if (!duty) return edge;
    const phrase = edge.provenance?.source_field === "duty_addressee"
      ? edge.provenance.source_value
      : null;
    return stampAccountability(edge, duty, { recipient_phrase: phrase });
  }));
  return Object.freeze({
    accepted: stampBag(resolved.accepted),
    held: stampBag(resolved.held),
    unknown: stampBag(resolved.unknown),
    unresolved: stampBag(resolved.unresolved),
  });
}

export function resolveDocAccountabilityRoles(inputs = {}) {
  const candidates = buildDocAccountabilityRoleCandidates(inputs);
  const dutyById = new Map();
  for (const candidate of candidates) {
    if (candidate._duty) dutyById.set(`obligation:${candidate._duty.obligation_id}`, candidate._duty);
  }
  const resolved = resolveCivicInstitutionRoleEdges(candidates.map(({ _duty, ...candidate }) => {
    void _duty;
    return candidate;
  }));
  return stampResolved(resolved, dutyById);
}

function belongsToInstitution(edge, canonicalId) {
  return edge?.subject_canonical_id === canonicalId || edge?.object_canonical_id === canonicalId;
}

function orientForInstitution(edge, canonicalId) {
  if (edge.subject_canonical_id === canonicalId) return edge;
  if (edge.object_canonical_id === canonicalId) return invertCivicInstitutionRoleEdge(edge);
  return null;
}

/** Profile-facing edges for one civic institution, with visible inverses. */
export function accountabilityRolesForInstitution(canonicalId, inputs = {}) {
  const resolved = resolveDocAccountabilityRoles(inputs);
  const keep = (edge) => belongsToInstitution(edge, canonicalId);
  const accepted = [];
  for (const edge of resolved.accepted) {
    if (!keep(edge)) continue;
    const oriented = orientForInstitution(edge, canonicalId);
    if (oriented) accepted.push(oriented);
  }
  return Object.freeze({
    accepted: Object.freeze(accepted),
    held: Object.freeze(resolved.held.filter(keep)),
    unknown: Object.freeze(resolved.unknown.filter(keep)),
    unresolved: Object.freeze(resolved.unresolved.filter(keep)),
  });
}

export function accountabilitySourcesFromLookup(lookup) {
  if (!lookup) return null;
  return { lookup };
}

export { buildCivicInstitutionRoleEdge };
