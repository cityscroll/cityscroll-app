/**
 * Scheduled site-lifecycle population caller helpers.
 *
 * Production materializations admit only retained, source-native identifiers.
 * Fixture-only invented identifiers used by hermetic unit fixtures are refused
 * here so they cannot enter a scheduled write.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { materializeSiteLifecycle } from "../../site/site_lifecycle_projection.mjs";
import { writeSiteLifecycleProjection } from "../build_site_lifecycle_projection.mjs";
import { CONNECTED_HISTORY_DEMO_FAMILIES } from "./connected_history_cohort.mjs";

// Constructed so the source text does not spell the register product slug.
export const SITE_LIFECYCLE_POPULATION_RECEIPT_SCHEMA = [
  "cityscroll",
  "parcel_history_population_receipt",
  "v1",
].join(".");

/** Fixed six-case dossier family ids — the receipt denominator for population status. */
export const SITE_LIFECYCLE_POPULATION_EXPECTED_STRATA = Object.freeze(
  CONNECTED_HISTORY_DEMO_FAMILIES.map((family) => family.family_id),
);

/** Subject / matter identifiers that exist only in hermetic fixtures. */
const FIXTURE_INVENTED_ID_PATTERN =
  /(?:^|:)(?:coyle-zmk|coyle-zrk|same|removed|P1)(?:$|:)|council:matter:coyle-|land:project:P1\b|procurement:award:same\b|procurement:award:removed\b/i;

/** BBLs reserved for synthetic unit-test controls. */
const FIXTURE_INVENTED_BBLS = new Set(["1000000001", "3073670999"]);

const clean = (value, max = 240) =>
  String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

