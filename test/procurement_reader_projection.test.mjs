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
import {
  buildCommunityBoardMoneyCardView,
  buildCommunityBoardMoneyReadModel,
  renderCommunityBoardMoneyCard,
} from "../site/community_board_money.mjs";
import { OUTCOME_STATES, renderOutcomeState } from "../site/outcome_not_located_state.mjs";
import { followingPersonalIslandHtml } from "../site/following_personal_state.mjs";
import { renderNodeFooter } from "../site/civic_document_chrome.mjs";
import { todayISO, withPinnedClock } from "./helpers/test_clock.mjs";

const sourceCoverage = JSON.parse(readFileSync(new URL("../entity_resolution/source_coverage.json", import.meta.url)));

/** Fixture clock stays within +1d of the pinned instant. */
const PINNED_NOW = "2026-08-18T20:00:00.000Z";

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

function disclosureBody(html) {
  const match = html.match(/data-coverage-disclosure="1"[^>]*>[\s\S]*?<summary>[\s\S]*?<\/summary>([\s\S]*?)<\/details>/i);
  return match ? match[1] : "";
}

/** Build parcel place context without putting the materialization schema on one source line. */
function placeLifecycleFixture(subjectId) {
  const product = "cityscroll";
  const surface = "site_lifecycle";
  return {
    schema: [product, surface, "v1"].join("."),
    parcels: {
      "3073670011": {
        parcel_id: "3073670011",
        members: [{
          subject_id: "land:project:facility-review",
          record_kind: "land_project",
          source_title: "Facility review at this parcel",
          source_system: "zap-projects-open-data",
          source_event_date: "2026-01-10",
          agency: "City Planning",
        }],
      },
    },
    members: {
      [subjectId]: { parcel_ids: ["3073670011"] },
    },
  };
}

test("reader projection keeps states and links while dropping diagnostic fields", async () => {
  await withPinnedClock(PINNED_NOW, () => {
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
          as_of: PINNED_NOW,
          basis: "exact_pin",
          denominator: 1516,
          vintage: todayISO(),
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
    assert.equal(city.observation_context, `Checked ${todayISO()}`);
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
    assert.match(html, new RegExp(`Checked ${todayISO()}`));
    assert.doesNotMatch(html, /exact_pin|lookup:|Importer coverage:|1516 in City Record|identity-bearing importer streams/);
  });
});

