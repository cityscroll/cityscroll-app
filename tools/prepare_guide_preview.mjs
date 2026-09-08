#!/usr/bin/env node
/** Prepare an ignored static preview without copying the site's data. */
import { mkdirSync, readFileSync, readdirSync, symlinkSync, existsSync, writeFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadGuide } from "./build_guide_documents.mjs";
import { findMandateById, noticeEvidenceForMandate, relatedCivicEdgesForMandate, renderMandateDocument } from "../site/mandate_document.mjs";

import { joinMandateToProvisions } from "../site/statutory_mandate_provision_join.mjs";
import { lookupAdminCodeCitation } from "../site/admin_code.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const site = join(root, "site");
const output = join(root, ".artifacts/guide-preview");
mkdirSync(output, { recursive: true });
for (const name of readdirSync(site)) {
  if (name === "mandates") continue;
  const target = join(output, name);
  if (!existsSync(target)) symlinkSync(join(site, name), target);
}

// These documents are rendered on the edge in production. Render guide-linked
// records from the same retained inputs and renderer for an offline preview.
const json = (name) => JSON.parse(readFileSync(join(site, "data", name), "utf8"));
const obligations = json("agency_obligations_lookup.json");
const backlinks = json("notice_mandate_backlinks_lookup.json");
const conformance = json("process_conformance_lookup.json");
const ids = new Set(loadGuide().articles.flatMap(article =>
  [...article.bodyHtml.matchAll(/href="\/mandates\/([A-Za-z0-9_%~-]+)\/?"/g)]
    .map(match => decodeURIComponent(match[1]))));
for (const id of ids) {
  const row = findMandateById(obligations, id);
  if (!row) throw new Error(`Guide mandate not in retained data: ${id}`);
  const html = renderMandateDocument(row, {
    noticeEvidence: noticeEvidenceForMandate(backlinks, id),
    relatedEdges: relatedCivicEdgesForMandate(conformance, id),
    provisionJoin: joinMandateToProvisions(row, { lookupProvision: lookupAdminCodeCitation }),
  });
  if (!html) throw new Error(`Guide mandate failed document admission: ${id}`);
  const directory = join(output, "mandates", encodeURIComponent(id));
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "index.html"), html);
}
console.log(`Guide preview ready (.artifacts/guide-preview; ${ids.size} mandate documents)`);
