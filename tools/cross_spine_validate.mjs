#!/usr/bin/env node
// Validate cross-spine fixture bundles (pure, no network).

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateCrossSpineFixtures } from "../ontology/cross_spine.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_FIXTURES = join(ROOT, "ontology/fixtures/cross_spine");

function usage(message) {
  if (message) console.error(`error: ${message}`);
  console.error(`Usage:
  node tools/cross_spine_validate.mjs [--fixtures <dir>] [--json] [--out <path>] [--check]

Default fixtures: ontology/fixtures/cross_spine
Files named fail_* must contradict; all other files must pass.`);
  process.exitCode = message ? 1 : 0;
}

function parseArgs(argv) {
  const args = {
    fixtures: DEFAULT_FIXTURES,
    json: false,
    out: null,
    check: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--fixtures") args.fixtures = resolve(argv[++i]);
    else if (a === "--out") args.out = resolve(argv[++i]);
    else if (a === "--json") args.json = true;
    else if (a === "--check") args.check = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

function loadBundles(dir) {
  if (!existsSync(dir)) throw new Error(`fixtures dir not found: ${dir}`);
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const path = join(dir, name);
      const bundle = JSON.parse(readFileSync(path, "utf8"));
      return { name, path, bundle, expect_fail: name.startsWith("fail_") };
    });
}

function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    usage(error.message);
    return;
  }
  if (args.help) {
    usage();
    return;
  }

  const loaded = loadBundles(args.fixtures);
  const report = validateCrossSpineFixtures(loaded.map((row) => row.bundle));
  report.files = loaded.map((row, index) => ({
    name: row.name,
    expect_fail: row.expect_fail,
    ok: report.results[index].ok,
    contradictions: report.results[index].contradictions,
    checked: report.results[index].checked,
  }));

  let suiteOk = true;
  for (const file of report.files) {
    if (file.expect_fail) {
      if (file.ok) {
        suiteOk = false;
        file.suite_error = "expected contradictions but bundle passed";
      }
    } else if (!file.ok) {
      suiteOk = false;
      file.suite_error = "expected pass but found contradictions";
    }
  }
  report.suite_ok = suiteOk;
  report.ok = suiteOk;

  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (args.out) {
    if (args.check && existsSync(args.out)) {
      const prior = readFileSync(args.out, "utf8");
      if (prior !== text) {
        console.error("cross-spine receipt drift vs --out");
        process.exitCode = 1;
        if (args.json) process.stdout.write(text);
        return;
      }
    } else {
      writeFileSync(args.out, text);
    }
  }

  if (args.json) process.stdout.write(text);
  else {
    console.log(
      `cross_spine bundles=${report.bundle_count} checked=${report.checked} contradictions=${report.contradictions} suite_ok=${report.suite_ok}`,
    );
    for (const file of report.files) {
      console.log(
        `  ${file.name} ok=${file.ok} contradictions=${file.contradictions}${file.suite_error ? ` ERROR ${file.suite_error}` : ""}`,
      );
    }
  }

  if (!report.suite_ok) process.exitCode = 1;
}

main();
