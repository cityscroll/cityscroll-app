#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  publicPayloadTreeFindings,
  publicTextFindings,
} from "./lib/public_payload_integrity.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const payloadRoots = [path.join(ROOT, "site/data"), path.join(ROOT, "worker/src/data")];

function readerSurfaceFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === "data") continue;
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...readerSurfaceFiles(target));
    else if (entry.isFile() && /\.(?:html|js|mjs)$/.test(entry.name)) files.push(target);
  }
  return files;
}

const surfaceFiles = readerSurfaceFiles(path.join(ROOT, "site"));

const findings = publicPayloadTreeFindings(payloadRoots, { repoRoot: ROOT });
for (const file of surfaceFiles) {
  const source = path.relative(ROOT, file);
  findings.push(...publicTextFindings(readFileSync(file, "utf8"), { source }));
}

if (findings.length) {
  console.error(`public payload integrity: ${findings.length} test-data marker(s)`);
  for (const item of findings.slice(0, 80)) {
    console.error(`  ${item.source}:${item.path} [${item.kind}] ${item.value}`);
  }
  if (findings.length > 80) console.error(`  ... ${findings.length - 80} more`);
  process.exit(1);
}

console.log(
  `public payload integrity OK — ${payloadRoots.length} payload trees and ${surfaceFiles.length} reader surfaces`,
);
