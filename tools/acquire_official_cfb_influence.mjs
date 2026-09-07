#!/usr/bin/env node

/**
 * Acquire the Campaign Finance Board contribution edges on a schedule.
 *
 * The artifact this writes — site/data/official_cfb_influence_lookup.json —
 * was materialized once by hand and then aged in place. Nothing rechecked the
 * publisher, so the day it resumed filing would have passed unnoticed. This
 * command is the scheduled acquisition the first-class refresh registry names
 * for it, and it exists to answer one question on every run: has the publisher
 * moved since the retained edges were built?
 *
 * The publisher's own clock answers it. Socrata reports `rowsUpdatedAt` for a
 * dataset without transferring a single row, so the check costs one small
 * request. The Campaign Finance Board declares an "As needed" update frequency
 * and can be quiet for months at a time, so the common outcome is that nothing
 * has changed.
 *
 * Three rules keep a quiet publisher cheap and a resumed one visible:
 *
 *  1. Rows are read only when the publisher's clock has moved past the one the
 *     retained artifact records. A quiet publisher costs the metadata request
 *     and nothing else.
 *  2. A run that changes neither the publisher clock nor the edges themselves
 *     rewrites nothing at all inside the declared cadence window, so repeated
 *     runs are byte-for-byte no-ops and a dormant publisher produces no daily
 *     commit. Outside that window the run records that it looked, which is the
 *     stamp the freshness gate reads: the honest claim is "confirmed with the
 *     publisher on this date", not "the publisher published on this date".
 *  3. A failed read never touches the retained artifact. The last complete
 *     materialization stands and the command exits non-zero, so a publisher
 *     outage is reported rather than converted into fewer edges.
 *
 *   node tools/acquire_official_cfb_influence.mjs
 *   node tools/acquire_official_cfb_influence.mjs --check
 *   node tools/acquire_official_cfb_influence.mjs --force
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  measureCfbRecipientJoin,
  buildCfbInfluenceLookup,
} from "../site/official_influence.mjs";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const ARTIFACT_PATH = join(ROOT, "site/data/official_cfb_influence_lookup.json");
export const HUB_PATH = join(ROOT, "site/data/person_hub_lookup.json");
export const RECEIPT_PATH = join(ROOT, "warehouse/receipts/proof/official_cfb_influence_latest.json");
export const FIXTURE_PATH = join(ROOT, "test/fixtures/person_hub/cfb_sample.json");

export const SOURCE_CONTRACT_ID = "cfb-campaign-contributions";
export const DATASET_ID = "rjkp-yttg";
export const ACQUISITION_RECEIPT_SCHEMA = "cityscroll.source_acquisition_receipt.v1";

/**
 * The cadence the first-class registry declares for this artifact, restated
 * here so the command is safe to run by hand at any frequency: inside the
 * window an unchanged publisher rewrites nothing.
 */
export const CHECK_CADENCE_HOURS = 168;

const METADATA_URL = `https://data.cityofnewyork.us/api/views/${DATASET_ID}.json`;
const RESOURCE_URL = `https://data.cityofnewyork.us/resource/${DATASET_ID}.json`;
const USER_AGENT = "CityScroll/1.0 (+https://cityscroll.org; campaign-finance acquisition)";
const PAGE_SIZE = 1000;
const MATERIALIZE_LIMIT = 12000;
const KILL_LIMIT = 5000;
const MAX_ATTEMPTS = 3;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * The publisher's own clock as an instant, from the epoch seconds Socrata
 * reports for the rows rather than for the dataset's description. A metadata
 * edit that touches no row must not read as new data.
 */
export function publisherUpdatedAt(metadata) {
  const seconds = metadata?.rowsUpdatedAt;
  return typeof seconds === "number" && Number.isFinite(seconds)
    ? new Date(seconds * 1000).toISOString()
    : null;
}

