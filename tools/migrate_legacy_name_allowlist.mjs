#!/usr/bin/env node
// Converts the previous line-pinned allowlist format (path, line number, digest)
// into content-addressed pins (path, digest, optional count=N).
// Live duplicate pins for the same line become one entry with count=N.
// Deferred (future:) duplicate pins were alternative line placements for one
// expected occurrence and collapse to count=1.
// Line numbers are dropped; they are not kept as advisory fields.
// Safe to re-run on an already-migrated file.

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_HEADER,
  parseAllowlistText,
  renderAllowlistFile,
} from "./check_stale_repo_name.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const ALLOWLIST_PATH = join(ROOT, ".github", "legacy-name-allowlist.txt");

const { records } = parseAllowlistText(readFileSync(ALLOWLIST_PATH, "utf8"));
writeFileSync(ALLOWLIST_PATH, renderAllowlistFile(DEFAULT_HEADER, records));
const counted = records.filter((record) => record.count > 1).length;
console.log(
  `Migrated ${records.length} content-addressed pin(s); ${counted} with count>1.`,
);
