#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  absoluteCityScrollUrl,
  CANONICAL_ORIGIN,
  migrateLegacyUrl,
} from "../site/route_migration.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join(ROOT, "site/demo/demo-links.json");
const CSV_PATH = join(ROOT, "docs/url-migration-map.csv");
const MARKDOWN_PATH = join(ROOT, "docs/url-migration-map.md");

const PATTERN_ROWS = [
  ["notice permalink", "/#notice/{request_id}", "/notices/{request_id}", "Preserve bounded w and focus fragment parameters.", "Legacy root location.replace().", "/#notice/20240515016"],
  ["index-document notice permalink", "/index.html#notice/{request_id}", "/notices/{request_id}", "Preserve bounded w and focus fragment parameters.", "Legacy index-document location.replace().", "/index.html#notice/20240515016"],
  ["translated notice permalink", "/?lang={lang}#notice/{request_id}", "/notices/{request_id}?lang={lang}", "Preserve only a selectable language plus bounded w and focus parameters.", "Legacy root location.replace().", "/?lang=es#notice/20240515016"],
  ["translated index-document notice permalink", "/index.html?lang={lang}#notice/{request_id}", "/notices/{request_id}?lang={lang}", "Preserve only a selectable language plus bounded w and focus parameters.", "Legacy index-document location.replace().", "/index.html?lang=es#notice/20240515016"],
  ["watched notice permalink", "/#notice/{request_id}?w={encoded_watch}&focus={anchor}", "/notices/{request_id}?w={encoded_watch}&focus={anchor}", "Preserve bounded w and focus values; validate their contents in the notice island.", "Legacy root location.replace().", "/#notice/20240515016?w=%7B%22lens%22%3A%22money%22%7D&focus=follow-the-dollars"],
  ["exam permalink", "/#exam/{exam_number}", "/exams/{exam_number}/", "Preserve only a selectable language value in the canonical exam document query.", "Legacy root location.replace().", "/#exam/7016"],
  ["translated exam permalink", "/?lang={lang}#exam/{exam_number}", "/exams/{exam_number}/?lang={lang}", "Preserve only a selectable language value in the canonical exam document query.", "Legacy root location.replace().", "/?lang=es#exam/7016"],
  ["agency profile", "/#agency/{name}", "/agencies/{canonical_id}/", "Resolve display names and known aliases to the canonical agency id; preserve tab and language.", "Legacy root location.replace().", "/#agency/Design%20and%20Construction%20(DDC)"],
  ["vendor profile", "/#vendor/{name}", "/vendors/{canonical_stem}/", "Normalize the routed vendor stem; preserve tab and language.", "Legacy root location.replace().", "/#vendor/CAMBA%20LLC"],
  ["official profile", "/#official/{id}", "/officials/{id}/", "Preserve bounded event, notice, and language context.", "Legacy root location.replace().", "/#official/7801?event=22526&notice=20260706036"],
  ["Contracts lens view", "/#money?{filters}", "/browse/contracts/?{filters}", "Forward the Contracts allowlist; normalize legacy agency= into the typed facet and disclose obsolete keys.", "Legacy root location.replace(); agency aliases redirect to the canonical facet-only URL.", "/#money?closing=week"],
  ["Staffing lens view", "/#people?{filters} and /#staffing?{filters}", "/browse/staffing/?{filters}", "Forward the Staffing allowlist; normalize legacy agency= into the typed facet; lang may move from the fragment into the document query.", "Legacy root location.replace(); agency aliases redirect to the canonical facet-only URL.", "/#staffing?lang=es&view=guide"],
  ["Zoning lens view", "/#land?{filters}", "/browse/zoning/?{filters}", "Forward the Zoning allowlist; normalize legacy agency= into the typed facet; item routes remain legacy in this increment.", "Legacy root location.replace(); agency aliases redirect to the canonical facet-only URL.", "/#land"],
  ["Property lens view", "/#property?{filters}", "/browse/property/?{filters}", "Forward the Property allowlist; normalize legacy agency= into the typed facet and disclose obsolete keys.", "Legacy root location.replace(); agency aliases redirect to the canonical facet-only URL.", "/#property?boro=Brooklyn&view=archive"],
  ["Rules lens view", "/#rules?{filters}", "/browse/rules/?{filters}", "Forward the Rules allowlist; normalize legacy agency= into the typed facet and disclose obsolete keys.", "Legacy root location.replace(); agency aliases redirect to the canonical facet-only URL.", "/#rules?q=BRONX+CURB"],
  ["Meetings lens view", "/#meetings?{filters}", "/browse/meetings/?{filters}", "Forward the Meetings allowlist; normalize legacy agency= into the typed facet and disclose obsolete keys.", "Legacy root location.replace(); agency aliases redirect to the canonical facet-only URL.", "/#meetings?q=IDA&when=upcoming"],
  ["Now view", "/#now?{scope}", "/now/?{scope}", "Forward supported shared-scope parameters.", "Legacy root location.replace().", "/#now"],
  ["Near-you view", "/#map?{scope}", "/near-you/?{scope}", "Forward supported place and shared-scope parameters.", "Legacy root location.replace().", "/#map?lens=property"],
  ["Following view", "/#alerts?{scope}", "/following/?{scope}", "Forward supported watch-scope and view parameters.", "Legacy root location.replace().", "/#alerts"],
  ["public Stats document", "/stats.html", "/stats.html", "URL unchanged; content is intentionally limited to corpus and coverage facts.", "Explicitly excluded from route rewrites and the Pages edge route.", "/stats.html"],
  ["public Stats API", "https://api.cityscroll.org/stats", "https://api.cityscroll.org/stats", "URL unchanged; public-stats.v2 removes product-use and delivery fields, which moved to authenticated /admin/stats.", "Explicitly excluded from the site route migration.", "https://api.cityscroll.org/stats"],
].map(([link_class, old_pattern, new_pattern, parameter_rule, forwarding_behavior, example]) => {
  const migrated = migrateLegacyUrl(example);
  const exampleTarget = link_class.startsWith("public Stats") ? example : migrated.target;
  return {
    link_class,
    old_pattern,
    new_pattern,
    parameter_rule,
    forwarding_behavior,
    verified_example: `${absoluteCityScrollUrl(example)} → ${absoluteCityScrollUrl(exampleTarget)}`,
  };
});

