#!/usr/bin/env node
/** Ratchet the reader-visible, CityScroll-authored copy on the dynamic Now surface. */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NON_VISIBLE_KEYS = new Set(["now_basis_derived", "now_date_source_field"]);

function loadEnglishStrings() {
  globalThis.window = globalThis;
  globalThis.localStorage = { getItem: () => "en", setItem: () => {} };
  globalThis.location = { search: "", href: "https://cityscroll.org/" };
  require(path.join(ROOT, "site", "i18n.js"));
  return globalThis.STRINGS.en;
}

function plainCopy(value) {
  return String(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/\{date\}/g, "August 10, 2026")
    .replace(/\{sources?\}/g, "City Record")
    .replace(/\{n\}/g, "4")
    .replace(/\{[^}]+\}/g, "details")
    .replace(/\s+/g, " ")
    .trim();
}

export function nowReadingCopy(strings = loadEnglishStrings()) {
  return Object.entries(strings)
    .filter(([key]) => key.startsWith("now_") && !NON_VISIBLE_KEYS.has(key))
    .map(([key, value]) => ({ key, text: plainCopy(value) }))
    .filter((row) => row.text);
}

export function evaluateNowReadingRatchet(grade, baseline) {
  const maximum = Number(baseline?.metrics?.grade_level?.baseline);
  if (!Number.isFinite(grade) || !Number.isFinite(maximum)) throw new Error("invalid Now reading-level metric or baseline");
  return { pass: grade <= maximum, grade_level: { value: grade, baseline: maximum, direction: "max" } };
}

async function score(executable = "readable-or-else") {
  const copy = nowReadingCopy();
  const directory = await mkdtemp(path.join(tmpdir(), "cityscroll-now-reading-"));
  const input = path.join(directory, "now.html");
  const body = copy.map((row) => `<p data-key="${row.key}">${row.text}</p>`).join("\n");
  await writeFile(input, `<!doctype html><html lang="en"><body>${body}</body></html>\n`);
  try {
    const result = spawnSync(executable, ["check", input, "--preset", "nycsg7", "--mode", "warn", "--format", "json"], { encoding: "utf8" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error((result.stderr || result.stdout || "readability check failed").trim());
    const [measurement] = JSON.parse(result.stdout);
    return {
      grade: measurement.grade,
      word_count: measurement.word_count,
      sentence_count: measurement.sentence_count,
      copy_keys: copy.map((row) => row.key),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function main(argv = process.argv.slice(2)) {
  let baselinePath = null;
  let format = "json";
  let executable = "readable-or-else";
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--baseline") baselinePath = argv[++index];
    else if (argv[index] === "--format") format = argv[++index];
    else if (argv[index] === "--readable-or-else") executable = argv[++index];
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  if (!baselinePath) throw new Error("--baseline is required");
  const baseline = JSON.parse(await readFile(path.resolve(baselinePath), "utf8"));
  const measurement = await score(executable);
  const ratchet = evaluateNowReadingRatchet(measurement.grade, baseline);
  const report = { schema_version: 1, surface: "now", tool: "readable-or-else", preset: "nycsg7", ...measurement, ratchet };
  process.stdout.write(format === "markdown"
    ? `Now copy: grade ${measurement.grade.toFixed(2)} (maximum ${ratchet.grade_level.baseline}); ${measurement.word_count} words; ratchet ${ratchet.pass ? "PASS" : "FAIL"}.\n`
    : `${JSON.stringify(report, null, 2)}\n`);
  return ratchet.pass ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`now_reading_level: ${error.message}\n`);
    process.exitCode = 1;
  });
}
