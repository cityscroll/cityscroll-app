/**
 * Time-scoped participant role observations for connected civic histories.
 *
 * Reuses the civic-institution role-edge envelope (role, endpoints, inverse,
 * source evidence, confidence, as-of, negative rule) for history-family
 * observations only. Does not invent a second role model, merge company
 * identity from shared spelling, or promote chair quotes / presentations /
 * testimony flags into formal board action.
 */

export const CONNECTED_HISTORY_ROLE_SCHEMA =
  "cityscroll.connected_history_role_observation.v1";
export const CONNECTED_HISTORY_ROLE_METHOD =
  "connected_history_role_observation_v1";
export const CONNECTED_HISTORY_ROLES_ARTIFACT_SCHEMA =
  "cityscroll.connected_history_roles.v1";
export const CONNECTED_HISTORY_ROLES_VERSION = 1;

/**
 * Formal-stance evidence roles owned by the board-document topic-slice gate
 * (site/community_board_document_topic_slices.mjs). Mirrored here so history
 * observations consume the same boundary without re-exporting that module.
 */
const BOARD_FORMAL_EVIDENCE_ROLES = Object.freeze([
  "committee_recommendation",
  "formal_vote",
  "resolution",
  "official_board_statement",
]);

/** Roles this module may represent when source evidence supports them. */
export const CONNECTED_HISTORY_ROLE_IDS = Object.freeze([
  "sponsor",
  "applicant",
  "recorded_owner",
  "operator",
  "speaker",
  "formal_board_action",
]);

const REQUIRED_EVIDENCE = Object.freeze([
  "source_system",
  "source_record_id",
  "source_span",
  "entity_qualifier",
  "role_date",
  "scope",
  "method_version",
  "observed_time",
]);

/**
 * Canonical history-family role vocabulary.
 * Envelope fields mirror civic-institution role edges without replacing them.
 */
export const CONNECTED_HISTORY_ROLE_VOCABULARY = Object.freeze({
  sponsor: Object.freeze({
    id: "sponsor",
    relation: "sponsor_of",
    inverse: "sponsored_by",
    role: "sponsor",
    from_kind: "actor",
    to_kind: "subject",
    required_evidence: REQUIRED_EVIDENCE,
    semantic_threshold: "exact_source_sponsor_field_with_quoted_span",
    reader_label: "Sponsor",
    negative_rule:
      "A publisher label, coappearance, or repeated company spelling never mints a sponsor role.",
  }),
  applicant: Object.freeze({
    id: "applicant",
    relation: "applicant_of",
    inverse: "has_applicant",
    role: "applicant",
    from_kind: "actor",
    to_kind: "subject",
    required_evidence: REQUIRED_EVIDENCE,
    semantic_threshold: "exact_source_applicant_field_with_quoted_span",
    reader_label: "Applicant",
    negative_rule:
      "Shared applicant spelling never proves beneficial ownership or merges company identity.",
  }),
  recorded_owner: Object.freeze({
    id: "recorded_owner",
    relation: "recorded_owner_of",
    inverse: "has_recorded_owner",
    role: "recorded_owner",
    from_kind: "actor",
    to_kind: "subject",
    required_evidence: REQUIRED_EVIDENCE,
    semantic_threshold: "exact_source_recorded_owner_field_with_quoted_span",
    reader_label: "Recorded owner",
    negative_rule:
      "An applicant label, lease mention, or coappearance never becomes recorded ownership.",
  }),
  operator: Object.freeze({
    id: "operator",
    relation: "operator_of",
    inverse: "has_operator",
    role: "operator",
    from_kind: "actor",
    to_kind: "subject",
    required_evidence: REQUIRED_EVIDENCE,
    semantic_threshold: "exact_source_operator_or_lease_field_with_quoted_span",
    reader_label: "Operator",
    negative_rule:
      "A related-news listing or publisher notice never mints an operator role.",
  }),
  speaker: Object.freeze({
    id: "speaker",
    relation: "speaker_at",
    inverse: "has_speaker",
    role: "speaker",
    from_kind: "actor",
    to_kind: "subject",
    required_evidence: REQUIRED_EVIDENCE,
    semantic_threshold: "exact_quoted_speaker_or_chair_statement",
    reader_label: "Speaker",
    negative_rule:
      "A chair quotation or individual statement remains a speaker observation and never becomes formal board action.",
  }),
  formal_board_action: Object.freeze({
    id: "formal_board_action",
    relation: "formal_board_action_on",
    inverse: "subject_of_formal_board_action",
    role: "formal_board_action",
    from_kind: "actor",
    to_kind: "subject",
    required_evidence: Object.freeze([
      ...REQUIRED_EVIDENCE,
      "formal_stance_evidence_role",
    ]),
    semantic_threshold: "board_document_formal_stance_evidence_gate",
    reader_label: "Formal board action",
    negative_rule:
      "Chair quotations, DOT presentations, public testimony, and board-action flags alone never mint formal board action. Formal stance remains governed by the board-document evidence gate.",
  }),
});

