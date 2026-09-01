import assert from "node:assert/strict";
import test from "node:test";

import {
  PROCUREMENT_PROCESS_STATE_FACETS,
  routeHashFromScope,
  scopeFromRouteHash,
  watchFromScope,
} from "../site/scope_v0.mjs";
import {
  KNOWN_PROCUREMENT_PROCESS_STATES,
  isKnownProcurementProcessState,
  procurementProcessStates,
} from "../site/procurement_process_state_vocabulary.mjs";
import { buildSharedProcurementReadModel } from "../site/shared_procurement_read_model.mjs";
import { buildProcurementSearchDocuments } from "../site/procurement_search_producer.mjs";
import { contractSearchDocumentToMoneyRow } from "../site/contract_search_bridge.mjs";
import {
  PROCUREMENT_BROWSE_QUERY_FIELDS,
  procurementBrowseFirstPageKey,
  queryProcurementBrowseRows,
} from "../site/procurement_browse_query.mjs";
import { filterMoneySnapshot } from "../site/resident_snapshot_queries.mjs";
import {
  compactCrolNegativeDigestRows,
  matchProcurementDigestRows,
} from "../site/procurement_digest_compile.mjs";
import { evaluateProcurementProcessWatch } from "../site/procurement_process_watch.mjs";
import { LENSES, sanitize } from "../worker/src/lib/filter.mjs";

const CONTRACT_STATES = ["open", "evaluation", "intent_to_award", "pending_registration", "registered"];

function sourceRecord(sourceSystem, sourceSystemId, snapshot) {
  return {
    source_system: sourceSystem,
    source_system_id: sourceSystemId,
    content_hash: `hash:${sourceSystemId}`,
    normalized_snapshot: JSON.stringify(snapshot),
    raw_snapshot: JSON.stringify(snapshot),
    ingested_at: "2026-08-18T19:46:32Z",
  };
}

function pendingRecord() {
  return sourceRecord("passport_public_contracts", "contract:EPINWATCH:CTR-1", {
    ctr_id: "CTR-1",
    epin: "EPIN-WATCH",
    contract_id: "CT-WATCH",
    title: "Bridge inspection",
    status: "Pending Registration Package Compilation",
    status_date: "2026-12-04",
  });
}

function registeredRecord() {
  return sourceRecord("passport_public_contracts", "contract:EPINWATCH:CTR-2", {
    ctr_id: "CTR-2",
    epin: "EPIN-WATCH",
    contract_id: "CT-WATCH",
    title: "Bridge inspection",
    status: "Registered",
    registration_date: "2027-01-17",
  });
}

function unknownStatusRecord() {
  return sourceRecord("passport_public_rfx", "rfx:EPINUNKNOWN:2001", {
    rfp_id: "2001",
    epin: "EPIN-UNKNOWN",
    procurement_name: "Signal replacement",
    agency: "Department of Transportation",
    rfx_status: "Publisher changed this",
    release_date: "2026-08-01",
    due_date: "2020-01-01",
  });
}

function readModel(records) {
  return buildSharedProcurementReadModel({
    sourceRecords: records,
    generatedAt: "2026-08-18T20:00:00Z",
    now: "2026-08-18T20:00:00Z",
  });
}

function browseRows(records) {
  const model = readModel(records);
  return buildProcurementSearchDocuments(model).documents
    .map((document) => contractSearchDocumentToMoneyRow({ ...document, outcome: "indexed" }))
    .filter(Boolean);
}

function digestRows(records) {
  return compactCrolNegativeDigestRows(readModel(records));
}

test("A1 the money route serializes every known source-backed state and drops the rest", () => {
  assert.deepEqual([...PROCUREMENT_PROCESS_STATE_FACETS], [...KNOWN_PROCUREMENT_PROCESS_STATES]);
  for (const state of CONTRACT_STATES) assert.ok(KNOWN_PROCUREMENT_PROCESS_STATES.includes(state));

  for (const state of KNOWN_PROCUREMENT_PROCESS_STATES) {
    const hash = `#money?mode=award&state=${state}`;
    const scope = scopeFromRouteHash(hash, { language: "en" });
    assert.equal(scope.facets.values.processState, state);
    assert.equal(routeHashFromScope(scope, { surface: "money" }), hash);
    // The same query becomes the Following watch without a second vocabulary.
    assert.deepEqual(watchFromScope(scope, { lens: "money" }).filter.processState, state);
  }

  for (const rejected of ["unknown", "registered_soon", "REGISTERED", ""]) {
    const scope = scopeFromRouteHash(`#money?mode=award&state=${rejected}`, { language: "en" });
    assert.equal(Object.hasOwn(scope.facets.values, "processState"), false);
    assert.equal(routeHashFromScope(scope, { surface: "money" }), "#money?mode=award");
  }

  // The state is a money predicate only; it never leaks onto another surface.
  assert.deepEqual(scopeFromRouteHash("#land?state=registered", { language: "en" }).facets.values, {});
});

