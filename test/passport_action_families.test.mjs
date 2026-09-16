import assert from "node:assert/strict";
import test from "node:test";

import { renderProcurementDocument } from "../site/procurement_document.mjs";
import { contractAmountBand, groupAnalyticalContracts } from "../site/analytical_projection.mjs";
import { projectProcurementFacts } from "../site/procurement_fact_projection.mjs";
import { materializeProcurementSearchDocument } from "../site/procurement_search_producer.mjs";
import { publicProcurementAmount } from "../site/checkbook_passport_corroboration.mjs";
import { buildProcurementBrowseQueryArtifacts } from "../site/procurement_browse_query.mjs";
import { buildSharedProcurementReadModel } from "../site/shared_procurement_read_model.mjs";
import { loadRetainedContractFamilies } from "../site/passport_retained_families.mjs";
import { procurementSourceRecordsFromMaterializations } from "../tools/build_shared_procurement_read_model.mjs";
import {
  reconcilePassportPopulations,
} from "../worker/src/lib/passport_parse.mjs";
import { testClockISOString, withPinnedClock } from "./helpers/test_clock.mjs";

const ACQUIRED_AT = "2026-09-07T12:00:00Z";
const retained = loadRetainedContractFamilies();

function byCtr(ctrId) {
  const row = retained.rows.find((entry) => String(entry.ctr_id) === String(ctrId));
  assert.ok(row, `retained row ${ctrId}`);
  return { ...row };
}

const FIREMATIC_IDS = ["4561064", "4618449"];
const TAMEER_IDS = [
  "4579402", "4980664", "4982079", "4983925", "5224471", "5240965",
  "5243993", "5247650", "5340426", "5359354", "5371783", "5372858",
];
const firematic = FIREMATIC_IDS.map(byCtr);
const tameer = TAMEER_IDS.map(byCtr);
const aha = byCtr("5778239");

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
  const model = modelFor([...firematic, ...tameer]);
  const passport = model.observations.filter((row) => row.source_system === "passport_public_contracts");
  assert.equal(passport.length, 14);
  assert.deepEqual(
    passport.filter((row) => row.snapshot.vendor === "FIREMATIC SUPPLY CO. INC").map((row) => row.snapshot.ctr_id).sort(),
    FIREMATIC_IDS.slice().sort(),
  );
  assert.deepEqual(
    passport.filter((row) => row.snapshot.vendor === "TAMEER INC").map((row) => row.snapshot.ctr_id).sort(),
    TAMEER_IDS.slice().sort(),
  );
  for (const row of passport) {
    assert.ok(row.snapshot.contract_type);
    assert.ok(row.snapshot.epin);
    for (const field of ["award_amount", "current_amount", "encumbered_amount", "paid_amount", "start_date", "end_date", "registration_date"]) {
      assert.ok(Object.hasOwn(row.snapshot, field), `${field} retained for ${row.snapshot.ctr_id}`);
    }
    assert.ok(row.snapshot.action_key);
    assert.ok(row.snapshot.action_family_key);
  }
  const firematicObject = model.rows.find((row) => row.passport_action_family?.family_key === "CT1-857-20228800365");
  assert.deepEqual(firematicObject.passport_action_family.actions.map((row) => row.ctr_id).sort(), FIREMATIC_IDS.slice().sort());
  assert.deepEqual(
    firematicObject.passport_action_family.actions
      .slice()
      .sort((left, right) => String(left.action_key).localeCompare(String(right.action_key)))
      .map((row) => row.action_role),
    ["base", "action"],
  );
});

test("A1: rendered action families keep original retained amounts in separate roles", () => {
  const model = modelFor([...firematic, ...tameer]);
  const firematicObject = model.rows.find((row) => row.passport_action_family?.family_key === "CT1-857-20228800365");
  const tameerObject = model.rows.find((row) => row.passport_action_family?.family_key === "CT1-850-20228802305");
  const observationsFor = (object) => model.observations.filter((row) => object.source_observation_refs.includes(row.source_observation_ref));
  const firematicFacts = projectProcurementFacts(firematicObject, observationsFor(firematicObject)).facts;
  const tameerObservations = observationsFor(tameerObject);
  const tameerBase = tameerObservations.find((row) => row.snapshot.ctr_id === "4579402")?.snapshot;
  const tameerAction = tameerObservations.find((row) => row.snapshot.ctr_id === "5372858")?.snapshot;
  const tameerBaseFacts = projectProcurementFacts({}, [{
    source_system: "passport_public_contracts",
    source_observation_ref: "tameer:base",
    snapshot: tameerBase,
  }]).facts;
  const tameerActionFacts = projectProcurementFacts({}, [{
    source_system: "passport_public_contracts",
    source_observation_ref: "tameer:action",
    snapshot: tameerAction,
  }]).facts;
  assert.deepEqual({
    original: firematicFacts.originalAmount,
    current: firematicFacts.currentAmount,
    action: firematicFacts.actionAmount,
  }, {
    original: 158997.84,
    current: 208687.62,
    action: 49689.78,
  });
  assert.deepEqual({
    original: tameerBaseFacts.originalAmount,
    current: tameerBaseFacts.currentAmount,
    action: tameerActionFacts.actionAmount,
  }, {
    original: 1442820.77,
    current: 1779343.45,
    action: 26112.93,
  });
  assert.equal(contractAmountBand(tameerBaseFacts.baseAmount), "$1 million–$9.99 million");
  const html = renderProcurementDocument(firematicObject, observationsFor(firematicObject));
  assert.match(html, /\$158,997\.84/);
  assert.match(html, /\$208,687\.62/);
  assert.match(html, /\$49,689\.78/);
});

