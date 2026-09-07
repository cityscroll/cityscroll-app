#!/usr/bin/env node

/**
 * Materialize the community board budget request register from the retained
 * publication fixtures.
 *
 * This reads only committed inputs — the frozen publications, the board
 * registry, and the agency identities this repository already carries — so the
 * artifact is a pure function of the tree and `--check` can prove it is
 * current without contacting anyone.
 *
 * The clock is the acquisition receipt's, not this process's. A rebuild that
 * changed nothing must produce the same bytes, or the check gate would fail on
 * the calendar rather than on the data.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildCommunityBoardBudgetRegister,
  shardCommunityBoardBudgetRegister,
  validateCommunityBoardBudgetRegister,
} from "../warehouse/lib/community_board_budget_register.mjs";
import {
  MANIFEST_PATH,
  RECEIPT_PATH,
  readFixture,
  readManifest,
} from "./acquire_community_board_budget_register.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BOARDS = join(ROOT, "site/data/community_board_participation.json");
const AGENCIES = join(ROOT, "site/agencies");
const OUT = join(ROOT, "site/data/community_board_budget_register.json");
const DOCUMENTS = join(ROOT, "site/data/community_board_budget_register");
const DOCUMENT_ROUTE = "/data/community_board_budget_register";

/**
 * The day the register is read as of: the day the publisher was actually read.
 *
 * This is stamped by the acquisition rather than taken from this process, for
 * two reasons. A rebuild that acquired nothing must produce the same bytes, so
 * the builder cannot consult a wall clock. And the honest meaning of "latest"
 * is latest as of when someone looked, which is exactly what the acquisition
 * receipt records. The publisher's forward-dated release falls out of the
 * servable set on every machine for the same reason and on the same day.
 */
export function evaluationDay(receipt) {
  const observed = String(receipt?.observed_at || "");
  return /^\d{4}-\d{2}-\d{2}/.test(observed) ? observed.slice(0, 10) : null;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * The agency identities this repository carries.
 *
 * A route directory is read by its tracked relationships file, never by its
 * generated `index.html`, so the set does not change depending on whether a
 * build has run in the working copy.
 */
export function knownAgencyIds({ root = ROOT } = {}) {
  return readdirSync(AGENCIES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(AGENCIES, entry.name, "relationships.json")))
    .map((entry) => entry.name)
    .sort();
}

export function buildArtifact() {
  const manifest = readManifest();
  if (!manifest) throw new Error(`no fixture manifest at ${relative(ROOT, MANIFEST_PATH)}; run tools/acquire_community_board_budget_register.mjs`);
  const receipt = existsSync(RECEIPT_PATH) ? readJson(RECEIPT_PATH) : null;
  if (receipt?.status !== "succeeded") {
    throw new Error("the last register acquisition did not succeed; the retained materialization stands until one does");
  }
  const boards = readJson(BOARDS);
  const publications = manifest.publications.map((entry) => {
    const rows = readFixture(entry.publication);
    if (!rows) throw new Error(`publication ${entry.publication} is named by the manifest but has no retained fixture`);
    if (rows.length !== entry.rows) throw new Error(`publication ${entry.publication} holds ${rows.length} rows, manifest says ${entry.rows}`);
    return {
      publication: entry.publication,
      rows,
      lineage: {
        fixture: `warehouse/fixtures/community-board-budget-register/publication-${entry.publication}.jsonl`,
        sha256: entry.sha256,
        published_row_count: entry.published_row_count,
      },
    };
  });
  return buildCommunityBoardBudgetRegister({
    publications,
    boardIds: Object.keys(boards.by_board || {}),
    agencyIds: knownAgencyIds(),
    asOf: evaluationDay(receipt),
    acquiredAt: receipt.observed_at,
    datasetId: manifest.dataset_id,
  });
}

const serialize = (value) => `${JSON.stringify(value, null, 2)}\n`;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/**
 * The header and the 59 board documents this artifact is published as.
 *
 * The header holds the acquisition clock, the counts and the agency bindings;
 * each board document holds only that board's requests and carries no clock, so
 * a refresh that finds no new publication rewrites none of them.
 */
export function buildDocuments() {
  const artifact = buildArtifact();
  const validation = validateCommunityBoardBudgetRegister(artifact);
  if (!validation.ok) throw new Error(validation.errors.join("; "));
  return shardCommunityBoardBudgetRegister(artifact, {
    documentPath: (boardId) => `${DOCUMENT_ROUTE}/${boardId}.json`,
    digest: (document) => sha256(serialize(document)),
  });
}

function documentPath(boardId) {
  return join(DOCUMENTS, `${boardId}.json`);
}

export function writeCommunityBoardBudgetRegister({ check = false } = {}) {
  const { index, documents } = buildDocuments();
  const expected = new Map([
    [OUT, serialize(index)],
    ...[...documents.entries()].map(([boardId, document]) => [documentPath(boardId), serialize(document)]),
  ]);
  const existing = existsSync(DOCUMENTS)
    ? readdirSync(DOCUMENTS).filter((name) => name.endsWith(".json")).map((name) => join(DOCUMENTS, name))
    : [];
  const orphans = existing.filter((path) => !expected.has(path));
  const stale = [...expected.entries()].filter(([path, text]) => !existsSync(path) || readFileSync(path, "utf8") !== text);
  const summary = `${index.counts.requests} requests, ${index.boards.length} boards, ${index.counts.responses_differing_in_source_text} changed responses`;

  if (check) {
    if (stale.length || orphans.length) {
      const paths = [...stale.map(([path]) => path), ...orphans].map((path) => relative(ROOT, path)).sort();
      throw new Error(`${paths.length} register document(s) are stale: ${paths.slice(0, 4).join(", ")}${paths.length > 4 ? ", ..." : ""}; rebuild with node tools/build_community_board_budget_register.mjs`);
    }
    console.log(`Community board budget register is current (${summary})`);
    return index;
  }

  mkdirSync(DOCUMENTS, { recursive: true });
  for (const [path, text] of stale) writeFileSync(path, text);
  // A board that stops appearing in the register loses its document rather
  // than leaving a stale one behind for a reader to find.
  for (const path of orphans) rmSync(path);
  console.log(`Community board budget register built (${summary}, ${stale.length} document(s) rewritten)`);
  return index;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = new Set(process.argv.slice(2));
  for (const arg of args) {
    if (arg !== "--check") throw new Error("Usage: node tools/build_community_board_budget_register.mjs [--check]");
  }
  writeCommunityBoardBudgetRegister({ check: args.has("--check") });
}
