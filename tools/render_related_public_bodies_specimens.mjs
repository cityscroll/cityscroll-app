#!/usr/bin/env node
/**
 * Write the gitignored specimen pages the related-public-bodies capture drives.
 *
 *   node tools/render_related_public_bodies_specimens.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildAgencyConstellationView,
  renderAgencyConstellationDocument,
} from "../site/agency_constellation.mjs";
import {
  renderBoroughBoardDocument,
  renderRelatedPublicBodiesFor,
} from "../site/civic_institution_related_bodies.mjs";
import {
  gateNodePageRender,
  renderCivicDocumentAssets,
  renderCivicDocumentMast,
  renderNodeBack,
  renderNodeFooter,
} from "../site/civic_document_chrome.mjs";
import { publisherAgencyRows } from "./lib/agency_publisher_crosswalk.mjs";
import agencyCrosswalk from "../worker/src/data/agency_crosswalk.json" with { type: "json" };
import { REVIEWED_BOROUGH_BOARDS } from "../site/borough_board_identity.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = join(ROOT, "site");

function write(rel, html) {
  const path = join(SITE, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, html);
  console.log("wrote", rel);
}

function agencyPage(id) {
  const rows = publisherAgencyRows(agencyCrosswalk);
  const view = buildAgencyConstellationView(id, { publisher_agency_rows: rows });
  if (!view) throw new Error(`no constellation view for ${id}`);
  return renderAgencyConstellationDocument(view, {
    publisherRow: agencyCrosswalk.entries?.[id] || null,
  });
}

function communityBoardSpecimen() {
  const related = renderRelatedPublicBodiesFor("brooklyn-cb-15");
  return gateNodePageRender(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Brooklyn Community Board 15 · CityScroll</title>
${renderCivicDocumentAssets("/")}</head>
<body>
<a class="skip" href="#main">Skip to content</a>
${renderCivicDocumentMast({ current: "browse", surfaceClass: "civic-object-mast" })}
<main id="main" class="node-document civic-object-document" data-civic-object-kind="community-board-constellation" data-subject-ref="community-board:brooklyn-cb-15" data-node-document="1">
${renderNodeBack({ href: "/agencies/", label: "Back to agencies", extraClass: "civic-object-back" })}
<header class="node-hero civic-object-hero">
  <p class="node-kicker civic-object-kicker">Community board</p>
  <h1>Brooklyn Community Board 15</h1>
  <p class="node-lede">A local advisory body, distinct from the borough president's office, the borough board, and the district it covers.</p>
</header>
${related}
</main>
${renderNodeFooter({ extraClass: "civic-object-footer" })}
</body></html>`);
}

export function renderRelatedPublicBodiesSpecimens() {
  for (const id of [
    "city-planning",
    "city-planning-commission",
    "metropolitan-transportation-authority",
    "n-y-c-transit-authority",
    "borough-president-brooklyn",
  ]) {
    write(`agencies/${id}/index.html`, agencyPage(id));
  }
  for (const board of REVIEWED_BOROUGH_BOARDS) {
    write(`agencies/${board.borough_slug}-borough-board/index.html`, renderBoroughBoardDocument(board));
  }
  write("community-boards/brooklyn-cb-15/index.html", communityBoardSpecimen());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  renderRelatedPublicBodiesSpecimens();
}
