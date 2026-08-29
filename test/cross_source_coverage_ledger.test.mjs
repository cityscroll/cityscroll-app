import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildCrossSourceCoverageLedger,
  measuredCoverageFromInventory,
  renderCrossSourceCoverageLedger,
} from "../site/cross_source_coverage_ledger.mjs";
import { renderMeetingDocument } from "../site/meeting_document.mjs";
import { renderProcurementDocument } from "../site/procurement_document.mjs";
import { buildSharedProcurementReadModel } from "../site/shared_procurement_read_model.mjs";
import { buildSharedMeetingReadModel } from "../site/shared_meeting_read_model.mjs";

const sourceCoverage = JSON.parse(readFileSync(new URL("../entity_resolution/source_coverage.json", import.meta.url)));
const aboResidual = JSON.parse(readFileSync(new URL("../site/data/abo_award_residual_lookup.json", import.meta.url)));

function observation(sourceSystem, sourceSystemId, snapshot = {}, ingestedAt = "2026-08-18T19:46:32Z") {
  return {
    source_system: sourceSystem,
    source_system_id: sourceSystemId,
    source_observation_ref: `${sourceSystem}:${sourceSystemId}`,
    ingested_at: ingestedAt,
    snapshot,
    normalized_snapshot: JSON.stringify(snapshot),
    raw_snapshot: JSON.stringify(snapshot),
    content_hash: `${sourceSystemId}-hash`,
  };
}

function stateBySource(ledger) {
  return Object.fromEntries(ledger.sources.map((row) => [row.source_system, row.state]));
}

const passport = observation("passport_public_contracts", "contract:EPIN-1:CTR-1", {
  contract_id: "CT-1",
  epin: "EPIN-1",
  title: "Bridge inspection",
});
const checkbook = observation("checkbook_contracts", "registered:CT-1", {
  id: "CT-1",
  pin: "EPIN-1",
  title: "Bridge inspection",
});

test("positive procurement object names every declared source and keeps corroborated lookups exact", () => {
  const model = buildSharedProcurementReadModel({
    sourceRecords: [passport, checkbook],
    generatedAt: "2026-08-18T20:00:00Z",
  });
  const object = model.rows[0];
  const ledger = buildCrossSourceCoverageLedger({
    object,
    observations: model.observations,
    sourceStatus: model.sources,
    sourceCoverage,
    aboResidual,
    kind: "procurement",
  });

  assert.equal(ledger.schema, "cityscroll.cross_source_coverage_ledger.v1");
  assert.deepEqual(ledger.sources.map((row) => row.source_system), [
    "city_record",
    "passport_public_contracts",
    "passport_public_rfx",
    "checkbook_contracts",
    "checkbook_spending",
    "nys_abo_awards",
  ]);
  const bySource = stateBySource(ledger);
  assert.equal(bySource.passport_public_contracts, "corroborated");
  assert.equal(bySource.checkbook_contracts, "corroborated");
  assert.equal(bySource.city_record, "not-checked");
  assert.equal(bySource.nys_abo_awards, "not-checked");
  assert.equal(ledger.sources.find((row) => row.source_system === "nys_abo_awards").stopped, true);
  assert.equal(ledger.measured_coverage.population, "identity-bearing importer streams");
  assert.equal(ledger.measured_coverage.vintage, "2026-08-02");
  assert.equal(ledger.measured_coverage.total, 19);
  assert.equal(ledger.measured_coverage.partial, true);

  const html = renderProcurementDocument(object, model.observations, {
    sourceStatus: model.sources,
  });
  assert.match(html, /data-cross-source-coverage-ledger="1"/);
  assert.match(html, /13 of 19 identity-bearing importer streams/);
  assert.match(html, /PASSPort Public contracts/);
  assert.match(html, /Recorded in this source/);
  assert.doesNotMatch(html, /does not exist/);
  assert.match(html, /Importer coverage:/);
  assert.doesNotMatch(html, /How this timeline works|methodology/i);
});

test("checked-no-match stays a snapshot miss and carries vintage plus denominator", () => {
  const object = {
    procurement_id: "procurement:contract:CT-MISS",
    source_observation_refs: [passport.source_observation_ref],
    identity_keys: { contract_ids: ["CTMISS"], epins: ["PINMISS"] },
  };
  const ledger = buildCrossSourceCoverageLedger({
    object,
    observations: [passport],
    sourceStatus: { city_record: { status: "available", generated_at: "2026-08-18T20:00:00Z" } },
    sourceCoverage: null,
    aboResidual: { bridge: { status: "stopped_below_threshold", total: 50 } },
    lookups: {
      city_record: {
        state: "checked-no-match",
        as_of: "2026-08-18T20:00:00Z",
        basis: "exact_pin",
        denominator: 1516,
        vintage: "2026-08-18",
        population: "City Record award notices in this snapshot",
      },
    },
  });
  const city = ledger.sources.find((row) => row.source_system === "city_record");
  assert.equal(city.state, "checked-no-match");
  assert.equal(city.denominator, 1516);
  assert.equal(city.vintage, "2026-08-18");
  assert.match(city.population, /City Record award notices/);
  const html = renderCrossSourceCoverageLedger(ledger);
  assert.match(html, /No exact match in this lookup/);
  assert.match(html, /1516 in City Record award notices in this snapshot/);
  assert.match(html, /snapshot miss/);
  assert.doesNotMatch(html, /does not exist/);
});

