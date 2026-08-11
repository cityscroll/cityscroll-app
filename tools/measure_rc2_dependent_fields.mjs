#!/usr/bin/env node
/**
 * Measure RC-2 dependent field and stage coverage on the accepted join corpus.
 *
 * Reads the committed receipt-backed subsidy project lookup (only emitted when
 * the RC-2 bridge cleared its usefulness/precision gates) and reports fill rates
 * for company, place, money, and lifecycle stages. Source-null stays null — this
 * tool never invents values.
 *
 * Usage:
 *   node tools/measure_rc2_dependent_fields.mjs
 *   node tools/measure_rc2_dependent_fields.mjs --check
 *   node tools/measure_rc2_dependent_fields.mjs --write
 */

import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOOKUP_PATH = path.join(ROOT, "site/data/subsidy_project_lookup.json");
const OUT_PATH = path.join(
  ROOT,
  "site/data/nycedc_sources/verification_receipts/rc2_dependent_field_coverage_2026-08-11.json",
);

function parseArgs(argv) {
  return {
    check: argv.includes("--check"),
    write: argv.includes("--write") || !argv.includes("--check"),
  };
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function present(value) {
  if (value == null) return false;
  if (typeof value === "number") return Number.isFinite(value);
  return String(value).trim().length > 0;
}

function rate(numerator, denominator) {
  if (!denominator) return null;
  return Number((numerator / denominator).toFixed(4));
}

export function measureRc2DependentFields(lookup) {
  assert.equal(lookup?.schema, "cityscroll.subsidy_project_lookup.v1");
  assert.equal(lookup?.receipt?.bridge_status, "accepted", "RC-2 bridge must be accepted");
  assert.ok(
    Number(lookup.receipt.join_rate) >= Number(lookup.receipt.threshold),
    "RC-2 join rate must clear usefulness threshold",
  );
  assert.equal(lookup.receipt.false_positives, 0);
  assert.equal(lookup.receipt.unreviewed_candidates, 0);

  const projects = Object.entries(lookup.by_notice || {}).flatMap(([request_id, rows]) =>
    (rows || []).map((row) => ({ request_id, ...row })),
  );
  const n = projects.length;
  assert.ok(n > 0, "accepted lookup must contain receipt-backed projects");

  const fieldCounts = {
    company: projects.filter((p) => present(p.company)).length,
    address: projects.filter((p) => present(p.address)).length,
    requested_benefit: projects.filter((p) => present(p.requested_benefit)).length,
    estimated_public_cost: projects.filter((p) => present(p.estimated_public_cost)).length,
    project_cost: projects.filter((p) => present(p.project_cost)).length,
    any_money: projects.filter(
      (p) => present(p.requested_benefit) || present(p.estimated_public_cost) || present(p.project_cost),
    ).length,
  };

  const stageCounts = {};
  for (const stage of ["application", "board_decision", "closing", "compliance"]) {
    const withDate = projects.filter((p) => present(p.milestones?.[stage]?.date)).length;
    const withOutcome = projects.filter((p) => present(p.milestones?.[stage]?.outcome)).length;
    stageCounts[stage] = {
      date: withDate,
      outcome: withOutcome,
      date_rate: rate(withDate, n),
      outcome_rate: rate(withOutcome, n),
    };
  }

  const any_money_rate = rate(fieldCounts.any_money, n);
  return {
    schema: "cityscroll.rc2_dependent_field_coverage.v1",
    observed_on: "2026-08-11",
    parent_receipt: {
      schema: lookup.receipt.schema,
      observed_at: lookup.receipt.observed_at,
      bridge_status: lookup.receipt.bridge_status,
      join_rate: lookup.receipt.join_rate,
      threshold: lookup.receipt.threshold,
      false_positives: lookup.receipt.false_positives,
      unreviewed_candidates: lookup.receipt.unreviewed_candidates,
    },
    corpus: {
      notices: lookup.notice_count,
      projects: n,
      request_ids: Object.keys(lookup.by_notice || {}).sort(),
    },
    fields: {
      company: { present: fieldCounts.company, total: n, rate: rate(fieldCounts.company, n) },
      address: { present: fieldCounts.address, total: n, rate: rate(fieldCounts.address, n) },
      requested_benefit: {
        present: fieldCounts.requested_benefit,
        total: n,
        rate: rate(fieldCounts.requested_benefit, n),
      },
      estimated_public_cost: {
        present: fieldCounts.estimated_public_cost,
        total: n,
        rate: rate(fieldCounts.estimated_public_cost, n),
      },
      project_cost: {
        present: fieldCounts.project_cost,
        total: n,
        rate: rate(fieldCounts.project_cost, n),
      },
      any_money: { present: fieldCounts.any_money, total: n, rate: any_money_rate },
    },
    stages: stageCounts,
    policy: {
      source_null_stays_null: true,
      invent_money_from_siblings: false,
      invent_outcome_from_hearing: false,
      reader_surface: "show positive facts only; omit empty slots (no class-(b) mask)",
    },
    verdict: {
      parent_bridge: "accepted",
      company_place_ready: fieldCounts.company === n && fieldCounts.address === n,
      money_partial: any_money_rate != null && any_money_rate > 0 && any_money_rate < 1,
      board_decision_ready: stageCounts.board_decision.date === n
        && stageCounts.board_decision.outcome === n,
      later_stages_honest_absent: stageCounts.closing.date === 0 && stageCounts.compliance.date === 0,
    },
  };
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const lookup = readJson(LOOKUP_PATH);
  const receipt = measureRc2DependentFields(lookup);
  const text = `${JSON.stringify(receipt, null, 2)}\n`;

  if (args.check) {
    const existing = readFileSync(OUT_PATH, "utf8");
    assert.equal(existing, text, "RC-2 dependent field coverage receipt drifted");
    console.log(`ok ${path.relative(ROOT, OUT_PATH)}`);
    return;
  }

  if (args.write) {
    mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    writeFileSync(OUT_PATH, text);
    console.log(`wrote ${path.relative(ROOT, OUT_PATH)}`);
  }

  console.log(JSON.stringify({
    projects: receipt.corpus.projects,
    company_rate: receipt.fields.company.rate,
    address_rate: receipt.fields.address.rate,
    any_money_rate: receipt.fields.any_money.rate,
    board_decision_date_rate: receipt.stages.board_decision.date_rate,
    board_decision_outcome_rate: receipt.stages.board_decision.outcome_rate,
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
