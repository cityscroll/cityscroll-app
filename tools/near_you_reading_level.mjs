#!/usr/bin/env node
/** Ratchet reader-visible, CityScroll-authored copy on static Near-you documents. */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function decodeHtml(value) {
  return String(value)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

export function nearYouAuthoredCopy(html) {
  const scrubbed = String(html)
    .replace(/<(?:style|script|svg)\b[^>]*>[\s\S]*?<\/(?:style|script|svg)>/gi, " ")
    .replace(/<ol class="near-(?:area-list|records)"[^>]*>[\s\S]*?<\/ol>/gi, " ");
  const prose = [...scrubbed.matchAll(/<(p|footer)\b([^>]*)>([\s\S]*?)<\/\1>/gi)]
    .filter(([, , attrs]) => !/near-(?:kicker|map-status|vintage)|map-legend/.test(attrs))
    .map(([, , , body]) => body.replace(/<[^>]*>/g, " "))
    .join(" ");
  return decodeHtml(prose)
    .replace(/\s+/g, " ")
    .trim();
}

export function evaluateNearYouReadingRatchet(grade, baseline) {
  const maximum = Number(baseline?.metrics?.grade_level?.baseline);
  if (!Number.isFinite(grade) || !Number.isFinite(maximum)) {
    throw new Error("invalid Near-you reading-level metric or baseline");
  }
  return { pass: grade <= maximum, grade_level: { value: grade, baseline: maximum, direction: "max" } };
}

async function score(executable = "readable-or-else") {
  const source = await readFile(path.join(ROOT, "site", "near-you", "index.html"), "utf8");
  const copy = nearYouAuthoredCopy(source);
  const directory = await mkdtemp(path.join(tmpdir(), "cityscroll-near-you-reading-"));
  const input = path.join(directory, "near-you.html");
  await writeFile(input, `<!doctype html><html lang="en"><body><p>${copy}</p></body></html>\n`);
  try {
    const result = spawnSync(executable, ["check", input, "--preset", "nycsg7", "--mode", "warn", "--format", "json"], { encoding: "utf8" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error((result.stderr || result.stdout || "readability check failed").trim());
    const [measurement] = JSON.parse(result.stdout);
    return {
      grade: measurement.grade,
      word_count: measurement.word_count,
      sentence_count: measurement.sentence_count,
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
  const ratchet = evaluateNearYouReadingRatchet(measurement.grade, baseline);
  const report = { schema_version: 1, surface: "near-you", tool: "readable-or-else", preset: "nycsg7", ...measurement, ratchet };
  process.stdout.write(format === "markdown"
    ? `Near-you copy: grade ${measurement.grade.toFixed(2)} (maximum ${ratchet.grade_level.baseline}); ${measurement.word_count} words; ratchet ${ratchet.pass ? "PASS" : "FAIL"}.\n`
    : `${JSON.stringify(report, null, 2)}\n`);
  return ratchet.pass ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`near_you_reading_level: ${error.message}\n`);
    process.exitCode = 1;
  });
}
