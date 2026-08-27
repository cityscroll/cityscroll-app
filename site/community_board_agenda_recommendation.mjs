/**
 * Declaration-only bridge for Community Board agenda items and recommendations.
 *
 * This module is deliberately a pure, in-memory contract. It can demonstrate
 * an evidence-complete graph in tests without adding agenda or recommendation
 * rows to a production artifact.
 */

export const COMMUNITY_BOARD_AGENDA_ITEM_EDGE_SCHEMA = "cityscroll.community_board_has_agenda_item_edge.v1";
export const COMMUNITY_BOARD_CONCERNS_EDGE_SCHEMA = "cityscroll.community_board_concerns_edge.v1";
export const COMMUNITY_BOARD_CONSIDERS_EDGE_SCHEMA = "cityscroll.community_board_considers_matter_edge.v1";
export const COMMUNITY_BOARD_RECOMMENDS_EDGE_SCHEMA = "cityscroll.community_board_committee_recommends_edge.v1";
export const COMMUNITY_BOARD_FULL_BOARD_ACTION_EDGE_SCHEMA = "cityscroll.community_board_full_board_action_edge.v1";
export const COMMUNITY_BOARD_RECOMMENDATION_DESTINATION_EDGE_SCHEMA = "cityscroll.community_board_recommendation_destination_edge.v1";

export const COMMUNITY_BOARD_AGENDA_ITEM_SOURCE_CONTRACT = Object.freeze({
  schema: "cityscroll.community_board_agenda_item_source_contract.v1",
  edge_schema: COMMUNITY_BOARD_AGENDA_ITEM_EDGE_SCHEMA,
  object_type: "agenda_item",
  relation: "has_agenda_item",
  semantics: "source-qualified agenda content; raw text survives an unresolved matter join",
  required_evidence: Object.freeze([
    "exact_meeting_source_identity",
    "exact_agenda_item_source_identity",
    "retained_source_document",
    "observed_receipt",
  ]),
  canonical_matter_join: "exact_publisher_identifier_only",
  similar_text_never_identity: true,
});

export const COMMUNITY_BOARD_MATTER_JOIN_CONTRACT = Object.freeze({
  schema: "cityscroll.community_board_matter_join_contract.v1",
  edge_schema: COMMUNITY_BOARD_CONCERNS_EDGE_SCHEMA,
  allowed_target_kinds: Object.freeze(["matter", "project", "application", "place"]),
  required_evidence: Object.freeze([
    "exact_source_object_identity",
    "exact_target_publisher_identifier",
    "retained_source_document",
    "observed_receipt",
  ]),
  method: "exact_publisher_identifier",
  similar_text_never_identity: true,
  raw_text_preserved_when_unknown: true,
});

export const COMMUNITY_BOARD_RECOMMENDATION_BRIDGE_SOURCE_CONTRACT = Object.freeze({
  schema: "cityscroll.community_board_recommendation_bridge_source_contract.v1",
  edge_schema: COMMUNITY_BOARD_RECOMMENDS_EDGE_SCHEMA,
  object_type: "recommendation",
  explicit_statement_required: true,
  discussion_is_not_recommendation: true,
  canonical_matter_join: "exact_publisher_identifier_only",
  required_evidence: Object.freeze([
    "exact_issuer_source_identity",
    "explicit_recommendation_statement",
    "exact_recommendation_source_identity",
    "retained_source_document",
    "observed_receipt",
  ]),
});

export const COMMUNITY_BOARD_AGENDA_RECOMMENDATION_CONTRACT = Object.freeze({
  schema: "cityscroll.community_board_agenda_recommendation_contract.v1",
  materialization: "declaration_only",
  object_types: Object.freeze(["agenda_item", "recommendation"]),
  invariants: Object.freeze({
    similar_agenda_text_does_not_mint_matter: true,
    discussion_does_not_infer_recommendation: true,
    raw_agenda_text_preserved_when_matter_unknown: true,
  }),
});

const clean = (value, max = 2_000) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

const date = (value) => clean(value, 80).match(/^(\d{4}-\d{2}-\d{2})/)?.[1] || null;

function sourceIdentity(row = {}) {
  const sourceSystem = clean(row.source_system || row.publisher_system, 120);
  const sourceId = clean(row.source_id || row.publisher_source_id, 300);
  return sourceSystem && sourceId ? { source_system: sourceSystem, source_id: sourceId } : null;
}
function sourceRef(kind, row) {
  const identity = sourceIdentity(row);
  return identity ? `${kind}:${identity.source_system}:${identity.source_id}` : null;
}

function documentEvidence(row = {}) {
  const document = row.source_document && typeof row.source_document === "object"
    ? row.source_document
    : {};
  const receipt = document.observed_receipt || row.observed_receipt || null;
  const id = clean(document.id || document.source_document_id || document.publisher_document_id, 300) || null;
  const url = clean(document.url || document.source_document_url || document.document_url, 2_000) || null;
  const observedAt = clean(receipt?.observed_at || receipt?.observedOn, 100) || null;
  const receiptOk = receipt?.status === "ok" && Boolean(observedAt);
  return {
    id,
    url,
    published_date: date(document.published_date || document.date || row.published_date),
    observed_receipt: receipt,
    observed_at: observedAt,
    complete: Boolean(id && url && receiptOk),
  };
}

