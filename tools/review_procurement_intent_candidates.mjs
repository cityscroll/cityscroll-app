#!/usr/bin/env node

/** Small terminal review harness for the Phase 1 candidate artifact. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(new URL(".", import.meta.url).pathname, "..");
const input = process.argv[2] || join(ROOT, "warehouse/fixtures/procurement-intent-radar/candidate_review.v0.json");
const artifact = JSON.parse(readFileSync(input, "utf8"));

for (const row of artifact.rows) {
  const label = row.status === "candidate" ? row.assertion?.object_text : row.candidate.rejection_reasons.join(", ");
  console.log(`${row.status.toUpperCase().padEnd(8)} ${row.source.source_record_id} | ${row.source.observed_at} | ${label}`);
  console.log(`  ${row.source.source_span_text}`);
  if (row.assertion) console.log(`  agency=${row.assertion.responsible_agency_ref} speaker=${row.assertion.asserted_by_person_ref || "none"} window=${row.assertion.expected_window.raw_text || "unspecified"} modality=${row.assertion.modality}`);
}

console.log(`\ncoverage: retained council text=${artifact.coverage.retained_app_corpus.text_bearing_council_rows}; eligible review sources=${artifact.coverage.review_corpus.eligible_source_count}; candidates=${artifact.coverage.review_corpus.candidate_count}; rejected=${artifact.coverage.review_corpus.rejected_count}`);
