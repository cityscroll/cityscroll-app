import assert from "node:assert/strict";
import test from "node:test";

import { renderProcurementDocument } from "../site/procurement_document.mjs";
import { contractAmountBand, groupAnalyticalContracts } from "../site/analytical_projection.mjs";
import { projectProcurementFacts } from "../site/procurement_fact_projection.mjs";
import { materializeProcurementSearchDocument } from "../site/procurement_search_producer.mjs";
import { publicProcurementAmount } from "../site/checkbook_passport_corroboration.mjs";
import { buildProcurementBrowseQueryArtifacts } from "../site/procurement_browse_query.mjs";
import { buildSharedProcurementReadModel } from "../site/shared_procurement_read_model.mjs";
import { procurementSourceRecordsFromMaterializations } from "../tools/build_shared_procurement_read_model.mjs";
import {
  mapContractRow,
  reconcilePassportPopulations,
} from "../worker/src/lib/passport_parse.mjs";
import { testClockISOString, withPinnedClock } from "./helpers/test_clock.mjs";

const ACQUIRED_AT = "2026-09-07T12:00:00Z";

function cells({
  ctr, epin, contract, title, vendor, type, method, amount, registration,
  award = amount, current = amount, encumbered = amount, paid = amount,
  start = "09/01/2026", end = "08/31/2027",
}) {
  return [
    ctr, epin, contract, title, "TEST AGENCY", vendor, "TEST PROGRAM", method,
    type, "Registered", award, current, encumbered, paid, start, end,
    registration, "Goods", "", "", "", "",
  ];
}

function contractRow(values) {
  return mapContractRow(cells(values));
}

const firematicBase = contractRow({
  ctr: "4561064", epin: "85721B0111001A000", contract: "FMS-FIREMATIC-1",
  title: "Bid 2100089 Nozzles", vendor: "FIREMATIC SUPPLY CO. INC",
  type: "Original", method: "Competitive Sealed Bid", amount: "$158,997.84", current: "$208,687.62", registration: "09/01/2021",
});
const firematicAction = contractRow({
  ctr: "4618449", epin: "85721B0111001A001", contract: "FMS-FIREMATIC-1",
  title: "Bid 2100089 Nozzles Amendment #1", vendor: "FIREMATIC SUPPLY CO. INC",
  type: "Amendment", method: "Amendment", amount: "$49,689.78", registration: "11/13/2021",
});

const tameerIds = ["4579402", "4980664", "4982079", "4983925", "5224471", "5240965", "5243993", "5247650", "5340426", "5359354", "5371783", "5372858"];
const tameerAmounts = [1442820.77, 26512.93, 27112.93, 27612.93, 28112.93, 28612.93, 29112.93, 29612.93, 30112.93, 30612.93, 31112.93, 26112.93];
const tameerCurrentAmounts = [1779343.45, ...tameerAmounts.slice(1)];
const tameerRegistrations = ["04/14/2025", "04/21/2025", "05/02/2025", "05/16/2025", "06/03/2025", "06/20/2025", "07/08/2025", "07/25/2025", "08/11/2025", "08/29/2025", "09/15/2025", "10/01/2025"];
const tameer = tameerIds.map((ctr, index) => contractRow({
  ctr,
  epin: `85021B0087001C${String(index + 1).padStart(3, "0")}`,
  contract: "FMS-TAMEER-1",
  title: index === 0 ? "LBC10CDHC" : `LBC10CDHC Change Order #${index === 9 ? 11 : index === 10 ? 8 : index}`,
  vendor: "TAMEER INC",
  type: index === 0 ? "Original" : "Revision",
  method: index === 0 ? "Competitive Sealed Bid" : "Construction Change Order",
  amount: `$${tameerAmounts[index].toLocaleString("en-US", { minimumFractionDigits: 2 })}`,
  current: `$${tameerCurrentAmounts[index].toLocaleString("en-US", { minimumFractionDigits: 2 })}`,
  registration: tameerRegistrations[index],
}));

const aha = contractRow({
  ctr: "5778239", epin: "05727U0002001", contract: "CT1-057-20278802113",
  title: "057270000251- AHA MATERIALS FOR TRAINING, EMS ACADEMY (EMS TRAINING FT TOTTEN)",
  vendor: "AMERICAN HEART ASSOCIATION INC", type: "General Contract (CT1)", method: "Subscription",
  amount: "$46,673.32", paid: "$0.00", registration: "09/07/2026",
  start: "08/21/2026", end: "06/30/2027",
});

function modelFor(rows, acquiredAt = testClockISOString()) {
  const records = procurementSourceRecordsFromMaterializations({
    generated_at: acquiredAt,
    rows: { passport_contracts: rows },
  }, { rows: [] });
  return buildSharedProcurementReadModel({
    sourceRecords: records,
    lifecycleRows: [],
    generatedAt: acquiredAt,
    now: acquiredAt,
  });
}

