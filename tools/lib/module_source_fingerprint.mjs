/**
 * Deterministic fingerprint of a module and every repository-local module it
 * reaches through relative imports.
 *
 * A generator that verifies its committed artifacts from a recorded digest
 * instead of rebuilding them must still fail when the generator's own logic
 * changed. Hashing the reachable source graph makes that check exact: any edit
 * to a participating module changes the fingerprint, so the recorded digest is
 * no longer accepted and the caller falls back to a full rebuild.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Static `from "…"` covers every import/export form; the second pattern picks
// up side-effect imports and dynamic `import("…")` calls.
const FROM_SPECIFIER = /\bfrom\s*["']([^"']+)["']/g;
const DIRECT_SPECIFIER = /\bimport\s*\(?\s*["']([^"']+)["']/g;

function relativeSpecifiers(source) {
  const found = new Set();
  for (const pattern of [FROM_SPECIFIER, DIRECT_SPECIFIER]) {
    pattern.lastIndex = 0;
    let match = pattern.exec(source);
    while (match) {
      if (match[1].startsWith("./") || match[1].startsWith("../")) found.add(match[1]);
      match = pattern.exec(source);
    }
  }
  return [...found];
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * @param {string} entryPath absolute path of the entry module
 * @param {string} rootDir absolute repository root the reported paths are relative to
 * @returns {{fingerprint: string, files: string[]}}
 */
export function moduleSourceFingerprint(entryPath, rootDir) {
  const visited = new Map();
  const queue = [resolve(entryPath)];
  while (queue.length) {
    const path = queue.pop();
    if (visited.has(path) || !isFile(path)) continue;
    const source = readFileSync(path, "utf8");
    visited.set(path, source);
    for (const specifier of relativeSpecifiers(source)) {
      const target = resolve(dirname(path), specifier);
      // A specifier that escapes the repository, or names something that is not
      // a file, contributes nothing this fingerprint can meaningfully cover.
      if (!relative(rootDir, target).startsWith(`..${sep}`)) queue.push(target);
    }
  }
  const files = [...visited.keys()]
    .map((path) => relative(rootDir, path).replaceAll("\\", "/"))
    .sort();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file);
    hash.update("\0");
    hash.update(createHash("sha256").update(visited.get(resolve(rootDir, file))).digest("hex"));
    hash.update("\n");
  }
  return { fingerprint: hash.digest("hex"), files };
}
