#!/usr/bin/env node
// Renders the real output for card "PPD-07" (procurement-pursuit-decision) --
// the research-lane gate, the registered pre-registrations, the access
// classification, and the handoff copy the classification produces -- for a
// fixed set of named cases, and prints {label: caseResult} JSON to stdout.
//
// Like the sibling PPD-06 evidence tool, this script never opens a browser and
// never produces a screenshot. It calls the real evaluateResearchLaneGates() /
// buildProcurementHandoffCopy() functions and reads the real committed
// classification, and prints their exact output, which is the textual evidence
// this card's capture manifest cites.
//
// Reuses Fixture A (Parks, Playground reconstruction) from the workstream's
// committed fixture ledger, the same identity the pursuit-snapshot,
// preference-set, and pursuit-state capture fixtures already use.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  evaluateResearchLaneGates,
  readResearchLaneRegistry,
  shardPathForEntryId,
} from "../tools/procurement_research_lane_gates.mjs";
import { buildProcurementHandoffCopy } from "../site/procurement_handoff_copy.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLASSIFICATION_RELATIVE = "docs/research/procurement-access-classification/classification.json";

const FIXTURE_A_LAST_OBSERVED = "2026-07-02T10:00:00Z";

function classification() {
  return JSON.parse(readFileSync(join(ROOT, CLASSIFICATION_RELATIVE), "utf8"));
}

// ----- Case: the gate over the committed registry -----
function gateGreenCase() {
  const registry = readResearchLaneRegistry(ROOT);
  const result = evaluateResearchLaneGates(registry, { root: ROOT });
  return {
    gate_command: registry.gate_command,
    ok: result.ok,
    failures: result.failures,
    prerequisite_cards: registry.prerequisite_cards.map((card) => ({
      card: card.card,
      evidence_shards: (card.evidence_shards || []).map((entryId) => shardPathForEntryId(entryId)),
      manifests: card.manifests || [],
    })),
    lanes: registry.lanes.map((lane) => ({
      id: lane.id,
      status: lane.status,
      runnable: lane.runnable,
      preregistration: lane.preregistration
        ? { path: lane.preregistration.path, content_sha256: lane.preregistration.content_sha256 }
        : null,
      steps: lane.steps,
    })),
  };
}

// ----- Case: the gate with one prerequisite card's evidence withdrawn -----
function gateWithdrawnEvidenceCase() {
  const registry = readResearchLaneRegistry(ROOT);
  const withdrawn = JSON.parse(JSON.stringify(registry));
  const card = withdrawn.prerequisite_cards.find((entry) => (entry.evidence_shards || []).length);
  const removed = card.evidence_shards[0];
  card.evidence_shards = [`${removed}-withdrawn-for-this-capture`];
  const result = evaluateResearchLaneGates(withdrawn, { root: ROOT });
  return {
    withdrawn_card: card.card,
    withdrawn_shard: removed,
    ok: result.ok,
    failures: result.failures,
  };
}

// ----- Case: the access classification's own summary -----
function accessClassificationCase() {
  const document = classification();
  return {
    schema: document.schema,
    observation_vintage: document.observation_vintage,
    corpus: { records: document.corpus.records, agencies: document.corpus.agencies, source_observations: document.corpus.source_observations },
    thresholds: document.thresholds,
    summary: document.summary,
    fields: document.fields.map((field) => ({
      id: field.id,
      class: field.class,
      records_observed: field.sample.records_observed,
      records_examined: field.sample.records_examined,
      agencies_observed: field.sample.agencies_observed,
    })),
  };
}

// ----- Case: the handoff copy for Fixture A's matter -----
function handoffCopyCase() {
  return buildProcurementHandoffCopy(classification(), {
    record: { last_observed_at: FIXTURE_A_LAST_OBSERVED },
  });
}

// ----- Case: the same handoff for a record carrying no observation date -----
function handoffCopyUndatedCase() {
  return buildProcurementHandoffCopy(classification(), { record: {} });
}

/**
 * Every named case, freshly computed. Exported so the card's own test can
 * recompute each case's content hash and compare it with the capture manifest,
 * which is what makes the manifest a receipt rather than a claim.
 */
export function researchLaneCaptureCases() {
  return {
    "research-lane-gate-green": gateGreenCase(),
    "research-lane-gate-withdrawn-evidence": gateWithdrawnEvidenceCase(),
    "access-classification-summary": accessClassificationCase(),
    "handoff-copy-fixture-a": handoffCopyCase(),
    "handoff-copy-no-observation-date": handoffCopyUndatedCase(),
  };
}

/** The exact text this card's manifest hashes for one case. */
export function researchLaneCaptureText(caseResult) {
  return `${JSON.stringify(caseResult, null, 2)}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${JSON.stringify(researchLaneCaptureCases(), null, 2)}\n`);
}
