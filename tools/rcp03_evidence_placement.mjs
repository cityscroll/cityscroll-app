#!/usr/bin/env node

/**
 * Repository evidence-placement proof (RCP-03 semantics, RCP-06 materialization).
 *
 * Reviewed placement facts are source-owned shards under
 * docs/repository-control-plane/evidence-placement.d/. Each shard owns exactly one
 * semantic key, so two unrelated changes that touch different document trees never
 * edit the same file. The whole-repository `cityscroll.repository_evidence_placement.v1`
 * receipt is derived from those shards at check time only; it is never tracked.
 *
 * Every shard is re-derived from the inspected commit on each run, so a stale,
 * missing, malformed, duplicate, or semantically incomplete input fails closed.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "21c3d22a3b2314506fda73229e77c80cc3c26de4";
const PRIVATE_MARKER = ["backstage", "://", "cityscroll-evidence/"].join("");
const CARD = "cityscroll-repository-control-plane/rcp-03";
const REVIEWED_AT = "2026-08-31T00:00:00.000Z";

export const RECEIPT_SCHEMA = "cityscroll.repository_evidence_placement.v1";
export const SHARD_SCHEMA = "cityscroll.repository-control-plane.evidence-placement-shard.v1";
export const SHARD_DIRECTORY_RELATIVE = "docs/repository-control-plane/evidence-placement.d";
export const FORBIDDEN_AGGREGATE_RELATIVE = "docs/repository-control-plane/evidence-placement.v1.json";
export const DERIVED_AGGREGATE_RELATIVE = ".artifacts/repository-control-plane/evidence-placement.v1.json";

const SERVED_PREFIXES = ["site/", "worker/"];
const SERVED_TEXT_EXTENSIONS = new Set([
  ".css", ".csv", ".js", ".mjs", ".svg", ".txt", ".webmanifest", ".xml", ".yaml", ".yml"
]);
const RETAINED_PROOF_PATHS = [
  "ARCHITECTURE.md",
  "architecture/evidence.d/README.md",
  "architecture/evidence.d/cityscroll-merge-throughput--mt-7-architecture-evidence-shards.json",
  "architecture/evidence.d/cityscroll-merge-throughput--mt-8-architecture-evidence-generated-aggregates.json",
  "docs/architecture.md",
  "docs/repository-control-plane/evidence-placement.d/README.md",
  "docs/repository-control-plane/evidence-placement-shard.v1.schema.json",
  "tools/architecture_evidence_shards.mjs"
];
const CONSTANT_KEYS = ["placement-attestation", "inventory-scope", "scrim-inventory", "public-result", "bibliography", "preservation", "served-artifacts"];

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}

// An ambient GIT_DIR, GIT_WORK_TREE, or GIT_INDEX_FILE — which git exports into hook
// environments — would override the directory this check is asked about. Resolve the
// repository from the working directory instead, so the check always reads the tree it
// was pointed at.
const GIT_ENVIRONMENT = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));

function git(args, options = {}) {
  return execFileSync("git", args, { cwd: ROOT, env: GIT_ENVIRONMENT, maxBuffer: 256 * 1024 * 1024, ...options });
}

function fromBase(path) {
  return git(["show", `${BASE}:${path}`]);
}

function tracked(pathspec = [], root = ROOT) {
  const args = ["ls-files", "-z", ...(pathspec.length ? ["--", ...pathspec] : [])];
  return git(args, { encoding: "utf8", cwd: root }).split("\0").filter(Boolean);
}

/** Raw review-inventory rows must never return to the public review document. */
export function hasRawInventoryRows(text) {
  return /^\| PB-\d{4} \|/m.test(text);
}

/** Fail-closed scan: the private evidence scheme may not appear in the given files. */
export function privateSchemeFindings(paths, { root = ROOT, detail = "private evidence scheme remains" } = {}) {
  const findings = [];
  for (const path of paths) {
    const absolute = resolve(root, path);
    if (!existsSync(absolute)) continue;
    if (readFileSync(absolute).includes(PRIVATE_MARKER)) findings.push(`${path}: ${detail}`);
  }
  return findings;
}