test("A1 retains complete Firematic and TAMEER action families with source fields", () => {
  const model = modelFor([firematicBase, firematicAction, ...tameer]);
  const passport = model.observations.filter((row) => row.source_system === "passport_public_contracts");
  assert.equal(passport.length, 14);
  assert.deepEqual(passport.filter((row) => row.snapshot.vendor === "FIREMATIC SUPPLY CO. INC").map((row) => row.snapshot.ctr_id).sort(), ["4561064", "4618449"]);
  assert.deepEqual(passport.filter((row) => row.snapshot.vendor === "TAMEER INC").map((row) => row.snapshot.ctr_id).sort(), tameerIds.slice().sort());
  for (const row of passport) {
    assert.ok(row.snapshot.contract_type);
    assert.ok(row.snapshot.epin);
    for (const field of ["award_amount", "current_amount", "encumbered_amount", "paid_amount", "start_date", "end_date", "registration_date"]) {
      assert.ok(Object.hasOwn(row.snapshot, field), `${field} retained for ${row.snapshot.ctr_id}`);
    }
    assert.ok(row.snapshot.action_key);
    assert.ok(row.snapshot.action_family_key);
  }
  const firematicObject = model.rows.find((row) => row.passport_action_family?.family_key === "FMS-FIREMATIC-1");
  assert.deepEqual(firematicObject.passport_action_family.actions.map((row) => row.ctr_id), ["4561064", "4618449"]);
  assert.deepEqual(firematicObject.passport_action_family.actions.map((row) => row.action_role), ["base", "action"]);
});

test("A1: rendered action families keep base and revision amounts in separate roles", () => {
  const model = modelFor([firematicBase, firematicAction, ...tameer]);
  const firematic = model.rows.find((row) => row.passport_action_family?.family_key === "FMS-FIREMATIC-1");
  const tameerObject = model.rows.find((row) => row.passport_action_family?.family_key === "FMS-TAMEER-1");
  const observationsFor = (object) => model.observations.filter((row) => object.source_observation_refs.includes(row.source_observation_ref));
  const firematicFacts = projectProcurementFacts(firematic, observationsFor(firematic)).facts;
  const tameerActions = tameerObject.passport_action_family.actions;
  const tameerObservations = observationsFor(tameerObject);
  const tameerBase = tameerObservations.find((row) => row.snapshot.ctr_id === tameerActions.find((action) => action.action_role === "base").ctr_id)?.snapshot;
  const tameerAction = tameerObservations.find((row) => row.snapshot.ctr_id === "5372858")?.snapshot;
  const tameerBaseFacts = projectProcurementFacts({}, [{ source_system: "passport_public_contracts", source_observation_ref: "tameer:base", snapshot: tameerBase }]).facts;
  const tameerActionFacts = projectProcurementFacts({}, [{ source_system: "passport_public_contracts", source_observation_ref: "tameer:action", snapshot: tameerAction }]).facts;
  assert.deepEqual({ original: firematicFacts.originalAmount, current: firematicFacts.currentAmount, action: firematicFacts.actionAmount }, {
    original: 158997.84, current: 208687.62, action: 49689.78,
  });
  assert.deepEqual({ original: tameerBaseFacts.originalAmount, current: tameerBaseFacts.currentAmount, action: tameerActionFacts.actionAmount }, {
    original: 1442820.77, current: 1779343.45, action: 26112.93,
  });
  assert.equal(contractAmountBand(tameerBaseFacts.baseAmount), "$1 million–$9.99 million");
  const html = renderProcurementDocument(firematic, observationsFor(firematic));
  assert.match(html, /\$158,997\.84/);
  assert.match(html, /\$208,687\.62/);
  assert.match(html, /\$49,689\.78/);
});

