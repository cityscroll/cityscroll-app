// Densify OTI agency former-name / successor edges into the agency crosswalk.
//
// Run:
//   node tools/build_agency_successors.mjs              # live SODA + write artifacts
//   node tools/build_agency_successors.mjs --fixture     # offline fixture path
//   node tools/build_agency_successors.mjs --check       # verify receipt + precision bar
//   node tools/build_agency_successors.mjs --dry         # measure only
//
// Materializes former_names stamps on the crosswalk only when the dated kill
// sample clears ≥95% precision with zero hard-negative merges.
//
// Home cold path: residual renames land in site/agency_identity.mjs
// AGENCY_GROUPS / ROUTE_ALIAS_TARGETS (not a bulk browser alias module).

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveAgencyIdentity } from "../site/agency_identity.mjs";
import {
  AGENCY_SUCCESSOR_PRECISION_FLOOR,
  AGENCY_SUCCESSOR_SOURCE_ID,
  densifyCrosswalkWithSuccessors,
  extractSuccessorEdges,
  measureSuccessorKillSample,
} from "./lib/agency_successors.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const FIXTURE = join(ROOT, "test/fixtures/agency_successors/oti_former_names_sample.json");
const CROSSWALK = join(ROOT, "worker/src/data/agency_crosswalk.json");
const RECEIPT_DIR = join(ROOT, "site/data/agency_sources/verification_receipts");
const EVIDENCE_DIR = join(ROOT, "docs/evidence/agency-successors");
const SODA = "https://data.cityofnewyork.us/resource";

function argsOf(argv) {
  return {
    fixture: argv.includes("--fixture"),
    check: argv.includes("--check"),
    dry: argv.includes("--dry"),
  };
}

async function loadRoster({ fixture }) {
  if (fixture) {
    const payload = JSON.parse(readFileSync(FIXTURE, "utf8"));
    return {
      rows: payload.rows || [],
      downloaded: payload._provenance?.downloaded || null,
      mode: "fixture",
      parent_roster_rows: payload._provenance?.parent_roster_rows || null,
    };
  }
  const url = `${SODA}/${AGENCY_SUCCESSOR_SOURCE_ID}.json?${new URLSearchParams({
    $limit: "2000",
    $select: "name,acronym,alternate_or_former_names,alternate_or_former_acronyms,operational_status,organization_type,record_id",
  })}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`SODA ${AGENCY_SUCCESSOR_SOURCE_ID} ${res.status}: ${await res.text()}`);
  const rows = await res.json();
  return {
    rows,
    downloaded: new Date().toISOString().slice(0, 10),
    mode: "live",
    parent_roster_rows: rows.length,
  };
}

function productResolve(raw) {
  // Product path: residual renames are densified into AGENCY_GROUPS so the
  // browser cold path stays free of a bulk alias payload.
  return resolveAgencyIdentity(raw);
}

function buildReceipt({ roster, edges, measured, stamped }) {
  return {
    schema: "cityscroll.agency_successor_kill_sample.v1",
    as_of: measured.as_of,
    downloaded: roster.downloaded,
    mode: roster.mode,
    source: {
      id: AGENCY_SUCCESSOR_SOURCE_ID,
      name: "NYC Agencies and Governance Organizations",
      attribution: "Office of Technology and Innovation (OTI)",
      url: `https://data.cityofnewyork.us/d/${AGENCY_SUCCESSOR_SOURCE_ID}`,
      parent_roster_rows: roster.parent_roster_rows,
      former_name_rows: roster.rows.filter(
        (r) => r.alternate_or_former_names || r.alternate_or_former_acronyms,
      ).length,
    },
    precision_floor: AGENCY_SUCCESSOR_PRECISION_FLOOR,
    edges: {
      extracted: edges.length,
      // Browser residual densify is AGENCY_GROUPS, not a bulk alias module.
      home_cold_path: "agency_groups_residual_only",
    },
    kill_sample: {
      positives: measured.positives,
      negatives: measured.negatives,
    },
    rates: measured.rates,
    precision: measured.precision,
    clears_precision_bar: measured.clears_precision_bar,
    materialize_edges: measured.materialize_edges,
    crosswalk_stamp: stamped,
    residual: {
      // Product path residual (GROUPS densify already applied in site code).
      before: measured.positives.residual_before,
      after: measured.positives.residual_after,
      fixed: measured.positives.fixed,
      fix_rate_on_residual: measured.positives.fix_rate_on_residual,
      product_positive_coverage: measured.rates.positive_coverage_after,
    },
  };
}