test("A1 the money watch schema clamps the same closed state vocabulary", () => {
  assert.ok(LENSES.money.includes("processState"));
  for (const state of KNOWN_PROCUREMENT_PROCESS_STATES) {
    assert.equal(sanitize("money", { processState: state }).processState, state);
  }
  assert.equal(Object.hasOwn(sanitize("money", { processState: "unknown" }), "processState"), false);
  assert.equal(Object.hasOwn(sanitize("money", { processState: "not_a_state" }), "processState"), false);
  assert.equal(Object.hasOwn(sanitize("money", {}), "processState"), false);
});

test("A1 browse and search rows carry only source-backed states on the canonical identity", () => {
  const rows = browseRows([pendingRecord(), registeredRecord()]);
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.procurement_id, "procurement:contract:CTWATCH");
  assert.deepEqual([...row.process_states], ["pending_registration", "registered"]);
  assert.ok(row.process_states.every(isKnownProcurementProcessState));

  // Every advertised state traces to a retained observation on this object.
  const model = readModel([pendingRecord(), registeredRecord()]);
  const object = model.rows[0];
  const retained = new Set(object.source_observation_refs);
  for (const event of object.process_events) assert.ok(retained.has(event.source_observation_ref));
  assert.deepEqual(procurementProcessStates(object.process_events), [...row.process_states]);

  // The bounded Browse projection keeps the field the resident filter reads.
  assert.ok(PROCUREMENT_BROWSE_QUERY_FIELDS.includes("process_states"));
  const selected = queryProcurementBrowseRows(rows, { mode: "award", processStates: ["registered"] });
  assert.deepEqual(selected.ordered_ids, ["procurement:contract:CTWATCH"]);
  assert.equal(queryProcurementBrowseRows(rows, { mode: "award", processStates: ["open"] }).total, 0);
  // A state predicate is never served from the precomputed default first page.
  assert.equal(procurementBrowseFirstPageKey({ mode: "award", sort: "newest" }), "award");
  assert.equal(procurementBrowseFirstPageKey({ mode: "award", sort: "newest", processStates: ["registered"] }), null);
});

test("A3 an unknown publisher state yields no known-state card and no query match", () => {
  const rows = browseRows([unknownStatusRecord()]);
  assert.equal(rows.length, 1);
  assert.equal(Object.hasOwn(rows[0], "process_states"), false);
  const model = readModel([unknownStatusRecord()]);
  assert.deepEqual(model.rows[0].process_events.map((event) => event.state), ["unknown"]);
  assert.deepEqual(procurementProcessStates(model.rows[0].process_events), []);

  for (const state of KNOWN_PROCUREMENT_PROCESS_STATES) {
    assert.equal(filterMoneySnapshot(rows, { mode: "open", processStates: [state], limit: 40 }).length, 0);
    assert.equal(filterMoneySnapshot(rows, { mode: "archive", processStates: [state], limit: 40 }).length, 0);
  }
  // An unobserved value narrows to nothing rather than widening the collection.
  assert.equal(filterMoneySnapshot(rows, { mode: "archive", processStates: ["unknown"], limit: 40 }).length, 0);
  assert.equal(filterMoneySnapshot(rows, { mode: "archive", limit: 40 }).length, 1);
});

test("A3 duplicate observations do not duplicate a state card", () => {
  const rows = browseRows([pendingRecord(), registeredRecord(), registeredRecord()]);
  assert.deepEqual([...rows[0].process_states], ["pending_registration", "registered"]);
  const selected = queryProcurementBrowseRows(rows, { mode: "award", processStates: ["registered"] });
  assert.equal(selected.total, 1);
});

