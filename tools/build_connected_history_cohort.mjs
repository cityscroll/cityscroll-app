#!/usr/bin/env node
/**
 * Freeze the connected-history evaluation cohort from retained inputs only.
 *
 *   node tools/build_connected_history_cohort.mjs
 *   node tools/build_connected_history_cohort.mjs --check
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONNECTED_HISTORY_EVALUATION_SEED,
  freezeConnectedHistoryCohort,
} from "./lib/connected_history_cohort.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "site/data/connected_history_evaluation_cohort.json");
const RECEIPT = join(
  ROOT,
  "site/data/connected_history_sources/verification_receipts/connected_history_evaluation_cohort_latest.json",
);

const checkOnly = process.argv.includes("--check");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function fileDigest(path) {
  const body = readFileSync(path);
  return {
    path: path.slice(ROOT.length + 1),
    sha256: createHash("sha256").update(body).digest("hex"),
    bytes: body.length,
  };
}

function loadInputs() {
  const constellationPath = join(ROOT, "site/data/community_board_constellation_lookup.json");
  const zapPath = join(ROOT, "site/data/zap_projects_warehouse_lookup.json");
  const landPath = join(ROOT, "site/data/community_board_land_positions.json");
  const lifecycleManifestPath = join(ROOT, "site/data/site_lifecycle/manifest.json");
  const lifecycleShardPath = join(ROOT, "site/data/site_lifecycle/0000.json");
  const bsaPath = join(ROOT, "site/data/bsa_calendar.json");

  const constellation = readJson(constellationPath);
  const zap = readJson(zapPath);
  const land = readJson(landPath);
  const lifecycleManifest = readJson(lifecycleManifestPath);
  const lifecycleShard = readJson(lifecycleShardPath);
  const bsa = readJson(bsaPath);

  const boardIds = Object.keys(constellation.by_id || {}).sort();

  // Lifecycle members already encode explicit parcel↔application↔project links.
  const explicitRelationsBySubject = {};
  for (const parcel of lifecycleShard.rows || []) {
    const parcelId = `parcel:${parcel.parcel_id}`;
    const relations = [];
    for (const member of parcel.members || []) {
      for (const rel of member.relation_path || []) {
        if (!rel) continue;
        relations.push({
          from: member.subject_id || parcelId,
          to: rel,
          relation: "site_lifecycle_member",
        });
      }
    }
    if (relations.length) explicitRelationsBySubject[parcelId] = relations;
    for (const member of parcel.members || []) {
      const subjectId = member.subject_id;
      if (!subjectId) continue;
      const memberRelations = (member.relation_path || []).map((rel) => ({
        from: subjectId,
        to: rel,
        relation: "site_lifecycle_member",
      }));
      if (memberRelations.length) {
        explicitRelationsBySubject[subjectId] = [
          ...(explicitRelationsBySubject[subjectId] || []),
          ...memberRelations,
        ];
      }
    }
  }

  return {
    boardIds,
    zapProjects: zap.rows || [],
    landPositionsByBoard: land.boards || {},
    siteLifecycleParcels: lifecycleShard.rows || [],
    bsaMeetings: bsa.rows || [],
    explicitRelationsBySubject,
    sourceVersions: {
      seed: CONNECTED_HISTORY_EVALUATION_SEED,
      boards_registry: {
        artifact: fileDigest(constellationPath),
        board_count: boardIds.length,
        generated_at: constellation.generated_at || null,
      },
      zap_projects: {
        artifact: fileDigest(zapPath),
        materialized_at: zap.materialized_at || null,
        row_count: zap.row_count ?? (zap.rows || []).length,
        mode: zap.mode || null,
      },
      board_land_positions: {
        artifact: fileDigest(landPath),
        generated_at: land.generated_at || null,
        retained_projects: land.counts?.retained_projects ?? null,
        boards_with_positions: land.counts?.boards_with_positions ?? null,
      },
      site_lifecycle: {
        manifest: fileDigest(lifecycleManifestPath),
        shard: fileDigest(lifecycleShardPath),
        generation: lifecycleManifest.generation || lifecycleShard.generation || null,
        counts: lifecycleManifest.counts || null,
      },
      bsa_calendar: {
        artifact: fileDigest(bsaPath),
        generated_at: bsa.generated_at || null,
        meeting_count: (bsa.rows || []).length,
      },
      dot_edc_tranche: {
        status: "unavailable",
        reason: "bounded_dossier_urls_not_yet_retained_as_source_bundles",
      },
    },
  };
}

function cohortReceipt(cohort) {
  return {
    schema: "cityscroll.connected_history_evaluation_cohort_receipt.v1",
    version: 1,
    seed: cohort.seed,
    selection_hash: cohort.selection_hash,
    denominators: cohort.denominators,
    sample_size: cohort.sample.length,
    judgment_counts: cohort.judgments.reduce((acc, row) => {
      acc[row.judgment] = (acc[row.judgment] || 0) + 1;
      return acc;
    }, {}),
    baseline_phase: cohort.baseline.phase,
    artifact: "site/data/connected_history_evaluation_cohort.json",
  };
}

const inputs = loadInputs();
const cohort = freezeConnectedHistoryCohort(inputs, {
  seed: CONNECTED_HISTORY_EVALUATION_SEED,
});
const receipt = cohortReceipt(cohort);

if (checkOnly) {
  const existing = readJson(OUT);
  const existingReceipt = readJson(RECEIPT);
  if (JSON.stringify(existing) !== JSON.stringify(cohort)) {
    console.error("connected_history_evaluation_cohort.json is stale — re-run without --check");
    process.exit(1);
  }
  if (JSON.stringify(existingReceipt) !== JSON.stringify(receipt)) {
    console.error("connected_history_evaluation_cohort_latest.json is stale — re-run without --check");
    process.exit(1);
  }
  console.log("ok connected history evaluation cohort is current");
  process.exit(0);
}

writeFileSync(OUT, `${JSON.stringify(cohort, null, 2)}\n`);
writeFileSync(RECEIPT, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      selection_hash: cohort.selection_hash,
      sample_size: cohort.sample.length,
      denominators: cohort.denominators,
      out: [OUT, RECEIPT],
    },
    null,
    2,
  ),
);
