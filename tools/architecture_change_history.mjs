/**
 * Lightweight architecture change-history from committed watermarks.
 *
 * Full facts.json stays ephemeral. Sequential compact watermarks are enough
 * to inspect coverage-hash, canary fingerprint, ontology, and binding trend.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  WATERMARK_RELATIVE,
  isWatermark,
  loadWatermark,
} from "./architecture_watermark.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const CHANGE_HISTORY_SCHEMA = "cityscroll.architecture.change_history.v1";

function stableJson(value) {
  return JSON.stringify(value ?? null);
}

export function diffWatermarks(before, after) {
  const canaries = [];
  const beforeCanaries = before?.canaries ?? {};
  const afterCanaries = after?.canaries ?? {};
  const ids = [...new Set([...Object.keys(beforeCanaries), ...Object.keys(afterCanaries)])].sort();
  for (const id of ids) {
    const left = beforeCanaries[id] ?? null;
    const right = afterCanaries[id] ?? null;
    if (!left && right) {
      canaries.push({ id, change: "added", after: right });
      continue;
    }
    if (left && !right) {
      canaries.push({ id, change: "removed", before: left });
      continue;
    }
    if (left.fingerprint !== right.fingerprint || left.count !== right.count) {
      canaries.push({
        id,
        change: "fingerprint",
        before: { count: left.count, fingerprint: left.fingerprint },
        after: { count: right.count, fingerprint: right.fingerprint },
      });
    }
  }
  return {
    kind: "delta",
    coverage_hash_changed: before?.observer_coverage_hash !== after?.observer_coverage_hash,
    ontology_changed: stableJson(before?.ontology) !== stableJson(after?.ontology),
    bindings_changed: stableJson(before?.bindings) !== stableJson(after?.bindings),
    canaries,
  };
}

export function projectChangeHistory(watermarks = []) {
  const entries = [];
  for (const [index, current] of watermarks.entries()) {
    if (!isWatermark(current)) {
      throw new Error("change-history projection requires compact architecture watermarks");
    }
    const previous = index > 0 ? watermarks[index - 1] : null;
    entries.push({
      commit: current.commit ?? null,
      generated_at: current.generated_at ?? null,
      observer_coverage_hash: current.observer_coverage_hash ?? null,
      changes: previous ? diffWatermarks(previous, current) : { kind: "baseline", canaries: [] },
    });
  }
  return {
    schema: CHANGE_HISTORY_SCHEMA,
    source: WATERMARK_RELATIVE,
    count: entries.length,
    entries,
  };
}

function gitShowWatermark(root, commit) {
  const raw = execFileSync("git", ["show", `${commit}:${WATERMARK_RELATIVE}`], {
    cwd: root,
    encoding: "utf8",
  });
  const document = JSON.parse(raw);
  if (!isWatermark(document)) return null;
  return document;
}

export function loadWatermarkHistory({ root = ROOT } = {}) {
  const snapshots = [];
  try {
    const hashes = execFileSync("git", ["log", "--pretty=%H", "--", WATERMARK_RELATIVE], {
      cwd: root,
      encoding: "utf8",
    }).trim().split("\n").filter(Boolean);
    for (const hash of hashes.slice().reverse()) {
      try {
        const document = gitShowWatermark(root, hash);
        if (document) snapshots.push(document);
      } catch {
        // Skip commits that deleted or moved the watermark.
      }
    }
  } catch {
    // Detached or non-git callers can still project the working-tree file.
  }
  const currentPath = join(root, WATERMARK_RELATIVE);
  if (existsSync(currentPath)) {
    const current = JSON.parse(readFileSync(currentPath, "utf8"));
    if (isWatermark(current)) {
      const last = snapshots[snapshots.length - 1];
      if (!last || last.observer_coverage_hash !== current.observer_coverage_hash
        || last.commit !== current.commit) {
        snapshots.push(current);
      }
    }
  } else {
    const loaded = loadWatermark({ root });
    if (loaded) snapshots.push(loaded);
  }
  return snapshots;
}

function main() {
  const history = projectChangeHistory(loadWatermarkHistory());
  process.stdout.write(`${JSON.stringify(history, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