test("A2 a later registered observation after pending registration fires exactly one transition", () => {
  const before = digestRows([pendingRecord()]);
  assert.deepEqual([...before[0].process_states], ["pending_registration"]);
  const seen = new Set();

  // First observation of an object is never a transition; it only records where it stands.
  const first = evaluateProcurementProcessWatch(before, seen);
  assert.equal(first.rows[0].procurement_process_watch.transition, null);
  assert.deepEqual(first.rows[0].procurement_process_watch.observed_states, ["pending_registration"]);
  for (const id of first.markSeenIds) seen.add(id);

  const after = digestRows([pendingRecord(), registeredRecord()]);
  const second = evaluateProcurementProcessWatch(after, seen);
  const transitions = second.rows.filter((row) => row.procurement_process_watch?.transition);
  assert.equal(transitions.length, 1);
  const { transition } = transitions[0].procurement_process_watch;
  assert.deepEqual(transition.from, { state: "pending_registration", effective_at: "2026-12-04" });
  assert.deepEqual(transition.to, { state: "registered" });
  assert.equal(transition.event.state, "registered");
  assert.equal(transition.event.effective_at, "2027-01-17");
  assert.equal(transition.event.source_system, "passport_public_contracts");
  assert.equal(transition.event.source_observation_ref, "passport_public_contracts:contract:EPINWATCH:CTR-2");
  assert.equal(transition.event.source_receipt_ref, "hash:contract:EPINWATCH:CTR-2");
  assert.equal(transition.event.evidence_href, "https://a0333-passportpublic.nyc.gov/contracts.html");
  assert.equal(
    transition.transition_key,
    `procurement-process:${encodeURIComponent("procurement:contract:CTWATCH")}:transition:`
      + `pending_registration>registered:${encodeURIComponent(transition.event.event_id)}`,
  );
  assert.ok(second.markSeenIds.includes(transition.transition_key));
  for (const id of second.markSeenIds) seen.add(id);

  // A refresh of the same observations delivers nothing further.
  const third = evaluateProcurementProcessWatch(digestRows([pendingRecord(), registeredRecord()]), seen);
  assert.equal(third.rows[0].procurement_process_watch.transition, null);
  assert.deepEqual(third.markSeenIds, []);
});

test("A2 no transition comes from a timer, an expiry, an absence, or a duplicate observation", () => {
  const seen = new Set();
  const opening = digestRows([pendingRecord()]);
  for (const id of evaluateProcurementProcessWatch(opening, seen).markSeenIds) seen.add(id);

  // Timer: re-evaluating the identical retained observations, however often, is inert.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const repeat = evaluateProcurementProcessWatch(digestRows([pendingRecord()]), seen);
    assert.equal(repeat.rows[0].procurement_process_watch.transition, null);
    assert.deepEqual(repeat.markSeenIds, []);
  }

  // Expiry: a long-past publisher deadline is not a state change.
  const expiredSeen = new Set();
  const expired = browseRows([unknownStatusRecord()]);
  assert.equal(expired[0].end_date, "2020-01-01");
  const expiredResult = evaluateProcurementProcessWatch(expired, expiredSeen);
  assert.equal(expiredResult.rows[0].procurement_process_watch, undefined);
  assert.deepEqual(expiredResult.markSeenIds, []);

  // Absence: an observation that stops being retained never fires a transition.
  const absent = evaluateProcurementProcessWatch(digestRows([registeredRecord()]).map((row) => ({
    ...row,
    process_events: [],
    process_states: [],
  })), seen);
  assert.equal(absent.rows[0].procurement_process_watch, undefined);
  assert.deepEqual(absent.markSeenIds, []);

  // Duplicate: the same registered observation repeated is one transition, then silence.
  const duplicated = evaluateProcurementProcessWatch(
    digestRows([pendingRecord(), registeredRecord(), registeredRecord()]),
    seen,
  );
  assert.equal(duplicated.rows.filter((row) => row.procurement_process_watch?.transition).length, 1);
  for (const id of duplicated.markSeenIds) seen.add(id);
  const replay = evaluateProcurementProcessWatch(
    digestRows([pendingRecord(), registeredRecord(), registeredRecord()]),
    seen,
  );
  assert.equal(replay.rows.filter((row) => row.procurement_process_watch?.transition).length, 0);
});

test("A2 an out-of-order publisher date does not manufacture an advance", () => {
  const backdatedRegistered = sourceRecord("passport_public_contracts", "contract:EPINWATCH:CTR-3", {
    ctr_id: "CTR-3",
    epin: "EPIN-WATCH",
    contract_id: "CT-WATCH",
    title: "Bridge inspection",
    status: "Registered",
    registration_date: "2020-01-01",
  });
  const seen = new Set();
  for (const id of evaluateProcurementProcessWatch(digestRows([pendingRecord()]), seen).markSeenIds) seen.add(id);
  const result = evaluateProcurementProcessWatch(digestRows([pendingRecord(), backdatedRegistered]), seen);
  assert.equal(result.rows[0].procurement_process_watch.transition, null);
});

test("A2 a process-state watch selects the canonical projection through the existing digest filter", () => {
  const snapshot = { rows: digestRows([pendingRecord(), registeredRecord()]) };
  const matched = matchProcurementDigestRows(snapshot, { processState: "registered" }, { lens: "money" });
  assert.deepEqual(matched.map((row) => row.procurement_id), ["procurement:contract:CTWATCH"]);
  assert.deepEqual(matchProcurementDigestRows(snapshot, { processState: "open" }, { lens: "money" }), []);
  assert.deepEqual(matchProcurementDigestRows(snapshot, { processState: "unknown" }, { lens: "money" }), []);
});