test("A2: action titles use publisher numbering rather than identifier suffixes", () => {
  const model = modelFor(tameer);
  const tameerObject = model.rows.find((row) => row.passport_action_family?.family_key === "FMS-TAMEER-1");
  const observations = model.observations.filter((row) => tameerObject.source_observation_refs.includes(row.source_observation_ref));
  assert.match(observations.find((row) => row.snapshot.epin.endsWith("C011")).snapshot.title, /Change Order #8/);
  assert.match(observations.find((row) => row.snapshot.epin.endsWith("C010")).snapshot.title, /Change Order #11/);
  const search = materializeProcurementSearchDocument(tameerObject, model);
  const browse = search.provenance.browse_record;
  assert.deepEqual({
    search: [browse.original_contract_amount, browse.current_contract_amount, browse.action_amount],
    browse: ((row) => [row.original_contract_amount, row.current_contract_amount, row.action_amount])(
      buildProcurementBrowseQueryArtifacts({ rows: [browse] }).queryRowsArtifact.query_rows[0],
    ),
    export: publicProcurementAmount(tameerObject, observations),
    aggregate: groupAnalyticalContracts([
      { prime_contract_id: "FMS-TAMEER-1", agency: "Department of Design and Construction", current_registered_amount: 1779343.45, original_registered_amount: 1442820.77 },
    ]).groups[0],
  }, {
    search: [1442820.77, 1779343.45, 26512.93],
    browse: [1442820.77, 1779343.45, 26512.93],
    export: 1442820.77,
    aggregate: {
      label: "Department of Design and Construction",
      contract_ids: ["FMS-TAMEER-1"],
      contract_count: 1,
      sum_current_registered_amount: 1779343.45,
      sum_original_registered_amount: 1442820.77,
      median_current_registered_amount: 1779343.45,
      total_contract_count: 1,
      eligible_contract_count: 0,
      missing_date_contract_count: 1,
      retroactive_contract_count: 0,
      early_on_time_contract_count: 0,
      retroactive_share: null,
      missing_date_share: 1,
      median_lag_days: null,
      p75_lag_days: null,
      p90_lag_days: null,
      excluded_row_count: 1,
    },
  });
});

test("A2 serves AHA without a City Record lifecycle match", async () => {
  const model = await withPinnedClock(ACQUIRED_AT, () => modelFor([aha]));
  assert.equal(model.rows.length, 1);
  assert.equal(model.rows[0].procurement_id, "procurement:contract:CT105720278802113");
  assert.equal(model.rows[0].lifecycle, null);
  assert.deepEqual(model.rows[0].source_observation_refs, [
    "passport_public_contracts:contract:05727U0002001:5778239",
  ]);
  const html = renderProcurementDocument(model.rows[0], model.observations);
  assert.match(html, /AHA MATERIALS FOR TRAINING/);
  assert.match(html, /46,673\.32/);
  assert.match(html, /<dt>Method<\/dt><dd>Subscription<\/dd>/);
  assert.match(html, /2026-09-07|09\/07\/2026/);
});

test("A3 is order-independent and keeps population stages explicit", () => {
  const left = modelFor([firematicBase, firematicAction, ...tameer, aha]);
  const right = modelFor([aha, ...tameer.slice().reverse(), firematicAction, firematicBase]);
  assert.deepEqual(
    left.rows.map((row) => ({ id: row.procurement_id, family: row.passport_action_family })).sort((a, b) => a.id.localeCompare(b.id)),
    right.rows.map((row) => ({ id: row.procurement_id, family: row.passport_action_family })).sort((a, b) => a.id.localeCompare(b.id)),
  );
  assert.deepEqual(reconcilePassportPopulations({
    rawRows: Array(4), parsedRows: Array(3),
    excludedRows: [{ reason: "publisher test row" }],
    rejectedRows: [{ reason: "missing EPIN" }],
    selectedRows: Array(2), servedRows: Array(2),
  }), {
    raw: 4, parsed: 3, excluded: 1, rejected: 1, selected: 2, served: 2,
    reconciliation: {
      raw_to_parsed: "3/4", parsed_to_selected: "2/3", selected_to_served: "2/2",
      note: "stage populations are reported separately; no portal-entry equivalence is inferred",
    },
  });
  assert.throws(() => reconcilePassportPopulations({ rejectedRows: [{}] }), /requires a reason/);
});

test("A4 carries acquisition vintage through builder and detail-loader inputs offline", async () => {
  const { model, acquiredAt } = await withPinnedClock(ACQUIRED_AT, () => {
    const acquiredAt = testClockISOString();
    return { model: modelFor([aha], acquiredAt), acquiredAt };
  });
  assert.equal(model.generated_at, acquiredAt);
  assert.equal(model.observations[0].ingested_at, acquiredAt);
  const html = renderProcurementDocument(model.rows[0], model.observations);
  assert.match(html, /2026-09-07T12:00:00Z|2026-09-07/);
});

test("A4 retains each revision amount and registration date in the served action family", () => {
  const model = modelFor(tameer);
  const family = model.rows.find((row) => row.passport_action_family?.family_key === "FMS-TAMEER-1");
  assert.ok(family);
  assert.equal(family.passport_action_family.actions.length, tameer.length);
  const observations = new Map(model.observations.map((row) => [row.snapshot.ctr_id, row]));
  for (const [index, ctr] of tameerIds.entries()) {
    const observation = observations.get(ctr);
    assert.equal(observation.snapshot.current_amount, tameerCurrentAmounts[index], `amount retained for ${ctr}`);
    assert.equal(observation.snapshot.registration_date, tameerRegistrations[index], `registration retained for ${ctr}`);
    const html = renderProcurementDocument(family, [observation]);
    const renderedAmount = tameerCurrentAmounts[index].toLocaleString("en-US", { minimumFractionDigits: 2 });
    assert.match(html, new RegExp(`<dd>\\$${renderedAmount.replace(",", "\\,")}<\\/dd>`));
    const [month, day, year] = tameerRegistrations[index].split("/");
    assert.match(html, new RegExp(`<dd>${year}-${month}-${day}(?: <span class="procurement-date-basis" data-date-basis="registration">\\(basis: registration\\)<\\/span>)?<\\/dd>`));
  }
});
