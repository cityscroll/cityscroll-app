#!/usr/bin/env node

/**
 * Publish an already-generated procurement-document read model under site/data.
 *
 * Observation and extraction stay in their bounded warehouse command. This
 * release seam validates the complete staged manifest and every declared shard
 * before it changes the served tree, then copies the validated bytes unchanged.
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  NAVIGATOR_DOCUMENT_SCHEMA,
  NAVIGATOR_MANIFEST_SCHEMA,
} from "../warehouse/lib/navigator_rfx_documents.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_NAME = "procurement_documents.json";
const SHARD_DIRECTORY = "procurement_documents";
export const SECTION_TEXT_INDEX_SCHEMA = "cityscroll.procurement_document_section_text_index.v1";
export const SECTION_TEXT_SHARD_SCHEMA = "cityscroll.procurement_document_section_text.v1";
const SECTION_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_SECTION_TEXT_BYTES = 512 * 1024;

function usage(message = null) {
  if (message) console.error(message);
  console.error(
    "usage: node tools/publish_procurement_documents.mjs "
    + "--generated-dir <staging-dir> [--site-data-dir <site/data>]",
  );
  process.exit(2);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--generated-dir" && value) {
      options.generatedDir = value;
      index += 1;
    } else if (arg === "--site-data-dir" && value) {
      options.siteDataDir = value;
      index += 1;
    } else {
      usage(`unknown or incomplete argument: ${arg}`);
    }
  }
  if (!options.generatedDir) usage("--generated-dir is required");
  return options;
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function assertPositiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Read and validate the complete staged publication without mutating output. */
export function readProcurementDocumentPublication(generatedDir) {
  const sourceDir = path.resolve(generatedDir);
  const manifestPath = path.join(sourceDir, MANIFEST_NAME);
  if (!existsSync(manifestPath)) throw new Error(`missing generated output: ${manifestPath}`);

  const manifestBytes = readFileSync(manifestPath);
  if (!manifestBytes.length) throw new Error(`generated output is empty: ${manifestPath}`);
  const manifest = parseJson(manifestBytes, MANIFEST_NAME);
  if (manifest.schema !== NAVIGATOR_MANIFEST_SCHEMA) {
    throw new Error(`${MANIFEST_NAME} has unsupported schema ${JSON.stringify(manifest.schema)}`);
  }
  if (manifest.representation !== "sharded") {
    throw new Error(`${MANIFEST_NAME} must use the sharded representation`);
  }
  if (manifest.shard_schema !== NAVIGATOR_DOCUMENT_SCHEMA) {
    throw new Error(`${MANIFEST_NAME} has unsupported shard_schema ${JSON.stringify(manifest.shard_schema)}`);
  }
  if (!Array.isArray(manifest.shards) || manifest.shards.length === 0) {
    throw new Error(`${MANIFEST_NAME} must declare at least one shard`);
  }

  const seenRfpIds = new Set();
  const seenPaths = new Set();
  const shards = manifest.shards.map((entry, index) => {
    const label = `shards[${index}]`;
    const rfpId = String(entry?.rfp_id ?? "");
    const expectedPath = `${SHARD_DIRECTORY}/rfx-${rfpId}.json`;
    if (!/^\d{3,}$/.test(rfpId)) throw new Error(`${label}.rfp_id must be numeric`);
    if (entry.path !== expectedPath) throw new Error(`${label}.path must be ${expectedPath}`);
    if (seenRfpIds.has(rfpId) || seenPaths.has(entry.path)) throw new Error(`${label} is duplicated`);
    seenRfpIds.add(rfpId);
    seenPaths.add(entry.path);
    assertPositiveInteger(entry.bytes, `${label}.bytes`);
    assertPositiveInteger(entry.row_count, `${label}.row_count`);

    const sourcePath = path.join(sourceDir, ...entry.path.split("/"));
    if (!existsSync(sourcePath)) throw new Error(`missing generated output: ${sourcePath}`);
    const bytes = readFileSync(sourcePath);
    if (!bytes.length) throw new Error(`generated output is empty: ${sourcePath}`);
    if (bytes.length !== entry.bytes) {
      throw new Error(`${label}.bytes=${entry.bytes} does not match generated shard bytes=${bytes.length}`);
    }
    const digest = sha256Hex(bytes);
    if (!/^[a-f0-9]{64}$/.test(entry.sha256 || "") || entry.sha256 !== digest) {
      throw new Error(`${label}.sha256 does not match the generated shard`);
    }
    const shard = parseJson(bytes, entry.path);
    if (shard.schema !== NAVIGATOR_DOCUMENT_SCHEMA) {
      throw new Error(`${entry.path} has unsupported schema ${JSON.stringify(shard.schema)}`);
    }
    if (String(shard.subject?.rfp_id ?? "") !== rfpId) {
      throw new Error(`${entry.path} subject.rfp_id does not match its manifest entry`);
    }
    if (!Array.isArray(shard.rows) || shard.rows.length !== entry.row_count) {
      throw new Error(`${entry.path} row count does not match its manifest entry`);
    }
    const sectionText = readOptionalSectionText(sourceDir, rfpId, shard);
    return Object.freeze({ entry, sourcePath, bytes, shard, sectionText });
  });

  const rowCount = shards.reduce((sum, item) => sum + item.shard.rows.length, 0);
  if (manifest.row_count !== undefined && manifest.row_count !== rowCount) {
    throw new Error(`${MANIFEST_NAME} row_count does not match its shards`);
  }
  if (manifest.coverage?.documents !== undefined && manifest.coverage.documents !== rowCount) {
    throw new Error(`${MANIFEST_NAME} coverage.documents does not match its shards`);
  }
  return Object.freeze({ manifestPath, manifestBytes, manifest, shards: Object.freeze(shards) });
}

