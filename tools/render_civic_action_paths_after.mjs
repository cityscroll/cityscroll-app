#!/usr/bin/env node
/**
 * Render static after-state pages for Civic Action Path evidence captures.
 *
 * Meeting, board, and DOT outcome HTML is produced from committed read models.
 * No request-time publisher fetch is used.
 */

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildCommunityBoardConstellationView,
  renderCommunityBoardConstellationDocument,
} from "../site/community_board_constellation.mjs";
import { renderCivicDocumentAssets } from "../site/civic_document_chrome.mjs";
import {
  projectCivicOutcomeTransition,
  projectRulemakingOutcomeSnapshot,
  renderCivicOutcomeTransition,
} from "../site/civic_outcome_transition.mjs";
import { renderMeetingOutcomesFirstPaint } from "../site/meeting_outcomes_static.mjs";
import { renderMeetingDocument } from "../site/meeting_document.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = process.argv[2];
if (!out) {
  throw new Error("usage: node tools/render_civic_action_paths_after.mjs <outdir>");
}

const read = (rel) => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
const meetings = read("site/data/shared_meeting_read_model.json");
const sources = {
  sourceRegistry: read("site/data/non_council_outcome_sources/source_registry.json"),
  sourceInventory: read("site/data/non_council_outcome_sources/board_source_inventory.json"),
  scorecard: read("site/data/community_board_minutes_scorecard.json"),
  geography: read("site/data/community_board_geography_lookup.json"),
  communityBoardParticipation: read("site/data/community_board_participation.json"),
};

function meetingRow(requestId) {
  const rows = (meetings.rows || []).filter((candidate) => candidate?.request_id === requestId);
  const row = rows.find((candidate) => candidate?.meeting_outcome) || rows[0];
  if (!row) throw new Error(`missing meeting row ${requestId}`);
  return row;
}

function write(rel, html) {
  const dest = join(out, rel);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, html);
}

const MEETINGS = {
  "strict-matter": "20260707022",
  "multi-matter": "20260707021",
  unmatched: "20260728026",
};

for (const [slug, requestId] of Object.entries(MEETINGS)) {
  const row = meetingRow(requestId);
  let html = renderMeetingDocument(row, meetings);
  if (slug === "strict-matter" && row.meeting_outcome) {
    const outcomes = renderMeetingOutcomesFirstPaint(row.meeting_outcome, requestId);
    html = html.replace("</main>", `${outcomes}</main>`);
  }
  write(`meetings/${slug}/index.html`, html);
}

const positive = buildCommunityBoardConstellationView("manhattan-cb-02", {
  ...sources,
  institutionEdges: {
    "manhattan-cb-02": [{
      relation: "hosts_meeting",
      edge_type: "hosts_meeting",
      status: "promoted",
      promoted: true,
      from: "community-board:manhattan-cb-02",
      to: "meeting:community_board:cb2-full-board",
      target_kind: "meeting",
      target_id: "meeting:community_board:cb2-full-board",
      target_name: "Manhattan CB2 Full Board",
      href: "/meetings/meeting%3Acommunity_board%3Acb2-full-board",
      canonical_href: "/meetings/meeting%3Acommunity_board%3Acb2-full-board",
      join: { matched: true, event_date: "2026-09-10" },
      source_receipt: { status: "ok", observed_at: "2026-08-27T00:00:00Z" },
      provenance: { source_url: "https://cbmanhattan.cityofnewyork.us/cb2/calendar/" },
    }],
  },
});
const negative = buildCommunityBoardConstellationView("bronx-cb-02", sources);
write(
  "community-boards/manhattan-cb-02/index.html",
  renderCommunityBoardConstellationDocument(positive, { assetPrefix: "/" }),
);
write(
  "community-boards/bronx-cb-02/index.html",
  renderCommunityBoardConstellationDocument(negative, { assetPrefix: "/" }),
);

const SUBJECT = "rulemaking:dot:bicycle-owned-racks";
const RULE_URL = "https://rules.cityofnewyork.us/rule/city-owned-bicycle-racks/";
function dotSnapshot(asOf) {
  const events = [
    { event_type: "proposal_published", valid_at: "2026-03-25", status: "occurred", source_url: RULE_URL },
    { event_type: "public_hearing", valid_at: "2026-04-24", status: "occurred", source_url: RULE_URL },
    { event_type: "adoption", valid_at: "2026-07-14", status: "occurred", source_url: RULE_URL },
    { event_type: "effective", valid_at: "2026-08-13", status: "occurred", source_url: RULE_URL },
  ];
  return {
    rulemaking_subject_ref: SUBJECT,
    request_id: asOf < "2026-07-14" ? "20260317026" : "20260706041",
    stage: asOf < "2026-07-14" ? "hearing" : asOf < "2026-08-13" ? "adopted" : "effective",
    nyc_rules: { url: RULE_URL },
    events: events.filter((event) => event.valid_at <= asOf),
  };
}
const t1 = projectRulemakingOutcomeSnapshot(dotSnapshot("2026-04-01"), { asOf: "2026-04-01" });
const t2 = projectRulemakingOutcomeSnapshot(dotSnapshot("2026-07-20"), { asOf: "2026-07-20" });
const t3 = projectRulemakingOutcomeSnapshot(dotSnapshot("2026-08-20"), { asOf: "2026-08-20" });
const adopted = projectCivicOutcomeTransition({ subject_ref: SUBJECT, previous: t1, current: t2 });
const effective = projectCivicOutcomeTransition({ subject_ref: SUBJECT, previous: t2, current: t3 });

function outcomePage(title, outcome, requestId) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · CityScroll</title>
${renderCivicDocumentAssets("/")}
</head>
<body>
<main class="civic-document node-document" data-rulemaking-subject="${SUBJECT}" data-request-id="${requestId}">
  <p class="node-kicker">DOT City-Owned Bicycle Racks</p>
  <h1>${title}</h1>
  <p>CityScroll reports what happened to the rulemaking. It never treats a resident comment as the cause of adoption or effectiveness.</p>
  ${renderCivicOutcomeTransition(outcome)}
  <p class="node-muted">Continuation remains this same City-Owned Bicycle Racks rulemaking. This is not a follow-all-DOT-rules watch.</p>
</main>
</body>
</html>
`;
}

write("rules/dot-t2-adoption/index.html", outcomePage("Notice of Adoption: City-Owned Bicycle Racks", adopted, "20260706041"));
write("rules/dot-t3-effective/index.html", outcomePage("City-Owned Bicycle Racks now effective", effective, "20260706041"));

for (const name of ["brand.css", "civic-documents.css", "local_constellation.css"]) {
  copyFileSync(join(ROOT, "site", name), join(out, name));
}
