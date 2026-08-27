import { communityBoardCommitteeId } from "./community_board_committees.mjs";

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
export const COMMUNITY_BOARD_PERSON_EDGE_SCHEMA = "cityscroll.community_board_person_role_edge.v1";
export const COMMUNITY_BOARD_RELATION_PROMOTION_METHOD = "exact_publisher_identity_date_document";
export const COMMUNITY_BOARD_PERSON_OBJECT_TYPE = "community-board-person";
export const COMMUNITY_BOARD_PERSON_ROLES = Object.freeze([
  "appointed_member",
  "board_chair",
  "board_officer",
  "committee_chair",
  "committee_member",
  "public_committee_member",
  "district_manager",
  "staff",
]);

const PERSON_RELATIONS = Object.freeze(["member_of", "chairs", "staffed_by", "works_for"]);

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

function personId(observation) {
  return clean(first(observation, [
    "publisher_person_id",
    "person_publisher_identifier",
    "member_publisher_identifier",
    "publisher_member_id",
    "reviewed_local_id",
    "local_person_id",
    "member_id",
    "person_id",
    "official_id",
  ]), 240) || null;
}

/**
 * A board-local person identity is deliberately not a Council official id.
 * The opaque publisher/local key is retained so a future generic person layer
 * can attach by explicit evidence without changing this source identity.
 */
export function communityBoardPersonId(board, publisherPersonId) {
  const normalizedBoard = boardId({ board_id: board });
  const identity = clean(publisherPersonId, 240);
  if (!normalizedBoard || !identity || /\s/.test(identity) || identity.toLowerCase() === normalizedBoard) return null;
  return `${COMMUNITY_BOARD_PERSON_OBJECT_TYPE}:${normalizedBoard}:${identity}`;
}

