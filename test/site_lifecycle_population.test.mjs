/**
 * Serve every admitted parcel and history shard.
 *
 *   node --test test/site_lifecycle_population.test.mjs
 */

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assembleSiteLifecycleDocument,
  createSiteLifecycleReader,
  materializeSiteLifecycle,
  shardSiteLifecycle,
} from "../site/site_lifecycle_projection.mjs";
import {
  loadSiteLifecycleContext,
  siteLifecycleMembersForSubject,
  SITE_LIFECYCLE_LOAD_FAILED_SCHEMA,
} from "../site/site_lifecycle_context.mjs";
import { writeSiteLifecycleProjection } from "../tools/build_site_lifecycle_projection.mjs";
import {
  assertProductionSiteLifecycleInputs,
  deriveSiteLifecyclePopulationStatus,
  materializeSiteLifecyclePopulation,
  observeSiteLifecyclePopulationStrata,
  readSiteLifecycleCallerInputs,
  runSiteLifecyclePopulationCaller,
  SITE_LIFECYCLE_POPULATION_EXPECTED_STRATA,
  SITE_LIFECYCLE_POPULATION_RECEIPT_SCHEMA,
} from "../tools/lib/site_lifecycle_population.mjs";
import { CONNECTED_HISTORY_DEMO_FAMILIES } from "../tools/lib/connected_history_cohort.mjs";
import { withTempDir } from "../tools/lib/with_temp_dir.mjs";
import { testClockISOString, withPinnedClock } from "./helpers/test_clock.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CALLER_INPUTS_PATH = join(
  ROOT,
  "warehouse/fixtures/site-lifecycle-population/kingsbridge_caller_inputs.json",
);
const POPULATION_RECEIPT_PATH = join(
  ROOT,
  "warehouse/receipts/proof/site_lifecycle_population_latest.json",
);
const COMMITTED_MANIFEST_PATH = join(ROOT, "site/data/site_lifecycle/manifest.json");

const KINGSBRIDGE_LOTS = ["2032470002", "2032470010"];

function ids(history) {
  return (history?.members || []).map((item) => item.subject_id);
}

function seedKingsbridgeInputs() {
  return readSiteLifecycleCallerInputs(CALLER_INPUTS_PATH);
}

test("A1: Kingsbridge multi-lot history is complete from every shard entry point", async () => withPinnedClock("2026-09-26T00:00:00.000Z", async () => withTempDir("site-lifecycle-population", async (outputDir) => {
  const inputs = seedKingsbridgeInputs();
  const document = materializeSiteLifecycle({
    landProjects: inputs.landProjects,
    projectLots: inputs.projectLots,
    procurementRecords: inputs.procurementRecords,
    generatedAt: testClockISOString(),
  });

  assert.deepEqual(Object.keys(document.parcels).sort(), KINGSBRIDGE_LOTS);
  assert.deepEqual(ids(document.parcels["2032470010"]), [
    "ceqr:08DME004X",
    "ceqr:13DME013X",
    "land:project:2025X0262",
    "ceqr:25DME006X",
  ]);
  assert.deepEqual(ids(document.parcels["2032470002"]), [
    "ceqr:13DME013X",
    "land:project:2025X0262",
    "ceqr:25DME006X",
  ]);
  assert.equal(document.members["land:project:2025X0262"].parcel_ids.join(), "2032470002,2032470010");
  assert.equal(document.members["ceqr:13DME013X"].parcel_ids.join(), "2032470002,2032470010");
  assert.equal(document.members["ceqr:08DME004X"].parcel_ids.join(), "2032470010");

  const shards = shardSiteLifecycle(document, 1);
  assert.equal(shards.length, 2, "small test shard limit must partition the two lots");
  assert.deepEqual(shards.map((shard) => shard.shard), ["0000", "0001"]);
  assert.deepEqual(shards.map((shard) => shard.rows.map((row) => row.parcel_id)), [
    ["2032470002"],
    ["2032470010"],
  ]);

  const manifest = writeSiteLifecycleProjection(document, {
    outputDir,
    receiptPath: join(outputDir, "membership.json"),
    shardSize: 1,
    sourceVintage: inputs.source_vintage,
    evidence: inputs.evidence,
    negativeRules: inputs.negative_rules,
  });
  assert.deepEqual(manifest.shards, ["0000.json", "0001.json"]);

  const writtenShards = await Promise.all(
    manifest.shards.map(async (name) => JSON.parse(await readFile(join(outputDir, name), "utf8"))),
  );
  const reverse = JSON.parse(await readFile(join(outputDir, "reverse.json"), "utf8"));
  const reader = createSiteLifecycleReader(manifest, writtenShards, reverse);
  assert.deepEqual(ids(reader.get("2032470010")), ids(document.parcels["2032470010"]));
  assert.deepEqual(ids(reader.get("2032470002")), ids(document.parcels["2032470002"]));
  assert.deepEqual(reader.memberParcels("land:project:2025X0262"), KINGSBRIDGE_LOTS);

  const assembled = assembleSiteLifecycleDocument(manifest, writtenShards, reverse);
  for (const parcelId of KINGSBRIDGE_LOTS) {
    assert.deepEqual(ids(assembled.parcels[parcelId]), ids(document.parcels[parcelId]));
  }

  // Ordering control: reverse the input observation order and require equal membership.
  const reversed = materializeSiteLifecycle({
    landProjects: [...inputs.landProjects].reverse(),
    projectLots: [...inputs.projectLots].reverse(),
    procurementRecords: [...inputs.procurementRecords].reverse(),
    generatedAt: testClockISOString(),
  });
  assert.deepEqual(ids(reversed.parcels["2032470010"]), ids(document.parcels["2032470010"]));
  assert.deepEqual(ids(reversed.parcels["2032470002"]), ids(document.parcels["2032470002"]));
  assert.equal(reversed.content_hash, document.content_hash);
})));

