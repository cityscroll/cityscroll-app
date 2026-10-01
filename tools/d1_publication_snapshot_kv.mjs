#!/usr/bin/env node

/**
 * Pack and unpack generation-qualified D1 publication snapshots for Workers KV.
 *
 * Cloudflare Workers KV rejects values over 25 MiB (API code 10024). The
 * partition snapshot for a full baseline already exceeds that uncompressed
 * (gen24 measured ~26.3 MiB). This module gzip-compresses the snapshot into a
 * versioned envelope under the primary snapshot key, and when even the
 * compressed envelope would exceed the limit, splits the gzip payload across
 * chunk keys with a manifest at the primary key.
 *
 * Every value intended for a KV put is size-checked before write. An oversize
 * payload fails loudly with the exact byte counts; nothing is silently dropped.
 *
 * Legacy raw JSON snapshots (schema cityscroll.d1-partition-snapshot.v2) still
 * unpack for read-side compatibility with any residual keys.
 *
 * Usage:
 *   node tools/d1_publication_snapshot_kv.mjs pack \
 *     --in <snapshot.json> --generation <n> --out-dir <dir> [--plan-out <path>]
 *   node tools/d1_publication_snapshot_kv.mjs unpack \
 *     --in <kv-value.json> --out <snapshot.json> [--chunks-dir <dir>]
 *   node tools/d1_publication_snapshot_kv.mjs assert-fits --path <file> [--key <name>]
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

import { SNAPSHOT_SCHEMA } from "./d1_delta_plan.mjs";
import { KV_VALUE_LIMIT_BYTES } from "./worker_deploy_guard.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Keep lockstep with tools/d1_production_delta.mjs snapshotKeyForGeneration. */
export const D1_PUBLICATION_SNAPSHOT_KEY_PREFIX = "d1-publication:snapshot:v2:";
export const D1_PUBLICATION_SNAPSHOT_KV_SCHEMA = "cityscroll.d1-publication-snapshot-kv.v1";
export const D1_PUBLICATION_SNAPSHOT_KV_CHUNK_SCHEMA = "cityscroll.d1-publication-snapshot-kv-chunk.v1";
export const D1_PUBLICATION_SNAPSHOT_KV_PLAN_SCHEMA = "cityscroll.d1-publication-snapshot-kv-plan.v1";
export { KV_VALUE_LIMIT_BYTES };

/** Leave headroom under the hard 25 MiB limit for JSON envelope framing. */
export const DEFAULT_CHUNK_PAYLOAD_BUDGET_BYTES = 20 * 1024 * 1024;

