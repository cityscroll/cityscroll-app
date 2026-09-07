#!/usr/bin/env node

/**
 * Materialize the per-board index of land use positions each Community Board
 * has recorded.
 *
 * One pass over the two committed retained inputs writes one artifact that
 * every board document reads, so no board page reaches the publisher and no two
 * boards can describe different populations. `--check` fails when the artifact
 * is stale.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildCommunityBoardLandPositions } from "../warehouse/lib/community_board_land_positions.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const AUTHORITY = join(ROOT, "site/data/land_authority_summary.json");
const PROJECTS = join(ROOT, "site/data/land_default_ulurp.json");
const OUT = join(ROOT, "site/data/community_board_land_positions.json");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function buildArtifact() {
  const authority = readJson(AUTHORITY);
  const projects = readJson(PROJECTS);
  return buildCommunityBoardLandPositions({
    authority,
    projects,
    // The retained inputs' own vintage is the only clock here. A wall clock
    // would make the artifact differ on every rebuild and defeat `--check`.
    generatedAt: authority.generated_at || projects.generated_at || null,
  });
}

export function writeCommunityBoardLandPositions({ check = false } = {}) {
  const artifact = buildArtifact();
  const json = `${JSON.stringify(artifact, null, 2)}\n`;
  const stale = !existsSync(OUT) || readFileSync(OUT, "utf8") !== json;
  const summary = `${artifact.counts.boards_with_positions} boards, `
    + `${artifact.counts.board_positions} recorded positions, `
    + `${artifact.counts.projects_with_board_positions} projects`;
  if (check) {
    if (stale) throw new Error(`${relative(ROOT, OUT)} is stale; rebuild with node tools/build_community_board_land_positions.mjs`);
    console.log(`Community board land positions are current (${summary})`);
    return artifact;
  }
  if (stale) {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, json);
  }
  console.log(`Community board land positions built (${summary})`);
  return artifact;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = new Set(process.argv.slice(2));
  for (const arg of args) {
    if (arg !== "--check") throw new Error("Usage: node tools/build_community_board_land_positions.mjs [--check]");
  }
  writeCommunityBoardLandPositions({ check: args.has("--check") });
}
