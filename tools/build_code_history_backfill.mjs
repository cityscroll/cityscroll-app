#!/usr/bin/env node

/**
 * Build the prioritized historical-backfill batch for the Administrative Code.
 *
 * Every ranking input is measured from material already retained in this
 * repository: the publisher's current corpus snapshot, the amendment notes that
 * snapshot carries, and the mandate joins already materialized from law source
 * documents. The builder acquires nothing, so a source that is not retained
 * here is recorded as an unavailable input rather than estimated.
 *
 * Usage:
 *   node tools/build_code_history_backfill.mjs           # write the read model
 *   node tools/build_code_history_backfill.mjs --check    # fail on drift
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  historicalCodeChanges,
  historicalConflicts,
  historicalObservations,
  parseHistoryNote,
  provisionBackfillCoverage,
  rankBackfillCandidates,
  selectBackfillBatch,
  BACKFILL_RANKING_WEIGHTS,
} from "../site/code_history_backfill.mjs";
import {
  joinMandateToProvisions,
  mandateRowsFromLookup,
} from "../site/statutory_mandate_provision_join.mjs";
import { lookupAdminCodeCitation } from "../site/admin_code.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CORPUS_DIR = path.join(ROOT, "site/data/legal_code");
const OUTPUT = path.join(ROOT, "site/data/code_history_backfill.json");
const EVIDENCE = path.join(ROOT, "docs/evidence/law-ledger-historical-backfill/ranking.json");

export const BACKFILL_READ_MODEL_SCHEMA = "cityscroll.code_history_backfill.v1";
export const BATCH_ID = "batch-1";
export const BATCH_LIMIT = 24;
export const BATCH_MINIMUM_SCORE = 60;
export const RANKING_EVIDENCE_TOP = 100;

/**
 * The official materials a later acquisition pass would read. None is fetched
 * here: this card ranks and bounds the work, and records what acquiring each
 * source would still require.
 */
export const BATCH_SOURCES = Object.freeze([
  {
    id: "american-legal-publishing-current-snapshot",
    name: "American Legal Publishing, current Administrative Code snapshot",
    url: "https://codelibrary.amlegal.com/codes/newyorkcity/latest/NYCadmin/0-0-0-1",
    role: "publisher amendment notes and current text, already retained",
    acquisition_status: "retained",
    acquisition_note: "Retained by the current-code builder; supplies the recorded change spine for this batch.",
  },
  {
    id: "nyc-council-legislation-local-law-texts",
    name: "New York City Council legislation records, enacted Local Law texts",
    url: "https://legistar.council.nyc.gov/Legislation.aspx",
    role: "enacted Local Law text and effective-date clauses for each recorded change",
    acquisition_status: "not_acquired",
    acquisition_note: "Per-law document retrieval and matter identity resolution are outside this card.",
  },
  {
    id: "nys-legislature-chapter-laws",
    name: "New York State Legislature, chapter laws",
    url: "https://www.nysenate.gov/legislation",
    role: "state chapter laws that the publisher records as amending Administrative Code sections",
    acquisition_status: "not_acquired",
    acquisition_note: "State chapter laws keep their own instrument identity and are never recorded as Local Laws.",
  },
  {
    id: "american-legal-publishing-superseded-editions",
    name: "American Legal Publishing, superseded Administrative Code editions",
    url: "https://codelibrary.amlegal.com/codes/newyorkcity/latest/NYCadmin/0-0-0-1",
    role: "historical provision text for a retained change interval",
    acquisition_status: "not_acquired",
    acquisition_note: "No superseded edition is published at a stable public address that this repository already retains.",
  },
]);

/** Ranking inputs whose source is not materialized in this repository. */
export const UNAVAILABLE_INPUTS = Object.freeze([
  {
    input: "authority_citation_count",
    weight: BACKFILL_RANKING_WEIGHTS.authority_citation,
    status: "not_materialized",
    reason: "Agency rulemaking authority citations are served from the rules read model rather than retained in this repository.",
    effect: "Every candidate scores zero for this input, so it moves no candidate above another in this batch.",
  },
]);

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function citationKey(value) {
  return String(value ?? "").replace(/^§\s*/, "").toLowerCase();
}

/**
 * Count how many other provisions cite each section. Self-references do not
 * count, and a citing provision counts once no matter how often it repeats a
 * citation.
 */
