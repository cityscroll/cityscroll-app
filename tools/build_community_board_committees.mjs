#!/usr/bin/env node
/**
 * Reacquire the reviewed Community Board committee registry from official
 * committee directory pages and publish
 * site/data/non_council_outcome_sources/community_board_committees.json.
 *
 *   node tools/build_community_board_committees.mjs
 *   node tools/build_community_board_committees.mjs --check
 *   node tools/build_community_board_committees.mjs --input-dir path/to/captures --observed-at ISO
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { COMMUNITY_BOARD_ACQUISITION_USER_AGENT } from "../site/community_board_source_adapters.mjs";
import {
  DEFAULT_COMMITTEE_SOURCE_URLS,
  buildCommunityBoardCommitteesFromCaptures,
} from "../site/community_board_committees_refresh.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "site/data/non_council_outcome_sources/community_board_committees.json");

function parseArgs(argv) {
  const args = {
    check: false,
    inputDir: null,
    observedAt: null,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--check") args.check = true;
    else if (key === "--input-dir") {
      args.inputDir = argv[++i];
    } else if (key === "--observed-at") {
      args.observedAt = argv[++i];
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

async function fetchHtml(sourceUrl) {
  // determinism-lint: allow network first-class committee refresh reacquires official directory pages
  const response = await fetch(sourceUrl, {
    headers: { "User-Agent": COMMUNITY_BOARD_ACQUISITION_USER_AGENT },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`committee directory fetch failed: ${response.status} ${sourceUrl}`);
  }
  return response.text();
}

async function loadCaptures(args, prior) {
  const boardIds = [...new Set((prior.committees || []).map((row) => row.board_id))];
  const captures = {};
  if (args.inputDir) {
    const root = resolve(args.inputDir);
    for (const boardId of boardIds) {
      const path = join(root, `${boardId}.html`);
      if (!existsSync(path)) {
        throw new Error(`missing capture for ${boardId}: ${path}`);
      }
      captures[boardId] = readFileSync(path, "utf8");
    }
    return captures;
  }
  for (const boardId of boardIds) {
    const sourceUrl = DEFAULT_COMMITTEE_SOURCE_URLS[boardId];
    if (!sourceUrl) {
      throw new Error(`no official committee directory URL registered for ${boardId}`);
    }
    captures[boardId] = await fetchHtml(sourceUrl);
  }
  return captures;
}

function writeArtifact(artifact) {
  mkdirSync(dirname(OUT), { recursive: true });
  const temporary = `${OUT}.tmp`;
  // determinism-lint: allow write owning builder replaces the reviewed committee registry after live reacquisition
  writeFileSync(temporary, stableStringify(artifact));
  renameSync(temporary, OUT);
}

function checkArtifact(artifact) {
  if (!existsSync(OUT)) {
    throw new Error("Missing community_board_committees.json; rebuild first");
  }
  const existing = readJson(OUT);
  if (existing.schema !== artifact.schema) throw new Error("committee schema mismatch");
  const left = (existing.committees || []).map((row) => [row.board_id, row.committee_id, row.publisher_name]);
  const right = (artifact.committees || []).map((row) => [row.board_id, row.committee_id, row.publisher_name]);
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error("committee identity drift");
  }
}

export async function materializeCommunityBoardCommittees(args = {}) {
  if (!existsSync(OUT) && !args.priorRegistry) {
    throw new Error(`missing prior committee registry at ${OUT}`);
  }
  const prior = args.priorRegistry || readJson(OUT);
  const capturesByBoard = args.capturesByBoard || await loadCaptures(args, prior);
  // determinism-lint: allow clock observation timestamp comes from the acquisition instant or an explicit override
  const observedAt = args.observedAt || new Date().toISOString();
  return buildCommunityBoardCommitteesFromCaptures({
    priorRegistry: prior,
    capturesByBoard,
    observedAt,
    sourceUrls: DEFAULT_COMMITTEE_SOURCE_URLS,
  });
}

async function main(argv = process.argv) {
  const args = parseArgs(argv);
  const artifact = await materializeCommunityBoardCommittees(args);
  if (args.check) {
    checkArtifact(artifact);
    console.log("community board committees check ok");
    return;
  }
  writeArtifact(artifact);
  console.log(`wrote ${OUT} observed_on=${artifact.observed_on} committees=${artifact.committees.length}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
