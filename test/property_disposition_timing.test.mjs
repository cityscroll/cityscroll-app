import { SITE_SOURCE } from "./helpers/site_source.mjs";
/**
 * Characterization: property civic-time registration + disposition-timing ECDFs.
 *
 * verify:
 *   node --test test/property_disposition_timing.test.mjs \
 *     worker/test/civic_time_contract.test.mjs \
 *     test/property_disposition_spine.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  buildPropertyDispositionSpine,
  groupDispositionSpines,
} from "../worker/src/lib/property_disposition_spine.mjs";
import {
  PROPERTY_DISPOSITION_METHOD,
  PROPERTY_DISPOSITION_TARGET_KIND,
  attachDispositionTimingEstimate as attachWorkerEstimate,
  buildAuctionSchedulePairs,
  buildDispositionLagModel,
  buildDispositionTimingBacktest,
  buildMultiStageHearingAuctionPairs,
  buildPropertyDispositionTimingReport,
  dispositionTimingPatternLine,
  empiricalQuantile,
} from "../worker/src/lib/property_disposition_timing.mjs";
import {
  attachDispositionTimingEstimate,
} from "../site/property_disposition_timing.mjs";
import { buildPropertyPhaseView } from "../site/property_phase_spine.mjs";
import { isRegisteredEventKind } from "../worker/src/lib/civic_time.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const history = JSON.parse(
  readFileSync(join(ROOT, "site/data/property_sources/property_disposition_history.json"), "utf8"),
);
const model = JSON.parse(
  readFileSync(join(ROOT, "site/data/property_disposition_timing_model.json"), "utf8"),
);
const multiFixture = JSON.parse(
  readFileSync(join(ROOT, "test/fixtures/property_disposition/multi_notice_bbl.json"), "utf8"),
);
const indexHtml = SITE_SOURCE;
const aboutHtml = readFileSync(join(ROOT, "site/about.html"), "utf8");
const i18n = readFileSync(join(ROOT, "site/i18n.js"), "utf8");

test("property disposition event kinds are registered (fail-closed vocabulary)", () => {
  assert.equal(isRegisteredEventKind("property.disposition_hearing"), true);
  assert.equal(isRegisteredEventKind("property.auction_or_rfp"), true);
  assert.equal(isRegisteredEventKind("property.award_or_conveyance"), true);
  // Sibling tax-lien domain must not collide with disposition kinds.
  assert.equal(isRegisteredEventKind("property.lien_sale"), false);
  assert.equal(isRegisteredEventKind("property.tax_lien_90_day"), false);
});

test("mapPropertyDispositionSpineToCivic emits envelopes from disposition spine fixtures", async () => {
  const spine = buildPropertyDispositionSpine(multiFixture.notices);
  assert.ok(spine.events.length >= 1);
  const { mapPropertyDispositionSpineToCivic, isRegisteredEventKind: reg } = await import(
    "../worker/src/lib/civic_time.mjs"
  );
  const civic = mapPropertyDispositionSpineToCivic(spine, {
    run_id: "test-property-disposition",
    processed_at: "2026-08-03T12:00:00Z",
  });
  assert.ok(civic.length >= 1);
  for (const ev of civic) {
    assert.equal(reg(ev.event_kind), true);
    assert.match(ev.event_kind, /^property\./);
    assert.match(ev.event_id, /^cte:[a-f0-9]{24}$/);
    assert.ok(Object.prototype.hasOwnProperty.call(ev, "valid_at"));
    assert.ok(Object.prototype.hasOwnProperty.call(ev, "published_at"));
  }
  assert.ok(
    civic.some((ev) =>
      ["property.disposition_hearing", "property.auction_or_rfp", "property.award_or_conveyance"]
        .includes(ev.event_kind)
    ),
  );
});

test("history fixture is the small Property Disposition corpus", () => {
  assert.equal(history.count, history.notices.length);
  assert.ok(history.notices.length >= 200 && history.notices.length <= 300);
  assert.ok(history.notices.every((n) => n.section_name === "Property Disposition"));
});

test("multi-stage hearing→auction pairs are rare; schedule cohort is the honest fuel", () => {
  const spines = groupDispositionSpines(history.notices);
  const multi = buildMultiStageHearingAuctionPairs(spines);
  const schedule = buildAuctionSchedulePairs(history.notices);
  assert.equal(multi.length, 0, "parcel-joined hearing→auction should be empty on this corpus");
  assert.ok(schedule.length >= 20, `schedule pairs=${schedule.length}`);
  assert.ok(schedule.every((p) => p.lag_days >= 0 && p.lag_days <= 365));
});

test("citywide ECDF quantiles are ordered and agency n stays below floor", () => {
  const schedule = buildAuctionSchedulePairs(history.notices);
  const lagModel = buildDispositionLagModel(schedule);
  assert.equal(lagModel.floor, 20);
  assert.ok(lagModel.cohorts.citywide.n >= 20);
  assert.ok(lagModel.cohorts.citywide.p10_days <= lagModel.cohorts.citywide.p50_days);
  assert.ok(lagModel.cohorts.citywide.p50_days <= lagModel.cohorts.citywide.p90_days);
  const agencyKeys = Object.keys(lagModel.cohorts).filter((k) => k.startsWith("agency:"));
  for (const key of agencyKeys) {
    assert.equal(lagModel.cohorts[key].eligible, lagModel.cohorts[key].n >= 20);
  }
  // Nearest-rank sanity
  assert.equal(empiricalQuantile([1, 2, 3, 4, 5], 0.5), 3);
});

test("backtest through the scorecard fails the ship bar and withholds per-matter dates", () => {
  const spines = groupDispositionSpines(history.notices);
  const multi = buildMultiStageHearingAuctionPairs(spines);
  const result = buildDispositionTimingBacktest(multi);
  assert.equal(result.scorecard.ship_bar.status, "fail");
  assert.equal(result.scorecard.public_projection, "cohort_statistic_only");
  assert.equal(result.scorecard.ship_bar.checks.minimum_resolved, false);
  assert.equal(model.public_projection, "cohort_statistic_only");
  assert.deepEqual(model.predictions, []);
  assert.equal(model.method, PROPERTY_DISPOSITION_METHOD);
  assert.equal(model.target_event_kind, PROPERTY_DISPOSITION_TARGET_KIND);
});

test("committed model report matches rebuild from history", () => {
  const rebuilt = buildPropertyDispositionTimingReport(history.notices, {
    generatedAt: model.generated_at,
  });
  assert.equal(rebuilt.corpus.primary_pair_kind, model.corpus.primary_pair_kind);
  assert.equal(rebuilt.citywide.n, model.citywide.n);
  assert.equal(rebuilt.citywide.p50_days, model.citywide.p50_days);
  assert.equal(rebuilt.public_projection, "cohort_statistic_only");
});

test("pattern line uses weeks and citywide cohort attribution", () => {
  const line = dispositionTimingPatternLine(model.citywide, {
    pairKind: model.corpus.primary_pair_kind,
  });
  assert.match(line, /^A published sale date typically falls \d+–\d+ weeks after the auction notice/);
  assert.match(line, /\d+ past Property Disposition notices since 2013/);
});

test("phase view attaches cohort estimate when hearing matched and auction empty", () => {
  // Synthetic hearing-only spine
  const spine = {
    schema_version: 1,
    subject_ref: "disposition:test:bbl:1000010001",
    join: { matched: true, method: "exact_bbl", keys: ["bbl:1000010001"], notice_count: 1 },
    stages: [
      {
        kind: "hearing",
        matched: true,
        notice_count: 1,
        request_ids: ["20240101001"],
        events: [{
          request_id: "20240101001",
          title: "Public hearing",
          time: { value: "2024-02-01", basis: "event_date", certainty: "planned" },
          source: { id: "city-record", url: "https://example.test/1" },
        }],
      },
      { kind: "auction_or_rfp", matched: false, notice_count: 0, request_ids: [], events: [] },
      { kind: "award_or_conveyance", matched: false, notice_count: 0, request_ids: [], events: [] },
    ],
    events: [],
    gaps: [],
  };
  const phaseView = buildPropertyPhaseView(spine);
  const withEstimate = attachDispositionTimingEstimate(phaseView, model);
  assert.ok(withEstimate.disposition_timing_estimate);
  assert.equal(withEstimate.disposition_timing_estimate.public_projection, "cohort_statistic_only");
  assert.equal(withEstimate.disposition_timing_estimate.predicted_window, null);
  assert.match(withEstimate.disposition_timing_estimate.pattern_line, /^A published sale date/);

  // Auction already matched → no estimate (scheduled date owns urgency)
  const full = {
    ...spine,
    stages: spine.stages.map((s) => s.kind === "auction_or_rfp"
      ? {
          ...s,
          matched: true,
          notice_count: 1,
          request_ids: ["20240301001"],
          events: [{
            request_id: "20240301001",
            title: "Public auction",
            time: { value: "2024-03-15", basis: "event_date" },
            source: { id: "city-record", url: "https://example.test/2" },
          }],
        }
      : s),
  };
  const noEstimate = attachDispositionTimingEstimate(buildPropertyPhaseView(full), model);
  assert.equal(noEstimate.disposition_timing_estimate, undefined);

  // Worker attach helper matches
  const workerAttached = attachWorkerEstimate(phaseView, model);
  assert.ok(workerAttached.disposition_timing_estimate?.pattern_line);
});

test("product surface wires estimate chrome, formula, and cohort copy keys", () => {
  assert.match(indexHtml, /data-property-disposition-timing="1"/);
  assert.match(indexHtml, /data-prediction-subject="property-sale-timing"/);
  assert.match(indexHtml, /disposition_timing_estimate/);
  assert.match(indexHtml, /property-disposition-timing-formula/);
  assert.match(i18n, /disposition_timing_estimate_html/);
  assert.match(aboutHtml, /id="property-disposition-timing-formula"/);
  assert.match(aboutHtml, /phase_duration_ecdf|phase-duration|auction notices/i);
});
