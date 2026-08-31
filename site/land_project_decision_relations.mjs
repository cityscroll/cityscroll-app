/**
 * Audited land-project relation vocabulary and compatibility adapter.
 *
 * Exact meeting→project joins remain on `decides_land_project` for existing
 * consumers. That identifier is a staged compatibility projection: it does not
 * mean the meeting decided the project. Canonical semantics are concern,
 * review, documentary recommendation, or documented disposition.
 */

export const LAND_PROJECT_DECISION_RELATION_SCHEMA = "cityscroll.land_project_decision_relation.v1";
export const LAND_PROJECT_DECISION_RELATION_VERSION = "1.0.0";
export const LAND_PROJECT_DECISION_RELATION_METHOD = "land_project_decision_relation_v1";
export const DECIDES_LAND_PROJECT_COMPATIBILITY = "decides_land_project";
export const ABOUT_PROJECT_RELATION = "about_project";
export const ABOUT_PROJECT_INVERSE = "has_notice";
export const ABOUT_PROJECT_READER_LABEL = "About this project";
export const EXACT_KEY_EDGE_TIER = "deterministic_exact_key";

const ABOUT_PROJECT_EVIDENCE = Object.freeze([
  "source_system",
  "source_record_id",
  "source_fields",
  "retained_identifier",
  "exact_join_key",
  "exact_join_value",
  "method_version",
  "observed_time",
  "source_url",
  "confidence",
  "tier",
  "project_id",
]);

export const LAND_PROJECT_SEMANTIC_THRESHOLDS = Object.freeze({
  CONCERN: "exact_project_or_application_or_ulurp_reference",
  REVIEW: "exact_project_or_application_or_ulurp_reference",
  RECOMMENDATION: "documentary_recommendation_evidence",
  DECISION: "explicit_authoritative_disposition",
});

const REQUIRED_EVIDENCE = Object.freeze([
  "source_record",
  "exact_join_key",
  "exact_join_value",
  "source_fields",
  "method_version",
  "observed_time",
  "semantic_threshold",
]);