function measureInboundReferences(rows) {
  const known = new Set(rows.map((row) => citationKey(row.citation)));
  const counts = new Map();
  const pattern = /(?:§+\s*|\bsections?\s+)(\d+[A-Za-z]?-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)/gi;
  for (const row of rows) {
    const self = citationKey(row.citation);
    const seen = new Set();
    for (const match of String(row.current_text ?? "").matchAll(pattern)) {
      const cited = citationKey(match[1]);
      if (cited === self || !known.has(cited)) continue;
      seen.add(cited);
    }
    for (const cited of seen) counts.set(cited, (counts.get(cited) || 0) + 1);
  }
  return counts;
}

/** Count accepted mandate-provision joins per provision. */
function measureMandateJoins() {
  const lookupPath = path.join(ROOT, "site/data/agency_obligations_lookup.json");
  const counts = new Map();
  let mandates = [];
  try {
    mandates = mandateRowsFromLookup(readJson(lookupPath));
  } catch (_error) {
    return counts;
  }
  for (const mandate of mandates) {
    const join = joinMandateToProvisions(mandate, { lookupProvision: lookupAdminCodeCitation });
    for (const edge of join.edges || []) {
      if (edge.status !== "accepted" || !edge.provision_id) continue;
      counts.set(edge.provision_id, (counts.get(edge.provision_id) || 0) + 1);
    }
  }
  return counts;
}

function loadCorpus() {
  const manifest = readJson(path.join(CORPUS_DIR, "manifest.json"));
  const rows = [];
  const recordsByCitation = new Map();
  for (const shard of manifest.shards) {
    const payload = readJson(path.join(CORPUS_DIR, shard.path));
    for (const row of payload.rows || []) {
      rows.push(row);
      const key = citationKey(row.citation);
      if (!recordsByCitation.has(key)) recordsByCitation.set(key, []);
      recordsByCitation.get(key).push(`${shard.path}#${row.source?.source_ref || row.id}`);
    }
  }
  return { manifest, rows, recordsByCitation };
}

export function buildBackfill() {
  const { manifest, rows, recordsByCitation } = loadCorpus();
  const observedAt = manifest.source.observed_at;
  const inbound = measureInboundReferences(rows);
  const mandateJoins = measureMandateJoins();

  const byId = new Map();
  const candidates = [];
  const corpusConflicts = [];
  for (const row of rows) {
    if (byId.has(row.id)) continue;
    const note = parseHistoryNote(row.current_text || "");
    const observations = historicalObservations(row, { note });
    const retained = observations.filter((item) => item.status === "retained");
    const duplicateRecords = (recordsByCitation.get(citationKey(row.citation)) || []).length > 1
      ? [{ provision_id: row.id, records: recordsByCitation.get(citationKey(row.citation)) }]
      : [];
    const conflicts = historicalConflicts(observations, { duplicate_records: duplicateRecords });
    corpusConflicts.push(...conflicts);
    byId.set(row.id, { row, note, observations, conflicts });
    candidates.push({
      provision_id: row.id,
      citation: row.citation,
      heading: row.heading,
      inbound_reference_count: inbound.get(citationKey(row.citation)) || 0,
      retained_change_count: retained.length,
      distinct_instrument_count: new Set(retained.map((item) => item.instrument_ref)).size,
      mandate_join_count: mandateJoins.get(row.id) || 0,
      authority_citation_count: 0,
      conflict_count: conflicts.length,
    });
  }

  const ranking = rankBackfillCandidates(candidates);
  const batch = selectBackfillBatch(ranking, {
    batch_id: BATCH_ID,
    limit: BATCH_LIMIT,
    minimum_score: BATCH_MINIMUM_SCORE,
    sources: BATCH_SOURCES,
  });

  const coverage = [];
  const changesByProvision = {};
  const selectedIds = new Set(batch.selected.map((selection) => selection.provision_id));
  for (const selection of batch.selected) {
    const entry = byId.get(selection.provision_id);
    if (!entry) continue;
    const changes = historicalCodeChanges(entry.observations, { provision: entry.row });
    changesByProvision[selection.provision_id] = changes;
    coverage.push(provisionBackfillCoverage({
      provision: entry.row,
      observations: entry.observations,
      changes,
      versions: [],
      conflicts: entry.conflicts,
      batch_id: batch.batch_id,
      rank: selection.rank,
      observed_at: observedAt,
    }));
  }

  const readModel = {
    schema: BACKFILL_READ_MODEL_SCHEMA,
    corpus: manifest.corpus,
    source: {
      system: manifest.source.system,
      landing_url: manifest.source.landing_url,
      observed_at: observedAt,
      content_hash: manifest.source.content_hash,
      publisher_current_through: manifest.source.publisher_current_through,
    },
    measurement: {
      provision_count: rows.length,
      provisions_with_history_note: candidates.filter((candidate) => candidate.retained_change_count > 0).length,
      cited_provision_count: [...inbound.values()].filter(Boolean).length,
      mandate_joined_provision_count: mandateJoins.size,
      ranking_candidate_count: ranking.candidate_count,
      ranking_fingerprint: sha256(JSON.stringify(ranking.candidates)),
    },
    unavailable_inputs: UNAVAILABLE_INPUTS,
    batch,
    coverage,
    changes: changesByProvision,
    conflicts: {
      in_batch: coverage.flatMap((row) => row.conflicts),
      corpus_summary: {
        total: corpusConflicts.length,
        duplicate_publisher_record: corpusConflicts.filter((row) => row.kind === "duplicate_publisher_record").length,
        effective_date_disagreement: corpusConflicts.filter((row) => row.kind === "effective_date_disagreement").length,
        resolution: "every conflicting observation is retained; no source is promoted over another",
      },
      outside_batch_examples: corpusConflicts
        .filter((row) => !selectedIds.has(row.provision_id))
        .slice(0, 5),
    },
  };
  const fingerprint = sha256(`${JSON.stringify(readModel, null, 2)}\n`);
  const published = { ...readModel, fingerprint };
  return { readModel: published, serialized: `${JSON.stringify(published, null, 2)}\n`, ranking };
}