function manifestRows() {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  return manifest.entries.map((entry) => {
    const mapped = migrateLegacyUrl(entry.url);
    return {
      link_class: `public demo: ${entry.id}`,
      old_pattern: entry.url,
      new_pattern: mapped.target,
      parameter_rule: mapped.parameterRule,
      forwarding_behavior: mapped.forwardingBehavior,
      verified_example: `${absoluteCityScrollUrl(entry.url)} → ${absoluteCityScrollUrl(mapped.target)}`,
    };
  });
}

export function buildMigrationRows() {
  return [...PATTERN_ROWS, ...manifestRows()];
}

function csvCell(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

export function renderCsv(rows) {
  const headers = ["link_class", "old_pattern", "new_pattern", "parameter_rule", "forwarding_behavior", "verified_example"];
  return `${[headers, ...rows.map((row) => headers.map((header) => row[header]))]
    .map((row) => row.map(csvCell).join(","))
    .join("\n")}\n`;
}

function markdownCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function renderMarkdown(rows) {
  const body = rows.map((row) => `| ${[
    row.link_class, row.old_pattern, row.new_pattern, row.parameter_rule,
    row.forwarding_behavior, row.verified_example,
  ].map(markdownCell).join(" | ")} |`).join("\n");
  return `# URL migration map\n\nThis table is generated from the finite route grammar and the public demo-link manifest. It covers every canonical migration class plus every checked-in externally shared demo URL. The CSV twin is [url-migration-map.csv](url-migration-map.csv).\n\n| Link class | Old pattern | New pattern | Parameter rule | Forwarding behavior | Verified example |\n|---|---|---|---|---|---|\n${body}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rows = buildMigrationRows();
  const outputs = [
    [CSV_PATH, renderCsv(rows)],
    [MARKDOWN_PATH, renderMarkdown(rows)],
  ];
  const check = process.argv.includes("--check");
  let changed = 0;
  for (const [path, content] of outputs) {
    if (existsSync(path) && readFileSync(path, "utf8") === content) continue;
    changed += 1;
    if (!check) {
      writeFileSync(path, content);
      console.log("wrote", path);
    }
  }
  if (check && changed) {
    console.error(`${changed} URL migration map artifact(s) are stale`);
    process.exit(1);
  }
  console.log(check ? `URL migration map ok (${rows.length} rows)` : `URL migration map built (${rows.length} rows)`);
}