export const LAND_PROJECT_RELATION_VOCABULARY = Object.freeze({
  about_project: Object.freeze({
    id: "about_project",
    family: "concern",
    domain: "meetings",
    from: "notice|meeting",
    to: "project",
    inverse: ABOUT_PROJECT_INVERSE,
    compatibility_relation: DECIDES_LAND_PROJECT_COMPATIBILITY,
    is_decision: false,
    semantic_threshold: LAND_PROJECT_SEMANTIC_THRESHOLDS.CONCERN,
    required_evidence: ABOUT_PROJECT_EVIDENCE,
    reader_label: ABOUT_PROJECT_READER_LABEL,
    negative_rule: "A meeting title, venue, body identity, date, draft row, or exact project join never proves a decision, recommendation, adoption, or rejection.",
  }),
  reviews_project: Object.freeze({
    id: "reviews_project",
    family: "review",
    domain: "meetings",
    from: "notice|meeting",
    to: "project",
    inverse: "reviewed_at",
    compatibility_relation: DECIDES_LAND_PROJECT_COMPATIBILITY,
    is_decision: false,
    semantic_threshold: LAND_PROJECT_SEMANTIC_THRESHOLDS.REVIEW,
    required_evidence: REQUIRED_EVIDENCE,
    reader_label: "Hearing that reviews this project",
    negative_rule: "A review hearing with an exact project reference is still not a documented disposition.",
  }),
  issues_recommendation: Object.freeze({
    id: "issues_recommendation",
    family: "recommendation",
    domain: "land",
    from: "community-board|borough-president|borough-board|agency",
    to: "project",
    inverse: "received_recommendation_from",
    compatibility_relation: null,
    is_decision: false,
    semantic_threshold: LAND_PROJECT_SEMANTIC_THRESHOLDS.RECOMMENDATION,
    required_evidence: Object.freeze([
      ...REQUIRED_EVIDENCE,
      "retained_recommendation_document",
    ]),
    reader_label: "Published recommendation",
    negative_rule: "Draft rows, hearing presence, and exact project joins never mint a recommendation.",
  }),
  project_disposition: Object.freeze({
    id: "project_disposition",
    family: "decision",
    domain: "land",
    from: "community-board|borough-president|borough-board|agency",
    to: "project",
    inverse: "has_disposition_from",
    compatibility_relation: null,
    is_decision: true,
    semantic_threshold: LAND_PROJECT_SEMANTIC_THRESHOLDS.DECISION,
    required_evidence: Object.freeze([
      ...REQUIRED_EVIDENCE,
      "explicit_authoritative_disposition",
    ]),
    reader_label: "Documented decision",
    negative_rule: "Draft, pending, hearing-only, and meeting-join rows are not documented decisions.",
  }),
  adopts: Object.freeze({
    id: "adopts",
    family: "decision",
    domain: "land",
    from: "community-board|agency",
    to: "project",
    inverse: "adopted_by",
    compatibility_relation: null,
    is_decision: true,
    semantic_threshold: LAND_PROJECT_SEMANTIC_THRESHOLDS.DECISION,
    required_evidence: Object.freeze([
      ...REQUIRED_EVIDENCE,
      "explicit_adoption_statement",
    ]),
    reader_label: "Documented adoption",
    negative_rule: "Do not infer adoption from a hearing, draft row, or exact project join.",
  }),
  rejects: Object.freeze({
    id: "rejects",
    family: "decision",
    domain: "land",
    from: "community-board|agency",
    to: "project",
    inverse: "rejected_by",
    compatibility_relation: null,
    is_decision: true,
    semantic_threshold: LAND_PROJECT_SEMANTIC_THRESHOLDS.DECISION,
    required_evidence: Object.freeze([
      ...REQUIRED_EVIDENCE,
      "explicit_rejection_statement",
    ]),
    reader_label: "Documented rejection",
    negative_rule: "Do not infer rejection from a hearing, draft row, or exact project join.",
  }),
  decides_land_project: Object.freeze({
    id: DECIDES_LAND_PROJECT_COMPATIBILITY,
    family: "compatibility",
    domain: "meetings",
    from: "notice|meeting",
    to: "project",
    inverse: "has_meeting_join",
    compatibility_relation: DECIDES_LAND_PROJECT_COMPATIBILITY,
    is_decision: false,
    semantic_threshold: LAND_PROJECT_SEMANTIC_THRESHOLDS.CONCERN,
    required_evidence: REQUIRED_EVIDENCE,
    projects_canonical: Object.freeze([ABOUT_PROJECT_RELATION, "reviews_project"]),
    reader_label: "Exact project-related proceeding",
    negative_rule: "Compatibility only. Existing consumers keep this id until migration is complete; it does not mean the meeting decided the project.",
  }),
});

export const MEETING_LAND_GRAPH_TYPES = Object.freeze([
  DECIDES_LAND_PROJECT_COMPATIBILITY,
  ABOUT_PROJECT_RELATION,
  "reviews_project",
]);

const REVIEW_BODY = /\b(?:community board|borough president|borough board|city planning commission|city council|planning commission)\b/i;
const HEARING_MARK = /\bhearing\b/i;
const DRAFT_STATUS = /^draft$/i;
const PENDING_OUTCOME = /^(pending|not yet|scheduled)$/i;
const ADOPT_MARK = /\b(?:adopt(?:ed|s|ion)?|approved)\b/i;
const REJECT_MARK = /\b(?:reject(?:ed|s|ion)?|disapproved|denied|unfavorable)\b/i;
const AUTHORITATIVE_OUTCOME = /\b(?:favorable|unfavorable|approved|disapproved|denied|adopted|rejected|conditional|withdrawn|modified)\b/i;

function clean(value, max = 500) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function asList(value) {
  if (Array.isArray(value)) return value.map((item) => clean(item)).filter(Boolean);
  const text = clean(value);
  return text ? [text] : [];
}

