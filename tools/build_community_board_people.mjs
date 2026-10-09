#!/usr/bin/env node
/**
 * Reacquire the grounded Community Board people artifact from the official
 * Manhattan CB6 roster page and publish site/data/community_board_people.json.
 *
 *   node tools/build_community_board_people.mjs
 *   node tools/build_community_board_people.mjs --check
 *   node tools/build_community_board_people.mjs --input path/to/roster.html --observed-at ISO
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { COMMUNITY_BOARD_ACQUISITION_USER_AGENT } from "../site/community_board_source_adapters.mjs";
import {
  MANHATTAN_CB06_ROSTER_URL,
  buildCommunityBoardPeopleFromRosterCapture,
} from "../site/community_board_people_refresh.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "site/data/community_board_people.json");

function parseArgs(argv) {
  const args = {
    check: false,
    input: null,
    observedAt: null,
    sourceUrl: MANHATTAN_CB06_ROSTER_URL,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--check") args.check = true;
    else if (key === "--input") {
      args.input = argv[++i];
    } else if (key === "--observed-at") {
      args.observedAt = argv[++i];
    } else if (key === "--source-url") {
      args.sourceUrl = argv[++i];
    } else {
      throw new Error(`unexpected argument: ${key}`);
    }
  }
  return args;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function stableStringify(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

async function fetchRosterHtml(sourceUrl) {
  // determinism-lint: allow network first-class people refresh reacquires the official roster page
  const response = await fetch(sourceUrl, {
    headers: { "User-Agent": COMMUNITY_BOARD_ACQUISITION_USER_AGENT },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`roster fetch failed: ${response.status} ${sourceUrl}`);
  }
  return response.text();
}

function writeArtifact(artifact) {
  mkdirSync(dirname(OUT), { recursive: true });
  const temporary = `${OUT}.tmp`;
  // determinism-lint: allow write owning builder replaces the grounded people artifact after live reacquisition
  writeFileSync(temporary, stableStringify(artifact));
  renameSync(temporary, OUT);
}

function checkArtifact(artifact) {
  if (!existsSync(OUT)) {
    throw new Error("Missing site/data/community_board_people.json; rebuild first");
  }
  const existing = readJson(OUT);
  if (existing.schema !== artifact.schema) throw new Error("people schema mismatch");
  const leftBoards = Object.keys(existing.boards || {}).sort();
  const rightBoards = Object.keys(artifact.boards || {}).sort();
  if (JSON.stringify(leftBoards) !== JSON.stringify(rightBoards)) {
    throw new Error("people board set drift");
  }
  for (const boardId of leftBoards) {
    const left = (existing.boards[boardId]?.relationships || []).map((row) => [
      row.publisher_person_id, row.relation, row.role, row.committee_ref || null,
    ]);
    const right = (artifact.boards[boardId]?.relationships || []).map((row) => [
      row.publisher_person_id, row.relation, row.role, row.committee_ref || null,
    ]);
    if (JSON.stringify(left) !== JSON.stringify(right)) {
      throw new Error(`people relationship drift for ${boardId}`);
    }
  }
}

export async function materializeCommunityBoardPeople(args = {}) {
  const sourceUrl = args.sourceUrl || MANHATTAN_CB06_ROSTER_URL;
  const html = args.html != null
    ? String(args.html)
    : args.input
      ? readFileSync(resolve(args.input), "utf8")
      : await fetchRosterHtml(sourceUrl);
  // determinism-lint: allow clock observation timestamp comes from the acquisition instant or an explicit override
  const observedAt = args.observedAt || new Date().toISOString();
  return buildCommunityBoardPeopleFromRosterCapture({
    html,
    sourceUrl,
    observedAt,
    contentSha256: sha256Text(html),
  });
}

async function main(argv = process.argv) {
  const args = parseArgs(argv);
  const artifact = await materializeCommunityBoardPeople(args);
  if (args.check) {
    checkArtifact(artifact);
    console.log("community board people check ok");
    return;
  }
  writeArtifact(artifact);
  const board = Object.keys(artifact.boards)[0];
  console.log(`wrote ${OUT} observed_on=${artifact.observed_on} board=${board} relationships=${artifact.boards[board].relationships.length}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