/** Conflict freedom is structural: the whole-repository aggregate must never be tracked again. */
export function trackedAggregateFindings(root = ROOT) {
  if (!tracked([FORBIDDEN_AGGREGATE_RELATIVE], root).length) return [];
  return [`${FORBIDDEN_AGGREGATE_RELATIVE}: generated whole-repository aggregate must not be tracked; it is derived at check time`];
}

function occurrences(value) {
  return value.toString("utf8").split(PRIVATE_MARKER).length - 1;
}

function treeDigest(prefixes, ref) {
  const listing = git(["ls-tree", "-r", ref, "--", ...prefixes], { encoding: "utf8" });
  const rows = listing.trim().split("\n").filter(Boolean).map((line) => {
    const match = line.match(/^\d+ blob ([0-9a-f]+)\t(.+)$/);
    if (!match) throw new Error(`unexpected git tree row: ${line}`);
    return `${match[2]}\0${match[1]}\n`;
  });
  return { file_count: rows.length, sha256: sha(rows.join("")) };
}

/** The document tree that owns a placement input: the first two path segments. */
export function documentTree(path) {
  const segments = path.split("/");
  return segments.length > 2 ? segments.slice(0, 2).join("/") : segments[0];
}

export function shardPathForId(id) {
  const match = /^document-tree:(.+)$/.exec(id);
  if (match) {
    const segments = match[1].split("/");
    if (!segments.length || segments.some((segment) => !/^[a-z0-9][a-z0-9._-]*$/.test(segment) || segment.includes("--"))) {
      throw new Error(`unsupported document tree ${match[1]}`);
    }
    return `document-tree--${segments.join("--")}.json`;
  }
  if (CONSTANT_KEYS.includes(id)) return `${id}.json`;
  throw new Error(`unsupported evidence placement key: ${id}`);
}

export function idForShardPath(name) {
  if (!name.endsWith(".json")) throw new Error(`unsupported shard file ${name}`);
  const segments = name.slice(0, -".json".length).split("--");
  if (segments[0] === "document-tree") {
    if (segments.length < 2) throw new Error(`unsupported shard file ${name}`);
    return `document-tree:${segments.slice(1).join("/")}`;
  }
  if (segments.length !== 1) throw new Error(`unsupported shard file ${name}`);
  return segments[0];
}

/**
 * Placement truth re-derived from the inspected commit. Shards are reviewed
 * assertions about this derivation, never a substitute for it.
 */
export function derivePlacementFacts() {
  const classification = JSON.parse(fromBase("docs/repository-control-plane/classification.v1.json"));
  const classified = classification.entries.filter((entry) => entry.canonical_owner === CARD && entry.id.startsWith("private-uri:"));
  const evidencePaths = classified.map((entry) => entry.path);
  evidencePaths.push("docs/performance/content-parity/notice-context-critical-path/reports/index.html");
  const documents = [...new Set(evidencePaths)].sort().map((path) => {
    const bytes = fromBase(path);
    const refs = bytes.toString("utf8").split(/\s+/).filter((token) => token.includes(PRIVATE_MARKER));
    return {
      path,
      source_sha256: sha(bytes),
      private_reference_count: occurrences(bytes),
      private_reference_set_sha256: sha([...new Set(refs)].sort().join("\n")),
      classification: "owner-only-evidence-reference",
      disposition: `register:${CARD}#private-evidence`,
      maintainer_resolution: `register:${CARD}#authorized-maintainer-access`
    };
  });

  const byTree = new Map();
  for (const document of documents) {
    const tree = documentTree(document.path);
    if (!byTree.has(tree)) byTree.set(tree, []);
    byTree.get(tree).push(document);
  }
  const trees = [...byTree.keys()].sort();

  const scrimBytes = fromBase("docs/repository-scrim-review.md");
  const scrim = scrimBytes.toString("utf8");
  const rows = [...scrim.matchAll(/^\| (PB-\d{4}) \|.*?\| ([^|]+) \| ([^|]+) \|/gm)];
  const byScope = Object.create(null);
  const byVerdict = Object.create(null);
  for (const row of rows) {
    const scope = row[2].trim();
    const verdict = row[3].trim();
    byScope[scope] = (byScope[scope] || 0) + 1;
    byVerdict[verdict] = (byVerdict[verdict] || 0) + 1;
  }

  const served = treeDigest(["site", "worker"], BASE);
  return {
    inspected_main_commit: BASE,
    documents,
    trees,
    documentsByTree: byTree,
    document_count: documents.length,
    reference_count: documents.reduce((sum, row) => sum + row.private_reference_count, 0),
    scrim: {
      source_path_at_inspected_commit: "docs/repository-scrim-review.md",
      source_sha256: sha(scrimBytes),
      row_count: rows.length,
      first_id: rows.at(0)?.[1],
      last_id: rows.at(-1)?.[1],
      row_ids_sha256: sha(rows.map((row) => row[1]).join("\n")),
      by_scope: byScope,
      by_verdict: byVerdict,
      classification: "private-generated-review-inventory",
      disposition: `register:${CARD}#scrim-inventory`,
      maintainer_resolution: `register:${CARD}#authorized-maintainer-access`
    },
    served
  };
}