test("A2: mixed generations, changing footprints, and invented fixture ids are refused", async () => withPinnedClock("2026-09-26T00:00:00.000Z", async () => {
  const inputs = seedKingsbridgeInputs();
  const document = materializeSiteLifecycle({
    landProjects: inputs.landProjects,
    projectLots: inputs.projectLots,
    procurementRecords: inputs.procurementRecords,
    generatedAt: testClockISOString(),
  });
  const [shard0, shard1] = shardSiteLifecycle(document, 1);
  assert.throws(
    () => createSiteLifecycleReader(
      { generation: document.generation, content_hash: document.content_hash },
      [shard0, { ...shard1, generation: "stale-generation" }],
      { generation: document.generation, content_hash: document.content_hash, members: document.members },
    ),
    /generation mismatch/,
  );
  assert.throws(
    () => createSiteLifecycleReader(
      { generation: document.generation, content_hash: document.content_hash },
      [shard0, shard1],
      { generation: "stale-reverse", content_hash: document.content_hash, members: document.members },
    ),
    /reverse index generation mismatch/,
  );
  assert.throws(
    () => createSiteLifecycleReader(
      { generation: document.generation, content_hash: document.content_hash },
      [shard0, shard1],
      { generation: document.generation, content_hash: "stale-hash", members: document.members },
    ),
    /reverse index content hash mismatch/,
  );

  // Same subject observed on an expanding footprint keeps both lots.
  const ice = document.parcels["2032470002"].members.find((item) => item.subject_id === "ceqr:13DME013X");
  const icePrimary = document.parcels["2032470010"].members.find((item) => item.subject_id === "ceqr:13DME013X");
  assert.ok(ice);
  assert.ok(icePrimary);
  assert.deepEqual(ice.source_events.map((event) => event.date).sort(), ["2013-01-01", "2013-06-15"]);
  assert.deepEqual(icePrimary.source_events.map((event) => event.date).sort(), ["2013-01-01", "2013-06-15"]);

  assert.throws(
    () => assertProductionSiteLifecycleInputs({
      councilMatters: [{ matter_id: "coyle-zmk", project_id: "2020K0270" }],
    }),
    /fixture-only invented source identifiers/,
  );
  assert.throws(
    () => materializeSiteLifecyclePopulation({
      landProjects: [{ project_id: "P1", project_name: "Synthetic" }],
      projectLots: [{ project_id: "P1", bbls: ["1000000001"] }],
    }, { mode: "production" }),
    /fixture-only invented source identifiers/,
  );

  // Positive control: native Kingsbridge inputs are admitted.
  const admitted = assertProductionSiteLifecycleInputs(inputs);
  assert.equal(admitted.landProjects[0].project_id, "2025X0262");
}));

