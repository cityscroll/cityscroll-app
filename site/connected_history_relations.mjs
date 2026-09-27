/**
 * Typed, source-backed history relations for proposals, proceedings,
 * corridors, and components.
 *
 * Extends the shared admission contract so explicit document references and
 * scoped history links can connect retained subjects without merging legally
 * distinct applications or inventing ownership from proximity, coappearance,
 * the same published applicant label, or a shared board calendar.
 */

export const CONNECTED_HISTORY_RELATION_SCHEMA =
  "cityscroll.connected_history_relation.v1";
export const CONNECTED_HISTORY_RELATION_METHOD =
  "connected_history_relation_v1";
export const CONNECTED_HISTORY_RELATIONS_ARTIFACT_SCHEMA =
  "cityscroll.connected_history_relations.v1";
export const CONNECTED_HISTORY_RELATIONS_VERSION = 1;

/** Families admitted by this module. */
export const CONNECTED_HISTORY_RELATION_FAMILIES = Object.freeze([
  "explicit_reference",
  "scoped_history",
]);

const REQUIRED_EVIDENCE = Object.freeze([
  "source_system",
  "source_record_id",
  "source_span",
  "method_version",
  "observed_time",
]);

/**
 * Canonical relation vocabulary. Each entry keeps applications and components
 * distinct: a link never collapses two subjects into one identity.
 */
export const CONNECTED_HISTORY_RELATION_VOCABULARY = Object.freeze({
  explicitly_references: Object.freeze({
    id: "explicitly_references",
    family: "explicit_reference",
    from: "land_application|project|document|proceeding",
    to: "land_application|project|document|proceeding",
    inverse: "referenced_by",
    required_evidence: REQUIRED_EVIDENCE,
    semantic_threshold: "stable_source_identifier_with_quoted_span",
    reader_label: "Explicitly references",
    negative_rule:
      "Proximity, coappearance, the same applicant label, or a shared board never mint this link. Distinct applications keep separate identities.",
  }),
  discussed_in_document: Object.freeze({
    id: "discussed_in_document",
    family: "explicit_reference",
    from: "bsa_case|proceeding",
    to: "board_document|official_document",
    inverse: "discusses_case",
    required_evidence: REQUIRED_EVIDENCE,
    semantic_threshold: "stable_case_identifier_with_quoted_span",
    reader_label: "Discussed in document",
    negative_rule:
      "A case-to-document link does not resolve parcel identity, ownership, or project equivalence. Conflicting parcel claims stay unresolved.",
  }),
  successive_proposal: Object.freeze({
    id: "successive_proposal",
    family: "scoped_history",
    from: "ceqr|project|proposal",
    to: "ceqr|project|proposal",
    inverse: "preceded_by_proposal",
    required_evidence: Object.freeze([
      ...REQUIRED_EVIDENCE,
      "scope",
    ]),
    semantic_threshold: "source_backed_successive_proposal_with_scope",
    reader_label: "Successive proposal",
    negative_rule:
      "Successive proposals remain separate civic identities. A later proposal never absorbs an earlier one.",
  }),
  shares_documented_footprint: Object.freeze({
    id: "shares_documented_footprint",
    family: "scoped_history",
    from: "parcel|project|proposal",
    to: "parcel|project|proposal",
    inverse: "shares_documented_footprint",
    required_evidence: Object.freeze([
      ...REQUIRED_EVIDENCE,
      "geographic_scope",
    ]),
    semantic_threshold: "source_backed_multi_parcel_footprint",
    reader_label: "Shares documented footprint",
    negative_rule:
      "Footprint scope is evidence of co-inclusion in a published plan, not ownership or a merged project.",
  }),
  corridor_segment: Object.freeze({
    id: "corridor_segment",
    family: "scoped_history",
    from: "corridor_segment|corridor",
    to: "corridor|corridor_segment",
    inverse: "has_corridor_segment",
    required_evidence: Object.freeze([
      ...REQUIRED_EVIDENCE,
      "geographic_scope",
    ]),
    semantic_threshold: "source_backed_segment_scope",
    reader_label: "Corridor segment",
    negative_rule:
      "Repeated board presentations of one segment never create multiple projects or any board endorsement.",
  }),
  phase_component: Object.freeze({
    id: "phase_component",
    family: "scoped_history",
    from: "phase|component|opening",
    to: "project|phase",
    inverse: "has_phase_component",
    required_evidence: Object.freeze([
      ...REQUIRED_EVIDENCE,
      "component_scope",
    ]),
    semantic_threshold: "source_backed_component_or_phase_scope",
    reader_label: "Phase or component",
    negative_rule:
      "A completed component does not close the parent project. Related-news listings are not identity links.",
  }),
});

/** Bases that never establish continuity under this admission policy. */
export const CONNECTED_HISTORY_REJECTED_BASES = Object.freeze([
  "proximity",
  "coappearance",
  "same_applicant",
  "same_board",
  "related_news",
  "street_name_similarity",
  "parcel_assumption",
  "inferred_ownership",
  "project_equivalence_shortcut",
]);

