#!/usr/bin/env node

// Board-acquisition deployed parity read-back.
//
// Produces the one retained observation declared by the board-acquisition
// recovery work: all seven bounded community-board acquisition sources read
// through the deployed acquisition worker's real public surface —
// GET /health for the deployed revision and one GET /hearings browse per
// board for the acquired records — and written to
// docs/evidence/board-acquisition/deployed-parity-readback.json under schema
// cityscroll.board_acquisition_deployed_parity.v1.
//
// Like the live MCP canary, this tool never overrides fetch and never opens a
// fixture environment: the moment it could reach a local handler it would stop
// observing the deployment. Every status, count, and digest in the written
// observation is derived from the fetched responses by the contract module's
// builder and must re-validate against its own facts before the file is
// written.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  DEPLOYED_PARITY_BOARDS,
  buildBoardAcquisitionDeployedParityObservation,
  validateBoardAcquisitionDeployedParityObservation,
} from "./board_acquisition_deployed_parity.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT = resolve(ROOT, "docs/evidence/board-acquisition/deployed-parity-readback.json");
const TRACKED_INDEX_PATH = resolve(ROOT, "site/data/community_board_meeting_index.json");
const DEFAULT_BASE_URL = "https://api.cityscroll.org";
const USER_AGENT = "cityscroll-board-acquisition-deployed-parity/1.0";
const MAX_PAGES_PER_BOARD = 6;

function fail(message) {
  throw new Error(`board-acquisition deployed parity failed: ${message}`);
}

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

async function fetchHealth(baseUrl) {
  const response = await fetch(`${baseUrl}/health`, {
    headers: { "user-agent": USER_AGENT },
  });
  const body = await response.json().catch(() => null);
  return {
    response_status: response.status,
    commit: typeof body?.commit === "string" ? body.commit : null,
    environment: typeof body?.environment === "string" ? body.environment : null,
  };
}

/**
 * One board's browse through the public /hearings surface, following the
 * opaque cursor until the served window is exhausted (bounded by
 * MAX_PAGES_PER_BOARD so a pathological cursor loop can never run away).
 */
async function fetchBoardBrowse(baseUrl, boardId) {
  const pages = [];
  let cursor = null;
  let truncated = false;
  let communityBoardSourceStatus = null;
  let communityBoardGeneratedAt = null;
  while (pages.length < MAX_PAGES_PER_BOARD) {
    const url = new URL(`${baseUrl}/hearings`);
    url.searchParams.set("community_board", boardId);
    url.searchParams.set("source_system", "community_board");
    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await fetch(url, { headers: { "user-agent": USER_AGENT } });
    const body = await response.json().catch(() => null);
    if (response.status !== 200 || !body || typeof body !== "object") {
      pages.push({ availability: null, rows: null, response_status: response.status });
      return { pages, truncated, communityBoardSourceStatus, communityBoardGeneratedAt };
    }
    pages.push({
      availability: body.availability ?? null,
      rows: Array.isArray(body.results) ? body.results : null,
      total_matches: body.total_matches,
      response_status: response.status,
    });
    const communityBoard = body.coverage?.sources?.community_board || null;
    if (pages.length === 1) {
      communityBoardSourceStatus = communityBoard?.status ?? null;
      communityBoardGeneratedAt = communityBoard?.generated_at ?? null;
    }
    cursor = body.pagination?.next_cursor || null;
    if (!cursor) break;
  }
  if (cursor) truncated = true;
  return { pages, truncated, communityBoardSourceStatus, communityBoardGeneratedAt };
}

function loadTrackedBoards() {
  let index;
  try {
    index = JSON.parse(readFileSync(TRACKED_INDEX_PATH, "utf8"));
  } catch (error) {
    fail(`cannot read tracked index site/data/community_board_meeting_index.json (${error.message})`);
  }
  const boards = {};
  for (const entry of index.board_coverage || []) {
    if (!DEPLOYED_PARITY_BOARDS.includes(entry?.board_id)) continue;
    boards[entry.board_id] = {
      board_name: entry.board_name || null,
      state: entry.meetings?.state || null,
      record_count: entry.meetings?.record_count,
      source_url: entry.meetings?.source_url || null,
      observed_at: entry.meetings?.observed_at || null,
    };
  }
  return {
    generated_at: index.generated_at || null,
    code_revision: index.code_revision || null,
    boards,
  };
}

export async function runBoardAcquisitionDeployedParity({
  baseUrl = process.env.BOARD_PARITY_API_BASE || DEFAULT_BASE_URL,
  skipFetch = false,
} = {}) {
  const trackedIndex = loadTrackedBoards();
  for (const boardId of DEPLOYED_PARITY_BOARDS) {
    if (!trackedIndex.boards[boardId]) {
      fail(`tracked index has no meetings entry for ${boardId}; registered-source-url parity cannot be asserted`);
    }
  }

  // The ancestry proof is against the current remote default branch, so fetch
  // it first (pass --no-fetch to rely on an already-fetched ref).
  if (!skipFetch) git(["fetch", "origin", "main", "--quiet"]);
  const originMainTip = git(["rev-parse", "origin/main"]);

  const health = await fetchHealth(baseUrl);
  if (!health.commit) fail("deployed /health did not report a commit");
  let commitIsAncestor = false;
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", health.commit, "origin/main"], {
      cwd: ROOT,
      stdio: "ignore",
    });
    commitIsAncestor = true;
  } catch {
    commitIsAncestor = false;
  }

  const boardBrowses = {};
  for (const boardId of DEPLOYED_PARITY_BOARDS) {
    boardBrowses[boardId] = await fetchBoardBrowse(baseUrl, boardId);
  }

  return buildBoardAcquisitionDeployedParityObservation({
    health,
    boardBrowses,
    trackedIndex,
    observedAt: new Date().toISOString(),
    runId: randomUUID(),
    baseUrl,
    originMainTip,
    commitIsAncestorOfOriginMain: commitIsAncestor,
  });
}

function parseArgs(argv) {
  const args = { write: false, out: DEFAULT_OUT, skipFetch: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--write") args.write = true;
    else if (argv[i] === "--out") args.out = resolve(argv[++i] || "");
    else if (argv[i] === "--no-fetch") args.skipFetch = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return args;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const observation = await runBoardAcquisitionDeployedParity({ skipFetch: args.skipFetch });
    const verdict = validateBoardAcquisitionDeployedParityObservation(observation);
    if (!verdict.valid) {
      console.error(`observation did not re-validate against its own facts: ${verdict.errors.join(", ")}`);
      process.exitCode = 1;
    }
    const serialized = `${JSON.stringify(observation, null, 2)}\n`;
    if (args.write && verdict.valid) {
      mkdirSync(dirname(args.out), { recursive: true });
      writeFileSync(args.out, serialized, "utf8");
      process.stdout.write(`wrote deployed parity observation: ${args.out}\n`);
    } else if (!args.write) {
      process.stdout.write(serialized);
    }
    if (verdict.valid && observation.status !== "all_sources_recovered") {
      console.error(`deployed parity observation recorded honestly as ${observation.status} (${observation.counts.sources_recovered}/${observation.counts.sources_attempted} sources recovered); see per-source recovery_basis fields`);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(String(error?.message || error));
    process.exitCode = 1;
  }
}