/**
 * The edges themselves, with every stamp removed.
 *
 * The fingerprint is what decides whether a rebuild is worth committing, so it
 * must not include the clocks: two identical materializations taken an hour
 * apart have to fingerprint the same.
 */
export function contentFingerprint(artifact) {
  const { retrieved_at: _retrieved, checked_at: _checked, publisher_updated_at: _publisher,
    content_fingerprint: _fingerprint, ...rest } = artifact || {};
  return sha256(JSON.stringify(rest));
}

/**
 * Person keys in a fixed order, so the same rows produce the same bytes
 * whichever order the publisher happened to page them out in.
 */
export function canonicalArtifact(artifact) {
  const byPerson = artifact?.by_person_id || {};
  const ordered = {};
  for (const key of Object.keys(byPerson).sort((a, b) => (Number(a) - Number(b)) || a.localeCompare(b))) {
    ordered[key] = byPerson[key];
  }
  return { ...artifact, by_person_id: ordered };
}

function hoursSince(instant, now) {
  const parsed = Date.parse(String(instant || ""));
  return Number.isFinite(parsed) ? (Date.parse(now) - parsed) / 3_600_000 : Infinity;
}

async function requestJson(url, { fetchImpl = fetch, attempts = MAX_ATTEMPTS } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
      return await response.json();
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`could not read ${url}: ${lastError?.message || lastError}`);
}

