#!/usr/bin/env node

/**
 * Fail closed if any .github/workflows file is not valid YAML.
 *
 * Born from PR 2481 / Deploy worker run 36905784571: a column-0 heredoc body
 * ("$chunk_keys") and terminator ("EOF") escaped a `run: |` block scalar, so
 * GitHub could not parse deploy-worker.yml (workflow path as run name, 0 jobs).
 *
 * Parser: vendored js-yaml 4.1.1 under tools/vendor/js-yaml/ (site-node does not
 * install npm deps). No silent skip — import or parse failure exits non-zero.
 *
 * Usage: node tools/check_github_workflows_yaml.mjs
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadAll } from "./vendor/js-yaml/js-yaml.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOWS = join(ROOT, ".github", "workflows");

function listWorkflowFiles() {
  return readdirSync(WORKFLOWS)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .map((name) => join(WORKFLOWS, name))
    .sort();
}

/**
 * Catch content that falls out of a `|` / `>` block scalar at column 0.
 * Ordinary dedents to the next step key are fine; column-0 residue mid-file
 * is the GitHub "0 jobs" parse break.
 */
export function checkBlockScalarIndentation(path, text) {
  const errors = [];
  const lines = text.split(/\r?\n/);
  let inBlock = false;
  let blockStart = 0;
  let contentIndent = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNo = index + 1;
    if (!inBlock) {
      if (/:\s*[|>][+\-0-9]*\s*$/.test(line)) {
        inBlock = true;
        blockStart = lineNo;
        contentIndent = null;
      }
      continue;
    }
    if (line.trim() === "") continue;
    const indent = line.match(/^ */)[0].length;
    if (contentIndent == null) contentIndent = indent;
    if (indent < contentIndent) {
      if (indent === 0) {
        errors.push(
          `${path}: line ${lineNo} column-0 content escapes block scalar `
          + `started at line ${blockStart}: ${JSON.stringify(line)}`,
        );
      }
      inBlock = false;
      contentIndent = null;
      if (/:\s*[|>][+\-0-9]*\s*$/.test(line)) {
        inBlock = true;
        blockStart = lineNo;
      }
    }
  }
  return errors;
}

export function parseWorkflowText(text, { filename = "<workflow>" } = {}) {
  const docs = loadAll(text, { filename });
  if (!docs.length || docs[0] == null) {
    throw new Error(`${filename}: empty YAML document`);
  }
  return docs;
}

function main() {
  const files = listWorkflowFiles();
  if (!files.length) {
    console.error(`no workflow files under ${WORKFLOWS}`);
    process.exitCode = 1;
    return;
  }
  let failures = 0;
  for (const path of files) {
    const rel = path.slice(ROOT.length + 1);
    const text = readFileSync(path, "utf8");
    for (const error of checkBlockScalarIndentation(rel, text)) {
      console.error(error);
      failures += 1;
    }
    try {
      const docs = parseWorkflowText(text, { filename: rel });
      console.log(`OK ${rel} (js-yaml docs=${docs.length})`);
    } catch (error) {
      console.error(`FAIL ${rel}: ${error?.message || error}`);
      failures += 1;
    }
  }
  if (failures) {
    console.error(`github workflows YAML check failed: ${failures} issue(s)`);
    process.exitCode = 1;
    return;
  }
  console.log("github workflows YAML check passed (parser=vendored-js-yaml@4.1.1)");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
