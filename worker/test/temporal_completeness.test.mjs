/**
 * Characterization: temporal completeness scorecard.
 * Named metric: temporal_completeness_rate
 *
 * verify:
 *   node --test worker/test/temporal_completeness.test.mjs
 *   node worker/scripts/temporal-completeness-scorecard.mjs --fixtures worker/test/fixtures/civic-time --check
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  SPINE_SOURCE_CONTRACTS,
  TEMPORAL_CLOCK_FAMILIES,
  classifyTemporalGap,
  contractIdFromSourceRecordRef,
  eventClockPresence,
  eventTemporalCompleteness,
  mapFixtureDoc,
  moneySpineAdapterCoverage,
  sourceHealthFromContracts,
  temporalCompletenessScorecard,
} from "../src/lib/civic_time.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURE_DIR = join(ROOT, "worker/test/fixtures/civic-time");
const CONTRACTS_PATH = join(ROOT, "site/data/source_contracts.json");

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function loadAllFixtureEvents() {
  const names = [
    "money_award.json",
    "rules_comment_open.json",
    "land_zap_milestone.json",
    "meetings_council.json",
  ];
  const events = [];
  for (const name of names) {
    events.push(...mapFixtureDoc(loadJson(join(FIXTURE_DIR, name))));
  }
  return events;
}

test("eventClockPresence treats valid range as event clock", () => {
  assert.deepEqual(
    eventClockPresence({
      valid_at: null,
      valid_from: "2024-01-01",
      valid_to: "2024-12-31",
      published_at: null,
      observed_at: "2024-01-02T00:00:00.000Z",
      processed_at: null,
    }),
    { event: true, publication: false, observed: true, processed: false },
  );
  assert.equal(eventTemporalCompleteness({
    valid_at: "2024-01-01",
    published_at: "2024-01-02",
    observed_at: "2024-01-03",
    processed_at: "2024-01-04",
  }), 1);
  assert.equal(eventTemporalCompleteness({}), 0);
});

test("contractIdFromSourceRecordRef maps known prefixes", () => {
  assert.equal(contractIdFromSourceRecordRef("city-record:20240723114"), "city-record");
  assert.equal(contractIdFromSourceRecordRef("legistar:Events/22526"), "nyc-council-legistar");
  assert.equal(contractIdFromSourceRecordRef("zap-api:milestone:x"), "zap-api-outcomes");
  assert.equal(contractIdFromSourceRecordRef("nyc-rules:guid:x"), "nyc-rules-rss");
  assert.equal(contractIdFromSourceRecordRef(null), null);
});

test("classifyTemporalGap distinguishes adapter vs source health", () => {
  const live = [{ id: "city-record", status: "live", health: "live" }];
  const disabled = [
    { id: "a", status: "disabled", health: "disabled" },
    { id: "b", status: "disabled", health: "disabled" },
  ];
  const unhealthy = [{ id: "city-record", status: "live", fetch_status: "error", health: "unhealthy" }];

  assert.equal(classifyTemporalGap({ fill_rate: 1, source_rows: live }), null);
  assert.equal(classifyTemporalGap({ fill_rate: 0.5, source_rows: live }).kind, "adapter_gap");
  assert.equal(classifyTemporalGap({ fill_rate: 0.5, source_rows: disabled }).kind, "source_disabled");
  assert.equal(classifyTemporalGap({ fill_rate: 0.5, source_rows: unhealthy }).kind, "source_unhealthy");
  assert.equal(classifyTemporalGap({ fill_rate: 0.5, source_rows: [] }).kind, "source_unknown");
});

test("temporal_completeness_rate on civic-time fixtures is measurable and > 0", () => {
  const events = loadAllFixtureEvents();
  assert.ok(events.length >= 8, `expected multi-spine fixtures, got ${events.length}`);

  const contracts = loadJson(CONTRACTS_PATH).contracts;
  const source_health = sourceHealthFromContracts(contracts);
  // Spine contracts used by the scorecard must resolve from the live registry.
  for (const spine of Object.keys(SPINE_SOURCE_CONTRACTS)) {
    for (const id of SPINE_SOURCE_CONTRACTS[spine]) {
      assert.ok(
        source_health[id] || contracts.some((c) => c.id === id),
        `missing source contract ${id} for spine ${spine}`,
      );
    }
  }

  const scorecard = temporalCompletenessScorecard(events, { source_health });

  assert.equal(scorecard.metric, "temporal_completeness_rate");
  assert.equal(scorecard.event_count, events.length);
  assert.ok(
    scorecard.temporal_completeness_rate > 0,
    `temporal_completeness_rate must be >0, got ${scorecard.temporal_completeness_rate}`,
  );
  // Fixtures are well-labeled; expect strong coverage (not necessarily 1.0 — publication-only
  // and valid-only events are honest nulls for the other clock).
  assert.ok(
    scorecard.temporal_completeness_rate >= 0.7,
    `fixture temporal_completeness_rate expected ≥0.7, got ${scorecard.temporal_completeness_rate}`,
  );

  for (const clock of TEMPORAL_CLOCK_FAMILIES) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(scorecard.clock_fill_rates, clock),
      `missing overall rate for ${clock}`,
    );
    assert.ok(scorecard.clock_fill_rates[clock] >= 0);
    assert.ok(scorecard.clock_fill_rates[clock] <= 1);
  }

  for (const spine of ["money", "rules", "land", "meetings"]) {
    assert.ok(scorecard.spines[spine], `missing spine ${spine}`);
    assert.ok(scorecard.spines[spine].event_count >= 1);
    assert.ok(Array.isArray(scorecard.spines[spine].source_health));
    assert.ok(scorecard.spines[spine].source_health.length >= 1);
    // Observed + processed are stamped on every fixture assertion.
    assert.equal(scorecard.spines[spine].clock_fill_rates.observed, 1);
    assert.equal(scorecard.spines[spine].clock_fill_rates.processed, 1);
  }

  // Money fixture intentionally omits valid on notice_published and publication on award_registered.
  assert.ok(scorecard.spines.money.clock_fill_rates.event < 1);
  assert.ok(scorecard.spines.money.clock_fill_rates.publication < 1);

  // Gaps must be actionable and join source health.
  assert.ok(scorecard.gap_count >= 1, "honest clock nulls should surface as gaps");
  for (const gap of scorecard.gaps) {
    assert.ok(TEMPORAL_CLOCK_FAMILIES.includes(gap.clock));
    assert.ok(gap.fill_rate < 1);
    assert.ok(gap.kind, "gap needs a classification kind");
    assert.ok(gap.action, "gap needs an action string");
    assert.ok(Array.isArray(gap.source_health));
  }
  // Live city-record / checkbook → money publication gap is adapter debt, not source-disabled.
  const moneyPub = scorecard.gaps.find((g) => g.spine === "money" && g.clock === "publication");
  assert.ok(moneyPub, "money publication gap expected from fixture");
  assert.equal(moneyPub.kind, "adapter_gap");
});

test("empty event list yields zero temporal_completeness_rate without throwing", () => {
  const empty = temporalCompletenessScorecard([]);
  assert.equal(empty.event_count, 0);
  assert.equal(empty.temporal_completeness_rate, 0);
  assert.equal(empty.full_clock_rate, 0);
  assert.equal(empty.gap_count, 0);
});

test("source_disabled classification when all spine contracts are disabled", () => {
  const events = mapFixtureDoc(loadJson(join(FIXTURE_DIR, "money_award.json")));
  const disabledHealth = Object.fromEntries(
    SPINE_SOURCE_CONTRACTS.money.map((id) => [id, { id, status: "disabled" }]),
  );
  const scorecard = temporalCompletenessScorecard(events, { source_health: disabledHealth });
  const gaps = scorecard.gaps.filter((g) => g.spine === "money");
  assert.ok(gaps.length >= 1);
  assert.ok(gaps.every((g) => g.kind === "source_disabled"));
});

test("scorecard coexists with money_spine_adapter_coverage (orthogonal metrics)", () => {
  // Adapter coverage answers "did we emit ≥1 event?"; temporal completeness answers
  // "do emitted events carry the four clocks?". Both must stay defined.
  const events = mapFixtureDoc(loadJson(join(FIXTURE_DIR, "money_award.json")));
  const scorecard = temporalCompletenessScorecard(events);
  assert.ok(scorecard.temporal_completeness_rate > 0);
  // moneySpineAdapterCoverage needs lifecycle pairs — empty input stays 0 without throwing.
  const adapter = moneySpineAdapterCoverage([]);
  assert.equal(adapter.coverage, 0);
});