/** The reviewed shard values a clean derivation implies, keyed by semantic id. */
export function expectedShardValues(facts) {
  const values = new Map();
  values.set("placement-attestation", {
    privacy_model: "placement-not-deletion",
    inspected_main_commit: facts.inspected_main_commit,
    history_treatment: "none; this is a tip-level placement change"
  });
  values.set("inventory-scope", {
    document_trees: facts.trees,
    document_count: facts.document_count,
    reference_count: facts.reference_count,
    unresolved_research_owner: `register:${CARD}#private-research`
  });
  values.set("scrim-inventory", facts.scrim);
  for (const tree of facts.trees) {
    const documents = facts.documentsByTree.get(tree);
    values.set(`document-tree:${tree}`, {
      tree,
      document_count: documents.length,
      reference_count: documents.reduce((sum, row) => sum + row.private_reference_count, 0),
      documents
    });
  }
  values.set("public-result", {
    reviewed_at: "2026-08-04",
    conclusion: "The review classified 1,144 occurrences: 1,143 were intentional public or non-published local material, one obsolete tip entry was removed, and none required credential rotation or history rewriting.",
    raw_inventory_rows_retained: 0,
    private_reference_occurrences_retained_in_public_content: 0
  });
  values.set("bibliography", [
    { former_private_id: "699", public_citation: "Edward R. Tufte, The Visual Display of Quantitative Information, 2nd ed. (Graphics Press, 2001)." },
    { former_private_id: "851", public_citation: "Alan Cooper et al., About Face: The Essentials of Interaction Design, 4th ed. (Wiley, 2014)." },
    { former_private_id: "853", public_citation: "Don Norman, The Design of Everyday Things, rev. ed. (Basic Books, 2013)." },
    { former_private_id: "854", public_citation: "Steve Krug, Don't Make Me Think, Revisited, 3rd ed. (New Riders, 2014)." },
    { former_private_id: "1183", public_citation: "Richard T. Snodgrass, Developing Time-Oriented Database Applications in SQL (Morgan Kaufmann, 1999)." },
    { former_private_id: "1182", public_citation: null, disposition: `register:${CARD}#private-research`, reason: "The retained note did not establish enough bibliographic detail for a public citation." }
  ]);
  values.set("preservation", {
    architecture: ["ARCHITECTURE.md", "docs/architecture.md", "docs/adr/"],
    runbooks: ["docs/*runbook*.md"],
    source_contracts: ["ontology/", "site/**/*.schema.json"],
    tests: ["test/", "worker/test/"],
    fixtures: ["test/fixtures/"],
    generators: ["tools/build_*.mjs"],
    receipts: ["docs/evidence/", "warehouse/receipts/proof/"],
    mt7_evidence: ["architecture/evidence.d/cityscroll-merge-throughput--mt-7-architecture-evidence-shards.json", "architecture/evidence.d/"]
  });
  values.set("served-artifacts", {
    paths: ["site/", "worker/"],
    reference: "inspected-main-commit",
    file_count: facts.served.file_count,
    sha256: facts.served.sha256,
    expected_after_sha256: facts.served.sha256,
    placement_disjoint_prefixes: SERVED_PREFIXES,
    superseded_head_derived_sha256: "2d8435b9878397c35a298a921f8cd792ef5dc1c83972e930965680dd18919aa4"
  });
  return values;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)).map(([key, entry]) => [key, stable(entry)]));
  }
  return value;
}

