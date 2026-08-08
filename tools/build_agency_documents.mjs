#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { AGENCY_GROUPS, agencyCanonicalId } from "../site/agency_identity.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = join(ROOT, "site/agencies/index.html");

const esc = (value) => String(value ?? "").replace(/[&<>\"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
}[char]));

export function renderAgencyIndex() {
  const links = Object.keys(AGENCY_GROUPS).map((name) => {
    const id = agencyCanonicalId(name);
    return `<li><a href="/agencies/${encodeURIComponent(id)}/" data-subject-ref="agency:id:${esc(id)}">${esc(name)}</a></li>`;
  }).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agencies · CityScroll</title><link rel="stylesheet" href="/brand.css"><link rel="stylesheet" href="/civic-documents.css"></head>
<body><a class="skip" href="#main">Skip to content</a>
<main id="main" class="node-document civic-object-document" data-node-document="1"><p class="node-back"><a href="/browse/">Back to Browse</a></p>
<header class="node-hero civic-object-hero"><p class="node-kicker civic-object-kicker">Agency profiles</p><h1>City agencies</h1>
<p class="node-lede">Browse the agencies represented in CityScroll’s reviewed identity registry. Each page opens that agency’s cross-category constellation (contracts, meetings, rules, staffing exams) when materialization has links, plus a path to the interactive profile.</p>
<p class="node-inline-actions civic-object-inline-actions"><a class="node-action civic-object-action" href="/graph/ontology-delta/">What’s new in the graph</a></p></header>
<section class="node-section node-card civic-object-section" aria-labelledby="agency-list-heading"><h2 id="agency-list-heading">Agencies</h2><ul class="node-record-list">${links}</ul></section>
</main><footer class="node-footer civic-object-footer">CityScroll is an unofficial reading aid. <a href="/about.html">About the data</a>.</footer></body></html>`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const check = process.argv.includes("--check");
  const content = renderAgencyIndex();
  const current = existsSync(OUTPUT) ? readFileSync(OUTPUT, "utf8") : "";
  if (current !== content) {
    if (check) {
      console.error("Agency index is stale; rebuild with node tools/build_agency_documents.mjs");
      process.exit(1);
    }
    mkdirSync(dirname(OUTPUT), { recursive: true });
    writeFileSync(OUTPUT, content);
    console.log("wrote", OUTPUT);
  }
  console.log(check ? `Agency index is current (${Object.keys(AGENCY_GROUPS).length} links)` : `Agency index built (${Object.keys(AGENCY_GROUPS).length} links)`);
}
