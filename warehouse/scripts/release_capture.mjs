#!/usr/bin/env node
// Capture a public-records release into the warehouse and close its taxonomy gap.
// The manifest is the boundary between private acquisition machinery and this repo.

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { renderGapTaxonomyDocument } from "../../tools/depot.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MANIFEST_SCHEMA = "cityscroll.public_records_release_manifest.v1";
const RECEIPT_SCHEMA = "cityscroll.public_records_release_receipt.v1";
const SOURCE_TYPE = "public-records request (FOIL)";

function usage() {
  return `Usage: node warehouse/scripts/release_capture.mjs --manifest path [options]

Options:
  --manifest path       Release manifest; artifact.path is relative to this file
  --warehouse-root path Defaults to ./warehouse
  --taxonomy path       Defaults to ./site/data/gap_taxonomy.json
  --taxonomy-doc path   Defaults to ./docs/gap-taxonomy.md
`;
}

function parseArgs(argv) {
  const args = {
    manifest: null,
    warehouseRoot: join(ROOT, "warehouse"),
    taxonomy: join(ROOT, "site/data/gap_taxonomy.json"),
    taxonomyDoc: join(ROOT, "docs/gap-taxonomy.md"),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--manifest") args.manifest = argv[++i];
    else if (arg === "--warehouse-root") args.warehouseRoot = resolve(argv[++i]);
    else if (arg === "--taxonomy") args.taxonomy = resolve(argv[++i]);
    else if (arg === "--taxonomy-doc") args.taxonomyDoc = resolve(argv[++i]);
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  return args;
}

function fail(message) {
  throw new Error(`release capture refused: ${message}`);
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") fail(`${label} is required`);
  return value.trim();
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) fail("manifest must be an object");
  if (manifest.schema !== MANIFEST_SCHEMA) fail(`manifest schema must be ${MANIFEST_SCHEMA}`);
  const releaseId = requiredString(manifest.release_id, "release_id");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(releaseId)) fail("release_id contains unsupported characters");
  if (!manifest.source || typeof manifest.source !== "object") fail("source is required");
  if (manifest.source.type !== SOURCE_TYPE) fail(`source.type must be ${SOURCE_TYPE}`);
  const sourceBody = requiredString(manifest.source.body, "source.body");
  const requestIdentifier = requiredString(manifest.source.request_identifier, "source.request_identifier");
  const receivedDate = requiredString(manifest.source.received_date, "source.received_date");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(receivedDate)) fail("source.received_date must be YYYY-MM-DD");
  if (!manifest.artifact || typeof manifest.artifact !== "object") fail("artifact is required");
  const artifactPath = requiredString(manifest.artifact.path, "artifact.path");
  const artifactHash = requiredString(manifest.artifact.sha256, "artifact.sha256");
  if (!/^[a-f0-9]{64}$/.test(artifactHash)) fail("artifact.sha256 must be lowercase SHA-256");
  const format = requiredString(manifest.artifact.format, "artifact.format");
  if (!/^[a-z0-9][a-z0-9.+-]{0,31}$/.test(format)) fail("artifact.format contains unsupported characters");
  const gapId = requiredString(manifest.gap_id, "gap_id");
  return {
    releaseId,
    source: {
      type: SOURCE_TYPE,
      body: sourceBody,
      request_identifier: requestIdentifier,
      received_date: receivedDate,
    },
    artifact: { path: artifactPath, sha256: artifactHash, format },
    gapId,
  };
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function stableComparable(value) {
  return JSON.stringify(value);
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
  renameSync(temp, path);
}

function copyAtomic(source, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  const temp = `${destination}.tmp-${process.pid}`;
  copyFileSync(source, temp);
  renameSync(temp, destination);
}

function relativeRepoPath(path) {
  const rel = relative(ROOT, path);
  return rel && !rel.startsWith(`..${sep}`) && rel !== ".." ? rel.split(sep).join("/") : path;
}

function closureLink(taxonomyDoc, receiptPath) {
  return relative(dirname(taxonomyDoc), receiptPath).split(sep).join("/");
}

function applyClosure(taxonomy, gapId, receipt, receiptLink) {
  if (!Array.isArray(taxonomy.gaps)) fail("taxonomy.gaps must be an array");
  const index = taxonomy.gaps.findIndex((gap) => gap && gap.id === gapId);
  if (index < 0) fail(`gap_id ${gapId} is not present in the taxonomy`);
  const current = taxonomy.gaps[index];
  if (current.closure_receipt && current.closure_receipt !== receiptLink) {
    fail(`gap ${gapId} already has a different closure receipt`);
  }
  if (current.closure?.receipt && current.closure.receipt !== receiptLink) {
    fail(`gap ${gapId} already has a different acquisition closure`);
  }
  const next = {
    ...current,
    class: "not_yet_ingested",
    disposition: "landed",
    closure_receipt: receiptLink,
    closure: {
      status: "closed_by_acquisition",
      closed_on: receipt.source.received_date,
      receipt: receiptLink,
      release_id: receipt.release_id,
      artifact_sha256: receipt.artifact.sha256,
    },
    public_source: current.public_source || {
      name: "Public-records request (FOIL) release",
      access: "Obtained record artifact retained in the public warehouse",
      update_cadence: "As released",
      join_keys: [],
    },
  };
  if (current.class === "not_published") {
    next.class_change = {
      from: "not_published",
      to: "not_yet_ingested",
      reason: "A public-records request (FOIL) release was acquired and retained in the warehouse.",
      observed_on: receipt.source.received_date,
    };
  }
  taxonomy.gaps[index] = next;
  return { beforeClass: current.class, afterClass: next.class, changed: stableComparable(current) !== stableComparable(next) };
}

