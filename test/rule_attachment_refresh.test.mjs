import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildRulesObservationRows } from "../tools/build_rules_meetings_domain_observations.mjs";
import { densifyRulesFromAttachmentText } from "../tools/densify_rule_evidence_attachments.mjs";
import { buildAgencyConformanceView } from "../site/process_conformance.mjs";

const raw = {
  request_id: "20260605008",
  agency_name: "Sanitation",
  short_title: "DSNY Final Rule re Implementation Dates for the Brooklyn North and Upper Manhattan Commercial Waste Zones",
  start_date: "2026-06-11T00:00:00.000",
  type_of_notice_description: "Notice",
  section_name: "Agency Rules",
};
const textById = JSON.parse(readFileSync(new URL("./fixtures/rule_attachment_text.json", import.meta.url)));
const { doc: enriched } = densifyRulesFromAttachmentText({
  retrieved_at: "2026-08-11T00:00:00.000Z",
  rows: buildRulesObservationRows([raw]),
}, textById);
enriched.rule_evidence_attachment_densified_at = "2026-08-11T01:00:00.000Z";
const mandate = {
  obligation_id: "64116-001",
  agency_id: "sanitation",
  duty_text: "Regulate the conduct of businesses authorized to collect commercial waste in commercial waste zones and establish and enforce specified standards and requirements.",
  deliverable_type: "rulemaking",
  citation: "New York City Charter § 753(e)(2)",
};
function observation(rows) {
  return buildAgencyConformanceView("sanitation", {
    obligationsLookup: { by_agency: { sanitation: { obligations: [mandate] } } },
    rulesDomain: { rows },
    asOf: "2026-09-09",
  }).items[0].observation;
}

test("metadata-only refresh keeps attachment-backed mandate evidence and its original vintage", () => {
  assert.equal(observation(buildRulesObservationRows([raw])).status, "evidence_only");
  const refreshed = buildRulesObservationRows([{ ...raw, email: "rules@example.org", phone: "212-555-0100" }], enriched);
  assert.equal(observation(refreshed).status, "observed");
  assert.equal(observation(refreshed).observed_record.request_id, raw.request_id);
  assert.deepEqual(refreshed[0].rule_evidence, enriched.rows[0].rule_evidence);
  assert.equal(refreshed[0].rule_evidence_densify.retained_from_snapshot, enriched.retrieved_at);
  const again = buildRulesObservationRows([raw], { retrieved_at: "2026-09-09T00:00:00.000Z", rows: refreshed });
  assert.deepEqual(again, refreshed, "later metadata reads do not relabel the evidence as newly extracted");
  assert.equal(JSON.stringify(refreshed).includes(textById[raw.request_id]), false);
});

test("refresh never borrows attachment evidence across changed or ambiguous notice identities", () => {
  for (const field of ["request_id", "agency_name", "short_title", "start_date", "type_of_notice_description", "section_name"]) {
    const changed = { ...raw, [field]: `${raw[field]} changed` };
    const next = buildRulesObservationRows([changed], enriched);
    assert.equal(next[0].rule_evidence_densify, undefined, field);
  }
  for (const field of ["source_links", "document_links"]) {
    const changed = { ...raw, [field]: ["https://example.org/replaced-document.pdf"] };
    assert.equal(buildRulesObservationRows([changed], enriched)[0].rule_evidence_densify, undefined, field);
  }
  const duplicate = { ...enriched, rows: [enriched.rows[0], enriched.rows[0]] };
  assert.equal(buildRulesObservationRows([raw], duplicate)[0].rule_evidence_densify, undefined);
  assert.deepEqual(buildRulesObservationRows([], enriched), [], "records outside the new publisher window stay outside it");
});

test("new publisher prose and adverse evidence take precedence over retained attachments", () => {
  const changed = { ...raw, additional_description_1: "This rule has been withdrawn." };
  const next = buildRulesObservationRows([changed], enriched);
  assert.equal(next[0].rule_evidence_densify, undefined);
  assert.ok(next[0].rule_evidence.negative_evidence.length > 0);
  assert.notEqual(observation(next).status, "observed");
  assert.equal(next[0].additional_description_1, undefined, "source prose remains uncommitted");
});

test("only marked attachment evidence with a known snapshot vintage is retained", () => {
  for (const previous of [
    { ...enriched, rows: [{ ...enriched.rows[0], rule_evidence_densify: undefined }] },
    { ...enriched, rows: [{ ...enriched.rows[0], rule_evidence_densify: { method: "unknown", source: "attachment_text" } }] },
    { ...enriched, retrieved_at: undefined },
  ]) {
    assert.equal(observation(buildRulesObservationRows([raw], previous)).status, "evidence_only");
  }
});