test("A2: action titles use publisher numbering rather than identifier suffixes", () => {
  const model = modelFor(tameer);
  const tameerObject = model.rows.find((row) => row.passport_action_family?.family_key === "CT1-850-20228802305");
  const observations = model.observations.filter((row) => tameerObject.source_observation_refs.includes(row.source_observation_ref));
  assert.match(observations.find((row) => row.snapshot.epin.endsWith("C011")).snapshot.title, /CO#8/);
  assert.match(observations.find((row) => row.snapshot.epin.endsWith("C010")).snapshot.title, /CO#11/);
  const search = materializeProcurementSearchDocument(tameerObject, model);
  const browse = search.provenance.browse_record;
  assert.deepEqual({
    search: [browse.original_contract_amount, browse.current_contract_amount, browse.action_amount],
    browse: ((row) => [row.original_contract_amount, row.current_contract_amount, row.action_amount])(
      buildProcurementBrowseQueryArtifacts({ rows: [browse] }).queryRowsArtifact.query_rows[0],
    ),
    export: publicProcurementAmount(tameerObject, observations),
    aggregate: groupAnalyticalContracts([
      {
        prime_contract_id: "CT1-850-20228802305",
        agency: "Department of Design and Construction",
        current_registered_amount: 1779343.45,
        original_registered_amount: 1442820.77,
      },
    ]).groups[0],
  }, {
    search: [1442820.77, 1779343.45, 26112.93],
    browse: [1442820.77, 1779343.45, 26112.93],
    export: 1442820.77,
    aggregate: {
      label: "Department of Design and Construction",
      contract_ids: ["CT1-850-20228802305"],
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

test("A2: repeated paid and encumbered totals are not summed across observations", async () => {
  const model = await withPinnedClock("2026-09-16T12:00:00.000Z", () => modelFor(firematic));
  const firematicObject = model.rows.find((row) => row.passport_action_family?.family_key === "CT1-857-20228800365");
  const observations = model.observations.filter((row) => firematicObject.source_observation_refs.includes(row.source_observation_ref));
  assert.equal(observations.length, 2);
  assert.deepEqual(observations.map((row) => row.snapshot.paid_amount).sort((a, b) => a - b), [158997.84, 208687.62]);
  assert.deepEqual(observations.map((row) => row.snapshot.encumbered_amount).sort((a, b) => a - b), [158997.84, 208687.62]);
  const projection = projectProcurementFacts(firematicObject, observations);
  const search = materializeProcurementSearchDocument(firematicObject, model);
  const browse = search.provenance.browse_record;
  const browseQuery = buildProcurementBrowseQueryArtifacts({ rows: [browse] }).queryRowsArtifact.query_rows[0];
  // Projection keeps one paid/encumbered observation; it must not sum across family rows.
  assert.ok(projection.facts.paidAmount === 158997.84 || projection.facts.paidAmount === 208687.62);
  assert.ok(projection.facts.encumberedAmount === 158997.84 || projection.facts.encumberedAmount === 208687.62);
  assert.notEqual(projection.facts.paidAmount, 158997.84 + 208687.62);
  assert.equal(browse.paid_amount, projection.facts.paidAmount);
  assert.equal(browseQuery.paid_amount, projection.facts.paidAmount);
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
  assert.match(html, /EMS ACADEMY \(EMS TRAINING FT TOTTEN\)|EMS ACADEMY/);
  assert.match(html, /46,673\.32/);
  assert.match(html, /<dt>Method<\/dt><dd>Subscription<\/dd>/);
  assert.match(html, /2026-09-07|09\/07\/2026/);
});

test("A3 is order-independent and keeps population stages explicit", () => {
  const left = modelFor([...firematic, ...tameer, aha]);
  const right = modelFor([aha, ...tameer.slice().reverse(), ...firematic.slice().reverse()]);
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

test("A4 retains each original revision amount and registration date in the served action family", () => {
  const model = modelFor(tameer);
  const family = model.rows.find((row) => row.passport_action_family?.family_key === "CT1-850-20228802305");
  assert.ok(family);
  assert.equal(family.passport_action_family.actions.length, tameer.length);
  const observations = new Map(model.observations.map((row) => [row.snapshot.ctr_id, row]));
  for (const expected of tameer) {
    const observation = observations.get(expected.ctr_id);
    assert.equal(observation.snapshot.current_amount, expected.current_amount, `amount retained for ${expected.ctr_id}`);
    assert.equal(observation.snapshot.registration_date, expected.registration_date, `registration retained for ${expected.ctr_id}`);
    const html = renderProcurementDocument(family, [observation]);
    const renderedAmount = Number(expected.current_amount).toLocaleString("en-US");
    assert.match(html, new RegExp(`\\$${renderedAmount.replaceAll(",", "\\,")}`));
    const [month, day, year] = expected.registration_date.split("/");
    assert.match(html, new RegExp(`<dd>${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`));
  }
});
