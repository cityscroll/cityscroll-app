import { readFileSync } from "node:fs";

export const SITE_MODULES = [
  "core.mjs",
  "traversal.mjs",
  "contracts-rum.mjs",
  "money-list.mjs",
  "money-history.mjs",
  "search-share.mjs",
  "exams.mjs",
  "staffing.mjs",
  "land.mjs",
  "map_runtime.mjs",
  "land_filing_report_runtime.mjs",
  "feed-actions.mjs",
  "result-match.mjs",
  "notice-context.mjs",
  "property.mjs",
  "rules.mjs",
  "procurement-lifecycle.mjs",
  "procurement-phase.mjs",
  "subsidy.mjs",
  "authority-award.mjs",
  "meetings.mjs",
  "entities.mjs",
  "entity_identity_report.mjs",
  "workspace.mjs",
  "now.mjs",
  "routing.mjs",
  "boot.mjs",
];

// Route-owned islands are registered here instead of the home loader. Tests read
// them directly when their surface is in scope, keeping unrelated-route source
// extraction aligned with the browser's wire graph.
export const ROUTE_ISLAND_MODULES = ["alerts.mjs", "community-board-scorecard.mjs", "following.mjs", "map.mjs", "place-context.mjs", "walk-entry.mjs"];

// Legacy alert behavior tests still extract the retired hash-builder source directly.
// It is intentionally outside SITE_MODULES so this test seam never becomes a wire claim.
export const SOURCE_ONLY_MODULES = ["alerts.mjs"];

// Primitives an app module used to declare inline and now imports from site/. Source
// extraction in tests reads the concatenation, so the declaration has to stay in it.
export const SHARED_SOURCE_MODULES = [
  "procurement_pin.mjs",
  "land_phase_label.mjs",
  "meeting_outcome_read.mjs",
];

export function readSiteSource() {
  const html = readFileSync(new URL("../../site/index.html", import.meta.url), "utf8");
  const modules = SITE_MODULES.map((name) =>
    readFileSync(new URL(`../../site/app/${name}`, import.meta.url), "utf8"),
  );
  const sourceOnly = SOURCE_ONLY_MODULES.map((name) =>
    readFileSync(new URL(`../../site/app/${name}`, import.meta.url), "utf8"),
  );
  const listPivots = readFileSync(new URL("../../site/list_entity_pivots.mjs", import.meta.url), "utf8");
  // Shared primitives the app modules now import instead of declaring inline. Tests that
  // slice a named function or const out of the app source still find them here.
  const shared = SHARED_SOURCE_MODULES.map((name) =>
    readFileSync(new URL(`../../site/${name}`, import.meta.url), "utf8"),
  );
  return [html, ...modules, ...sourceOnly, listPivots, ...shared].join("\n");
}

export const SITE_SOURCE = readSiteSource();
