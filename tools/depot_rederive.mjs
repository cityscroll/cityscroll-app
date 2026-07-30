#!/usr/bin/env node
// Post-ingest depot re-derivation: refresh join-graph coverage, enumerate
// candidate crosswalks, re-classify gaps, re-rank the ingest queue, and emit a
// receipt. CI runs `--check` as a drift gate (writes nothing; fails if the
// committed registry is stale relative to its own re-derivation).
//
//   node tools/depot_rederive.mjs
//   node tools/depot_rederive.mjs --check
//   node tools/depot_rederive.mjs --receipt site/data/depot_receipts/latest.json

import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  GAP_DOC_PATH,
  GAP_TAXONOMY_PATH,
  DEPOT_RECEIPT_DIR,
  checkDepotFreshness,
  formatRegistryJson,
  loadGapTaxonomy,
  loadSourceContracts,
  rederiveDepot,
  renderGapTaxonomyDocument,
} from "./depot.mjs";

function parseArgs(argv) {
  const args = {
    check: false,
    receipt: null,
    write: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") {
      args.check = true;
      args.write = false;
    } else if (a === "--receipt") {
      args.receipt = argv[++i];
    } else if (a === "--help" || a === "-h") {
      args.help = true;
    }
  }
  return args;
}

function defaultReceiptPath(observedOn) {
  return join(DEPOT_RECEIPT_DIR, `depot_rederive_${observedOn}.json`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Usage:
  node tools/depot_rederive.mjs              Write refreshed registry + docs + receipt
  node tools/depot_rederive.mjs --check      Fail if committed registry is stale (CI)
  node tools/depot_rederive.mjs --receipt p  Write receipt to path p
`);
    return;
  }

  const registry = loadGapTaxonomy();
  const sourceContracts = loadSourceContracts();
  const observedOn = new Date().toISOString().slice(0, 10);

  if (args.check) {
    const result = checkDepotFreshness(registry, sourceContracts, { observedOn });
    if (!result.ok) {
      console.error("depot re-derivation drift gate FAILED:");
      for (const m of result.mismatches) console.error(`  - ${m}`);
      console.error("\nFix: run `node tools/depot_rederive.mjs` and commit the refreshed registry.");
      if (result.receipt.class_changes_loud?.length) {
        console.error("\nClass changes in re-derivation:");
        for (const line of result.receipt.class_changes_loud) console.error(`  ${line}`);
      }
      process.exitCode = 1;
      return;
    }
    console.log(
      `depot registry current (sources=${result.receipt.sources_count}`
      + `, materialized=${result.receipt.materialized_crosswalks.length}`
      + `, candidates=${result.receipt.candidate_crosswalks.length}`
      + `, class_changes=${result.receipt.class_changes.length})`,
    );
    if (result.receipt.passport_field_case) {
      const p = result.receipt.passport_field_case;
      console.log(
        `  passport field case: predicted=${p.predicted_grade}`
        + ` realized_either=${p.realized_either_rate}`
        + ` epin_in_graph=${p.epin_in_graph}`
        + ` checkbook_candidates=${p.passport_checkbook_candidates.length}`,
      );
    }
    return;
  }

  const { registry: next, receipt } = rederiveDepot(registry, sourceContracts, { observedOn });
  const doc = renderGapTaxonomyDocument(next);

  if (args.write) {
    writeFileSync(GAP_TAXONOMY_PATH, formatRegistryJson(next));
    writeFileSync(GAP_DOC_PATH, doc.endsWith("\n") ? doc : `${doc}\n`);

    const receiptPath = args.receipt || defaultReceiptPath(observedOn);
    mkdirSync(dirname(receiptPath), { recursive: true });
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

    // Also stamp a stable "latest" pointer for local inspection
    const latest = join(DEPOT_RECEIPT_DIR, "latest.json");
    writeFileSync(latest, `${JSON.stringify(receipt, null, 2)}\n`);

    console.log(`wrote ${GAP_TAXONOMY_PATH}`);
    console.log(`wrote ${GAP_DOC_PATH}`);
    console.log(`wrote ${receiptPath}`);
  }

  if (receipt.class_changes_loud?.length) {
    console.log("\n*** CLASS CHANGES ***");
    for (const line of receipt.class_changes_loud) console.log(line);
  }
  const p = receipt.passport_field_case;
  console.log(
    `passport: predicted=${p.predicted_grade} realized_either=${p.realized_either_rate}`
    + ` (${p.realized_either_joined}/${p.realized_either_total})`
    + ` epin_in_graph=${p.epin_in_graph}`,
  );
  console.log(
    `crosswalks: materialized=${receipt.materialized_crosswalks.length}`
    + ` candidates=${receipt.candidate_crosswalks.length}`,
  );
  const yes = receipt.candidate_crosswalks.filter((c) => c.worth_materializing === "yes");
  if (yes.length) {
    console.log("worth-materializing candidates:");
    for (const c of yes) console.log(`  - ${c.id} score=${c.score} keys=${c.key_path.join(",")}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main();
}
