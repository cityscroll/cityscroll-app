/**
 * Answer one ordinary question about one community board: when did it last
 * meet in full session, and where can a reader see that for themselves.
 *
 * The meetings corpus holds committee meetings, task-force meetings and full
 * board meetings side by side, and it covers some boards and not others. Both
 * facts make a bare search a poor answer: the newest row for a board is
 * usually a committee, and an empty result set reads as "no community boards
 * here" rather than "this board is not covered". This module keeps those cases
 * apart. It never returns a committee meeting in place of a full board one,
 * never returns another board's meeting, and never presents an empty result or
 * a zero as an answer.
 */

export const COMMUNITY_BOARD_FULL_BOARD_LENS_SCHEMA = "cityscroll.community_board_full_board_meeting_answer.v1";

export const COMMUNITY_BOARD_FULL_BOARD_ANSWER_STATES = Object.freeze([
  "full_board_meeting",
  "no_full_board_meeting_recorded",
  "board_source_unreadable",
  "board_not_covered",
  "board_query_unresolved",
  "lens_unreadable",
]);

export const COMMUNITY_BOARD_CONVENING_BODIES = Object.freeze(["full_board", "committee", "unknown"]);

import { sourceRecordStatus } from "./community_board_source_adapters.mjs";

const SHARED_MEETING_READ_MODEL_SCHEMA = "cityscroll.shared_meeting_read_model.v1";

// Publishers name a committee, a subcommittee, a task force or the executive
// body in the meeting title. A title carrying any of those is that body's
// meeting, whatever else the title says, so this is checked first.
const COMMITTEE_TITLE = /\b(?:committees?|subcommittees?|task\s*-?\s*forces?|taskforces?|working\s+group|caucus|briefing|oversight|executive|cabinet)\b/i;
// Full-board vocabulary as boards themselves write it.
const FULL_BOARD_TITLE = /\bfull\s+board\b|\bgeneral\s+board\s+meeting\b|\b(?:monthly\s+)?board\s+meeting\b|\bcommunity\s+board\s+\d+\s+meeting\b/i;

const BOROUGH_WORDS = Object.freeze({
  bronx: "bronx",
  brooklyn: "brooklyn",
  manhattan: "manhattan",
  queens: "queens",
  "staten island": "staten-island",
});

function text(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed || null;
}

