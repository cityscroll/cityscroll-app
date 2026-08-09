import { constellationLink, officialSourceDisclosure } from "./affordance_grammar.mjs";

/**
 * Process conformance (first praxis wave): expected statutory mandate events
 * vs observations in the public record.
 *
 * Implementation choice (not user-facing copy): only join when the public-record
 * signal is reliable; otherwise enrichment_pending — never fabricate observations.
 * User-facing copy states the observation plainly without "not X but Y" hedges.
 *
 * Vocabulary: product term is **mandates** (upstream extract may say obligations).
 *
 * Later seams: full event logs, van der Aalst-style process mining enrichment
 * (Process Mining Manifesto), multi-source evidence trails.
 */

import { resolveAgencyIdentity } from "./agency_identity.mjs";

export const PROCESS_CONFORMANCE_SCHEMA = "cityscroll.process_conformance.v1";
export const PROCESS_CONFORMANCE_METHOD = "mandate_expected_vs_observed_v1";
export const PROCESS_CONFORMANCE_ITERATION = "v1";

/** Public observation status keys and plain reader labels. */
export const OBSERVATION_STATUS = Object.freeze({
  OBSERVED: "observed",
  EVIDENCE_ONLY: "evidence_only",
  EXPECTED_NOT_YET_OBSERVED: "expected_not_yet_observed",
  ON_TRACK: "on_track",
  ENRICHMENT_PENDING: "enrichment_pending",
});

export const OBSERVATION_LABELS = Object.freeze({
  [OBSERVATION_STATUS.OBSERVED]: "Observed in City Record",
  // Internal-only status: retained as evidence, never rendered as a public edge.
  [OBSERVATION_STATUS.EVIDENCE_ONLY]: "Evidence retained without a public link",
  [OBSERVATION_STATUS.EXPECTED_NOT_YET_OBSERVED]: "Expected, not yet in City Record",
  [OBSERVATION_STATUS.ON_TRACK]: "On track — deadline still ahead",
  // Internal-only status: the public renderer filters these items before display.
  [OBSERVATION_STATUS.ENRICHMENT_PENDING]: "Awaiting a City Record detector",
});

/**
 * Deliverable types with a reliable City Record observation path in v1.
 * rulemaking → Agency Rules notices (rules domain / entity-intelligence rules).
 * report → City Record rows whose title/type signals a report/study/plan filing
 *          for the same agency, with topic-token join (strict).
 */
export const DETECTABLE_DELIVERABLES = Object.freeze(["rulemaking", "report"]);

/** Maximum tolerated lag after a known obligation deadline for an automatic match. */
export const MAX_POST_DEADLINE_PLAUSIBILITY_DAYS = 365;

/**
 * Mandate → rule publication is a selective-prediction gate: only enriched
 * candidates with every relation feature may become a public typed edge.
 * The held-out precision for this relation is measured by tools/cross_spine_eval.mjs.
 */
export const MANDATE_RULE_MIN_PRECISION = 0.90;
export const MANDATE_RULE_PUBLICATION_TIER = "public_inferred";
export const MANDATE_RULE_EVIDENCE_ONLY_TIER = "evidence_only";

/** Expected civic-event kind from mandate deliverable_type. */
export const EXPECTED_EVENT_BY_DELIVERABLE = Object.freeze({
  rulemaking: {
    kind: "rule_filing",
    label: "Agency Rules filing (proposal, hearing, adoption, or notice)",
    signal: "city_record_agency_rules",
  },
  report: {
    kind: "report_or_study",
    label: "Report, study, or plan publication or filing",
    signal: "city_record_report_signal",
  },
  program: {
    kind: "program_action",
    label: "Program action or operational milestone",
    signal: null,
  },
  "data publication": {
    kind: "data_publication",
    label: "Public data or map publication",
    signal: null,
  },
  other: {
    kind: "other_duty",
    label: "Statutory duty event",
    signal: null,
  },
  hearing: {
    kind: "public_hearing",
    label: "Public hearing notice",
    signal: "city_record_hearing",
  },
});

/** Reader-facing intro for the mandates conformance section (useful framing only). */
export const CONFORMANCE_COPY = Object.freeze({
  lead:
    "Statutory mandates with expected public-record events — rule filings, reports — and matching City Record notices when they appear.",
});