function fail(message) {
  throw new Error(message);
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function byteLengthOfUtf8(value) {
  return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8");
}

/**
 * Fail closed before any KV put. Names the key, measured size, and limit.
 */
export function assertKvValueFits(value, {
  key = null,
  limitBytes = KV_VALUE_LIMIT_BYTES,
  label = "KV value",
} = {}) {
  const bytes = typeof value === "number" && Number.isFinite(value)
    ? value
    : Buffer.isBuffer(value)
      ? value.byteLength
      : byteLengthOfUtf8(value);
  if (bytes > limitBytes) {
    const keyPart = key ? ` key=${key}` : "";
    fail(
      `${label} exceeds Workers KV limit:${keyPart} size=${bytes} bytes `
      + `(${(bytes / 1024 / 1024).toFixed(6)} MiB) limit=${limitBytes} bytes `
      + `(${(limitBytes / 1024 / 1024).toFixed(6)} MiB)`,
    );
  }
  return bytes;
}

export function snapshotKeyForGeneration(generation) {
  if (!Number.isInteger(generation) || generation < 1) fail("generation must be a positive integer");
  return `${D1_PUBLICATION_SNAPSHOT_KEY_PREFIX}${generation}`;
}

export function snapshotChunkKey(generation, index) {
  if (!Number.isInteger(index) || index < 0) fail("chunk index must be a non-negative integer");
  return `${snapshotKeyForGeneration(generation)}:chunk:${index}`;
}

function encodeEnvelopeJson(envelope) {
  return `${JSON.stringify(envelope)}\n`;
}

function gzipPayload(rawBytes, { level = 9 } = {}) {
  return gzipSync(rawBytes, { level });
}

function splitIntoChunks(buffer, maxChunkBytes) {
  if (!Number.isInteger(maxChunkBytes) || maxChunkBytes < 1) {
    fail(`maxChunkBytes must be a positive integer (got ${maxChunkBytes})`);
  }
  const chunks = [];
  for (let offset = 0; offset < buffer.byteLength; offset += maxChunkBytes) {
    chunks.push(buffer.subarray(offset, Math.min(offset + maxChunkBytes, buffer.byteLength)));
  }
  return chunks.length ? chunks : [Buffer.alloc(0)];
}

/**
 * Pack raw snapshot bytes into one or more KV values.
 *
 * Returns a plan describing every key/value that must be written, with each
 * value already asserted under the KV size limit.
 */
export function packSnapshotForKv(rawBytes, {
  generation,
  limitBytes = KV_VALUE_LIMIT_BYTES,
  chunkPayloadBudgetBytes = DEFAULT_CHUNK_PAYLOAD_BUDGET_BYTES,
  gzipLevel = 9,
} = {}) {
  if (!Buffer.isBuffer(rawBytes)) fail("packSnapshotForKv requires a Buffer of snapshot bytes");
  if (!Number.isInteger(generation) || generation < 1) fail("generation must be a positive integer");

  const primaryKey = snapshotKeyForGeneration(generation);
  const uncompressedBytes = rawBytes.byteLength;
  const uncompressedSha256 = sha256Bytes(rawBytes);
  const gzipBytes = gzipPayload(rawBytes, { level: gzipLevel });
  const gzipSha256 = sha256Bytes(gzipBytes);

  const singleEnvelope = {
    schema: D1_PUBLICATION_SNAPSHOT_KV_SCHEMA,
    encoding: "gzip-base64",
    generation,
    uncompressed_bytes: uncompressedBytes,
    uncompressed_sha256: uncompressedSha256,
    gzip_bytes: gzipBytes.byteLength,
    gzip_sha256: gzipSha256,
    chunk_count: 1,
    payload: gzipBytes.toString("base64"),
  };
  const singleText = encodeEnvelopeJson(singleEnvelope);
  const singleBytes = byteLengthOfUtf8(singleText);

  if (singleBytes <= limitBytes) {
    assertKvValueFits(singleBytes, { key: primaryKey, limitBytes, label: "packed D1 publication snapshot" });
    return {
      schema: D1_PUBLICATION_SNAPSHOT_KV_PLAN_SCHEMA,
      mode: "single",
      generation,
      primary_key: primaryKey,
      uncompressed_bytes: uncompressedBytes,
      uncompressed_sha256: uncompressedSha256,
      gzip_bytes: gzipBytes.byteLength,
      gzip_sha256: gzipSha256,
      packed_primary_bytes: singleBytes,
      kv_limit_bytes: limitBytes,
      puts: [{ key: primaryKey, relative_path: "primary.json", bytes: singleBytes }],
      values: { [primaryKey]: singleText },
    };
  }

  // Compressed single envelope still over the limit: chunk the gzip payload.
  const gzipChunks = splitIntoChunks(gzipBytes, chunkPayloadBudgetBytes);
  const puts = [];
  const values = {};
  const chunkKeys = [];

  for (let index = 0; index < gzipChunks.length; index += 1) {
    const chunkKey = snapshotChunkKey(generation, index);
    const chunkEnvelope = {
      schema: D1_PUBLICATION_SNAPSHOT_KV_CHUNK_SCHEMA,
      encoding: "gzip-base64-chunk",
      generation,
      chunk_index: index,
      chunk_count: gzipChunks.length,
      gzip_sha256: gzipSha256,
      payload: gzipChunks[index].toString("base64"),
    };
    const chunkText = encodeEnvelopeJson(chunkEnvelope);
    const chunkBytes = assertKvValueFits(chunkText, {
      key: chunkKey,
      limitBytes,
      label: "packed D1 publication snapshot chunk",
    });
    chunkKeys.push(chunkKey);
    puts.push({ key: chunkKey, relative_path: `chunk-${index}.json`, bytes: chunkBytes });
    values[chunkKey] = chunkText;
  }

  const manifest = {
    schema: D1_PUBLICATION_SNAPSHOT_KV_SCHEMA,
    encoding: "gzip-base64-chunked",
    generation,
    uncompressed_bytes: uncompressedBytes,
    uncompressed_sha256: uncompressedSha256,
    gzip_bytes: gzipBytes.byteLength,
    gzip_sha256: gzipSha256,
    chunk_count: gzipChunks.length,
    chunk_keys: chunkKeys,
  };
  const manifestText = encodeEnvelopeJson(manifest);
  const manifestBytes = assertKvValueFits(manifestText, {
    key: primaryKey,
    limitBytes,
    label: "packed D1 publication snapshot manifest",
  });
  puts.unshift({ key: primaryKey, relative_path: "primary.json", bytes: manifestBytes });
  values[primaryKey] = manifestText;

  return {
    schema: D1_PUBLICATION_SNAPSHOT_KV_PLAN_SCHEMA,
    mode: "chunked",
    generation,
    primary_key: primaryKey,
    uncompressed_bytes: uncompressedBytes,
    uncompressed_sha256: uncompressedSha256,
    gzip_bytes: gzipBytes.byteLength,
    gzip_sha256: gzipSha256,
    packed_primary_bytes: manifestBytes,
    kv_limit_bytes: limitBytes,
    puts,
    values,
  };
}

function decodeGzipBase64(payload, { expectedGzipSha256 = null, expectedUncompressedSha256 = null } = {}) {
  if (typeof payload !== "string" || payload.length === 0) fail("snapshot KV envelope payload is missing");
  const gzipBytes = Buffer.from(payload, "base64");
  if (expectedGzipSha256 && sha256Bytes(gzipBytes) !== expectedGzipSha256) {
    fail("snapshot KV gzip payload sha256 mismatch");
  }
  const raw = gunzipSync(gzipBytes);
  if (expectedUncompressedSha256 && sha256Bytes(raw) !== expectedUncompressedSha256) {
    fail("snapshot KV uncompressed sha256 mismatch");
  }
  return raw;
}

function parseKvText(text) {
  if (typeof text !== "string") fail("unpack requires UTF-8 KV value text");
  const trimmed = text.trim();
  if (!trimmed) fail("snapshot KV value is empty");
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    fail(`snapshot KV value is not JSON: ${error.message}`);
  }
  return parsed;
}