/** Bases that never establish a history-family participant role. */
export const CONNECTED_HISTORY_ROLE_REJECTED_BASES = Object.freeze([
  "same_applicant_spelling",
  "applicant_label_as_ownership",
  "beneficial_ownership_inference",
  "chair_quote_as_formal_board_action",
  "presentation_as_formal_board_action",
  "testimony_flags_as_resolution",
  "coappearance",
  "publisher_label",
  "related_news",
]);

/**
 * True when ownership evidence is only an applicant label / locator.
 * Structural: does not trust a self-declared basis field.
 */
function isApplicantLabelOwnershipEvidence(candidate = {}) {
  const system = clean(candidate.source_system, 100).toLowerCase();
  const locator = clean(candidate?.source_span?.locator, 240).toLowerCase();
  if (system.includes("applicant-label") || system.includes("applicant_label")) {
    return true;
  }
  if (!locator) return false;
  if (
    locator === "primary_applicant"
    || locator.includes("applicant_label")
    || locator.includes("applicant-label")
    || locator.endsWith("_applicant")
    || locator.startsWith("applicant_")
  ) {
    return true;
  }
  return false;
}

/** Source roles that may support formal_board_action (lcd-11 evidence gate). */
export const CONNECTED_HISTORY_FORMAL_EVIDENCE_ROLES = Object.freeze([
  ...BOARD_FORMAL_EVIDENCE_ROLES,
]);

const clean = (value, max = 500) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

const DATE_PRECISIONS = new Set(["day", "month", "year", "unknown"]);

function hasQuotedSpan(span) {
  if (!span || typeof span !== "object") return false;
  const locator = clean(span.locator, 240);
  const quote = clean(span.quote, 500);
  return Boolean(locator && quote);
}

function normalizeRoleDate(input) {
  if (!input || typeof input !== "object") return null;
  const value = clean(input.value || input.date || input.as_of, 40);
  const precision = clean(input.precision || "unknown", 20).toLowerCase();
  if (!value) return null;
  if (!DATE_PRECISIONS.has(precision)) return null;
  return { value, precision };
}

function normalizeEntity(candidate) {
  const qualifier = clean(
    candidate.entity_qualifier
      || candidate.actor?.entity_qualifier
      || candidate.actor_qualifier,
    240,
  );
  const entityId = clean(
    candidate.entity_id
      || candidate.actor?.entity_id
      || candidate.from
      || candidate.actor_id,
    240,
  );
  const spelling = clean(
    candidate.entity_spelling
      || candidate.actor?.spelling
      || candidate.spelling,
    240,
  ) || null;
  const displayName = clean(
    candidate.entity_display_name
      || candidate.actor?.display_name
      || candidate.display_name,
    240,
  ) || null;
  const identityStatus = clean(
    candidate.identity_status
      || candidate.actor?.identity_status
      || "source_qualified",
    40,
  ).toLowerCase() || "source_qualified";
  if (!qualifier || !entityId) return null;
  return {
    entity_id: entityId,
    entity_qualifier: qualifier,
    spelling,
    display_name: displayName,
    identity_status: ["resolved", "source_qualified", "unresolved"].includes(identityStatus)
      ? identityStatus
      : "source_qualified",
  };
}

function scopeValue(candidate) {
  const direct = candidate?.scope;
  if (direct == null) return null;
  if (Array.isArray(direct)) {
    const values = [...new Set(direct.map((item) => clean(item, 160)).filter(Boolean))];
    return values.length ? values : null;
  }
  const text = clean(direct, 240);
  return text ? [text] : null;
}

export function connectedHistoryRoleVocab(roleId) {
  return CONNECTED_HISTORY_ROLE_VOCABULARY[clean(roleId, 80)] || null;
}

export function isRejectedConnectedHistoryRoleBasis(basis) {
  const value = clean(basis, 80).toLowerCase();
  return CONNECTED_HISTORY_ROLE_REJECTED_BASES.includes(value);
}