/** @deprecated use CONFORMANCE_COPY — kept as alias for older call sites. */
export const CONFORMANCE_HONESTY = CONFORMANCE_COPY;

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "by", "with", "from",
  "as", "at", "is", "are", "be", "been", "was", "were", "will", "shall", "must", "may",
  "that", "this", "these", "those", "such", "each", "any", "all", "other", "into", "its",
  "their", "them", "they", "his", "her", "under", "over", "within", "without", "upon",
  "department", "commissioner", "agency", "city", "new", "york", "nyc", "mayor",
  "council", "speaker", "submit", "submitted", "regarding", "necessary", "including",
  "pursuant", "section", "sections", "code", "administrative", "local", "law", "rules",
  "rule", "promulgate", "implement", "carry", "out", "develop", "ensure", "provide",
  "prepare", "post", "website", "public", "number", "date", "year", "years", "days",
  "after", "before", "later", "than", "no", "not", "more", "less", "least", "most",
  "report", "reports", "study", "plan", "plans", "program", "programs",
]);

const clean = (value, max = 500) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

const esc = (value) => String(value ?? "").replace(/[<>&"']/g, (char) => ({
  "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
}[char]));

function validDate(value) {
  const date = clean(value, 20);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parsed = Date.parse(`${date}T12:00:00Z`);
  return Number.isFinite(parsed) ? date : null;
}

function datePart(value) {
  const raw = clean(value, 40);
  if (!raw) return null;
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? validDate(match[1]) : null;
}

/** Normalize legal references without treating a bare agency/title token as law evidence. */
export function citationLawKeys(value) {
  const text = clean(value, 600).toLowerCase();
  if (!text) return [];
  const keys = [];
  const patterns = [
    /(?:§{1,2}|section)\s*[a-z0-9][a-z0-9().-]*/g,
    /(?:local law|ll|intro|int|file)\s*[a-z0-9][a-z0-9().-]*/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      keys.push(match[0].replace(/\s+/g, "").replace(/^section/, "§"));
    }
  }
  return [...new Set(keys)];
}

/** Content tokens for conservative topic join (no stemming). */
export function contentTokens(text) {
  return [...new Set(
    String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 4 && !STOPWORDS.has(token) && !/^\d+$/.test(token)),
  )];
}

export function expectedEventForDeliverable(deliverableType) {
  const key = clean(deliverableType, 80) || "other";
  return EXPECTED_EVENT_BY_DELIVERABLE[key] || EXPECTED_EVENT_BY_DELIVERABLE.other;
}

export function isDetectableDeliverable(deliverableType) {
  return DETECTABLE_DELIVERABLES.includes(clean(deliverableType, 80));
}

/**
 * Normalize one public-record event candidate for join.
 * @param {object} raw
 */
export function normalizeObservationCandidate(raw = {}) {
  const requestId = clean(raw.request_id || raw.id, 40);
  const label = clean(raw.label || raw.short_title || raw.title, 320);
  if (!label && !requestId) return null;
  const agencyId = clean(raw.agency_id, 120) || null;
  const agencyName = clean(raw.agency_name || raw.agency, 200) || null;
  const when = datePart(raw.when || raw.start_date || raw.date || raw.observed_at);
  const body = clean(
    raw.body || raw.body_text || raw.rule_body || raw.description || raw.additional_description_1,
    4000,
  ) || null;
  const citation = clean(
    raw.citation || raw.law_citation || raw.law_number || raw.law_number_display
      || raw.file_number || raw.reference,
    240,
  ) || null;
  const section = clean(raw.section_name || raw.section, 80).toLowerCase();
  const type = clean(raw.type_of_notice_description || raw.notice_type || raw.type, 120).toLowerCase();
  const domain = clean(raw.domain || raw.signal_domain, 40).toLowerCase() || null;
  const blob = `${label} ${type} ${section}`.toLowerCase();
  const isRules = domain === "rules"
    || section.includes("agency rules")
    || /rule|regulatory agenda|proposed rule|adoption of rules|emergency rule/.test(blob);
  const isReportShaped = /\breport\b|\bstudy\b|\bsurvey\b|\bevaluation\b|\bplan\b|\bstrategy\b/.test(blob)
    && !isRules;
  const isHearing = domain === "meetings"
    || /public hearing|hearing/.test(blob);
  let signalKind = clean(raw.signal_kind, 40) || null;
  if (!signalKind) {
    if (isRules) signalKind = "rule_filing";
    else if (isReportShaped) signalKind = "report_or_study";
    else if (isHearing) signalKind = "public_hearing";
    else signalKind = "other_notice";
  }
  return {
    request_id: requestId || null,
    label: label || requestId,
    when,
    agency_id: agencyId,
    agency_name: agencyName,
    signal_kind: signalKind,
    domain: domain || (isRules ? "rules" : isHearing ? "meetings" : "city_record"),
    href: clean(raw.href, 240)
      || (requestId ? `#notice/${encodeURIComponent(requestId)}` : null),
    source_system: clean(raw.source_system || raw.provenance?.source_system || "city_record", 80),
    body,
    citation,
    citation_keys: citationLawKeys([
      citation,
      raw.law_text,
      raw.body_text,
      raw.body,
      raw.rule_body,
    ].filter(Boolean).join(" ")),
    negative_evidence: Array.isArray(raw.negative_evidence)
      ? raw.negative_evidence.map((item) => clean(item, 120)).filter(Boolean).slice(0, 8)
      : [],
    tokens: contentTokens(label),
  };
}