function coverageSummary(readModel) {
  const rows = readModel.coverage;
  const localLaws = new Set();
  const stateLaws = new Set();
  for (const row of rows) {
    for (const ref of row.local_law_refs) localLaws.add(ref);
    for (const ref of row.state_law_refs) stateLaws.add(ref);
  }
  return {
    selected_sections: rows.length,
    retained_changes: rows.reduce((total, row) => total + row.retained_change_count, 0),
    unresolved_note_entries: rows.reduce((total, row) => total + row.unresolved_observation_count, 0),
    distinct_local_laws: localLaws.size,
    distinct_state_chapter_laws: stateLaws.size,
    coverage_intervals: rows.reduce((total, row) => total + row.intervals.length, 0),
    unknown_intervals: rows.reduce((total, row) => total + row.unknown_intervals.length, 0),
    materialized_versions: rows.reduce((total, row) => total + row.materialization.materialized, 0),
    unresolved_materializations: rows.reduce((total, row) => total + row.materialization.unresolved, 0),
    sections_with_no_open_period: rows.filter((row) => row.unknown_intervals.length === 0).length,
  };
}

function rankingEvidence(ranking, readModel) {
  return `${JSON.stringify({
    schema: "cityscroll.code_history_backfill_ranking_evidence.v1",
    source: readModel.source,
    weights: ranking.weights,
    tie_break: ranking.tie_break,
    candidate_count: ranking.candidate_count,
    measurement: readModel.measurement,
    unavailable_inputs: readModel.unavailable_inputs,
    read_model_fingerprint: readModel.fingerprint,
    ranking_fingerprint: readModel.measurement.ranking_fingerprint,
    eligibility: readModel.batch.eligibility,
    cutoff: readModel.batch.cutoff,
    sources: readModel.batch.sources,
    coverage_summary: coverageSummary(readModel),
    conflicts: readModel.conflicts.corpus_summary,
    top: ranking.candidates.slice(0, RANKING_EVIDENCE_TOP),
  }, null, 2)}\n`;
}

function main() {
  const check = process.argv.includes("--check");
  const { serialized, ranking, readModel } = buildBackfill();
  const evidence = rankingEvidence(ranking, readModel);
  if (!check) {
    writeFileSync(OUTPUT, serialized);
    writeFileSync(EVIDENCE, evidence);
    console.log(`wrote ${path.relative(ROOT, OUTPUT)} (${readModel.batch.selected_count} sections)`);
    console.log(`wrote ${path.relative(ROOT, EVIDENCE)} (top ${RANKING_EVIDENCE_TOP} candidates)`);
    return;
  }
  const failures = [];
  for (const [file, expected] of [[OUTPUT, serialized], [EVIDENCE, evidence]]) {
    let actual = null;
    try {
      actual = readFileSync(file, "utf8");
    } catch (_error) {
      failures.push(`${path.relative(ROOT, file)} is missing`);
      continue;
    }
    if (actual !== expected) failures.push(`${path.relative(ROOT, file)} is stale`);
  }
  if (failures.length) {
    console.error("code history backfill check failed:");
    for (const failure of failures) console.error(`  ${failure}`);
    console.error("run: node tools/build_code_history_backfill.mjs");
    process.exitCode = 1;
    return;
  }
  console.log("code history backfill read model and ranking evidence are current");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
