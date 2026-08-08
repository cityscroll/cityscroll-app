import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const ROOT = new URL("../", import.meta.url);
const rendererFiles = [
  "site/app/procurement-phase.mjs",
  "site/app/procurement-lifecycle.mjs",
  "site/app/money-history.mjs",
  "site/app/rules.mjs",
  "site/app/land.mjs",
  "site/app/property.mjs",
  "site/app/subsidy.mjs",
  "site/app/workspace.mjs",
];

const removedKeys = [
  "lifecycle_no_pin_note_html",
  "lifecycle_unmatched_registered_html",
  "lifecycle_documents_not_published_html",
  "lifecycle_phase_empty",
  "lifecycle_unknown_html",
  "lifecycle_payment_unavailable_html",
  "lifecycle_dollars_paid_unavailable_html",
  "external_award_none_note_html",
  "external_award_nycha_none_note_html",
  "rule_event_not_published_html",
  "rule_event_not_yet_ingested_html",
  "rule_event_join_gap_html",
  "rule_phase_empty",
  "land_outcomes_unmatched_html",
  "land_outcomes_unmatched_default",
  "notice_land_no_match_html",
  "notice_land_no_match_with_keys_html",
  "notice_land_unavailable_html",
  "project_connections_gap_applicant",
  "project_connections_gap_parcels",
  "project_connections_gap_meetings",
  "project_connections_gap_decisions",
  "project_connections_gap_notices",
  "project_connections_gap_mih",
  "project_connections_gap_source",
  "project_connections_gap_bounded",
  "franchise_stage_not_yet_ingested_html",
  "franchise_spine_unavailable_html",
  "disposition_spine_unavailable_html",
  "property_xd_no_bbl_html",
  "property_xd_not_in_corpus_html",
  "subsidy_outcome_unknown_html",
  "subsidy_stage_unmatched_html",
  "subsidy_stage_not_published_html",
  "subsidy_source_unavailable_html",
  "subsidy_unmatched_html",
  "subsidy_unmatched_default_reason",
  "subsidy_company_unknown_html",
  "subsidy_place_unknown_html",
  "subsidy_money_unknown_html",
  "subsidy_company_not_yet_ingested_html",
  "subsidy_place_not_yet_ingested_html",
  "subsidy_money_not_yet_ingested_html",
  "subsidy_feed_unavailable_html",
  "subsidy_phase_empty",
  "subsidy_phase_not_yet_reached_html",
  "subsidy_phase_show_future_gaps",
  "subsidy_phase_show_fields",
  "subsidy_stage_too_soon_html",
  "subsidy_join_too_soon_html",
];

function read(path) {
  return readFileSync(new URL(path, ROOT), "utf8");
}

test("notice detail renderers omit unpopulated domain slots", () => {
  const source = rendererFiles.map(read).join("\n");
  for (const key of removedKeys) {
    assert.doesNotMatch(source, new RegExp(`t\\([\\"']${key}[\\"']`), key);
  }

  assert.match(read("site/app/rules.mjs"), /if\(!event\)\s*return "";/);
  assert.match(read("site/app/procurement-lifecycle.mjs"), /if\(docsStatus!=="matched"\)\s*return "";/);
  assert.match(read("site/app/land.mjs"), /if\(!itemRows&&!docs\)\s*return "";/);
  assert.match(read("site/app/property.mjs"), /if\(!view\?\.ok\)\s*return "";/);
  assert.match(read("site/app/subsidy.mjs"), /if\(!entry\|\|entry\.status!=="matched"\)\s*return "";/);
});

test("removed notice absence slots have no locale catalog entries", () => {
  const catalogs = [
    "site/i18n.js",
    ...readdirSync(new URL("site/i18n/lang/", ROOT))
      .filter((name) => name.endsWith(".js"))
      .map((name) => `site/i18n/lang/${name}`),
  ];
  for (const catalog of catalogs) {
    const source = read(catalog);
    for (const key of removedKeys) {
      assert.doesNotMatch(source, new RegExp(`^\\s*${key}:`, "m"), `${catalog}: ${key}`);
    }
  }
});
