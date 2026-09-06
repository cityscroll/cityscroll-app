#!/usr/bin/env node
/**
 * Write gitignored specimen pages for exact-institution follow capture.
 *
 *   node tools/render_exact_institution_follow_specimens.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildAgencyConstellationView,
  renderAgencyConstellationDocument,
} from "../site/agency_constellation.mjs";
import { communityBoardParticipationPaths } from "../site/community_board_participation.mjs";
import {
  gateNodePageRender,
  renderCivicDocumentAssets,
  renderCivicDocumentMast,
  renderNodeBack,
  renderNodeFooter,
} from "../site/civic_document_chrome.mjs";
import {
  buildFollowingViewModel,
  renderFollowingDocument,
} from "../site/following_view.mjs";
import { exactInstitutionFollow } from "../site/institution_follow_scope.mjs";
import { publisherAgencyRows } from "./lib/agency_publisher_crosswalk.mjs";
import agencyCrosswalk from "../worker/src/data/agency_crosswalk.json" with { type: "json" };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = join(ROOT, "site");
const ARTIFACTS = join(ROOT, ".artifacts/exact-institution-follow");

function write(root, rel, html) {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, html);
  return rel;
}

function agencyPage(id) {
  const rows = publisherAgencyRows(agencyCrosswalk);
  const view = buildAgencyConstellationView(id, { publisher_agency_rows: rows });
  if (!view) throw new Error(`no constellation view for ${id}`);
  return renderAgencyConstellationDocument(view, {
    publisherRow: agencyCrosswalk.entries?.[id] || null,
  });
}

function followingPage(id) {
  const exact = exactInstitutionFollow(id);
  if (exact.status !== "ok") throw new Error(`no exact follow for ${id}`);
  return renderFollowingDocument(buildFollowingViewModel({
    lens: exact.lens,
    filter: exact.filter,
    requested: true,
    frequency: "weekly",
  }));
}

function communityBoardPage() {
  const exact = exactInstitutionFollow("brooklyn-cb-15");
  const paths = communityBoardParticipationPaths({
    board_id: "brooklyn-cb-15",
    board: { body_id: "brooklyn-cb-15", homepage_url: "https://www.nyc.gov/site/brooklyncbs/cb15/index.page" },
  });
  const follow = paths.find((path) => path.kind === "follow_board");
  return gateNodePageRender(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Brooklyn Community Board 15 · CityScroll</title>
${renderCivicDocumentAssets("/")}</head>
<body>
<a class="skip" href="#main">Skip to content</a>
${renderCivicDocumentMast({ current: "browse", surfaceClass: "civic-object-mast" })}
<main id="main" class="node-document civic-object-document" data-civic-object-kind="community-board-constellation" data-subject-ref="community-board:brooklyn-cb-15">
${renderNodeBack({ href: "/agencies/", label: "Back to agencies", extraClass: "civic-object-back" })}
<header class="node-hero civic-object-hero">
  <p class="node-kicker civic-object-kicker">Community board</p>
  <h1>Brooklyn Community Board 15</h1>
  <p class="node-lede">A local advisory body. Follow uses this board’s exact identity.</p>
  <p><a class="node-action primary civic-object-action" href="${follow?.href || ""}">${exact.follow_label}</a></p>
</header>
</main>
${renderNodeFooter({ extraClass: "civic-object-footer" })}
</body></html>`);
}

function storedNameCorrectionPage() {
  return renderFollowingDocument(buildFollowingViewModel({
    lens: "entity",
    filter: { kind: "agency", name: "OFFICE OF RACIAL EQUITY" },
    requested: true,
    frequency: "weekly",
  }));
}

export function renderExactInstitutionFollowSpecimens() {
  const written = [];
  for (const id of [
    "office-of-racial-equity",
    "commission-on-racial-equity",
    "metropolitan-transportation-authority",
    "n-y-c-transit-authority",
  ]) {
    written.push(write(SITE, `agencies/${id}/index.html`, agencyPage(id)));
    written.push(write(ARTIFACTS, `following-exact-${id}.html`, followingPage(id)));
  }
  written.push(write(SITE, "community-boards/brooklyn-cb-15/index.html", communityBoardPage()));
  written.push(write(ARTIFACTS, "following-exact-brooklyn-cb-15.html", followingPage("brooklyn-cb-15")));
  written.push(write(ARTIFACTS, "following-stored-office-spelling.html", storedNameCorrectionPage()));
  return written;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const rel of renderExactInstitutionFollowSpecimens()) console.log("wrote", rel);
}