/**
 * Unpack a primary KV value (and optional chunk map) into raw snapshot bytes.
 * Accepts legacy raw partition snapshots and packed envelopes.
 */
export function unpackSnapshotFromKv(primaryText, {
  chunksByKey = null,
  readChunk = null,
} = {}) {
  const parsed = parseKvText(primaryText);

  if (parsed?.schema === SNAPSHOT_SCHEMA) {
    // Legacy raw snapshot stored directly under the generation key.
    return Buffer.from(primaryText, "utf8");
  }

  if (parsed?.schema !== D1_PUBLICATION_SNAPSHOT_KV_SCHEMA) {
    fail(`unrecognized D1 publication snapshot KV schema: ${parsed?.schema ?? "missing"}`);
  }

  if (parsed.encoding === "gzip-base64") {
    return decodeGzipBase64(parsed.payload, {
      expectedGzipSha256: parsed.gzip_sha256 || null,
      expectedUncompressedSha256: parsed.uncompressed_sha256 || null,
    });
  }

  if (parsed.encoding === "gzip-base64-chunked") {
    const chunkKeys = Array.isArray(parsed.chunk_keys) ? parsed.chunk_keys : null;
    const chunkCount = Number(parsed.chunk_count);
    if (!chunkKeys || chunkKeys.length !== chunkCount || chunkCount < 1) {
      fail("chunked snapshot manifest is missing chunk_keys");
    }
    const parts = [];
    for (let index = 0; index < chunkKeys.length; index += 1) {
      const key = chunkKeys[index];
      let chunkText = chunksByKey?.[key] ?? null;
      if (chunkText == null && typeof readChunk === "function") {
        chunkText = readChunk(key, index);
      }
      if (typeof chunkText !== "string") {
        fail(`missing snapshot chunk value for ${key}`);
      }
      const chunk = parseKvText(chunkText);
      if (chunk?.schema !== D1_PUBLICATION_SNAPSHOT_KV_CHUNK_SCHEMA) {
        fail(`unrecognized snapshot chunk schema for ${key}`);
      }
      if (chunk.chunk_index !== index || chunk.generation !== parsed.generation) {
        fail(`snapshot chunk identity mismatch for ${key}`);
      }
      if (typeof chunk.payload !== "string") fail(`snapshot chunk payload missing for ${key}`);
      parts.push(Buffer.from(chunk.payload, "base64"));
    }
    const gzipBytes = Buffer.concat(parts);
    if (parsed.gzip_sha256 && sha256Bytes(gzipBytes) !== parsed.gzip_sha256) {
      fail("chunked snapshot gzip sha256 mismatch");
    }
    if (parsed.gzip_bytes != null && gzipBytes.byteLength !== Number(parsed.gzip_bytes)) {
      fail("chunked snapshot gzip byte length mismatch");
    }
    const raw = gunzipSync(gzipBytes);
    if (parsed.uncompressed_sha256 && sha256Bytes(raw) !== parsed.uncompressed_sha256) {
      fail("chunked snapshot uncompressed sha256 mismatch");
    }
    if (parsed.uncompressed_bytes != null && raw.byteLength !== Number(parsed.uncompressed_bytes)) {
      fail("chunked snapshot uncompressed byte length mismatch");
    }
    return raw;
  }

  fail(`unsupported D1 publication snapshot KV encoding: ${parsed.encoding}`);
}

