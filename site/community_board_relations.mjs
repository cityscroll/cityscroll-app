/**
 * Earned community-board governance relations.
 *
 * A board source document can support more than one civic fact, but membership
 * and recommendation edges have different targets and meanings. Keep their
 * contracts separate and require the same minimum evidence for publication:
 * exact publisher identities, a relation date, and a retained source document
 * with an observation receipt.
 */

export const COMMUNITY_BOARD_MEMBER_EDGE_SCHEMA = "cityscroll.community_board_member_edge.v1";
export const COMMUNITY_BOARD_RECOMMENDATION_EDGE_SCHEMA = "cityscroll.community_board_recommendation_edge.v1";
export const COMMUNITY_BOARD_RELATION_PROMOTION_METHOD = "exact_publisher_identity_date_document";

const clean = (value, max = 500) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

function date(value) {
  const match = clean(value, 80).match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] || null;
}

function httpsUrl(value) {
  const text = clean(value, 2_000);
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function first(value, aliases) {
  for (const alias of aliases) {
    const candidate = value?.[alias];
    if (candidate != null && clean(candidate, 500)) return candidate;
  }
  return null;
}

function boardId(observation) {
  const value = clean(first(observation, ["publisher_board_id", "board_id", "body_id"]), 100).toLowerCase();
  return /^[a-z]+(?:-[a-z]+)*-cb-\d{2}$/.test(value) ? value : null;
}

function sourceDocument(observation, relationDate) {
  const nested = observation?.source_document && typeof observation.source_document === "object"
    ? observation.source_document
    : observation?.document && typeof observation.document === "object"
      ? observation.document
      : {};
  const id = clean(first(nested, ["publisher_document_id", "document_id", "source_document_id", "source_record_id"])
    || first(observation, ["publisher_document_id", "document_id", "source_document_id", "source_record_id"]), 240) || null;
  const url = httpsUrl(first(nested, ["document_url", "source_url", "url"])
    || first(observation, ["document_url", "source_url"]));
  const publishedDate = date(first(nested, ["date", "document_date", "published_date", "meeting_date"])
    || first(observation, ["document_date", "published_date", "meeting_date", "date"]));
  const receipt = nested.observed_receipt || observation.observed_receipt || observation.receipt || null;
  const receiptStatus = clean(receipt?.status, 40).toLowerCase();
  const observedAt = clean(receipt?.observed_at || receipt?.observedOn, 80) || null;
  return {
    id,
    url,
    date: publishedDate,
    observed_receipt: receipt && typeof receipt === "object" ? { ...receipt } : null,
    receipt_ok: receiptStatus === "ok" && Boolean(observedAt),
    date_matches_relation: Boolean(publishedDate && relationDate && publishedDate === relationDate),
  };
}

function looksLikePublisherIdentity(value, displayName = null) {
  const identity = clean(value, 240);
  const name = clean(displayName, 500);
  return Boolean(identity)
    && !/\s/.test(identity)
    && identity.toLowerCase() !== name.toLowerCase();
}

function contractFor(kind) {
  return kind === "member" ? COMMUNITY_BOARD_MEMBER_SOURCE_CONTRACT : COMMUNITY_BOARD_RECOMMENDATION_SOURCE_CONTRACT;
}

function unknownResult(kind, reason, observation = {}, document = null) {
  const contract = contractFor(kind);
  return {
    schema: contract.edge_schema,
    contract: contract.schema,
    relation: contract.relation,
    status: "unknown",
    promoted: false,
    reason,
    from: boardId(observation) ? `community-board:${boardId(observation)}` : null,
    source_document: document,
    provenance: document?.observed_receipt ? { observed_receipt: document.observed_receipt } : null,
  };
}

function promote(kind, observation = {}) {
  const contract = contractFor(kind);
  const relationDate = date(first(observation, kind === "member"
    ? ["membership_date", "effective_date", "observed_date", "date"]
    : ["recommendation_date", "decision_date", "observed_date", "date"]));
  const document = sourceDocument(observation, relationDate);
  const board = boardId(observation);
  const target = clean(first(observation, kind === "member"
    ? ["publisher_member_id", "member_id", "person_id", "official_id"]
    : ["publisher_recommendation_id", "recommendation_id", "matter_id"]), 240) || null;
  const targetPublisherId = clean(first(observation, kind === "member"
    ? ["member_publisher_identifier", "person_publisher_identifier", "publisher_member_id", "member_id", "person_id"]
    : ["recommendation_publisher_identifier", "publisher_recommendation_id", "recommendation_id", "matter_id"]), 240) || null;
  const displayName = clean(first(observation, kind === "member"
    ? ["member_name", "person_name", "name"]
    : ["recommendation_title", "matter_title", "title", "name"]), 500) || null;
  if (!board) return unknownResult(kind, "board_identity_missing", observation, document);
  if (!target) return unknownResult(kind, kind === "member" ? "member_identity_missing" : "recommendation_identity_missing", observation, document);
  if (observation.inferred === true || observation.inferred_edge === true || observation.inference_basis) {
    return unknownResult(kind, "inferred_edge_forbidden", observation, document);
  }
  if (!targetPublisherId || targetPublisherId !== target || !looksLikePublisherIdentity(targetPublisherId, displayName)) {
    return unknownResult(kind, "publisher_identity_missing_or_mismatched", observation, document);
  }
  if (!relationDate) return unknownResult(kind, "relation_date_missing", observation, document);
  if (!document.id || !document.url) return unknownResult(kind, "source_document_identity_missing", observation, document);
  if (!document.date || !document.date_matches_relation) return unknownResult(kind, "source_document_date_missing_or_mismatched", observation, document);
  if (!document.receipt_ok) return unknownResult(kind, "source_document_receipt_missing", observation, document);

  const targetName = displayName;
  const sourceFields = Object.keys(observation).filter((field) => !["source_document", "document", "receipt"].includes(field));
  const targetKind = kind === "member" ? "official" : "recommendation";
  const targetRef = `${targetKind}:${target}`;
  return {
    schema: contract.edge_schema,
    contract: contract.schema,
    relation: contract.relation,
    edge_type: contract.relation,
    status: "promoted",
    promoted: true,
    from: `community-board:${board}`,
    to: targetRef,
    target_kind: targetKind,
    target_id: target,
    target_name: targetName,
    relation_date: relationDate,
    source_document: {
      id: document.id,
      url: document.url,
      date: document.date,
      observed_receipt: document.observed_receipt,
    },
    provenance: {
      source_system: "community_board_publisher",
      source_record_id: document.id,
      source_url: document.url,
      source_fields: [...new Set([...sourceFields, "source_document_id", "source_document_url", "source_document_date"])].sort(),
      observed_at: document.observed_receipt.observed_at,
      join_method: COMMUNITY_BOARD_RELATION_PROMOTION_METHOD,
      basis: contract.semantics,
    },
    promotion: {
      method: COMMUNITY_BOARD_RELATION_PROMOTION_METHOD,
      evidence: ["exact_board_publisher_identity", "exact_target_publisher_identity", "exact_relation_date", "retained_source_document"],
    },
  };
}

export const COMMUNITY_BOARD_MEMBER_SOURCE_CONTRACT = Object.freeze({
  schema: "cityscroll.community_board_member_source_contract.v1",
  edge_schema: COMMUNITY_BOARD_MEMBER_EDGE_SCHEMA,
  relation: "has_member",
  inverse_relation: "member_of",
  target_kind: "official",
  semantics: "descriptive temporal service on a community board; it does not imply influence, support, control, or a vote",
  required_evidence: Object.freeze(["exact_board_publisher_identity", "exact_member_publisher_identity", "exact_relation_date", "retained_source_document"]),
});

export const COMMUNITY_BOARD_RECOMMENDATION_SOURCE_CONTRACT = Object.freeze({
  schema: "cityscroll.community_board_recommendation_source_contract.v1",
  edge_schema: COMMUNITY_BOARD_RECOMMENDATION_EDGE_SCHEMA,
  relation: "issues_recommendation",
  target_kind: "recommendation",
  semantics: "a recommendation explicitly issued by the board in a dated publisher document; it does not imply adoption or implementation",
  required_evidence: Object.freeze(["exact_board_publisher_identity", "exact_recommendation_publisher_identity", "exact_relation_date", "retained_source_document"]),
});

export const COMMUNITY_BOARD_RELATION_CONTRACTS = Object.freeze({
  member: COMMUNITY_BOARD_MEMBER_SOURCE_CONTRACT,
  recommendation: COMMUNITY_BOARD_RECOMMENDATION_SOURCE_CONTRACT,
});

export function promoteCommunityBoardMemberEdge(observation = {}) {
  return promote("member", observation);
}

export function promoteCommunityBoardRecommendationEdge(observation = {}) {
  return promote("recommendation", observation);
}

export function buildCommunityBoardRelationEdges({ members = [], recommendations = [] } = {}) {
  return {
    members: (Array.isArray(members) ? members : []).map(promoteCommunityBoardMemberEdge),
    recommendations: (Array.isArray(recommendations) ? recommendations : []).map(promoteCommunityBoardRecommendationEdge),
  };
}

export function promotedCommunityBoardRelationEdges(input = {}) {
  const built = buildCommunityBoardRelationEdges(input);
  return {
    members: built.members.filter((edge) => edge.promoted),
    recommendations: built.recommendations.filter((edge) => edge.promoted),
  };
}

export function communityBoardRelationAvailability(sourceRows = [], relation = "member") {
  const minutes = (Array.isArray(sourceRows) ? sourceRows : []).find((row) => row.role === "minutes");
  if (minutes?.state === "not_yet_ingested") {
    return { state: "not_yet_ingested", reason: "The official board records have not been collected yet." };
  }
  if (minutes?.state === "observed") {
    return { state: "unknown", reason: `The official records do not yet identify ${relation === "member" ? "board members" : "board recommendations"} with exact publisher keys.` };
  }
  return { state: "unknown", reason: "The official board source is not indexed for this relation." };
}