async function collectRows({ fetchImpl = fetch } = {}) {
  const rows = [];
  while (rows.length < MATERIALIZE_LIMIT) {
    const params = new URLSearchParams({
      $where: "election>='2021' AND officecd='5'",
      $select: "name,recipid,recipname,candfirst,amnt,election,date,officecd",
      // A tied sort key pages differently on each read, so the window a run takes
      // is fixed by the publisher's own row identity rather than by chance.
      $order: "date DESC,:id",
      $limit: String(Math.min(PAGE_SIZE, MATERIALIZE_LIMIT - rows.length)),
      $offset: String(rows.length),
    });
    const page = await requestJson(`${RESOURCE_URL}?${params}`, { fetchImpl });
    if (!Array.isArray(page)) throw new Error("publisher returned a non-array page");
    if (!page.length) break;
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

/**
 * Materialize the edges from rows already read, without contacting anyone.
 * Separated from the acquisition so the same code path can be exercised
 * against the retained sample.
 */
export function materialize(rows, { hub, publisherUpdated, retrievedAt, checkedAt }) {
  const measurement = measureCfbRecipientJoin(rows.slice(0, KILL_LIMIT), hub);
  const lookup = canonicalArtifact(buildCfbInfluenceLookup({
    cfbRows: measurement.gate?.promoted ? rows : rows.slice(0, KILL_LIMIT),
    personHubLookup: hub,
    measurement,
    retrievedAt,
  }));
  const stamped = {
    ...lookup,
    retrieved_at: retrievedAt,
    checked_at: checkedAt,
    publisher_updated_at: publisherUpdated,
  };
  return { ...stamped, content_fingerprint: contentFingerprint(stamped) };
}

function writeJson(path, value) {
  // determinism-lint: allow write the scheduled acquisition writes only its declared artifact and receipt
  mkdirSync(dirname(path), { recursive: true });
  // determinism-lint: allow write the scheduled acquisition writes only its declared artifact and receipt
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Read the committed artifact and report whether it carries the stamps the
 * scheduled refresh needs. Contacts nobody, so it is safe in check mode.
 */
export function inspectRetained({ artifactPath = ARTIFACT_PATH } = {}) {
  if (!existsSync(artifactPath)) return { present: false, findings: ["the retained artifact is missing"] };
  const artifact = readJson(artifactPath);
  const findings = [];
  for (const field of ["checked_at", "retrieved_at", "publisher_updated_at", "content_fingerprint"]) {
    if (!String(artifact?.[field] || "").trim()) findings.push(`${field} is missing`);
  }
  if (artifact.content_fingerprint && artifact.content_fingerprint !== contentFingerprint(artifact)) {
    findings.push("content_fingerprint does not describe the retained edges");
  }
  return { present: true, artifact, findings };
}

export async function acquire({
  now = new Date().toISOString(),
  fetchImpl = fetch,
  artifactPath = ARTIFACT_PATH,
  receiptPath = RECEIPT_PATH,
  hubPath = HUB_PATH,
  force = false,
  rows = null,
} = {}) {
  const retained = existsSync(artifactPath) ? readJson(artifactPath) : null;
  const metadata = rows ? { rowsUpdatedAt: null } : await requestJson(METADATA_URL, { fetchImpl });
  const publisherUpdated = rows ? retained?.publisher_updated_at || null : publisherUpdatedAt(metadata);
  const publisherMoved = !retained || !publisherUpdated || publisherUpdated !== retained.publisher_updated_at;
  const withinCadence = hoursSince(retained?.checked_at, now) < CHECK_CADENCE_HOURS;

  if (retained && !publisherMoved && !force && withinCadence) {
    return {
      outcome: "unchanged_within_cadence",
      wrote_artifact: false,
      publisher_updated_at: publisherUpdated,
      checked_at: retained.checked_at,
    };
  }
  if (retained && !publisherMoved && !force) {
    // The publisher has not moved, so the edges cannot have. Record only that
    // the check happened: the freshness gate measures when this dataset was
    // last confirmed, not when the Campaign Finance Board last filed.
    const confirmed = { ...retained, checked_at: now };
    writeJson(artifactPath, { ...confirmed, content_fingerprint: contentFingerprint(confirmed) });
    return {
      outcome: "confirmed_unchanged",
      wrote_artifact: true,
      publisher_updated_at: publisherUpdated,
      checked_at: now,
    };
  }

  const hub = readJson(hubPath);
  const source = rows || await collectRows({ fetchImpl });
  if (!source.length) throw new Error("publisher returned no contribution rows; retained edges stand");
  const built = materialize(source, {
    hub,
    publisherUpdated,
    retrievedAt: now,
    checkedAt: now,
  });
  const edgesUnchanged = retained?.content_fingerprint === built.content_fingerprint;
  const written = edgesUnchanged
    ? { ...retained, checked_at: now, publisher_updated_at: publisherUpdated }
    : built;
  writeJson(artifactPath, { ...written, content_fingerprint: contentFingerprint(written) });
  const receipt = {
    schema: ACQUISITION_RECEIPT_SCHEMA,
    source_contract_id: SOURCE_CONTRACT_ID,
    dataset_id: DATASET_ID,
    observed_at: now,
    status: "succeeded",
    publisher_updated_at: publisherUpdated,
    rows_read: source.length,
    edge_count: written.edge_count,
    person_count: written.person_count,
    edges_changed: !edgesUnchanged,
  };
  writeJson(receiptPath, receipt);
  return {
    outcome: edgesUnchanged ? "rebuilt_identical" : "rebuilt_changed",
    wrote_artifact: true,
    publisher_updated_at: publisherUpdated,
    checked_at: now,
    rows_read: source.length,
  };
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes("--check")) {
    const inspection = inspectRetained();
    if (!inspection.present || inspection.findings.length) {
      console.error(`official CFB influence acquisition is not current:\n${inspection.findings.join("\n")}`);
      process.exitCode = 1;
      return;
    }
    console.log(
      `official_cfb_influence ok checked_at=${inspection.artifact.checked_at} `
      + `publisher_updated_at=${inspection.artifact.publisher_updated_at} `
      + `edges=${inspection.artifact.edge_count}`,
    );
    return;
  }
  const result = await acquire({
    // determinism-lint: allow clock a scheduled acquisition records the instant it read the publisher
    now: new Date().toISOString(),
    force: argv.includes("--force"),
    rows: argv.includes("--fixture") ? readJson(FIXTURE_PATH) : null,
  });
  console.log(JSON.stringify({ artifact: relative(ROOT, ARTIFACT_PATH), ...result }));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