function provenance(document, joinMethod) {
  return {
    source_document_id: document.id,
    source_url: document.url,
    observed_at: document.observed_at,
    join_method: joinMethod,
  };
}

function unknown(reason, extra = {}) {
  return { status: "unknown", promoted: false, reason, ...extra };
}

/**
 * Only an explicit exact-key join may create a canonical target reference.
 * Similarity, title, address, or topic signals are intentionally ignored.
 */
export function exactMatterJoin(row = {}) {
  const join = row.matter_join;
  if (!join || typeof join !== "object") return { status: "unknown", reason: "matter_join_missing" };
  if (join.similar_text === true || join.similarity === true || join.inferred === true) {
    return { status: "unknown", reason: "similar_text_cannot_mint_matter" };
  }
  if (join.method !== COMMUNITY_BOARD_MATTER_JOIN_CONTRACT.method) {
    return { status: "unknown", reason: "exact_publisher_matter_join_required" };
  }
  const targetKind = clean(join.target_kind, 40).toLowerCase();
  const publisherIdentifier = clean(join.publisher_identifier, 300);
  const targetRef = clean(join.target_ref || join.canonical_ref, 400);
  if (!COMMUNITY_BOARD_MATTER_JOIN_CONTRACT.allowed_target_kinds.includes(targetKind)) {
    return { status: "unknown", reason: "matter_target_kind_not_allowed" };
  }
  if (!publisherIdentifier || !targetRef || !targetRef.startsWith(`${targetKind}:`)) {
    return { status: "unknown", reason: "exact_publisher_matter_identity_missing" };
  }
  return {
    status: "matched",
    method: join.method,
    target_kind: targetKind,
    publisher_identifier: publisherIdentifier,
    target_ref: targetRef,
  };
}

function sourceQualifiedNode(kind, row, document, matterJoin) {
  const identity = sourceIdentity(row);
  const id = sourceRef(kind, row);
  if (!identity || !id) return unknown(`${kind}_source_identity_missing`);
  if (!document.complete) return unknown("source_document_evidence_incomplete");
  return {
    status: "promoted",
    promoted: true,
    id,
    type: kind,
    source_qualified: true,
    source_system: identity.source_system,
    source_id: identity.source_id,
    source_document: document,
    matter_ref: matterJoin.status === "matched" ? matterJoin.target_ref : null,
    matter_join_status: matterJoin.status,
  };
}

export function projectCommunityBoardAgendaItem(row = {}) {
  const document = documentEvidence(row);
  const matterJoin = exactMatterJoin(row);
  const base = sourceQualifiedNode("agenda_item", row, document, matterJoin);
  const rawText = clean(row.raw_text || row.text || row.title, 4_000) || null;
  const item = {
    schema: "cityscroll.community_board_agenda_item.v1",
    ...(base.id ? base : { status: base.status, promoted: false, reason: base.reason }),
    title: clean(row.title, 500) || null,
    raw_text: rawText,
    agenda_number: clean(row.agenda_number, 100) || null,
    meeting_ref: clean(row.meeting_ref, 400) || null,
    committee_ref: clean(row.committee_ref, 400) || null,
    matter_ref: matterJoin.status === "matched" ? matterJoin.target_ref : null,
    matter_join_status: matterJoin.status,
  };
  if (base.status !== "promoted") return { item, edges: [] };
  if (!/^meeting:[^:]+:.+/.test(item.meeting_ref)) return { item: { ...item, status: "unknown", promoted: false, reason: "meeting_source_identity_missing" }, edges: [] };
  return {
    item,
    edges: [{
      schema: COMMUNITY_BOARD_AGENDA_ITEM_EDGE_SCHEMA,
      relation: "has_agenda_item",
      status: "promoted",
      promoted: true,
      from: item.meeting_ref,
      to: item.id,
      provenance: provenance(document, "exact_source_identity_with_retained_document"),
    }, ...(matterJoin.status === "matched" ? [{
      schema: COMMUNITY_BOARD_CONCERNS_EDGE_SCHEMA,
      relation: "concerns",
      status: "promoted",
      promoted: true,
      from: item.id,
      to: matterJoin.target_ref,
      target_kind: matterJoin.target_kind,
      target_publisher_identifier: matterJoin.publisher_identifier,
      provenance: provenance(document, COMMUNITY_BOARD_MATTER_JOIN_CONTRACT.method),
    }] : [])],
  };
}

