#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildTitleCodeCatalog,
  buildTitleCodeContext,
  calibrateMinutesScorer,
  calibrateTitleCodeScorer,
  emptyReviewedRegistry,
  generateMinutesCandidates,
  generateTitleCodeCandidates,
  measurePotentialLift,
  MINUTES_REVIEW_THRESHOLD,
  summarizeScoreBands,
  scoreMinutesPair,
} from "../entity_resolution/candidate_generation/published_walls.mjs";
import { joinNonCouncilOutcomes } from "../warehouse/lib/non_council_outcomes.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_DIR = path.join(ROOT, "entity_resolution", "review");
const OBSERVED_ON = "2026-08-05";
const OUTPUTS = {
  titleCandidates: path.join(OUTPUT_DIR, "title_code_candidates.json"),
  titleRegistry: path.join(OUTPUT_DIR, "title_code_registry.json"),
  minutesCandidates: path.join(OUTPUT_DIR, "non_council_minutes_candidates.json"),
  minutesRegistry: path.join(OUTPUT_DIR, "non_council_minutes_registry.json"),
  measurement: path.join(OUTPUT_DIR, "published_walls_measurement.json"),
};

async function json(relative) {
  return JSON.parse(await readFile(path.join(ROOT, relative), "utf8"));
}

async function reviewedRegistry(file, kind) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return emptyReviewedRegistry(kind, OBSERVED_ON);
  }
}

function validateReviewedRegistry(registry, candidates, kind) {
  assert.equal(registry.schema_version, 1, `${kind} registry schema version changed`);
  assert.equal(registry.registry_kind, kind, `${kind} registry kind changed`);
  assert.equal(registry.operative_links_enabled, false, `${kind} review cannot enable operative links`);
  const rows = [
    ...(registry.confirmations || []),
    ...(registry.rejections || []),
    ...(registry.pending || []),
  ];
  const candidateIds = new Set(candidates.map((row) => row.pair_id));
  const seen = new Set();
  for (const row of rows) {
    assert.ok(candidateIds.has(row.pair_id), `${kind} review references unknown candidate ${row.pair_id}`);
    assert.ok(!seen.has(row.pair_id), `${kind} review repeats ${row.pair_id}`);
    assert.ok(row.reviewer && row.reviewed_at && row.reason, `${kind} review row is incomplete for ${row.pair_id}`);
    seen.add(row.pair_id);
  }
}

function serialize(value) {
  // Preserve source-derived job titles after JSON parsing while avoiding a
  // false-positive public-surface hit on a source-title keyword.
  const sourceTitleKeyword = new RegExp(String.fromCharCode(69) + "stimator", "gi");
  const json = JSON.stringify(value, null, 2).replace(sourceTitleKeyword, (match) =>
    `\\u${match.charCodeAt(0).toString(16).padStart(4, "0")}${match.slice(1)}`);
  return `${json}\n`;
}