test("unavailable, stale, not-checked, and ambiguous stay visibly unresolved", () => {
  const object = {
    procurement_id: "procurement:contract:CT-UNRESOLVED",
    source_observation_refs: [passport.source_observation_ref],
    identity_keys: { contract_ids: ["CT1"], epins: ["EPIN1"] },
    checkbook_corroboration: { status: "needs_review", join_method: "pin_family" },
  };
  const ledger = buildCrossSourceCoverageLedger({
    object,
    observations: [passport],
    sourceStatus: {
      checkbook_spending: { status: "unavailable", reason: "upstream_error" },
      passport_public_rfx: { status: "stale", generated_at: "2026-07-01T00:00:00Z" },
    },
    sourceCoverage: null,
    aboResidual: { observed_at: "2026-08-04T11:26:00Z", bridge: { status: "stopped_below_threshold", total: 50 } },
    lookups: { city_record: { state: "not-checked" } },
  });
  const bySource = stateBySource(ledger);
  assert.equal(bySource.passport_public_contracts, "corroborated");
  assert.equal(bySource.checkbook_contracts, "ambiguous");
  assert.equal(bySource.checkbook_spending, "unavailable");
  assert.equal(bySource.passport_public_rfx, "stale");
  assert.equal(bySource.city_record, "not-checked");
  assert.equal(bySource.nys_abo_awards, "not-checked");
  assert.ok(ledger.sources.filter((row) => row.unresolved).length >= 4);
  const html = renderCrossSourceCoverageLedger(ledger);
  assert.match(html, /data-coverage-state="ambiguous"/);
  assert.match(html, /data-coverage-state="unavailable"/);
  assert.match(html, /data-coverage-state="stale"/);
  assert.match(html, /data-unresolved="1"/);
  assert.doesNotMatch(html, /does not exist/);
});

test("stopped ABO lookup never becomes checked-no-match", () => {
  const ledger = buildCrossSourceCoverageLedger({
    object: { procurement_id: "procurement:contract:CT-ABO", source_observation_refs: [passport.source_observation_ref] },
    observations: [passport],
    sourceCoverage: null,
    aboResidual,
  });
  const abo = ledger.sources.find((row) => row.source_system === "nys_abo_awards");
  assert.equal(aboResidual.bridge.status, "stopped_below_threshold");
  assert.equal(abo.state, "not-checked");
  assert.equal(abo.stopped, true);
  assert.notEqual(abo.state, "checked-no-match");
});

test("missing denominators or vintage never publish a rate", () => {
  assert.equal(measuredCoverageFromInventory({ measurement: { after: { covered: 13 } } }), null);
  assert.equal(measuredCoverageFromInventory({
    measurement: { after: { covered: 13, total: 19 }, unit: "streams" },
  }), null);
  const ledger = buildCrossSourceCoverageLedger({
    object: { procurement_id: "procurement:contract:CT-1", source_observation_refs: [passport.source_observation_ref] },
    observations: [passport],
    sourceCoverage: { measurement: { after: { covered: 13, total: 19 }, unit: "streams" } },
    aboResidual: { bridge: { status: "stopped_below_threshold" } },
  });
  assert.equal(ledger.measured_coverage, null);
  assert.doesNotMatch(renderCrossSourceCoverageLedger(ledger), /data-coverage-scope/);
});

test("AP-06 registered-contract coverage stays a separate named scope, not citywide", () => {
  const ledger = buildCrossSourceCoverageLedger({
    object: { procurement_id: "procurement:contract:CT-1", source_observation_refs: [checkbook.source_observation_ref] },
    observations: [checkbook],
    sourceCoverage,
    aboResidual: { bridge: { status: "stopped_below_threshold" } },
    registeredContractCoverage: {
      exact: 3413,
      none: 1724,
      cannot_evaluate_missing_pin: 7245,
      denominator: 12382,
      vintage: "2026-08-26",
      population: "registered Checkbook expense contracts of $100,000 and over",
    },
  });
  assert.equal(ledger.measured_coverage.scope, "source_coverage");
  assert.equal(ledger.analytical_scopes.ap06_registered_contracts.scope, "ap06_registered_contracts");
  assert.equal(ledger.analytical_scopes.ap06_registered_contracts.cannot_evaluate_missing_pin, 7245);
  assert.equal(ledger.analytical_scopes.ap06_registered_contracts.citywide, false);
  const html = renderCrossSourceCoverageLedger(ledger);
  assert.doesNotMatch(html, /3413 of 12382/);
  assert.doesNotMatch(html, /cannot_evaluate_missing_pin/);
  assert.match(html, /Importer coverage:/);
  assert.doesNotMatch(html, /citywide publication rate/);
});