/**
 * Collect observation candidates for one agency from committed materializations.
 * Rules domain observations + entity-intelligence rules objects + meetings rows.
 */
export function collectAgencyObservationCandidates({
  agencyId,
  agencyName = null,
  rulesDomain = null,
  meetingsDomain = null,
  entityIntelligence = null,
} = {}) {
  const identity = resolveAgencyIdentity(agencyId || agencyName);
  const id = identity?.canonical_id || clean(agencyId, 120);
  const name = identity?.canonical_name || clean(agencyName, 200);
  const nameLower = (name || "").toLowerCase();
  const out = [];
  const seen = new Set();

  const push = (raw) => {
    const row = normalizeObservationCandidate(raw);
    if (!row) return;
    const key = row.request_id || `${row.label}|${row.when || ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(row);
  };

  const agencyMatches = (rowAgency) => {
    const raw = clean(rowAgency, 200);
    if (!raw) return false;
    if (nameLower && raw.toLowerCase() === nameLower) return true;
    const resolved = resolveAgencyIdentity(raw);
    return resolved?.canonical_id && resolved.canonical_id === id;
  };

  for (const row of rulesDomain?.rows || []) {
    if (!agencyMatches(row.agency_name || row.agency)) continue;
    push({
      ...row,
      domain: "rules",
      signal_kind: "rule_filing",
      agency_id: id,
      agency_name: name,
    });
  }

  for (const row of meetingsDomain?.rows || []) {
    if (!agencyMatches(row.agency_name || row.agency)) continue;
    push({
      ...row,
      domain: "meetings",
      agency_id: id,
      agency_name: name,
    });
  }

  const ref = id ? `agency:id:${id}` : null;
  const ei = entityIntelligence?.by_ref?.[ref]
    || entityIntelligence?.by_subject_ref?.[ref]
    || null;
  for (const object of ei?.domains?.rules?.objects || []) {
    push({
      request_id: object.request_id,
      label: object.label,
      when: object.when,
      href: object.href,
      domain: "rules",
      signal_kind: "rule_filing",
      agency_id: id,
      agency_name: name,
      source_system: object.provenance?.source_system || "city_record",
    });
  }
  for (const object of ei?.domains?.meetings?.objects || []) {
    push({
      request_id: object.request_id,
      label: object.label,
      when: object.when,
      href: object.href,
      domain: "meetings",
      agency_id: id,
      agency_name: name,
      source_system: object.provenance?.source_system || "city_record",
    });
  }

  return out.sort((left, right) => String(right.when || "").localeCompare(String(left.when || "")));
}

/** Score whether a candidate notice is a topic match for a mandate duty. */
export function scoreTopicMatch(dutyText, candidate) {
  const dutyTokens = contentTokens(dutyText);
  const noticeTokens = Array.isArray(candidate?.tokens)
    ? candidate.tokens
    : contentTokens(candidate?.label);
  if (!dutyTokens.length || !noticeTokens.length) {
    return { score: 0, shared: [], method: null };
  }
  const noticeSet = new Set(noticeTokens);
  const shared = dutyTokens.filter((token) => noticeSet.has(token));
  if (shared.length >= 2) {
    return { score: shared.length, shared, method: "topic_token_overlap_v1" };
  }
  return { score: 0, shared: [], method: null };
}

function mandateCitationKeys(mandate) {
  return citationLawKeys([
    mandate?.citation,
    mandate?.source?.citation,
    mandate?.file_number,
    mandate?.law_number_display,
    mandate?.matter_id,
  ].filter(Boolean).join(" "));
}

function candidateCitationKeys(candidate) {
  return citationLawKeys([
    candidate?.citation,
    candidate?.citation_keys?.join(" "),
    candidate?.law_number,
    candidate?.law_number_display,
    candidate?.file_number,
    candidate?.matter_id,
    candidate?.law_text,
    candidate?.body,
  ].filter(Boolean).join(" "));
}

function agencyEvidenceMatches(mandate, candidate) {
  if (mandate?.agency_id && candidate?.agency_id) {
    const left = resolveAgencyIdentity(mandate.agency_id)?.canonical_id;
    const right = resolveAgencyIdentity(candidate.agency_id)?.canonical_id;
    return Boolean(left && right && left === right);
  }
  const left = clean(mandate?.agency_name, 200).toLowerCase();
  const right = clean(candidate?.agency_name, 200).toLowerCase();
  return !left || !right || left === right;
}

function negativeEvidenceFor(mandate, candidate, temporalCompatible) {
  const negative = Array.isArray(candidate?.negative_evidence)
    ? candidate.negative_evidence.slice()
    : [];
  const statusText = `${candidate?.label || ""} ${candidate?.body || ""}`.toLowerCase();
  if (/\b(withdrawn|repealed|rescinded|superseded|cancelled|canceled|rejected|not adopted)\b/.test(statusText)) {
    negative.push("adverse_rule_status");
  }
  if (!temporalCompatible) negative.push("temporal_incompatibility");
  const disqualifying = Array.isArray(mandate?.negative_terms)
    ? new Set(mandate.negative_terms.flatMap((term) => contentTokens(term)))
    : new Set();
  const candidateTokens = new Set(contentTokens(`${candidate?.label || ""} ${candidate?.body || ""}`));
  for (const token of disqualifying) {
    if (candidateTokens.has(token)) negative.push(`mandate_negative_term:${token}`);
  }
  return [...new Set(negative.map((item) => clean(item, 120)).filter(Boolean))];
}

/**
 * Build the relation-specific mandate → rule feature vector. Missing source
 * fields stay missing/false; they never become positive evidence by default.
 */
export function scoreMandateRuleEvidence(mandate, candidate, { expectedKind = "rule_filing" } = {}) {
  const topic = scoreTopicMatch(mandate?.duty_text || mandate?.label || mandate?.action_summary, candidate);
  const bodyTokens = contentTokens(candidate?.body || "");
  const dutyTokens = contentTokens(mandate?.duty_text || mandate?.label || mandate?.action_summary);
  const bodySet = new Set(bodyTokens);
  const ruleBodyOverlap = [...new Set(dutyTokens.filter((token) => bodySet.has(token)))];
  const deadlineDate = validDate(mandate?.deadline?.computed_date || mandate?.deadline_date);
  const temporalCompatible = candidateWithinDeadlinePlausibility(candidate, deadlineDate)
    && (!mandate?.effective_date || !candidate?.when || candidate.when >= mandate.effective_date);
  const mandateKeys = mandateCitationKeys(mandate);
  const candidateKeys = candidateCitationKeys(candidate);
  const citationLawOverlap = mandateKeys.filter((key) => candidateKeys.includes(key));
  const citationLawMatch = candidate?.citation_law_match === true || citationLawOverlap.length > 0;
  const negativeEvidence = negativeEvidenceFor(mandate, candidate, temporalCompatible);
  const features = {
    agency_exact: agencyEvidenceMatches(mandate, candidate),
    expected_event_match: candidateFitsExpected(candidate, expectedKind),
    topic_overlap: topic.shared,
    rule_body_overlap: ruleBodyOverlap,
    citation_law_match: citationLawMatch,
    citation_law_overlap: citationLawOverlap,
    temporal_compatible: temporalCompatible,
    negative_evidence: negativeEvidence,
    negative_evidence_free: negativeEvidence.length === 0,
  };
  const publicationEligible = features.agency_exact
    && features.expected_event_match
    && features.topic_overlap.length >= 2
    && features.rule_body_overlap.length >= 1
    && features.citation_law_match
    && features.temporal_compatible
    && features.negative_evidence_free;
  return {
    ...features,
    topic_score: topic.score,
    publication_eligible: publicationEligible,
    publication_tier: publicationEligible
      ? MANDATE_RULE_PUBLICATION_TIER
      : MANDATE_RULE_EVIDENCE_ONLY_TIER,
  };
}

function candidateWithinDeadlinePlausibility(candidate, deadlineDate) {
  if (!deadlineDate || !candidate?.when) return true;
  const deadlineMs = Date.parse(`${deadlineDate}T12:00:00Z`);
  const candidateMs = Date.parse(`${candidate.when}T12:00:00Z`);
  if (!Number.isFinite(deadlineMs) || !Number.isFinite(candidateMs)) return true;
  const daysAfterDeadline = Math.floor((candidateMs - deadlineMs) / 86_400_000);
  return daysAfterDeadline <= MAX_POST_DEADLINE_PLAUSIBILITY_DAYS;
}

function candidateFitsExpected(candidate, expectedKind) {
  if (!candidate) return false;
  if (expectedKind === "rule_filing") return candidate.signal_kind === "rule_filing";
  if (expectedKind === "report_or_study") {
    return candidate.signal_kind === "report_or_study"
      || (candidate.signal_kind === "rule_filing" && /\breport\b|\bstudy\b|\bplan\b/.test(String(candidate.label || "").toLowerCase()));
  }
  if (expectedKind === "public_hearing") return candidate.signal_kind === "public_hearing";
  return false;
}

/**
 * Resolve observation for one mandate against candidates.
 * Machine fields keep an internal adjudication marker; reader labels state the fact.
 */
export function resolveMandateObservation(mandate, candidates = [], { asOf = null } = {}) {
  const deliverable = clean(mandate?.deliverable_type || mandate?.expected_event, 80) || "other";
  const expected = expectedEventForDeliverable(deliverable);
  const duty = clean(mandate?.duty_text || mandate?.label || mandate?.action_summary, 500);
  const deadlineDate = validDate(mandate?.deadline?.computed_date || mandate?.deadline_date);
  const today = validDate(asOf) || new Date().toISOString().slice(0, 10);
  const base = {
    expected_event: {
      kind: expected.kind,
      label: expected.label,
      deliverable_type: deliverable,
      deadline_date: deadlineDate,
      deadline_text: clean(mandate?.deadline?.text || mandate?.deadline_text, 240) || null,
    },
    // Internal schema markers for downstream tools — not reader copy.
    is_compliance_verdict: false,
    adjudication: "not_adjudicated",
    method: PROCESS_CONFORMANCE_METHOD,
  };

  if (!isDetectableDeliverable(deliverable) || !expected.signal) {
    return {
      ...base,
      status: OBSERVATION_STATUS.ENRICHMENT_PENDING,
      label: OBSERVATION_LABELS[OBSERVATION_STATUS.ENRICHMENT_PENDING],
      note: `No City Record detector for “${deliverable}” yet.`,
      observed_record: null,
      match: null,
    };
  }

  let best = null;
  for (const candidate of candidates) {
    if (!candidateFitsExpected(candidate, expected.kind)) continue;
    if (!candidateWithinDeadlinePlausibility(candidate, deadlineDate)) continue;
    const match = scoreTopicMatch(duty, candidate);
    if (match.score <= 0) continue;
    const evidence = expected.kind === "rule_filing"
      ? scoreMandateRuleEvidence(mandate, candidate, { expectedKind: expected.kind })
      : null;
    if (!best || (evidence?.publication_eligible && !best.evidence?.publication_eligible)
      || (Boolean(evidence?.publication_eligible) === Boolean(best.evidence?.publication_eligible)
        && match.score > best.match.score)) {
      best = { candidate, match, evidence };
    }
  }

  if (best) {
    if (best.evidence && !best.evidence.publication_eligible) {
      return {
        ...base,
        status: OBSERVATION_STATUS.EVIDENCE_ONLY,
        label: OBSERVATION_LABELS[OBSERVATION_STATUS.EVIDENCE_ONLY],
        note: "Candidate retained as evidence-only because the mandate-to-rule publication gate was not met.",
        observed_record: null,
        shadow_candidate: {
          request_id: best.candidate.request_id,
          label: best.candidate.label,
          when: best.candidate.when,
          href: best.candidate.href,
          features: best.evidence,
        },
        match: {
          method: best.match.method,
          shared_tokens: best.match.shared.slice(0, 8),
          score: best.match.score,
          evidence: best.evidence,
          publication: MANDATE_RULE_EVIDENCE_ONLY_TIER,
        },
      };
    }
    return {
      ...base,
      status: OBSERVATION_STATUS.OBSERVED,
      label: OBSERVATION_LABELS[OBSERVATION_STATUS.OBSERVED],
      note: "Matched a City Record filing by agency identity and shared topic tokens.",
      observed_record: {
        request_id: best.candidate.request_id,
        label: best.candidate.label,
        when: best.candidate.when,
        href: best.candidate.href,
        source_system: best.candidate.source_system,
        signal_kind: best.candidate.signal_kind,
      },
      match: {
        method: best.match.method,
        shared_tokens: best.match.shared.slice(0, 8),
        score: best.match.score,
        ...(best.evidence ? {
          evidence: best.evidence,
          publication: MANDATE_RULE_PUBLICATION_TIER,
        } : {}),
      },
    };
  }

  // Not observed in the checked public-record corpus.
  const futureDeadline = deadlineDate && deadlineDate > today;
  if (futureDeadline) {
    return {
      ...base,
      status: OBSERVATION_STATUS.ON_TRACK,
      label: OBSERVATION_LABELS[OBSERVATION_STATUS.ON_TRACK],
      note: `Expected ${expected.label} by ${deadlineDate}. No matching City Record filing yet.`,
      observed_record: null,
      match: null,
    };
  }

  return {
    ...base,
    status: OBSERVATION_STATUS.EXPECTED_NOT_YET_OBSERVED,
    label: OBSERVATION_LABELS[OBSERVATION_STATUS.EXPECTED_NOT_YET_OBSERVED],
    note: `Expected ${expected.label}${deadlineDate ? ` by ${deadlineDate}` : ""}. No matching City Record filing in the current corpus.`,
    observed_record: null,
    match: null,
  };
}

/**
 * Build agency-level process-conformance view over mandates + observation corpus.
 */
export function buildAgencyConformanceView(agencyIdOrName, {
  obligationsLookup = null,
  rulesDomain = null,
  meetingsDomain = null,
  entityIntelligence = null,
  asOf = null,
  limit = 40,
} = {}) {
  const identity = resolveAgencyIdentity(agencyIdOrName);
  if (!identity?.canonical_id) return null;
  const bucket = obligationsLookup?.by_agency?.[identity.canonical_id] || null;
  const mandates = Array.isArray(bucket?.obligations) ? bucket.obligations : [];
  const candidates = collectAgencyObservationCandidates({
    agencyId: identity.canonical_id,
    agencyName: identity.canonical_name,
    rulesDomain,
    meetingsDomain,
    entityIntelligence,
  });
  const today = validDate(asOf) || new Date().toISOString().slice(0, 10);

  const items = mandates.map((row) => {
    const observation = resolveMandateObservation(row, candidates, { asOf: today });
    return {
      mandate_id: row.obligation_id,
      obligation_id: row.obligation_id, // stable internal id
      duty_text: row.duty_text,
      deliverable_type: row.deliverable_type,
      recurrence: row.recurrence,
      citation: row.citation,
      deadline_date: row.deadline?.computed_date || null,
      deadline_text: row.deadline?.text || null,
      source: row.source || null,
      source_href: row.source?.legistar_url || null,
      certification_status: row.certification?.status || null,
      observation,
    };
  });

  // Sort: observed first for demo scan, then on-track, then expected-not-yet, then enrichment.
  const rank = {
    [OBSERVATION_STATUS.OBSERVED]: 0,
    [OBSERVATION_STATUS.EVIDENCE_ONLY]: 1,
    [OBSERVATION_STATUS.ON_TRACK]: 2,
    [OBSERVATION_STATUS.EXPECTED_NOT_YET_OBSERVED]: 3,
    [OBSERVATION_STATUS.ENRICHMENT_PENDING]: 4,
  };
  items.sort((left, right) => {
    const leftRank = rank[left.observation.status] ?? 9;
    const rightRank = rank[right.observation.status] ?? 9;
    if (leftRank !== rightRank) return leftRank - rightRank;
    const leftDate = left.deadline_date || "9999";
    const rightDate = right.deadline_date || "9999";
    if (leftDate !== rightDate) return leftDate.localeCompare(rightDate);
    return String(left.mandate_id).localeCompare(String(right.mandate_id));
  });

  const counts = {
    total: items.length,
    observed: 0,
    expected_not_yet_observed: 0,
    on_track: 0,
    enrichment_pending: 0,
    detectable: 0,
  };
  for (const item of items) {
    counts[item.observation.status] = (counts[item.observation.status] || 0) + 1;
    if (isDetectableDeliverable(item.deliverable_type)) counts.detectable += 1;
  }

  return {
    schema: PROCESS_CONFORMANCE_SCHEMA,
    method: PROCESS_CONFORMANCE_METHOD,
    iteration: PROCESS_CONFORMANCE_ITERATION,
    agency_id: identity.canonical_id,
    agency_name: identity.canonical_name || bucket?.agency_name || identity.canonical_id,
    subject_ref: `agency:id:${identity.canonical_id}`,
    as_of: today,
    status: items.length ? "matched" : "empty",
    counts,
    candidate_corpus: {
      size: candidates.length,
      sources: [
        "rules_domain_observations",
        "meetings_domain_observations",
        "entity_intelligence.rules",
        "entity_intelligence.meetings",
      ],
      sample: candidates.slice(0, 6).map((row) => ({
        request_id: row.request_id,
        label: row.label,
        when: row.when,
        signal_kind: row.signal_kind,
        href: row.href,
      })),
    },
    items: items.slice(0, limit),
    items_total: items.length,
    copy: CONFORMANCE_COPY,
    honesty: CONFORMANCE_COPY, // alias
    share_path: agencyMandatesConformancePath(identity.canonical_id),
    // Seams for later process-mining enrichment (event logs, alignments).
    seams: {
      event_log: "future: civic-time event log per mandate subject_ref",
      normative_model: "future: Process Mining Manifesto normative model overlay",
      multi_source: "future: Required Reports, agency sites, Legistar attachments",
    },
  };
}

/** Shareable path for an agency's mandates conformance surface. */
export function agencyMandatesConformancePath(agencyIdOrName) {
  const identity = resolveAgencyIdentity(agencyIdOrName);
  if (!identity?.canonical_id) return "/agencies/";
  return `/agencies/${encodeURIComponent(identity.canonical_id)}/#mandates-conformance`;
}

/**
 * Build the committed multi-agency lookup artifact.
 */
export function buildProcessConformanceLookup({
  obligationsLookup = null,
  rulesDomain = null,
  meetingsDomain = null,
  entityIntelligence = null,
  asOf = null,
  agencyIds = null,
  generatedAt = null,
} = {}) {
  const today = validDate(asOf) || new Date().toISOString().slice(0, 10);
  const ids = Array.isArray(agencyIds) && agencyIds.length
    ? agencyIds
    : Object.keys(obligationsLookup?.by_agency || {}).sort();
  const byAgency = Object.create(null);
  let mandateTotal = 0;
  let observedTotal = 0;
  let detectableTotal = 0;

  for (const id of ids) {
    const view = buildAgencyConformanceView(id, {
      obligationsLookup,
      rulesDomain,
      meetingsDomain,
      entityIntelligence,
      asOf: today,
      // Full mandate text lives in agency_obligations_lookup; store observation
      // deltas only so the public artifact stays small and single-owned.
      limit: 500,
    });
    if (!view || view.status === "empty") continue;
    const observations = Object.create(null);
    for (const item of view.items || []) {
      const mid = item.mandate_id || item.obligation_id;
      if (!mid) continue;
      const expected = item.observation?.expected_event || null;
      observations[mid] = {
        status: item.observation?.status || null,
        label: item.observation?.label || null,
        expected_event: expected
          ? {
            kind: expected.kind || null,
            label: expected.label || null,
            deliverable_type: expected.deliverable_type || null,
            deadline_date: expected.deadline_date || null,
          }
          : null,
        observed_record: item.observation?.observed_record
          ? {
            request_id: item.observation.observed_record.request_id || null,
            label: item.observation.observed_record.label || null,
            when: item.observation.observed_record.when || null,
            href: item.observation.observed_record.href || null,
            signal_kind: item.observation.observed_record.signal_kind || null,
          }
          : null,
        ...(item.observation?.shadow_candidate ? {
          shadow_candidate: {
            request_id: item.observation.shadow_candidate.request_id || null,
            label: item.observation.shadow_candidate.label || null,
            when: item.observation.shadow_candidate.when || null,
            href: item.observation.shadow_candidate.href || null,
            features: item.observation.shadow_candidate.features || null,
          },
        } : {}),
        match: item.observation?.match
          ? {
            method: item.observation.match.method,
            score: item.observation.match.score,
            shared_tokens: (item.observation.match.shared_tokens || []).slice(0, 6),
            publication: item.observation.match.publication || null,
            evidence: item.observation.match.evidence || null,
          }
          : null,
        is_compliance_verdict: false,
        adjudication: "not_adjudicated",
        method: item.observation?.method || PROCESS_CONFORMANCE_METHOD,
      };
    }
    byAgency[id] = {
      agency_id: view.agency_id,
      agency_name: view.agency_name,
      subject_ref: view.subject_ref,
      as_of: view.as_of,
      counts: view.counts,
      share_path: view.share_path,
      candidate_corpus_size: view.candidate_corpus.size,
      // Compact map: mandate_id → observation only (join duty text from obligations).
      observations,
    };
    mandateTotal += view.counts.total;
    observedTotal += view.counts.observed;
    detectableTotal += view.counts.detectable;
  }

  return {
    schema: PROCESS_CONFORMANCE_SCHEMA,
    method: PROCESS_CONFORMANCE_METHOD,
    iteration: PROCESS_CONFORMANCE_ITERATION,
    generated_at: generatedAt || new Date().toISOString(),
    as_of: today,
    copy: CONFORMANCE_COPY,
    honesty: CONFORMANCE_COPY, // alias for older readers
    summary: {
      agency_count: Object.keys(byAgency).length,
      mandate_count: mandateTotal,
      detectable_mandate_count: detectableTotal,
      observed_count: observedTotal,
      detectable_deliverables: [...DETECTABLE_DELIVERABLES],
    },
    by_agency: byAgency,
    seams: {
      event_log: "future: civic-time event log per mandate subject_ref",
      normative_model: "future: Process Mining Manifesto normative model overlay",
      multi_source: "future: Required Reports, agency sites, Legistar attachments",
    },
    verified_demo: "agency:id:parks-and-recreation",
  };
}

/** Compact HTML for constellation embedding (mandates conformance section). */
export function renderMandatesConformanceSection(view, { limit = 12 } = {}) {
  if (!view) return "";
  const counts = view.counts || {};
  if (!(counts.observed > 0)) return "";
  const publicItems = (view.items || []).filter((item) => (
    item.observation?.status === OBSERVATION_STATUS.OBSERVED
    || item.observation?.status === OBSERVATION_STATUS.ON_TRACK
  ));
  if (!publicItems.length) return "";
  const statusLine = [
    `${counts.observed || 0} observed`,
    counts.on_track > 0 ? `${counts.on_track} on track` : null,
  ].filter(Boolean).join(" · ");

  const items = publicItems.slice(0, limit);
  const sourceItems = items.filter((item) => item.source_href).map((item) => ({
    href: item.source_href,
    label: item.duty_text || "Source law",
  }));
  const list = items.length
    ? `<ul class="node-record-list mandates-conformance-list">${items.map((item) => {
      const obs = item.observation || {};
      const status = obs.status || OBSERVATION_STATUS.ENRICHMENT_PENDING;
      const statusLabel = obs.label || OBSERVATION_LABELS[status] || status;
      const expected = obs.expected_event || {};
      const deadline = expected.deadline_date
        ? `deadline ${expected.deadline_date}`
        : (expected.deadline_text ? `deadline: ${expected.deadline_text}` : null);
      const observedLink = obs.observed_record?.href
        ? ` · ${constellationLink({ href: obs.observed_record.href, label: `City Record: ${obs.observed_record.label || obs.observed_record.request_id}`, className: "agency-edge-link", escape: esc })}`
        : "";
      const meta = [
        item.deliverable_type,
        expected.label || null,
        deadline,
        item.recurrence,
      ].filter(Boolean).map(esc).join(" · ");
      return `<li class="node-record mandate-conformance-item" data-mandate-id="${esc(item.mandate_id)}" data-observation-status="${esc(status)}" data-compliance-verdict="not_adjudicated">
        <div class="node-record-main">
          <span class="mandate-obs-chip mandate-obs-${esc(status)}" data-observation-label="${esc(status)}">${esc(statusLabel)}</span>
          ${esc(item.duty_text)}
        </div>
        <span class="muted node-muted">${meta}${item.citation ? ` · ${esc(item.citation)}` : ""}${observedLink}</span>
      </li>`;
    }).join("")}</ul>`
    : `<p class="node-muted">${esc(view.note || "No mandates are linked to this agency in the current materialization.")}</p>`;

  const share = view.share_path
    ? `<a class="node-action civic-object-action" href="${esc(view.share_path)}">Share this mandates view</a>`
    : "";

  const copy = view.copy || view.honesty || CONFORMANCE_COPY;
  return `<section id="mandates-conformance" class="node-section node-card civic-object-section mandates-conformance" data-agency-constellation-category="obligations" data-process-conformance="v1" data-status="${esc(view.status)}" data-export-class="object_members" data-method="${esc(view.method || PROCESS_CONFORMANCE_METHOD)}" data-certification-basis="auto_certified_quote_verify_v1">
    <h2>Mandates · expected vs observed <span class="muted node-muted">(${esc(statusLine)})</span></h2>
    <p class="node-muted muted">${esc(copy.lead || CONFORMANCE_COPY.lead)}</p>
    ${list}
    ${officialSourceDisclosure({ items: sourceItems, label: "Open source laws", escape: esc })}
    ${share ? `<p class="node-inline-actions civic-object-inline-actions">${share}</p>` : ""}
  </section>`;
}

/** Minimal CSS fragment for observation chips (injected via civic-documents or inline). */
export const MANDATE_CONFORMANCE_STYLE = `
main:not(:has(#mandates-conformance)) a[href$="#mandates-conformance"] {
  display: none;
}
.mandates-conformance .mandate-obs-chip {
  display: inline-block;
  margin-inline-end: 0.5rem;
  padding: 0.1rem 0.45rem;
  border-radius: 999px;
  border: 1px solid var(--color-border, #c8c8c8);
  font: 600 0.75rem/1.3 var(--font-body, system-ui, sans-serif);
  letter-spacing: 0.01em;
  vertical-align: 0.05em;
  white-space: nowrap;
}
.mandates-conformance .mandate-obs-observed {
  background: color-mix(in srgb, var(--color-action, #0b57d0) 12%, transparent);
  border-color: color-mix(in srgb, var(--color-action, #0b57d0) 35%, var(--color-border, #c8c8c8));
}
.mandates-conformance .mandate-obs-on_track {
  background: color-mix(in srgb, var(--color-text, #222) 6%, transparent);
}
.mandates-conformance .mandate-conformance-item .node-record-main {
  line-height: 1.45;
}
`;