function readOptionalSectionText(sourceDir, rfpId, parentShard) {
  const indexRel = `${SHARD_DIRECTORY}/rfx-${rfpId}/sections.json`;
  const indexPath = path.join(sourceDir, ...indexRel.split("/"));
  if (!existsSync(indexPath)) return null;
  const indexBytes = readFileSync(indexPath);
  if (!indexBytes.length) throw new Error(`generated output is empty: ${indexPath}`);
  const index = parseJson(indexBytes, indexRel);
  if (index.schema !== SECTION_TEXT_INDEX_SCHEMA) {
    throw new Error(`${indexRel} has unsupported schema ${JSON.stringify(index.schema)}`);
  }
  if (String(index.rfp_id ?? "") !== rfpId) {
    throw new Error(`${indexRel} rfp_id does not match ${rfpId}`);
  }
  const parentDoc = (parentShard.rows || []).find((row) => String(row.document_id) === String(index.document_id));
  if (!parentDoc) {
    throw new Error(`${indexRel} document_id ${JSON.stringify(index.document_id)} is not in parent shard`);
  }
  if (index.document_sha256 !== parentDoc.sha256) {
    throw new Error(`${indexRel} document_sha256 does not match parent document`);
  }
  if (!Array.isArray(index.sections) || index.sections.length === 0) {
    throw new Error(`${indexRel} must declare at least one section`);
  }
  const parentSections = new Map((parentDoc.sections || []).map((sec) => [sec.id, sec]));
  const seenIds = new Set();
  const sections = index.sections.map((entry, idx) => {
    const label = `${indexRel}:sections[${idx}]`;
    const id = String(entry?.id ?? "");
    if (!SECTION_ID_PATTERN.test(id) || seenIds.has(id)) {
      throw new Error(`${label}.id is invalid or duplicated`);
    }
    seenIds.add(id);
    const parentSec = parentSections.get(id);
    if (!parentSec) throw new Error(`${label}.id=${id} is not declared in parent shard`);
    const expectedPath = `${SHARD_DIRECTORY}/rfx-${rfpId}/sections/${id}.json`;
    if (entry.path !== expectedPath) throw new Error(`${label}.path must be ${expectedPath}`);
    assertPositiveInteger(entry.bytes, `${label}.bytes`);
    if (entry.bytes === 0 || entry.bytes > MAX_SECTION_TEXT_BYTES) {
      throw new Error(`${label}.bytes=${entry.bytes} exceeds bounds`);
    }
    const secSourcePath = path.join(sourceDir, ...entry.path.split("/"));
    if (!existsSync(secSourcePath)) throw new Error(`missing generated output: ${secSourcePath}`);
    const bytes = readFileSync(secSourcePath);
    if (bytes.length !== entry.bytes) {
      throw new Error(`${label}.bytes=${entry.bytes} does not match file bytes=${bytes.length}`);
    }
    const digest = sha256Hex(bytes);
    if (!/^[a-f0-9]{64}$/.test(entry.sha256 || "") || entry.sha256 !== digest) {
      throw new Error(`${label}.sha256 does not match file digest`);
    }
    const payload = parseJson(bytes, entry.path);
    if (payload.schema !== SECTION_TEXT_SHARD_SCHEMA) {
      throw new Error(`${entry.path} has unsupported schema ${JSON.stringify(payload.schema)}`);
    }
    if (String(payload.rfp_id ?? "") !== rfpId || String(payload.section?.id ?? "") !== id) {
      throw new Error(`${entry.path} identity does not match index entry`);
    }
    const expectedCount = parentSec.pdf_pages[1] - parentSec.pdf_pages[0] + 1;
    if (!Array.isArray(payload.pages) || payload.pages.length !== expectedCount) {
      throw new Error(`${entry.path} page count does not match parent section page range`);
    }
    return Object.freeze({ entry, sourcePath: secSourcePath, bytes, payload });
  });
  return Object.freeze({ indexRel, indexPath, indexBytes, index, sections: Object.freeze(sections) });
}