function reject(reason, extras = {}) {
  return Object.freeze({
    schema: LAND_PROJECT_DECISION_RELATION_SCHEMA,
    version: LAND_PROJECT_DECISION_RELATION_VERSION,
    accepted: false,
    canonical_relation: null,
    compatibility_relation: null,
    family: null,
    is_decision: false,
    semantic_threshold: null,
    reader_label: null,
    reason,
    evidence: null,
    ...extras,
  });
}

function accept(vocab, evidence, extras = {}) {
  return Object.freeze({
    schema: LAND_PROJECT_DECISION_RELATION_SCHEMA,
    version: LAND_PROJECT_DECISION_RELATION_VERSION,
    accepted: true,
    canonical_relation: vocab.id,
    compatibility_relation: vocab.compatibility_relation,
    family: vocab.family,
    is_decision: vocab.is_decision,
    semantic_threshold: vocab.semantic_threshold,
    reader_label: vocab.reader_label,
    reason: null,
    evidence: Object.freeze({ ...evidence }),
    ...extras,
  });
}

function evidenceEnvelope(input = {}) {
  const sourceRecord = clean(
    input.source_record
      || input.source_record_id
      || input.provenance?.source_record_id,
    240,
  );
  const joinKey = clean(input.join_key || input.provenance?.join_key, 80);
  const joinValue = clean(
    input.join_value
      ?? input.provenance?.join_value
      ?? input.provenance?.input_value,
    240,
  );
  const sourceFields = asList(input.source_fields || input.provenance?.source_fields);
  const method = clean(input.method || input.provenance?.basis, 80);
  const methodVersion = clean(input.method_version || input.methodVersion, 40) || (method ? "1" : "");
  const observedTime = clean(
    input.observed_time
      || input.observed_at
      || input.when
      || input.provenance?.observed_at,
    80,
  );
  return {
    source_record: sourceRecord || null,
    join_key: joinKey || null,
    join_value: joinValue || null,
    source_fields: sourceFields,
    method: method || null,
    method_version: methodVersion || null,
    observed_time: observedTime || null,
    tier: clean(input.tier || input.provenance?.tier, 80) || EXACT_KEY_EDGE_TIER,
  };
}

function evidenceComplete(envelope, threshold) {
  if (!envelope.source_record) return "missing_source_record";
  if (!envelope.join_key || !envelope.join_value) return "missing_exact_join";
  if (!envelope.source_fields.length) return "missing_source_fields";
  if (!envelope.method || !envelope.method_version) return "missing_method_version";
  if (!envelope.observed_time) return "missing_observed_time";
  if (!threshold) return "missing_semantic_threshold";
  return null;
}

export function isExactMeetingLandJoinMethod(method) {
  const value = clean(method, 80);
  return value === "exact_ulurp_token_v1"
    || value === "zap_project_ref_v1"
    || value === "exact_ulurp_token"
    || value === "exact_project_id"
    || value === "meeting_body_ulurp_token"
    || value === "meeting_body_zap_project";
}

export function isMeetingLandGraphType(type) {
  return MEETING_LAND_GRAPH_TYPES.includes(clean(type, 80));
}

function reviewProceeding(input = {}) {
  const haystack = [
    input.agency_name,
    input.label,
    input.short_title,
    input.type_of_notice_description,
    input.section_name,
    input.representing,
  ].map((part) => clean(part)).join(" ");
  return REVIEW_BODY.test(haystack) || HEARING_MARK.test(haystack);
}

/**
 * Classify an exact meeting/notice → land-project join.
 * Exact identity is required; the join never proves a decision.
 */
