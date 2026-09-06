#!/usr/bin/env node
/**
 * Materialize the public-body directory at site/agencies/index.html.
 *
 * The directory used to be the keys of the reviewed agency alias table. It is
 * now built from the destinations this repository actually publishes — the
 * agency constellation lookup and the community-board lookup — so a reader can
 * reach the profiles that exist rather than a list of interchangeable links.
 * Both lookups are committed artifacts, which keeps this document reproducible
 * from the tree and lets `--check` fail closed on drift.
 *
 *   node tools/build_agency_documents.mjs
 *   node tools/build_agency_documents.mjs --check
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildAgencyDirectoryModel,
  renderAgencyDirectoryDocument,
} from "../site/agency_directory.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = join(ROOT, "site/agencies/index.html");
const AGENCY_LOOKUP = join(ROOT, "site/data/agency_constellation_lookup.json");
const COMMUNITY_BOARD_LOOKUP = join(ROOT, "site/data/community_board_constellation_lookup.json");
const AGENCY_CROSSWALK = join(ROOT, "worker/src/data/agency_crosswalk.json");

function readLookup(path) {
  if (!existsSync(path)) {
    throw new Error(`Missing ${path.slice(ROOT.length + 1)}; build it before the directory`);
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

export function agencyDirectoryModel() {
  return buildAgencyDirectoryModel({
    agencies: readLookup(AGENCY_LOOKUP),
    communityBoards: readLookup(COMMUNITY_BOARD_LOOKUP),
    publisherCrosswalk: existsSync(AGENCY_CROSSWALK) ? readLookup(AGENCY_CROSSWALK) : null,
  });
}

export function renderAgencyIndex() {
  return renderAgencyDirectoryDocument(agencyDirectoryModel());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const check = process.argv.includes("--check");
  const model = agencyDirectoryModel();
  const content = renderAgencyDirectoryDocument(model);
  const current = existsSync(OUTPUT) ? readFileSync(OUTPUT, "utf8") : "";
  if (current !== content) {
    if (check) {
      console.error("Agency directory is stale; rebuild with node tools/build_agency_documents.mjs");
      process.exit(1);
    }
    mkdirSync(dirname(OUTPUT), { recursive: true });
    writeFileSync(OUTPUT, content);
    console.log("wrote", OUTPUT);
  }
  const state = check ? "current" : "built";
  console.log(
    `Agency directory is ${state} (${model.total} institutions, ${model.linked} linked, `
    + `${model.classified} with a reviewed type, ${model.sections.length} sections)`,
  );
}
