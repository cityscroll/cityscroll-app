#!/usr/bin/env node
/**
 * Build property disposition-timing model from committed City Record history.
 *
 *   node tools/build_property_disposition_timing.mjs
 *   node tools/build_property_disposition_timing.mjs --check
 *
 * Writes:
 *   site/data/property_disposition_timing_model.json
 *   docs/evidence/property-disposition-timing/backtest.json
 *   site/data/property_sources/verification_receipts/property_disposition_timing_latest.json
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildPropertyDispositionTimingReport } from "../worker/src/lib/property_disposition_timing.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HISTORY = join(ROOT, "site/data/property_sources/property_disposition_history.json");
const MODEL_OUT = join(ROOT, "site/data/property_disposition_timing_model.json");
const EVIDENCE_OUT = join(ROOT, "docs/evidence/property-disposition-timing/backtest.json");
const RECEIPT_OUT = join(
  ROOT,
  "site/data/property_sources/verification_receipts/property_disposition_timing_latest.json",
);

const checkOnly = process.argv.includes("--check");

const history = JSON.parse(readFileSync(HISTORY, "utf8"));
const notices = Array.isArray(history.notices) ? history.notices : [];
const report = buildPropertyDispositionTimingReport(notices, {
  generatedAt: "2026-08-03T12:00:00Z",
});

const evidence = {
  schema_version: 1,
  domain: "property",
  model_name: report.model_name,
  model_version: report.model_version,
  generated_at: report.generated_at,
  corpus: report.corpus,
  citywide: report.citywide,
  backtest: report.backtest,
  public_projection: report.public_projection,
};

const receipt = {
  observed_at: history.observed_at || report.generated_at.slice(0, 10),
  notice_count: notices.length,
  multi_stage_pairs: report.corpus.multi_stage_hearing_auction_pairs,
  auction_schedule_pairs: report.corpus.auction_schedule_pairs,
  primary_pair_kind: report.corpus.primary_pair_kind,
  public_projection: report.public_projection,
  ship_bar: report.backtest?.scorecard?.ship_bar?.status || "fail",
  citywide_n: report.citywide?.n ?? 0,
  weeks: {
    low: report.citywide?.middle_half_low_weeks,
    high: report.citywide?.middle_half_high_weeks,
    p50: report.citywide?.p50_weeks,
  },
};

if (checkOnly) {
  const existing = JSON.parse(readFileSync(MODEL_OUT, "utf8"));
  const stable = (obj) => {
    const { generated_at: _g, ...rest } = obj;
    return JSON.stringify(rest);
  };
  if (stable(existing) !== stable(report)) {
    console.error("property_disposition_timing_model.json is stale — re-run without --check");
    process.exit(1);
  }
  console.log("ok property disposition timing model is current");
  process.exit(0);
}

mkdirSync(dirname(EVIDENCE_OUT), { recursive: true });
mkdirSync(dirname(RECEIPT_OUT), { recursive: true });
writeFileSync(MODEL_OUT, `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(EVIDENCE_OUT, `${JSON.stringify(evidence, null, 2)}\n`);
writeFileSync(RECEIPT_OUT, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      notices: notices.length,
      multi_stage: report.corpus.multi_stage_hearing_auction_pairs,
      schedule: report.corpus.auction_schedule_pairs,
      public_projection: report.public_projection,
      ship_bar: report.backtest?.scorecard?.ship_bar?.status,
      out: [MODEL_OUT, EVIDENCE_OUT, RECEIPT_OUT],
    },
    null,
    2,
  ),
);
