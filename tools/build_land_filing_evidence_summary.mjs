#!/usr/bin/env node
/**
 * Materialize the bounded Land filing-evidence summary (LDP-27), joining
 * LDP-23 obligations, LDP-24 document manifests, LDP-25 RER envelopes, and
 * LDP-26 filing sequences per project into `site/data/land_filing_evidence_summary.json`.
 *
 * This repo has not yet run the LDP-22..26 collection pipeline against a
 * live ZAP corpus, so there are no committed obligation/document/RER/sequence
 * records to join today. Rather than invent one, this builder emits an
 * honest empty `summaries: {}` -- exactly the "no filing evidence available"
 * state `land_filing_evidence_view.mjs` already renders correctly (A9) --
 * and is ready to join real per-project inputs the moment those cards'
 * warehouse output exists on disk.
 *
 * Usage:
 *   node tools/build_land_filing_evidence_summary.mjs
 *   node tools/build_land_filing_evidence_summary.mjs --check
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildLandFilingEvidenceSummary, withLandFilingEvidenceReport } from "../site/land_filing_evidence.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PAYLOAD_JSON = "site/data/land_filing_evidence_summary.json";
export const LAND_FILING_EVIDENCE_SUMMARY_SCHEMA = "cityscroll.land_filing_evidence_summary_lookup.v1";

/**
 * @param {{
 *   obligationsByProject?: Record<string, object>,
 *   documentsByProject?: Record<string, object[]>,
 *   rerEnvelopesByDocument?: Record<string, object>,
 *   sequencesByProject?: Record<string, object>,
 *   generatedAt: string,
 * }} input
 */
export function buildLandFilingEvidenceSummaryLookup({
  obligationsByProject = {},
  documentsByProject = {},
  rerEnvelopesByDocument = {},
  sequencesByProject = {},
  generatedAt,
} = {}) {
  const summaries = {};
  for (const [projectId, obligation] of Object.entries(obligationsByProject)) {
    const documents = documentsByProject[projectId] || [];
    const sequence = sequencesByProject[projectId] || null;
    let summary = buildLandFilingEvidenceSummary({ obligation, documents, sequence, materializedAt: generatedAt });
    const matchedDocumentRef = obligation.fulfillment?.document_refs?.[0];
    const rerEnvelope = matchedDocumentRef ? rerEnvelopesByDocument[matchedDocumentRef] : null;
    if (rerEnvelope) summary = withLandFilingEvidenceReport(summary, { obligation, documents, rerEnvelope });
    summaries[projectId] = summary;
  }
  return {
    schema: LAND_FILING_EVIDENCE_SUMMARY_SCHEMA,
    generated_at: generatedAt,
    summaries,
  };
}

function parseArgs(argv) {
  const out = { check: false };
  for (const arg of argv.slice(2)) {
    if (arg === "--check") out.check = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

function main() {
  const { check } = parseArgs(process.argv);
  // No committed LDP-22..26 corpus exists yet in this repo -- see the module
  // docstring. `generated_at` stays fixed so the empty payload is stable to
  // diff rather than drifting on every run.
  const payload = buildLandFilingEvidenceSummaryLookup({ generatedAt: "2026-09-05T00:00:00.000Z" });
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  const outPath = path.join(ROOT, PAYLOAD_JSON);
  if (check) {
    const current = readFileSync(outPath, "utf8");
    if (current !== serialized) {
      console.error(`${PAYLOAD_JSON} is stale`);
      process.exit(1);
    }
    console.log("Land filing-evidence summary is current");
    return;
  }
  writeFileSync(outPath, serialized);
  console.log(`wrote ${PAYLOAD_JSON}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