export function classifyMeetingLandProjectRelation(input = {}) {
  const envelope = evidenceEnvelope(input);
  if (input.fuzzy || input.match === "fuzzy" || input.provenance?.match === "fuzzy") {
    return reject("fuzzy_join");
  }
  if (input.unknown || input.status === "unknown") return reject("unknown_join");
  if (!isExactMeetingLandJoinMethod(envelope.method) && !isExactMeetingLandJoinMethod(input.join_method)) {
    if (!envelope.method) return reject("missing_method_version");
    return reject("unsupported_join_method");
  }
  const projectId = clean(input.project_id || String(input.to || "").replace(/^project:/, ""), 40);
  const fromRef = clean(input.from || input.subject_ref || input.notice_id, 80);
  if (!projectId || !fromRef) return reject("missing_identifier");
  const vocab = reviewProceeding(input)
    ? LAND_PROJECT_RELATION_VOCABULARY.reviews_project
    : LAND_PROJECT_RELATION_VOCABULARY.about_project;
  const incomplete = evidenceComplete(envelope, vocab.semantic_threshold);
  if (incomplete) return reject(incomplete);
  return accept(vocab, {
    ...envelope,
    semantic_threshold: vocab.semantic_threshold,
    project_id: projectId,
    from: fromRef,
  }, {
    compatibility_relation: DECIDES_LAND_PROJECT_COMPATIBILITY,
    is_decision: false,
  });
}

function dispositionOutcome(disposition = {}) {
  return clean(
    disposition.community_board
      || disposition.borough_president
      || disposition.borough_board
      || disposition.outcome
      || "",
  );
}

/**
 * Classify a ZAP/outcome disposition row. Draft and pending rows are not
 * documented decisions. Calendar-capable pending rows may still be returned
 * as non-decisional review events when they carry a date.
 */
export function classifyLandDispositionRelation(input = {}) {
  const disposition = input.disposition && typeof input.disposition === "object"
    ? input.disposition
    : input;
  const status = clean(disposition.status, 80);
  const outcome = dispositionOutcome(disposition);
  const envelope = evidenceEnvelope({
    ...input,
    source_record: input.source_record
      || disposition.id
      || disposition.source_ids?.[0]
      || input.project_id,
    join_key: input.join_key || "project_id",
    join_value: input.join_value || input.project_id || disposition.project_id,
    source_fields: input.source_fields || ["dispositions", "status"],
    method: input.method || "zap_disposition",
    method_version: input.method_version || "1",
    observed_time: input.observed_time
      || disposition.vote_date
      || disposition.hearing_date
      || disposition.hearing_at
      || input.project_id,
  });
  if (DRAFT_STATUS.test(status)) return reject("draft_only");
  if (!outcome || PENDING_OUTCOME.test(outcome)) {
    const when = clean(disposition.vote_date || disposition.hearing_date || disposition.hearing_at, 40);
    if (when) {
      const vocab = LAND_PROJECT_RELATION_VOCABULARY.reviews_project;
      const incomplete = evidenceComplete(envelope, vocab.semantic_threshold);
      if (incomplete) return reject(incomplete);
      return accept(vocab, {
        ...envelope,
        semantic_threshold: vocab.semantic_threshold,
        calendar_only: true,
      }, {
        is_decision: false,
        compatibility_relation: "project_disposition",
        calendar_when: when,
      });
    }
    return reject("no_authoritative_disposition");
  }
  if (!AUTHORITATIVE_OUTCOME.test(outcome) && !AUTHORITATIVE_OUTCOME.test(status)) {
    return reject("no_authoritative_disposition");
  }
  let vocab = LAND_PROJECT_RELATION_VOCABULARY.project_disposition;
  if (ADOPT_MARK.test(outcome) && !REJECT_MARK.test(outcome)) {
    vocab = LAND_PROJECT_RELATION_VOCABULARY.adopts;
  } else if (REJECT_MARK.test(outcome) && !ADOPT_MARK.test(outcome)) {
    vocab = LAND_PROJECT_RELATION_VOCABULARY.rejects;
  }
  const incomplete = evidenceComplete(envelope, vocab.semantic_threshold);
  if (incomplete) return reject(incomplete);
  if (input.recommendation && !input.recommendation_document && !input.document_url) {
    return reject("recommendation_without_document");
  }
  return accept(vocab, {
    ...envelope,
    semantic_threshold: vocab.semantic_threshold,
    outcome,
    status: status || null,
  });
}