/** Validate first, then replace only the served procurement-document paths. */
export function publishProcurementDocuments({ generatedDir, siteDataDir = path.join(ROOT, "site/data") }) {
  const publication = readProcurementDocumentPublication(generatedDir);
  const destinationRoot = path.resolve(siteDataDir);
  if (path.dirname(publication.manifestPath) === destinationRoot) {
    throw new Error("generated and served procurement-document directories must be distinct");
  }
  const destinationShardDir = path.join(destinationRoot, SHARD_DIRECTORY);
  const destinationManifest = path.join(destinationRoot, MANIFEST_NAME);

  mkdirSync(destinationRoot, { recursive: true });
  rmSync(destinationShardDir, { recursive: true, force: true });
  mkdirSync(destinationShardDir, { recursive: true });
  for (const item of publication.shards) {
    const destination = path.join(destinationRoot, ...item.entry.path.split("/"));
    copyFileSync(item.sourcePath, destination);
    if (!readFileSync(destination).equals(item.bytes)) throw new Error(`published shard changed bytes: ${item.entry.path}`);
    if (item.sectionText) {
      const destIndex = path.join(destinationRoot, ...item.sectionText.indexRel.split("/"));
      mkdirSync(path.dirname(destIndex), { recursive: true });
      copyFileSync(item.sectionText.indexPath, destIndex);
      if (!readFileSync(destIndex).equals(item.sectionText.indexBytes)) {
        throw new Error(`published section index changed bytes: ${item.sectionText.indexRel}`);
      }
      for (const sec of item.sectionText.sections) {
        const destSec = path.join(destinationRoot, ...sec.entry.path.split("/"));
        mkdirSync(path.dirname(destSec), { recursive: true });
        copyFileSync(sec.sourcePath, destSec);
        if (!readFileSync(destSec).equals(sec.bytes)) {
          throw new Error(`published section shard changed bytes: ${sec.entry.path}`);
        }
      }
    }
  }
  copyFileSync(publication.manifestPath, destinationManifest);
  if (!readFileSync(destinationManifest).equals(publication.manifestBytes)) {
    throw new Error(`published manifest changed bytes: ${MANIFEST_NAME}`);
  }

  return Object.freeze({
    generated_at: publication.manifest.generated_at,
    row_count: publication.shards.reduce((sum, item) => sum + item.shard.rows.length, 0),
    shards: Object.freeze(publication.shards.map((item) => Object.freeze({
      rfp_id: String(item.entry.rfp_id),
      path: item.entry.path,
      bytes: item.bytes.length,
      sha256: item.entry.sha256,
      section_text_count: item.sectionText ? item.sectionText.sections.length : 0,
    }))),
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = publishProcurementDocuments({
    generatedDir: options.generatedDir,
    siteDataDir: options.siteDataDir || path.join(ROOT, "site/data"),
  });
  console.log(
    `published procurement documents: generated_at=${result.generated_at} `
    + `shards=${result.shards.length} rows=${result.row_count}`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
