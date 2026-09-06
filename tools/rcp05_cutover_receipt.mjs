#!/usr/bin/env node

/**
 * Repository control-plane cutover proof (RCP-05).
 *
 * The classified migrations already landed as separate bounded changes. This check
 * proves they were a measured state transition rather than a deletion: every
 * classification entry is claimed by exactly one migration, every claimed entry ends
 * with exactly one owner reference, the before/after exhibits still hold at the
 * commits that produced them, retained evidence still resolves, privatized evidence
 * still names an authorized-maintainer resolution, no migration touched a served
 * artifact, and no migration commit left the history reachable from HEAD.
 *
 * Reviewed inputs are source-owned shards under
 * docs/repository-control-plane/cutover.d/, one file per semantic key, so two
 * unrelated changes never edit the same file. The
 * `cityscroll.repository_governance_cutover.v1` receipt is derived from those
 * inputs at check time and is never tracked.
 *
 * Before/after values are anchored to each migration commit and its parent, which are
 * immutable. Tip relations are separate, and are the only part that reads HEAD, so an
 * unrelated documentation change cannot make this receipt stale.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { aggregateArchitectureEvidence } from "./architecture_evidence_shards.mjs";
import { classifyPath, scanDocument } from "./inverse_control_plane_guard.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const RECEIPT_SCHEMA = "cityscroll.repository_governance_cutover.v1";
export const SHARD_SCHEMA = "cityscroll.repository-control-plane.cutover-shard.v1";
export const CARD = "cityscroll-engineering/cutover-without-product-or-evidence-loss";
export const SHARD_DIRECTORY_RELATIVE = "docs/repository-control-plane/cutover.d";
export const FORBIDDEN_AGGREGATE_RELATIVE = "docs/repository-control-plane/cutover.v1.json";
export const DERIVED_AGGREGATE_RELATIVE = ".artifacts/repository-control-plane/cutover.v1.json";

const CLASSIFICATION_RELATIVE = "docs/repository-control-plane/classification.v1.json";
const OWNER_MAPPING_RELATIVE = "docs/repository-control-plane/semantic-owner-mapping.v1.json";
const GUARD_MANIFEST_RELATIVE = "docs/repository-control-plane/inverse-guard.v1.json";
const ROUTER_POLICY_RELATIVE = "docs/repository-control-plane/agents-router-policy.v1.json";
const PLACEMENT_TOOL_RELATIVE = "tools/rcp03_evidence_placement.mjs";

const SERVED_PREFIXES = ["site", "worker"];
const PRIVATE_MARKER = ["backstage", "://", "cityscroll-evidence/"].join("");
const PUBLIC_TEXT_PATHSPEC = ["*.md", "*.json", "*.html", ":!test/"];
const PUBLIC_MARKDOWN_PATHSPEC = ["*.md", ":!test/"];

/** Content classes whose canonical owner is a planning register rather than the repository. */
const TEMPORAL_CLASSES = new Set([
  "repo-only-rollout-register",
  "mixed-measurement-and-temporal-intent",
  "stale-measurement-and-reconciliation-intent",
  "mixed-current-contract-and-temporal-intent",
  "unresolved-owner-decision",
]);
const PRIVATE_CLASSES = new Set([
  "private-evidence-reference",
  "internal-research-bookkeeping",
  "bulky-generated-review-inventory",
]);

export const MIGRATION_KEYS = [
  "rcp-01-shadow-planning",
  "rcp-02-root-router",
  "rcp-03-private-evidence",
  "retained-in-place",
];
export const CONSTANT_KEYS = ["history-decision", "private-access", "coverage-reconciliation"];
export const EXPECTED_KEYS = [...MIGRATION_KEYS, ...CONSTANT_KEYS];

// An ambient GIT_DIR, GIT_WORK_TREE, or GIT_INDEX_FILE — which git exports into hook
// environments — would override the directory this check is asked about. Resolve the
// repository from the working directory instead.
const GIT_ENVIRONMENT = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
);

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}