/**
 * Admit one history-family role observation under the shared evidence policy.
 * Returns an admitted observation or a structured rejection.
 */
export function admitConnectedHistoryRole(candidate = {}) {
  const roleId = clean(candidate.role || candidate.role_id || candidate.relation, 80);
  const vocab = connectedHistoryRoleVocab(roleId);
  if (!vocab) {
    return {
      admitted: false,
      reason: "unknown_role",
      rejection_class: "vocabulary",
      candidate,
    };
  }

  const basis = clean(candidate.basis || candidate.admission_basis, 80).toLowerCase();
  if (basis && isRejectedConnectedHistoryRoleBasis(basis)) {
    return {
      admitted: false,
      reason: `rejected_basis:${basis}`,
      rejection_class: "insufficient_role_basis",
      candidate,
      vocab_id: vocab.id,
    };
  }

  // Ownership never admits from applicant-label evidence alone, even when the
  // candidate omits a self-declared rejected basis.
  if (vocab.id === "recorded_owner" && isApplicantLabelOwnershipEvidence(candidate)) {
    return {
      admitted: false,
      reason: "rejected_basis:applicant_label_as_ownership",
      rejection_class: "insufficient_role_basis",
      candidate,
      vocab_id: vocab.id,
    };
  }

  // Boundary upgrades: chair quotes / presentations / testimony flags cannot
  // enter as formal_board_action even when the claimed role string matches.
  const claimedAs = clean(candidate.claimed_as || candidate.source_kind || "", 80).toLowerCase();
  if (vocab.id === "formal_board_action") {
    if (
      claimedAs === "chair_statement"
      || claimedAs === "chair_quote"
      || claimedAs === "presentation"
      || claimedAs === "dot_presentation"
      || claimedAs === "testimony"
      || claimedAs === "public_testimony"
    ) {
      return {
        admitted: false,
        reason: `forbidden_formal_upgrade:${claimedAs || "unqualified"}`,
        rejection_class: "formal_stance_gate",
        candidate,
        vocab_id: vocab.id,
      };
    }
    const sourceRole = clean(
      candidate.formal_evidence_role || candidate.source_role || candidate.document_role,
      80,
    ).toLowerCase();
    if (!CONNECTED_HISTORY_FORMAL_EVIDENCE_ROLES.includes(sourceRole)) {
      return {
        admitted: false,
        reason: sourceRole
          ? `formal_evidence_role_rejected:${sourceRole}`
          : "missing_formal_stance_evidence_role",
        rejection_class: "formal_stance_gate",
        candidate,
        vocab_id: vocab.id,
      };
    }
  }

  const actor = normalizeEntity(candidate);
  if (!actor) {
    return {
      admitted: false,
      reason: "missing_entity_qualifier",
      rejection_class: "incomplete",
      candidate,
      vocab_id: vocab.id,
    };
  }

  const subjectId = clean(candidate.subject || candidate.to || candidate.subject_id, 160);
  if (!subjectId) {
    return {
      admitted: false,
      reason: "missing_subject",
      rejection_class: "incomplete",
      candidate,
      vocab_id: vocab.id,
    };
  }

  if (actor.entity_id === subjectId) {
    return {
      admitted: false,
      reason: "self_link",
      rejection_class: "identity_collapse",
      candidate,
      vocab_id: vocab.id,
    };
  }

  const sourceSystem = clean(candidate.source_system, 100);
  const sourceRecordId = clean(
    candidate.source_record_id || candidate.source_record,
    160,
  );
  const methodVersion = clean(
    candidate.method_version || CONNECTED_HISTORY_ROLE_METHOD,
    80,
  );
  const observedTime = clean(candidate.observed_time || candidate.observed_at, 40);
  if (!sourceSystem || !sourceRecordId || !methodVersion || !observedTime) {
    return {
      admitted: false,
      reason: "missing_required_evidence",
      rejection_class: "incomplete",
      candidate,
      vocab_id: vocab.id,
    };
  }

  if (!hasQuotedSpan(candidate.source_span)) {
    return {
      admitted: false,
      reason: "missing_quoted_source_span",
      rejection_class: "incomplete",
      candidate,
      vocab_id: vocab.id,
    };
  }

  const roleDate = normalizeRoleDate(candidate.role_date || candidate.as_of);
  if (!roleDate) {
    return {
      admitted: false,
      reason: "missing_role_date",
      rejection_class: "incomplete",
      candidate,
      vocab_id: vocab.id,
    };
  }

  const scope = scopeValue(candidate);
  if (!scope) {
    return {
      admitted: false,
      reason: "missing_scope",
      rejection_class: "incomplete",
      candidate,
      vocab_id: vocab.id,
    };
  }

  const observation = {
    schema: CONNECTED_HISTORY_ROLE_SCHEMA,
    role: vocab.role,
    relation: vocab.relation,
    inverse: vocab.inverse,
    from: actor.entity_id,
    to: subjectId,
    actor,
    subject: subjectId,
    method: CONNECTED_HISTORY_ROLE_METHOD,
    method_version: methodVersion,
    source_system: sourceSystem,
    source_record_id: sourceRecordId,
    source_locator: {
      source_system: sourceSystem,
      source_record_id: sourceRecordId,
      source_span: {
        locator: clean(candidate.source_span.locator, 240),
        quote: clean(candidate.source_span.quote, 500),
      },
    },
    role_date: roleDate,
    as_of: roleDate.value,
    scope,
    observed_time: observedTime,
    confidence: "strong",
    linking: actor.identity_status === "resolved",
    beneficial_ownership: false,
    formal_board_endorsement: vocab.id === "formal_board_action",
    reader_label: vocab.reader_label,
    semantic_threshold: vocab.semantic_threshold,
    negative_rule: vocab.negative_rule,
    envelope: "civic_institution_role_edge",
  };

  if (candidate.family_id) observation.family_id = clean(candidate.family_id, 80);
  if (candidate.candidate_id) observation.candidate_id = clean(candidate.candidate_id, 120);
  if (vocab.id === "formal_board_action") {
    observation.formal_evidence_role = clean(
      candidate.formal_evidence_role || candidate.source_role || candidate.document_role,
      80,
    ).toLowerCase();
  }
  if (candidate.board_presentation === true || claimedAs === "presentation") {
    observation.presentation = true;
    observation.formal_board_endorsement = false;
  }
  if (claimedAs === "chair_statement" || claimedAs === "chair_quote") {
    observation.chair_statement = true;
    observation.formal_board_endorsement = false;
  }

  return {
    admitted: true,
    reason: "role_evidence_satisfied",
    observation,
    vocab_id: vocab.id,
  };
}