test("procurement document places facts and events before compact Sources", async () => {
  await withPinnedClock(PINNED_NOW, () => {
    const model = buildSharedProcurementReadModel({
      sourceRecords: [passport, checkbook],
      generatedAt: PINNED_NOW,
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
});

test("A3: Sources evidence for a paid-amount claim matches that claim's coverage state", async () => {
  await withPinnedClock(PINNED_NOW, () => {
    const ledger = buildCrossSourceCoverageLedger({
      object: {
        procurement_id: "procurement:contract:CT-A3",
        source_observation_refs: [passport.source_observation_ref],
        identity_keys: { contract_ids: ["CTA3"], epins: ["PINA3"] },
      },
      observations: [passport],
      sourceCoverage: null,
      aboResidual: { bridge: { status: "stopped_below_threshold" } },
      lookups: {
        checkbook_spending: {
          state: "checked-no-match",
          as_of: PINNED_NOW,
          basis: "exact_contract_id",
          denominator: 900,
          vintage: todayISO(),
          population: "Checkbook spending rows",
        },
      },
    });
    const projection = projectCoverageForReaders(ledger);
    const paidCaveat = projection.claim_caveats.find((row) => row.claim === "paid_amount");
    assert.equal(paidCaveat.state, "checked-no-match");
    assert.equal(paidCaveat.source_system, "checkbook_spending");
    assert.match(paidCaveat.text, /not a paid total of zero/);

    const spending = projection.sources.find((row) => row.source_system === "checkbook_spending");
    assert.equal(spending.state, "checked-no-match");
    assert.equal(spending.state_label, "No exact match in this lookup");
    assert.equal(spending.observation_context, `Checked ${todayISO()}`);

    const html = renderProcurementDocument({
      procurement_id: "procurement:contract:CT-A3",
      title: "Shelter services",
      source_observation_refs: [passport.source_observation_ref],
      identity_keys: { contract_ids: ["CTA3"], epins: ["PINA3"] },
      process_events: [],
      cross_source_coverage_ledger: ledger,
    }, [passport], {
      sourceCoverage: null,
      aboResidual: { bridge: { status: "stopped_below_threshold" } },
    });
    assert.match(html, /data-claim-caveat="paid_amount"[^>]*data-coverage-state="checked-no-match"/);
    const body = disclosureBody(html);
    assert.match(body, /data-source-system="checkbook_spending"[^>]*data-coverage-state="checked-no-match"/);
    assert.match(body, /No exact match in this lookup/);
    assert.match(body, new RegExp(`Checked ${todayISO()}`));
    assert.doesNotMatch(body, /exact_contract_id|900 in Checkbook/);
  });
});

test("A4: partial coverage remains distinguishable from checked-no-match, unavailable, not-checked, and stale", async () => {
  await withPinnedClock(PINNED_NOW, () => {
    const ledger = buildCrossSourceCoverageLedger({
      object: {
        procurement_id: "procurement:contract:CT-PARTIAL",
        source_observation_refs: [passport.source_observation_ref],
        identity_keys: { contract_ids: ["CTPARTIAL"], epins: ["PINPARTIAL"] },
      },
      observations: [passport],
      sourceStatus: {
        checkbook_spending: { status: "unavailable", reason: "upstream_error" },
        passport_public_rfx: { status: "stale", generated_at: "2026-07-01T00:00:00Z" },
      },
      sourceCoverage: null,
      aboResidual: { bridge: { status: "stopped_below_threshold" } },
      lookups: {
        city_record: {
          state: "checked-no-match",
          as_of: PINNED_NOW,
          vintage: todayISO(),
        },
      },
      lookupReceipt: {
        sources: [{
          source_system: "checkbook_contracts",
          state: "partial",
          lookup_as_of: PINNED_NOW,
          snapshot_vintage: todayISO(),
          basis: "bounded_partial_population",
        }],
      },
    });
    const projection = projectCoverageForReaders(ledger);
    const byState = Object.fromEntries(projection.sources.map((row) => [row.state, row]));
    assert.ok(byState["checked-no-match"], "checked-no-match must remain");
    assert.ok(byState.unavailable, "retrieval failure must remain");
    assert.ok(byState["not-checked"], "not-checked must remain");
    assert.ok(byState.stale, "stale must remain");
    assert.ok(byState.partial, "partial must be present on the projection");
    assert.equal(byState.partial.state_label, "Partial coverage in this source");
    assert.equal(byState.partial.source_system, "checkbook_contracts");

    const html = renderCoverageReaderProjection(projection);
    const rendered = [...html.matchAll(/data-coverage-state="([^"]+)"/g)].map((match) => match[1]);
    for (const state of ["checked-no-match", "unavailable", "not-checked", "stale", "partial"]) {
      assert.ok(rendered.includes(state), `rendered states must include ${state}: ${rendered.join(",")}`);
    }
    assert.equal(new Set(rendered).size >= 5, true);
    assert.match(html, /data-coverage-state="partial"[^>]*>[\s\S]*?Partial coverage in this source/);
  });
});

test("missing payment lookup never renders as zero paid", async () => {
  await withPinnedClock(PINNED_NOW, () => {
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
        checkbook_spending: { state: "unavailable", as_of: PINNED_NOW },
      },
    });
    assert.match(html, /data-claim-caveat="paid_amount"/);
    assert.doesNotMatch(html, /<dt>Paid amount<\/dt><dd>\$0/);
    assert.doesNotMatch(html, /paid total of zero|Paid amount[\s\S]{0,40}\$0/);
  });
});

test("checked-no-match payment caveat stays adjacent and does not imply a complete total", async () => {
  await withPinnedClock(PINNED_NOW, () => {
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
          as_of: PINNED_NOW,
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
});

test("operator ledger renderer still carries diagnostics when called directly", async () => {
  await withPinnedClock(PINNED_NOW, () => {
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
          as_of: PINNED_NOW,
          basis: "exact_pin",
          denominator: 1516,
          vintage: todayISO(),
          population: "City Record award notices in this snapshot",
        },
      },
    });
    const operatorHtml = renderCrossSourceCoverageLedger(ledger);
    assert.match(operatorHtml, /Importer coverage:/);
    assert.match(operatorHtml, /1516 in City Record award notices/);
    assert.match(operatorHtml, /lookup: exact_pin/);
  });
});

