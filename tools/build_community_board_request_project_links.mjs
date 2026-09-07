#!/usr/bin/env node

/**
 * Materialize the reviewed links between community board budget requests and
 * the capital projects the city publishes records for.
 *
 * Every input is committed: the retained budget register, the retained capital
 * observations, the capital history's record dates, and the agency crosswalk
 * this repository already carries. Nothing here contacts a publisher and
 * nothing reads a clock, so `--check` can prove the artifact is current from
 * the tree alone.
 *
 * The reviewed decisions live beside the projection in
 * `warehouse/lib/community_board_request_project_links.mjs`. This tool re-derives
 * the candidates and refuses to write an artifact whose reviews no longer match
 * the retained text.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildCommunityBoardRequestProjectLinks,
  validateCommunityBoardRequestProjectLinks,
} from "../warehouse/lib/community_board_request_project_links.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "site/data/community_board_request_project_links.json");
const REGISTER = "site/data/community_board_budget_register.json";
const DOCUMENTS = "site/data/community_board_budget_register";
const CAPITAL_PAYLOAD = "site/data/procurement_planning_payload";
const HISTORY = "site/data/procurement_project_history.json";
const CONTRACTS = "site/data/source_contracts.json";
const CROSSWALK = "worker/src/data/agency_crosswalk.json";
const AGENCIES = join(ROOT, "site/agencies");
const CAPITAL_CONTRACT_ID = "capital-projects-dashboard";

const readJson = (path) => JSON.parse(readFileSync(join(ROOT, path), "utf8"));

/**
 * The capital observations, read from the committed planning payload shards.
 *
 * Only the capital-project collection takes part: the plan rows in the same
 * payload are a different publisher's records and carry no project code.
 */
export function capitalObservationRows() {
  const rows = [];
  for (const name of readdirSync(join(ROOT, CAPITAL_PAYLOAD)).sort()) {
    if (!name.startsWith("capital-projects-") || !name.endsWith(".json")) continue;
    const shard = readJson(`${CAPITAL_PAYLOAD}/${name}`);
    if (shard?.collection !== "capital_projects") continue;
    for (const row of shard.rows || []) rows.push(row);
  }
  return rows;
}

/**
 * Which agency page, if any, each capital agency abbreviation addresses.
 *
 * The capital dashboard publishes an abbreviation ("DDC", "DOT"); the crosswalk
 * publishes the acronym the city uses, which sometimes carries a "NYC" prefix.
 * A resolution counts only when the resulting identity is a page this site
 * actually publishes, so a link is never built out of a string that happens to
 * look like a route.
 */
export function agencyRoutesForCapitalAgencies({ crosswalk, publishedAgencyIds }) {
  const routes = {};
  for (const [agencyId, entry] of Object.entries(crosswalk?.entries || {})) {
    if (!publishedAgencyIds.has(agencyId)) continue;
    const acronym = String(entry?.acronym || "").trim().toUpperCase();
    if (!acronym) continue;
    for (const candidate of new Set([acronym, acronym.replace(/^NYC\s+/, ""), acronym.replace(/\s+/g, "")])) {
      if (!/^[A-Z]{2,8}$/.test(candidate)) continue;
      // First published identity wins, and a second claimant is dropped rather
      // than overwriting: an ambiguous abbreviation gets no link at all.
      if (candidate in routes) {
        if (routes[candidate]?.agency_id !== agencyId) routes[candidate] = null;
        continue;
      }
      routes[candidate] = {
        agency_id: agencyId,
        href: `/agencies/${encodeURIComponent(agencyId)}/`,
        name: entry?.canonical_name ? String(entry.canonical_name) : null,
      };
    }
  }
  return Object.fromEntries(Object.entries(routes).filter(([, value]) => value));
}

export function publishedAgencyIds() {
  return new Set(
    readdirSync(AGENCIES, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(AGENCIES, entry.name, "relationships.json")))
      .map((entry) => entry.name),
  );
}

export function buildArtifact() {
  const register = readJson(REGISTER);
  const documents = (register.boards || []).map((entry) => readJson(`${DOCUMENTS}/${entry.board_id}.json`));
  const contracts = readJson(CONTRACTS);
  const capitalContract = (contracts.contracts || []).find((row) => row?.id === CAPITAL_CONTRACT_ID);
  if (!capitalContract) throw new Error(`no source contract ${CAPITAL_CONTRACT_ID} in ${CONTRACTS}`);
  const artifact = buildCommunityBoardRequestProjectLinks({
    register,
    documents,
    capitalRows: capitalObservationRows(),
    projectHistory: readJson(HISTORY),
    agencyRoutes: agencyRoutesForCapitalAgencies({
      crosswalk: readJson(CROSSWALK),
      publishedAgencyIds: publishedAgencyIds(),
    }),
    capitalSource: {
      source: "capital_projects_dashboard",
      source_contract_id: capitalContract.id,
      dataset_id: capitalContract.dataset_id,
      source_url: `${capitalContract.domain}/resource/${capitalContract.dataset_id}.json`,
      landing_url: capitalContract.landing_page,
    },
  });
  const problems = validateCommunityBoardRequestProjectLinks(artifact);
  if (problems.length) throw new Error(`materialization is not readable: ${problems.join(", ")}`);
  return artifact;
}

export function writeCommunityBoardRequestProjectLinks({ check = false } = {}) {
  const artifact = buildArtifact();
  const text = `${JSON.stringify(artifact, null, 2)}\n`;
  const summary = `${artifact.counts.relations} reviewed link(s) across ${artifact.counts.boards_with_a_relation} board(s), `
    + `${artifact.counts.reviewed_refusals} reviewed refusal(s), ${artifact.counts.candidates_pending_review} candidate(s) awaiting review`;
  const current = existsSync(OUT) && readFileSync(OUT, "utf8") === text;
  if (check) {
    if (!current) {
      throw new Error(`${relative(ROOT, OUT)} is stale; rebuild with node tools/build_community_board_request_project_links.mjs`);
    }
    console.log(`Request-to-project links are current (${summary})`);
    return artifact;
  }
  if (!current) writeFileSync(OUT, text);
  console.log(`Request-to-project links built (${summary})`);
  return artifact;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = new Set(process.argv.slice(2));
  for (const arg of args) {
    if (arg !== "--check") throw new Error("Usage: node tools/build_community_board_request_project_links.mjs [--check]");
  }
  writeCommunityBoardRequestProjectLinks({ check: args.has("--check") });
}
