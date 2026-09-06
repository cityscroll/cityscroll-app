#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAgencyFiscalContext, AGENCY_FISCAL_CONTEXT_URL } from "../site/agency_fiscal_context.mjs";
import { readAnalyticalProjectionDocument } from "./lib/analytical_projection_io.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = join(ROOT, "site", AGENCY_FISCAL_CONTEXT_URL);
const FISCAL_ROWS = join(ROOT, "warehouse/sources/ibo-fiscal-history/materialized/observations.jsonl");
const IBO_RECEIPT = join(ROOT, "warehouse/sources/ibo-fiscal-history/materialized/receipt.json");
const FALLBACK_CONTEXT = join(ROOT, "site/data/agency_fiscal_context_fallback.json");
const CONTRACTS = join(ROOT, "site/data/analytics_registered_contracts.json");
const PAYMENTS = join(ROOT, "site/data/analytics_payments.json");

function readJson(path) { return JSON.parse(readFileSync(path, "utf8")); }
function readJsonl(path) { return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse); }

export function build() {
  const fiscalRows = readJsonl(FISCAL_ROWS);
  const iboReceipt = readJson(IBO_RECEIPT);
  const fallbackFiscalContext = existsSync(FALLBACK_CONTEXT) ? readJson(FALLBACK_CONTEXT) : null;
  const contractProjection = readAnalyticalProjectionDocument(CONTRACTS);
  const paymentProjection = readJson(PAYMENTS);
  return buildAgencyFiscalContext({
    fiscalRows,
    fallbackFiscalContext,
    registeredRows: contractProjection.rows,
    paymentRows: paymentProjection.rows,
    iboReceipt,
    contractProjection,
    paymentProjection,
    generatedAt: [iboReceipt.retrieval_timestamp, contractProjection.generated_at, paymentProjection.generated_at].filter(Boolean).sort().join("|") || null,
  });
}

const payload = build();
const serialized = `${JSON.stringify(payload, null, 2)}\n`;
if (process.argv.includes("--check")) {
  if (!existsSync(OUTPUT) || readFileSync(OUTPUT, "utf8") !== serialized) throw new Error(`stale agency fiscal context: ${OUTPUT}`);
  console.log(`agency fiscal context current: agencies=${payload.coverage.agency_count} exact=${payload.coverage.exact_fiscal_join_count}`);
} else {
  writeFileSync(OUTPUT, serialized);
  console.log(`wrote agency fiscal context: agencies=${payload.coverage.agency_count} exact=${payload.coverage.exact_fiscal_join_count}`);
}