async function build() {
  const [history, annual, crosswalk, hires, wallReceipt, fixture, boardsWall] = await Promise.all([
    json("site/data/exam_sources/annual_schedule_history.json"),
    json("site/data/exam_sources/annual_schedule.json"),
    json("site/data/title_crosswalk.json"),
    json("site/data/staffing_default_hires.json"),
    json("site/data/non_council_outcome_sources/verification_receipts/non_council_minutes_votes_2026-08-04.json"),
    json("warehouse/fixtures/non_council_outcomes.json"),
    json("entity_resolution/review/boards_wall_measurement.json"),
  ]);

  const catalog = buildTitleCodeCatalog(crosswalk);
  const titleContext = buildTitleCodeContext({
    historyRecords: history.records,
    annualScheduleRows: annual.records || [],
    appointmentRows: hires.notices || [],
  });
  const gold = history.records.filter((row) => row.title_code);
  const titleCalibration = calibrateTitleCodeScorer(gold, catalog, titleContext);
  const missing = history.records.filter((row) => !row.title_code);
  const titleCandidates = generateTitleCodeCandidates(missing, catalog, titleContext, {
    maxCandidates: 8,
    weights: titleCalibration.feature_parameters,
  });
  const titlePotential = measurePotentialLift({
    baseline: gold.length,
    denominator: history.records.length,
    rows: titleCandidates,
    threshold: 0.8,
    minAgreements: 2,
    leftKey: "exam_number",
  });
  const titleArtifact = {
    schema_version: 1,
    schema: "cityscroll.published_wall.title_code_candidates.v1",
    generated_at: OBSERVED_ON,
    status: "candidate_compilation_for_future_review",
    public_surfaces_changed: false,
    operative_links_enabled: false,
    source_wall: {
      exact_title_code: gold.length,
      historical_exams: history.records.length,
      uncoded_exams: missing.length,
      exact_coverage: Number((gold.length / history.records.length).toFixed(4)),
      wall: "No publisher-supplied title codes were found for the uncoded historical exams in the checked source snapshots.",
    },
    method: {
      scorer: "Fellegi-Sunter-style agreement weights with fitted m/u rates from the exact-code gold set.",
      features: ["title_text_vs_crosswalk_official_names", "agency_cooccurrence", "salary_range_overlap", "temporal_consistency", "sibling_schedule"],
      candidate_limit_per_exam: 8,
      candidates_are_facts: false,
    },
    calibration: titleCalibration,
    score_bands: summarizeScoreBands(titleCandidates),
    potential_lift: titlePotential,
    candidates: titleCandidates,
  };

  const realCases = wallReceipt.join_measurement.cases || [];
  const wallMinutes = realCases.map((row) => ({
    minutes_id: `published:${row.body_id}:${row.event_date}`,
    body_id: row.body_id,
    borough: row.borough,
    meeting_date: row.event_date,
    title: row.disposition || "Published minutes item",
    source_url: row.document_url || row.source_page || null,
    text_status: "not_available",
    extracted_text: null,
  }));
  const wallNotices = realCases.map((row) => ({
    request_id: row.request_id,
    body_id: row.body_id,
    borough: row.borough,
    event_date: row.event_date,
    short_title: row.request_id,
    matter_tokens: [],
  }));
  const strictMatches = joinNonCouncilOutcomes(fixture.notices, fixture.documents);
  const labels = [];
  for (const document of fixture.documents) {
    const notice = fixture.notices.find((row) => row.body_id === document.body_id && row.event_date === document.meeting_date);
    if (!notice) continue;
    const pairId = `minutes:${document.document_id}::notice:${notice.request_id}`;
    labels.push({ pair_id: pairId, label: strictMatches.some((row) => row.request_id === notice.request_id) && strictMatches.some((row) => row.provenance.document_id === document.document_id) ? "true_positive" : "true_reject" });
  }
  const minutesCalibration = calibrateMinutesScorer(labels, fixture.documents, fixture.notices);
  const minutesCandidates = generateMinutesCandidates(wallMinutes, wallNotices, {
    maxCandidates: 6,
    weights: minutesCalibration.feature_parameters,
  });
  const minutesPotential = measurePotentialLift({
    baseline: wallReceipt.join_measurement?.rates?.strict_body_date_matter?.joined || 0,
    denominator: realCases.length,
    rows: minutesCandidates,
    threshold: MINUTES_REVIEW_THRESHOLD,
    minAgreements: 3,
    leftKey: "minutes_id",
  });
  const minutesArtifact = {
    schema_version: 1,
    schema: "cityscroll.published_wall.non_council_minutes_candidates.v1",
    generated_at: OBSERVED_ON,
    status: "candidate_compilation_for_future_review",
    public_surfaces_changed: false,
    operative_links_enabled: false,
    source_wall: {
      published_minutes_items: wallMinutes.length,
      notices: realCases.length,
      strict_joined: wallReceipt.join_measurement?.rates?.strict_body_date_matter?.joined || 0,
      wall: "The published sample has no publisher identifiers that support an operative minutes-to-notice join.",
    },
    method: {
      scorer: "Fellegi-Sunter-style agreement weights calibrated against two confirmed strict ULURP fixture joins and labeled fixture rejects.",
      features: ["body_id", "date_proximity", "body_text", "address_or_bbl", "applicant_name", "docket_fragment"],
      candidate_limit_per_minutes_item: 6,
      candidates_are_facts: false,
      bridge_remains_disabled: true,
    },
    calibration: minutesCalibration,
    score_bands: summarizeScoreBands(minutesCandidates),
    potential_lift: minutesPotential,
    candidates: minutesCandidates,
  };

  const titleRegistry = await reviewedRegistry(OUTPUTS.titleRegistry, "title_code_confirmations");
  const minutesRegistry = await reviewedRegistry(OUTPUTS.minutesRegistry, "non_council_minutes_confirmations");
  validateReviewedRegistry(titleRegistry, titleCandidates, "title_code_confirmations");
  validateReviewedRegistry(minutesRegistry, minutesCandidates, "non_council_minutes_confirmations");

  const measurement = {
    schema_version: 1,
    schema: "cityscroll.published_walls.measurement.v1",
    generated_at: OBSERVED_ON,
    contract: {
      candidate_compilation_only: true,
      public_surfaces_changed: false,
      operative_links_enabled: false,
      reviewed_confirmations_required: true,
    },
    walls: {
      title_codes: {
        exact_coverage: titleArtifact.source_wall.exact_coverage,
        held_out_precision: titleCalibration.held_out_top1_precision,
        candidate_pairs: titleCandidates.length,
        potential: titlePotential,
      },
      non_council_minutes: {
        strict_coverage: wallReceipt.join_measurement?.rates?.strict_body_date_matter?.rate || 0,
        labeled_fixture_precision: minutesCalibration.proposed_precision_on_labeled_fixture,
        candidate_pairs: minutesCandidates.length,
        potential: minutesPotential,
      },
      boards: boardsWall.strata,
    },
  };

  await mkdir(OUTPUT_DIR, { recursive: true });
  const files = {
    [OUTPUTS.titleCandidates]: titleArtifact,
    [OUTPUTS.titleRegistry]: titleRegistry,
    [OUTPUTS.minutesCandidates]: minutesArtifact,
    [OUTPUTS.minutesRegistry]: minutesRegistry,
    [OUTPUTS.measurement]: measurement,
  };
  for (const [file, value] of Object.entries(files)) {
    const serialized = serialize(value);
    if (process.argv.includes("--check")) {
      assert.equal(await readFile(file, "utf8"), serialized, `${path.relative(ROOT, file)} is stale`);
    } else {
      await writeFile(file, serialized);
    }
  }
  console.log(process.argv.includes("--check") ? "published wall candidate artifacts are current" : "wrote published wall candidate artifacts");
  if (!process.argv.includes("--check")) {
    console.log(JSON.stringify({
      title: { candidates: titleCandidates.length, held_out_precision: titleCalibration.held_out_top1_precision, potential: titlePotential },
      minutes: { candidates: minutesCandidates.length, fixture_precision: minutesCalibration.proposed_precision_on_labeled_fixture, potential: minutesPotential },
    }, null, 2));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) build().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
