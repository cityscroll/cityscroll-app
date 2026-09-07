#!/usr/bin/env node

/**
 * Materialize the compact per-board list of land use projects recorded in each
 * Community Board's own district.
 *
 * One pass over the two committed inputs writes one artifact that every board
 * document reads, so no page fans out to the publisher and no two boards can
 * describe different populations. `--check` fails when the artifact is stale.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildCommunityBoardDistrictProjects } from "../warehouse/lib/community_board_district_projects.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GEOGRAPHY = join(ROOT, "site/data/community_board_geography_lookup.json");
const PROJECTS = join(ROOT, "site/data/zap_projects_warehouse_lookup.json");
const OUT = join(ROOT, "site/data/community_board_district_projects.json");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function buildArtifact() {
  const geography = readJson(GEOGRAPHY);
  const projects = readJson(PROJECTS);
  return buildCommunityBoardDistrictProjects({
    geography,
    projects,
    // The two inputs' own vintages are the only clock here. A wall clock would
    // make the artifact differ on every rebuild and defeat the --check gate.
    generatedAt: projects.materialized_at || null,
  });
}

export function writeCommunityBoardDistrictProjects({ check = false } = {}) {
  const artifact = buildArtifact();
  const json = `${JSON.stringify(artifact, null, 2)}\n`;
  const stale = !existsSync(OUT) || readFileSync(OUT, "utf8") !== json;
  if (check) {
    if (stale) throw new Error(`${relative(ROOT, OUT)} is stale; rebuild with node tools/build_community_board_district_projects.mjs`);
    console.log(`Community board district projects are current (${artifact.counts.boards_with_projects} boards, ${artifact.counts.board_project_rows} project rows)`);
    return artifact;
  }
  if (stale) {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, json);
  }
  console.log(`Community board district projects built (${artifact.counts.boards_with_projects} boards, ${artifact.counts.board_project_rows} project rows)`);
  return artifact;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = new Set(process.argv.slice(2));
  for (const arg of args) {
    if (arg !== "--check") throw new Error("Usage: node tools/build_community_board_district_projects.mjs [--check]");
  }
  writeCommunityBoardDistrictProjects({ check: args.has("--check") });
}