async function main() {
  const args = argsOf(process.argv.slice(2));
  const roster = await loadRoster(args);
  const edges = extractSuccessorEdges(roster.rows);
  // Measure the live product resolve path (GROUPS residual densify).
  const measured = measureSuccessorKillSample({
    edges,
    baseResolve: productResolve,
    densifiedResolve: productResolve,
  });
  const crosswalk = JSON.parse(readFileSync(CROSSWALK, "utf8"));
  const densified = densifyCrosswalkWithSuccessors(crosswalk, edges, {
    materialize: measured.materialize_edges,
  });
  const stamped = {
    stamped_entries: densified.stampedEntries,
    stamped_surfaces: densified.stampedSurfaces,
    applied_count: densified.applied.length,
  };
  const receipt = buildReceipt({ roster, edges, measured, stamped });

  console.log(
    `OTI successors: ${edges.length} edges from ${roster.mode} roster ` +
    `(${receipt.source.former_name_rows} former-name rows).`,
  );
  console.log(
    `Kill sample precision=${(measured.precision * 100).toFixed(1)}% ` +
    `(floor ${(AGENCY_SUCCESSOR_PRECISION_FLOOR * 100).toFixed(0)}%) ` +
    `product coverage ${measured.positives.resolved_after}/${measured.positives.total} ` +
    `false_merges=${measured.negatives.false_merges}`,
  );
  if (measured.collisions.length) {
    console.log(`Alias collisions dropped: ${measured.collisions.length}`);
  }

  if (args.check) {
    const receiptPath = join(RECEIPT_DIR, `agency_successors_${measured.as_of}.json`);
    const committed = JSON.parse(readFileSync(receiptPath, "utf8"));
    if (!committed.clears_precision_bar) {
      throw new Error("committed receipt does not clear precision bar");
    }
    if (committed.precision < AGENCY_SUCCESSOR_PRECISION_FLOOR) {
      throw new Error(`committed precision ${committed.precision} below floor`);
    }
    if (committed.kill_sample?.negatives?.false_merges > 0) {
      throw new Error("committed receipt has false merges");
    }
    if (!measured.clears_precision_bar) {
      throw new Error("live/fixture recompute no longer clears precision bar");
    }
    if (measured.positives.resolved_after !== measured.positives.total) {
      throw new Error("product path does not resolve every kill-sample positive");
    }
    console.log(`--check ok: ${receiptPath}`);
    return;
  }

  if (args.dry) {
    console.log("--dry: nothing written.");
    console.log(JSON.stringify({
      precision: measured.precision,
      materialize: measured.materialize_edges,
      product_positive_coverage: measured.rates.positive_coverage_after,
      false_merges: measured.negatives.false_merges,
    }, null, 2));
    return;
  }

  if (!measured.materialize_edges) {
    throw new Error(
      `Successor densify stopped below precision bar ` +
      `(precision=${measured.precision}, false_merges=${measured.negatives.false_merges}). ` +
      `Crosswalk not updated.`,
    );
  }

  mkdirSync(RECEIPT_DIR, { recursive: true });
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const receiptPath = join(RECEIPT_DIR, `agency_successors_${measured.as_of}.json`);
  const evidencePath = join(EVIDENCE_DIR, "kill-sample.json");
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
  writeFileSync(evidencePath, JSON.stringify(receipt, null, 2) + "\n");
  writeFileSync(CROSSWALK, JSON.stringify(densified.crosswalk, null, 2) + "\n");
  console.log(`Wrote ${receiptPath}`);
  console.log(`Wrote ${evidencePath}`);
  console.log(
    `Updated ${CROSSWALK} ` +
    `(stamped ${densified.stampedEntries} entries / ${densified.stampedSurfaces} surfaces)`,
  );
  console.log("Home cold path: residual renames live in site/agency_identity.mjs AGENCY_GROUPS.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