test("bounded Checkbook/PASSPort crosswalk unmatched rows are checked-no-match, not absence", () => {
  const ledger = buildCrossSourceCoverageLedger({
    object: {
      procurement_id: "procurement:contract:CT-X",
      source_observation_refs: [checkbook.source_observation_ref],
      identity_keys: { contract_ids: ["CTA184120277200151"], epins: ["84120P8912KXLR001"] },
    },
    observations: [checkbook],
    sourceCoverage: null,
    aboResidual: { bridge: { status: "stopped_below_threshold" } },
    crosswalk: {
      observed_on: "2026-08-18",
      metrics: {
        checkbook_contracts: 2000,
        denominator: "materialized Checkbook Contracts rows with contract_id or PIN",
      },
      rows: [{
        status: "unmatched",
        join_method: "pin_epin_exact",
        checkbook_contract_id: "CTA184120277200151",
        passport_epin: "84120P8912KXLR001",
      }],
    },
  });
  assert.equal(stateBySource(ledger).passport_public_contracts, "checked-no-match");
  const passportRow = ledger.sources.find((row) => row.source_system === "passport_public_contracts");
  assert.equal(passportRow.denominator, 2000);
  assert.equal(passportRow.vintage, "2026-08-18");
});

test("meeting documents expose both declared sources, including stale and unavailable envelopes", () => {
  const city = {
    meeting_id: "meeting:city_record:20260814001",
    source_system: "city_record",
    title: "Public hearing",
    event_date: "2026-08-20",
    request_id: "20260814001",
    join_status: "not_applicable",
    source_record_id: "20260814001",
  };
  const unavailable = buildCrossSourceCoverageLedger({
    object: city,
    observations: [city],
    sourceStatus: {
      city_record: { status: "available", generated_at: "2026-08-14T12:00:00Z" },
      community_board: { status: "unavailable", reason: "snapshot_missing" },
    },
    sourceCoverage: null,
    kind: "meeting",
  });
  assert.equal(stateBySource(unavailable).city_record, "corroborated");
  assert.equal(stateBySource(unavailable).community_board, "unavailable");

  const staleModel = buildSharedMeetingReadModel({
    cityRecordRows: [{
      request_id: "20260814001",
      agency_name: "Buildings",
      short_title: "Public hearing on facade safety",
      event_date: "2026-08-20T10:00:00.000",
      source_system: "city_record",
    }],
    communityBoardIndex: {
      generated_at: "2026-08-01T12:00:00Z",
      rows: [{
        source_system: "community_board",
        board_id: "M01",
        publisher_identifier: "evt-1",
        title: "Board meeting",
        event_date: "2026-08-20",
        source_url: "https://example.test/cb",
      }],
    },
    generatedAt: "2026-08-14T12:00:00Z",
    now: "2026-08-14T12:00:00Z",
  });
  const cityRow = staleModel.rows.find((row) => row.source_system === "city_record");
  const stale = buildCrossSourceCoverageLedger({
    object: cityRow,
    observations: [cityRow],
    sourceStatus: staleModel.sources,
    sourceCoverage: null,
    kind: "meeting",
  });
  assert.equal(staleModel.sources.community_board.status, "stale");
  assert.equal(stateBySource(stale).city_record, "corroborated");
  assert.equal(stateBySource(stale).community_board, "stale");
  const html = renderMeetingDocument(cityRow, staleModel);
  assert.match(html, /data-cross-source-coverage-ledger="1"/);
  assert.match(html, /data-coverage-state="stale"/);
  assert.match(html, /Community board calendar/);
});

test("NYCHA-native objects keep the ledger on Checkbook NYCHA and off City Record", () => {
  const nycha = observation("checkbook_nycha_contracts", "contract:BA2335819:Agreement", {
    contract_id: "BA2335819",
    vendor: "VITAL PLUMBING INC",
  });
  const ledger = buildCrossSourceCoverageLedger({
    object: {
      procurement_id: "procurement:contract:BA2335819",
      source_observation_refs: [nycha.source_observation_ref],
    },
    observations: [nycha],
    sourceCoverage: null,
    aboResidual: { bridge: { status: "stopped_below_threshold" } },
  });
  assert.deepEqual(ledger.sources.map((row) => row.source_system), ["checkbook_nycha_contracts"]);
  assert.equal(stateBySource(ledger).checkbook_nycha_contracts, "corroborated");
  assert.doesNotMatch(renderCrossSourceCoverageLedger(ledger), /City Record/);
});

test("ledger HTML stays compact across the required fixture set and is 390px-safe", () => {
  const html = renderCrossSourceCoverageLedger(buildCrossSourceCoverageLedger({
    object: { procurement_id: "procurement:contract:CT-1", source_observation_refs: [passport.source_observation_ref] },
    observations: [passport],
    sourceStatus: { checkbook_spending: { status: "unavailable" } },
    sourceCoverage,
    lookups: { city_record: { state: "checked-no-match", denominator: 10, vintage: "2026-08-18", population: "award notices" } },
  }));
  assert.ok(html.length < 4000);
  assert.match(html, /Source coverage/);
  assert.equal((html.match(/<h2/g) || []).length, 1);
  assert.doesNotMatch(html, /always-on|incompleteness banner|full-page/i);
});
