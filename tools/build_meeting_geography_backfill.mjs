#!/usr/bin/env node
/**
 * Restartable meeting-geography backfill over the pinned shared meeting corpus.
 *
 * Extends the production meeting / district-activity harnesses by stamping
 * admitted location assertions and parcel memberships onto shared meeting rows
 * so published meeting slices and district activity stay precomputed.
 *
 *   node tools/build_meeting_geography_backfill.mjs --backfill
 *   node tools/build_meeting_geography_backfill.mjs --backfill --resume
 *   node tools/build_meeting_geography_backfill.mjs --check
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  communityDistrictIdFromBoardOntology,
} from "../site/community_board_geography.mjs";
import {
  BACKFILL_OUTCOME,
  MEETING_GEOGRAPHY_BACKFILL_MANIFEST_SCHEMA,
  MEETING_GEOGRAPHY_BACKFILL_SCHEMA,
  activateMeetingGeographyBackfill,
  collectAddressCandidates,
  createMeetingGeographyBackfill,
  loadActiveMeetingGeographyBackfill,
  stampMeetingRowsWithGeography,
} from "../site/meeting_geography_backfill.mjs";
import {
  PARCEL_GEOGRAPHY_MANIFEST_PATH,
  lookupParcelMemberships,
  parcelShardKey,
} from "../site/parcel_geography.mjs";
import {
  createRecordAddressResolutionCache,
} from "../site/record_address_resolution_cache.mjs";
import {
  createRecordLocationMembershipProjection,
} from "../site/record_location_memberships.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHARED_MEETING_PATH = path.join(ROOT, "site/data/shared_meeting_read_model.json");
const COMMUNITY_BOARD_GEOGRAPHY_PATH = path.join(ROOT, "site/data/community_board_geography_lookup.json");
const ADDRESS_MANIFEST_PATH = path.join(ROOT, "site/data/address-index/manifest.json");
const ADDRESS_DIR = path.join(ROOT, "site/data/address-index");
const PARCEL_DIR = path.join(ROOT, "site/data/parcel-geography");
const PUBLIC_DIR = path.join(ROOT, "site/data/meeting-geography-backfill");
const EVIDENCE_DIR = path.join(ROOT, "docs/evidence/meeting-geography-backfill");
const CHECKPOINT_PATH = path.join(PUBLIC_DIR, "checkpoint.json");

function loadJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function parseArgs(argv) {
  const args = {
    backfill: false,
    resume: false,
    check: false,
    interruptAfter: null,
    failBeforeActivate: false,
    publicDir: PUBLIC_DIR,
    sharedMeetingPath: SHARED_MEETING_PATH,
    writeSharedModel: true,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--backfill") args.backfill = true;
    else if (token === "--resume") args.resume = true;
    else if (token === "--check") args.check = true;
    else if (token === "--no-write-shared-model") args.writeSharedModel = false;
    else if (token === "--fail-before-activate") args.failBeforeActivate = true;
    else if (token === "--interrupt-after") {
      args.interruptAfter = Number(argv[++index]);
    } else if (token === "--public-dir") {
      args.publicDir = path.resolve(argv[++index]);
    } else if (token === "--shared-meeting") {
      args.sharedMeetingPath = path.resolve(argv[++index]);
    } else if (token === "--help" || token === "-h") {
      args.help = true;
    } else {
      throw new Error(`unknown argument: ${token}`);
    }
  }
  return args;
}

function shardLoader(dir) {
  const cache = new Map();
  return (shardKey) => {
    const key = String(shardKey || "");
    if (cache.has(key)) return cache.get(key);
    const filePath = path.join(dir, `${key}.json`);
    if (!existsSync(filePath)) {
      cache.set(key, null);
      return null;
    }
    const doc = loadJson(filePath);
    cache.set(key, doc);
    return doc;
  };
}

function buildRunner() {
  const addressManifest = loadJson(ADDRESS_MANIFEST_PATH);
  const parcelManifest = loadJson(path.join(ROOT, PARCEL_GEOGRAPHY_MANIFEST_PATH));
  const communityBoardGeography = loadJson(COMMUNITY_BOARD_GEOGRAPHY_PATH);
  const loadAddressShard = shardLoader(ADDRESS_DIR);
  const loadParcelShard = shardLoader(PARCEL_DIR);

  const addressCache = createRecordAddressResolutionCache({
    manifest: addressManifest,
    loadShard: loadAddressShard,
  });
  const membershipProjection = createRecordLocationMembershipProjection({
    loadParcelShard,
    parcelMembershipGeneration: parcelManifest.membership?.generated_at
      || parcelManifest.coordinate_vintage
      || parcelManifest.generated_at
      || null,
  });

  return createMeetingGeographyBackfill({
    addressCache,
    membershipProjection,
    communityBoardGeography,
    lookupParcelPoint: (bbl) => {
      const shard = loadParcelShard(parcelShardKey(bbl));
      const bundle = lookupParcelMemberships(shard, bbl);
      if (!bundle) return null;
      return { lat: bundle.lat, lon: bundle.lon };
    },
  });
}

function summarizeCandidates(rows) {
  const distinct = new Set();
  let bearing = 0;
  for (const row of rows) {
    const candidates = collectAddressCandidates(row);
    if (!candidates.length) continue;
    bearing += 1;
    for (const candidate of candidates) distinct.add(candidate.value);
  }
  return {
    canonical_meeting_count: rows.length,
    address_bearing_rows: bearing,
    distinct_address_strings: distinct.size,
  };
}

function writeEvidence(outcomesDocument, manifest) {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(
    path.join(EVIDENCE_DIR, "per-id-outcomes.json"),
    `${JSON.stringify(outcomesDocument, null, 2)}\n`,
  );
  writeFileSync(
    path.join(EVIDENCE_DIR, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

export function runMeetingGeographyBackfill({
  sharedMeetingPath = SHARED_MEETING_PATH,
  publicDir = PUBLIC_DIR,
  resume = true,
  interruptAfter = null,
  failBeforeActivate = false,
  writeSharedModel = true,
  runner = null,
  now = () => new Date().toISOString(),
} = {}) {
  const shared = loadJson(sharedMeetingPath);
  const rows = Array.isArray(shared?.rows) ? shared.rows : [];
  if (!rows.length) throw new Error("shared meeting read model has no rows");

  const candidateSummary = summarizeCandidates(rows);
  const builtAt = now();
  const sourceGenerationHash = createHashish(shared);
  const generation = `gen-${sourceGenerationHash.slice(0, 12)}-${builtAt.slice(0, 10)}`;

  mkdirSync(publicDir, { recursive: true });
  const checkpointPath = path.join(publicDir, "checkpoint.json");
  const priorCheckpoint = resume && existsSync(checkpointPath)
    ? loadJson(checkpointPath)
    : null;

  const activeRunner = runner || buildRunner();
  let result;
  try {
    result = activeRunner.run({
      rows,
      checkpoint: priorCheckpoint?.generation === generation ? priorCheckpoint : null,
      generation,
      sourceGenerationHash,
      interruptAfter,
      observedAt: builtAt,
      onCheckpoint: (state) => {
        writeFileSync(checkpointPath, `${JSON.stringify(state, null, 2)}\n`);
      },
    });
  } catch (error) {
    if (error?.checkpoint) {
      writeFileSync(checkpointPath, `${JSON.stringify(error.checkpoint, null, 2)}\n`);
    }
    throw error;
  }

  const outcomesDocument = {
    schema: "cityscroll.meeting_geography_backfill_outcomes.v1",
    generation,
    source_generation_hash: sourceGenerationHash,
    built_at: builtAt,
    candidate_input: candidateSummary,
    counts: result.counts,
    positive_record: {
      meeting_id: "meeting:community_board:https://cb14brooklyn.com/meeting/housing-and-land-use-committee-meeting-september-2026/",
      expected_nta2020: "BK1403",
      expected_role: "venue",
    },
    outcomes: result.outcomes.map((outcome) => ({
      meeting_id: outcome.meeting_id,
      input_hash: outcome.input_hash,
      outcome: outcome.outcome,
      address_candidate_count: outcome.address_candidate_count,
      address_candidates: outcome.address_candidates,
      assertion_ids: outcome.assertion_ids,
      memberships: outcome.memberships,
      edge_count: outcome.edge_count,
      processed_at: outcome.processed_at,
      // Delivery retains assertions for the named positive record and physical
      // venue rows so Midwood membership is inspectable without re-running.
      ...(outcome.outcome === BACKFILL_OUTCOME.PHYSICAL_VENUE
        || outcome.meeting_id === "meeting:community_board:https://cb14brooklyn.com/meeting/housing-and-land-use-committee-meeting-september-2026/"
        ? { assertions: outcome.assertions }
        : {}),
    })),
  };

  const stampedRows = stampMeetingRowsWithGeography(rows, result.outcomes);
  const stampedShared = {
    ...shared,
    rows: stampedRows,
    hearings: Array.isArray(shared.hearings)
      ? stampMeetingRowsWithGeography(shared.hearings, result.outcomes)
      : shared.hearings,
    geography_backfill: {
      generation,
      built_at: builtAt,
      counts: result.counts,
      candidate_input: candidateSummary,
    },
  };

  const manifest = {
    schema: MEETING_GEOGRAPHY_BACKFILL_MANIFEST_SCHEMA,
    generation,
    built_at: builtAt,
    source_generation_hash: sourceGenerationHash,
    shared_meeting_schema: shared.schema || null,
    shared_meeting_generated_at: shared.generated_at || null,
    candidate_input: candidateSummary,
    counts: result.counts,
    positive_record: outcomesDocument.positive_record,
  };

  const activation = activateMeetingGeographyBackfill({
    publicDir,
    generation,
    manifest,
    outcomesDocument,
    projectionDocument: result.projection,
    stampedSharedMeetingModel: writeSharedModel ? stampedShared : null,
    sharedMeetingReadModelPath: writeSharedModel ? sharedMeetingPath : null,
    failBeforeActivate,
  });

  writeEvidence(outcomesDocument, {
    ...manifest,
    active_generation: activation.generation,
  });

  // Clear checkpoint after successful activation so a later resume starts clean
  // only when the source hash changes.
  writeFileSync(checkpointPath, `${JSON.stringify({
    ...result.checkpoint,
    completed: true,
    activated_generation: activation.generation,
  }, null, 2)}\n`);

  return {
    schema: MEETING_GEOGRAPHY_BACKFILL_SCHEMA,
    activation,
    manifest,
    counts: result.counts,
    candidate_input: candidateSummary,
    outcomes_path: path.join(publicDir, "per-id-outcomes.json"),
    evidence_path: path.join(EVIDENCE_DIR, "per-id-outcomes.json"),
  };
}

function createHashish(shared) {
  const ids = (shared?.rows || []).map((row) => row?.meeting_id || "").join("\n");
  return createHash("sha256")
    .update(`${shared?.generated_at || ""}\n${ids}`)
    .digest("hex");
}

function checkBackfill(publicDir = PUBLIC_DIR, sharedMeetingPath = SHARED_MEETING_PATH) {
  const active = loadActiveMeetingGeographyBackfill(publicDir);
  if (!active?.manifest || !active?.outcomes) {
    throw new Error("meeting geography backfill is not activated");
  }
  const shared = loadJson(sharedMeetingPath);
  const rows = shared.rows || [];
  const candidateSummary = summarizeCandidates(rows);
  const outcomes = active.outcomes.outcomes || [];
  if (outcomes.length !== rows.length) {
    throw new Error(`outcome count ${outcomes.length} != shared rows ${rows.length}`);
  }
  if (candidateSummary.address_bearing_rows !== active.manifest.candidate_input?.address_bearing_rows) {
    throw new Error("address-bearing candidate count drifted from active manifest");
  }
  const sept23 = outcomes.find((row) => row.meeting_id === active.outcomes.positive_record?.meeting_id
    || row.meeting_id === "meeting:community_board:https://cb14brooklyn.com/meeting/housing-and-land-use-committee-meeting-september-2026/");
  if (!sept23) throw new Error("September 23 positive record missing from outcomes");
  const venue = (sept23.memberships || []).find((membership) => membership.role === "venue");
  if (!venue || venue.memberships?.nta2020 !== "BK1403") {
    throw new Error("September 23 venue membership is not BK1403");
  }
  const stamped = rows.find((row) => row.meeting_id === sept23.meeting_id);
  if (!stamped?.location_memberships?.some((membership) => membership.role === "venue"
    && membership.memberships?.nta2020 === "BK1403")) {
    throw new Error("shared meeting read model is missing stamped September 23 BK1403 venue membership");
  }
  // OATH location-free rows must remain unclassified as physical.
  const oathPhysical = outcomes.filter((row) => {
    const sharedRow = rows.find((candidate) => candidate.meeting_id === row.meeting_id);
    return sharedRow?.source_system === "oath_trial_calendar"
      && row.outcome === BACKFILL_OUTCOME.PHYSICAL_VENUE;
  });
  if (oathPhysical.length) {
    throw new Error(`OATH rows incorrectly classified physical: ${oathPhysical.length}`);
  }
  console.log(
    `ok meeting-geography-backfill generation=${active.pointer.active_generation} `
    + `rows=${outcomes.length} address_bearing=${candidateSummary.address_bearing_rows} `
    + `distinct_addresses=${candidateSummary.distinct_address_strings} `
    + `physical_venue=${active.manifest.counts?.by_outcome?.physical_venue || 0}`,
  );
  return active;
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(`Usage:
  node tools/build_meeting_geography_backfill.mjs --backfill [--resume]
  node tools/build_meeting_geography_backfill.mjs --check`);
    return;
  }
  if (args.check) {
    checkBackfill(args.publicDir, args.sharedMeetingPath);
    return;
  }
  if (!args.backfill) {
    throw new Error("pass --backfill or --check");
  }
  const result = runMeetingGeographyBackfill({
    sharedMeetingPath: args.sharedMeetingPath,
    publicDir: args.publicDir,
    resume: args.resume || true,
    interruptAfter: args.interruptAfter,
    failBeforeActivate: args.failBeforeActivate,
    writeSharedModel: args.writeSharedModel,
  });
  console.log(
    `wrote meeting geography backfill generation=${result.activation.generation} `
    + `rows=${result.counts.processed_rows} `
    + `address_bearing=${result.candidate_input.address_bearing_rows} `
    + `distinct_addresses=${result.candidate_input.distinct_address_strings} `
    + `physical_venue=${result.counts.by_outcome.physical_venue || 0}`,
  );
}

const isDirect = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirect) {
  try {
    main();
  } catch (error) {
    console.error(error?.stack || error);
    process.exitCode = 1;
  }
}

export {
  buildRunner,
  checkBackfill,
  summarizeCandidates,
  COMMUNITY_BOARD_GEOGRAPHY_PATH,
  SHARED_MEETING_PATH,
  PUBLIC_DIR,
  EVIDENCE_DIR,
  communityDistrictIdFromBoardOntology,
};
