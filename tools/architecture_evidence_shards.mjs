#!/usr/bin/env node

/**
 * Architecture-evidence entry shards.
 *
 * architecture/evidence.d/<stable-entry-id>.json is the source-owned registry.
 * This aggregator discovers those entries, validates identity and schema, and
 * derives the existing card-inventory / card-projection-inventory aggregates
 * in memory or into an untracked check/build destination.
 * --check never writes and must not regenerate tracked files.
 * --write may emit gitignored compatibility files under .artifacts/.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { evaluateCardReconciliation } from "./card_reconciliation_guard.mjs";
import {
  inspectForbiddenFields,
  inspectPublicIdentity,
  inspectRawIdentityEscapes,
} from "./public_identity_contract.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const ENTRY_SCHEMA = "cityscroll.architecture-evidence-entry.v1";
export const ENTRY_SCHEMA_PATH = "architecture/evidence-entry.v1.schema.json";
export const ENTRY_DIR = "architecture/evidence.d";
export const SOURCE_CARDS_SCHEMA = "cityscroll.card-inventory.v1";
export const PROJECTION_INVENTORY_SCHEMA = "cityscroll.card-projection-inventory.v1";
export const SOURCE_CARDS_RELATIVE = "architecture-evidence/source-cards.json";
export const PROJECTIONS_RELATIVE = "architecture-evidence/projections.json";
export const FORBIDDEN_TRACKED_AGGREGATES = Object.freeze([
  SOURCE_CARDS_RELATIVE,
  PROJECTIONS_RELATIVE,
]);
export const GENERATED_AGGREGATE_DIR = ".artifacts/architecture-evidence";
export const GENERATED_SOURCE_CARDS_RELATIVE = `${GENERATED_AGGREGATE_DIR}/source-cards.json`;
export const GENERATED_PROJECTIONS_RELATIVE = `${GENERATED_AGGREGATE_DIR}/projections.json`;
export const AGGREGATE_RECEIPT_SCHEMA = "cityscroll.architecture-evidence-aggregate.v1";
export const SUPPORTED_ENTRY_SCHEMAS = Object.freeze([ENTRY_SCHEMA]);

const ENTRY_SEGMENT = "[a-z0-9]+(?:[._-][a-z0-9]+)*";
const ENTRY_ID_PATTERN = new RegExp(`^${ENTRY_SEGMENT}(?:/${ENTRY_SEGMENT})*$`);
const IGNORED_ENTRY_NAMES = new Set(["README.md"]);

// Identity-bearing fields whose source text must be spelled plainly. A JSON
// parser resolves an escape before any value-level rule can see it, so these are
// checked against the raw file text rather than the parsed document.
export const RAW_IDENTITY_FIELDS = Object.freeze(["id", "schema", "fingerprint"]);

function posix(root, filePath) {
  return relative(root, filePath).split("\\").join("/");
}

function compareText(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function encodeEntryId(id) {
  return String(id || "").split("/").join("--");
}

export function decodeEntryFilename(name) {
  const fileName = String(name || "");
  if (!fileName.endsWith(".json")) return null;
  return fileName.slice(0, -".json".length).split("--").join("/");
}

export function entryRelativePath(id) {
  return `${ENTRY_DIR}/${encodeEntryId(id)}.json`;
}

export function renderJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function sha256Text(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function generatedAggregatePaths(outputDir = GENERATED_AGGREGATE_DIR) {
  const directory = String(outputDir || GENERATED_AGGREGATE_DIR).split("\\").join("/").replace(/\/+$/, "");
  return {
    directory,
    sourceCards: `${directory}/source-cards.json`,
    projections: `${directory}/projections.json`,
  };
}

function isForbiddenAggregatePath(relativePath) {
  return FORBIDDEN_TRACKED_AGGREGATES.includes(String(relativePath || "").split("\\").join("/"));
}

const GIT_BINDINGS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_PREFIX",
  "GIT_COMMON_DIR",
];

export function isolatedGitEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of GIT_BINDINGS) delete env[key];
  return env;
}

export function listedTrackedFiles(root, paths) {
  const result = spawnSync("git", ["-C", root, "ls-files", "--", ...paths], {
    encoding: "utf8",
    env: isolatedGitEnv(),
  });
  if (result.status !== 0) return [];
  return result.stdout.split(/\r?\n/).filter(Boolean);
}

export function inspectForbiddenAggregates(root) {
  const base = resolve(root);
  const tracked = new Set(listedTrackedFiles(base, FORBIDDEN_TRACKED_AGGREGATES));
  const findings = [];
  for (const relativePath of FORBIDDEN_TRACKED_AGGREGATES) {
    if (tracked.has(relativePath)) {
      findings.push(finding(
        `generated architecture-evidence aggregate ${relativePath} must not be tracked`,
        { class: "stale_aggregate", path: relativePath },
      ));
      continue;
    }
    const filePath = resolve(base, relativePath);
    if (existsSync(filePath) && statSync(filePath).isFile()) {
      findings.push(finding(
        `generated architecture-evidence aggregate ${relativePath} must not be committed; derive it at check/build time`,
        { class: "stale_aggregate", path: relativePath },
      ));
    }
  }
  return findings;
}

function finding(message, extra = {}) {
  return { message, ...extra };
}

function validateEntryIdentity(id) {
  if (!id || typeof id !== "string" || !id.trim()) {
    return "entry is missing a required id";
  }
  if (id.includes("--")) {
    return `entry id ${id} is not collision-safe; path segments must not contain --`;
  }
  if (!ENTRY_ID_PATTERN.test(id)) {
    return `entry id ${id} is not a deterministic collision-safe identity`;
  }
  return null;
}

function validateEntryShape(entry, filePath) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return `entry ${filePath} is malformed`;
  }
  const schema = entry.schema;
  if (!schema) return `entry ${filePath} is missing schema`;
  if (!SUPPORTED_ENTRY_SCHEMAS.includes(schema)) {
    return `entry ${filePath} has unsupported schema version ${schema}`;
  }
  const identityError = validateEntryIdentity(entry.id);
  if (identityError) return `${identityError} (${filePath})`;
  if (!entry.status || typeof entry.status !== "string") {
    return `entry ${filePath} is missing required identity field status`;
  }
  if (!entry.fingerprint || typeof entry.fingerprint !== "string") {
    return `entry ${filePath} is missing required identity field fingerprint`;
  }
  if (!entry.updated_at || typeof entry.updated_at !== "string") {
    return `entry ${filePath} is missing required identity field updated_at`;
  }
  if (!Array.isArray(entry.projections)) {
    return `entry ${filePath} is missing required projections array`;
  }
  for (const [index, projection] of entry.projections.entries()) {
    if (!projection || typeof projection !== "object" || Array.isArray(projection)) {
      return `entry ${filePath} projection ${index} is malformed`;
    }
    if (!projection.id || typeof projection.id !== "string") {
      return `entry ${filePath} projection ${index} is missing id`;
    }
    if (!projection.path || typeof projection.path !== "string") {
      return `entry ${filePath} projection ${index} is missing path`;
    }
  }
  return null;
}

function cardRecord(entry) {
  return {
    id: entry.id,
    status: entry.status,
    fingerprint: entry.fingerprint,
    updated_at: entry.updated_at,
  };
}

function projectionCardRecord(entry) {
  return {
    id: entry.id,
    status: entry.status,
    source_fingerprint: entry.fingerprint,
    source_updated_at: entry.updated_at,
  };
}

export function buildInventories(entries) {
  const sorted = [...entries].sort((left, right) => compareText(left.id, right.id));
  const sourceCards = {
    schema: SOURCE_CARDS_SCHEMA,
    cards: sorted.map(cardRecord),
  };
  const byProjection = new Map();
  for (const entry of sorted) {
    for (const projection of entry.projections) {
      const key = projection.path;
      let bucket = byProjection.get(key);
      if (!bucket) {
        bucket = {
          id: projection.id,
          path: projection.path,
          cards: [],
        };
        byProjection.set(key, bucket);
      } else if (bucket.id !== projection.id) {
        throw new Error(`projection path ${key} has colliding ids ${bucket.id} and ${projection.id}`);
      }
      if (bucket.cards.some((card) => card.id === entry.id)) {
        throw new Error(`duplicate projection entry for card ${entry.id} in ${key}`);
      }
      bucket.cards.push(projectionCardRecord(entry));
    }
  }
  const projections = {
    schema: PROJECTION_INVENTORY_SCHEMA,
    membership: "declared",
    projections: [...byProjection.values()]
      .sort((left, right) => compareText(left.id, right.id) || compareText(left.path, right.path))
      .map((row) => ({
        id: row.id,
        path: row.path,
        cards: [...row.cards].sort((left, right) => compareText(left.id, right.id)),
      })),
  };
  return { sourceCards, projections };
}

function listEntryFiles(root, directory) {
  const findings = [];
  if (!existsSync(directory)) {
    return {
      files: [],
      findings: [finding(`${ENTRY_DIR} is missing`, { class: "missing_entry" })],
    };
  }
  const listed = readdirSync(directory, { withFileTypes: true });
  const files = [];
  for (const item of listed.sort((left, right) => compareText(left.name, right.name))) {
    const filePath = join(directory, item.name);
    const repoPath = posix(root, filePath);
    if (IGNORED_ENTRY_NAMES.has(item.name)) continue;
    if (item.isDirectory()) {
      findings.push(finding(`unexpected directory in ${ENTRY_DIR}: ${item.name}`, {
        class: "unregistered_entry",
        path: repoPath,
      }));
      continue;
    }
    if (!item.name.endsWith(".json")) {
      findings.push(finding(`unexpected unregistered entry ${repoPath}`, {
        class: "unregistered_entry",
        path: repoPath,
      }));
      continue;
    }
    files.push({ name: item.name, filePath, repoPath });
  }
  return { files, findings };
}

export function loadArchitectureEvidenceEntries({ root = ROOT, entriesDir = ENTRY_DIR } = {}) {
  const base = resolve(root);
  const directory = resolve(base, entriesDir);
  const listed = listEntryFiles(base, directory);
  const findings = [...listed.findings];
  const entries = [];
  const ids = new Map();
  const paths = new Map();

  for (const file of listed.files) {
    let parsed;
    let rawText;
    try {
      rawText = readFileSync(file.filePath, "utf8");
      parsed = JSON.parse(rawText);
    } catch {
      findings.push(finding(`entry ${file.repoPath} is malformed`, {
        class: "malformed_entry",
        path: file.repoPath,
      }));
      continue;
    }
    const shapeError = validateEntryShape(parsed, file.repoPath);
    if (shapeError) {
      const unsupported = String(shapeError).includes("unsupported schema version");
      findings.push(finding(shapeError, {
        class: unsupported ? "unsupported_version" : "invalid_entry",
        path: file.repoPath,
        id: parsed?.id || null,
      }));
      continue;
    }
    // The positive public identity contract. These rules say what a public
    // identity must look like, so the repository never has to carry a list of
    // what it must not look like.
    const contractViolations = [
      ...inspectRawIdentityEscapes(rawText, { path: file.repoPath, fields: RAW_IDENTITY_FIELDS }),
      ...inspectPublicIdentity(parsed.id, { path: file.repoPath, field: "id" }),
      ...inspectForbiddenFields(parsed, { path: file.repoPath }),
    ];
    if (contractViolations.length) {
      for (const row of contractViolations) {
        findings.push(finding(
          `entry ${row.path} violates the public identity contract (${row.rule} at ${row.field}): ${row.detail}`,
          { class: "public_identity_contract", path: row.path, id: null },
        ));
      }
      continue;
    }

    const expectedName = `${encodeEntryId(parsed.id)}.json`;
    if (file.name !== expectedName) {
      findings.push(finding(
        `entry id ${parsed.id} does not match path ${file.repoPath}; expected ${entryRelativePath(parsed.id)}`,
        { class: "collision", path: file.repoPath, id: parsed.id },
      ));
      continue;
    }
    if (ids.has(parsed.id)) {
      findings.push(finding(
        `duplicate entry id ${parsed.id} in ${file.repoPath} and ${ids.get(parsed.id)}`,
        { class: "duplicate_entry", path: file.repoPath, id: parsed.id },
      ));
      continue;
    }
    if (paths.has(expectedName)) {
      findings.push(finding(
        `colliding entry path ${file.repoPath}`,
        { class: "collision", path: file.repoPath, id: parsed.id },
      ));
      continue;
    }
    ids.set(parsed.id, file.repoPath);
    paths.set(expectedName, parsed.id);
    entries.push({
      ...parsed,
      projections: parsed.projections.map((row) => ({ id: row.id, path: row.path })),
      _path: file.repoPath,
    });
  }

  entries.sort((left, right) => compareText(left.id, right.id));
  return { entries, findings };
}

export function aggregateArchitectureEvidence({
  root = ROOT,
  entriesDir = ENTRY_DIR,
} = {}) {
  const loaded = loadArchitectureEvidenceEntries({ root, entriesDir });
  const forbidden = inspectForbiddenAggregates(root);
  const issueRows = [...loaded.findings, ...forbidden];
  const findings = issueRows.map((row) => row.message);
  let sourceCards = null;
  let projections = null;
  let sourceCardsText = null;
  let projectionsText = null;
  if (!loaded.findings.length) {
    try {
      const inventories = buildInventories(loaded.entries);
      sourceCards = inventories.sourceCards;
      projections = inventories.projections;
      sourceCardsText = renderJson(sourceCards);
      projectionsText = renderJson(projections);
    } catch (error) {
      const message = error?.message || String(error);
      findings.push(message);
      issueRows.push(finding(message, { class: "collision" }));
    }
  }

  const receipt = {
    schema: AGGREGATE_RECEIPT_SCHEMA,
    entry_count: loaded.entries.length,
    entry_ids: loaded.entries.map((entry) => entry.id),
    source_cards_sha256: sourceCardsText ? sha256Text(sourceCardsText) : null,
    projections_sha256: projectionsText ? sha256Text(projectionsText) : null,
  };

  if (!findings.length && sourceCards && projections) {
    const reconciliation = evaluateCardReconciliation({ sourceCards, projections });
    if (reconciliation.status !== "PASS") {
      findings.push(...reconciliation.findings);
      issueRows.push(...(reconciliation.evidence?.issues || []).map((row) => (
        finding(row.message, { class: row.class, path: row.projection, id: row.card_id })
      )));
    }
  }

  return {
    status: findings.length ? "FAIL" : "PASS",
    reason: findings[0] || "architecture-evidence shards aggregated",
    findings,
    issues: issueRows,
    entries: loaded.entries,
    sourceCards,
    projections,
    sourceCardsText,
    projectionsText,
    receipt,
  };
}

export function checkArchitectureEvidence(options = {}) {
  return aggregateArchitectureEvidence(options);
}

export function reconcileDerivedArchitectureEvidence(options = {}) {
  const derived = checkArchitectureEvidence(options);
  if (derived.status !== "PASS" || !derived.sourceCards || !derived.projections) {
    return {
      status: "FAIL",
      reason: derived.findings[0] || "architecture-evidence shards failed",
      findings: derived.findings,
      evidence: derived,
    };
  }
  return evaluateCardReconciliation({
    sourceCards: derived.sourceCards,
    projections: derived.projections,
  });
}

export function writeArchitectureEvidenceAggregates({
  root = ROOT,
  sourceCardsText,
  projectionsText,
  outputDir = GENERATED_AGGREGATE_DIR,
  write = false,
} = {}) {
  const paths = generatedAggregatePaths(outputDir);
  if (isForbiddenAggregatePath(paths.sourceCards) || isForbiddenAggregatePath(paths.projections)) {
    throw new Error(`refusing to write tracked architecture-evidence aggregate ${paths.sourceCards}`);
  }
  const sourcePath = resolve(root, paths.sourceCards);
  const projectionsPath = resolve(root, paths.projections);
  if (write) {
    mkdirSync(dirname(sourcePath), { recursive: true });
    mkdirSync(dirname(projectionsPath), { recursive: true });
    writeFileSync(sourcePath, sourceCardsText, "utf8");
    writeFileSync(projectionsPath, projectionsText, "utf8");
  }
  return { sourcePath, projectionsPath, relative: paths };
}

function argument(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] || fallback : fallback;
}

function main(argv = process.argv.slice(2)) {
  const check = argv.includes("--check");
  const write = argv.includes("--write");
  const root = resolve(argument(argv, "--root", ROOT));
  const outputDir = argument(argv, "--output-dir", GENERATED_AGGREGATE_DIR);
  const result = aggregateArchitectureEvidence({ root });
  process.stdout.write(renderJson({
    status: result.status,
    reason: result.reason,
    findings: result.findings,
    receipt: result.receipt,
  }));
  if (result.status !== "PASS") {
    for (const row of result.findings) {
      console.error(`architecture-evidence: ${row}`);
    }
    process.exitCode = 1;
    return;
  }
  if (check) return;
  if (write) {
    writeArchitectureEvidenceAggregates({
      write: true,
      root,
      outputDir,
      sourceCardsText: result.sourceCardsText,
      projectionsText: result.projectionsText,
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error?.stack || error);
    process.exitCode = 1;
  }
}

export {
  ROOT,
  main,
};
