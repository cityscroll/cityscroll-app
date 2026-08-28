#!/usr/bin/env node
/*
 * Build the bounded Tier-2 rule-document projection.
 *
 * Characterization is an input to this collector, not a report written after
 * the fact. A live crawler must provide the same source contract before it is
 * allowed to replace the fixture input.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRuleVersionsProjection } from "../site/rule_versions.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(ROOT, "test/fixtures/rule_versions/source_sample.json");
const TEXT_FIXTURE = join(ROOT, "test/fixtures/rule_attachment_text.json");
const OUTPUT = join(ROOT, "site/data/rule_versions.json");
const RECEIPT = join(ROOT, "warehouse/receipts/proof/rule_versions_latest.json");

function args(argv) {
  return { check: argv.includes("--check"), fixture: argv.includes("--from-fixture") };
}

function loadFixture() {
  const fixture = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const textById = JSON.parse(readFileSync(TEXT_FIXTURE, "utf8"));
  const documents = fixture.documents.map((document) => ({
    ...document,
    text: textById[document.text_fixture] || null,
  }));
  return { fixture, documents };
}

function materialize() {
  const { fixture, documents } = loadFixture();
  if (!fixture.collector_started_after_characterization) {
    throw new Error("rule-version collector requires completed source characterization");
  }
  const projections = buildRuleVersionsProjection(documents, { rulemaking_id: "rulemaking:dsny:commercial-waste-zones" });
  const observedCitations = projections.versions.flatMap((version) => version.authority.map((item) => item.ref.replace(/^legal-code:/, "")));
  const expectedCitations = documents.flatMap((document) => document.expected_citation_keys || []);
  const expectedCitationSet = new Set(expectedCitations);
  const matchedCitations = observedCitations.filter((citation) => expectedCitationSet.has(citation)).length;
  const checks = {
    characterization: {
      sample_count: fixture.observations.length,
      agencies: [...new Set(fixture.observations.map((row) => row.agency))].sort(),
      lifecycle_stages: [...new Set(fixture.observations.map((row) => row.lifecycle_stage))].sort(),
      required_fields_present: fixture.observations.every((row) => [
        "rule_page_id", "document_placement", "link_stability", "authority_location",
        "citation_extractability", "proposed_adopted_pairability", "source_url",
      ].every((field) => Object.prototype.hasOwnProperty.call(row, field))),
    },
    rule_documents: {
      proposed_documents: projections.coverage.proposed_documents,
      adopted_documents: projections.coverage.adopted_documents,
      paired_versions: projections.coverage.paired_versions,
      acquisition_failures: projections.coverage.acquisition_failures,
    },
    legal_citations: {
      exact_citation_count: projections.coverage.exact_citations,
      exact_citation_precision: {
        numerator: matchedCitations,
        denominator: observedCitations.length,
        value: observedCitations.length ? matchedCitations / observedCitations.length : null,
        basis: "source_sample_expected_citation_keys",
      },
      resolvable_targets: projections.coverage.resolvable_targets,
      ambiguous_references: projections.coverage.ambiguous_references,
    },
    version_pairing: {
      proposed_adopted_pairs: projections.pairs.length,
      source_id_pairing_evidence: projections.pairs.map((pair) => pair.basis),
      unpairable_or_non_text_cases: documents.filter((document) => !document.text || !document.pairing_key).length,
    },
    version_diff: projections.coverage.version_diff,
  };
  return {
    schema: "cityscroll.rule_versions_materialization.v1",
    schema_version: 1,
    generated_at: "2026-08-28T00:00:00Z",
    source_contract: {
      tier: 2,
      source: "NYC Rules detail pages and linked City Record documents",
      characterization_completed: fixture.characterization_completed_at,
      collector_started_after_characterization: fixture.collector_started_after_characterization,
      observations: fixture.observations,
    },
    documents,
    projections: [projections],
    checks,
  };
}

function receipt(materialization) {
  return {
    schema: "cityscroll.rule_versions_receipt.v1",
    generated_at: materialization.generated_at,
    source_contract: materialization.source_contract,
    checks: materialization.checks,
  };
}

const options = args(process.argv.slice(2));
if (!options.fixture && !options.check) throw new Error("use --from-fixture or --check");
if (!existsSync(FIXTURE)) throw new Error(`missing ${FIXTURE}`);
const materialization = materialize();
if (options.check) {
  const current = JSON.parse(readFileSync(OUTPUT, "utf8"));
  if (JSON.stringify(current) !== JSON.stringify(materialization)) throw new Error("rule versions materialization is stale; run node tools/build_rule_versions.mjs --from-fixture");
  const currentReceipt = JSON.parse(readFileSync(RECEIPT, "utf8"));
  if (JSON.stringify(currentReceipt) !== JSON.stringify(receipt(materialization))) throw new Error("rule versions receipt is stale; rebuild materialization");
  console.log("rule versions materialization is current");
} else {
  writeFileSync(OUTPUT, `${JSON.stringify(materialization, null, 2)}\n`);
  writeFileSync(RECEIPT, `${JSON.stringify(receipt(materialization), null, 2)}\n`);
  console.log(`wrote ${OUTPUT} and ${RECEIPT}`);
}
