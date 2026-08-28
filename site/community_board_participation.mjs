/**
 * Source-qualified Community Board participation projection.
 *
 * This is a build-time/read-model adapter. It does not fetch publishers,
 * mutate Following or Calendar, or infer a rule for one board from another.
 * Governance facts come from the current retained bylaw version; application
 * currency comes only from an explicitly scoped application source.
 */

import {
  buildCommunityBoardBylawGraph,
  currentCommunityBoardBylawVersion,
} from "./community_board_bylaws.mjs";

export const COMMUNITY_BOARD_PARTICIPATION_SCHEMA = "cityscroll.community_board_participation.v1";
export const COMMUNITY_BOARD_PARTICIPATION_SOURCE_SCHEMA = "cityscroll.community_board_participation_source.v1";
export const COMMUNITY_BOARD_PARTICIPATION_RECEIPT_SCHEMA = "cityscroll.community_board_participation_receipt.v1";
export const COMMUNITY_BOARD_PARTICIPATION_METHOD = "community_board_participation_projection_v1";
export const COMMUNITY_BOARD_PARTICIPATION_UNKNOWN = "source_does_not_establish";
export const COMMUNITY_BOARD_PARTICIPATION_KINDS = Object.freeze([
  "public_session",
  "public_committee_membership",
  "full_board_membership",
]);
export const COMMUNITY_BOARD_APPLICATION_STATES = Object.freeze([
  "open",
  "closed",
  "unknown",
  "not_applicable",
]);
export const COMMUNITY_BOARD_APPLICATION_MAX_AGE_DAYS = 120;

const BOARD_ID = /^[a-z]+(?:-[a-z]+)*-cb-\d{2}$/;
const SOURCE_ID = /^[A-Za-z][A-Za-z0-9_.:-]{1,239}$/;

const clean = (value, max = 2_000) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

