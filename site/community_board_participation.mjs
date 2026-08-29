/**
 * Source-qualified Community Board participation projection.
 *
 * This is a build-time/read-model adapter. It does not fetch publishers,
 * mutate Following or Calendar, or infer a rule for one board from another.
 * Governance facts come from the current retained bylaw version; application
 * currency comes only from an explicitly scoped application source.
 */

import { officialSourceLink } from "./affordance_grammar.mjs";
import {
  calendarNativeSubscriptionUrl,
  hasDefensibleDatedOccurrences,
} from "./calendar_subscription.mjs";
import { renderNodeSection } from "./civic_document_chrome.mjs";
import { communityBoardMeetingEdgeAccepted } from "./community_board_institution_edges.mjs";
import { followingUrlFromWatch } from "./following_view.mjs";
import { calendarFeedUrlForScope } from "./scope_v0.mjs";
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
export const COMMUNITY_BOARD_PARTICIPATION_PATH_KINDS = Object.freeze([
  "attend_meeting",
  "add_to_calendar",
  "follow_board",
  "follow_committee",
  "speak_or_comment",
  "contact_board",
  "apply_public_committee_membership",
  "apply_full_board_membership",
]);
export const APPLY_NOW_LABEL = "Apply now";

const BOARD_ID = /^[a-z]+(?:-[a-z]+)*-cb-\d{2}$/;
const SOURCE_ID = /^[A-Za-z][A-Za-z0-9_.:-]{1,239}$/;

const clean = (value, max = 2_000) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

const esc = (value) => String(value ?? "").replace(/[<>&"']/g, (char) => ({
  "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
}[char]));

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

