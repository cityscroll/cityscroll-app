#!/usr/bin/env node
// Build the compact public tax-lien progression read models from the ignored
// warehouse bulk CSV. Optional PLUTO + tract crosswalk inputs add NTA counts;
// they are read-only build inputs and are never copied into this repository.

import { createReadStream, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { parseCsv } from "../warehouse/lib/zap_lookup.mjs";
import { evaluatePredictionBacktest } from "../worker/src/lib/prediction_calibration.mjs";
import {
  buildTaxLienAreaAggregates,
  buildTaxLienSaleModel,
  taxLienBbl,
} from "../worker/src/lib/tax_lien_sale_model.mjs";
import {
  emitTaxLienSaleDatePrediction,
  emitTaxLienSalePrediction,
} from "../worker/src/lib/tax_lien_sale_prediction.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SUMMARY_PATH = join(ROOT, "site/data/tax_lien_sale_summary.json");
const LOOKUP_PATH = join(ROOT, "site/data/tax_lien_sale_bbl.json");
const SCORECARD_PATH = join(ROOT, "warehouse/receipts/proof/tax_lien_sale_calibration_latest.json");
const SCHEDULES = Object.freeze({
  "2025-02-01": {
    sale_date: "2025-06-03",
    action_deadline: "2025-06-02",
    source_url: "https://www.nyc.gov/site/finance/about/press/dof-2025-tax-lien-sale-extension.page",
  },
});

function parseArgs(argv) {
  const args = { csv: null, pluto: null, ntaTract: null, check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") args.check = true;
    else if (["--csv", "--pluto", "--nta-tract"].includes(arg)) {
      if (!argv[index + 1]) throw new Error(`${arg} requires a path`);
      const key = arg === "--nta-tract" ? "ntaTract" : arg.slice(2);
      args[key] = resolve(argv[++index]);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.csv) throw new Error("--csv is required");
  if (Boolean(args.pluto) !== Boolean(args.ntaTract)) {
    throw new Error("--pluto and --nta-tract must be provided together");
  }
  return args;
}

function splitCsvLine(line) {
  const cells = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') { value += '"'; index += 1; }
      else quoted = !quoted;
    } else if (char === "," && !quoted) { cells.push(value); value = ""; }
    else value += char;
  }
  cells.push(value);
  return cells;
}

async function csvRows(path, visit) {
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let headers = null;
  for await (const line of lines) {
    const cells = splitCsvLine(line);
    if (!headers) { headers = cells; continue; }
    if (!line.trim()) continue;
    const row = {};
    headers.forEach((header, index) => { row[header] = cells[index] || ""; });
    visit(row);
  }
}

function geoidFromPluto(row) {
  const bct = String(row.bct2020 || "").replace(/\D/g, "");
  const borough = String(row.borocode || "").replace(/\D/g, "");
  const county = { "1": "061", "2": "005", "3": "047", "4": "081", "5": "085" }[borough];
  const tract = bct.length === 7 ? bct.slice(1) : bct.padStart(6, "0").slice(-6);
  return county && tract ? `36${county}${tract}` : null;
}

async function buildNtaMap(plutoPath, ntaTractPath, wantedBbls) {
  const byGeoid = new Map();
  await csvRows(ntaTractPath, (row) => {
    if (row.geoid_2020 && row.nta_code) byGeoid.set(row.geoid_2020, {
      code: row.nta_code,
      name: row.nta_name,
      borough: row.borough,
    });
  });
  const byBbl = new Map();
  await csvRows(plutoPath, (row) => {
    const bbl = String(row.BBL || "").replace(/\.0$/, "").padStart(10, "0");
    if (!wantedBbls.has(bbl)) return;
    const nta = byGeoid.get(geoidFromPluto(row));
    if (nta) byBbl.set(bbl, nta);
  });
  return byBbl;
}

function event(eventId, subjectRef, eventKind, validAt) {
  return { event_id: eventId, subject_ref: subjectRef, event_kind: eventKind, valid_at: validAt };
}

function calibrationFor(model) {
  const splitDate = "2025-02-02";
  const candidates = Object.keys(model.holdout.by_bbl).sort();
  const sample = [];
  for (const code of ["1", "2", "3", "4", "5"]) {
    sample.push(...candidates.filter((bbl) => bbl[0] === code).slice(0, 20));
  }
  const predictions = [];
  const events = model.training.cycle_ids.map((cycleId) => event(
    `tax-lien-cycle:${cycleId}`,
    `property-lien-cycle:${cycleId}`,
    "property.tax_lien_notice_90",
    cycleId,
  ));
  for (const bbl of sample) {
    predictions.push(
      emitTaxLienSalePrediction(model, bbl, { generated_at: `${splitDate}T00:00:00Z` }),
      emitTaxLienSaleDatePrediction(model, bbl, { generated_at: `${splitDate}T00:00:00Z` }),
    );
    events.push(
      event(`tax-lien-open:${bbl}`, `property-bbl:${bbl}`, "property.tax_lien_notice_90", model.holdout.cycle_id),
      event(`tax-lien-deadline:${bbl}`, `property-bbl:${bbl}`, "property.tax_lien_sale_deadline", model.holdout.sale_date),
    );
    if (model.holdout.by_bbl[bbl].outcome === "sold_lien") {
      events.push(event(`tax-lien-sold:${bbl}`, `property-bbl:${bbl}`, "property.tax_lien_sold", model.holdout.sale_date));
    }
  }
  return evaluatePredictionBacktest({
    domain: "property",
    split_date: splitDate,
    grace_days: 0,
    open_event_kinds: ["property.tax_lien_notice_90"],
    terminal_event_kinds: ["property.tax_lien_sold", "property.tax_lien_sale_deadline"],
    predictions,
    events,
  });
}