function date(value) {
  const match = clean(value, 80).match(/^(\d{4}-\d{2}-\d{2})(?:T|$)/);
  if (!match) return null;
  const parsed = new Date(`${match[1]}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : match[1];
}

function instant(value) {
  const text = clean(value, 100);
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function httpsUrl(value) {
  try {
    const url = new URL(clean(value, 2_000));
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function boardId(value) {
  const normalized = clean(value, 100).toLowerCase();
  return BOARD_ID.test(normalized) ? normalized : null;
}

function valueOrUnknown(value, statement = "The checked source does not establish this fact.") {
  const normalized = value && typeof value === "object" ? value : {};
  return {
    status: COMMUNITY_BOARD_PARTICIPATION_UNKNOWN,
    value: normalized.value ?? null,
    statement: clean(normalized.statement, 2_000) || statement,
  };
}

function established(value, statement) {
  return {
    status: "established",
    value: value ?? null,
    statement: clean(statement, 2_000) || null,
  };
}

function rule(version, topic) {
  return version?.rules?.find((candidate) => candidate.topic === topic) || null;
}

function ruleFact(version, topic) {
  const candidate = rule(version, topic);
  if (!candidate || candidate.answer !== "yes") return valueOrUnknown(candidate);
  return established(candidate.value, candidate.statement);
}

function bylawSource(version, candidateRule) {
  if (!version) return null;
  return {
    source_url: version.source_url,
    document_id: version.publisher_document_id,
    document_title: version.publisher_document_title || null,
    locator: candidateRule?.source_locator || null,
    observed_at: version.receipt?.observed_at || version.observed_on || null,
    observed_on: version.observed_on || null,
    effective_at: version.effective_date || version.adoption_date || null,
    receipt: version.receipt || null,
    bylaw_version_id: version.id,
  };
}

function applicationSourceForBoard(source, requestedBoardId) {
  const sourceBoardIds = Array.isArray(source?.applies_to_board_ids)
    ? source.applies_to_board_ids.map(boardId).filter(Boolean)
    : source?.board_id ? [boardId(source.board_id)].filter(Boolean) : [];
  return sourceBoardIds.includes(requestedBoardId) ? sourceBoardIds : null;
}

function normalizedApplicationSource(input = {}) {
  const id = clean(input.id || input.source_id, 240);
  if (!SOURCE_ID.test(id)) throw new TypeError("participation source requires a stable source id");
  const sourceUrl = httpsUrl(input.source_url || input.url);
  if (!sourceUrl) throw new TypeError("participation source requires an HTTPS source_url");
  const kind = clean(input.participation_kind || input.kind, 100);
  if (!COMMUNITY_BOARD_PARTICIPATION_KINDS.includes(kind) || kind === "public_session") {
    throw new TypeError("participation source requires an application participation kind");
  }
  const boardIds = (Array.isArray(input.applies_to_board_ids)
    ? input.applies_to_board_ids
    : [input.board_id])
    .map(boardId)
    .filter(Boolean);
  if (!boardIds.length) throw new TypeError("participation source requires explicit board scope");
  const receiptInput = input.receipt || input.observed_receipt || input.source_receipt;
  const receipt = receiptInput && typeof receiptInput === "object" ? { ...receiptInput } : null;
  const status = COMMUNITY_BOARD_APPLICATION_STATES.includes(clean(input.application_status, 40).toLowerCase())
    ? clean(input.application_status, 40).toLowerCase()
    : "unknown";
  return Object.freeze({
    schema: COMMUNITY_BOARD_PARTICIPATION_SOURCE_SCHEMA,
    id,
    participation_kind: kind,
    applies_to_board_ids: Object.freeze([...new Set(boardIds)]),
    eligibility: input.eligibility && typeof input.eligibility === "object"
      ? Object.freeze({ ...input.eligibility })
      : null,
    appointing_authority: input.appointing_authority && typeof input.appointing_authority === "object"
      ? Object.freeze({ ...input.appointing_authority })
      : null,
    application_status: status,
    application_open_at: instant(input.application_open_at || input.open_at),
    application_close_at: instant(input.application_close_at || input.close_at),
    application_destination: httpsUrl(input.application_destination || input.destination),
    application_cadence: clean(input.application_cadence || input.cadence, 300) || null,
    version: clean(input.version, 200) || null,
    source_url: sourceUrl,
    document_id: clean(input.document_id || input.publisher_document_id, 300) || null,
    document_title: clean(input.document_title || input.publisher_document_title, 500) || null,
    locator: clean(input.locator || input.source_locator, 2_000) || null,
    observed_at: instant(input.observed_at || input.observed_on),
    effective_at: instant(input.effective_at || input.effective_date),
    receipt,
    provenance: {
      source_url: sourceUrl,
      document_id: clean(input.document_id || input.publisher_document_id, 300) || null,
      locator: clean(input.locator || input.source_locator, 2_000) || null,
      observed_at: instant(input.observed_at || input.observed_on),
      effective_at: instant(input.effective_at || input.effective_date),
      method: COMMUNITY_BOARD_PARTICIPATION_METHOD,
      explicit_board_scope: true,
    },
  });
}

export function normalizeCommunityBoardParticipationSource(input = {}) {
  return normalizedApplicationSource(input);
}

function sourceEvidence(source) {
  if (!source) return null;
  return {
    source_url: source.source_url,
    document_id: source.document_id,
    document_title: source.document_title,
    locator: source.locator,
    observed_at: source.observed_at,
    effective_at: source.effective_at,
    receipt: source.receipt,
    source_id: source.id,
  };
}

function ageDays(observedAt, asOf) {
  const observed = observedAt ? new Date(observedAt).getTime() : NaN;
  const now = asOf ? new Date(asOf).getTime() : NaN;
  if (Number.isNaN(observed) || Number.isNaN(now)) return null;
  return Math.max(0, (now - observed) / 86_400_000);
}

export function communityBoardApplicationAvailability(source, {
  asOf = new Date().toISOString(),
  maxAgeDays = COMMUNITY_BOARD_APPLICATION_MAX_AGE_DAYS,
} = {}) {
  if (!source) return Object.freeze({ state: "not_applicable", cta: false, reason: "application_not_observed" });
  const age = ageDays(source.observed_at, asOf);
  if (source.receipt?.status !== "ok" || age == null) {
    return Object.freeze({ state: "unknown", cta: false, reason: source.receipt?.status === "ok" ? "application_observation_missing" : "application_source_receipt_unknown", age_days: age });
  }
  if (source.application_status === "closed") {
    return Object.freeze({ state: "closed", cta: false, reason: "application_window_closed", age_days: age });
  }
  if (source.application_status !== "open") {
    return Object.freeze({ state: "unknown", cta: false, reason: "application_window_unknown", age_days: age });
  }
  if (age == null || age > maxAgeDays) {
    return Object.freeze({ state: "unknown", cta: false, reason: "application_source_stale", age_days: age });
  }
  const asOfMs = new Date(asOf).getTime();
  const openMs = source.application_open_at ? new Date(source.application_open_at).getTime() : NaN;
  const closeMs = source.application_close_at ? new Date(source.application_close_at).getTime() : NaN;
  if (!source.application_destination) {
    return Object.freeze({ state: "unknown", cta: false, reason: "application_destination_missing", age_days: age });
  }
  if (!Number.isNaN(openMs) && asOfMs < openMs) {
    return Object.freeze({ state: "unknown", cta: false, reason: "application_window_not_open", age_days: age });
  }
  if (!Number.isNaN(closeMs) && asOfMs > closeMs) {
    return Object.freeze({ state: "closed", cta: false, reason: "application_window_closed", age_days: age });
  }
  return Object.freeze({ state: "open", cta: true, reason: "application_window_open", age_days: age });
}

function applicationFields(source, options) {
  const availability = communityBoardApplicationAvailability(source, options);
  return {
    application_status: source?.application_status || "unknown",
    application_open_at: source?.application_open_at || null,
    application_close_at: source?.application_close_at || null,
    application_destination: source?.application_destination || null,
    application_cadence: source?.application_cadence || null,
    application_version: source?.version || null,
    application_availability: availability,
    application_cta: availability.cta,
  };
}

function participationRecord({
  boardId: requestedBoardId,
  kind,
  committeeId = null,
  eligibility,
  authority,
  source,
  evidence = [],
  bylawVersion = null,
  history = [],
  options = {},
}) {
  const application = source && kind !== "public_session" ? applicationFields(source, options) : {
    application_status: "not_applicable",
    application_open_at: null,
    application_close_at: null,
    application_destination: null,
    application_cadence: null,
    application_version: null,
    application_availability: Object.freeze({ state: "not_applicable", cta: false, reason: "participation_is_not_an_application" }),
    application_cta: false,
  };
  return {
    schema: COMMUNITY_BOARD_PARTICIPATION_SCHEMA,
    participation_kind: kind,
    board_id: requestedBoardId,
    committee_id: committeeId,
    eligibility,
    appointing_authority: authority,
    ...application,
    source: sourceEvidence(source) || evidence.find(Boolean) || bylawSource(bylawVersion, null),
    evidence: Object.freeze([
      ...evidence.filter(Boolean),
      ...(source ? [sourceEvidence(source)] : []),
    ]),
    bylaw_version_id: bylawVersion?.id || null,
    superseded_bylaw_versions: Object.freeze(history.map((version) => version.id)),
    cross_board_inference: false,
    provenance: {
      method: COMMUNITY_BOARD_PARTICIPATION_METHOD,
      board_id: requestedBoardId,
      committee_id: committeeId,
      source_qualified: true,
      cross_board_inference: false,
      bylaw_version_id: bylawVersion?.id || null,
      source_ids: Object.freeze([
        ...evidence.filter(Boolean).map((item) => item.bylaw_version_id || item.source_id).filter(Boolean),
        ...(source ? [source.id] : []),
      ]),
    },
  };
}

function currentVersionBundle(bylaws, requestedBoardId) {
  const graph = bylaws?.currentByBoard
    ? bylaws
    : buildCommunityBoardBylawGraph(bylaws || []);
  const current = currentCommunityBoardBylawVersion(graph.versions, requestedBoardId);
  const history = graph.versions.filter((version) => version.board_id === requestedBoardId && version.id !== current?.id);
  return { graph, current, history };
}

function sourcesForBoard(sources, requestedBoardId) {
  return (Array.isArray(sources) ? sources : [])
    .map(normalizedApplicationSource)
    .filter((source) => applicationSourceForBoard(source, requestedBoardId));
}

/** Project one board without publisher reads or state mutation. */
export function projectCommunityBoardParticipation({
  board_id: requestedBoardId,
  boardId: boardIdAlias,
  bylaws,
  communityBoardBylaws,
  application_sources = [],
  applications,
  as_of = new Date().toISOString(),
  max_age_days = COMMUNITY_BOARD_APPLICATION_MAX_AGE_DAYS,
} = {}) {
  const requested = boardId(requestedBoardId || boardIdAlias);
  if (!requested) throw new TypeError("participation projection requires a valid board_id");
  const { current, history } = currentVersionBundle(bylaws || communityBoardBylaws, requested);
  const options = { asOf: as_of, maxAgeDays: max_age_days };
  const scopedSources = sourcesForBoard(applications || application_sources, requested);
  const committeeSource = scopedSources.find((source) => source.participation_kind === "public_committee_membership") || null;
  const boardSource = scopedSources.find((source) => source.participation_kind === "full_board_membership") || null;
  const sessionRule = rule(current, "public_participation");
  const committeeEligibilityRule = rule(current, "public_committee_member_eligibility");
  const committeeAuthorityRule = rule(current, "committee_membership_eligibility");
  const session = participationRecord({
    boardId: requested,
    kind: "public_session",
    eligibility: ruleFact(current, "public_participation"),
    authority: valueOrUnknown(null, "The checked source does not establish an appointing authority for public attendance or speaking."),
    evidence: [bylawSource(current, sessionRule)],
    bylawVersion: current,
    history,
    options,
  });
  const committee = participationRecord({
    boardId: requested,
    kind: "public_committee_membership",
    eligibility: committeeSource?.eligibility
      ? established(committeeSource.eligibility.value ?? committeeSource.eligibility, committeeSource.eligibility.statement)
      : ruleFact(current, "public_committee_member_eligibility"),
    authority: committeeSource?.appointing_authority
      ? established(committeeSource.appointing_authority.value ?? committeeSource.appointing_authority, committeeSource.appointing_authority.statement)
      : ruleFact(current, "committee_membership_eligibility"),
    source: committeeSource,
    evidence: [bylawSource(current, committeeEligibilityRule), bylawSource(current, committeeAuthorityRule)],
    bylawVersion: current,
    history,
    options,
  });
  const board = participationRecord({
    boardId: requested,
    kind: "full_board_membership",
    eligibility: boardSource?.eligibility
      ? established(boardSource.eligibility.value ?? boardSource.eligibility, boardSource.eligibility.statement)
      : valueOrUnknown(),
    authority: boardSource?.appointing_authority
      ? established(boardSource.appointing_authority.value ?? boardSource.appointing_authority, boardSource.appointing_authority.statement)
      : valueOrUnknown(),
    source: boardSource,
    evidence: [],
    bylawVersion: null,
    history: [],
    options,
  });
  const participation = [session, committee, board];
  return Object.freeze({
    schema: COMMUNITY_BOARD_PARTICIPATION_SCHEMA,
    method: COMMUNITY_BOARD_PARTICIPATION_METHOD,
    board_id: requested,
    generated_at: as_of,
    cross_board_inference: false,
    governance: {
      status: current ? "established" : COMMUNITY_BOARD_PARTICIPATION_UNKNOWN,
      current_bylaw_version_id: current?.id || null,
      latest_known_good_version_id: current?.id || null,
      superseded_versions: history.map((version) => ({
        id: version.id,
        source_url: version.source_url,
        observed_on: version.observed_on,
        effective_date: version.effective_date,
        supersedes: version.supersedes,
      })),
      source: current ? bylawSource(current, null) : null,
    },
    participation: Object.freeze(participation),
    applications: Object.freeze(scopedSources.map((source) => ({
      ...source,
      availability: communityBoardApplicationAvailability(source, options),
    }))),
    provenance: {
      method: COMMUNITY_BOARD_PARTICIPATION_METHOD,
      observed_at: as_of,
      source_qualified: true,
      cross_board_inference: false,
    },
  });
}

export const buildCommunityBoardParticipationProjection = projectCommunityBoardParticipation;

/** Materialize all explicitly registered boards, retaining unknown rows. */
export function buildCommunityBoardParticipationLookup({
  boards = [],
  sourceRegistry,
  bylaws,
  communityBoardBylaws,
  application_sources = [],
  applications,
  as_of = new Date().toISOString(),
  max_age_days = COMMUNITY_BOARD_APPLICATION_MAX_AGE_DAYS,
} = {}) {
  const boardRows = boards.length
    ? boards
    : (sourceRegistry?.sources || []).filter((row) => row.body_type === "community_board");
  const byBoard = {};
  for (const board of boardRows) {
    const id = boardId(board.board_id || board.body_id || board.id);
    if (!id) continue;
    byBoard[id] = projectCommunityBoardParticipation({
      board_id: id,
      bylaws: bylaws || communityBoardBylaws,
      application_sources: applications || application_sources,
      as_of,
      max_age_days,
    });
  }
  return {
    schema: COMMUNITY_BOARD_PARTICIPATION_SCHEMA,
    method: COMMUNITY_BOARD_PARTICIPATION_METHOD,
    generated_at: as_of,
    board_count: Object.keys(byBoard).length,
    cross_board_inference: false,
    by_board: byBoard,
  };
}

export function communityBoardParticipationForBoard(lookup, requestedBoardId) {
  const requested = boardId(requestedBoardId);
  return requested ? lookup?.by_board?.[requested] || null : null;
}
