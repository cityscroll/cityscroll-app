#!/usr/bin/env node

/**
 * Keep the provider-neutral preflight contract wider than, and in parity with,
 * the three required hosted validation jobs. Setup/reporting shell and local-only
 * performance helpers are intentionally outside this comparison.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CI_PATH = join(ROOT, ".github", "workflows", "ci.yml");
const PREFLIGHT_PATH = join(ROOT, "tools", "preflight-required-checks.sh");
// Source: the required validation graph declared in .github/workflows/ci.yml. The Unit
// aggregate owns the required status context; its matrix owns the hosted Unit commands.
const REQUIRED_JOBS = ["unit-family", "a11y-pr-shard", "reading-level"];

function jobBlock(source, job) {
  const start = source.search(new RegExp(`^  ${job}:\\s*$`, "m"));
  if (start < 0) throw new Error(`required CI job is missing: ${job}`);
  const remainder = source.slice(start + 1);
  const nextJob = remainder.search(/^  [A-Za-z0-9_-]+:\s*$/m);
  return nextJob < 0 ? remainder : remainder.slice(0, nextJob);
}

function runBlocks(jobSource) {
  const lines = jobSource.split("\n");
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^        run:\s*(.*)$/);
    if (!match) continue;
    if (match[1] && match[1] !== "|") {
      blocks.push(match[1]);
      continue;
    }
    const block = [];
    for (let next = index + 1; next < lines.length; next += 1) {
      if (/^      - /.test(lines[next])) break;
      block.push(lines[next].replace(/^          /, ""));
      index = next;
    }
    blocks.push(block.join("\n"));
  }
  return blocks;
}

function joinShellContinuations(source) {
  const lines = source.split("\n");
  const commands = [];
  let current = "";
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    current += `${current ? " " : ""}${line.replace(/\\$/, "").trim()}`;
    if (!line.endsWith("\\")) {
      commands.push(current);
      current = "";
    }
  }
  if (current) commands.push(current);
  return commands;
}

function normalize(command) {
  return command
    .replace(/[;&]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isValidationCommand(command) {
  if (/^(?:if|then|else|fi|set|echo|sleep|gh|git)\b/.test(command)) return false;
  if (/^(?:python3|python)\s+-m\s+(?:pip|playwright)\b/.test(command)) return false;
  if (/^python3\s+tools\/local_site_server\.py\b/.test(command)) return false;
  if (/^node tools\/validate_presets\.mjs --write\b/.test(command)) return false;
  return /^(?:python3\s+test\/|node\s+(?:--test|tools\/)|npm\s+ci\b)/.test(command);
}

function parityKey(command) {
  // The local preflight checks the same no-disclaimer corpus without the hosted
  // runner's root/format flags. Keep that intentional invocation difference out
  // of the command-identity comparison.
  if (/^python3 test\/standards\/no_disclaimer_slop\.py\b/.test(command)) {
    return "python3 test/standards/no_disclaimer_slop.py";
  }
  return command;
}

function hostedCommands(source) {
  const commands = [];
  for (const job of REQUIRED_JOBS) {
    for (const block of runBlocks(jobBlock(source, job))) {
      for (const command of joinShellContinuations(block).map(normalize)) {
        if (isValidationCommand(command)) commands.push({ job, command });
      }
    }
  }
  return commands;
}

function localCommands(source) {
  const commands = [];
  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const marker = lines[index].indexOf("run_and_fail ");
    if (marker < 0) continue;
    let command = lines[index].slice(marker + "run_and_fail ".length).trim();
    while (command.endsWith("\\") && index + 1 < lines.length) {
      command = `${command.slice(0, -1).trim()} ${lines[++index].trim()}`;
    }
    command = normalize(command.replace(/[)]+$/, ""));
    if (command === "preset_gate") {
      commands.push("node tools/validate_presets.mjs --check");
      continue;
    }
    if (isValidationCommand(command)) commands.push(command);
  }
  return commands;
}

export function compareRequiredCheckParity({ ciSource, preflightSource }) {
  const hosted = hostedCommands(ciSource);
  const local = new Set(localCommands(preflightSource).map(parityKey));
  const missing = hosted.filter(({ command }) => !local.has(parityKey(command)));
  const duplicateHosted = hosted
    .map(({ command }) => command)
    .filter((command, index, all) => all.indexOf(command) !== index);
  return {
    hosted,
    local: [...local].sort(),
    missing,
    duplicateHosted: [...new Set(duplicateHosted)],
  };
}

function main() {
  if (!process.argv.includes("--check")) {
    console.error("usage: node tools/audit-required-check-parity.mjs --check");
    process.exitCode = 2;
    return;
  }
  const result = compareRequiredCheckParity({
    ciSource: readFileSync(CI_PATH, "utf8"),
    preflightSource: readFileSync(PREFLIGHT_PATH, "utf8"),
  });
  if (result.duplicateHosted.length) {
    throw new Error(`duplicate validation commands in required CI jobs: ${result.duplicateHosted.join(", ")}`);
  }
  if (result.missing.length) {
    const details = result.missing.map(({ job, command }) => `  ${job}: ${command}`).join("\n");
    throw new Error(`required hosted commands missing from local preflight contract:\n${details}`);
  }
  console.log(`required-check parity green (${result.hosted.length} hosted commands represented locally)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