function stable(value) { return `${JSON.stringify(value, null, 2)}\n`; }

function compactLookup(model, ntaByBbl) {
  const rows = {};
  for (const [bbl, row] of Object.entries(model.holdout.by_bbl)) {
    const nta = ntaByBbl.get(bbl);
    rows[bbl] = [
      row.stage,
      row.outcome,
      row.borough_code,
      row.community_board,
      row.tax_class_code,
      row.water_debt_only,
      nta?.code || null,
      nta?.name || null,
    ];
  }
  return {
    schema_version: 1,
    cycle_id: model.holdout.cycle_id,
    data_vintage: model.holdout.data_vintage,
    field_order: ["stage", "outcome", "borough_code", "community_board", "tax_class_code", "water_debt_only", "nta_code", "nta_name"],
    rows,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rows = parseCsv(readFileSync(args.csv, "utf8"));
  const generatedAt = "2026-08-03T04:27:32Z";
  const model = buildTaxLienSaleModel(rows, {
    holdout_cycle: "2025-02-01",
    generated_at: generatedAt,
    schedules: SCHEDULES,
  });
  const wanted = new Set(rows.map(taxLienBbl).filter(Boolean));
  const ntaByBbl = args.pluto ? await buildNtaMap(args.pluto, args.ntaTract, wanted) : new Map();
  const areas = buildTaxLienAreaAggregates(rows, ntaByBbl);
  const scorecard = calibrationFor(model);
  const latestAreas = areas.find((cycle) => cycle.cycle_id === model.holdout.cycle_id);
  const summary = {
    schema_version: 1,
    generated_at: generatedAt,
    source: {
      id: "dof-tax-lien-sale-lists",
      dataset_id: "9rz4-mjek",
      name: "DOF Tax Lien Sale Lists",
      url: "https://data.cityofnewyork.us/d/9rz4-mjek",
      row_count: rows.length,
    },
    method: {
      name: "base_rate + announced sale date",
      model_name: model.model_name,
      model_version: model.model_version,
      minimum_historical_cycles: 3,
      training_cycles: model.training.cycle_count,
      false_positive_modes: [
        "A property can leave a later list after payment, a payment plan, an exemption, a correction, or a program-level cancellation; the dataset does not identify which lever applied.",
        "The list records BBL progression, not owner intent, debt amount, later foreclosure, or title transfer.",
        "Publication is irregular; an expired cycle is historical context, not a current warning.",
      ],
    },
    schedule: {
      sale_date: model.holdout.sale_date,
      action_deadline: model.holdout.action_deadline,
      source_url: SCHEDULES[model.holdout.cycle_id].source_url,
    },
    action_channels: {
      lien_sale_help_url: "https://www.nyc.gov/site/finance/property/property-lien-sales.page",
      payment_plan_url: "https://www.nyc.gov/site/finance/property/property-payment-plans.page",
      exemption_url: "https://www.nyc.gov/site/finance/property/lien-sale-eligibility-chart.page",
      phone: "311",
    },
    training: model.training,
    latest_cycle: {
      cycle_id: model.holdout.cycle_id,
      status: model.holdout.status,
      data_vintage: model.holdout.data_vintage,
      publications: model.holdout.publications,
      citywide: model.holdout.citywide,
      boroughs: latestAreas.boroughs,
      ntas: latestAreas.ntas,
      nta_coverage: latestAreas.nta_coverage,
    },
    cycles: areas,
    scorecard,
    public_projection: scorecard.public_projection,
  };
  const lookup = compactLookup(model, ntaByBbl);
  const outputs = [[SUMMARY_PATH, summary], [LOOKUP_PATH, lookup], [SCORECARD_PATH, scorecard]];
  if (args.check) {
    const stale = outputs.filter(([path, value]) => readFileSync(path, "utf8") !== stable(value));
    if (stale.length) throw new Error(`generated tax-lien artifacts are stale: ${stale.map(([path]) => basename(path)).join(", ")}`);
    process.stdout.write(`tax-lien artifacts OK rows=${rows.length} bbls=${Object.keys(model.holdout.by_bbl).length} nta=${ntaByBbl.size} ship_bar=${scorecard.ship_bar.status}\n`);
    return;
  }
  for (const [path, value] of outputs) writeFileSync(path, stable(value));
  process.stdout.write(`wrote tax-lien artifacts rows=${rows.length} bbls=${Object.keys(model.holdout.by_bbl).length} nta=${ntaByBbl.size} ship_bar=${scorecard.ship_bar.status}\n`);
}

main().catch((error) => {
  process.stderr.write(`build_tax_lien_sale_predictions: ${error.message || error}\n`);
  process.exitCode = 1;
});