function sameValue(left, right) {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

function validateShard(document, name, facts) {
  const findings = [];
  if (!document || typeof document !== "object" || Array.isArray(document)) return [`${name}: malformed shard`];
  if (document.schema !== SHARD_SCHEMA) findings.push(`${name}: unsupported schema ${document.schema ?? "missing"}`);
  if (typeof document.id !== "string") findings.push(`${name}: missing id`);
  else {
    try {
      const expected = shardPathForId(document.id);
      if (name !== expected) findings.push(`${name}: id/path mismatch; ${document.id} belongs at ${expected}`);
    } catch (error) {
      findings.push(`${name}: ${error.message}`);
    }
  }
  if (document.owner !== document.id) findings.push(`${name}: owner must equal stable semantic key ${document.id ?? "missing"}`);
  if (document.card !== CARD) findings.push(`${name}: card must be ${CARD}`);
  if (document.input_revision !== facts.inspected_main_commit) {
    findings.push(`${name}: stale input_revision ${document.input_revision ?? "missing"}; inspected commit is ${facts.inspected_main_commit}`);
  }
  if (typeof document.updated_at !== "string" || !Number.isFinite(Date.parse(document.updated_at))) findings.push(`${name}: invalid updated_at`);
  if (!("value" in document)) findings.push(`${name}: missing value`);
  const allowed = new Set(["schema", "id", "owner", "card", "input_revision", "updated_at", "value"]);
  for (const key of Object.keys(document)) if (!allowed.has(key)) findings.push(`${name}: unsupported field ${key}`);
  return findings;
}

export function loadPlacementShards({ root = ROOT, directory = null, facts } = {}) {
  const shardDir = directory ?? join(root, SHARD_DIRECTORY_RELATIVE);
  if (!existsSync(shardDir)) throw new Error(`${SHARD_DIRECTORY_RELATIVE}: missing placement shard directory`);
  const names = readdirSync(shardDir).filter((name) => name.endsWith(".json")).sort();
  if (names.length === 0) throw new Error(`${SHARD_DIRECTORY_RELATIVE}: missing placement shards`);
  const findings = [];
  const byId = new Map();
  for (const name of names) {
    let document;
    try {
      document = JSON.parse(readFileSync(join(shardDir, name), "utf8"));
    } catch (error) {
      findings.push(`${name}: malformed JSON (${error.message})`);
      continue;
    }
    findings.push(...validateShard(document, name, facts));
    if (typeof document?.id === "string") {
      if (byId.has(document.id)) findings.push(`${name}: duplicate semantic key ${document.id}`);
      else byId.set(document.id, document);
    }
  }

  const expected = expectedShardValues(facts);
  for (const id of expected.keys()) if (!byId.has(id)) findings.push(`missing required placement input ${id} (${shardPathForId(id)})`);
  for (const id of byId.keys()) if (!expected.has(id)) findings.push(`stale or unregistered placement input ${id} (${shardPathForId(id)})`);
  for (const [id, value] of expected) {
    const shard = byId.get(id);
    if (!shard || !("value" in shard)) continue;
    if (!sameValue(shard.value, value)) findings.push(`${shardPathForId(id)}: placement input does not match the inspected commit; re-derive with --write-shards --shard-id ${id}`);
  }
  if (findings.length) throw new Error(`invalid evidence placement inputs:\n- ${findings.join("\n- ")}`);
  return [...byId.values()].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

/** Deterministic check-time aggregation into the unchanged v1 receipt shape. */
export function aggregatePlacementShards(shards, { root = ROOT, directory = null } = {}) {
  const shardDir = directory ?? join(root, SHARD_DIRECTORY_RELATIVE);
  const byId = new Map();
  for (const shard of shards) {
    if (byId.has(shard.id)) throw new Error(`duplicate semantic key ${shard.id}; reviewed handoff required`);
    byId.set(shard.id, shard);
  }
  const value = (id) => {
    if (!byId.has(id)) throw new Error(`missing required placement input ${id}`);
    return byId.get(id).value;
  };
  const attestation = value("placement-attestation");
  const scope = value("inventory-scope");
  const documents = scope.document_trees
    .map((tree) => value(`document-tree:${tree}`).documents)
    .flat()
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const generatedAt = [...byId.values()].map((shard) => shard.updated_at).sort().at(-1);
  return {
    schema: RECEIPT_SCHEMA,
    card: CARD,
    inspected_main_commit: attestation.inspected_main_commit,
    generated_at: generatedAt,
    privacy_model: attestation.privacy_model,
    materialization: {
      mode: "derived-at-check-time",
      shard_directory: SHARD_DIRECTORY_RELATIVE,
      shard_schema: SHARD_SCHEMA,
      shard_count: byId.size,
      input_revision: attestation.inspected_main_commit,
      tracked_aggregate: null,
      compatibility_projection: DERIVED_AGGREGATE_RELATIVE,
      shards: [...byId.values()].map((shard) => ({
        id: shard.id,
        path: `${SHARD_DIRECTORY_RELATIVE}/${shardPathForId(shard.id)}`,
        sha256: sha(readFileSync(join(shardDir, shardPathForId(shard.id))))
      }))
    },
    private_inventory: {
      scrim_review: value("scrim-inventory"),
      private_reference_documents: documents,
      document_count: documents.length,
      reference_count: documents.reduce((sum, row) => sum + row.private_reference_count, 0),
      unresolved_research_owner: scope.unresolved_research_owner
    },
    public_result: value("public-result"),
    bibliography_mapping: value("bibliography"),
    preservation: value("preservation"),
    served_artifact_baseline: value("served-artifacts"),
    history_treatment: attestation.history_treatment
  };
}

function servedScanPaths() {
  return tracked(["site", "worker"]).filter((path) => SERVED_TEXT_EXTENSIONS.has(extname(path)));
}

export function verifyTip(receipt, { root = ROOT } = {}) {
  const errors = [];
  const publicExtensions = new Set([".md", ".json", ".html"]);
  errors.push(...privateSchemeFindings(tracked().filter((path) => publicExtensions.has(extname(path))), { root }));
  errors.push(...privateSchemeFindings(servedScanPaths(), { root, detail: "private evidence scheme remains in a served artifact" }));
  const scrim = readFileSync(resolve(root, "docs/repository-scrim-review.md"), "utf8");
  if (hasRawInventoryRows(scrim)) errors.push("raw scrim inventory rows remain");
  if (receipt.private_inventory.scrim_review.row_count !== 1144) errors.push("scrim receipt does not cover 1,144 rows");
  if (receipt.private_inventory.document_count !== 51) errors.push("private-reference document inventory is incomplete");
  if (receipt.private_inventory.reference_count !== 2644) errors.push("private-reference occurrence inventory is incomplete");
  for (const path of RETAINED_PROOF_PATHS) {
    if (!existsSync(resolve(root, path))) errors.push(`${path}: retained proof missing`);
  }
  if (!statSync(resolve(root, SHARD_DIRECTORY_RELATIVE), { throwIfNoEntry: false })?.isDirectory()) {
    errors.push(`${SHARD_DIRECTORY_RELATIVE}: source-owned placement inputs missing`);
  }

  errors.push(...trackedAggregateFindings(root));

  // Placement inputs and served artifacts are disjoint, so a placement change cannot move product output.
  const placementPaths = [
    receipt.private_inventory.scrim_review.source_path_at_inspected_commit,
    ...receipt.private_inventory.private_reference_documents.map((row) => row.path),
    ...receipt.materialization.shards.map((row) => row.path),
    "tools/rcp03_evidence_placement.mjs"
  ];
  for (const path of placementPaths) {
    if (SERVED_PREFIXES.some((prefix) => path.startsWith(prefix))) errors.push(`${path}: placement input overlaps a served artifact tree`);
  }
  const servedAtInspectedCommit = treeDigest(["site", "worker"], BASE);
  if (servedAtInspectedCommit.sha256 !== receipt.served_artifact_baseline.expected_after_sha256
    || servedAtInspectedCommit.file_count !== receipt.served_artifact_baseline.file_count) {
    errors.push("served site/worker artifacts at the inspected commit no longer match the reviewed baseline");
  }
  if (errors.length) throw new Error(errors.join("\n"));
}

export function writeShards(facts, { root = ROOT, ids = [] } = {}) {
  if (!ids.length) throw new Error("--write-shards requires at least one explicit --shard-id");
  const expected = expectedShardValues(facts);
  const shardDir = join(root, SHARD_DIRECTORY_RELATIVE);
  mkdirSync(shardDir, { recursive: true });
  for (const id of ids) {
    if (!expected.has(id)) throw new Error(`unsupported or absent --shard-id ${id}`);
    const name = shardPathForId(id);
    const existingPath = join(shardDir, name);
    if (existsSync(existingPath)) {
      const previous = JSON.parse(readFileSync(existingPath, "utf8"));
      if (previous.owner !== id) throw new Error(`${name}: owned by ${previous.owner}; reviewed handoff required`);
    }
    const document = {
      schema: SHARD_SCHEMA,
      id,
      owner: id,
      card: CARD,
      input_revision: facts.inspected_main_commit,
      updated_at: REVIEWED_AT,
      value: expected.get(id)
    };
    writeFileSync(existingPath, `${JSON.stringify(document, null, 2)}\n`);
  }
}

export function evaluate({ root = ROOT, directory = null } = {}) {
  const facts = derivePlacementFacts();
  const shards = loadPlacementShards({ root, directory, facts });
  const receipt = aggregatePlacementShards(shards, { root, directory });
  return { facts, shards, receipt };
}

function main(argv = process.argv.slice(2)) {
  const facts = derivePlacementFacts();
  if (argv.includes("--write-shards")) {
    const ids = argv.reduce((list, value, index) => (argv[index - 1] === "--shard-id" ? [...list, value] : list), []);
    writeShards(facts, { ids });
  }
  const shards = loadPlacementShards({ facts });
  const receipt = aggregatePlacementShards(shards);
  verifyTip(receipt);
  if (argv.includes("--write")) {
    const outputIndex = argv.indexOf("--output-dir");
    const target = outputIndex >= 0
      ? join(resolve(argv[outputIndex + 1]), "evidence-placement.v1.json")
      : join(ROOT, DERIVED_AGGREGATE_RELATIVE);
    if (resolve(target) === join(ROOT, FORBIDDEN_AGGREGATE_RELATIVE)) {
      throw new Error(`${FORBIDDEN_AGGREGATE_RELATIVE} is derived at check time and must never be written into the tracked tree`);
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(receipt, null, 2)}\n`);
    process.stdout.write(`derived placement receipt written to ${target}\n`);
  }
  process.stdout.write(`RCP-03 evidence placement verified: ${receipt.private_inventory.scrim_review.row_count} review rows, ${receipt.private_inventory.reference_count} private references, ${receipt.materialization.shard_count} source-owned inputs, served artifacts unchanged\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
