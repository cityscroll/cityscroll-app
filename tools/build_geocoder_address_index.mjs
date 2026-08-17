#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildAddressIndexFromPadLines } from "./lib/geocoder_address_index.mjs";
import { ADDRESS_INDEX_MANIFEST_SCHEMA, ADDRESS_INDEX_SHARD_SCHEMA } from "../site/precomputed_address_geocoder.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_DIR = path.join(ROOT, "site", "data", "address-index");
const MANIFEST_PATH = path.join(OUTPUT_DIR, "manifest.json");
const PAD_DOWNLOAD = "https://data.cityofnewyork.us/download/bc8t-ecyu/application%2Fzip";
const PAD_METADATA = "https://data.cityofnewyork.us/api/views/bc8t-ecyu";
const MAX_SHARD_BYTES = 20 * 1024 * 1024;

function parseArgs(argv) {
  const options = { check: false, fromLive: false, padZip: null, sourceVersion: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") options.check = true;
    else if (arg === "--from-live") options.fromLive = true;
    else if (arg === "--pad-zip" || arg === "--source-version") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      options[arg === "--pad-zip" ? "padZip" : "sourceVersion"] = value;
      index += 1;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function atomicWrite(filePath, content) {
  const temporary = `${filePath}.tmp`;
  await writeFile(temporary, content);
  await rename(temporary, filePath);
}

async function verifyCommittedIndex() {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
  assert.equal(manifest.schema, ADDRESS_INDEX_MANIFEST_SCHEMA);
  assert.equal(Object.keys(manifest.shards || {}).length, manifest.shard_count);
  assert.ok(manifest.coverage?.included_real_and_vanity_ranges > 1_000_000,
    "citywide PAD coverage must retain more than one million real/vanity source ranges");
  assert.ok(manifest.coverage?.materialized_ranges > 500_000,
    "citywide PAD index must retain more than 500,000 materialized ranges");
  let records = 0;
  let streets = 0;
  for (const [key, descriptor] of Object.entries(manifest.shards)) {
    assert.match(key, /^[0-9a-f]{2}$/);
    const filePath = path.join(OUTPUT_DIR, path.basename(descriptor.file));
    const content = await readFile(filePath);
    assert.equal(content.byteLength, descriptor.bytes, `${key} shard byte count drifted`);
    assert.equal(sha256(content), descriptor.sha256, `${key} shard digest drifted`);
    assert.ok(content.byteLength <= MAX_SHARD_BYTES, `${key} exceeds the static-host shard limit`);
    const shard = JSON.parse(content);
    assert.equal(shard.schema, ADDRESS_INDEX_SHARD_SCHEMA);
    assert.equal(shard.key, key);
    const shardStreets = Object.keys(shard.streets || {}).length;
    const shardRecords = Object.values(shard.streets || {}).reduce((sum, rows) => sum + rows.length, 0);
    assert.equal(shardStreets, descriptor.streets, `${key} street count drifted`);
    assert.equal(shardRecords, descriptor.records, `${key} record count drifted`);
    records += shardRecords;
    streets += shardStreets;
  }
  assert.equal(records, manifest.coverage.materialized_ranges);
  assert.equal(streets, manifest.coverage.normalized_streets);
  return manifest;
}

async function liveSourceMetadata(fetchImpl = fetch) {
  const response = await fetchImpl(PAD_METADATA, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`PAD metadata failed: HTTP ${response.status}`);
  const metadata = await response.json();
  const version = String(metadata.description || "").match(/Current version:\s*([\w.-]+)/i)?.[1] || "unknown";
  return {
    version,
    updatedAt: Number(metadata.rowsUpdatedAt) > 0
      ? new Date(Number(metadata.rowsUpdatedAt) * 1000).toISOString()
      : null,
  };
}

async function downloadPad(destination, fetchImpl = fetch) {
  const response = await fetchImpl(PAD_DOWNLOAD);
  if (!response.ok || !response.body) throw new Error(`PAD download failed: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
}

function padAddressLines(zipPath) {
  const child = spawn("unzip", ["-p", zipPath, "bobaadr.txt"], { stdio: ["ignore", "pipe", "pipe"] });
  let errorText = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { errorText += chunk; });
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const completed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`unzip failed (${code}): ${errorText.trim()}`)));
  });
  return { lines, completed };
}

async function build({ padZip, sourceVersion, sourceUpdatedAt = null }) {
  const sourceSha256 = await sha256File(padZip);
  try {
    const existing = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
    if (existing?.source?.sha256 === sourceSha256 && existing?.source?.version === sourceVersion) {
      await verifyCommittedIndex();
      console.log(`unchanged PAD ${sourceVersion} (${sourceSha256.slice(0, 12)})`);
      return existing;
    }
  } catch (_error) {
    // A missing or invalid committed index is rebuilt below.
  }

  const { lines, completed } = padAddressLines(padZip);
  const built = await buildAddressIndexFromPadLines(lines, {
    generatedAt: new Date().toISOString(),
    sourceSha256,
    sourceVersion,
    shardCount: 64,
  });
  await completed;
  built.manifest.source.updated_at = sourceUpdatedAt;
  await mkdir(OUTPUT_DIR, { recursive: true });
  for (const [key, shard] of built.shards) {
    const rendered = `${JSON.stringify(shard)}\n`;
    const descriptor = built.manifest.shards[key];
    descriptor.bytes = Buffer.byteLength(rendered);
    descriptor.sha256 = sha256(rendered);
    assert.ok(descriptor.bytes <= MAX_SHARD_BYTES, `${key} exceeds the static-host shard limit`);
    await atomicWrite(path.join(OUTPUT_DIR, `${key}.json`), rendered);
  }
  await atomicWrite(MANIFEST_PATH, `${JSON.stringify(built.manifest, null, 2)}\n`);
  const totalBytes = (await Promise.all([...built.shards.keys()].map((key) => stat(path.join(OUTPUT_DIR, `${key}.json`)))))
    .reduce((sum, item) => sum + item.size, 0);
  console.log(`wrote ${built.manifest.coverage.materialized_ranges.toLocaleString()} PAD ranges across ${built.shards.size} shards (${(totalBytes / 1024 / 1024).toFixed(1)} MiB)`);
  return verifyCommittedIndex();
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.check) {
    const manifest = await verifyCommittedIndex();
    console.log(`ok address index ${manifest.source.version}: ${manifest.coverage.materialized_ranges.toLocaleString()} ranges`);
    return;
  }
  let padZip = options.padZip ? path.resolve(options.padZip) : null;
  let metadata = { version: options.sourceVersion || "unknown", updatedAt: null };
  if (options.fromLive) {
    metadata = await liveSourceMetadata();
    if (options.sourceVersion) metadata.version = options.sourceVersion;
    padZip = path.join(tmpdir(), `cityscroll-pad-${process.pid}.zip`);
    await downloadPad(padZip);
  }
  if (!padZip) throw new Error("Use --from-live or --pad-zip <official PAD zip>");
  if (!options.fromLive && !options.sourceVersion) throw new Error("--pad-zip requires --source-version");
  await build({ padZip, sourceVersion: metadata.version, sourceUpdatedAt: metadata.updatedAt });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((error) => { console.error(error); process.exit(1); });

export { build, verifyCommittedIndex };
