// Densify OTI agency former-name / successor edges into the agency crosswalk
// and the site resolve alias table.
//
// Run:
//   node tools/build_agency_successors.mjs              # live SODA + write artifacts
//   node tools/build_agency_successors.mjs --fixture     # offline fixture path
//   node tools/build_agency_successors.mjs --check       # verify receipt + precision bar
//   node tools/build_agency_successors.mjs --dry         # measure only
//
// Materializes successor edges only when the dated kill sample clears ≥95%
// precision with zero hard-negative merges.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveAgencyIdentity } from "../site/agency_identity.mjs";
import {
  AGENCY_SUCCESSOR_PRECISION_FLOOR,
  AGENCY_SUCCESSOR_SOURCE_ID,
  densifyCrosswalkWithSuccessors,
  extractSuccessorEdges,
  materializeSuccessorAliasMap,
  measureSuccessorKillSample,
  renderSuccessorAliasModule,
} from "./lib/agency_successors.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const FIXTURE = join(ROOT, "test/fixtures/agency_successors/oti_former_names_sample.json");
const CROSSWALK = join(ROOT, "worker/src/data/agency_crosswalk.json");
const ALIAS_MODULE = join(ROOT, "site/agency_successor_aliases.mjs");
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

function baseResolve(raw) {
  // Baseline without OTI successor densify (groups + route aliases only).
  return resolveAgencyIdentity(raw, { skipSuccessors: true });
}

function densifiedResolve(raw) {
  // Product path after the alias module is written. During the first build
  // pass we approximate with resolveWithSuccessors via measureSuccessorKillSample.
  return resolveAgencyIdentity(raw, { skipSuccessors: false });
}

function buildReceipt({ roster, edges, measured, stamped, aliasCount }) {
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
      alias_map: aliasCount,
      collisions: measured.collisions,
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
      before: measured.positives.residual_before,
      after: measured.positives.residual_after,
      fixed: measured.positives.fixed,
      fix_rate_on_residual: measured.positives.fix_rate_on_residual,
    },
  };
}

async function main() {
  const args = argsOf(process.argv.slice(2));
  const roster = await loadRoster(args);
  const edges = extractSuccessorEdges(roster.rows);
  const aliasMapDraft = materializeSuccessorAliasMap(edges, { baseResolve });
  // First-pass measure uses the pure alias map (module may still be stale).
  let measured = measureSuccessorKillSample({
    edges,
    baseResolve,
    aliasMap: aliasMapDraft,
  });
  const aliasMap = measured.materialize_edges ? aliasMapDraft : {};
  const crosswalk = JSON.parse(readFileSync(CROSSWALK, "utf8"));
  const densified = densifyCrosswalkWithSuccessors(crosswalk, edges, {
    materialize: measured.materialize_edges,
  });
  const stamped = {
    stamped_entries: densified.stampedEntries,
    stamped_surfaces: densified.stampedSurfaces,
    applied_count: densified.applied.length,
  };
  const receipt = buildReceipt({
    roster,
    edges,
    measured,
    stamped,
    aliasCount: Object.keys(aliasMap).length,
  });

  console.log(
    `OTI successors: ${edges.length} edges from ${roster.mode} roster ` +
    `(${receipt.source.former_name_rows} former-name rows).`,
  );
  console.log(
    `Kill sample precision=${(measured.precision * 100).toFixed(1)}% ` +
    `(floor ${(AGENCY_SUCCESSOR_PRECISION_FLOOR * 100).toFixed(0)}%) ` +
    `residual ${measured.positives.residual_before}→${measured.positives.residual_after} ` +
    `fixed=${measured.positives.fixed} false_merges=${measured.negatives.false_merges}`,
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
    if (committed.negatives?.false_merges > 0 || committed.kill_sample?.negatives?.false_merges > 0) {
      throw new Error("committed receipt has false merges");
    }
    // Recompute must still clear the bar on the fixture/live path used here.
    if (!measured.clears_precision_bar) {
      throw new Error("live/fixture recompute no longer clears precision bar");
    }
    console.log(`--check ok: ${receiptPath}`);
    return;
  }

  if (args.dry) {
    console.log("--dry: nothing written.");
    console.log(JSON.stringify({
      precision: measured.precision,
      materialize: measured.materialize_edges,
      residual_fix_rate: measured.positives.fix_rate_on_residual,
      fixed: measured.positives.fixed,
    }, null, 2));
    return;
  }

  if (!measured.materialize_edges) {
    throw new Error(
      `Successor densify stopped below precision bar ` +
      `(precision=${measured.precision}, false_merges=${measured.negatives.false_merges}). ` +
      `Crosswalk/aliases not updated.`,
    );
  }

  mkdirSync(RECEIPT_DIR, { recursive: true });
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const receiptPath = join(RECEIPT_DIR, `agency_successors_${measured.as_of}.json`);
  const evidencePath = join(EVIDENCE_DIR, "kill-sample.json");
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
  writeFileSync(evidencePath, JSON.stringify(receipt, null, 2) + "\n");
  writeFileSync(ALIAS_MODULE, renderSuccessorAliasModule(aliasMap, { asOf: measured.as_of }));
  writeFileSync(CROSSWALK, JSON.stringify(densified.crosswalk, null, 2) + "\n");
  console.log(`Wrote ${receiptPath}`);
  console.log(`Wrote ${evidencePath}`);
  console.log(`Wrote ${ALIAS_MODULE} (${Object.keys(aliasMap).length} aliases)`);
  console.log(
    `Updated ${CROSSWALK} ` +
    `(stamped ${densified.stampedEntries} entries / ${densified.stampedSurfaces} surfaces)`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