function dayStamp(value) {
  const match = String(value || "").match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function isOnOrAfter(dateValue, asOf) {
  const day = dayStamp(dateValue);
  if (!day) return false;
  const now = dayStamp(asOf);
  return now ? day >= now : true;
}

function participationKind(projection, kind) {
  return (Array.isArray(projection?.participation) ? projection.participation : [])
    .find((row) => row?.participation_kind === kind) || null;
}

function evidenceFrom(source) {
  if (!source) return null;
  return {
    source_url: source.source_url || null,
    document_id: source.document_id || source.source_id || null,
    document_title: source.document_title || null,
    locator: source.locator || null,
    observed_at: source.observed_at || source.observed_on || null,
    receipt: source.receipt || null,
    source_id: source.source_id || source.id || source.bylaw_version_id || null,
    statement: source.statement || null,
  };
}

function establishedSpeaking(record) {
  if (record?.eligibility?.status !== "established") return false;
  const value = record.eligibility.value && typeof record.eligibility.value === "object"
    ? record.eligibility.value
    : {};
  if (value.public_session === true || value.may_speak === true || value.speak === true) return true;
  return /\bspeak|\bcomment|\btestif/i.test(record.eligibility.statement || "");
}

function acceptedMeetings(meetings = []) {
  return (Array.isArray(meetings) ? meetings : []).filter((row) => {
    if (!row || typeof row !== "object") return false;
    if (row.relation && row.relation !== "hosts_meeting") return false;
    return communityBoardMeetingEdgeAccepted(row) || row.state === "official";
  });
}

function meetingDate(row) {
  return row?.join?.event_date || row?.event_date || row?.meeting_date || row?.date || null;
}

function meetingHref(row) {
  return row?.href || row?.canonical_href || null;
}

function meetingId(row) {
  return row?.target_id || row?.to || row?.meeting_id || null;
}

function isCommitteeMeeting(row) {
  const host = String(row?.from || row?.committee_ref || "");
  return host.startsWith("community-board-committee:") || Boolean(row?.committee_name || row?.committee_id);
}

function boardWatch(requestedBoardId) {
  const ref = `community-board:${requestedBoardId}`;
  return { lens: "meetings", filter: { communityBoard: ref } };
}

function calendarRowsForMeetings(meetings) {
  return acceptedMeetings(meetings).map((row) => ({
    meeting_id: meetingId(row),
    event_date: meetingDate(row),
  })).filter((row) => row.meeting_id && row.event_date);
}

function pathRecord({
  kind,
  verb,
  href = null,
  cta = false,
  state = "supported",
  destination_kind = "internal",
  reason = null,
  evidence = null,
}) {
  return Object.freeze({
    kind,
    verb,
    href,
    cta: Boolean(cta && href),
    state,
    destination_kind,
    reason: clean(reason, 2_000) || null,
    evidence: evidence ? Object.freeze({ ...evidence }) : null,
    cross_board_inference: false,
  });
}

/**
 * Compose the bounded Ways to participate paths for one selected board.
 * Continuation destinations reuse Following and Calendar; application and
 * speaking verbs require board-local retained evidence.
 */
export function communityBoardParticipationPaths({
  board_id: requestedBoardId,
  boardId: boardIdAlias,
  board = {},
  participation = null,
  meetings = [],
  committees = [],
  as_of = null,
} = {}) {
  const requested = boardId(requestedBoardId || boardIdAlias || board?.body_id || board?.board_id);
  if (!requested) return Object.freeze([]);
  const asOf = as_of || participation?.generated_at || null;
  const paths = [];
  const upcoming = acceptedMeetings(meetings)
    .filter((row) => isOnOrAfter(meetingDate(row), asOf) && meetingHref(row))
    .sort((left, right) => String(meetingDate(left)).localeCompare(String(meetingDate(right))));
  const nextMeeting = upcoming[0] || null;
  if (nextMeeting) {
    const committee = isCommitteeMeeting(nextMeeting);
    paths.push(pathRecord({
      kind: "attend_meeting",
      verb: committee ? "Attend the next committee meeting" : "Attend the next board meeting",
      href: meetingHref(nextMeeting),
      cta: true,
      destination_kind: "internal",
      reason: meetingDate(nextMeeting) ? `Scheduled ${meetingDate(nextMeeting)}` : null,
      evidence: evidenceFrom({
        source_url: nextMeeting.source_url || nextMeeting.provenance?.source_url,
        receipt: nextMeeting.source_receipt || nextMeeting.provenance?.observed_receipt,
        observed_at: nextMeeting.source_receipt?.observed_at || nextMeeting.provenance?.observed_at,
        locator: meetingDate(nextMeeting),
        document_id: meetingId(nextMeeting),
        statement: committee
          ? "This board’s published committee calendar includes an upcoming meeting."
          : "This board’s published calendar includes an upcoming meeting.",
      }),
    }));
  }
  const calendarRows = calendarRowsForMeetings(meetings);
  const calendarWatch = boardWatch(requested);
  const calendarFeed = hasDefensibleDatedOccurrences("meetings", calendarRows)
    ? calendarFeedUrlForScope(calendarWatch)
    : null;
  const calendarHref = calendarFeed ? calendarNativeSubscriptionUrl(calendarFeed) || calendarFeed : null;
  if (calendarHref) {
    paths.push(pathRecord({
      kind: "add_to_calendar",
      verb: "Add to calendar",
      href: calendarHref,
      cta: true,
      destination_kind: "calendar",
      reason: "Standing calendar for this board’s published meetings.",
      evidence: evidenceFrom(nextMeeting || calendarRows[0] || acceptedMeetings(meetings)[0]),
    }));
  }
  const followHref = followingUrlFromWatch(calendarWatch, { frequency: "weekly" });
  if (followHref) {
    paths.push(pathRecord({
      kind: "follow_board",
      verb: "Follow this board",
      href: followHref,
      cta: true,
      destination_kind: "internal",
      reason: "Email when meetings for this board are published.",
      evidence: evidenceFrom({
        source_url: board.homepage_url || board.directory_url,
        document_id: requested,
        statement: "Follow uses this board’s exact identity.",
      }),
    }));
  }
  // Follow committee remains omitted until meetings watches can replay a
  // committee identity without falling back to the whole board.
  void committees;

  const session = participationKind(participation, "public_session");
  if (establishedSpeaking(session)) {
    const speakHref = meetingHref(nextMeeting)
      || httpsUrl(session.source?.source_url)
      || httpsUrl(board.homepage_url);
    paths.push(pathRecord({
      kind: "speak_or_comment",
      verb: "Speak or comment at a public session",
      href: speakHref,
      cta: Boolean(speakHref),
      destination_kind: speakHref && speakHref.startsWith("/") ? "internal" : "official",
      reason: session.eligibility.statement,
      evidence: evidenceFrom({
        ...session.source,
        statement: session.eligibility.statement,
      }),
    }));
  }

  const contactHref = httpsUrl(board.homepage_url) || httpsUrl(board.directory_url);
  if (contactHref) {
    paths.push(pathRecord({
      kind: "contact_board",
      verb: "Contact this board",
      href: contactHref,
      cta: true,
      destination_kind: "official",
      reason: board.homepage_url ? "Board homepage" : "City directory entry",
      evidence: evidenceFrom({
        source_url: contactHref,
        document_id: requested,
        statement: "Contact uses this board’s published homepage or directory listing.",
      }),
    }));
  }

  const committeeMembership = participationKind(participation, "public_committee_membership");
  if (committeeMembership?.eligibility?.status === "established") {
    const applyOpen = committeeMembership.application_cta === true
      && httpsUrl(committeeMembership.application_destination);
    paths.push(pathRecord({
      kind: "apply_public_committee_membership",
      verb: applyOpen ? APPLY_NOW_LABEL : "Public committee membership",
      href: applyOpen
        ? httpsUrl(committeeMembership.application_destination)
        : httpsUrl(committeeMembership.source?.source_url),
      cta: Boolean(applyOpen),
      state: applyOpen ? "supported" : (committeeMembership.application_availability?.state === "closed" ? "closed" : "supported"),
      destination_kind: "official",
      reason: applyOpen
        ? committeeMembership.eligibility.statement
        : (committeeMembership.application_availability?.state === "closed"
          ? "The published committee application window is closed."
          : committeeMembership.eligibility.statement),
      evidence: evidenceFrom({
        ...committeeMembership.source,
        statement: committeeMembership.eligibility.statement,
      }),
    }));
  }

  const fullBoard = participationKind(participation, "full_board_membership");
  const fullBoardEvidence = fullBoard?.source || fullBoard?.evidence?.[0];
  if (fullBoard?.application_cta === true && httpsUrl(fullBoard.application_destination)) {
    paths.push(pathRecord({
      kind: "apply_full_board_membership",
      verb: APPLY_NOW_LABEL,
      href: httpsUrl(fullBoard.application_destination),
      cta: true,
      destination_kind: "official",
      reason: fullBoard.eligibility?.statement || "A current full-board application is published for this board.",
      evidence: evidenceFrom({
        ...fullBoardEvidence,
        statement: fullBoard.eligibility?.statement,
      }),
    }));
  } else if (fullBoard?.application_availability?.state === "closed" && fullBoardEvidence) {
    paths.push(pathRecord({
      kind: "apply_full_board_membership",
      verb: "Community Board membership",
      href: httpsUrl(fullBoardEvidence.source_url),
      cta: false,
      state: "closed",
      destination_kind: "official",
      reason: "The published application window is closed.",
      evidence: evidenceFrom({
        ...fullBoardEvidence,
        statement: fullBoard.eligibility?.statement,
      }),
    }));
  }

  return Object.freeze(paths);
}

export function communityBoardParticipationPathsForView(view = {}) {
  const meetings = view.categories?.find((category) => category.id === "meetings")?.items
    || view.institution_edges
    || [];
  const committees = view.categories?.find((category) => category.id === "committees")?.items || [];
  return communityBoardParticipationPaths({
    board_id: view.body_id || view.id,
    board: view.board,
    participation: view.participation,
    meetings,
    committees,
    as_of: view.participation?.generated_at || view.summary?.generated_at,
  });
}

function pathLink(path, escapeHtml) {
  if (!path.href) return `<strong>${escapeHtml(path.verb)}</strong>`;
  if (path.destination_kind === "official") {
    return officialSourceLink({
      href: path.href,
      label: path.verb,
      className: "board-participation-link",
      escape: escapeHtml,
    });
  }
  return `<a class="board-participation-link" href="${escapeHtml(path.href)}">${escapeHtml(path.verb)}</a>`;
}

function pathEvidenceMarkup(path, escapeHtml) {
  const evidence = path.evidence || {};
  const sourceLink = evidence.source_url
    ? officialSourceLink({
      href: evidence.source_url,
      label: evidence.document_title || "Open the source",
      className: "board-source-link",
      escape: escapeHtml,
    })
    : "";
  const parts = [
    evidence.statement ? `<p>${escapeHtml(evidence.statement)}</p>` : "",
    evidence.locator ? `<p>${escapeHtml(evidence.locator)}</p>` : "",
    evidence.document_id && !/^[a-z][a-z0-9_-]*:/.test(String(evidence.document_id))
      ? `<p>${escapeHtml(evidence.document_id)}</p>` : "",
    evidence.observed_at ? `<p>Source checked ${escapeHtml(String(evidence.observed_at).slice(0, 10))}</p>` : "",
    evidence.receipt?.status ? `<p>Receipt ${escapeHtml(evidence.receipt.status)}</p>` : "",
    sourceLink ? `<p>${sourceLink}</p>` : "",
  ].filter(Boolean).join("");
  if (!parts) return "";
  return `<details class="inline-disclose board-participation-details"><summary>Why this appears</summary><div class="inline-disclose-body">${parts}</div></details>`;
}

/** Render the additive Ways to participate section for a selected board. */
export function renderCommunityBoardParticipationSection(viewOrPaths) {
  const paths = Array.isArray(viewOrPaths)
    ? viewOrPaths
    : communityBoardParticipationPathsForView(viewOrPaths);
  if (!paths.length) return "";
  const items = paths.map((path) => {
    const attrs = [
      `data-participation-path="${esc(path.kind)}"`,
      `data-path-state="${esc(path.state)}"`,
      path.cta ? `data-participation-cta="${esc(path.kind === "apply_full_board_membership" || path.kind === "apply_public_committee_membership" ? "apply-now" : path.kind)}"` : "",
      path.evidence?.source_id ? `data-source-id="${esc(path.evidence.source_id)}"` : "",
      path.evidence?.document_id ? `data-document-id="${esc(path.evidence.document_id)}"` : "",
    ].filter(Boolean).join(" ");
    return `<li class="node-record board-participation-path" ${attrs}><div class="node-record-main">${pathLink(path, esc)}</div>${path.reason ? `<span class="muted node-muted">${esc(path.reason)}</span>` : ""}${pathEvidenceMarkup(path, esc)}</li>`;
  }).join("");
  return renderNodeSection({
    heading: "Ways to participate",
    headingId: "ways-to-participate-heading",
    extraClass: "node-card civic-object-section community-board-participation",
    attrs: {
      id: "ways-to-participate",
      "data-community-board-participation": "1",
    },
    body: `<p class="node-lede">Current ways to enter this board’s public work, shown only when this board’s sources support them.</p><ul class="node-record-list board-participation-list">${items}</ul>`,
  });
}