function git(args, { root = ROOT, encoding = "utf8" } = {}) {
  return execFileSync("git", args, {
    cwd: root,
    env: GIT_ENVIRONMENT,
    encoding,
    maxBuffer: 256 * 1024 * 1024,
  });
}

function gitLines(args, options) {
  const output = git(args, options);
  return output.split("\n").filter(Boolean);
}

function blob(ref, path, { root = ROOT } = {}) {
  try {
    return git(["show", `${ref}:${path}`], { root });
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Reviewed inputs                                                            */
/* -------------------------------------------------------------------------- */

export function shardPathForId(id) {
  return `${SHARD_DIRECTORY_RELATIVE}/${id}.json`;
}

/** Read every reviewed input. Identity is structural: filename, `id`, and `owner` must agree. */
export function readShards(root = ROOT) {
  const directory = resolve(root, SHARD_DIRECTORY_RELATIVE);
  const findings = [];
  const shards = new Map();
  const files = existsSync(directory)
    ? readdirSync(directory).filter((name) => name.endsWith(".json")).sort()
    : [];
  for (const file of files) {
    const relative = `${SHARD_DIRECTORY_RELATIVE}/${file}`;
    let document;
    try {
      document = JSON.parse(readFileSync(join(directory, file), "utf8"));
    } catch (error) {
      findings.push(`${relative}: input is not readable JSON (${error.message})`);
      continue;
    }
    const stem = file.slice(0, -".json".length);
    if (document?.schema !== SHARD_SCHEMA) findings.push(`${relative}: expected schema ${SHARD_SCHEMA}`);
    if (document?.card !== CARD) findings.push(`${relative}: expected card ${CARD}`);
    if (document?.id !== stem) findings.push(`${relative}: id must equal the filename stem`);
    if (document?.owner !== document?.id) findings.push(`${relative}: owner must equal id`);
    if (!["migration", "constant"].includes(document?.kind)) findings.push(`${relative}: kind must be migration or constant`);
    if (!document?.value || typeof document.value !== "object") findings.push(`${relative}: value must be an object`);
    if (shards.has(stem)) findings.push(`${relative}: duplicate input for key ${stem}`);
    shards.set(stem, document);
  }
  for (const key of EXPECTED_KEYS) if (!shards.has(key)) findings.push(`${shardPathForId(key)}: required input is missing`);
  for (const key of shards.keys()) if (!EXPECTED_KEYS.includes(key)) findings.push(`${shardPathForId(key)}: input key is not part of the cutover contract`);
  for (const key of MIGRATION_KEYS) if (shards.get(key) && shards.get(key).kind !== "migration") findings.push(`${shardPathForId(key)}: expected kind migration`);
  for (const key of CONSTANT_KEYS) if (shards.get(key) && shards.get(key).kind !== "constant") findings.push(`${shardPathForId(key)}: expected kind constant`);
  return { shards, findings };
}

/** The derived aggregate is a check-time view, never a second tracked authority. */
export function trackedAggregateFindings(root = ROOT) {
  const tracked = gitLines(["ls-files", "--", FORBIDDEN_AGGREGATE_RELATIVE], { root });
  if (!tracked.length) return [];
  return [`${FORBIDDEN_AGGREGATE_RELATIVE}: generated cutover aggregate must not be tracked; it is derived at check time`];
}

/* -------------------------------------------------------------------------- */
/* Entry partition                                                            */
/* -------------------------------------------------------------------------- */

/** The bounded migration that executed a classification entry's disposition. */
export function migrationKeyForEntry(entry) {
  if (entry.path === "AGENTS.md") return "rcp-02-root-router";
  if (TEMPORAL_CLASSES.has(entry.content_class)) return "rcp-01-shadow-planning";
  if (PRIVATE_CLASSES.has(entry.content_class)) return "rcp-03-private-evidence";
  return "retained-in-place";
}

/**
 * Assign every classification entry to exactly one migration.
 *
 * A double claim or an orphan is a hard failure: the whole point of the cutover proof
 * is that no classified item was executed twice or silently left behind.
 */
export function partitionEntries(entries) {
  const findings = [];
  const groups = new Map(MIGRATION_KEYS.map((key) => [key, []]));
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.id)) {
      findings.push(`${entry.id}: duplicate classification entry id`);
      continue;
    }
    seen.add(entry.id);
    const key = migrationKeyForEntry(entry);
    if (!groups.has(key)) {
      findings.push(`${entry.id}: no bounded migration claims this entry`);
      continue;
    }
    groups.get(key).push(entry);
  }
  const claimed = [...groups.values()].reduce((sum, rows) => sum + rows.length, 0);
  if (claimed !== seen.size) findings.push(`claimed ${claimed} entries for ${seen.size} classification entries`);
  return { groups, findings };
}

