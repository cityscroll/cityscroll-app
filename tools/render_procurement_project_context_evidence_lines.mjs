#!/usr/bin/env node
// Writes the textual half of the wider-project section's evidence: the exact
// rendered rows and notes each named capture case produces, extracted from the
// same HTML the capture manifest screenshots. Run after a production change to
// the section, alongside tools/capture_procurement_project_context_evidence.py.
import { writeFileSync } from "node:fs";

import { CAPTURE_CASES, MATERIALIZATION } from "../test/fixtures/procurement_project_context_fixtures.mjs";

const OUT = new URL("../docs/evidence/procurement-project-context/rendered-lines.md", import.meta.url);

function decode(value) {
  return value
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

function section(html) {
  const match = html.match(/<section class="project-context"[\s\S]*?<\/section>/);
  return match ? match[0] : null;
}

function rows(markup) {
  return [...markup.matchAll(/<dt>([\s\S]*?)<\/dt><dd>([\s\S]*?)<\/dd>/g)]
    .map(([, term, value]) => `| ${decode(term)} | ${decode(value)} |`);
}

function firstText(markup, pattern) {
  const match = markup.match(pattern);
  return match ? decode(match[1]).trim() : null;
}

const lines = [
  "# Rendered evidence: the wider project on procurement detail",
  "",
  "Textual evidence to accompany `capture-manifest.json`. Each block is the",
  "exact rendered content the named capture case produces, extracted from the",
  "same HTML the manifest's screenshots captured. Screenshot binaries are held",
  "outside this repository per the evidence rule; this file is the reproducible",
  "textual record of what they show.",
  "",
  "Data vintage: "
    + `${MATERIALIZATION.source_scope.solicitations.rows} published procurement notices through `
    + `${MATERIALIZATION.source_scope.solicitations.extract_date}, joined to the `
    + `${MATERIALIZATION.source_scope.capital_projects.reporting_period} capital reporting period `
    + `(${MATERIALIZATION.source_scope.capital_projects.published_project_codes} published project codes).`,
  "",
];

for (const entry of CAPTURE_CASES) {
  const markup = section(entry.render());
  lines.push(`## ${entry.label}`, "");
  lines.push(`- Notice: \`${entry.requestId}\``);
  if (!markup) {
    lines.push("- No wider-project section renders for this case.", "");
    continue;
  }
  lines.push("");
  lines.push("| Fact | Value |", "| --- | --- |");
  lines.push(...rows(markup));
  lines.push("");
  const scope = firstText(markup, /<p class="project-context-scope">([\s\S]*?)<\/p>/);
  lines.push(scope ? `Published project scope: ${scope}` : "Published project scope: none published.");
  lines.push("");
  const notes = [...markup.matchAll(/<li>([\s\S]*?)<\/li>/g)].map(([, note]) => decode(note).trim());
  if (notes.length) {
    lines.push("Boundaries stated to the reader:", "");
    for (const note of notes) lines.push(`- ${note}`);
    lines.push("");
  }
  const observations = firstText(markup, /<details class="project-context-observations">[\s\S]*?<p>([\s\S]*?)<\/p>/);
  if (observations) lines.push(`Source records: ${observations}`, "");
  const official = markup.match(/class="project-context-official-link" href="([^"]+)"/);
  if (official) lines.push(`Official action preserved: \`${decode(official[1])}\``, "");
}

writeFileSync(OUT, `${lines.join("\n").replace(/\n{3,}/g, "\n\n")}\n`);
process.stdout.write(`wrote ${OUT.pathname}\n`);
