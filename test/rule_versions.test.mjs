import { test } from "node:test";
import assert from "node:assert/strict";
import materialization from "../site/data/rule_versions.json" with { type: "json" };
import {
  buildRuleVersionsProjection,
  normalizeRuleVersionDocument,
} from "../site/rule_versions.mjs";
import { buildRuleVersionDiff } from "../site/rule_version_diff.mjs";
import { buildRulemakingObjects } from "../worker/src/lib/rulemaking.mjs";
import { renderRulemakingDocument } from "../site/rulemaking_document.mjs";

const RULEMAKING = "rulemaking:dot:bicycle-racks";

const proposed = {
  source_id: "nyc_rules:dot:bicycle-racks:proposed",
  source_url: "https://rules.cityofnewyork.us/rule/city-owned-bicycle-racks/",
  source_label: "DOT proposed rule document",
  version_kind: "proposed",
  pairing_key: "dot-bicycle-racks",
  published_at: "2026-03-25",
  text: "Authority: pursuant to Section 2903(a) of the New York City Charter. The proposed rule amends 34 RCNY § 4-12(p) and adds 34 RCNY § 4-12(q).",
};

const adopted = {
  source_id: "nyc_rules:dot:bicycle-racks:adopted",
  source_url: "https://rules.cityofnewyork.us/rule/city-owned-bicycle-racks/",
  source_label: "DOT adopted rule document",
  version_kind: "adopted",
  pairing_key: "dot-bicycle-racks",
  published_at: "2026-07-14",
  effective_date: "2026-08-13",
  text: "Authority: pursuant to Section 2903(a) of the New York City Charter. The adopted rule amends 34 RCNY § 4-12(p) and adds 34 RCNY § 4-12(q).",
};

test("rule version projection keeps source text, effective dates, exact effects, and pairing evidence", () => {
  const projection = buildRuleVersionsProjection([proposed, adopted], {
    rulemaking_id: RULEMAKING,
    title: "City-Owned Bicycle Racks",
  });
  assert.equal(projection.versions.length, 2);
  assert.equal(projection.versions[1].effective_date, "2026-08-13");
  assert.equal(projection.versions[1].effective_date_basis, "source_stated");
  assert.deepEqual(projection.pairs, [{
    proposed: projection.versions[0].id,
    adopted: projection.versions[1].id,
    basis: "shared_source_pairing_key",
  }]);
  assert.ok(projection.legal_effects.some((effect) => effect.kind === "amends" && effect.target.citation === "34:4-12(p)"));
  assert.ok(projection.legal_effects.some((effect) => effect.kind === "adds" && effect.target.citation === "34:4-12(q)"));
  assert.ok(projection.versions.every((version) => version.authority.some((item) => item.basis === "source_stated")));
});

test("ambiguous effect prose is held instead of becoming a legal-code edge", () => {
  const version = normalizeRuleVersionDocument({
    source_id: "city_record:held",
    version_kind: "proposed",
    source_url: "https://a856-cityrecord.nyc.gov/RequestDetail/20260728026",
    text: "The agency amends its rules regarding inspections. No exact code section is stated.",
  }, { rulemaking_id: RULEMAKING });
  assert.equal(version.legal_effects.length, 0);
  assert.equal(version.held_references.length, 1);
  assert.equal(version.held_references[0].status, "held_ambiguous");
});

test("rulemaking page renders version text and date provenance", () => {
  const rows = [
    {
      request_id: "20260317026",
      agency: "DOT",
      title: "DOT Proposed Rules Relating to City-Owned Bicycle Racks",
      notice_date: "2026-03-25",
      stage: "proposed",
      rulemaking_subject_ref: RULEMAKING,
      rulemaking_join: { matched: true, confidence: "high", notice_count: 2 },
      nyc_rules: { url: proposed.source_url, title: "City-Owned Bicycle Racks" },
      rule_version_documents: [proposed],
    },
    {
      request_id: "20260706041",
      agency: "DOT",
      title: "Notice of Adoption: City-Owned Bicycle Racks",
      notice_date: "2026-07-14",
      stage: "adopted",
      rulemaking_subject_ref: RULEMAKING,
      rulemaking_join: { matched: true, confidence: "high", notice_count: 2 },
      rule_version_documents: [adopted],
    },
  ];
  const [object] = buildRulemakingObjects(rows, { now: "2026-08-20" });
  const html = renderRulemakingDocument(object, { now: "2026-08-20" });
  assert.match(html, /What this changes/);
  assert.match(html, /Proposed version/);
  assert.match(html, /Adopted version/);
  assert.match(html, /August 13, 2026/);
  assert.match(html, /Read retained text/);
  assert.match(html, /34 RCNY/);
  assert.match(html, /data-legal-effect-count="4"/);
  assert.match(html, /data-diff-state="available"/);
  assert.match(html, /data-changed-region-count="1"/);
  assert.match(html, /Changed region/);
  assert.match(html, /Proposed source/);
  assert.match(html, /href="#rule-version-proposed-nyc-rules-dot-bicycle-racks-proposed"/);
  assert.match(html, /href="#rule-version-adopted-nyc-rules-dot-bicycle-racks-adopted"/);
});

