/**
 * Reviewed, board-local Community Board committee identity.
 *
 * A committee's topic is useful for discovery, but never supplies identity.
 * Identity comes from the board plus the reviewed local committee id and is
 * only resolved from an exact publisher identifier, official name, or alias.
 */

export const COMMUNITY_BOARD_COMMITTEE_REGISTRY_SCHEMA = "cityscroll.community_board_committee_registry.v1";
export const COMMUNITY_BOARD_COMMITTEE_OBJECT_TYPE = "community-board-committee";
export const COMMUNITY_BOARD_HAS_COMMITTEE_RELATION = "has_committee";

const clean = (value, max = 500) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

function registryRows(registry) {
  if (Array.isArray(registry)) return registry;
  if (Array.isArray(registry?.committees)) return registry.committees;
  if (Array.isArray(registry?.records)) return registry.records;
  return [];
}

function boardId(value) {
  const id = clean(value, 100).toLowerCase().replace(/^community-board:/, "");
  return /^[a-z]+(?:-[a-z]+)*-cb-\d{2}$/.test(id) ? id : null;
}

function localCommitteeId(value) {
  const id = clean(value, 120).toLowerCase();
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) ? id : null;
}

/** Comparison normalization is case/whitespace only; it is not fuzzy matching. */
export function normalizeCommunityBoardCommitteeLabel(value) {
  return clean(value, 300).normalize("NFKC").replace(/[\u2013\u2014]/g, "-").toLowerCase();
}

function publisherIdentifier(value) {
  return clean(value, 240) || null;
}

function sourceUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function normalizedRecord(row = {}) {
  const board = boardId(row.board_id);
  const id = localCommitteeId(row.committee_id || row.local_committee_id);
  const publisherName = clean(row.publisher_name || row.name, 300) || null;
  const officialSourceUrl = sourceUrl(row.source_url);
  const observedOn = clean(row.observed_on, 40) || null;
  if (!board || !id || !publisherName || !officialSourceUrl || !observedOn) return null;
  const aliases = [...new Set((Array.isArray(row.aliases) ? row.aliases : [])
    .map((alias) => clean(alias, 300)).filter(Boolean))];
  return {
    board_id: board,
    committee_id: id,
    publisher_name: publisherName,
    ...(publisherIdentifier(row.publisher_identifier) ? { publisher_identifier: publisherIdentifier(row.publisher_identifier) } : {}),
    aliases,
    source_url: officialSourceUrl,
    observed_on: observedOn,
    ...(clean(row.active_from, 40) ? { active_from: clean(row.active_from, 40) } : {}),
    ...(clean(row.active_to, 40) ? { active_to: clean(row.active_to, 40) } : {}),
    topic_facets: [...new Set((Array.isArray(row.topic_facets) ? row.topic_facets : [])
      .map((facet) => clean(facet, 100).toLowerCase()).filter(Boolean))],
  };
}

export function normalizeCommunityBoardCommitteeRegistry(registry = {}) {
  return registryRows(registry).map(normalizedRecord).filter(Boolean);
}

export function communityBoardCommitteeId(board, committee) {
  const normalizedBoard = boardId(board);
  const normalizedCommittee = localCommitteeId(committee);
  return normalizedBoard && normalizedCommittee
    ? `${COMMUNITY_BOARD_COMMITTEE_OBJECT_TYPE}:${normalizedBoard}:${normalizedCommittee}`
    : null;
}

function explicitCommitteeFields(input = {}) {
  const committee = input.committee && typeof input.committee === "object" && !Array.isArray(input.committee)
    ? input.committee
    : {};
  return {
    publisherIdentifier: publisherIdentifier(
      committee.publisher_identifier
      || committee.publisher_id
      || committee.committee_identifier
      || committee.committee_id
      || input.convening_body_publisher_identifier
      || input.publisher_committee_identifier
      || input.publisher_committee_id
      || input.committee_publisher_identifier
      || input.committee_publisher_id,
    ),
    label: clean(
      committee.name || committee.publisher_name || committee.label || committee.title
      || input.convening_body_label
      || input.convening_body_name
      || input.committee_name
      || input.publisher_committee_name,
      300,
    ) || null,
  };
}

/**
 * Resolve one supplied body against only the requested board's registry rows.
 * The optional title is accepted only for an exact reviewed alias, never as a
 * substring or citywide topic match.
 */
