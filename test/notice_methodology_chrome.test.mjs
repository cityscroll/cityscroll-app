import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const NOTICE_DETAIL_RENDERERS = [
  "site/app/notice-context.mjs",
  "site/app/alerts.mjs",
  "site/app/procurement-phase.mjs",
  "site/app/subsidy.mjs",
  "site/app/rules.mjs",
  "site/app/meetings.mjs",
  "site/app/land.mjs",
  "site/app/property.mjs",
  "site/app/money-history.mjs",
  "site/property_commercial_ui.mjs",
  "site/sub_outreach.mjs",
  "site/subsidy_project_panel.mjs",
  "site/non_council_outcome_panel.mjs",
];

const METHODOLOGY_KEYS = [
  "context_how_computed_summary",
  "context_how_computed_body_html",
  "context_flags_summary",
  "context_flags_body_html",
  "lifecycle_provenance_note_html",
  "lifecycle_dollars_vendor_variant_html",
  "lifecycle_dollars_provenance_html",
  "mwbe_sol_persona_html",
  "mwbe_sol_provenance_html",
  "subsidy_provenance_note_html",
  "subsidy_phase_how_summary",
  "subsidy_project_how_summary",
  "subsidy_project_provenance",
  "non_council_outcome_how_summary",
  "non_council_outcome_provenance",
  "sub_outreach_how_summary",
  "sub_outreach_provenance_html",
  "rule_event_provenance_html",
  "rule_phase_how_summary",
  "rule_phase_how_html",
  "rule_phase_how_multi_html",
  "meeting_outcomes_provenance_html",
  "meeting_phase_how_summary",
  "meeting_phase_how_html",
  "land_spine_how_summary",
  "land_spine_how_html",
  "notice_land_join_matched_html",
  "notice_land_provenance_html",
  "join_evidence_summary",
  "join_evidence_html",
  "join_evidence_singleton_html",
  "disposition_provenance_html",
  "franchise_provenance_html",
  "property_commercial_provenance_html",
  "paper_trail_how_summary",
  "paper_trail_how_html",
  "external_award_nycha_note_html",
];

test("notice-detail renderers do not expose join or derivation methodology chrome", () => {
  const source = NOTICE_DETAIL_RENDERERS
    .map((file) => `${file}\n${readFileSync(file, "utf8")}`)
    .join("\n");

  for (const key of METHODOLOGY_KEYS) {
    assert.doesNotMatch(source, new RegExp(`t\\([\\"']${key}[\\"']`), key);
  }
  assert.doesNotMatch(source, /class=["'][^"']*join-evidence/, "join-evidence disclosure");
  assert.doesNotMatch(source, /data-notice-land-join=/, "always-on land join method line");
});