test("diff retains exact changed spans and deterministic alignment", () => {
  const left = normalizeRuleVersionDocument({
    source_id: "left",
    version_kind: "proposed",
    source_url: "https://rules.cityofnewyork.us/rule/left/",
    text: "Definitions. The agency may issue permits. Records are public.",
  }, { rulemaking_id: RULEMAKING });
  const right = normalizeRuleVersionDocument({
    source_id: "right",
    version_kind: "adopted",
    source_url: "https://rules.cityofnewyork.us/rule/right/",
    text: "Definitions. The agency shall issue permits. Records are public.",
  }, { rulemaking_id: RULEMAKING });
  const diff = buildRuleVersionDiff(left, right, { basis: "shared_source_pairing_key" });
  assert.equal(diff.status, "available");
  assert.equal(diff.alignment.deterministic, true);
  assert.equal(diff.changed_region_count, 1);
  assert.equal(diff.regions[0].proposed_span.text, "may");
  assert.equal(diff.regions[0].adopted_span.text, "shall");
  assert.equal(diff.regions[0].proposed_span.source_url, left.source_url);
  assert.equal(diff.regions[0].adopted_span.source_url, right.source_url);
});

test("non-text and ambiguous or unpaired versions stay explicitly unavailable", () => {
  const scanned = normalizeRuleVersionDocument({
    source_id: "scanned",
    version_kind: "proposed",
    text_status: "scanned",
  }, { rulemaking_id: RULEMAKING });
  const adopted = normalizeRuleVersionDocument({
    source_id: "adopted",
    version_kind: "adopted",
    text: "A final rule.",
  }, { rulemaking_id: RULEMAKING });
  assert.equal(buildRuleVersionDiff(scanned, adopted).reason_code, "non_text_proposed");

  const projection = buildRuleVersionsProjection([
    { source_id: "p1", version_kind: "proposed", pairing_key: "ambiguous", text: "Same." },
    { source_id: "p2", version_kind: "proposed", pairing_key: "ambiguous", text: "Same." },
    { source_id: "a1", version_kind: "adopted", pairing_key: "ambiguous", text: "Final." },
  ], { rulemaking_id: RULEMAKING });
  assert.equal(projection.diffs[0].status, "unavailable");
  assert.equal(projection.diffs[0].reason_code, "ambiguous_pairing");
  assert.equal(projection.coverage.ambiguous_pairings, 1);
  assert.equal(projection.coverage.version_diff.non_text_failures, 0);

  const unpaired = buildRuleVersionsProjection([
    { source_id: "only-proposed", version_kind: "proposed", text: "A proposal without a final." },
  ], { rulemaking_id: RULEMAKING });
  assert.equal(unpaired.diffs[0].status, "unavailable");
  assert.equal(unpaired.diffs[0].reason_code, "unpaired_versions");
});

test("comments and agency explanations are separate source observations", () => {
  const projection = buildRuleVersionsProjection([
    {
      source_id: "p-comments",
      version_kind: "proposed",
      pairing_key: "evidence",
      source_url: "https://rules.cityofnewyork.us/rule/evidence/",
      comment_count: 4,
      text: "A proposed rule.",
    },
    {
      source_id: "a-explanation",
      version_kind: "adopted",
      pairing_key: "evidence",
      source_url: "https://rules.cityofnewyork.us/rule/evidence/",
      agency_explanation: "The agency explains the adopted wording in its published response.",
      text: "An adopted rule. The agency explains the adopted wording in its published response.",
    },
  ], { rulemaking_id: RULEMAKING });
  assert.equal(projection.comment_observations.length, 1);
  assert.equal(projection.comment_observations[0].count, 4);
  assert.equal(projection.agency_explanations.length, 1);
  assert.equal(projection.coverage.version_diff.observed_comments, 1);
  assert.equal(projection.coverage.version_diff.published_agency_explanations, 1);
});

test("committed Tier-2 receipt keeps characterization and bridge metrics separate", () => {
  assert.equal(materialization.source_contract.collector_started_after_characterization, true);
  assert.equal(materialization.checks.characterization.required_fields_present, true);
  assert.deepEqual(materialization.checks.characterization.lifecycle_stages, ["adopted", "effective", "hearing", "proposed"]);
  assert.equal(materialization.checks.rule_documents.proposed_documents, 1);
  assert.equal(materialization.checks.rule_documents.adopted_documents, 1);
  assert.equal(materialization.checks.version_pairing.proposed_adopted_pairs, 1);
  assert.ok(Object.hasOwn(materialization.checks.legal_citations, "ambiguous_references"));
  assert.equal(materialization.checks.version_diff.usable_version_pairs, 1);
  assert.equal(materialization.checks.version_diff.text_extraction.available_versions, 2);
  assert.equal(materialization.checks.version_diff.section_alignment.rate, 1);
  assert.equal(materialization.checks.version_diff.non_text_failures, 0);
  assert.equal(materialization.checks.version_diff.observed_comments, 0);
  assert.equal(materialization.checks.version_diff.published_agency_explanations, 0);
});
