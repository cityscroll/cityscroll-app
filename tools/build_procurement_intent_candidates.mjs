#!/usr/bin/env node

/** Materialize the deterministic PIR Phase 1 review artifact. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractSources, isEligibleHistoricalCouncilSource } from "../warehouse/lib/procurement_intent_extractor.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_INPUT = join(ROOT, "test/fixtures/procurement_intent_radar/gold_fixtures.v0.json");
const DEFAULT_OUTPUT = join(ROOT, "warehouse/fixtures/procurement-intent-radar/candidate_review.v0.json");
const RETAINED_MEETINGS = join(ROOT, "site/data/shared_meeting_read_model.json");

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function loadSources(inputPath) {
  const payload = JSON.parse(readFileSync(inputPath, "utf8"));
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.cases)) return payload.cases.map((item) => item.source);
  if (Array.isArray(payload.sources)) return payload.sources;
  throw new Error("input must be an array, fixture pack, or {sources} document");
}

function retainedCoverage() {
  if (!existsSync(RETAINED_MEETINGS)) {
    return { artifact: "site/data/shared_meeting_read_model.json", rows: 0, council_attributable_rows: 0, text_bearing_council_rows: 0, note: "retained meeting artifact is absent" };
  }
  const payload = JSON.parse(readFileSync(RETAINED_MEETINGS, "utf8"));
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  const councilRows = rows.filter((row) => /council|legistar/iu.test(JSON.stringify(row.source_record || row)) || /council|legistar/iu.test(String(row.source_system || "")));
  const textBearing = councilRows.filter((row) => [row.transcript, row.testimony, row.briefing_paper, row.text, row.body, row.search_text].some((value) => typeof value === "string" && value.trim()));
  return {
    artifact: "site/data/shared_meeting_read_model.json",
    rows: rows.length,
    council_attributable_rows: councilRows.length,
    text_bearing_council_rows: textBearing.length,
    note: "The retained meeting read model contains meeting metadata/search text, not Council transcript, testimony, or briefing-paper passages.",
  };
}

function buildArtifactObject(input) {
  const suppliedSources = loadSources(resolve(input));
  const sources = suppliedSources.filter((source) => isEligibleHistoricalCouncilSource(source));
  const rows = extractSources(sources);
  return {
    schema: "cityscroll.procurement_intent_radar.candidate_review.v0",
    extraction_schema: "cityscroll.future_action_assertion.v0",
    extraction_version: "pir-phase1.0",
    source_policy: "deterministic-only; source text and metadata supplied by the caller; no acquisition or post-dated realization data",
    input_artifact: input === DEFAULT_INPUT ? "test/fixtures/procurement_intent_radar/gold_fixtures.v0.json" : resolve(input),
    coverage: {
      retained_app_corpus: retainedCoverage(),
      review_corpus: { supplied_source_count: suppliedSources.length, eligible_source_count: sources.length, excluded_source_count: suppliedSources.length - sources.length, candidate_count: rows.filter((row) => row.status === "candidate").length, rejected_count: rows.filter((row) => row.status === "rejected").length },
    },
    rows,
  };
}

export function buildArtifact({ input = DEFAULT_INPUT, output = DEFAULT_OUTPUT } = {}) {
  const artifact = buildArtifactObject(input);
  mkdirSync(dirname(resolve(output)), { recursive: true });
  writeFileSync(resolve(output), `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return artifact;
}

export function checkArtifact({ input = DEFAULT_INPUT, output = DEFAULT_OUTPUT } = {}) {
  const expected = buildArtifactObject(input);
  if (!existsSync(resolve(output))) throw new Error("candidate review artifact is missing; rebuild without --check");
  const actual = readFileSync(resolve(output), "utf8");
  if (actual !== `${JSON.stringify(expected, null, 2)}\n`) throw new Error("candidate review artifact is stale; rebuild without --check");
  return expected;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("build_procurement_intent_candidates.mjs")) {
  const input = argument("--input", DEFAULT_INPUT);
  const output = argument("--output", DEFAULT_OUTPUT);
  const artifact = process.argv.includes("--check") ? checkArtifact({ input, output }) : buildArtifact({ input, output });
  console.log(`${process.argv.includes("--check") ? "checked" : "wrote"} ${output} candidates=${artifact.coverage.review_corpus.candidate_count} rejected=${artifact.coverage.review_corpus.rejected_count} retained_council_text=${artifact.coverage.retained_app_corpus.text_bearing_council_rows}`);
}