function normalizeQuery(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function dayOf(value) {
  return String(value ?? "").slice(0, 10) || null;
}

/**
 * Classify the body that convened one meeting from what the publisher said.
 *
 * A meeting joined to a committee is that committee's. Otherwise only the
 * publisher's own title decides, and a title that names neither stays
 * `unknown` so it can never stand in for a full board meeting.
 */
export function classifyCommunityBoardConveningBody(meeting = {}) {
  if (text(meeting.committee?.name) || text(meeting.institution_refs?.committee_ref)) return "committee";
  const title = String(meeting.title ?? "");
  if (COMMITTEE_TITLE.test(title)) return "committee";
  if (FULL_BOARD_TITLE.test(title)) return "full_board";
  return "unknown";
}

function coverageRows(readModel) {
  const rows = readModel?.sources?.community_board?.board_coverage;
  return Array.isArray(rows) ? rows : null;
}

function boardQueryKeys(row) {
  const keys = new Set();
  const id = text(row.board_id);
  if (id) {
    keys.add(normalizeQuery(id));
    keys.add(normalizeQuery(`community-board:${id}`));
  }
  const name = text(row.board_name);
  if (name) keys.add(normalizeQuery(name));
  const district = text(row.community_district);
  if (district) keys.add(normalizeQuery(district));
  const borough = text(row.borough);
  const number = Number(String(row.board_id || "").match(/-cb-(\d{2})$/)?.[1]);
  if (borough && Number.isFinite(number)) {
    for (const label of [
      `${borough} community board ${number}`,
      `${borough} community board no ${number}`,
      `${borough} community board number ${number}`,
      `${borough} cb ${number}`,
      `cb ${number} ${borough}`,
      `community board ${number} ${borough}`,
    ]) keys.add(normalizeQuery(label));
  }
  return [...keys].filter(Boolean);
}

/**
 * Resolve a reader's board wording to one inventoried board.
 *
 * A borough is required. "Community Board 5" names five different boards, and
 * answering it with any one of them is the substitution this lens exists to
 * prevent, so an unqualified number resolves to nothing at all.
 */
export function resolveCommunityBoardQuery(query, coverage = []) {
  const normalized = normalizeQuery(query);
  if (!normalized) return null;
  const index = new Map();
  for (const row of coverage) {
    for (const key of boardQueryKeys(row)) {
      if (!index.has(key)) index.set(key, row);
    }
  }
  const direct = index.get(normalized);
  if (direct) return direct;
  const parsed = parseCommunityBoardQuery(query);
  if (!parsed) return null;
  return index.get(normalizeQuery(`${parsed.borough} community board ${parsed.number}`)) || null;
}

/**
 * Read a borough and a board number out of a reader's wording.
 *
 * A wording that names both but matches no inventoried board is a board this
 * corpus does not cover; a wording that names neither is a question this lens
 * cannot turn into one board. The two answers differ, so the parse is separate
 * from the lookup.
 */
export function parseCommunityBoardQuery(query) {
  const normalized = normalizeQuery(query);
  if (!normalized) return null;
  const borough = Object.keys(BOROUGH_WORDS).find((word) => normalized.includes(word));
  const number = normalized.match(/\b(?:community\s+board|cb|board)\s*(?:no|number)?\s*(\d{1,2})\b/)?.[1]
    || normalized.match(/\b(\d{1,2})\b/)?.[1];
  if (!borough || !number) return null;
  return { borough, borough_id: BOROUGH_WORDS[borough], number: Number(number) };
}

function minutesProjection(meeting, coverage) {
  const documents = (Array.isArray(meeting?.meeting_documents) ? meeting.meeting_documents : [])
    .filter((document) => document?.role === "minutes" && document?.attachment_status === "attached");
  if (documents.length) {
    return {
      status: "held",
      document_count: documents.length,
      documents: documents.slice(0, 5).map((document) => ({
        title: text(document.title),
        url: text(document.document_url || document.record_url),
        publication_date: dayOf(document.publication_date || document.meeting_date || document.date),
      })),
      source_url: text(coverage?.source_url),
      observed_at: text(coverage?.observed_at),
      reason: null,
      statement: "The minutes corpus holds minutes for this meeting.",
    };
  }
  const state = coverage?.state || "not-registered";
  const reason = {
    indexed: "minutes_source_read_without_minutes_for_this_meeting",
    "checked-empty": "minutes_source_read_and_publishes_no_minutes",
    unreadable: "minutes_source_could_not_be_read",
    "not-registered": "no_minutes_source_is_published_for_this_board",
  }[state];
  const statement = {
    indexed: "The minutes corpus was read for this board and holds no minutes for this meeting.",
    "checked-empty": "The minutes corpus was read for this board and it publishes no minutes there.",
    unreadable: "The minutes corpus could not read this board's minutes source, so whether minutes exist is unknown.",
    "not-registered": "This board publishes no minutes source in this corpus, so whether minutes exist is unknown.",
  }[state];
  return {
    status: "not_held",
    document_count: 0,
    documents: [],
    source_url: text(coverage?.source_url),
    observed_at: text(coverage?.observed_at),
    reason,
    statement,
  };
}

/**
 * Report the observation behind a meeting against the same retention window the
 * board source join already uses, so an answer built on an older capture says
 * so instead of reading as a current observation.
 */
function observation(row, asOfInstant) {
  const observedAt = text(row.source_receipt?.observed_at);
  const status = sourceRecordStatus({ observed_receipt: row.source_receipt }, {
    ...(asOfInstant ? { asOf: asOfInstant } : {}),
  });
  const observedDay = dayOf(observedAt);
  const asOfDay = dayOf(asOfInstant);
  const ageDays = observedDay && asOfDay
    ? Math.round((Date.parse(`${asOfDay}T00:00:00Z`) - Date.parse(`${observedDay}T00:00:00Z`)) / 86_400_000)
    : null;
  return {
    observed_at: observedAt,
    observation_state: status.state === "observed" ? "observed" : "outside_retention_window",
    observation_reason: status.reason,
    observation_age_days: ageDays,
  };
}

function meetingProjection(row, board, coverage, asOfInstant) {
  const observed = observation(row, asOfInstant);
  return {
    meeting_id: text(row.meeting_id),
    title: text(row.title),
    event_date: text(row.event_date),
    meeting_day: dayOf(row.event_date),
    board_id: text(row.board_id),
    board_name: text(row.board_name) || text(board.board_name),
    convening_body: "full_board",
    convening_body_basis: "publisher_meeting_title",
    venue: row.venue || null,
    source: {
      source_system: text(row.source_system),
      publisher: text(board.board_name),
      source_url: text(row.source_url) || text(coverage?.meetings?.source_url),
      publisher_identifier: text(row.publisher_identifier),
      observed_at: observed.observed_at || text(coverage?.meetings?.observed_at),
      observation_state: observed.observation_state,
      observation_age_days: observed.observation_age_days,
      retained_snapshot: coverage?.meetings?.retained_snapshot || null,
    },
    minutes: minutesProjection(row, coverage?.minutes),
  };
}

function answer(fields) {
  return { schema: COMMUNITY_BOARD_FULL_BOARD_LENS_SCHEMA, ...fields };
}

/**
 * Answer "when did this board last meet in full session" from the committed
 * meetings read model, contacting no publisher.
 */
export function communityBoardFullBoardMeetingAnswer({ readModel = null, query = "", asOf = null } = {}) {
  const asked = text(query);
  // The day bounds "has it happened yet"; the instant bounds "how old is the
  // observation". Truncating the second to a day makes a same-day observation
  // look like a future one.
  const asOfInstant = text(asOf) || text(readModel?.freshness?.checked_at) || text(readModel?.generated_at);
  const asOfDay = dayOf(asOfInstant);
  const base = { query: asked, as_of: asOfDay, board: null, meeting: null, coverage: null };
  const coverage = coverageRows(readModel);
  if (readModel?.schema !== SHARED_MEETING_READ_MODEL_SCHEMA
    || !Array.isArray(readModel?.rows)
    || !coverage
    || readModel?.sources?.community_board?.status === "unavailable") {
    return answer({
      ...base,
      status: "lens_unreadable",
      reason: "community_board_meeting_lens_could_not_be_read",
      statement: "The community board meetings lens could not be read, so this question cannot be answered from it right now.",
    });
  }
  if (!asked) {
    return answer({
      ...base,
      status: "board_query_unresolved",
      reason: "no_board_named",
      statement: "No community board was named, so there is nothing to look up.",
    });
  }
  const board = resolveCommunityBoardQuery(asked, coverage);
  if (!board && parseCommunityBoardQuery(asked)) {
    return answer({
      ...base,
      status: "board_not_covered",
      reason: "board_is_not_in_the_published_board_set",
      statement: `"${asked}" is not one of the community boards this corpus publishes, so there is nothing here to report about it.`,
    });
  }
  if (!board) {
    return answer({
      ...base,
      status: "board_query_unresolved",
      reason: "board_name_did_not_resolve_to_one_board",
      statement: `"${asked}" does not name one community board in this corpus. Naming the borough with the board number resolves it; a bare board number belongs to five different boards.`,
    });
  }
  const boardIdentity = {
    id: board.board_id,
    name: board.board_name,
    borough: board.borough,
    community_district: board.community_district,
  };
  const boardCoverage = { meetings: board.meetings, minutes: board.minutes };
  const answered = { ...base, board: boardIdentity, coverage: boardCoverage };
  if (board.meetings?.state === "unreadable") {
    return answer({
      ...answered,
      status: "board_source_unreadable",
      reason: board.meetings.reason || "meeting_source_could_not_be_read",
      statement: `${board.board_name} publishes a meeting source that this corpus could not read, so when it last met in full session is unknown here. The board's own meeting calendar carries its full board meetings.`,
    });
  }
  if (board.meetings?.state === "not-registered") {
    return answer({
      ...answered,
      status: "board_not_covered",
      reason: "no_meeting_source_is_published_for_this_board",
      statement: `${board.board_name} publishes no meeting source that this corpus reads, so when it last met in full session is unknown here. The board's own meeting calendar carries its full board meetings.`,
    });
  }
  const boardMeetings = readModel.rows
    .filter((row) => row.source_system === "community_board" && row.board_id === board.board_id)
    .filter((row) => classifyCommunityBoardConveningBody(row) === "full_board")
    .filter((row) => dayOf(row.event_date))
    .sort((left, right) => String(right.event_date).localeCompare(String(left.event_date)));
  const boardRows = readModel.rows
    .filter((row) => row.source_system === "community_board" && row.board_id === board.board_id);
  const held = asOfDay
    ? boardMeetings.find((row) => dayOf(row.event_date) <= asOfDay)
    : boardMeetings[0];
  if (held) {
    const meeting = meetingProjection(held, board, boardCoverage, asOfInstant);
    const dated = meeting.source.observation_state === "observed"
      ? `observed ${dayOf(meeting.source.observed_at)}`
      : `observed ${dayOf(meeting.source.observed_at)}, which is older than the window this corpus treats as a current observation, so a later meeting may have been held since`;
    return answer({
      ...answered,
      status: "full_board_meeting",
      meeting,
      reason: null,
      statement: `${board.board_name} last met in full session on ${meeting.meeting_day} according to ${meeting.source.publisher}, ${dated}. ${meeting.minutes.statement}`,
    });
  }
  const scheduled = [...boardMeetings].reverse().find((row) => !asOfDay || dayOf(row.event_date) > asOfDay);
  if (scheduled) {
    return answer({
      ...answered,
      status: "no_full_board_meeting_recorded",
      reason: "record_holds_only_later_full_board_meetings",
      next_scheduled: meetingProjection(scheduled, board, boardCoverage, asOfInstant),
      statement: `This corpus holds no full board meeting for ${board.board_name} on or before ${asOfDay}. The earliest it holds is ${dayOf(scheduled.event_date)}, so when the board last met in full session is not recorded here.`,
    });
  }
  return answer({
    ...answered,
    status: "no_full_board_meeting_recorded",
    reason: board.meetings?.state === "checked-empty"
      ? "meeting_source_read_and_publishes_no_meetings"
      : boardRows.some((row) => classifyCommunityBoardConveningBody(row) === "unknown")
        ? "meeting_source_has_unclassified_titles"
        : "meeting_source_read_without_a_full_board_meeting",
    statement: board.meetings?.state === "checked-empty"
      ? `${board.board_name}'s meeting source was read on ${dayOf(board.meetings.observed_at)} and publishes no meetings, so when it last met in full session is not recorded here.`
      : boardRows.some((row) => classifyCommunityBoardConveningBody(row) === "unknown")
        ? `${board.board_name}'s meeting source was read on ${dayOf(board.meetings?.observed_at)} but its published meeting title does not identify a full board session, so when the board last met in full session is not recorded here.`
      : `${board.board_name}'s meeting source was read on ${dayOf(board.meetings?.observed_at)} and the meetings it publishes are committee and task-force meetings, not full board meetings, so when the board last met in full session is not recorded here.`,
  });
}