function buildReceipt(capture, artifactSource, rawPath, receiptPath, beforeClass = null) {
  return {
    schema: RECEIPT_SCHEMA,
    release_id: capture.releaseId,
    status: "captured",
    captured_at: new Date().toISOString(),
    source: capture.source,
    artifact: {
      raw_path: relativeRepoPath(rawPath),
      source_path: relativeRepoPath(artifactSource),
      bytes: statSync(artifactSource).size,
      format: capture.artifact.format,
      sha256: capture.artifact.sha256,
    },
    gap: {
      id: capture.gapId,
      before_class: beforeClass,
      after_class: "not_yet_ingested",
      disposition: "landed",
      closure_receipt: relativeRepoPath(receiptPath),
    },
  };
}

function sameRelease(receipt, capture) {
  return receipt?.schema === RECEIPT_SCHEMA
    && receipt.release_id === capture.releaseId
    && stableComparable(receipt.source) === stableComparable(capture.source)
    && receipt.artifact?.sha256 === capture.artifact.sha256
    && receipt.artifact?.format === capture.artifact.format
    && receipt.gap?.id === capture.gapId;
}

export function captureRelease({ manifestPath, warehouseRoot, taxonomyPath, taxonomyDocPath }) {
  const manifestAbsolute = resolve(manifestPath);
  const capture = validateManifest(JSON.parse(readFileSync(manifestAbsolute, "utf8")));
  const artifactSource = resolve(dirname(manifestAbsolute), capture.artifact.path);
  if (!existsSync(artifactSource)) fail(`artifact file does not exist: ${capture.artifact.path}`);
  const actualHash = sha256(artifactSource);
  if (actualHash !== capture.artifact.sha256) {
    fail(`artifact hash mismatch: manifest=${capture.artifact.sha256} actual=${actualHash}`);
  }

  const root = resolve(warehouseRoot);
  const rawPath = join(root, "raw", "public-records", capture.releaseId, basename(artifactSource));
  const receiptPath = join(root, "receipts", "public-records", `${capture.releaseId}.json`);
  const receiptLink = closureLink(resolve(taxonomyDocPath), receiptPath);
  const taxonomy = JSON.parse(readFileSync(resolve(taxonomyPath), "utf8"));

  let receipt;
  let status = "captured";
  if (existsSync(receiptPath)) {
    const existing = JSON.parse(readFileSync(receiptPath, "utf8"));
    if (!sameRelease(existing, capture)) fail(`release ${capture.releaseId} already exists with different provenance`);
    const existingRawPath = existing.artifact?.raw_path && existing.artifact.raw_path.startsWith("/")
      ? existing.artifact.raw_path
      : existing.artifact?.raw_path
        ? resolve(ROOT, existing.artifact.raw_path)
        : rawPath;
    if (!existsSync(existingRawPath) || sha256(existingRawPath) !== capture.artifact.sha256) {
      fail(`release ${capture.releaseId} receipt exists but warehouse artifact is missing or altered`);
    }
    receipt = existing;
    status = "duplicate";
  } else {
    if (existsSync(rawPath) && sha256(rawPath) !== capture.artifact.sha256) {
      fail(`warehouse artifact path is occupied by a different hash: ${rawPath}`);
    }
    copyAtomic(artifactSource, rawPath);
    receipt = buildReceipt(capture, artifactSource, rawPath, receiptPath);
    writeJsonAtomic(receiptPath, receipt);
  }

  const closure = applyClosure(taxonomy, capture.gapId, receipt, receiptLink);
  if (closure.changed || status === "captured") {
    writeJsonAtomic(resolve(taxonomyPath), taxonomy);
    writeFileSync(resolve(taxonomyDocPath), `${renderGapTaxonomyDocument(taxonomy).replace(/\n?$/, "\n")}`, "utf8");
  }

  return {
    status,
    release_id: capture.releaseId,
    receipt_path: relativeRepoPath(receiptPath),
    raw_path: relativeRepoPath(rawPath),
    gap_id: capture.gapId,
    gap_class: taxonomy.gaps.find((gap) => gap.id === capture.gapId)?.class,
    gap_disposition: taxonomy.gaps.find((gap) => gap.id === capture.gapId)?.disposition,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!args.manifest) throw new Error("--manifest is required\n\n" + usage());
  const result = captureRelease({
    manifestPath: args.manifest,
    warehouseRoot: args.warehouseRoot,
    taxonomyPath: args.taxonomy,
    taxonomyDocPath: args.taxonomyDoc,
  });
  console.log(JSON.stringify(result));
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