export function projectCommunityBoardRecommendation(row = {}) {
  const document = documentEvidence(row);
  const matterJoin = exactMatterJoin(row);
  const base = sourceQualifiedNode("recommendation", row, document, matterJoin);
  const statement = clean(row.recommendation_text || row.explicit_statement, 4_000) || null;
  const explicit = row.explicit_recommendation === true || Boolean(statement);
  const discussionOnly = row.discussion_only === true || row.inferred === true || row.inferred_edge === true;
  const item = {
    schema: "cityscroll.community_board_recommendation.v1",
    ...(base.id ? base : { status: base.status, promoted: false, reason: base.reason }),
    title: clean(row.title, 500) || null,
    recommendation_text: statement,
    decision: clean(row.decision, 100) || null,
    issuer_ref: clean(row.issuer_ref, 400) || null,
    matter_ref: matterJoin.status === "matched" ? matterJoin.target_ref : null,
    matter_join_status: matterJoin.status,
  };
  if (discussionOnly) return { item: { ...item, status: "unknown", promoted: false, reason: "discussion_does_not_infer_recommendation" }, edges: [] };
  if (!explicit) return { item: { ...item, status: "unknown", promoted: false, reason: "explicit_recommendation_statement_missing" }, edges: [] };
  if (base.status !== "promoted") return { item, edges: [] };
  if (!/^community-board:[^:]+$/.test(item.issuer_ref)) {
    return { item: { ...item, status: "unknown", promoted: false, reason: "issuer_source_identity_missing" }, edges: [] };
  }
  const edges = [{
    schema: "cityscroll.community_board_recommendation_edge.v1",
    relation: "issues_recommendation",
    status: "promoted",
    promoted: true,
    from: item.issuer_ref,
    to: item.id,
    provenance: provenance(document, "explicit_recommendation_statement"),
  }];
  if (matterJoin.status === "matched") edges.push({
    schema: COMMUNITY_BOARD_CONCERNS_EDGE_SCHEMA,
    relation: "concerns",
    status: "promoted",
    promoted: true,
    from: item.id,
    to: matterJoin.target_ref,
    target_kind: matterJoin.target_kind,
    target_publisher_identifier: matterJoin.publisher_identifier,
    provenance: provenance(document, COMMUNITY_BOARD_MATTER_JOIN_CONTRACT.method),
  });
  return { item, edges };
}

function matterObject(row = {}) {
  const document = documentEvidence(row);
  const identity = sourceIdentity(row);
  const ref = clean(row.matter_ref, 400);
  if (!identity || !ref || !ref.startsWith("matter:") || !document.complete) return null;
  return {
    id: ref,
    type: "matter",
    source_qualified: true,
    publisher_identifier: clean(row.publisher_identifier || identity.source_id, 300),
    title: clean(row.title, 500) || null,
    source_document: document,
  };
}

/** Build an evidence-complete graph only for a caller-provided fixture. */
export function buildCommunityBoardAgendaRecommendationGraph(input = {}) {
  const agenda = projectCommunityBoardAgendaItem(input.agenda_item || {});
  const recommendation = projectCommunityBoardRecommendation(input.recommendation || {});
  const matter = matterObject(input.matter || {});
  const committee = input.committee || {};
  const meeting = input.meeting || {};
  const committeeDocument = documentEvidence(committee);
  const meetingRef = clean(meeting.id || meeting.meeting_ref, 400);
  const committeeRef = clean(committee.id, 400);
  const boardRef = clean(input.board_ref, 400);
  const matterRef = matter?.id || null;
  const hasRequiredEvidence = Boolean(
    matter
    && committeeRef.startsWith("community-board-committee:")
    && committeeDocument.complete
    && /^meeting:[^:]+:.+/.test(meetingRef)
    && /^community-board:[^:]+$/.test(boardRef)
    && agenda.item.matter_ref === matterRef
    && recommendation.item.matter_ref === matterRef
    && agenda.item.committee_ref === committeeRef,
  );
  if (!hasRequiredEvidence) {
    return { schema: COMMUNITY_BOARD_AGENDA_RECOMMENDATION_CONTRACT.schema, status: "unknown", materialized: false, reason: "workflow_evidence_incomplete", agenda_item: agenda.item, recommendation: recommendation.item, matter, edges: [] };
  }
  const provenanceDocument = documentEvidence(input.agenda_item);
  const edges = [
    ...agenda.edges,
    {
      schema: COMMUNITY_BOARD_CONSIDERS_EDGE_SCHEMA,
      relation: "considers",
      status: "promoted",
      promoted: true,
      from: committeeRef,
      to: matterRef,
      provenance: provenance(provenanceDocument, COMMUNITY_BOARD_MATTER_JOIN_CONTRACT.method),
    },
    ...recommendation.edges,
  ];
  return {
    schema: COMMUNITY_BOARD_AGENDA_RECOMMENDATION_CONTRACT.schema,
    status: "demonstrated",
    materialized: false,
    nodes: [
      { id: meetingRef, type: "meeting", source_qualified: true },
      { id: committeeRef, type: "community-board-committee", source_qualified: true },
      agenda.item,
      matter,
      recommendation.item,
    ],
    edges,
  };
}