/* -------------------------------------------------------------------------- */
/* Ownership reconciliation                                                   */
/* -------------------------------------------------------------------------- */

/** How an owner reference can be checked from inside the repository. */
export function ownerResolution(owner, inventoryIds) {
  if (!owner || owner === "unresolved") return "unresolved";
  if (owner === "repository") return "repository";
  if (inventoryIds.has(owner)) return "card-inventory";
  return "register-asserted";
}

/**
 * Resolve the RCP-01 mapping's indirection back to a concrete owner.
 *
 * The mapping deliberately points at manifest fields instead of copying an id, so a
 * card body is never duplicated into the repository.
 */
export function resolveMappingOwner(value, entriesById) {
  if (!value) return null;
  const indirect = value.match(/^manifest:(.+)#(register_id|canonical_owner)$/);
  if (!indirect) return value;
  const entry = entriesById.get(indirect[1]);
  if (!entry) return null;
  return entry[indirect[2]] ?? null;
}

/**
 * Reconcile each entry to exactly one owner on two axes.
 *
 * `disposition_owner` names who owns the repository-side act, and is always resolved.
 * `outcome_owner` names who owns the product outcome the migrated intent described; the
 * migration deliberately left some of those unresolved rather than inventing a card,
 * and this check requires that state to stay explicit instead of becoming an implied pass.
 */
export function reconcileOwners({ entries, mappingItems, inventoryIds }) {
  const findings = [];
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  const mappingById = new Map(mappingItems.map((item) => [item.manifest_id, item]));
  const rows = [];
  for (const entry of entries) {
    const dispositionOwner = entry.canonical_owner === "unresolved" ? entry.register_id : entry.canonical_owner;
    const owners = new Set();
    if (dispositionOwner && dispositionOwner !== "unresolved") owners.add(dispositionOwner);
    if (entry.canonical_owner === "unresolved") {
      // A manifest entry whose owner is unresolved still names the record that holds
      // the disposition. A literal "unresolved" replacement reference is not an owner.
      const holding = (entry.stable_replacement_reference || "").replace(/^register:/, "").split("#")[0];
      if (holding && holding !== "unresolved") owners.add(holding);
    }
    if (!owners.size) findings.push(`${entry.id}: no owner reference; a migrated item must not end with zero owners`);
    if (owners.size > 1) findings.push(`${entry.id}: ${owners.size} conflicting owner references (${[...owners].sort().join(", ")})`);
    const resolved = [...owners][0] ?? null;

    const mapping = mappingById.get(entry.id);
    const outcomeOwner = mapping ? resolveMappingOwner(mapping.canonical_owner, entriesById) : resolved;
    if (mapping && mapping.resolution === "unresolved" && outcomeOwner) {
      findings.push(`${entry.id}: mapping records an unresolved outcome owner but also names ${outcomeOwner}`);
    }
    if (mapping && mapping.resolution !== "unresolved" && !outcomeOwner) {
      findings.push(`${entry.id}: mapping records resolution ${mapping.resolution} without a resolvable owner`);
    }
    if (!mapping && TEMPORAL_CLASSES.has(entry.content_class)) {
      findings.push(`${entry.id}: temporal intent has no entry in the semantic-owner mapping`);
    }

    rows.push({
      manifest_id: entry.id,
      path: entry.path,
      selector: entry.selector,
      content_class: entry.content_class,
      disposition: entry.disposition,
      migration: migrationKeyForEntry(entry),
      disposition_owner: resolved,
      disposition_owner_resolution: ownerResolution(resolved, inventoryIds),
      outcome_owner: outcomeOwner,
      outcome_owner_state: mapping ? mapping.resolution : "not-temporal",
      replacement_reference: entry.stable_replacement_reference,
      history_treatment: entry.history_treatment,
    });
  }
  rows.sort((left, right) => left.manifest_id.localeCompare(right.manifest_id));
  return { rows, findings };
}

/* -------------------------------------------------------------------------- */
/* Before / after measurement                                                 */
/* -------------------------------------------------------------------------- */

function countMatches(text, pattern) {
  if (text == null) return 0;
  return (text.match(new RegExp(pattern, "gim")) || []).length;
}

function grepCount(ref, pathspec, pattern, { root = ROOT, fixed = false } = {}) {
  try {
    const flags = ["grep", "-I", "-c", "-i", ...(fixed ? ["-F"] : []), "-e", pattern, ref, "--", ...pathspec];
    return gitLines(flags, { root }).reduce((sum, line) => sum + Number(line.slice(line.lastIndexOf(":") + 1)), 0);
  } catch {
    return 0; // git grep exits non-zero when nothing matches
  }
}

function grepDocuments(ref, pathspec, pattern, { root = ROOT, fixed = false } = {}) {
  try {
    const flags = ["grep", "-I", "-l", ...(fixed ? ["-F"] : []), "-e", pattern, ref, "--", ...pathspec];
    return gitLines(flags, { root }).length;
  } catch {
    return 0;
  }
}

function pointer(document, path) {
  return path.split("/").filter(Boolean).reduce((value, key) => (value == null ? value : value[key]), document);
}

/** Observe one reviewed measurement at one commit. */
export function observe(measurement, ref, { root = ROOT } = {}) {
  switch (measurement.kind) {
    case "pattern-count":
      return countMatches(blob(ref, measurement.path, { root }), measurement.pattern);
    case "tree-file-count":
      try {
        return gitLines(["ls-tree", "-r", "--name-only", ref, "--", measurement.path], { root }).length;
      } catch {
        return 0;
      }
    case "json-number": {
      const text = blob(ref, measurement.path, { root });
      if (text == null) return null;
      return pointer(JSON.parse(text), measurement.pointer);
    }
    case "blob-bytes": {
      const text = blob(ref, measurement.path, { root });
      return text == null ? null : Buffer.byteLength(text, "utf8");
    }
    case "blob-lines": {
      const text = blob(ref, measurement.path, { root });
      return text == null ? null : text.split("\n").length - 1;
    }
    case "private-locator-documents":
      return grepDocuments(ref, PUBLIC_TEXT_PATHSPEC, PRIVATE_MARKER, { root, fixed: true });
    case "private-locator-occurrences":
      return grepCount(ref, PUBLIC_TEXT_PATHSPEC, PRIVATE_MARKER, { root, fixed: true });
    case "public-markdown-pattern-count":
      return grepCount(ref, PUBLIC_MARKDOWN_PATHSPEC, measurement.pattern, { root });
    default:
      return null;
  }
}

/** Compare a reviewed measurement against the repository at the parent, the commit, and the tip. */
export function evaluateMeasurement(measurement, { commit, root = ROOT, routerCeiling }) {
  const before = observe(measurement, `${commit}^`, { root });
  const after = observe(measurement, commit, { root });
  const tip = observe(measurement, "HEAD", { root });
  const findings = [];
  if (before !== measurement.before) findings.push(`${measurement.id}: reviewed before ${measurement.before} but observed ${before} at ${commit}^`);
  if (after !== measurement.after) findings.push(`${measurement.id}: reviewed after ${measurement.after} but observed ${after} at ${commit}`);
  switch (measurement.tip_relation) {
    case "equal-to-after":
      if (tip !== measurement.after) findings.push(`${measurement.id}: migrated value returned at HEAD (${tip}, expected ${measurement.after})`);
      break;
    case "at-most-before":
      if (!(tip <= measurement.before)) findings.push(`${measurement.id}: HEAD value ${tip} exceeds the pre-migration value ${measurement.before}`);
      break;
    case "at-most-router-ceiling":
      if (!(tip <= routerCeiling)) findings.push(`${measurement.id}: HEAD value ${tip} exceeds the router ceiling ${routerCeiling}`);
      break;
    default:
      findings.push(`${measurement.id}: unknown tip relation ${measurement.tip_relation}`);
  }
  return { observation: { id: measurement.id, kind: measurement.kind, path: measurement.path, before, after, tip, tip_relation: measurement.tip_relation }, findings };
}

/* -------------------------------------------------------------------------- */
/* Migration-level proofs                                                     */
/* -------------------------------------------------------------------------- */

/** Control-plane language the landed inverse guard detects, counted by rule at one commit. */
export function guardFindingsAt(ref, { root = ROOT, guardManifest, paths }) {
  const byRule = {};
  for (const path of paths) {
    const text = blob(ref, path, { root });
    if (text == null) continue;
    for (const finding of scanDocument({ path, text, classification: classifyPath(path, guardManifest) })) {
      byRule[finding.rule] = (byRule[finding.rule] || 0) + 1;
    }
  }
  return Object.fromEntries(Object.entries(byRule).sort(([left], [right]) => left.localeCompare(right)));
}

/** A cutover change may not move product output: the served trees must be untouched. */
export function servedDeltaPaths(commit, { root = ROOT } = {}) {
  try {
    return gitLines(["diff", "--name-only", `${commit}^`, commit, "--", ...SERVED_PREFIXES], { root });
  } catch {
    return [];
  }
}

/** History is immutable when every recorded migration commit is still reachable from HEAD. */
export function commitReachable(commit, { root = ROOT } = {}) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", commit, "HEAD"], { cwd: root, env: GIT_ENVIRONMENT });
    return true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Retained evidence and private access                                       */
/* -------------------------------------------------------------------------- */

/** Every retained architecture-evidence projection must still resolve at the tip. */
export function retainedShardFindings({ root = ROOT, projections }) {
  const findings = [];
  const checked = [];
  for (const row of projections) {
    const exists = existsSync(resolve(root, row.path));
    checked.push({ card: row.card ?? row.id, path: row.path, resolves: exists });
    if (!exists) findings.push(`${row.path}: retained evidence projection for ${row.card ?? row.id} does not resolve`);
  }
  return { checked, findings };
}

/**
 * Prove authorized maintainers can still reach every privatized disposition.
 *
 * The proof is that each disposition names one register resolution. Publishing the
 * payload, or inventing a public URL to stand in for it, would defeat the placement.
 */
export function privateAccessFindings({ placement, expected }) {
  const findings = [];
  const dispositions = [
    ...placement.private_inventory.private_reference_documents.map((row) => ({ path: row.path, resolution: row.maintainer_resolution })),
    { path: placement.private_inventory.scrim_review.source_path_at_inspected_commit, resolution: placement.private_inventory.scrim_review.maintainer_resolution },
  ];
  for (const row of dispositions) {
    if (!row.resolution) findings.push(`${row.path}: privatized disposition has no authorized-maintainer resolution`);
    else if (!row.resolution.startsWith(`${expected.resolution_scheme}:`)) findings.push(`${row.path}: maintainer resolution does not use the ${expected.resolution_scheme} scheme`);
    else if (row.resolution !== expected.expected_resolution) findings.push(`${row.path}: maintainer resolution ${row.resolution} is not the reviewed resolution`);
    if (/^https?:\/\//i.test(row.resolution || "")) findings.push(`${row.path}: privatized evidence must not resolve through a public URL`);
  }
  if (dispositions.length !== expected.expected_disposition_count) {
    findings.push(`private access: reviewed ${expected.expected_disposition_count} privatized dispositions but observed ${dispositions.length}`);
  }
  if (placement.public_result.private_reference_occurrences_retained_in_public_content !== 0) {
    findings.push("private access: public content still retains an owner-only evidence locator");
  }
  return { disposition_count: dispositions.length, resolutions: [...new Set(dispositions.map((row) => row.resolution))].sort(), findings };
}

/* -------------------------------------------------------------------------- */
/* Receipt                                                                    */
/* -------------------------------------------------------------------------- */

function loadPlacement(root) {
  const derived = resolve(root, DERIVED_AGGREGATE_RELATIVE.replace("cutover", "evidence-placement"));
  if (existsSync(derived)) return JSON.parse(readFileSync(derived, "utf8"));
  execFileSync("node", [resolve(root, PLACEMENT_TOOL_RELATIVE), "--write"], { cwd: root, env: GIT_ENVIRONMENT, stdio: "pipe" });
  return JSON.parse(readFileSync(derived, "utf8"));
}

export function buildReceipt({ root = ROOT } = {}) {
  const findings = [];
  const classification = JSON.parse(readFileSync(resolve(root, CLASSIFICATION_RELATIVE), "utf8"));
  const mapping = JSON.parse(readFileSync(resolve(root, OWNER_MAPPING_RELATIVE), "utf8"));
  const guardManifest = JSON.parse(readFileSync(resolve(root, GUARD_MANIFEST_RELATIVE), "utf8"));
  const routerPolicy = JSON.parse(readFileSync(resolve(root, ROUTER_POLICY_RELATIVE), "utf8"));

  const architecture = aggregateArchitectureEvidence({ root });
  if (architecture.status !== "PASS") throw new Error(`source-card inventory unavailable: ${architecture.findings.join("; ")}`);
  const inventoryIds = new Set(architecture.sourceCards.cards.map((card) => card.id));

  const { shards, findings: shardFindings } = readShards(root);
  findings.push(...shardFindings, ...trackedAggregateFindings(root));
  if (shardFindings.length) return { receipt: null, findings };

  const { groups, findings: partitionFindings } = partitionEntries(classification.entries);
  findings.push(...partitionFindings);

  const ownership = reconcileOwners({ entries: classification.entries, mappingItems: mapping.items, inventoryIds });
  findings.push(...ownership.findings);

  const scannedPaths = [...new Set(classification.entries.map((entry) => entry.path))]
    .filter((path) => !path.includes("*") && /\.(?:md|json|ya?ml)$/i.test(path))
    .sort();

  const migrations = [];
  for (const key of MIGRATION_KEYS) {
    const shard = shards.get(key);
    const value = shard.value;
    const claimed = groups.get(key) ?? [];
    const commit = value.migration_commit;
    if (!/^[0-9a-f]{40}$/.test(commit || "")) findings.push(`${shardPathForId(key)}: migration_commit must be a full commit id`);
    const reachable = commitReachable(commit, { root });
    if (!reachable) findings.push(`${shardPathForId(key)}: migration commit ${commit} is not reachable from HEAD; history was rewritten`);

    if (claimed.length !== value.manifest_entry_count) {
      findings.push(`${shardPathForId(key)}: reviewed ${value.manifest_entry_count} classification entries but ${claimed.length} are claimed`);
    }
    const observedDispositions = {};
    for (const entry of claimed) observedDispositions[entry.disposition] = (observedDispositions[entry.disposition] || 0) + 1;
    const reviewedDispositions = value.dispositions || {};
    const dispositionKeys = [...new Set([...Object.keys(observedDispositions), ...Object.keys(reviewedDispositions)])].sort();
    for (const disposition of dispositionKeys) {
      if ((observedDispositions[disposition] || 0) !== (reviewedDispositions[disposition] || 0)) {
        findings.push(`${shardPathForId(key)}: disposition ${disposition} reviewed ${reviewedDispositions[disposition] || 0}, observed ${observedDispositions[disposition] || 0}`);
      }
    }

    const observations = [];
    for (const measurement of value.measurements || []) {
      const result = evaluateMeasurement(measurement, { commit, root, routerCeiling: routerPolicy.max_bytes });
      observations.push(result.observation);
      findings.push(...result.findings.map((detail) => `${shardPathForId(key)}: ${detail}`));
    }

    const served = reachable ? servedDeltaPaths(commit, { root }) : [];
    if (served.length !== value.served_artifact_delta_paths) {
      findings.push(`${shardPathForId(key)}: reviewed ${value.served_artifact_delta_paths} served-artifact changes but observed ${served.length}`);
    }
    if (served.length) findings.push(`${shardPathForId(key)}: migration changed served artifacts without a separate authorization (${served.slice(0, 5).join(", ")})`);
    if (value.history_treatment !== "none") findings.push(`${shardPathForId(key)}: history treatment must be none`);

    migrations.push({
      id: key,
      register_card: value.register_card,
      migration_commit: commit,
      commit_reachable_from_head: reachable,
      summary: value.summary,
      manifest_entry_count: claimed.length,
      dispositions: Object.fromEntries(Object.entries(observedDispositions).sort(([left], [right]) => left.localeCompare(right))),
      control_plane_findings_before: reachable ? guardFindingsAt(`${commit}^`, { root, guardManifest, paths: scannedPaths }) : null,
      control_plane_findings_after: reachable ? guardFindingsAt(commit, { root, guardManifest, paths: scannedPaths }) : null,
      measurements: observations,
      served_artifact_delta_paths: served.length,
      history_treatment: value.history_treatment,
      reversible: value.reversible === true,
    });
  }

  const tipGuardFindings = guardFindingsAt("HEAD", { root, guardManifest, paths: scannedPaths });
  if (Object.keys(tipGuardFindings).length) {
    findings.push(`tip: classified documents still carry control-plane content (${JSON.stringify(tipGuardFindings)})`);
  }

  const retained = retainedShardFindings({
    root,
    projections: (architecture.projections?.projections ?? []).map((row) => ({
      card: row.cards?.map((card) => card.id).sort().join(", ") || row.id,
      path: row.path,
    })),
  });
  findings.push(...retained.findings);

  const placement = loadPlacement(root);
  const access = privateAccessFindings({ placement, expected: shards.get("private-access").value });
  findings.push(...access.findings);

  const history = shards.get("history-decision").value;
  if (history.decision !== "no-rewrite") findings.push(`${shardPathForId("history-decision")}: decision must be no-rewrite unless a separate finding is recorded`);
  if (history.security_or_legal_exception || history.approval_reference) {
    findings.push(`${shardPathForId("history-decision")}: a history exception requires a separate demonstrated finding and approval, which this check does not grant`);
  }
  const reviewRequired = classification.entries.filter((entry) => entry.history_treatment === "review-required").length;

  const coverage = shards.get("coverage-reconciliation").value;
  if (coverage.classification_entry_count !== classification.entries.length) {
    findings.push(`${shardPathForId("coverage-reconciliation")}: reviewed ${coverage.classification_entry_count} classification entries but the manifest holds ${classification.entries.length}`);
  }
  for (const delta of coverage.deltas) {
    if (!MIGRATION_KEYS.includes(delta.executing_migration)) findings.push(`${shardPathForId("coverage-reconciliation")}: delta ${delta.id} names an unknown migration`);
    if (delta.state !== "reconciled") findings.push(`${shardPathForId("coverage-reconciliation")}: delta ${delta.id} is ${delta.state}`);
    if (delta.loss !== "none") findings.push(`${shardPathForId("coverage-reconciliation")}: delta ${delta.id} records loss ${delta.loss}`);
  }

  const ownerCounts = {};
  for (const row of ownership.rows) ownerCounts[row.disposition_owner_resolution] = (ownerCounts[row.disposition_owner_resolution] || 0) + 1;
  const unresolvedOutcomes = ownership.rows.filter((row) => row.outcome_owner_state === "unresolved");

  const receipt = {
    schema: RECEIPT_SCHEMA,
    card: CARD,
    status: findings.length ? "FAIL" : "PASS",
    materialization: {
      mode: "derived-at-check-time",
      shard_directory: SHARD_DIRECTORY_RELATIVE,
      shard_schema: SHARD_SCHEMA,
      shard_count: shards.size,
      tracked_aggregate: false,
      compatibility_projection: DERIVED_AGGREGATE_RELATIVE,
      shards: [...shards.keys()].sort(),
    },
    inputs: {
      classification_manifest: CLASSIFICATION_RELATIVE,
      classification_manifest_sha256: sha(readFileSync(resolve(root, CLASSIFICATION_RELATIVE))),
      semantic_owner_mapping: OWNER_MAPPING_RELATIVE,
      semantic_owner_mapping_sha256: sha(readFileSync(resolve(root, OWNER_MAPPING_RELATIVE))),
      source_card_inventory_schema: architecture.sourceCards.schema,
      source_card_inventory_sha256: architecture.receipt.source_cards_sha256,
      evidence_placement_inspected_commit: placement.inspected_main_commit,
      credential_free: true,
    },
    migrations,
    ownership: {
      classification_entries: ownership.rows.length,
      entries_with_exactly_one_disposition_owner: ownership.rows.filter((row) => row.disposition_owner).length,
      entries_with_no_disposition_owner: ownership.rows.filter((row) => !row.disposition_owner).length,
      disposition_owner_resolution_counts: Object.fromEntries(Object.entries(ownerCounts).sort(([left], [right]) => left.localeCompare(right))),
      explicitly_unresolved_outcome_owners: unresolvedOutcomes.length,
      explicitly_unresolved_outcome_ids: unresolvedOutcomes.map((row) => row.manifest_id),
      rows: ownership.rows,
    },
    retained_evidence: {
      projection_count: retained.checked.length,
      unresolved_projections: retained.checked.filter((row) => !row.resolves).map((row) => row.path),
    },
    private_access: {
      disposition_count: access.disposition_count,
      resolutions: access.resolutions,
      payload_published: false,
      public_url_resolutions: 0,
    },
    served_artifacts: {
      paths: SERVED_PREFIXES.map((prefix) => `${prefix}/`),
      comparison: "per-migration parent-to-commit diff",
      total_changed_paths: migrations.reduce((sum, row) => sum + row.served_artifact_delta_paths, 0),
      authorized_changes: [],
    },
    history: {
      decision: history.decision,
      rationale: history.rationale,
      public_history_statement: history.public_history_statement,
      security_or_legal_exception: history.security_or_legal_exception,
      review_required_entries: reviewRequired,
      migration_commits_reachable_from_head: migrations.filter((row) => row.commit_reachable_from_head).length,
    },
    coverage_reconciliation: coverage,
    tip_control_plane_findings: tipGuardFindings,
    findings,
  };

  return { receipt, findings };
}

function main(argv = process.argv.slice(2)) {
  const { receipt, findings } = buildReceipt({ root: ROOT });
  const outputIndex = argv.indexOf("--output-dir");
  if (argv.includes("--write") && receipt) {
    const target = outputIndex >= 0 ? resolve(argv[outputIndex + 1], "cutover.v1.json") : resolve(ROOT, DERIVED_AGGREGATE_RELATIVE);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(receipt, null, 2)}\n`);
    process.stdout.write(`derived cutover receipt written to ${target}\n`);
  }
  if (findings.length) {
    for (const finding of findings) process.stderr.write(`RCP-05 cutover: ${finding}\n`);
    process.exitCode = 1;
    return;
  }
  const migrated = receipt.migrations.reduce((sum, row) => sum + row.manifest_entry_count, 0);
  process.stdout.write(
    `RCP-05 cutover verified: ${migrated} classified entries across ${receipt.migrations.length} bounded migrations, `
    + `${receipt.ownership.entries_with_exactly_one_disposition_owner} with one owner, `
    + `${receipt.ownership.explicitly_unresolved_outcome_owners} outcome owners explicitly unresolved, `
    + `${receipt.private_access.disposition_count} private dispositions reachable, `
    + `${receipt.served_artifacts.total_changed_paths} served artifacts changed, history ${receipt.history.decision}\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
