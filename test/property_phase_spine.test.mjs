/**
 * Property disposition phase presentation (compact stepper + current/next).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  PROPERTY_DISPOSITION_PHASES,
  aggregatePhaseEvents,
  buildPropertyPhaseView,
  dedupePhaseSourceLinks,
  dispositionStageToPhase,
} from "../site/property_phase_spine.mjs";
import {
  buildPropertyDispositionSpine,
  groupDispositionSpines,
} from "../worker/src/lib/property_disposition_spine.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(
  readFileSync(join(ROOT, "test/fixtures/property_disposition/multi_notice_bbl.json"), "utf8"),
);

test("PROPERTY_DISPOSITION_PHASES matches process stage order", () => {
  assert.deepEqual([...PROPERTY_DISPOSITION_PHASES], [
    "hearing",
    "auction_or_rfp",
    "award_or_conveyance",
  ]);
  assert.equal(dispositionStageToPhase("hearing"), "hearing");
  assert.equal(dispositionStageToPhase("nope"), null);
});

test("buildPropertyPhaseView marks current as last matched and next as first unmatched after", () => {
  const spines = groupDispositionSpines(fixture.notices);
  assert.ok(spines.length >= 1);
  // Prefer a multi-notice spine when present
  const multi = spines.find((s) => (s.join?.notice_count || 0) > 1) || spines[0];
  const view = buildPropertyPhaseView(multi);
  assert.ok(view);
  assert.equal(view.phases.length, 3);
  assert.ok(view.current);
  assert.ok(view.action?.action_key);
  // Current is a matched phase when any stage matched
  if (view.metrics.matched_count > 0) {
    assert.equal(view.current.matched, true);
  }
});

test("buildPropertyPhaseView aggregates and dedupes source URLs per phase", () => {
  const spines = groupDispositionSpines(fixture.notices);
  const multi = spines.find((s) => (s.join?.notice_count || 0) > 1) || spines[0];
  const view = buildPropertyPhaseView(multi);
  const matched = view.phases.filter((p) => p.matched);
  assert.ok(matched.length >= 1);
  for (const p of matched) {
    assert.ok(Array.isArray(p.aggregates));
    assert.ok("source_url" in p);
  }
  const events = [
    { title: "PUBLIC HEARING", request_id: "1", time: { value: "2020-01-01" }, source: { url: "https://example.test/a" } },
    { title: "PUBLIC HEARING", request_id: "2", time: { value: "2020-02-01" }, source: { url: "https://example.test/a" } },
  ];
  assert.equal(aggregatePhaseEvents(events).length, 1);
  assert.equal(aggregatePhaseEvents(events)[0].count, 2);
  assert.equal(dedupePhaseSourceLinks(events).count, 1);
});

test("singleton award spine still produces phase view with action lead", () => {
  const spine = buildPropertyDispositionSpine([
    {
      request_id: "20241112003",
      start_date: "2024-11-12",
      agency_name: "Citywide Administrative Services",
      type_of_notice_description: "Notice",
      section_name: "Property Disposition",
      short_title: "Notice of tentative winning bidders",
      additional_description_1: "The property has been sold for $275,000. Borough of Manhattan Block 644 Lot 1.",
      property_location: {
        scope: "local",
        boroughs: ["Manhattan"],
        bbls: ["1006440001"],
        tax_lots: [{ block: "644", lots: ["1"] }],
      },
    },
  ]);
  const view = buildPropertyPhaseView(spine);
  assert.equal(view.current.id, "award_or_conveyance");
  assert.equal(view.action.action_key, "disposition_phase_action_conveyance");
  assert.equal(view.phases.find((p) => p.id === "hearing").matched, false);
});
