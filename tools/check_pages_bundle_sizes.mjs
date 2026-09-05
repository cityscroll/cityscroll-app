#!/usr/bin/env node

import { readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

import { publicSitePayloadFiles, publicSiteSourceRoot } from "./lib/public_site_payload.mjs";

// Cloudflare Pages' per-file guard. The Worker has a separate uncompressed
// bundle ceiling: tools/worker_deploy_guard.mjs checks the pinned Wrangler
// dry-run metafile against the 64 MiB raw, 10 MB compressed, and startup budgets.
// Keep these checks separate because they measure different deploy artifacts.
export const MAX_PAGES_FILE_BYTES = 24 * 1024 * 1024;

// The production build refreshes source data on the runner before it builds, so
// a published file is larger at deploy time than the committed copy a pull
// request measured. That difference is why a file can pass every pull-request
// check and then fail the deploy. This is the margin reserved for it: a
// published file at or below the headroom mark has room for a refresh to grow
// it, and one above the mark is reported as out of headroom while it is still
// deploying rather than on the day it crosses the hard ceiling. It is the same
// figure the shared read model already packs its shards to
// (DEFAULT_PROCUREMENT_SHARD_MAX_BYTES in site/procurement_read_model_shards.mjs),
// so a sharded artifact satisfies it by construction.
export const PAGES_FILE_HEADROOM_BYTES = 18 * 1024 * 1024;

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

function overLimit(files, limit) {
  return files
    .filter(({ bytes }) => bytes > limit)
    .sort((left, right) => left.path.localeCompare(right.path));
}

function builtPagesFiles(siteDir) {
  const root = resolve(siteDir);
  return filesUnder(root).map((path) => ({ path, bytes: statSync(path).size }));
}

export function oversizedPagesFiles(siteDir, limit = MAX_PAGES_FILE_BYTES) {
  return overLimit(builtPagesFiles(siteDir), limit);
}

/**
 * The same measurement taken against the site source instead of a built
 * payload, so the budget can be checked without a full build — in a unit
 * suite, or immediately after a build boundary regenerates a data artifact.
 * Only files the public site build actually publishes are measured.
 */
export function publishedSourceFiles(sourceDir = ".") {
  return publicSitePayloadFiles(publicSiteSourceRoot(resolve(sourceDir)));
}

export function oversizedPublishedSourceFiles(sourceDir = ".", limit = MAX_PAGES_FILE_BYTES) {
  return overLimit(publishedSourceFiles(sourceDir), limit);
}

function describe(finding) {
  const sizeMiB = (finding.bytes / (1024 * 1024)).toFixed(2);
  return `${relative(process.cwd(), finding.path)} (${finding.bytes} bytes, ${sizeMiB} MiB)`;
}

function parseFlag(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[index + 1] : null;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const argv = process.argv.slice(2);
  const sourceDir = parseFlag(argv, "--source-dir");
  const files = sourceDir
    ? publishedSourceFiles(sourceDir)
    : builtPagesFiles(parseFlag(argv, "--site-dir") || "_site");
  const scope = sourceDir
    ? `the published files in ${sourceDir}`
    : `all files in ${parseFlag(argv, "--site-dir") || "_site"}`;

  const findings = overLimit(files, MAX_PAGES_FILE_BYTES);
  for (const finding of findings) {
    console.error(
      `Cloudflare Pages bundle file exceeds the 24 MiB guard: ${describe(finding)}. `
      + "Pages rejects files over 25 MiB.",
    );
  }
  if (findings.length) process.exitCode = 1;

  for (const finding of overLimit(files, PAGES_FILE_HEADROOM_BYTES)) {
    if (findings.includes(finding)) continue;
    console.warn(
      `Cloudflare Pages bundle file is out of refresh headroom: ${describe(finding)} is above the `
      + "18 MiB headroom mark, so a build-time source refresh can push it past the 24 MiB guard.",
    );
  }

  if (!findings.length) {
    console.log(`Cloudflare Pages bundle size guard passed: ${scope} are at or below 24 MiB`);
  }
}