test("A3: population suite covers empty docs, nonzero shards, and retained caller receipts", async () => withPinnedClock("2026-09-26T00:00:00.000Z", async () => withTempDir("site-lifecycle-population-receipt", async (outputDir) => {
  const empty = materializeSiteLifecycle({ generatedAt: testClockISOString() });
  assert.deepEqual(empty.counts, { parcels: 0, members: 0 });
  assert.deepEqual(shardSiteLifecycle(empty, 1), []);
  assert.equal(createSiteLifecycleReader({ generation: empty.generation, content_hash: empty.content_hash }, [], {
    generation: empty.generation,
    content_hash: empty.content_hash,
    members: {},
  }).size, 0);

  const inputs = seedKingsbridgeInputs();
  const populationReceiptPath = join(outputDir, "population_receipt.json");
  const result = runSiteLifecyclePopulationCaller({
    inputs,
    callerInputsPath: CALLER_INPUTS_PATH,
    mode: "production",
    outputDir,
    membershipReceiptPath: join(outputDir, "membership.json"),
    populationReceiptPath,
    shardSize: 1,
    generatedAt: testClockISOString(),
  });
  assert.equal(result.receipt.schema, SITE_LIFECYCLE_POPULATION_RECEIPT_SCHEMA);
  assert.deepEqual(result.receipt.expected_strata, [...SITE_LIFECYCLE_POPULATION_EXPECTED_STRATA].sort());
  assert.deepEqual(result.receipt.observed_strata, ["kingsbridge-armory"]);
  assert.ok(Array.isArray(result.receipt.shortfalls));
  assert.ok(result.receipt.shortfalls.includes("coyle"));
  assert.equal(result.receipt.status, "incomplete");
  assert.equal(result.receipt.mode, "production");
  assert.ok(result.receipt.counts.parcels >= 2);
  assert.deepEqual(result.receipt.shards, ["0000.json", "0001.json"]);
  assert.equal(result.receipt.scheduled_observation.awaiting_deployed_cycle, true);
  assert.equal(result.receipt.scheduled_observation.observed_scheduled_at, null);

  const written = JSON.parse(await readFile(populationReceiptPath, "utf8"));
  assert.equal(written.generation, result.document.generation);
  assert.equal(written.input_fingerprint, result.receipt.input_fingerprint);
  assert.equal(written.status, result.receipt.status);
  assert.deepEqual(written.shortfalls, result.receipt.shortfalls);

  const committedReceipt = JSON.parse(await readFile(POPULATION_RECEIPT_PATH, "utf8"));
  assert.equal(committedReceipt.schema, SITE_LIFECYCLE_POPULATION_RECEIPT_SCHEMA);
  assert.ok(committedReceipt.counts.parcels > 2 || committedReceipt.counts.parcels === 2);
  // Retained population receipt must cover more than the frozen Coyle two-parcel fixture
  // OR explicitly name the Kingsbridge caller inputs as its source.
  const committedManifest = JSON.parse(await readFile(COMMITTED_MANIFEST_PATH, "utf8"));
  assert.equal(committedManifest.counts.parcels, 2);
  assert.ok(
    committedReceipt.caller_inputs_path?.includes("kingsbridge_caller_inputs.json")
      || committedReceipt.counts.parcels > committedManifest.counts.parcels,
    "population receipt must retain caller inputs beyond the committed two-parcel fixture",
  );
  assert.equal(committedReceipt.scheduled_observation.awaiting_deployed_cycle, true);
  assert.ok(Array.isArray(committedReceipt.expected_strata));
  assert.ok(Array.isArray(committedReceipt.observed_strata));
  assert.ok(Array.isArray(committedReceipt.shortfalls));
  assert.equal(
    committedReceipt.status,
    committedReceipt.shortfalls.length === 0 ? "complete" : "incomplete",
  );

  const files = await readdir(outputDir);
  assert.ok(files.includes("0000.json"));
  assert.ok(files.includes("0001.json"));
  assert.ok(files.includes("manifest.json"));
  assert.ok(files.includes("reverse.json"));
})));