/**
 * Project candidates into admitted observations plus structured rejections.
 * Ordering is deterministic by candidate_id then role/from/to.
 */
export function projectConnectedHistoryRoles(candidates = []) {
  const rows = Array.isArray(candidates) ? candidates : [];
  const admitted = [];
  const rejected = [];
  for (const candidate of rows) {
    const decision = admitConnectedHistoryRole(candidate);
    if (decision.admitted) admitted.push(decision.observation);
    else {
      rejected.push({
        candidate_id: clean(candidate?.candidate_id, 120) || null,
        role: clean(candidate?.role || candidate?.role_id, 80) || null,
        from: clean(candidate?.entity_id || candidate?.from || candidate?.actor?.entity_id, 240) || null,
        to: clean(candidate?.subject || candidate?.to, 160) || null,
        reason: decision.reason,
        rejection_class: decision.rejection_class,
        basis: clean(candidate?.basis || candidate?.admission_basis, 80) || null,
      });
    }
  }

  const sortKey = (row) => [
    row.candidate_id || "",
    row.role || "",
    row.from || "",
    row.to || row.subject || "",
  ].join("\0");
  admitted.sort((left, right) => sortKey(left).localeCompare(sortKey(right)));
  rejected.sort((left, right) => sortKey(left).localeCompare(sortKey(right)));

  const roleCoverage = {};
  for (const roleId of CONNECTED_HISTORY_ROLE_IDS) {
    roleCoverage[roleId] = {
      admitted: admitted.filter((row) => row.role === roleId).length,
      status: "absent",
    };
  }
  for (const row of admitted) {
    roleCoverage[row.role].status = "observed";
  }
  const missingStrata = CONNECTED_HISTORY_ROLE_IDS.filter(
    (roleId) => roleCoverage[roleId].status === "absent",
  );

  return {
    schema: CONNECTED_HISTORY_ROLES_ARTIFACT_SCHEMA,
    version: CONNECTED_HISTORY_ROLES_VERSION,
    method: CONNECTED_HISTORY_ROLE_METHOD,
    vocabulary: [...CONNECTED_HISTORY_ROLE_IDS],
    rejected_bases: [...CONNECTED_HISTORY_ROLE_REJECTED_BASES],
    counts: {
      candidates: rows.length,
      admitted: admitted.length,
      rejected: rejected.length,
    },
    role_coverage: roleCoverage,
    missing_strata: missingStrata,
    observations: admitted,
    rejections: rejected,
  };
}

