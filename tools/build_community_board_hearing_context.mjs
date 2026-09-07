#!/usr/bin/env node

/**
 * Materialize the hearing preparation reading from the retained fixture.
 *
 * This reads only committed inputs — the frozen publisher observation, the
 * retained budget register, and the retained community board meeting index —
 * so the artifact is a pure function of the tree and `--check` can prove it is
 * current without contacting anyone.
 *
 * The clock is the acquisition's, never this process's. A rebuild that
 * acquired nothing must produce the same bytes, or the check gate would fail
 * on the calendar rather than on the data.
 *
 * The meeting the agenda belongs to has to already exist as a meeting this
 * site publishes. That is a fail-closed join: a hearing agenda attached to a
 * meeting identity no reader can open is a page that tells someone to show up
 * and then has nowhere to send them.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  HEARING_CONTEXT_SCHEMA,
  hearingClean,
} from "../warehouse/lib/community_board_hearing_context.mjs";
import { RECEIPT_PATH } from "./acquire_community_board_hearing_context.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(ROOT, "warehouse/fixtures/community-board-hearing-context");
const REGISTER = join(ROOT, "site/data/community_board_budget_register");
const MEETING_INDEX = join(ROOT, "site/data/community_board_meeting_index.json");
const OUT = join(ROOT, "site/data/community_board_hearing_context.json");

const serialize = (value) => `${JSON.stringify(value, null, 2)}\n`;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * The meeting this agenda belongs to, as this site already publishes it.
 *
 * The board's own meeting identity and its route are read from the retained
 * meeting index rather than composed from the source address here. Composing
 * one would produce a route that looks right and 404s the moment the index
 * spells an identity differently.
 */
export function meetingForSource({ boardId, sourceUrl, index }) {
  const edges = (index?.institution_edges || []).filter((edge) => (
    edge.edge_type === "hosts_meeting"
    && edge.from === `community-board:${boardId}`
    && edge.target_id?.endsWith(sourceUrl)
  ));
  if (edges.length !== 1) return null;
  const edge = edges[0];
  return {
    meeting_id: edge.target_id,
    href: edge.canonical_href || edge.href || null,
    title: hearingClean(edge.target_name, 300) || null,
    promoted: edge.promoted === true,
  };
}

/**
 * One board's reading, joined to the register requests the passages name.
 *
 * A passage or a disagreement whose tracking code is not in the retained
 * register is dropped rather than published: the surface it renders on lists
 * the requests from that same register, so a code with nothing behind it would
 * point a reader at a record the page cannot show them.
 */
