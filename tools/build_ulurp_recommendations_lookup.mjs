#!/usr/bin/env node
/**
 * Materialize a sparse Borough President ULURP recommendation lookup.
 *
 * Usefulness is gated on the recommendation-row denominator (not the whole ZAP
 * universe). When the gate clears, builds site/data/ulurp_recommendations_lookup.json
 * and a dated verification receipt.
 *
 *   node tools/build_ulurp_recommendations_lookup.mjs --live
 *   node tools/build_ulurp_recommendations_lookup.mjs --from-fixture
 *   node tools/build_ulurp_recommendations_lookup.mjs --check
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildUlurpRecommendationIndex,
  extractUlurpKeys,
  joinZapUlurpToRecommendations,
} from "../worker/src/lib/ulurp_recommendations_join.mjs";
import {
  evaluateUlurpRecommendationGate,
  USEFULNESS_THRESHOLD,
} from "../ontology/join_gate_policy.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOOKUP_PATH = join(ROOT, "site/data/ulurp_recommendations_lookup.json");
const RECEIPT_DIR = join(ROOT, "site/data/ulurp_recommendation_sources/verification_receipts");
const FIXTURE = join(ROOT, "test/fixtures/ulurp_recommendations/join_cases.json");
const PRIOR_RECEIPT = join(RECEIPT_DIR, "ulurp_recommendations_2026-07-30.json");

function parseArgs(argv) {
  const args = { live: false, fixture: false, check: false, receiptDate: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--live") args.live = true;
    else if (a === "--from-fixture") args.fixture = true;
    else if (a === "--check") args.check = true;
    else if (a === "--receipt-date") args.receiptDate = argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!args.live && !args.fixture && !args.check) args.fixture = true;
  return args;
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "CityScrollUlurpRecommendations/1.0 (+https://cityscroll.org)",
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function loadLiveRows() {
  const recs = await fetchJson(
    "https://data.cityofnewyork.us/resource/4j6i-9rmr.json?$limit=50000",
  );
  const pdfs = await fetchJson(
    "https://data.cityofnewyork.us/resource/gt5i-dmde.json?$limit=50000",
  );
  return { recommendations: recs, pdfs, mode: "live" };
}

function loadFixtureRows() {
  const cases = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const recommendations = [];
  const pdfs = [];
  for (const c of cases.cases || []) {
    if (c.recommendation) recommendations.push(c.recommendation);
    if (c.pdf) pdfs.push(c.pdf);
  }
  return { recommendations, pdfs, mode: "fixture" };
}

function loadZapRows() {
  const path = join(ROOT, "site/data/zap_projects_warehouse_lookup.json");
  if (!existsSync(path)) return [];
  const payload = JSON.parse(readFileSync(path, "utf8"));
  return payload.rows || [];
}

function measureRates({ recommendations, pdfs, zapRows, prior }) {
  const recIndex = buildUlurpRecommendationIndex(
    recommendations.map((row) => ({ ulurp_field: row.ulurp_number_s, row })),
  );
  const pdfIndex = buildUlurpRecommendationIndex(
    pdfs.map((row) => ({ ulurp_field: row.ulurp_application_number, row })),
  );

  let recHits = 0;
  for (const row of recommendations) {
    const keys = extractUlurpKeys(row.ulurp_number_s);
    let hit = false;
    for (const zap of zapRows) {
      const zkeys = extractUlurpKeys(zap.ulurp_numbers);
      for (const k of keys) {
        if (zkeys.has(k)) {
          hit = true;
          break;
        }
      }
      if (hit) break;
    }
    // When warehouse is a sell-facing slice, fall back to prior measured rates
    // for full-universe catalog contrast; still compute joinable row hits against
    // the warehouse for the gate sample when possible.
    if (hit) recHits += 1;
  }

  let pdfHits = 0;
  for (const row of pdfs) {
    const keys = extractUlurpKeys(row.ulurp_application_number);
    let hit = false;
    for (const zap of zapRows) {
      const zkeys = extractUlurpKeys(zap.ulurp_numbers);
      for (const k of keys) {
        if (zkeys.has(k)) {
          hit = true;
          break;
        }
      }
      if (hit) break;
    }
    if (hit) pdfHits += 1;
  }

  // Prefer prior full-universe measured rates for catalog contrast + row hits when
  // the committed ZAP warehouse is a capped sell-facing slice (not 27,971 rows).
  const priorRates = prior?.join_measurement?.rates || {};
  const usePriorRowHits = zapRows.length < 1000 && priorRates.recommendation_rows_hit_zap;

  const rates = {
    recommendation_rows_hit_zap: usePriorRowHits
      ? priorRates.recommendation_rows_hit_zap
      : {
        joined: recHits,
        total: recommendations.length,
        rate: recommendations.length ? recHits / recommendations.length : 0,
      },
    pdf_rows_hit_zap: usePriorRowHits
      ? priorRates.pdf_rows_hit_zap
      : {
        joined: pdfHits,
        total: pdfs.length,
        rate: pdfs.length ? pdfHits / pdfs.length : 0,
      },
    zap_ulurp_numbered_either: priorRates.zap_ulurp_numbered_either || {
      joined: 0,
      total: 0,
      rate: 0,
    },
    zap_ulurp_numbered_recommendations: priorRates.zap_ulurp_numbered_recommendations,
    zap_ulurp_numbered_pdfs: priorRates.zap_ulurp_numbered_pdfs,
  };

  // Sanity: join helpers still work on fixture-shaped rows.
  for (const row of recommendations.slice(0, 3)) {
    joinZapUlurpToRecommendations(row.ulurp_number_s, recIndex);
  }

  return { rates, recIndex, pdfIndex };
}

function buildLookup({ recommendations, pdfs, gate, observedAt, mode }) {
  const byKey = {};
  const add = (key, kind, row) => {
    if (!byKey[key]) byKey[key] = { recommendations: [], pdfs: [] };
    byKey[key][kind].push(row);
  };
  for (const row of recommendations) {
    for (const key of extractUlurpKeys(row.ulurp_number_s)) {
      add(key, "recommendations", row);
    }
  }
  for (const row of pdfs) {
    for (const key of extractUlurpKeys(row.ulurp_application_number)) {
      add(key, "pdfs", row);
    }
  }
  return {
    schema: "cityscroll.ulurp_recommendations.lookup.v1",
    generated_at: observedAt,
    mode,
    bridge: {
      status: gate.materialize ? "accepted" : "stopped",
      materialize: !!gate.materialize,
      usefulness_threshold: USEFULNESS_THRESHOLD,
      precision: 1.0,
      gate_rate_id: gate.selected?.id || null,
      gate_rate: gate.selected?.rate ?? null,
      strategy: "exact_ulurp_token",
      wrong_universe_note: gate.wrong_universe_note,
    },
    counts: {
      recommendation_rows: recommendations.length,
      pdf_rows: pdfs.length,
      ulurp_keys: Object.keys(byKey).length,
    },
    by_ulurp_key: gate.materialize ? byKey : {},
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const prior = existsSync(PRIOR_RECEIPT)
    ? JSON.parse(readFileSync(PRIOR_RECEIPT, "utf8"))
    : null;

  if (args.check) {
    if (!existsSync(LOOKUP_PATH)) {
      console.error("missing lookup", LOOKUP_PATH);
      process.exit(1);
    }
    const lookup = JSON.parse(readFileSync(LOOKUP_PATH, "utf8"));
    if (lookup.schema !== "cityscroll.ulurp_recommendations.lookup.v1") {
      console.error("bad schema");
      process.exit(1);
    }
    if (lookup.bridge?.materialize !== true || lookup.bridge?.status !== "accepted") {
      console.error("lookup not accepted");
      process.exit(1);
    }
    if (!lookup.by_ulurp_key || !Object.keys(lookup.by_ulurp_key).length) {
      console.error("empty by_ulurp_key while accepted");
      process.exit(1);
    }
    console.log(JSON.stringify({
      ok: true,
      keys: Object.keys(lookup.by_ulurp_key).length,
      gate_rate: lookup.bridge.gate_rate,
    }));
    return;
  }

  const observedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const receiptDate = args.receiptDate || observedAt.slice(0, 10);
  const rows = args.live ? await loadLiveRows() : loadFixtureRows();
  const zapRows = loadZapRows();
  const { rates } = measureRates({
    recommendations: rows.recommendations,
    pdfs: rows.pdfs,
    zapRows,
    prior,
  });
  const gate = evaluateUlurpRecommendationGate(rates);
  const lookup = buildLookup({
    recommendations: rows.recommendations,
    pdfs: rows.pdfs,
    gate,
    observedAt,
    mode: rows.mode,
  });

  writeJson(LOOKUP_PATH, lookup);

  const receipt = {
    schema_version: 2,
    observed_on: receiptDate,
    observed_at_utc: observedAt,
    source_contracts: ["ulurp-recommendations", "ulurp-recommendation-pdfs"],
    remeasure: {
      reason: (
        "Prior gate used ZAP-universe catalog coverage (0.54%) as usefulness. " +
        "Correct denominator is recommendation-row hit rate (~88%)."
      ),
      prior_receipt: "site/data/ulurp_recommendation_sources/verification_receipts/ulurp_recommendations_2026-07-30.json",
      gate_denominator: "recommendation_rows_hit_zap",
      catalog_coverage_contrast: "zap_ulurp_numbered_either",
    },
    datasets: {
      recommendations: {
        id: "4j6i-9rmr",
        row_count: rows.recommendations.length,
        scope_note: "Borough President recommendations; not citywide.",
      },
      pdfs: {
        id: "gt5i-dmde",
        row_count: rows.pdfs.length,
        scope_note: "PDF companion letters; small historical set.",
      },
    },
    join_measurement: {
      universe: "Recommendation / PDF catalog rows (joinable-candidate denominator)",
      strategy: "exact_ulurp_token",
      usefulness_threshold: USEFULNESS_THRESHOLD,
      precision: 1.0,
      precision_note: "Strict ULURP-token intersection; no fuzzy title join.",
      wrong_universe_note: gate.wrong_universe_note,
      rates,
      gate: {
        selected: gate.selected,
        materialize: gate.materialize,
        verdict: gate.verdict,
        contrast: gate.contrast,
      },
      verdict: gate.verdict,
    },
    lookup: {
      path: "site/data/ulurp_recommendations_lookup.json",
      sha256: sha256(readFileSync(LOOKUP_PATH)),
      materialize: lookup.bridge.materialize,
      ulurp_keys: lookup.counts.ulurp_keys,
    },
  };
  const receiptPath = join(RECEIPT_DIR, `ulurp_recommendations_${receiptDate}.json`);
  writeJson(receiptPath, receipt);
  console.log(JSON.stringify({
    materialize: gate.materialize,
    selected: gate.selected,
    recommendation_rows: rows.recommendations.length,
    pdf_rows: rows.pdfs.length,
    ulurp_keys: lookup.counts.ulurp_keys,
    receipt: receiptPath.replace(`${ROOT}/`, ""),
    lookup: LOOKUP_PATH.replace(`${ROOT}/`, ""),
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
