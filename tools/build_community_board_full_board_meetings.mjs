#!/usr/bin/env node

/**
 * Materialize one answer per community board to the ordinary question "when
 * did this board last meet in full session?".
 *
 * The meetings read model already holds every board meeting the corpus has
 * observed. It cannot, on its own, tell a reader apart from a search that
 * returned nothing: the newest row for a board is usually a committee, and an
 * empty result set looks the same whether the board is uncovered, its source
 * could not be read, or it simply has not met. This artifact resolves that once
 * at build time so every public read is a materialization rather than a query.
 *
 *   node tools/build_community_board_full_board_meetings.mjs
 *   node tools/build_community_board_full_board_meetings.mjs --check
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  COMMUNITY_BOARD_FULL_BOARD_ANSWER_STATES,
  communityBoardFullBoardMeetingAnswer,
} from "../site/community_board_full_board_lens.mjs";

const ROOT = join(import.meta.dirname, "..");
const READ_MODEL = join(ROOT, "site/data/shared_meeting_read_model.json");
const OUTPUT = join(ROOT, "site/data/community_board_full_board_meetings.json");
export const COMMUNITY_BOARD_FULL_BOARD_MEETINGS_SCHEMA = "cityscroll.community_board_full_board_meetings.v1";

function readJson(path) { return JSON.parse(readFileSync(path, "utf8")); }

export function buildCommunityBoardFullBoardMeetings(readModel) {
  const coverage = readModel?.sources?.community_board?.board_coverage || [];
  // The read model's own checked-at instant is the clock. Using it rather than
  // a wall clock keeps this artifact a pure function of its input.
  const asOf = readModel?.freshness?.checked_at || readModel?.generated_at || null;
  const boards = coverage.map((row) => communityBoardFullBoardMeetingAnswer({
    readModel,
    query: row.board_id,
    asOf,
  }));
  const counts = Object.fromEntries(COMMUNITY_BOARD_FULL_BOARD_ANSWER_STATES
    .map((state) => [state, boards.filter((board) => board.status === state).length]));
  return {
    schema: COMMUNITY_BOARD_FULL_BOARD_MEETINGS_SCHEMA,
    generated_at: readModel?.generated_at || null,
    as_of: String(asOf || "").slice(0, 10) || null,
    observed_through: asOf,
    source: {
      read_model: "site/data/shared_meeting_read_model.json",
      read_model_schema: readModel?.schema || null,
      community_board_source_status: readModel?.sources?.community_board?.status || null,
      community_board_observed_at: readModel?.sources?.community_board?.generated_at || null,
    },
    policy: {
      convening_body_basis: "the convening body comes from the publisher's own meeting title and any committee the meeting is joined to",
      substitution: "a committee, subcommittee or task-force meeting is never returned in place of a full board meeting, and no board's meeting is ever returned for another board",
      absence: "an uncovered board, an unreadable source and a board that has not met each keep their own state and reason; none of them becomes an empty record or a zero",
      answer_states: COMMUNITY_BOARD_FULL_BOARD_ANSWER_STATES,
    },
    counts: { boards: boards.length, ...counts },
    boards,
  };
}

function currentDocument() {
  return `${JSON.stringify(buildCommunityBoardFullBoardMeetings(readJson(READ_MODEL)), null, 2)}\n`;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const document = currentDocument();
  if (process.argv.includes("--check")) {
    if (!existsSync(OUTPUT)) throw new Error("community board full board meeting answers are missing");
    if (readFileSync(OUTPUT, "utf8") !== document) {
      throw new Error("community board full board meeting answers are stale; rerun tools/build_community_board_full_board_meetings.mjs");
    }
    const parsed = JSON.parse(document);
    console.log(`checked ${parsed.counts.boards} community board answers (${parsed.counts.full_board_meeting} dated)`);
  } else {
    writeFileSync(OUTPUT, document);
    const parsed = JSON.parse(document);
    console.log(`wrote ${parsed.counts.boards} community board answers (${parsed.counts.full_board_meeting} dated)`);
  }
}
