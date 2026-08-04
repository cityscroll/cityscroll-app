import { readFileSync } from "node:fs";

export const SITE_MODULES = [
  "core.mjs",
  "money-list.mjs",
  "money-history.mjs",
  "search-share.mjs",
  "people.mjs",
  "land.mjs",
  "feed-actions.mjs",
  "property.mjs",
  "rules.mjs",
  "alerts.mjs",
  "procurement-lifecycle.mjs",
  "procurement-phase.mjs",
  "subsidy.mjs",
  "authority-award.mjs",
  "meetings.mjs",
  "entities.mjs",
  "workspace.mjs",
  "map.mjs",
  "routing.mjs",
  "boot.mjs",
];

export function readSiteSource() {
  const html = readFileSync(new URL("../../site/index.html", import.meta.url), "utf8");
  const modules = SITE_MODULES.map((name) =>
    readFileSync(new URL(`../../site/app/${name}`, import.meta.url), "utf8"),
  );
  return [html, ...modules].join("\n");
}

export const SITE_SOURCE = readSiteSource();
