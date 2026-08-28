#!/usr/bin/env node
/* Host-side Tier 1 acquisition for NYC Rules regulatory agendas. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  REGULATORY_AGENDA_INDEX_URL,
  buildRegulatoryAgendaMaterialization,
  extractRegulatoryAgendaItems,
  parseRegulatoryAgendaIndex,
} from "../site/regulatory_agenda.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "site/data/regulatory_agenda.json");
const RECEIPT = join(ROOT, "warehouse/receipts/proof/regulatory_agenda_latest.json");
const UA = "CityScrollBot/1.0 (+https://cityscroll.org; regulatory-agenda)";

function args(argv) {
  const out = { fixture: null, indexUrl: REGULATORY_AGENDA_INDEX_URL };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--fixture") out.fixture = argv[++i];
    else if (argv[i] === "--index-url") out.indexUrl = argv[++i];
  }
  return out;
}

async function getText(url) {
  const response = await fetch(url, { headers: { Accept: "text/html,application/pdf,*/*", "User-Agent": UA } });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response;
}

function pdfText(bytes, label) {
  const temp = join(ROOT, ".artifacts", `regulatory-agenda-${process.pid}-${label.replace(/[^a-z0-9_-]/gi, "-")}.pdf`);
  mkdirSync(dirname(temp), { recursive: true });
  writeFileSync(temp, bytes);
  try {
    return execFileSync("pdftotext", [temp, "-"], { encoding: "utf8", maxBuffer: 12 * 1024 * 1024 });
  } finally {
    try { rmSync(temp, { force: true }); } catch { /* best effort */ }
  }
}

async function acquireLive(indexUrl) {
  const indexResponse = await getText(indexUrl);
  const index = parseRegulatoryAgendaIndex(await indexResponse.text(), {
    indexUrl,
    retrievedAt: new Date().toISOString(),
  });
  const documents = [];
  const items = [];
  for (const document of index.documents) {
    try {
      const response = await getText(document.publisher_document);
      const text = pdfText(Buffer.from(await response.arrayBuffer()), `${document.agency}-${document.fiscal_year}`);
      const acquired = { ...document, retrieval_status: "available" };
      documents.push(acquired);
      items.push(...extractRegulatoryAgendaItems(text, acquired));
    } catch (error) {
      documents.push({ ...document, retrieval_status: "failed", retrieval_error: String(error?.message || error) });
    }
  }
  return { index, documents, items };
}

function acquireFixture(path) {
  const fixture = JSON.parse(readFileSync(path, "utf8"));
  const index = parseRegulatoryAgendaIndex(fixture.index_html, {
    indexUrl: fixture.index_url || REGULATORY_AGENDA_INDEX_URL,
    retrievedAt: fixture.retrieved_at || "2026-08-28T00:00:00Z",
  });
  const documents = index.documents.map((document) => {
    const text = fixture.documents?.[document.publisher_document] || fixture.documents?.[document.agency_code];
    return { document, text };
  });
  return {
    index,
    documents: documents.map(({ document, text }) => ({ ...document, retrieval_status: text ? "available" : "not_yet_acquired" })),
    items: documents.flatMap(({ document, text }) => text ? extractRegulatoryAgendaItems(text, document) : []),
  };
}

const options = args(process.argv);
const acquired = options.fixture ? acquireFixture(options.fixture) : await acquireLive(options.indexUrl);
const materialization = buildRegulatoryAgendaMaterialization({
  ...acquired,
  generatedAt: acquired.index.retrieved_at || new Date().toISOString(),
});
mkdirSync(dirname(OUT), { recursive: true });
mkdirSync(dirname(RECEIPT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(materialization, null, 2)}\n`);
writeFileSync(RECEIPT, `${JSON.stringify({
  schema: "cityscroll.regulatory_agenda_receipt.v1",
  generated_at: materialization.generated_at,
  source: materialization.source,
  checks: materialization.checks,
  agenda_link_metrics: materialization.agenda_link_bridge.metrics,
}, null, 2)}\n`);
console.log(`wrote ${OUT} agencies=${materialization.counts.agencies} items=${materialization.counts.items}`);