export function buildBoard(observation, { registerDocument, meetingIndex }) {
  const boardId = observation.board_id;
  const codes = new Set((registerDocument?.requests || []).map((request) => request.tracking_code));
  const meeting = meetingForSource({ boardId, sourceUrl: observation.hearing.source_url, index: meetingIndex });
  if (!meeting) throw new Error(`no published meeting for ${boardId} at ${observation.hearing.source_url}`);
  if (!codes.has(observation.previous_cycle.worked_example_tracking_code)) {
    throw new Error(`the worked example ${observation.previous_cycle.worked_example_tracking_code} is not in ${boardId}'s retained register`);
  }

  const previous = observation.previous_cycle;
  const passages = previous.statement_passages.filter((passage) => codes.has(passage.tracking_code));
  const disagreements = previous.response_source_disagreements.filter((row) => codes.has(row.tracking_code));
  const documentsById = new Map(previous.documents.map((document) => [document.id, document]));

  return {
    board_id: boardId,
    board_name: observation.board_name,
    publisher: observation.publisher,
    observed_at: observation.observed_at,
    hearing: {
      ...meeting,
      meeting_date: observation.hearing.meeting_date,
      time_zone: observation.hearing.time_zone,
      source_url: observation.hearing.source_url,
      source_sha256: observation.hearing.receipt.content_sha256,
      segments: observation.hearing.segments,
      participation: observation.hearing.participation,
    },
    previous_cycle: {
      fiscal_year: previous.fiscal_year,
      worked_example_tracking_code: previous.worked_example_tracking_code,
      register_request_count: previous.register_request_count,
      documents: previous.documents.map((document) => ({
        id: document.id,
        kind: document.kind,
        title: document.title,
        fiscal_year: document.fiscal_year,
        source_url: document.source_url,
        ...(document.meeting_date ? { meeting_date: document.meeting_date } : {}),
        content_sha256: document.receipt.content_sha256,
        content_length: document.receipt.content_length,
        extraction: document.extraction,
      })),
      document_failures: previous.document_failures,
      statement_passages: passages,
      statement_passages_unattached_count: previous.statement_passages_unattached.length,
      responses_compared: previous.responses_compared,
      response_source_disagreements: disagreements.map((row) => ({
        ...row,
        board_document_title: documentsById.get(row.board_document_id)?.title || null,
        board_document_url: documentsById.get(row.board_document_id)?.source_url || null,
      })),
      ratified_resolution: previous.ratified_resolution
        ? {
          ...previous.ratified_resolution,
          document_title: documentsById.get(previous.ratified_resolution.document_id)?.title || null,
          document_url: documentsById.get(previous.ratified_resolution.document_id)?.source_url || null,
          meeting_date: documentsById.get(previous.ratified_resolution.document_id)?.meeting_date || null,
        }
        : null,
    },
  };
}

export function buildArtifact({ root = ROOT } = {}) {
  const receiptPath = RECEIPT_PATH;
  const receipt = existsSync(receiptPath) ? readJson(receiptPath) : null;
  if (receipt?.status !== "succeeded") {
    throw new Error("the last hearing context acquisition did not succeed; the retained materialization stands until one does");
  }
  const manifest = readJson(join(FIXTURES, "manifest.json"));
  const meetingIndex = readJson(MEETING_INDEX);
  const boards = manifest.boards.map((entry) => {
    const text = readFileSync(join(FIXTURES, entry.fixture), "utf8");
    if (sha256(text) !== entry.sha256) {
      throw new Error(`retained fixture ${entry.fixture} does not match the hash its manifest records`);
    }
    const registerPath = join(REGISTER, `${entry.board_id}.json`);
    return buildBoard(JSON.parse(text), {
      registerDocument: existsSync(registerPath) ? readJson(registerPath) : null,
      meetingIndex,
    });
  });
  return {
    schema: HEARING_CONTEXT_SCHEMA,
    method: "published_agenda_with_previous_cycle_context_v1",
    negative_rule: "A previous-cycle request and its published answer are the record of an earlier fiscal year. Neither is an item on the coming agenda, a commitment that the board will raise it again, funding, or delivery. A document retained here without usable extracted text has not been read, and a recorded vote to send a letter is not evidence of what the letter says.",
    observed_at: manifest.observed_at,
    boards,
  };
}

export function writeCommunityBoardHearingContext({ check = false } = {}) {
  const artifact = buildArtifact();
  const text = serialize(artifact);
  const summary = artifact.boards
    .map((board) => `${board.board_id}: ${board.hearing.segments.length} segment(s), ${board.previous_cycle.documents.length} document(s)`)
    .join("; ");

  if (check) {
    if (!existsSync(OUT) || readFileSync(OUT, "utf8") !== text) {
      throw new Error(`${relative(ROOT, OUT)} is stale; rebuild with node tools/build_community_board_hearing_context.mjs`);
    }
    console.log(`Community board hearing context is current (${summary})`);
    return artifact;
  }
  writeFileSync(OUT, text);
  console.log(`Community board hearing context built (${summary})`);
  return artifact;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = new Set(process.argv.slice(2));
  for (const arg of args) {
    if (arg !== "--check") throw new Error("Usage: node tools/build_community_board_hearing_context.mjs [--check]");
  }
  writeCommunityBoardHearingContext({ check: args.has("--check") });
}
