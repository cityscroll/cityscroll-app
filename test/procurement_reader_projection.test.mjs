import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildCrossSourceCoverageLedger,
  projectCoverageForReaders,
  renderCoverageClaimCaveats,
  renderCoverageReaderProjection,
  renderCrossSourceCoverageLedger,
} from "../site/cross_source_coverage_ledger.mjs";
import { renderProcurementDocument } from "../site/procurement_document.mjs";
import { buildSharedProcurementReadModel } from "../site/shared_procurement_read_model.mjs";

const sourceCoverage = JSON.parse(readFileSync(new URL("../entity_resolution/source_coverage.json", import.meta.url)));

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

const passport = observation("passport_public_contracts", "contract:EPIN-1:CTR-1", {
  contract_id: "CT-1",
  epin: "EPIN-1",
  title: "Bridge inspection",
  current_amount: "100000",
});
const checkbook = observation("checkbook_contracts", "registered:CT-1", {
  id: "CT-1",
  pin: "EPIN-1",
  title: "Bridge inspection",
  current_amount: "100000",
});

function closedSourcesText(html) {
  const match = html.match(/data-coverage-disclosure="1"[^>]*>[\s\S]*?<summary>[\s\S]*?<\/summary>([\s\S]*?)<\/details>/i);
  const closed = html.replace(match ? match[0] : "", "");
  return closed.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

test("reader projection keeps states and links while dropping diagnostic fields", () => {
  const ledger = buildCrossSourceCoverageLedger({
    object: {
      procurement_id: "procurement:contract:CT-READER",
      source_observation_refs: [passport.source_observation_ref],
      identity_keys: { contract_ids: ["CT1"], epins: ["EPIN1"] },
    },
    observations: [passport],
    sourceStatus: {
      checkbook_spending: { status: "unavailable", reason: "upstream_error" },
      passport_public_rfx: { status: "stale", generated_at: "2026-07-01T00:00:00Z" },
    },
    sourceCoverage,
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

  const projection = projectCoverageForReaders(ledger);
  assert.equal(projection.schema, "cityscroll.coverage_reader_projection.v1");
  assert.ok(projection.sources.some((row) => row.state === "corroborated"));
  assert.ok(projection.sources.some((row) => row.state === "checked-no-match"));
  assert.ok(projection.sources.some((row) => row.state === "unavailable"));
  assert.ok(projection.sources.some((row) => row.state === "stale"));
  assert.ok(projection.sources.some((row) => row.state === "not-checked"));
  assert.ok(projection.claim_caveats.some((row) => row.claim === "paid_amount" && row.state === "unavailable"));

  const city = projection.sources.find((row) => row.source_system === "city_record");
  assert.equal(city.observation_context, "Checked 2026-08-18");
  assert.equal(Object.hasOwn(city, "lookup_basis"), false);
  assert.equal(Object.hasOwn(city, "denominator"), false);
  assert.equal(Object.hasOwn(city, "population"), false);
  assert.equal(Object.hasOwn(projection, "measured_coverage"), false);

  const html = renderCoverageReaderProjection(projection);
  assert.match(html, /data-coverage-reader-projection="1"/);
  assert.match(html, />Sources</);
  assert.match(html, /data-coverage-state="checked-no-match"/);
  assert.match(html, /data-coverage-state="unavailable"/);
  assert.match(html, /data-coverage-state="stale"/);
  assert.match(html, /Checked 2026-08-18/);
  assert.doesNotMatch(html, /exact_pin|lookup:|Importer coverage:|1516 in City Record|identity-bearing importer streams/);
});

test("procurement document places facts and events before compact Sources", () => {
  const model = buildSharedProcurementReadModel({
    sourceRecords: [passport, checkbook],
    generatedAt: "2026-08-18T20:00:00Z",
  });
  const object = {
    ...model.rows[0],
    process_events: [{
      event_id: "evt-1",
      state: "award",
      effective_at: "2026-08-01T12:00:00Z",
      source_system: "passport_public_contracts",
    }],
  };
  const html = renderProcurementDocument(object, model.observations, {
    sourceStatus: {
      ...model.sources,
      checkbook_spending: { status: "unavailable" },
    },
    sourceCoverage,
  });

  const factsAt = html.indexOf(">Contract facts<");
  const eventsAt = html.indexOf(">Observed events<");
  const sourcesAt = html.indexOf("data-coverage-reader-projection=\"1\"");
  assert.ok(factsAt > 0);
  assert.ok(eventsAt > factsAt);
  assert.ok(sourcesAt > eventsAt);
  assert.match(html, /data-claim-caveat="paid_amount"/);
  assert.match(html, /data-coverage-disclosure="1"/);
  assert.doesNotMatch(html, /data-cross-source-coverage-ledger="1"/);

  const closed = closedSourcesText(html);
  assert.doesNotMatch(closed, /Importer coverage:|exact_pin|1516 in |identity-bearing importer streams|lookup:/);
  assert.match(html, /Inspect source details/);
  assert.match(html, /PASSPort Public contracts/);
  assert.match(html, /Recorded in this source|No exact match in this lookup|Source unavailable|Source snapshot is stale|Lookup not run/);
});

test("missing payment lookup never renders as zero paid", () => {
  const object = {
    procurement_id: "procurement:contract:CT-NOPAY",
    title: "Shelter services",
    source_observation_refs: [passport.source_observation_ref],
    identity_keys: { contract_ids: ["CTNOPAY"], epins: ["PINNOPAY"] },
    process_events: [],
  };
  const html = renderProcurementDocument(object, [passport], {
    sourceStatus: { checkbook_spending: { status: "unavailable" } },
    sourceCoverage: null,
    aboResidual: { bridge: { status: "stopped_below_threshold" } },
    lookups: {
      checkbook_spending: { state: "unavailable", as_of: "2026-08-18T20:00:00Z" },
    },
  });
  assert.match(html, /data-claim-caveat="paid_amount"/);
  assert.doesNotMatch(html, /<dt>Paid amount<\/dt><dd>\$0/);
  assert.doesNotMatch(html, /paid total of zero|Paid amount[\s\S]{0,40}\$0/);
});

test("checked-no-match payment caveat stays adjacent and does not imply a complete total", () => {
  const projection = projectCoverageForReaders(buildCrossSourceCoverageLedger({
    object: {
      procurement_id: "procurement:contract:CT-MISS-PAY",
      source_observation_refs: [passport.source_observation_ref],
    },
    observations: [passport],
    sourceCoverage: null,
    aboResidual: { bridge: { status: "stopped_below_threshold" } },
    lookups: {
      checkbook_spending: {
        state: "checked-no-match",
        as_of: "2026-08-18T20:00:00Z",
        basis: "exact_contract_id",
        denominator: 900,
        population: "Checkbook spending rows",
      },
    },
  }));
  const caveats = renderCoverageClaimCaveats(projection);
  assert.match(caveats, /data-claim-caveat="paid_amount"/);
  assert.match(caveats, /not a paid total of zero/);
  assert.doesNotMatch(caveats, /exact_contract_id|900 in Checkbook/);
});

test("operator ledger renderer still carries diagnostics when called directly", () => {
  const ledger = buildCrossSourceCoverageLedger({
    object: {
      procurement_id: "procurement:contract:CT-OPS",
      source_observation_refs: [passport.source_observation_ref],
    },
    observations: [passport],
    sourceCoverage,
    aboResidual: { bridge: { status: "stopped_below_threshold" } },
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
  const operatorHtml = renderCrossSourceCoverageLedger(ledger);
  assert.match(operatorHtml, /Importer coverage:/);
  assert.match(operatorHtml, /1516 in City Record award notices/);
  assert.match(operatorHtml, /lookup: exact_pin/);
});

test("real zero paid amounts remain visible when present", () => {
  const paid = observation("checkbook_spending", "payment:CT-ZERO", {
    contract_id: "CT-ZERO",
    amount: "0",
    check_amount: "0",
  });
  const model = buildSharedProcurementReadModel({
    sourceRecords: [
      observation("passport_public_contracts", "contract:EPIN-Z:CT-ZERO", {
        contract_id: "CT-ZERO",
        epin: "EPIN-Z",
        title: "Zero-pay pilot",
        current_amount: "0",
      }),
      paid,
    ],
    generatedAt: "2026-08-18T20:00:00Z",
  });
  const html = renderProcurementDocument(model.rows[0], model.observations, {
    sourceStatus: model.sources,
    sourceCoverage: null,
    aboResidual: { bridge: { status: "stopped_below_threshold" } },
  });
  // A retained zero remains printable; absence must not invent one.
  if (/Paid amount/.test(html)) {
    assert.match(html, /Paid amount[\s\S]{0,80}\$0/);
  }
  assert.doesNotMatch(html, /Importer coverage:/);
});
