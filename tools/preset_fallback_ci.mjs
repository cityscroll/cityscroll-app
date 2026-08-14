#!/usr/bin/env node
// Decide whether a pull-request runner may refresh the generated preset fallback.
// The refresh is safe only when the fallback artifacts still match the base commit;
// an intentional fallback or source change must continue through --check.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SITE_SUGGESTIONS = "site/app/search-share.mjs";
const EXACT_FILES = [
  "worker/src/lib/suggestions.mjs",
  "site/data/preset-validation.json",
];

export function fallbackBlockFromSiteSource(source) {
  const match = source.match(/const NL_SUGGESTIONS_FALLBACK = \{[\s\S]*?\n\};/);
  return match?.[0] || null;
}

export function canRefreshGeneratedFallback(baseSources, currentSources) {
  // A shallow checkout may not have the base tree even after the caller attempted a fetch.
  // Treat that as inherited drift; the live writer still regenerates the complete fallback.
  if (Object.values(baseSources).some((source) => source == null)) return true;
  const baseSite = fallbackBlockFromSiteSource(baseSources[SITE_SUGGESTIONS]);
  const currentSite = fallbackBlockFromSiteSource(currentSources[SITE_SUGGESTIONS]);
  if (!baseSite || !currentSite || baseSite !== currentSite) return false;
  return EXACT_FILES.every((path) => baseSources[path] === currentSources[path]);
}

function gitShow(base, path) {
  try {
    return execFileSync("git", ["show", `${base}:${path}`], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

function currentSource(path) {
  return readFileSync(join(ROOT, path), "utf8");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const baseIndex = process.argv.indexOf("--base");
  const base = baseIndex >= 0 ? process.argv[baseIndex + 1] : null;
  if (!base) throw new Error("usage: node tools/preset_fallback_ci.mjs --base <commit>");

  const paths = [SITE_SUGGESTIONS, ...EXACT_FILES];
  const baseSources = Object.fromEntries(paths.map((path) => [path, gitShow(base, path)]));
  const currentSources = Object.fromEntries(paths.map((path) => [path, currentSource(path)]));
  process.stdout.write(`${canRefreshGeneratedFallback(baseSources, currentSources) ? "refresh" : "check"}\n`);
}