export function writePackPlan(plan, outDir, { planOut = null } = {}) {
  mkdirSync(outDir, { recursive: true });
  for (const put of plan.puts) {
    const path = join(outDir, put.relative_path);
    writeFileSync(path, plan.values[put.key]);
  }
  const publicPlan = {
    schema: plan.schema,
    mode: plan.mode,
    generation: plan.generation,
    primary_key: plan.primary_key,
    uncompressed_bytes: plan.uncompressed_bytes,
    uncompressed_sha256: plan.uncompressed_sha256,
    gzip_bytes: plan.gzip_bytes,
    gzip_sha256: plan.gzip_sha256,
    packed_primary_bytes: plan.packed_primary_bytes,
    kv_limit_bytes: plan.kv_limit_bytes,
    puts: plan.puts.map(({ key, relative_path, bytes }) => ({ key, relative_path, bytes })),
  };
  const planPath = planOut || join(outDir, "plan.json");
  mkdirSync(dirname(planPath), { recursive: true });
  writeFileSync(planPath, `${JSON.stringify(publicPlan, null, 2)}\n`);
  return { planPath, publicPlan };
}

function required(args, name) {
  const value = args[name];
  if (value == null || value === true || value === "") fail(`missing --${name}`);
  return value;
}

export function parseArgs(argv) {
  const args = { command: null };
  const rest = argv.slice(2);
  if (rest[0] && !rest[0].startsWith("--")) {
    args.command = rest.shift();
  }
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (!argument.startsWith("--")) fail(`unknown argument ${argument}`);
    const name = argument.slice(2);
    const next = rest[index + 1];
    if (next === undefined || next.startsWith("--")) {
      args[name] = true;
    } else {
      args[name] = next;
      index += 1;
    }
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.command === "pack") {
    const inputPath = resolve(ROOT, required(args, "in"));
    const outDir = resolve(ROOT, required(args, "out-dir"));
    const generation = Number(required(args, "generation"));
    const raw = readFileSync(inputPath);
    const plan = packSnapshotForKv(raw, { generation });
    const { publicPlan } = writePackPlan(plan, outDir, {
      planOut: args["plan-out"] ? resolve(ROOT, args["plan-out"]) : null,
    });
    process.stdout.write(`${JSON.stringify(publicPlan)}\n`);
    return 0;
  }
  if (args.command === "unpack") {
    const inputPath = resolve(ROOT, required(args, "in"));
    const outPath = resolve(ROOT, required(args, "out"));
    const primaryText = readFileSync(inputPath, "utf8");
    let chunksByKey = null;
    if (args["chunks-dir"]) {
      const chunksDir = resolve(ROOT, args["chunks-dir"]);
      const parsed = parseKvText(primaryText);
      if (parsed?.encoding === "gzip-base64-chunked") {
        chunksByKey = {};
        for (let index = 0; index < (parsed.chunk_keys || []).length; index += 1) {
          const key = parsed.chunk_keys[index];
          const chunkPath = join(chunksDir, `chunk-${index}.json`);
          if (!existsSync(chunkPath)) fail(`missing chunk file ${chunkPath}`);
          chunksByKey[key] = readFileSync(chunkPath, "utf8");
        }
      }
    }
    const raw = unpackSnapshotFromKv(primaryText, { chunksByKey });
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, raw);
    const preview = JSON.parse(raw.toString("utf8"));
    if (preview?.schema !== SNAPSHOT_SCHEMA) {
      fail(`unpacked snapshot has unexpected schema ${preview?.schema ?? "missing"}`);
    }
    process.stdout.write(`${JSON.stringify({
      out: outPath,
      uncompressed_bytes: raw.byteLength,
      schema: preview.schema,
    })}\n`);
    return 0;
  }
  if (args.command === "assert-fits") {
    const path = resolve(ROOT, required(args, "path"));
    const key = args.key || null;
    const bytes = readFileSync(path).byteLength;
    assertKvValueFits(bytes, { key, label: path });
    process.stdout.write(`${JSON.stringify({ path, key, bytes, limit_bytes: KV_VALUE_LIMIT_BYTES })}\n`);
    return 0;
  }
  fail("usage: pack | unpack | assert-fits");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv) || 0;
  } catch (error) {
    console.error(error?.stack || error);
    process.exitCode = 1;
  }
}