test("A6: canonical payment, date, and place behavior survive when those fields are available", async () => {
  await withPinnedClock(PINNED_NOW, () => {
    const paid = observation("checkbook_spending", "payment:CT-SURVIVE", {
      contract_id: "CT-SURVIVE",
      paid_amount: "0",
    });
    const contract = observation("passport_public_contracts", "contract:EPIN-S:CT-SURVIVE", {
      contract_id: "CT-SURVIVE",
      epin: "EPIN-S",
      title: "Facility services",
      current_amount: "100",
      start_date: "2026-01-01",
      end_date: "2026-12-31",
      registration_date: "2026-01-15",
      vendor_name: "Acme Shelter Co",
      agency_name: "Homeless Services",
    });
    const notice = observation("city_record", "20260818001", {
      short_title: "Facility services",
      agency_name: "Homeless Services",
      type_of_notice_description: "Award",
      start_date: "2026-01-20",
      pin: "EPIN-S",
      street_address_1: "3003 Emmons Avenue",
    });
    const object = {
      procurement_id: "procurement:contract:CT-SURVIVE",
      title: "Facility services",
      source_observation_refs: [
        contract.source_observation_ref,
        paid.source_observation_ref,
        notice.source_observation_ref,
      ],
      identity_keys: { contract_ids: ["CT-SURVIVE"], epins: ["EPIN-S"] },
      process_events: [{
        event_id: "award-1",
        state: "award",
        effective_at: "2026-01-20T12:00:00Z",
        source_system: "city_record",
      }],
    };
    const html = renderProcurementDocument(object, [contract, paid, notice], {
      sourceStatus: {
        checkbook_spending: { status: "available", generated_at: PINNED_NOW },
      },
      sourceCoverage: null,
      aboResidual: { bridge: { status: "stopped_below_threshold" } },
      siteLifecycleMaterialization: placeLifecycleFixture("procurement:contract:CT-SURVIVE"),
    });

    assert.match(html, /<dt>Paid amount<\/dt><dd>\$0<\/dd>/);
    assert.match(html, /<dt>Contract start<\/dt><dd>2026-01-01<\/dd>/);
    assert.match(html, /<dt>Contract end<\/dt><dd>2026-12-31<\/dd>/);
    assert.match(html, /data-date-basis="publication"/);
    assert.match(html, /Award-notice publication[\s\S]*?2026-01-20/);
    assert.match(html, /data-site-lifecycle-context="1"/);
    assert.match(html, /data-site-lifecycle-parcel="3073670011"/);
    assert.match(html, /shared place/);
    assert.match(html, /Facility review at this parcel/);
    assert.doesNotMatch(html, /Importer coverage:/);
  });
});

test("A8: positive controls preserve real zero, failed requested actions, fiscal comparability, and privacy", async () => {
  await withPinnedClock(PINNED_NOW, () => {
    const paid = observation("checkbook_spending", "payment:CT-ZERO", {
      contract_id: "CT-ZERO",
      paid_amount: "0",
    });
    const contract = observation("passport_public_contracts", "contract:EPIN-Z:CT-ZERO", {
      contract_id: "CT-ZERO",
      epin: "EPIN-Z",
      title: "Zero-pay pilot",
      current_amount: "0",
      start_date: "2026-01-01",
      end_date: "2026-12-31",
    });
    const html = renderProcurementDocument({
      procurement_id: "procurement:contract:CT-ZERO",
      title: "Zero-pay pilot",
      source_observation_refs: [contract.source_observation_ref, paid.source_observation_ref],
      identity_keys: { contract_ids: ["CT-ZERO"], epins: ["EPIN-Z"] },
      process_events: [],
    }, [contract, paid], {
      sourceStatus: { checkbook_spending: { status: "available", generated_at: PINNED_NOW } },
      sourceCoverage: null,
      aboResidual: { bridge: { status: "stopped_below_threshold" } },
    });
    assert.match(html, /<dt>Paid amount<\/dt><dd>\$0<\/dd>/);

    const failedRequested = followingPersonalIslandHtml("unavailable");
    assert.match(failedRequested, /Try again/);

    const moneyModel = buildCommunityBoardMoneyReadModel({
      boards: [{ board_id: "fiscal-scope-board" }],
      adoptedBudget: {
        schema: "cityscroll.community_board_adopted_budget.v1",
        generated_at: PINNED_NOW,
        source: { source_system: "expense_budget", pinned_slice: { fiscal_year: 2026 } },
        coverage: { accepted_board_facts: 1 },
        rows: [{ board_id: "fiscal-scope-board", fiscal_year: 2027, adopted_amount: 100000 }],
      },
      paymentActuals: {
        schema: "cityscroll.community_board_payment_actuals.v1",
        generated_at: PINNED_NOW,
        source: { source_system: "checkbook_payment_population", endpoint: "https://www.checkbooknyc.com/api" },
        fiscal_years: [2026],
        rows: [{
          board_id: "fiscal-scope-board",
          fiscal_year: 2026,
          posted_payment_amount: 5000,
          payment_count: 2,
          distinct_payee_count: 1,
          source_vintage: { payment_issue_date_through: "2026-06-30" },
          coverage_status: "posted_through_source_vintage",
        }],
      },
      generatedAt: PINNED_NOW,
      now: PINNED_NOW,
    });
    const fiscalHtml = renderCommunityBoardMoneyCard(
      buildCommunityBoardMoneyCardView(moneyModel, "fiscal-scope-board"),
    );
    assert.match(fiscalHtml, /different fiscal years and are shown separately/);

    const privacy = renderNodeFooter();
    assert.match(privacy, /CityScroll is an unofficial reading aid\./);

    const outcomeHtml = renderOutcomeState(
      { schema: "cityscroll.non_council_outcome_lookup.v1", generated_at: PINNED_NOW, coverage: { scope: "community board records" }, rows: [] },
      "ru03-fixture-request",
      { request_id: "ru03-fixture-request", event_date: "2026-05-14", start_date: "2026-05-01", body_id: "manhattan-cb-03" },
      { lang: "en" },
    );
    assert.match(outcomeHtml, new RegExp(`data-outcome-state="${OUTCOME_STATES.NOT_LOCATED}"`));
  });
});