test("A3 runtime: manifest reader loads every shard and unions multi-lot members", async () => withPinnedClock("2026-09-26T00:00:00.000Z", async () => withTempDir("site-lifecycle-population-load", async (outputDir) => {
  const inputs = seedKingsbridgeInputs();
  const document = materializeSiteLifecycle({
    landProjects: inputs.landProjects,
    projectLots: inputs.projectLots,
    procurementRecords: inputs.procurementRecords,
    generatedAt: testClockISOString(),
  });
  const manifest = writeSiteLifecycleProjection(document, {
    outputDir,
    receiptPath: join(outputDir, "membership.json"),
    shardSize: 1,
  });
  const reverse = JSON.parse(await readFile(join(outputDir, "reverse.json"), "utf8"));
  const shardBodies = Object.fromEntries(await Promise.all(
    manifest.shards.map(async (name) => [name, JSON.parse(await readFile(join(outputDir, name), "utf8"))]),
  ));

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const path = String(url);
    if (path.endsWith("/manifest.json")) {
      return { ok: true, status: 200, json: async () => manifest };
    }
    if (path.endsWith("/reverse.json")) {
      return { ok: true, status: 200, json: async () => reverse };
    }
    for (const name of manifest.shards) {
      if (path.endsWith(`/${name}`)) {
        return { ok: true, status: 200, json: async () => shardBodies[name] };
      }
    }
    return { ok: false, status: 404, json: async () => null };
  };
  try {
    const loaded = await loadSiteLifecycleContext({ basePath: "data/site_lifecycle" });
    assert.notEqual(loaded.schema, SITE_LIFECYCLE_LOAD_FAILED_SCHEMA);
    assert.deepEqual(Object.keys(loaded.parcels).sort(), KINGSBRIDGE_LOTS);
    const located = siteLifecycleMembersForSubject(loaded, "land:project:2025X0262");
    assert.deepEqual(located.parcelIds, KINGSBRIDGE_LOTS);
    assert.ok(located.members.some((member) => member.subject_id === "ceqr:13DME013X"));
    assert.ok(located.members.some((member) => member.subject_id === "ceqr:25DME006X"));
    // Secondary lot still recovers the shared history through the subject entry point.
    assert.ok(ids(loaded.parcels["2032470002"]).includes("land:project:2025X0262"));
  } finally {
    globalThis.fetch = originalFetch;
  }

  // Mixed-generation load must fail closed, not return an empty success.
  globalThis.fetch = async (url) => {
    const path = String(url);
    if (path.endsWith("/manifest.json")) {
      return { ok: true, status: 200, json: async () => manifest };
    }
    if (path.endsWith("/reverse.json")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ...reverse, generation: "stale" }),
      };
    }
    for (const name of manifest.shards) {
      if (path.endsWith(`/${name}`)) {
        return { ok: true, status: 200, json: async () => shardBodies[name] };
      }
    }
    return { ok: false, status: 404, json: async () => null };
  };
  try {
    const failed = await loadSiteLifecycleContext({ basePath: "data/site_lifecycle" });
    assert.equal(failed.schema, SITE_LIFECYCLE_LOAD_FAILED_SCHEMA);
    assert.match(failed.reason, /generation mismatch|reverse index/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
})));

/**
 * Build fixture-mode caller inputs that mark every fixed-dossier sample stratum
 * using already-retained subject ids. Corridor families are represented by their
 * dossier subject tokens in notes so a shortfall can be removed without inventing
 * parcel joins.
 */
