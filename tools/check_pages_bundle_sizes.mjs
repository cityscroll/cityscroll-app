#!/usr/bin/env node

import { readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

// Cloudflare Pages' per-file guard. The Worker has a separate uncompressed
// bundle ceiling: tools/worker_deploy_guard.mjs checks the pinned Wrangler
// dry-run metafile against the 64 MiB raw, 10 MB compressed, and startup budgets.
// Keep these checks separate because they measure different deploy artifacts.
export const MAX_PAGES_FILE_BYTES = 24 * 1024 * 1024;

function filesUnder(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  visit(root);
  return files;
}

export function oversizedPagesFiles(siteDir, limit = MAX_PAGES_FILE_BYTES) {
  const root = resolve(siteDir);
  return filesUnder(root)
    .map((path) => ({ path, bytes: statSync(path).size }))
    .filter(({ bytes }) => bytes > limit)
    .sort((left, right) => left.path.localeCompare(right.path));
}

function parseSiteDir(argv) {
  const index = argv.indexOf("--site-dir");
  return index >= 0 && argv[index + 1] ? argv[index + 1] : "_site";
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const siteDir = resolve(parseSiteDir(process.argv.slice(2)));
  const findings = oversizedPagesFiles(siteDir);
  if (findings.length) {
    for (const finding of findings) {
      const sizeMiB = (finding.bytes / (1024 * 1024)).toFixed(2);
      console.error(
        `Cloudflare Pages bundle file exceeds the 24 MiB guard: ${relative(process.cwd(), finding.path)} `
        + `(${finding.bytes} bytes, ${sizeMiB} MiB). Pages rejects files over 25 MiB.`,
      );
    }
    process.exitCode = 1;
  } else {
    console.log(`Cloudflare Pages bundle size guard passed: all files in ${siteDir} are at or below 24 MiB`);
  }
}