function personIdentity(observation, board) {
  const id = personId(observation);
  const ref = communityBoardPersonId(board, id);
  if (!ref) return null;
  return {
    id: ref,
    publisher_person_id: id,
    identity_basis: observation.publisher_person_id || observation.person_publisher_identifier
      ? "exact_publisher_person_identifier"
      : "reviewed_board_local_identity",
    canonical_person_ref: null,
  };
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
    ? ["publisher_person_id", "person_publisher_identifier", "member_publisher_identifier", "publisher_member_id", "reviewed_local_id", "member_id", "person_id", "official_id"]
    : ["publisher_recommendation_id", "recommendation_id", "matter_id"]), 240) || null;
  const targetPublisherId = clean(first(observation, kind === "member"
    ? ["publisher_person_id", "person_publisher_identifier", "member_publisher_identifier", "publisher_member_id", "reviewed_local_id", "member_id", "person_id", "official_id"]
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
  const memberRole = clean(observation.role, 80).toLowerCase() || "appointed_member";
  if (kind === "member" && !["appointed_member", "board_chair", "board_officer"].includes(memberRole)) {
    return unknownResult(kind, "member_role_mismatch", observation, document);
  }

  const targetName = displayName;
  const sourceFields = Object.keys(observation).filter((field) => !["source_document", "document", "receipt"].includes(field));
  const targetKind = kind === "member" ? COMMUNITY_BOARD_PERSON_OBJECT_TYPE : "recommendation";
  const targetRef = kind === "member" ? communityBoardPersonId(board, target) : `${targetKind}:${target}`;
  if (!targetRef) return unknownResult(kind, "person_identity_invalid", observation, document);
  const identity = kind === "member" ? personIdentity({ ...observation, member_id: target }, board) : null;
  const validFrom = date(first(observation, ["valid_from", "membership_start", "service_start"])) || relationDate;
  const validTo = date(first(observation, ["valid_to", "membership_end", "service_end"]));
  const observedOn = date(first(observation, ["observed_on", "observed_date"]))
    || date(document.observed_receipt?.observed_at);
  return {
    schema: contract.edge_schema,
    contract: contract.schema,
    relation: contract.relation,
    inverse_relation: contract.inverse_relation,
    edge_type: contract.relation,
    status: "promoted",
    promoted: true,
    from: `community-board:${board}`,
    to: targetRef,
    target_kind: targetKind,
    target_id: target,
    target_name: targetName,
    relation_date: relationDate,
    ...(kind === "member" ? {
      person_ref: targetRef,
      person_identity: identity,
      role: clean(observation.role || observation.role_semantics, 80) || "appointed_member",
      role_semantics: "descriptive service relationship; membership does not establish voting power",
      valid_from: validFrom,
      valid_to: validTo,
      observed_on: observedOn,
    } : {}),
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
  target_kind: COMMUNITY_BOARD_PERSON_OBJECT_TYPE,
  semantics: "descriptive temporal service on a community board; it does not imply influence, support, control, or a vote",
  required_evidence: Object.freeze(["exact_board_publisher_identity", "exact_member_publisher_identity", "exact_relation_date", "retained_source_document", "observed_receipt"]),
});

export const COMMUNITY_BOARD_PERSON_ROLE_CONTRACT = Object.freeze({
  schema: "cityscroll.community_board_person_role_source_contract.v1",
  edge_schema: COMMUNITY_BOARD_PERSON_EDGE_SCHEMA,
  relations: PERSON_RELATIONS,
  roles: COMMUNITY_BOARD_PERSON_ROLES,
  semantics: "source-qualified, temporal board-local person relationship; it does not imply a Council official identity or voting power",
  required_evidence: Object.freeze([
    "exact_board_publisher_identity",
    "exact_person_publisher_or_reviewed_local_identity",
    "exact_relation_date",
    "retained_source_document",
    "observed_receipt",
  ]),
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
  person_role: COMMUNITY_BOARD_PERSON_ROLE_CONTRACT,
  recommendation: COMMUNITY_BOARD_RECOMMENDATION_SOURCE_CONTRACT,
});

function normalizedRole(observation = {}, relation, targetKind) {
  const supplied = clean(observation.role || observation.role_semantics || observation.title, 100).toLowerCase();
  if (/district[\s_]+manager/.test(supplied)) return "district_manager";
  if (/\bstaff\b|assistant district manager|community coordinator/.test(supplied)) return "staff";
  if (/public/.test(supplied) && targetKind === "community-board-committee") return "public_committee_member";
  if (/chair/.test(supplied)) return targetKind === "community-board-committee" ? "committee_chair" : "board_chair";
  if (/officer/.test(supplied) || /vice chair|treasurer|secretary/.test(supplied)) return "board_officer";
  if (relation === "staffed_by" || relation === "works_for") return "staff";
  return targetKind === "community-board-committee" ? "committee_member" : "appointed_member";
}

function roleTarget(observation, board, relation) {
  if (relation === "staffed_by" || relation === "works_for") {
    return { ref: `community-board:${board}`, kind: "community-board", id: board };
  }
  const explicit = clean(first(observation, ["committee_ref", "committee_id", "target_id", "target_ref"]), 300);
  if (explicit.startsWith("community-board-committee:")) {
    const expectedBoard = `community-board-committee:${board}:`;
    return explicit.startsWith(expectedBoard)
      ? { ref: explicit, kind: "community-board-committee", id: explicit.slice(expectedBoard.length) }
      : null;
  }
  if (explicit && observation.committee_id && communityBoardCommitteeId(board, observation.committee_id)) {
    return { ref: communityBoardCommitteeId(board, observation.committee_id), kind: "community-board-committee", id: clean(observation.committee_id, 120).toLowerCase() };
  }
  if (observation.committee_id && communityBoardCommitteeId(board, observation.committee_id)) {
    return { ref: communityBoardCommitteeId(board, observation.committee_id), kind: "community-board-committee", id: clean(observation.committee_id, 120).toLowerCase() };
  }
  return { ref: `community-board:${board}`, kind: "community-board", id: board };
}

/** Promote one typed, temporal person relationship without creating a Council official. */
export function promoteCommunityBoardPersonRoleEdge(observation = {}) {
  const relation = clean(observation.relation || observation.relation_type || observation.edge_type, 60).toLowerCase() || "member_of";
  if (!PERSON_RELATIONS.includes(relation)) {
    return { schema: COMMUNITY_BOARD_PERSON_EDGE_SCHEMA, status: "unknown", promoted: false, relation, reason: "unsupported_person_relation" };
  }
  const board = boardId(observation);
  const identity = personIdentity(observation, board);
  const target = roleTarget(observation, board, relation);
  const relationDate = date(first(observation, ["relation_date", "membership_date", "effective_date", "observed_date", "date"]));
  const document = sourceDocument(observation, relationDate);
  const role = normalizedRole(observation, relation, target?.kind);
  if (!board) return { schema: COMMUNITY_BOARD_PERSON_EDGE_SCHEMA, status: "unknown", promoted: false, relation, reason: "board_identity_missing", source_document: document };
  if (!identity) return { schema: COMMUNITY_BOARD_PERSON_EDGE_SCHEMA, status: "unknown", promoted: false, relation, reason: "person_identity_missing_or_invalid", from: null, source_document: document };
  if (!target) return { schema: COMMUNITY_BOARD_PERSON_EDGE_SCHEMA, status: "unknown", promoted: false, relation, reason: "committee_scope_mismatch", from: identity.id, source_document: document };
  if (!relationDate) return { schema: COMMUNITY_BOARD_PERSON_EDGE_SCHEMA, status: "unknown", promoted: false, relation, reason: "relation_date_missing", from: identity.id, source_document: document };
  if (!document.id || !document.url || !document.date || !document.date_matches_relation || !document.receipt_ok) {
    return { schema: COMMUNITY_BOARD_PERSON_EDGE_SCHEMA, status: "unknown", promoted: false, relation, reason: "source_document_evidence_incomplete", from: identity.id, to: target.ref, source_document: document };
  }
  if (!COMMUNITY_BOARD_PERSON_ROLES.includes(role)) {
    return { schema: COMMUNITY_BOARD_PERSON_EDGE_SCHEMA, status: "unknown", promoted: false, relation, reason: "role_not_in_vocabulary", from: identity.id, to: target.ref, source_document: document };
  }
  const roleFitsTarget = target.kind === "community-board"
    ? relation === "member_of"
      ? ["appointed_member", "board_chair", "board_officer"].includes(role)
      : relation === "chairs"
        ? ["board_chair", "board_officer"].includes(role)
        : ["district_manager", "staff"].includes(role)
    : relation === "member_of"
      ? ["committee_member", "public_committee_member"].includes(role)
      : relation === "chairs" && role === "committee_chair";
  if (!roleFitsTarget) {
    return { schema: COMMUNITY_BOARD_PERSON_EDGE_SCHEMA, status: "unknown", promoted: false, relation, reason: "role_target_mismatch", from: identity.id, to: target.ref, source_document: document };
  }
  const boardStaffingEdge = relation === "staffed_by";
  const from = boardStaffingEdge ? target.ref : identity.id;
  const to = boardStaffingEdge ? identity.id : target.ref;
  const targetKind = boardStaffingEdge ? COMMUNITY_BOARD_PERSON_OBJECT_TYPE : target.kind;
  const targetId = boardStaffingEdge ? identity.id : target.id;
  const subjectKind = boardStaffingEdge ? target.kind : COMMUNITY_BOARD_PERSON_OBJECT_TYPE;
  const subjectId = boardStaffingEdge ? target.id : identity.publisher_person_id;
  const validFrom = date(first(observation, ["valid_from", "membership_start", "service_start"])) || relationDate;
  const validTo = date(first(observation, ["valid_to", "membership_end", "service_end"]));
  const observedOn = date(first(observation, ["observed_on", "observed_date"])) || date(document.observed_receipt?.observed_at);
  return {
    schema: COMMUNITY_BOARD_PERSON_EDGE_SCHEMA,
    contract: COMMUNITY_BOARD_PERSON_ROLE_CONTRACT.schema,
    edge_type: relation,
    relation,
    inverse_relation: relation === "member_of" ? "has_member" : relation === "chairs" ? "chaired_by" : relation === "staffed_by" ? "works_for" : "staffed_by",
    status: "promoted",
    promoted: true,
    from,
    to,
    subject_kind: subjectKind,
    subject_id: subjectId,
    person_name: clean(first(observation, ["person_name", "member_name", "name"]), 500) || null,
    person_ref: identity.id,
    organization_ref: target.ref,
    target_kind: targetKind,
    target_id: targetId,
    role,
    role_semantics: role === "public_committee_member"
      ? "public participation in a committee; this edge does not establish board membership or voting power"
      : role === "district_manager" || role === "staff"
        ? "employment or staff service for the board; this edge does not establish board membership"
        : "descriptive temporal service relationship; this edge does not establish voting power",
    relation_date: relationDate,
    valid_from: validFrom,
    valid_to: validTo,
    observed_on: observedOn,
    source_document: { id: document.id, url: document.url, date: document.date, observed_receipt: document.observed_receipt },
    provenance: {
      source_system: "community_board_publisher",
      source_record_id: document.id,
      source_url: document.url,
      observed_at: document.observed_receipt.observed_at,
      join_method: COMMUNITY_BOARD_RELATION_PROMOTION_METHOD,
      basis: COMMUNITY_BOARD_PERSON_ROLE_CONTRACT.semantics,
      source_fields: Object.keys(observation).filter((field) => !["source_document", "document", "receipt"].includes(field)).sort(),
    },
    promotion: {
      method: COMMUNITY_BOARD_RELATION_PROMOTION_METHOD,
      evidence: [...COMMUNITY_BOARD_PERSON_ROLE_CONTRACT.required_evidence],
    },
  };
}

export const promoteCommunityBoardPersonEdge = promoteCommunityBoardPersonRoleEdge;

export function communityBoardPersonObject(observation = {}) {
  const board = boardId(observation);
  const identity = personIdentity(observation, board);
  if (!identity) return null;
  return {
    id: identity.id,
    type: COMMUNITY_BOARD_PERSON_OBJECT_TYPE,
    board_id: board,
    publisher_person_id: identity.publisher_person_id,
    person_name: clean(first(observation, ["person_name", "member_name", "name"]), 500) || null,
    canonical_person_ref: null,
    identity_basis: identity.identity_basis,
  };
}

export function buildCommunityBoardPersonEdges({ relationships = [], personRoles = [], members = [], committeeMembers = [], chairs = [], staff = [], employment = [] } = {}) {
  const rows = [
    ...relationships,
    ...personRoles,
    ...members.map((row) => ({ ...row, relation: row.relation || "member_of" })),
    ...committeeMembers.map((row) => ({ ...row, relation: row.relation || "member_of" })),
    ...chairs.map((row) => ({ ...row, relation: row.relation || "chairs" })),
    ...staff.map((row) => ({ ...row, relation: row.relation || "staffed_by" })),
    ...employment.map((row) => ({ ...row, relation: row.relation || "works_for" })),
  ];
  return rows.map(promoteCommunityBoardPersonRoleEdge);
}

export function promoteCommunityBoardMemberEdge(observation = {}) {
  return promote("member", observation);
}

export function promoteCommunityBoardRecommendationEdge(observation = {}) {
  return promote("recommendation", observation);
}

export function buildCommunityBoardRelationEdges({ members = [], recommendations = [], relationships = [], personRoles = [], committeeMembers = [], chairs = [], staff = [], employment = [] } = {}) {
  return {
    members: (Array.isArray(members) ? members : []).map(promoteCommunityBoardMemberEdge),
    recommendations: (Array.isArray(recommendations) ? recommendations : []).map(promoteCommunityBoardRecommendationEdge),
    person_roles: buildCommunityBoardPersonEdges({ relationships, personRoles, committeeMembers, chairs, staff, employment }),
  };
}

export function promotedCommunityBoardRelationEdges(input = {}) {
  const built = buildCommunityBoardRelationEdges(input);
  return {
    members: built.members.filter((edge) => edge.promoted),
    recommendations: built.recommendations.filter((edge) => edge.promoted),
    person_roles: built.person_roles.filter((edge) => edge.promoted),
  };
}

export function communityBoardRelationAvailability(sourceRows = [], relation = "member") {
  const rows = Array.isArray(sourceRows) ? sourceRows : [];
  const role = relation === "member" || relation === "person" ? "roster" : relation;
  const source = rows.find((row) => row.role === role || row.source_type === role);
  if (source?.state === "not_yet_ingested" || source?.governance_state === "not_yet_ingested") {
    return { state: "not_yet_ingested", reason: "The official board source for this relationship has not been collected yet." };
  }
  if (source?.state === "observed" || source?.governance_state === "observed") {
    return { state: "unknown", reason: `The official records do not yet identify ${relation === "member" ? "board members" : "board relationships"} with exact publisher keys.` };
  }
  return { state: "unknown", reason: "" };
}
