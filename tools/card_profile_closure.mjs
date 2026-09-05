// Read the committed card-work profile closure.
//
// The closure used to be one committed JSON aggregate. That made it a per-change
// conflict generator: it carried whole-repository counters, byte totals, the
// revision it was derived at and a digest of the pattern list, so *every* change
// that added or resized any tracked file rewrote the same handful of lines. With
// several changes open at once, each landing rewrote those lines again and left
// every other branch conflicting on a file none of them had a real disagreement
// about.
//
// The storage is split so that is structurally impossible:
//
//   closure.v1.json    The contract. Only facts that move when the profile
//                      policy moves: declared trees, gate-class classification,
//                      the config digest, the functional-corpus declaration.
//                      A change here is a real disagreement and should conflict.
//   closure.d/*.txt    The derived path inventories, one sorted repository path
//                      per line. Two changes that each add a path add different
//                      lines, so they merge. `.gitattributes` marks them
//                      `merge=union` for the case where the lines are adjacent.
//   card-work.sparse   The generated sparse-checkout pattern list, same shape
//                      and same merge treatment.
//
// Nothing reads an inventory positionally, so a union merge that leaves the file
// unsorted or with a duplicate line is harmless: every read here sorts and
// deduplicates, and the next `node tools/derive_card_profile.mjs` rewrites the
// canonical form. Volatile measurements are not stored at all — they are derived
// on demand by `node tools/derive_card_profile.mjs --measure`.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, "..");

export const CLOSURE_RELATIVE_PATH = "tools/card-profile/closure.v1.json";
export const INVENTORY_RELATIVE_DIR = "tools/card-profile/closure.d";
export const SPARSE_RELATIVE_PATH = "tools/card-profile/card-work.sparse";

// Every inventory the closure contract names, and the field the hydrated
// closure object exposes it at. The field names are the ones the manifest has
// always used, so a consumer reads the same shape it always did.
export const INVENTORIES = Object.freeze({
  required_paths: "required-paths.txt",
  deferred_paths: "deferred-paths.txt",
  site_data_paths: "site-data-paths.txt",
  functional_corpus_paths: "functional-corpus-paths.txt",
  worker_to_site_data_targets: "worker-to-site-data-targets.txt"
});

export function closurePath(root = DEFAULT_ROOT) {
  return resolve(root, CLOSURE_RELATIVE_PATH);
}

export function inventoryPath(name, root = DEFAULT_ROOT) {
  const file = INVENTORIES[name];
  if (!file) throw new Error(`unknown card profile inventory: ${name}`);
  return resolve(root, INVENTORY_RELATIVE_DIR, file);
}

export function sparsePath(root = DEFAULT_ROOT) {
  return resolve(root, SPARSE_RELATIVE_PATH);
}

function contentLines(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

/**
 * One inventory as a sorted, deduplicated path list. A missing inventory is an
 * empty one rather than a throw, so a caller can report the gap with the rest of
 * its problems instead of crashing on the first one.
 */
export function readInventory(name, root = DEFAULT_ROOT) {
  const path = inventoryPath(name, root);
  if (!existsSync(path)) return [];
  return [...new Set(contentLines(readFileSync(path, "utf8")))].sort();
}

/** The committed sparse-checkout patterns, sorted and deduplicated. */
export function committedPatterns(root = DEFAULT_ROOT) {
  const path = sparsePath(root);
  if (!existsSync(path)) return [];
  return [...new Set(contentLines(readFileSync(path, "utf8")))].sort();
}

/**
 * The digest of the committed pattern list, in canonical (sorted, deduplicated)
 * form so a union merge cannot change it without changing what the list means.
 * It is derived here rather than stored in the manifest, because a stored digest
 * of a file that grows with the repository is a guaranteed conflict.
 */
export function patternsDigest(root = DEFAULT_ROOT) {
  return createHash("sha256").update(`${committedPatterns(root).join("\n")}\n`).digest("hex");
}

// The pattern list is --no-cone, so a directory pattern is a prefix match and
// everything else is exact. This is the same rule Git applies when it
// materialises the checkout.
export function materialisedByPatterns(patterns, path) {
  return patterns.some((pattern) =>
    pattern.endsWith("/") ? path.startsWith(pattern.slice(1)) : path === pattern.slice(1)
  );
}

/**
 * The closure contract with its inventories attached, in the shape every
 * consumer already reads: `required_paths`, `deferred_hydration_set.paths`,
 * `site_data.profile_paths`, `functional_corpus.paths` and a `patterns_sha256`
 * derived from the committed pattern list.
 */
export function loadClosure(root = DEFAULT_ROOT) {
  const contract = JSON.parse(readFileSync(closurePath(root), "utf8"));
  return hydrateClosure(contract, root);
}

/** Attach the inventories to an already-parsed contract. */
export function hydrateClosure(contract, root = DEFAULT_ROOT) {
  const closure = { ...contract };
  closure.required_paths = readInventory("required_paths", root);
  closure.deferred_hydration_set = {
    ...(contract.deferred_hydration_set ?? {}),
    paths: readInventory("deferred_paths", root)
  };
  closure.site_data = { ...(contract.site_data ?? {}), profile_paths: readInventory("site_data_paths", root) };
  if (contract.sources?.static) {
    closure.sources = {
      ...contract.sources,
      static: {
        ...contract.sources.static,
        worker_to_site_data_targets: readInventory("worker_to_site_data_targets", root)
      }
    };
  }
  if (contract.functional_corpus) {
    const paths = readInventory("functional_corpus_paths", root);
    closure.functional_corpus = { ...contract.functional_corpus, path_count: paths.length, paths };
  }
  closure.patterns_sha256 = patternsDigest(root);
  return closure;
}