function dossierPopulationInputs(familyIds) {
  const wanted = new Set(familyIds);
  const families = CONNECTED_HISTORY_DEMO_FAMILIES.filter((family) => wanted.has(family.family_id));
  const landProjects = [];
  const projectLots = [];
  const procurementRecords = [];
  const notes = [];

  for (const family of families) {
    notes.push(family.family_id);
    const parcelIds = family.subject_ids
      .filter((subjectId) => subjectId.startsWith("parcel:"))
      .map((subjectId) => subjectId.slice("parcel:".length));
    const landProjectId = family.subject_ids
      .find((subjectId) => subjectId.startsWith("land:project:"))
      ?.slice("land:project:".length);
    const ceqrIds = family.subject_ids.filter((subjectId) => subjectId.startsWith("ceqr:"));

    if (landProjectId && parcelIds.length) {
      landProjects.push({
        project_id: landProjectId,
        project_name: family.label,
        noticed_date: "2020-01-01",
        source_system: "zap-projects-open-data",
        evidence_path: `zap-projects-open-data:${landProjectId}`,
      });
      projectLots.push({ project_id: landProjectId, bbls: parcelIds });
    } else if (parcelIds.length) {
      const applicationId = family.subject_ids.find((subjectId) => subjectId.startsWith("land:application:"));
      notes.push(applicationId || family.subject_ids[0]);
      procurementRecords.push({
        subject_id: applicationId || `parcel:${parcelIds[0]}`,
        record_kind: "dossier_stratum_marker",
        request_id: `${family.family_id}-marker`,
        event_date: "2020-01-01",
        source_system: "retained-dossier",
        short_title: family.label,
        evidence: parcelIds.map((bbl) => ({ bbl, classification: "exact_target" })),
      });
    } else {
      for (const subjectId of family.subject_ids) notes.push(subjectId);
    }

    for (const subjectId of ceqrIds) {
      const requestId = subjectId.slice("ceqr:".length);
      const bbl = parcelIds[0];
      if (!bbl) {
        notes.push(subjectId);
        continue;
      }
      procurementRecords.push({
        subject_id: subjectId,
        record_kind: "ceqr_review",
        request_id: requestId,
        event_date: "2020-01-01",
        source_system: "ceqr",
        short_title: `${family.label} ${requestId}`,
        evidence: [{ bbl, classification: "exact_target" }],
      });
    }
  }

  return {
    schema: "cityscroll.parcel_history_caller_inputs.v1",
    version: 1,
    source_vintage: "2026-09-21",
    generated_at: "2026-09-26T00:00:00.000Z",
    notes,
    landProjects,
    projectLots,
    procurementRecords,
    councilMatters: [],
    evidence: [],
    negative_rules: ["Do not fill a missing dossier stratum by substituting another family."],
  };
}

test("A5: population status derives from dossier strata and can report a named shortfall", async () => withPinnedClock("2026-09-26T00:00:00.000Z", async () => {
  assert.deepEqual(
    [...SITE_LIFECYCLE_POPULATION_EXPECTED_STRATA].sort(),
    CONNECTED_HISTORY_DEMO_FAMILIES.map((family) => family.family_id).sort(),
  );

  const allFamilyIds = CONNECTED_HISTORY_DEMO_FAMILIES.map((family) => family.family_id);
  const completeInputs = dossierPopulationInputs(allFamilyIds);
  const complete = materializeSiteLifecyclePopulation(completeInputs, {
    mode: "fixture",
    generatedAt: testClockISOString(),
  });
  assert.deepEqual(complete.receipt.expected_strata, [...allFamilyIds].sort());
  assert.deepEqual(complete.receipt.observed_strata, [...allFamilyIds].sort());
  assert.deepEqual(complete.receipt.shortfalls, []);
  assert.equal(complete.receipt.status, "complete");

  // Positive control: remove one dossier stratum and require status to leave complete.
  const removed = "franklin-avenue";
  const reducedInputs = dossierPopulationInputs(allFamilyIds.filter((familyId) => familyId !== removed));
  const reduced = materializeSiteLifecyclePopulation(reducedInputs, {
    mode: "fixture",
    generatedAt: testClockISOString(),
  });
  assert.equal(reduced.receipt.status, "incomplete");
  assert.deepEqual(reduced.receipt.shortfalls, [removed]);
  assert.equal(reduced.receipt.observed_strata.includes(removed), false);
  assert.ok(reduced.receipt.expected_strata.includes(removed));
  assert.notEqual(reduced.receipt.status, complete.receipt.status);

  // Runtime observation of the helper itself: empty observed list names every expected stratum.
  const emptyCoverage = deriveSiteLifecyclePopulationStatus({
    expectedStrata: SITE_LIFECYCLE_POPULATION_EXPECTED_STRATA,
    observedStrata: observeSiteLifecyclePopulationStrata({
      document: { parcels: {}, members: {} },
      admitted: {},
    }),
  });
  assert.equal(emptyCoverage.status, "incomplete");
  assert.deepEqual(emptyCoverage.shortfalls, [...SITE_LIFECYCLE_POPULATION_EXPECTED_STRATA].sort());
  assert.deepEqual(emptyCoverage.observed_strata, []);

  // Existing invented-identifier refusal stays in force — shortfalls are never filled by substitution.
  assert.throws(
    () => materializeSiteLifecyclePopulation({
      landProjects: [{ project_id: "P1", project_name: "Synthetic filler" }],
      projectLots: [{ project_id: "P1", bbls: ["1000000001"] }],
      notes: ["franklin-avenue"],
    }, { mode: "production" }),
    /fixture-only invented source identifiers/,
  );
}));
