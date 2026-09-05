#!/usr/bin/env node
// Advisory companion to check_capture_manifest_images.mjs: a capture-manifest.json can only stand
// in for the image it replaces if every capture records a sha256 of the rendered output. This
// never fails CI — the manifest corpus only partially carries the field today (see
// docs/capture-manifest-guard.md) — it warns so a new or edited manifest trends toward complete.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MANIFEST_RE = /(^|\/)docs\/evidence\/.*capture-manifest\.json$/;

export function manifestPaths(changedPaths) {
  return changedPaths.filter((path) => MANIFEST_RE.test(path));
}

export function missingShaEntries(payload) {
  const captures = Array.isArray(payload?.captures) ? payload.captures : [];
  const missing = [];
  captures.forEach((capture, index) => {
    const sha = capture?.sha256 ?? capture?.content_sha256;
    if (typeof sha !== "string" || !sha.trim()) {
      missing.push({ index, label: capture?.fixture ?? capture?.route ?? `captures[${index}]` });
    }
  });
  return missing;
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
    console.error("usage: lint_capture_manifest_schema.mjs --paths-file <file of changed paths>");
    process.exitCode = 2;
    return;
  }
  const changedPaths = readFileSync(pathsFile, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const manifests = manifestPaths(changedPaths);
  let warnings = 0;
  for (const path of manifests) {
    let payload;
    try {
      payload = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      console.warn(`capture-manifest schema advisory: ${path}: could not parse as JSON (${error.message})`);
      warnings += 1;
      continue;
    }
    for (const { label } of missingShaEntries(payload)) {
      console.warn(
        `capture-manifest schema advisory: ${path}: capture "${label}" has no sha256 — the manifest ` +
          "cannot stand in for the image without it. See docs/capture-manifest-guard.md.",
      );
      warnings += 1;
    }
  }
  if (warnings) {
    console.warn(
      `capture-manifest schema advisory: ${warnings} entr${warnings === 1 ? "y" : "ies"} missing sha256 ` +
        `across ${manifests.length} manifest(s) touched by this change (warning only, not a failure).`,
    );
  } else {
    console.log(`capture-manifest schema advisory: OK (${manifests.length} manifest(s) touched, none missing sha256).`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
