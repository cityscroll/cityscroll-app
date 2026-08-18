/**
 * Path-coverage check for architecture observer canaries.
 *
 * architecture/observer-canaries.json is the single registration. This module
 * checks that list against the reconciliation workflow trigger filter so a
 * canary that cannot fire CI is a red test, not a silent gap.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadObserverCanaries } from "./build_architecture_facts.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const RECONCILIATION_WORKFLOW = ".github/workflows/architecture-reconciliation.yml";
export const CANARY_LIST = "architecture/observer-canaries.json";

function normalizeRepoPath(value) {
  return String(value || "").trim().split("\\").join("/");
}

export function githubGlobToRegExp(pattern) {
  const escaped = normalizeRepoPath(pattern).replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\0/g, ".*")}$`);
}

export function pathMatchesTriggerFilter(repoPath, patterns) {
  const target = normalizeRepoPath(repoPath);
  if (!target) return false;
  return (patterns || []).some((pattern) => githubGlobToRegExp(pattern).test(target));
}

export function parseReconciliationTriggerPaths(workflowText) {
  const text = workflowText ?? readFileSync(join(ROOT, RECONCILIATION_WORKFLOW), "utf8");
  const start = text.search(/^\s+pull_request:\s*$/m);
  if (start < 0) {
    throw new Error(`${RECONCILIATION_WORKFLOW} is missing a pull_request trigger`);
  }
  const afterTrigger = text.slice(start);
  const pathsAt = afterTrigger.search(/^\s+paths:\s*$/m);
  if (pathsAt < 0) {
    throw new Error(`${RECONCILIATION_WORKFLOW} is missing a pull_request.paths filter`);
  }
  const patterns = [];
  for (const line of afterTrigger.slice(pathsAt).split("\n").slice(1)) {
    if (!line.trim() || /^\s+#/.test(line)) continue;
    const item = line.match(/^\s+-\s+["']([^"']+)["']\s*$/);
    if (!item) break;
    patterns.push(item[1]);
  }
  if (patterns.length === 0) {
    throw new Error(`${RECONCILIATION_WORKFLOW} pull_request.paths filter is empty`);
  }
  return patterns;
}

export function uncoveredCanaryPaths({ canaries, patterns } = {}) {
  const listed = canaries ?? loadObserverCanaries();
  const filter = patterns ?? parseReconciliationTriggerPaths();
  return listed
    .map((entry) => ({
      id: String(entry?.id || "").trim(),
      path: normalizeRepoPath(entry?.path),
    }))
    .filter((entry) => entry.id && entry.path && !pathMatchesTriggerFilter(entry.path, filter));
}