/** Lookup helper for tests and consumers. */
export function rolesForSubject(artifact, subjectId) {
  const id = clean(subjectId, 160);
  if (!id || !artifact?.observations) return [];
  return artifact.observations.filter(
    (row) => row.subject === id || row.to === id || row.from === id,
  );
}

/**
 * Absence of a role is reportable non-observation. It never becomes an
 * adverse inference (no opposition, denial, or ownership claim).
 */
export function roleAbsenceInference(artifact, { subject, role } = {}) {
  const roleId = clean(role, 80);
  const subjectId = clean(subject, 160);
  if (!roleId || !connectedHistoryRoleVocab(roleId)) {
    return {
      role: roleId || null,
      subject: subjectId || null,
      status: "unknown_role",
      adverse_inference: false,
      observed: false,
    };
  }
  const matches = (artifact?.observations || []).filter((row) => {
    if (row.role !== roleId) return false;
    if (!subjectId) return true;
    return row.subject === subjectId || row.to === subjectId;
  });
  if (matches.length) {
    return {
      role: roleId,
      subject: subjectId || null,
      status: "observed",
      adverse_inference: false,
      observed: true,
      count: matches.length,
    };
  }
  return {
    role: roleId,
    subject: subjectId || null,
    status: "absent",
    adverse_inference: false,
    observed: false,
    count: 0,
    note: "Absence of a role observation is not evidence against the actor or subject.",
  };
}

/**
 * Source-qualified actors that share a spelling remain distinct identities.
 * Shared spelling never collapses company identity or proves ownership.
 *
 * Returns false on identity collapse:
 * 1. Partial: multiple source qualifiers under one spelling forced onto one
 *    entity_id.
 * 2. Total: distinct subjects under one spelling merged onto one entity_id
 *    (including when the entity_qualifier is also identical).
 * 3. beneficial_ownership, or a resolved identity claimed while that spelling
 *    still covers more than one subject or more than one entity_id.
 */
export function unresolvedCompanyIdentitiesRemainDistinct(observations = []) {
  const rows = Array.isArray(observations) ? observations : [];
  const bySpelling = new Map();
  for (const row of rows) {
    const spelling = clean(row?.actor?.spelling, 240).toLowerCase();
    if (!spelling) continue;
    const qualifier = clean(row?.actor?.entity_qualifier, 240);
    const entityId = clean(row?.actor?.entity_id, 240);
    if (!qualifier || !entityId) return false;
    const bucket = bySpelling.get(spelling) || [];
    bucket.push({
      entity_id: entityId,
      entity_qualifier: qualifier,
      identity_status: clean(row?.actor?.identity_status, 40).toLowerCase(),
      subject: clean(row?.subject, 240),
    });
    bySpelling.set(spelling, bucket);
  }

  // Check 1: shared spelling must not collapse distinct identities.
  for (const bucket of bySpelling.values()) {
    const qualifiers = new Set(bucket.map((item) => item.entity_qualifier));
    const entityIds = new Set(bucket.map((item) => item.entity_id));
    const subjects = new Set(
      bucket.map((item) => item.subject).filter((subject) => subject.length > 0),
    );
    // Partial collapse: distinct source qualifiers forced onto one entity_id.
    if (qualifiers.size >= 2 && entityIds.size === 1) {
      return false;
    }
    // Total collapse: distinct subjects merged onto one entity_id. Plurality
    // of qualifiers is erased by a thorough merge, so subjects are the signal.
    if (subjects.size >= 2 && entityIds.size === 1) {
      return false;
    }
  }

  // Check 2: ownership inference and spelling-based resolution are collapses.
  for (const row of rows) {
    if (row?.beneficial_ownership) return false;
  }
  for (const bucket of bySpelling.values()) {
    const entityIds = new Set(bucket.map((item) => item.entity_id));
    const subjects = new Set(
      bucket.map((item) => item.subject).filter((subject) => subject.length > 0),
    );
    const hasResolved = bucket.some((item) => item.identity_status === "resolved");
    // A resolved company identity cannot stand while distinct entity ids or
    // distinct subjects remain under the same spelling — that is spelling
    // used as a merge key, including after a total id merge.
    if (hasResolved && (entityIds.size >= 2 || subjects.size >= 2)) {
      return false;
    }
  }
  return true;
}

export function connectedHistoryRoleVocabulary() {
  return CONNECTED_HISTORY_ROLE_VOCABULARY;
}