export function classifyLandRecommendationRelation(input = {}) {
  const document = clean(input.document_url || input.recommendation_document || input.href, 1_000);
  if (!document || !/^https:\/\//i.test(document)) return reject("missing_recommendation_document");
  const envelope = evidenceEnvelope(input);
  const vocab = LAND_PROJECT_RELATION_VOCABULARY.issues_recommendation;
  const incomplete = evidenceComplete(envelope, vocab.semantic_threshold);
  if (incomplete) return reject(incomplete);
  return accept(vocab, {
    ...envelope,
    semantic_threshold: vocab.semantic_threshold,
    document_url: document,
  });
}

function noticeIdFromRef(value) {
  const match = clean(value, 80).match(/^notice:(.+)$/);
  return match ? match[1] : "";
}

function cityRecordNoticeUrl(noticeId) {
  return noticeId
    ? `https://a856-cityrecord.nyc.gov/RequestDetail/${encodeURIComponent(noticeId)}`
    : "";
}

function detectNonExactBridge(input = {}) {
  const bridge = clean(input.bridge || input.match_kind || input.join_basis, 40).toLowerCase();
  if (input.title_only || bridge === "title") return "title_only";
  if (input.address_only || bridge === "address") return "address_only";
  if (input.date_only || bridge === "date") return "date_only";
  if (input.publisher_only || bridge === "publisher") return "publisher_only";
  if (input.draft || input.draft_only || DRAFT_STATUS.test(clean(input.status, 40))) {
    return "draft_only";
  }
  if (input.fuzzy || input.match === "fuzzy" || input.provenance?.match === "fuzzy") {
    return "fuzzy_join";
  }
  if (input.unknown || input.status === "unknown") return "unknown_join";
  if (input.ambiguous || (Array.isArray(input.candidates) && input.candidates.length > 1)) {
    return "ambiguous_key";
  }
  if (input.no_reference || input.status === "no_ref") return "no_reference";
  if (input.missing_project || input.status === "no_land_match") return "missing_project";
  return null;
}

function unresolvedStop(reason, extras = {}) {
  return Object.freeze({
    schema: LAND_PROJECT_DECISION_RELATION_SCHEMA,
    version: LAND_PROJECT_DECISION_RELATION_VERSION,
    accepted: false,
    canonical_relation: null,
    compatibility_relation: null,
    family: null,
    is_decision: false,
    reader_label: null,
    inverse: ABOUT_PROJECT_INVERSE,
    canonical_edge: null,
    compatibility_edge: null,
    evidence: null,
    project_href: null,
    notice_href: null,
    reason,
    unresolved: Object.freeze({
      status: "unresolved",
      reason,
      inspectable: true,
    }),
    ...extras,
  });
}

/**
 * Materialize the canonical notice→project subject edge.
 *
 * Exact ULURP / application / ZAP identifiers mint `about_project`. The
 * compatibility identifier stays `decides_land_project`. Hearing or review
 * wording may ride as `proceeding_relation`; the subject edge never asserts a
 * recommendation or documented decision.
 */
export function materializeExactNoticeProjectEdge(input = {}, extras = {}) {
  const stop = detectNonExactBridge({ ...input, ...extras });
  if (stop) return unresolvedStop(stop);
  const filled = compatibilityMeetingDefaults(input, extras);
  const classified = classifyMeetingLandProjectRelation({
    ...input,
    ...extras,
    ...filled,
  });
  if (!classified.accepted) {
    return unresolvedStop(classified.reason || "unsupported_join_method");
  }
  const projectId = classified.evidence.project_id;
  const fromRef = classified.evidence.from;
  const noticeId = noticeIdFromRef(fromRef) || clean(input.request_id || extras.request_id, 40);
  const sourceSystem = clean(
    input.source_system
      || extras.source_system
      || input.provenance?.source_system,
    80,
  ) || "city_record";
  const sourceUrl = clean(
    input.source_url
      || extras.source_url
      || input.provenance?.source_url
      || cityRecordNoticeUrl(noticeId),
    500,
  );
  const retained = clean(
    input.retained_identifier
      || extras.retained_identifier
      || classified.evidence.join_value,
    80,
  );
  const confidence = publicConfidence(input.confidence || extras.confidence) || "strong";
  const evidence = Object.freeze({
    source_system: sourceSystem,
    source_record_id: classified.evidence.source_record,
    source_fields: classified.evidence.source_fields,
    retained_identifier: retained,
    join_key: classified.evidence.join_key,
    join_value: classified.evidence.join_value,
    method: classified.evidence.method,
    method_version: classified.evidence.method_version,
    observed_time: classified.evidence.observed_time,
    source_url: sourceUrl || null,
    confidence,
    tier: classified.evidence.tier || EXACT_KEY_EDGE_TIER,
    project_id: projectId,
  });
  const missingField = ABOUT_PROJECT_EVIDENCE.find((field) => {
    if (field === "exact_join_key") return !evidence.join_key;
    if (field === "exact_join_value") return !evidence.join_value;
    if (field === "source_fields") return !evidence.source_fields?.length;
    if (field === "source_url") return !evidence.source_url;
    return evidence[field] == null || evidence[field] === "";
  });
  if (missingField) return unresolvedStop(`missing_${missingField}`);

  const toRef = `project:${projectId}`;
  const vocab = LAND_PROJECT_RELATION_VOCABULARY.about_project;
  const provenance = Object.freeze({
    source_system: evidence.source_system,
    source_record_id: evidence.source_record_id,
    source_fields: evidence.source_fields,
    join_key: evidence.join_key,
    join_value: evidence.join_value,
    retained_identifier: evidence.retained_identifier,
    observed_at: evidence.observed_time,
    source_url: evidence.source_url,
    match: "exact",
    tier: evidence.tier,
    basis: evidence.method,
  });
  const edgeBase = {
    from: fromRef,
    to: toRef,
    domain: "meetings",
    confidence,
    method: evidence.method,
    method_version: evidence.method_version,
    tier: evidence.tier,
    is_decision: false,
    project_id: projectId,
    inverse: ABOUT_PROJECT_INVERSE,
    reader_label: ABOUT_PROJECT_READER_LABEL,
    provenance,
  };
  return Object.freeze({
    schema: LAND_PROJECT_DECISION_RELATION_SCHEMA,
    version: LAND_PROJECT_DECISION_RELATION_VERSION,
    accepted: true,
    canonical_relation: ABOUT_PROJECT_RELATION,
    proceeding_relation: classified.canonical_relation,
    compatibility_relation: DECIDES_LAND_PROJECT_COMPATIBILITY,
    family: vocab.family,
    is_decision: false,
    reader_label: ABOUT_PROJECT_READER_LABEL,
    inverse: ABOUT_PROJECT_INVERSE,
    semantic_threshold: vocab.semantic_threshold,
    reason: null,
    evidence,
    project_href: `#land/${projectId}`,
    notice_href: noticeId ? `/notices/${encodeURIComponent(noticeId)}` : null,
    canonical_edge: Object.freeze({
      ...edgeBase,
      type: ABOUT_PROJECT_RELATION,
      canonical_relation: ABOUT_PROJECT_RELATION,
      compatibility_relation: DECIDES_LAND_PROJECT_COMPATIBILITY,
    }),
    compatibility_edge: Object.freeze({
      ...edgeBase,
      type: DECIDES_LAND_PROJECT_COMPATIBILITY,
      canonical_relation: ABOUT_PROJECT_RELATION,
      compatibility_relation: DECIDES_LAND_PROJECT_COMPATIBILITY,
    }),
    unresolved: null,
  });
}

function publicConfidence(value) {
  const confidence = clean(value, 24).toLowerCase();
  return confidence === "strong" || confidence === "tentative" ? confidence : "";
}

export function aboutProjectReaderProjection(materialization) {
  if (!materialization?.accepted) {
    return Object.freeze({
      visible: false,
      label: null,
      href: null,
      project_id: null,
      relation: null,
      is_decision: false,
      proof: null,
      unresolved: materialization?.unresolved || Object.freeze({
        status: "unresolved",
        reason: materialization?.reason || "missing",
        inspectable: true,
      }),
    });
  }
  return Object.freeze({
    visible: true,
    label: materialization.reader_label,
    href: materialization.project_href,
    project_id: materialization.evidence.project_id,
    relation: ABOUT_PROJECT_RELATION,
    is_decision: false,
    proof: Object.freeze({
      identifier: materialization.evidence.retained_identifier,
      join_key: materialization.evidence.join_key,
      join_value: materialization.evidence.join_value,
      method: materialization.evidence.method,
      method_version: materialization.evidence.method_version,
      source_fields: materialization.evidence.source_fields,
      source_system: materialization.evidence.source_system,
      source_record_id: materialization.evidence.source_record_id,
      source_url: materialization.evidence.source_url,
      observed_time: materialization.evidence.observed_time,
      tier: materialization.evidence.tier,
      confidence: materialization.evidence.confidence,
    }),
    unresolved: null,
  });
}

/**
 * Stamp canonical semantics onto a compatibility meeting-land edge without
 * changing its public `type`. Stored graph rows stay `decides_land_project`.
 */
function compatibilityMeetingDefaults(edge = {}, extras = {}) {
  const method = extras.method || edge.method || edge.provenance?.basis || edge.join?.method;
  const zap = /zap_project|exact_project_id/i.test(clean(method, 80));
  const from = extras.from || edge.from || (edge.request_id ? `notice:${edge.request_id}` : "");
  const to = extras.to || edge.to || (edge.project_id ? `project:${edge.project_id}` : "");
  const projectId = clean(extras.project_id || String(to).replace(/^project:/, ""), 40);
  return {
    method,
    method_version: extras.method_version || edge.method_version || "1",
    source_record: extras.source_record
      || edge.provenance?.source_record_id
      || edge.source_record_id
      || from,
    source_fields: extras.source_fields
      || edge.provenance?.source_fields
      || (zap ? ["body", "zap_project_url"] : ["body", "ulurp_numbers"]),
    join_key: extras.join_key || edge.join_key || edge.provenance?.join_key || (zap ? "project_id" : "ulurp_number"),
    join_value: extras.join_value
      || edge.join_value
      || edge.provenance?.join_value
      || edge.provenance?.input_value
      || projectId,
    observed_time: extras.observed_time
      || edge.observed_time
      || edge.when
      || edge.event_date
      || edge.provenance?.observed_at,
    from,
    to,
    project_id: projectId,
    agency_name: extras.agency_name || edge.agency_name,
    label: extras.label || edge.label || edge.short_title,
    type_of_notice_description: extras.type_of_notice_description
      || edge.type_of_notice_description,
  };
}

export function adaptDecidesLandProjectEdge(edge = {}, extras = {}) {
  if (!edge || typeof edge !== "object") return null;
  const type = clean(edge.type || extras.type, 80) || DECIDES_LAND_PROJECT_COMPATIBILITY;
  if (type && !isMeetingLandGraphType(type) && type !== "references_project") {
    return { ...edge, classification: reject("unsupported_join_method") };
  }
  const filled = compatibilityMeetingDefaults(edge, extras);
  const classification = classifyMeetingLandProjectRelation({
    ...edge,
    ...extras,
    ...filled,
  });
  const vocab = LAND_PROJECT_RELATION_VOCABULARY[classification.canonical_relation]
    || LAND_PROJECT_RELATION_VOCABULARY.decides_land_project;
  return {
    ...edge,
    type: isMeetingLandGraphType(type) ? type : DECIDES_LAND_PROJECT_COMPATIBILITY,
    canonical_relation: classification.canonical_relation || vocab.id,
    compatibility_relation: DECIDES_LAND_PROJECT_COMPATIBILITY,
    semantic_threshold: classification.semantic_threshold || vocab.semantic_threshold,
    reader_label: classification.reader_label || vocab.reader_label,
    is_decision: false,
    classification,
  };
}

export function documentedDecisionFromDisposition(disposition, extras = {}) {
  const classified = classifyLandDispositionRelation({ disposition, ...extras });
  return classified.accepted && classified.is_decision ? classified : null;
}

export function landProjectRelationVocabulary() {
  return LAND_PROJECT_RELATION_VOCABULARY;
}