export function matchCommunityBoardCommittee(input = {}, registry = {}) {
  const board = boardId(input.board_id || input.body_id);
  const rows = normalizeCommunityBoardCommitteeRegistry(registry).filter((row) => row.board_id === board);
  const fields = explicitCommitteeFields(input);
  const title = clean(input.title, 300) || null;
  const candidates = fields.label ? [fields.label] : (title ? [title] : []);

  if (!board || !rows.length) {
    return { status: "unresolved", reason: !board ? "board_identity_missing" : "board_registry_missing", board_id: board, committee_id: null, id: null };
  }
  if (fields.publisherIdentifier) {
    const matches = rows.filter((row) => row.publisher_identifier === fields.publisherIdentifier);
    if (matches.length === 1) return resolvedMatch(matches[0], "exact_publisher_committee_identifier", fields);
    if (matches.length > 1) return unresolvedMatch(board, "ambiguous_publisher_committee_identifier", fields);
  }
  if (candidates.length) {
    const official = rows.filter((row) => candidates.some((candidate) => normalizeCommunityBoardCommitteeLabel(candidate) === normalizeCommunityBoardCommitteeLabel(row.publisher_name)));
    if (official.length === 1) return resolvedMatch(official[0], "exact_official_publisher_name", fields);
    if (official.length > 1) return unresolvedMatch(board, "ambiguous_official_publisher_name", fields);
    const aliases = rows.filter((row) => candidates.some((candidate) => row.aliases
      .some((alias) => normalizeCommunityBoardCommitteeLabel(candidate) === normalizeCommunityBoardCommitteeLabel(alias))));
    if (aliases.length === 1) return resolvedMatch(aliases[0], "reviewed_board_local_alias", fields);
    if (aliases.length > 1) return unresolvedMatch(board, "ambiguous_reviewed_board_local_alias", fields);
  }
  return unresolvedMatch(board, "committee_not_in_reviewed_registry", fields);
}

function resolvedMatch(row, method, fields) {
  return {
    status: "matched",
    reason: null,
    match_method: method,
    board_id: row.board_id,
    committee_id: row.committee_id,
    id: communityBoardCommitteeId(row.board_id, row.committee_id),
    publisher_name: row.publisher_name,
    publisher_identifier: row.publisher_identifier || fields.publisherIdentifier || null,
    source_url: row.source_url,
    registry_record: row,
  };
}

function unresolvedMatch(board, reason, fields) {
  return {
    status: "unresolved",
    reason,
    match_method: null,
    board_id: board,
    committee_id: null,
    id: null,
    publisher_name: fields.label,
    publisher_identifier: fields.publisherIdentifier,
  };
}

export function communityBoardCommitteeObject(match = {}) {
  if (match?.status !== "matched" || !match.id) return null;
  return {
    id: match.id,
    type: COMMUNITY_BOARD_COMMITTEE_OBJECT_TYPE,
    name: match.publisher_name,
    board_id: match.board_id,
    committee_id: match.committee_id,
    publisher_identifier: match.publisher_identifier || null,
    topic_facets: match.registry_record?.topic_facets || [],
    source_url: match.source_url || null,
    provenance: match.registry_record ? {
      source_url: match.registry_record.source_url,
      observed_on: match.registry_record.observed_on,
      match_method: match.match_method,
    } : null,
  };
}

export function communityBoardCommitteeRegistryEdge(match = {}) {
  const object = communityBoardCommitteeObject(match);
  if (!object) return null;
  return {
    schema: "cityscroll.community_board_has_committee_edge.v1",
    edge_type: COMMUNITY_BOARD_HAS_COMMITTEE_RELATION,
    relation: COMMUNITY_BOARD_HAS_COMMITTEE_RELATION,
    status: "promoted",
    promoted: true,
    from: `community-board:${object.board_id}`,
    to: object.id,
    target_kind: COMMUNITY_BOARD_COMMITTEE_OBJECT_TYPE,
    target_id: object.id,
    target_name: object.name,
    source_url: object.source_url,
    source_record_id: object.publisher_identifier,
    provenance: object.provenance,
    evidence: ["board_local_reviewed_registry", "official_publisher_source"],
    committee: object,
  };
}
