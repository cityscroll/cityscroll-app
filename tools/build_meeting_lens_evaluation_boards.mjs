#!/usr/bin/env node

/**
 * Derive the community boards the live evaluation runs actually asked about.
 *
 * The coverage work behind the meetings lens answers a question that was put
 * to the deployed machine-facing interface, not a board picked here. The board
 * names therefore come out of the evaluation receipts rather than being typed
 * into a test, so a later change to the evaluation set moves the fixture and
 * the test with it instead of leaving a stale name behind.
 *
 * The receipts are operational records kept outside this repository. This tool
 * reads a directory of them, keeps only the neutral facts a public fixture
 * needs, and writes the fixture the committed test reads:
 *
 *   node tools/build_meeting_lens_evaluation_boards.mjs --receipts <dir>
 *   node tools/build_meeting_lens_evaluation_boards.mjs --check
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
export const MEETING_LENS_EVALUATION_BOARDS_FIXTURE = join(
  ROOT,
  "test/fixtures/meeting-lens/evaluation_boards.json",
);
export const MEETING_LENS_EVALUATION_BOARDS_SCHEMA = "cityscroll.meeting_lens_evaluation_boards.v1";
const RECEIPT_SCHEMA = "cityscroll.live_evaluation_run_receipt.v1";
const MEETING_TASK_FAMILY = "meetings";
const BOARD_MENTION = /\b(Bronx|Brooklyn|Manhattan|Queens|Staten Island)\s+Community Board\s+(\d{1,2})\b/;

function readJson(path) { return JSON.parse(readFileSync(path, "utf8")); }

/**
 * The board a meetings task asked about is the one its answer names first.
 * Later names in the same answer are the near matches the run rejected, so
 * only the first mention is taken.
 */
export function boardNamedByEvaluationTask(task = {}) {
  const passages = [
    String(task.sanitized_output || ""),
    ...(Array.isArray(task.rubric_result?.asserted_facts)
      ? task.rubric_result.asserted_facts.map((fact) => String(fact?.claim || ""))
      : []),
  ];
  for (const passage of passages) {
    const match = passage.match(BOARD_MENTION);
    if (match) return { name: `${match[1]} Community Board ${Number(match[2])}`, borough: match[1], district: Number(match[2]) };
  }
  return null;
}

export function buildMeetingLensEvaluationBoards(receipts, { derivedOn }) {
  const runs = [];
  const boards = new Map();
  for (const receipt of receipts) {
    for (const task of receipt.tasks || []) {
      if (task.family !== MEETING_TASK_FAMILY) continue;
      const board = boardNamedByEvaluationTask(task);
      runs.push({
        run_generated_at: receipt.generated_at || null,
        task_family: task.family,
        outcome: task.outcome || null,
        board_named: board?.name || null,
      });
      if (board && !boards.has(board.name)) boards.set(board.name, board);
    }
  }
  runs.sort((left, right) => String(left.run_generated_at).localeCompare(String(right.run_generated_at)));
  return {
    schema: MEETING_LENS_EVALUATION_BOARDS_SCHEMA,
    derived_on: derivedOn,
    derived_from: {
      source: "live evaluation runs of the deployed machine-facing research interface",
      receipt_schema: RECEIPT_SCHEMA,
      task_family: MEETING_TASK_FAMILY,
      derivation: "the first community board named in each meetings task's answer, then its rubric claims",
      run_count: receipts.length,
    },
    question: "the board's most recent full board meeting, its date, and its minutes",
    runs,
    boards: [...boards.values()].sort((left, right) => left.name.localeCompare(right.name)),
  };
}

function receiptsFrom(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => readJson(join(directory, entry.name)))
    .filter((receipt) => receipt?.schema === RECEIPT_SCHEMA);
}

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : null;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes("--check")) {
    if (!existsSync(MEETING_LENS_EVALUATION_BOARDS_FIXTURE)) throw new Error("evaluation board fixture is missing");
    const fixture = readJson(MEETING_LENS_EVALUATION_BOARDS_FIXTURE);
    if (fixture.schema !== MEETING_LENS_EVALUATION_BOARDS_SCHEMA) throw new Error("evaluation board fixture has an unexpected schema");
    if (!fixture.boards?.length) throw new Error("evaluation board fixture names no board");
    console.log(`checked ${fixture.boards.length} evaluated boards across ${fixture.runs.length} runs`);
  } else {
    const directory = argValue("--receipts");
    if (!directory) throw new Error("name the evaluation receipt directory with --receipts <dir>");
    const fixture = buildMeetingLensEvaluationBoards(receiptsFrom(directory), {
      derivedOn: argValue("--derived-on") || new Date().toISOString().slice(0, 10),
    });
    writeFileSync(MEETING_LENS_EVALUATION_BOARDS_FIXTURE, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`wrote ${fixture.boards.length} evaluated boards from ${fixture.runs.length} runs`);
  }
}
