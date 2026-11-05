#!/usr/bin/env node

/**
 * Observe documents for an explicit, bounded list of PASSPort RFx ids.
 *
 * Generated output is deliberately written to an operator-supplied staging
 * directory. Publishing staged files under site/data is a separate release
 * boundary and this command refuses to cross it.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  boundedHttpGet,
  createNavigatorObservationState,
  isAllowedNavigatorDocumentUrl,
  isAllowedNavigatorUrl,
  MAX_DOCUMENT_BYTES,
  observeNavigatorRfxDocuments,
} from "../warehouse/lib/navigator_rfx_documents.mjs";
import { detectPdfLibraryVersionViaPython } from "../warehouse/lib/seqra_document_extraction.mjs";
import { RFX_DATA_URL, parseRfxDump } from "../worker/src/lib/passport_parse.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_EXTRACTOR_VERSION = "seqra_document_page_extract.py.v1";
const DEFAULT_ONTOLOGY_VERSION = "procurement-documents.v1";
const DEFAULT_RULES_VERSION = "observation-only.v1";

function usage(message = null) {
  if (message) console.error(message);
  console.error(
    "usage: node tools/observe_navigator_rfx_documents.mjs "
    + "--rfp-id <id> [--rfp-id <id> ...] --output-dir <staging-dir> "
    + "[--rfx-dump <rfxData.js>] [--extractor-version <version>] "
    + "[--pdf-library-version <version>] [--ontology-version <version>] [--rules-version <version>]",
  );
  process.exit(2);
}

function parseArgs(argv) {
  const options = { rfpIds: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--rfp-id" && value) {
      options.rfpIds.push(value);
      index += 1;
    } else if (arg === "--output-dir" && value) {
      options.outputDir = value;
      index += 1;
    } else if (arg === "--rfx-dump" && value) {
      options.rfxDump = value;
      index += 1;
    } else if (arg === "--extractor-version" && value) {
      options.extractorVersion = value;
      index += 1;
    } else if (arg === "--pdf-library-version" && value) {
      options.pdfLibraryVersion = value;
      index += 1;
    } else if (arg === "--ontology-version" && value) {
      options.ontologyVersion = value;
      index += 1;
    } else if (arg === "--rules-version" && value) {
      options.rulesVersion = value;
      index += 1;
    } else {
      usage(`unknown or incomplete argument: ${arg}`);
    }
  }
  if (!options.rfpIds.length) usage("at least one --rfp-id is required");
  if (!options.outputDir) usage("--output-dir is required");
  return options;
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function readExistingExtractions(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => JSON.parse(readFileSync(path.join(directory, entry.name), "utf8")));
}

async function rfxRowsFrom(options) {
  if (options.rfxDump) return parseRfxDump(readFileSync(path.resolve(options.rfxDump), "utf8"));
  const result = await boundedHttpGet(RFX_DATA_URL, {
    maxBytes: MAX_DOCUMENT_BYTES,
    allowedUrl: (url) => url === RFX_DATA_URL,
  });
  if (!result.ok) throw new Error(`RFx dump acquisition failed: ${result.failure.type}`);
  return parseRfxDump(result.bytes.toString("utf8"));
}

function assertStagingBoundary(outputDir) {
  const relative = path.relative(ROOT, outputDir).split(path.sep).join("/");
  if (relative === "site/data" || relative.startsWith("site/data/")) {
    throw new Error("observation output is staging-only; publication under site/data is a separate release boundary");
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const outputDir = path.resolve(options.outputDir);
  assertStagingBoundary(outputDir);
  const extractionDir = path.join(outputDir, "extractions");
  const existingExtractions = readExistingExtractions(extractionDir);
  const state = createNavigatorObservationState(existingExtractions);
  const rfxRows = await rfxRowsFrom(options);
  const pdfLibraryVersion = options.pdfLibraryVersion || detectPdfLibraryVersionViaPython();
  const httpGet = (url, request) => boundedHttpGet(url, {
    maxBytes: request.maxBytes,
    allowedUrl: request.kind === "navigator" ? isAllowedNavigatorUrl : isAllowedNavigatorDocumentUrl,
  });

  const result = await observeNavigatorRfxDocuments({
    targetRfpIds: options.rfpIds,
    rfxRows,
    httpGet,
    projectRoot: ROOT,
    state,
    extractorVersion: options.extractorVersion || DEFAULT_EXTRACTOR_VERSION,
    pdfLibraryVersion,
    ontologyVersion: options.ontologyVersion || DEFAULT_ONTOLOGY_VERSION,
    rulesVersion: options.rulesVersion || DEFAULT_RULES_VERSION,
  });

  mkdirSync(outputDir, { recursive: true });
  mkdirSync(extractionDir, { recursive: true });
  writeFileSync(path.join(outputDir, "procurement_documents.json"), stableJson(result.manifest));
  const shardDir = path.join(outputDir, "procurement_documents");
  mkdirSync(shardDir, { recursive: true });
  for (const [rfpId, shard] of result.shards) {
    writeFileSync(path.join(shardDir, `rfx-${rfpId}.json`), stableJson(shard));
  }
  for (const extraction of result.state.extractions.values()) {
    const digest = extraction.extraction_key.sha256;
    const keyDigest = createHash("sha256").update(JSON.stringify(extraction.extraction_key)).digest("hex");
    writeFileSync(path.join(extractionDir, `${digest}--${keyDigest}.json`), stableJson(extraction));
  }
  writeFileSync(path.join(outputDir, "failures.json"), stableJson(result.failures));

  console.log(
    `navigator RFx documents: targets=${options.rfpIds.length} shards=${result.shards.size} `
    + `rows=${result.manifest.row_count} failures=${result.failures.length} `
    + `extractions=${result.state.extractions.size} cache_misses=${result.state.extraction_runs}`,
  );
  if (result.failures.length) process.exitCode = 1;
}

await main();
