#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { testClockISOString, withPinnedClock } from "../test/helpers/test_clock.mjs";
import {
  buildContractSubstanceView,
  renderContractSubstanceHtml,
} from "../site/procurement_contract_substance_ui.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUTPUT_DIR = process.argv[2] || join(ROOT, ".artifacts", "contract-substance-role-corpus");
const CORPUS = JSON.parse(readFileSync(
  join(ROOT, "site", "data", "procurement_contract_substance_role_corpus.json"),
  "utf8",
));
const SERVICE_GEOGRAPHY = JSON.parse(readFileSync(
  join(ROOT, "site", "data", "procurement_contract_service_geography.json"),
  "utf8",
));
const CSS = readFileSync(join(ROOT, "site", "procurement_contract_substance.css"), "utf8");
const CAPTURE_CLOCK = "2026-09-19T12:00:00.000Z";

function page(body) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${CSS}</style></head><body><main>${body}</main></body></html>`;
}

function decodeHref(value) {
  return value.replaceAll("&amp;", "&");
}

function renderView(options) {
  const view = buildContractSubstanceView(options);
  if (!view) throw new Error(`capture fixture did not produce a view for ${options.contractIds.join(",")}`);
  return renderContractSubstanceHtml(view);
}

function withMutation() {
  const roleCorpus = structuredClone(CORPUS);
  const rows = roleCorpus.rows.filter((candidate) => candidate.contract_id === "BID2000090");
  if (!rows.length) throw new Error("DCAS capture row is missing");
  for (const row of rows) {
    row.document_role = "executed_obligation";
    row.resident_claim_label = "What the vendor promised";
  }
  const html = renderContractSubstanceHtml(buildContractSubstanceView({
    roleCorpus,
    contractIds: ["BID2000090"],
  }));
  return {
    mutation: "bid_tab to executed_obligation",
    source_role_before: "bid_tab",
    source_role_after: "executed_obligation",
    rendered_row_count: (html.match(/class="substance-row/g) || []).length,
    vendor_promise_label_emitted: /What the vendor promised/.test(html),
    contract_requires_heading_emitted: /What this contract requires|contract requires/i.test(html),
    assertion: "A source-role mutation is refused rather than promoted into vendor-promise copy.",
  };
}

await withPinnedClock(CAPTURE_CLOCK, () => {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const docgo = page(renderView({
    roleCorpus: CORPUS,
    contractIds: ["CT180620248801671"],
    authorizedTotal: 432000000,
    paidTotal: 123456789,
    paidAsOf: testClockISOString(),
  }));
  const bhrags = page(renderView({
    serviceGeography: SERVICE_GEOGRAPHY,
    contractIds: ["CT107120258801626"],
  }));
  const dcas = renderView({ roleCorpus: CORPUS, contractIds: ["BID2000090"] });
  const grownyc = renderView({ roleCorpus: CORPUS, contractIds: ["MOCS-FCRC-202411-GROWNYC"] });
  const harness = page(`${dcas}${grownyc}`);

  const cases = [
    {
      key: "docgo",
      route: "/procurements/procurement%3Acontract%3ACT180620248801671",
      case: "DocGo exact contract identity with Comptroller audit evidence",
      file: "docgo.html",
      html: docgo,
      assertions: [
        "The current $432,000,000 contract identity and served amounts remain observable beside the audit role label.",
        "The audit source destination is retained without a vendor-promise heading.",
      ],
    },
    {
      key: "bhrags",
      route: "/procurements/procurement%3Acontract%3ACT107120258801626",
      case: "BHRAGS notice-attributed facility context",
      file: "bhrags.html",
      html: bhrags,
      assertions: [
        "3218 Emmons Avenue and 60 units remain notice-attributed facility context with the resolved links.",
        "The facility context does not become a contractual deliverable.",
      ],
    },
    {
      key: "real-corpus-harness",
      route: "real-corpus-harness",
      case: "DCAS and GrowNYC role-specific retained passages",
      file: "real-corpus-harness.html",
      html: harness,
      assertions: [
        "DCAS values remain Bid offer rows linked to the bid-tab PDF.",
        "GrowNYC clauses, sites, and fees remain Proposed agreement term rows linked to the MOCS PDF.",
      ],
    },
  ];
  for (const capture of cases) writeFileSync(join(OUTPUT_DIR, capture.file), capture.html);
  writeFileSync(join(OUTPUT_DIR, "metadata.json"), `${JSON.stringify({
    schema: "cityscroll.contract_substance_role_corpus_capture_inputs.v1",
    generated_at: testClockISOString(),
    data_vintages: {
      role_corpus_generated_at: CORPUS.generated_at,
      service_geography_generated_at: SERVICE_GEOGRAPHY.generated_at,
      route_payment_observation: "served from the materialized procurement shard; the page receipt carries observed amounts",
    },
    captures: cases.map(({ html, ...capture }) => ({
      ...capture,
      expected_destinations: [...new Set([...html.matchAll(/<a\b[^>]*href="([^"]+)"/g)].map((match) => decodeHref(match[1])))],
    })),
    source_role_mutation: withMutation(),
  }, null, 2)}\n`);
});

process.stdout.write(`wrote ${OUTPUT_DIR}\n`);