const clean = (value, max = 500) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

function hasQuotedSpan(span) {
  if (!span || typeof span !== "object") return false;
  const locator = clean(span.locator, 240);
  const quote = clean(span.quote, 500);
  return Boolean(locator && quote);
}

function scopeValue(candidate, key) {
  const direct = candidate?.[key];
  if (direct == null) return null;
  if (Array.isArray(direct)) {
    const values = [...new Set(direct.map((item) => clean(item, 160)).filter(Boolean))];
    return values.length ? values : null;
  }
  if (typeof direct === "object") {
    const values = Object.values(direct)
      .map((item) => clean(item, 160))
      .filter(Boolean);
    return values.length ? values : null;
  }
  const text = clean(direct, 240);
  return text ? [text] : null;
}

export function connectedHistoryRelationVocab(relationId) {
  return CONNECTED_HISTORY_RELATION_VOCABULARY[clean(relationId, 80)] || null;
}

export function isRejectedConnectedHistoryBasis(basis) {
  const value = clean(basis, 80).toLowerCase();
  return CONNECTED_HISTORY_REJECTED_BASES.includes(value);
}

/**
 * Admit one candidate relation under the shared provenance policy.
 * Returns an admitted edge or a structured rejection. Never merges identities.
 */
export function admitConnectedHistoryRelation(candidate = {}) {
  const relationId = clean(candidate.relation || candidate.relation_id, 80);
  const vocab = connectedHistoryRelationVocab(relationId);
  if (!vocab) {
    return {
      admitted: false,
      reason: "unknown_relation",
      rejection_class: "vocabulary",
      candidate,
    };
  }

  const basis = clean(candidate.basis || candidate.admission_basis, 80).toLowerCase();
  if (basis && isRejectedConnectedHistoryBasis(basis)) {
    return {
      admitted: false,
      reason: `rejected_basis:${basis}`,
      rejection_class: "insufficient_continuity_basis",
      candidate,
      vocab_id: vocab.id,
    };
  }

  const fromId = clean(candidate.from || candidate.from_id, 160);
  const toId = clean(candidate.to || candidate.to_id, 160);
  if (!fromId || !toId) {
    return {
      admitted: false,
      reason: "missing_endpoint",
      rejection_class: "incomplete",
      candidate,
      vocab_id: vocab.id,
    };
  }
  if (fromId === toId) {
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
    candidate.method_version || CONNECTED_HISTORY_RELATION_METHOD,
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

  // Scoped-history relations require an explicit geographic or component scope.
  let geographicScope = null;
  let componentScope = null;
  let scope = null;
  if (vocab.family === "scoped_history") {
    geographicScope = scopeValue(candidate, "geographic_scope");
    componentScope = scopeValue(candidate, "component_scope");
    scope = scopeValue(candidate, "scope") || geographicScope || componentScope;
    const needsGeographic = vocab.required_evidence.includes("geographic_scope");
    const needsComponent = vocab.required_evidence.includes("component_scope");
    const needsScope = vocab.required_evidence.includes("scope");
    if (needsGeographic && !geographicScope) {
      return {
        admitted: false,
        reason: "missing_geographic_scope",
        rejection_class: "incomplete",
        candidate,
        vocab_id: vocab.id,
      };
    }
    if (needsComponent && !componentScope) {
      return {
        admitted: false,
        reason: "missing_component_scope",
        rejection_class: "incomplete",
        candidate,
        vocab_id: vocab.id,
      };
    }
    if (needsScope && !scope) {
      return {
        admitted: false,
        reason: "missing_scope",
        rejection_class: "incomplete",
        candidate,
        vocab_id: vocab.id,
      };
    }
  }

  // Parcel conflicts may accompany a case/document link; they never resolve here.
  const parcelConflict = candidate.parcel_conflict && typeof candidate.parcel_conflict === "object"
    ? {
      status: clean(candidate.parcel_conflict.status || "unresolved", 40),
      notes: clean(candidate.parcel_conflict.notes, 400) || null,
      claims: Array.isArray(candidate.parcel_conflict.claims)
        ? candidate.parcel_conflict.claims.map((claim) => ({
          address: clean(claim?.address, 160) || null,
          block: clean(claim?.block, 40) || null,
          lot: clean(claim?.lot, 40) || null,
          source_record_id: clean(claim?.source_record_id, 160) || null,
        }))
        : [],
    }
    : null;
  if (parcelConflict && parcelConflict.status === "resolved") {
    return {
      admitted: false,
      reason: "silent_parcel_resolution_forbidden",
      rejection_class: "identity_collapse",
      candidate,
      vocab_id: vocab.id,
    };
  }

  const edge = {
    schema: CONNECTED_HISTORY_RELATION_SCHEMA,
    relation: vocab.id,
    family: vocab.family,
    from: fromId,
    to: toId,
    inverse: vocab.inverse,
    method: CONNECTED_HISTORY_RELATION_METHOD,
    method_version: methodVersion,
    source_system: sourceSystem,
    source_record_id: sourceRecordId,
    source_span: {
      locator: clean(candidate.source_span.locator, 240),
      quote: clean(candidate.source_span.quote, 500),
    },
    observed_time: observedTime,
    confidence: "strong",
    tier: "deterministic_exact_key",
    warrant_method: "exact_quoted_source_span",
    identities_merged: false,
    reader_label: vocab.reader_label,
    semantic_threshold: vocab.semantic_threshold,
    negative_rule: vocab.negative_rule,
  };

  if (candidate.family_id) edge.family_id = clean(candidate.family_id, 80);
  if (candidate.candidate_id) edge.candidate_id = clean(candidate.candidate_id, 120);
  if (geographicScope) edge.geographic_scope = geographicScope;
  if (componentScope) edge.component_scope = componentScope;
  if (scope && !geographicScope && !componentScope) edge.scope = scope;
  if (parcelConflict) {
    edge.parcel_conflict = parcelConflict;
    edge.parcel_identity = "unresolved";
  }
  if (candidate.board_presentations != null) {
    const count = Number(candidate.board_presentations);
    if (Number.isFinite(count) && count >= 0) {
      edge.board_presentations = count;
      edge.board_endorsement = false;
    }
  }
  if (Array.isArray(candidate.preserves_ids)) {
    edge.preserves_ids = [...new Set(
      candidate.preserves_ids.map((id) => clean(id, 160)).filter(Boolean),
    )].sort();
  }

  return {
    admitted: true,
    reason: "relation_evidence_satisfied",
    edge,
    vocab_id: vocab.id,
  };
}

/**
 * Project a candidate list into admitted edges plus structured rejections.
 * Ordering is deterministic by candidate_id then from/to/relation.
 */
export function projectConnectedHistoryRelations(candidates = []) {
  const rows = Array.isArray(candidates) ? candidates : [];
  const admitted = [];
  const rejected = [];
  for (const candidate of rows) {
    const decision = admitConnectedHistoryRelation(candidate);
    if (decision.admitted) admitted.push(decision.edge);
    else {
      rejected.push({
        candidate_id: clean(candidate?.candidate_id, 120) || null,
        relation: clean(candidate?.relation, 80) || null,
        from: clean(candidate?.from || candidate?.from_id, 160) || null,
        to: clean(candidate?.to || candidate?.to_id, 160) || null,
        reason: decision.reason,
        rejection_class: decision.rejection_class,
        basis: clean(candidate?.basis || candidate?.admission_basis, 80) || null,
      });
    }
  }

  const sortKey = (edge) => [
    edge.candidate_id || "",
    edge.from,
    edge.to,
    edge.relation,
  ].join("\0");
  admitted.sort((left, right) => sortKey(left).localeCompare(sortKey(right)));
  rejected.sort((left, right) => {
    const key = (row) => [
      row.candidate_id || "",
      row.from || "",
      row.to || "",
      row.relation || "",
    ].join("\0");
    return key(left).localeCompare(key(right));
  });

  return {
    schema: CONNECTED_HISTORY_RELATIONS_ARTIFACT_SCHEMA,
    version: CONNECTED_HISTORY_RELATIONS_VERSION,
    method: CONNECTED_HISTORY_RELATION_METHOD,
    vocabulary: Object.keys(CONNECTED_HISTORY_RELATION_VOCABULARY).sort(),
    families: [...CONNECTED_HISTORY_RELATION_FAMILIES],
    rejected_bases: [...CONNECTED_HISTORY_REJECTED_BASES],
    counts: {
      candidates: rows.length,
      admitted: admitted.length,
      rejected: rejected.length,
    },
    relations: admitted,
    rejections: rejected,
  };
}

/** True when every listed application id remains a separate subject. */
export function applicationsRemainDistinct(subjectIds = [], relations = []) {
  const ids = [...new Set((subjectIds || []).map((id) => clean(id, 160)).filter(Boolean))];
  if (ids.length < 2) return true;
  const idSet = new Set(ids);
  for (const edge of relations || []) {
    if (edge?.identities_merged) return false;
    // An edge may connect two applications, but both endpoints must survive.
    if (idSet.has(edge?.from) && idSet.has(edge?.to) && edge.from === edge.to) {
      return false;
    }
  }
  // Distinctness means the id set was not collapsed to a single survivor.
  return ids.length === idSet.size;
}

/** Lookup helper for tests and consumers. */
export function relationsForSubject(artifact, subjectId) {
  const id = clean(subjectId, 160);
  if (!id || !artifact?.relations) return [];
  return artifact.relations.filter((edge) => edge.from === id || edge.to === id);
}

export function connectedHistoryRelationVocabulary() {
  return CONNECTED_HISTORY_RELATION_VOCABULARY;
}
