import { readFileSync } from "node:fs";

export const SITE_MODULES = [
  "core.mjs",
  "money-list.mjs",
  "money-history.mjs",
  "search-share.mjs",
  "people.mjs",
  "land.mjs",
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
  "workspace.mjs",
  "now.mjs",
  "routing.mjs",
  "boot.mjs",
];

// Route-owned islands are registered here instead of the home loader. Tests read
// them directly when their surface is in scope, keeping unrelated-route source
// extraction aligned with the browser's wire graph.
export const ROUTE_ISLAND_MODULES = ["alerts.mjs", "following.mjs", "map.mjs"];

// Legacy alert behavior tests still extract the retired hash-builder source directly.
// It is intentionally outside SITE_MODULES so this test seam never becomes a wire claim.
export const SOURCE_ONLY_MODULES = ["alerts.mjs"];

export function readSiteSource() {
  const html = readFileSync(new URL("../../site/index.html", import.meta.url), "utf8");
  const modules = SITE_MODULES.map((name) =>
    readFileSync(new URL(`../../site/app/${name}`, import.meta.url), "utf8"),
  );
  const sourceOnly = SOURCE_ONLY_MODULES.map((name) =>
    readFileSync(new URL(`../../site/app/${name}`, import.meta.url), "utf8"),
  );
  return [html, ...modules, ...sourceOnly].join("\n");
}

export const SITE_SOURCE = readSiteSource();