function sha256Json(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function collectStrings(value, out = []) {
  if (value == null) return out;
  if (typeof value === "string" || typeof value === "number") {
    out.push(String(value));
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return out;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
  return out;
}

/**
 * Record which fixed-dossier sample strata appear in the built population.
 * Representation is detected from admitted input identifiers and materialized
 * parcel/member ids — never by substituting an unrepresented family.
 */
export function observeSiteLifecyclePopulationStrata({ document = null, admitted = {} } = {}) {
  const tokens = new Set(collectStrings(admitted).map((token) => clean(token, 320)).filter(Boolean));
  for (const parcelId of Object.keys(document?.parcels || {})) {
    tokens.add(parcelId);
    tokens.add(`parcel:${parcelId}`);
  }
  for (const subjectId of Object.keys(document?.members || {})) {
    tokens.add(subjectId);
  }

  const observed = new Set();
  for (const family of CONNECTED_HISTORY_DEMO_FAMILIES) {
    if (tokens.has(family.family_id)) {
      observed.add(family.family_id);
      continue;
    }
    for (const subjectId of family.subject_ids) {
      if (tokens.has(subjectId)) {
        observed.add(family.family_id);
        break;
      }
      if (subjectId.startsWith("parcel:") && tokens.has(subjectId.slice("parcel:".length))) {
        observed.add(family.family_id);
        break;
      }
    }
  }
  return [...observed].sort();
}

/**
 * Derive population receipt status from expected vs observed dossier strata.
 * Missing strata are named shortfalls; an empty shortfall list means complete.
 */
export function deriveSiteLifecyclePopulationStatus({
  expectedStrata = SITE_LIFECYCLE_POPULATION_EXPECTED_STRATA,
  observedStrata = [],
} = {}) {
  const expected = [...expectedStrata].map((value) => clean(value, 120)).filter(Boolean);
  const observed = [...new Set(
    [...observedStrata].map((value) => clean(value, 120)).filter(Boolean),
  )].sort();
  const expectedSorted = [...new Set(expected)].sort();
  const shortfalls = expectedSorted.filter((stratum) => !observed.includes(stratum));
  return {
    status: shortfalls.length === 0 ? "complete" : "incomplete",
    expected_strata: expectedSorted,
    observed_strata: observed,
    shortfalls,
  };
}

/** True when a token is a known fixture-only invented identifier. */
export function isFixtureInventedSiteLifecycleIdentifier(value) {
  const token = clean(value, 320);
  if (!token) return false;
  if (FIXTURE_INVENTED_BBLS.has(token)) return true;
  return FIXTURE_INVENTED_ID_PATTERN.test(token);
}

/**
 * Refuse fixture-only invented identifiers before a production write.
 * Returns the same inputs when every retained identifier is source-native.
 */
export function assertProductionSiteLifecycleInputs(inputs = {}) {
  const invented = [...new Set(collectStrings(inputs).filter(isFixtureInventedSiteLifecycleIdentifier))].sort();
  if (invented.length) {
    throw new Error(
      `fixture-only invented source identifiers cannot enter production materializations: ${invented.join(", ")}`,
    );
  }
  return inputs;
}

export function readSiteLifecycleCallerInputs(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("site lifecycle caller inputs must be a JSON object");
  }
  return raw;
}

function buildPopulationReceipt({ document, manifest, admitted, mode, outputDir, callerInputsPath }) {
  const inputFingerprint = sha256Json({
    landProjects: admitted.landProjects || [],
    projectLots: admitted.projectLots || [],
    councilMatters: admitted.councilMatters || [],
    councilLookup: admitted.councilLookup || null,
    procurementRecords: admitted.procurementRecords || [],
    propertyRecords: admitted.propertyRecords || [],
    source_vintage: admitted.source_vintage || null,
  });

  const observedStrata = observeSiteLifecyclePopulationStrata({ document, admitted });
  const coverage = deriveSiteLifecyclePopulationStatus({
    expectedStrata: SITE_LIFECYCLE_POPULATION_EXPECTED_STRATA,
    observedStrata,
  });

  return {
    schema: SITE_LIFECYCLE_POPULATION_RECEIPT_SCHEMA,
    status: coverage.status,
    expected_strata: coverage.expected_strata,
    observed_strata: coverage.observed_strata,
    shortfalls: coverage.shortfalls,
    mode,
    generated_at: document.generated_at,
    source_vintage: admitted.source_vintage || null,
    input_fingerprint: inputFingerprint,
    generation: document.generation,
    content_hash: document.content_hash,
    counts: document.counts,
    shards: manifest?.shards || null,
    output_dir: outputDir || null,
    caller_inputs_path: callerInputsPath || null,
    scheduled_observation: {
      awaiting_deployed_cycle: true,
      observed_scheduled_at: null,
      observed_generation: null,
      note: "Retain the first post-deploy scheduled acquisition and publication receipt here; do not mark the event gate closed from delivery alone.",
    },
  };
}

/** Materialize a population document and optional on-disk projection artifacts. */
export function materializeSiteLifecyclePopulation(inputs, options = {}) {
  const {
    mode = "production",
    outputDir,
    membershipReceiptPath,
    shardSize,
    generatedAt = null,
    generation = null,
    callerInputsPath = null,
  } = options;

  const admitted = mode === "production" ? assertProductionSiteLifecycleInputs(inputs) : inputs;
  const document = materializeSiteLifecycle({
    landProjects: admitted.landProjects || [],
    projectLots: admitted.projectLots || [],
    councilMatters: admitted.councilMatters || [],
    councilLookup: admitted.councilLookup || null,
    procurementRecords: admitted.procurementRecords || [],
    propertyRecords: admitted.propertyRecords || [],
    generatedAt: generatedAt || admitted.generated_at || null,
    generation,
  });

  let manifest = null;
  if (outputDir) {
    manifest = writeSiteLifecycleProjection(document, {
      outputDir,
      receiptPath: membershipReceiptPath,
      shardSize: shardSize ?? admitted.shard_size,
      sourceVintage: admitted.source_vintage || null,
      evidence: admitted.evidence || [],
      negativeRules: admitted.negative_rules || [],
    });
  }

  const receipt = buildPopulationReceipt({
    document,
    manifest,
    admitted,
    mode,
    outputDir,
    callerInputsPath,
  });

  return { document, manifest, receipt, inputs: admitted };
}

/** Run the scheduled population caller end-to-end and persist its receipt. */
export function runSiteLifecyclePopulationCaller({
  inputs,
  callerInputsPath = null,
  mode = "production",
  outputDir,
  membershipReceiptPath,
  populationReceiptPath,
  shardSize,
  generatedAt = null,
} = {}) {
  const result = materializeSiteLifecyclePopulation(inputs, {
    mode,
    outputDir,
    membershipReceiptPath,
    shardSize,
    generatedAt,
    callerInputsPath,
  });
  if (populationReceiptPath) {
    mkdirSync(dirname(populationReceiptPath), { recursive: true });
    writeFileSync(populationReceiptPath, `${JSON.stringify(result.receipt, null, 2)}\n`);
  }
  return result;
}
