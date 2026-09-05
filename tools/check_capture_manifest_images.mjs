#!/usr/bin/env node
// Delivery-side enforcement of the capture-manifest convention: visual proof for a change is a
// capture-manifest.json entry (route, viewport, revision, data vintage, assertion, sha256 of the
// rendered output), never a committed image binary. See docs/capture-manifest-guard.md.
//
// The caller supplies only paths ADDED in the current change (against the merge base), so the
// existing screenshot corpus under docs/screenshots/ never has to be migrated or baselined —
// renaming or modifying one of those files is unaffected, only a brand-new image path fails.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const ALLOWLIST_PATH = join(ROOT, "docs", "capture-manifest-image-allowlist.json");
const ALLOWLIST_RELATIVE_PATH = "docs/capture-manifest-image-allowlist.json";
const CONVENTION_DOC = "docs/capture-manifest-guard.md";
const DOCS_PREFIX = "docs/";
// Source: docs/capture-manifest-guard.md.
const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|tiff?)$/i;

export function loadAllowlist(path = ALLOWLIST_PATH) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
  const payload = JSON.parse(raw);
  const entries = payload.images && typeof payload.images === "object" ? payload.images : {};
  for (const [entryPath, reason] of Object.entries(entries)) {
    if (typeof reason !== "string" || !reason.trim()) {
      throw new Error(`${ALLOWLIST_RELATIVE_PATH}: entry for ${entryPath} needs a non-empty one-line reason`);
    }
    if (entryPath.includes("*") || entryPath.includes("?")) {
      throw new Error(`${ALLOWLIST_RELATIVE_PATH}: entries must be exact paths, not patterns (found: ${entryPath})`);
    }
  }
  return entries;
}

export function readPaths(pathsFile) {
  return readFileSync(pathsFile, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function findOffendingImages(addedPaths, allowlist) {
  return addedPaths.filter(
    (path) => path.startsWith(DOCS_PREFIX) && IMAGE_RE.test(path) && !Object.hasOwn(allowlist, path),
  );
}

function parsePathsFileArg(argv) {
  const eq = argv.find((arg) => arg.startsWith("--paths-file="));
  if (eq) return eq.slice("--paths-file=".length);
  const idx = argv.indexOf("--paths-file");
  return idx !== -1 ? argv[idx + 1] : null;
}

function main() {
  const pathsFile = parsePathsFileArg(process.argv.slice(2));
  if (!pathsFile) {
    console.error("usage: check_capture_manifest_images.mjs --paths-file <file of newly added paths>");
    process.exitCode = 2;
    return;
  }
  const allowlist = loadAllowlist();
  const addedPaths = readPaths(pathsFile);
  const offending = findOffendingImages(addedPaths, allowlist);
  if (offending.length) {
    console.error("capture-manifest image guard FAILED — new image binaries committed under docs/:");
    for (const path of offending) console.error(`  ${path}`);
    console.error(
      `Visual proof belongs in a capture-manifest.json entry (route, viewport, revision, data vintage, ` +
        `assertion, sha256 of the rendered output), not a committed image; the image is retained ` +
        `owner-side outside the repository. See ${CONVENTION_DOC}. A genuine, reviewed exception ` +
        `(for example a README logo) is listed by its exact path in ${ALLOWLIST_RELATIVE_PATH}.`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `capture-manifest image guard OK — no new image binaries under docs/ ` +
      `(${addedPaths.length} added path(s) checked, ${Object.keys(allowlist).length} allowlisted).`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
