#!/usr/bin/env node

/**
 * PIR-5 prospective shadow mode runner.
 *
 * Replays the retained arrival stream through the two-phase shadow runner and
 * writes the internal-only JSON artifact and its human-readable report. The
 * output is a measurement receipt: it is not served, linked, indexed, or
 * followed, and it authorizes no public surface.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runShadowMode } from "../warehouse/lib/procurement_intent_shadow.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const DEFAULT_STREAM = join(ROOT, "test/fixtures/procurement_intent_radar/shadow_arrivals.v0.json");
export const DEFAULT_OUTPUT = join(ROOT, "warehouse/fixtures/procurement-intent-radar/shadow_mode.v1.json");
export const DEFAULT_REPORT = join(ROOT, "docs/evidence/procurement-intent-radar/shadow-mode.md");
export const STREAM_ARTIFACT = "test/fixtures/procurement_intent_radar/shadow_arrivals.v0.json";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function hashFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function renderJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function buildShadowArtifact({ stream = DEFAULT_STREAM } = {}) {
  const path = resolve(stream);
  return runShadowMode(readJson(path), {
    streamArtifact: STREAM_ARTIFACT,
    streamSha256: hashFile(path),
  });
}

function agencyOf(intent) {
  return intent.assertion.stated_intent.responsible_agency_ref;
}

function count(value, singular, plural = `${singular}s`) {
  return `${value} ${value === 1 ? singular : plural}`;
}

function windowLabel(window) {
  if (!window || (!window.earliest && !window.latest)) return "no stated window";
  return `${window.earliest || "open"} → ${window.latest || "open"}`;
}

export function reportMarkdown(artifact) {
  const { metrics, input_coverage: coverage, protocol, publication_boundary: boundary } = artifact;
  const states = metrics.intent_states;
  const lines = [
    "# Procurement Intent Radar prospective shadow mode",
    "",
    "## What this is",
    "",
    `As of ${artifact.as_of}. Shadow mode replays newly arriving meeting and document text through the`,
    "existing candidate extractor and reconciliation bridge, keeps every resulting intent internal, and",
    "resolves those intents only when later solicitation evidence arrives. It is a measurement mode. No",
    "route, search result, follow target, notification, or resident-facing claim is produced, and nothing",
    "here promotes the workstream.",
    "",
    "The two phases are separated by the information boundary that matters. The assertion phase sees only",
    "an arriving source span, its metadata, its citations, and its clocks. The resolution phase is the only",
    "phase that reads later solicitations, and it records its finding beside the earlier assertion rather",
    "than rewriting it.",
    "",
    "## What was observed",
    "",
    `The retained stream \`${coverage.stream_artifact}\` carries ${count(coverage.arrivals, "arrival")}:`,
    `${count(coverage.source_observations, "source observation")} and ${count(coverage.solicitation_observations, "solicitation observation")}.`,
    `It opened ${count(states.denominator, "internal intent")}: ${states.open} open, ${states.resolved} resolved, ${states.ambiguous} ambiguous,`,
    `${states.unmatched} not observed inside the stated window, and ${states.superseded} superseded.`,
    "",
    `${coverage.limitation} The stream is versioned fixture material rather than retained city evidence,`,
    "so its source spans and solicitation rows make no claim about any real agency or real solicitation.",
    "",
    "| Register | Result |",
    "| --- | --- |",
    `| Occurrence | ${metrics.occurrence.realized} realized, ${metrics.occurrence.review_required} awaiting review, ${metrics.occurrence.not_observed_yet} not observed yet, ${metrics.occurrence.not_observed_in_stated_window} not observed in the stated window |`,
    `| Timing | ${metrics.timing.hit} window hit, ${metrics.timing.miss} window miss, ${metrics.timing.claims_abstained} abstained for want of a stated window |`,
    `| Abstentions | ${count(metrics.abstention.extraction_abstentions, "extraction abstention")}, ${count(metrics.abstention.insufficient_source_evidence, "arrival")} with insufficient source evidence, ${count(metrics.abstention.review_required, "intent")} needing human review |`,
    `| Freshness | ${count(metrics.freshness.stale_arrivals, "stale arrival")} over the ${metrics.freshness.stale_threshold_days}-day threshold; maximum arrival lag ${count(metrics.freshness.maximum_arrival_lag_days, "day")} |`,
    `| Idempotency | ${count(metrics.idempotency.duplicate_replays, "duplicate replay")}, ${count(metrics.idempotency.assertions_rewritten_by_replay, "assertion")} rewritten by replay |`,
    `| Supersession | ${metrics.supersession.superseded_intents} superseded, ${count(metrics.supersession.superseded_assertions_retained, "superseded assertion")} retained verbatim |`,
    `| Realization cardinality | ${metrics.realization_cardinality.one_to_one} one-to-one, ${metrics.realization_cardinality.one_to_many} one-to-many, ${metrics.realization_cardinality.none} with no accepted realization |`,
    "",
    "### No-promotion gate",
    "",
    `**${artifact.promotion.status}.** ${artifact.promotion.reason}`,
    "",
    "| Gate | Measured | Threshold | Result |",
    "| --- | ---: | ---: | --- |",
    `| Public surfaces created | ${artifact.promotion.gates.public_exposure.observed_public_surfaces} | 0 | ${artifact.promotion.gates.public_exposure.passed ? "pass" : "fail"} |`,
    `| Temporal leakage failures | ${artifact.promotion.gates.temporal_integrity.observed_failures} | 0 | ${artifact.promotion.gates.temporal_integrity.passed ? "pass" : "fail"} |`,
    `| Recurrent arrival corpus | ${artifact.promotion.gates.recurrent_arrival_corpus.observed_source_observations} source observations | ${artifact.promotion.gates.recurrent_arrival_corpus.threshold} | ${artifact.promotion.gates.recurrent_arrival_corpus.passed ? "pass" : "withheld"} |`,
    "",
    "## What remains unknown",
    "",
    "An open intent has not failed. It has not been observed yet, and the artifact records that separately",
    "from an intent whose stated window closed with no observed solicitation. Ambiguous candidates stay",
    "internal review leads and never become accepted edges. Every provisional identity keeps its publisher",
    "fields as explicit nulls until a later observation resolves them.",
    "",
    "## Per-intent evidence",
    "",
    "| Intent | Asserted | Arrived | Agency | Stated window | State | Occurrence | Timing | Lead | Realizations |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | ---: | ---: |",
    ...artifact.intents.map((intent) => [
      "",
      intent.process_ref,
      intent.assertion.asserted_at,
      intent.assertion.arrived_at,
      agencyOf(intent),
      windowLabel(intent.assertion.stated_intent.expected_window),
      intent.state,
      intent.resolution.prospective_outcome.occurrence,
      intent.resolution.prospective_outcome.timing,
      intent.resolution.prospective_outcome.lead_days ?? "—",
      `${intent.resolution.accepted_edges.length} accepted / ${intent.resolution.candidates.length} candidates`,
      "",
    ].join(" | ").trim()),
    "",
    "### Arrivals that opened no intent",
    "",
    "| Arrival | Arrived | Disposition | Reasons |",
    "| --- | --- | --- | --- |",
    ...artifact.arrivals
      .filter((row) => ["insufficient_evidence", "abstained", "duplicate_replay", "malformed"].includes(row.disposition))
      .map((row) => `| ${row.arrival_id} | ${row.arrived_at} | ${row.disposition} | ${(row.reasons || []).join(", ") || "—"} |`),
    "",
    "## How this was established",
    "",
    [
      `Evaluator versions: extractor ${protocol.evaluator_versions.extractor};`,
      `prospective ontology ${protocol.evaluator_versions.prospective_ontology};`,
      `realization matcher ${protocol.evaluator_versions.realization_matcher};`,
      `shadow mode ${protocol.evaluator_versions.shadow_mode}.`,
    ].join(" "),
    "",
    "Each arriving source is sealed at its own publication clock before extraction, so a later EPIN, title,",
    "vendor, coverage field, or publication date cannot enter candidate generation. The assertion phase is",
    "handed the source projection of the stream and never the solicitation projection, so later evidence is",
    "structurally out of reach rather than merely unused. Every assertion is fingerprinted before resolution",
    "and re-checked after it; a changed fingerprint is a hard failure.",
    "",
    "Identity is content-addressed from the sealed source, so replaying the same arrival is a recorded",
    "duplicate rather than a second intent. A later arrival that resolves to the same provisional subject",
    "supersedes the earlier one and the earlier assertion is retained unchanged.",
    "",
    `Runtime dependencies: none. ${protocol.runtime_dependencies.note} The run is reproducible from the`,
    "retained, versioned stream alone.",
    "",
    [
      `Visibility: ${boundary.visibility}.`,
      `Public routes ${boundary.public_routes.length};`,
      `public realized edges ${boundary.public_realized_edges};`,
      `notifications ${boundary.notifications_emitted};`,
      `resident-facing claims ${boundary.resident_facing_claims}.`,
      `Authorization: ${boundary.authorization}.`,
    ].join(" "),
    "",
    "Rebuild:",
    "",
    "```sh",
    "node tools/run_procurement_intent_shadow_mode.mjs",
    "node tools/run_procurement_intent_shadow_mode.mjs --check",
    "```",
  ];
  return `${lines.join("\n")}\n`;
}

export function writeShadowMode({ stream = DEFAULT_STREAM, output = DEFAULT_OUTPUT, report = DEFAULT_REPORT } = {}) {
  const artifact = buildShadowArtifact({ stream });
  mkdirSync(dirname(resolve(output)), { recursive: true });
  writeFileSync(resolve(output), renderJson(artifact), "utf8");
  mkdirSync(dirname(resolve(report)), { recursive: true });
  writeFileSync(resolve(report), reportMarkdown(artifact), "utf8");
  return artifact;
}

export function checkShadowMode({ stream = DEFAULT_STREAM, output = DEFAULT_OUTPUT, report = DEFAULT_REPORT } = {}) {
  const artifact = buildShadowArtifact({ stream });
  if (artifact.temporal_integrity.leakage_failures.length !== 0) {
    throw new Error("shadow mode has temporal leakage failures; leakage is a hard failure");
  }
  if (artifact.publication_boundary.public_realized_edges !== 0 || artifact.publication_boundary.public_routes.length !== 0) {
    throw new Error("shadow mode must not publish public surfaces");
  }
  if (!existsSync(resolve(output)) || readFileSync(resolve(output), "utf8") !== renderJson(artifact)) {
    throw new Error("shadow mode JSON is stale; rebuild without --check");
  }
  if (!existsSync(resolve(report)) || readFileSync(resolve(report), "utf8") !== reportMarkdown(artifact)) {
    throw new Error("shadow mode report is stale; rebuild without --check");
  }
  return artifact;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("run_procurement_intent_shadow_mode.mjs")) {
  const check = process.argv.includes("--check");
  const artifact = check ? checkShadowMode() : writeShadowMode();
  const states = artifact.metrics.intent_states;
  console.log([
    `${check ? "checked" : "wrote"} PIR-5 shadow mode`,
    `arrivals=${artifact.input_coverage.arrivals}`,
    `intents=${states.denominator}`,
    `open=${states.open}`,
    `resolved=${states.resolved}`,
    `ambiguous=${states.ambiguous}`,
    `unmatched=${states.unmatched}`,
    `superseded=${states.superseded}`,
    `leakage_failures=${artifact.temporal_integrity.leakage_failures.length}`,
    `visibility=${artifact.visibility}`,
    `promotion=${artifact.promotion.status}`,
  ].join(" "));
}
