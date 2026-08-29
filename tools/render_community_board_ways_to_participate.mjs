import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

import {
  buildCommunityBoardConstellationView,
  renderCommunityBoardConstellationDocument,
} from "../site/community_board_constellation.mjs";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = process.argv[2];
if (!out) {
  throw new Error("usage: node tools/render_community_board_ways_to_participate.mjs <outdir>");
}

const read = (rel) => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
const sources = {
  sourceRegistry: read("site/data/non_council_outcome_sources/source_registry.json"),
  sourceInventory: read("site/data/non_council_outcome_sources/board_source_inventory.json"),
  scorecard: read("site/data/community_board_minutes_scorecard.json"),
  geography: read("site/data/community_board_geography_lookup.json"),
  communityBoardParticipation: read("site/data/community_board_participation.json"),
};

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

mkdirSync(join(out, "community-boards/manhattan-cb-02"), { recursive: true });
mkdirSync(join(out, "community-boards/bronx-cb-02"), { recursive: true });
writeFileSync(
  join(out, "community-boards/manhattan-cb-02/index.html"),
  renderCommunityBoardConstellationDocument(positive, { assetPrefix: "/" }),
);
writeFileSync(
  join(out, "community-boards/bronx-cb-02/index.html"),
  renderCommunityBoardConstellationDocument(negative, { assetPrefix: "/" }),
);
for (const name of ["brand.css", "civic-documents.css", "local_constellation.css"]) {
  copyFileSync(join(ROOT, "site", name), join(out, name));
}
