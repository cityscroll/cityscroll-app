// Contract test: the procurement lifecycle model (PROC-001).
//
// Proves the lifecycle assembly produces correct, explicit states for every required
// scenario: solicitation → award → pending → registered → payment, legacy PIN fallback,
// amendments, no-match behavior, cursor/cap behavior, and source timestamps. The pure
// library (worker/src/lib/checkbook_lifecycle.mjs) is the characterization surface — it
// has no fetch or env, so fixtures exercise the join logic directly.
//
//   node --test test/contract/procurement_lifecycle.test.mjs   (from the crol-list/ dir)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assembleLifecycle,
  parseContractTransactions,
  parseSpendingTransactions,
  classifyStage,
  detectAmendments,
  pinMatchStrategy,
  usablePin,
  pinBase,
  checkbookSuccess,
  STAGES,
} from "../../worker/src/lib/checkbook_lifecycle.mjs";

// ---------------------------------------------------------------------------
// Helper: build a Checkbook Contracts XML response
// ---------------------------------------------------------------------------

function contractsXml(contracts) {
  const tx = contracts.map((c) =>
    `<transaction>`
    + `<prime_contract_id>${c.id || ""}</prime_contract_id>`
    + `<prime_vendor>${c.vendor || ""}</prime_vendor>`
    + `<agency_name>${c.agency || ""}</agency_name>`
    + `<pin>${c.pin || ""}</pin>`
    + `<status>${c.status || "registered"}</status>`
    + `<prime_contract_current_amount>${c.current || ""}</prime_contract_current_amount>`
    + `<prime_contract_original_amount>${c.original || ""}</prime_contract_original_amount>`
    + `<prime_vendor_spent_to_date>${c.spent || ""}</prime_vendor_spent_to_date>`
    + `<prime_contract_start_date>${c.start || ""}</prime_contract_start_date>`
    + `<prime_contract_end_date>${c.end || ""}</prime_contract_end_date>`
    + `<prime_contract_registration_date>${c.registered || ""}</prime_contract_registration_date>`
    + `<received_date>${c.received || ""}</received_date>`
    + `</transaction>`).join("");
  return `<response><status><result>success</result></status><contract_transactions>${tx}</contract_transactions></response>`;
}

function spendingXml(transactions) {
  const tx = transactions.map((s) =>
    `<transaction>`
    + `<spending_id>${s.id || ""}</spending_id>`
    + `<vendor_name>${s.vendor || ""}</vendor_name>`
    + `<pin>${s.pin || ""}</pin>`
    + `<check_amount>${s.amount || ""}</check_amount>`
    + `<check_date>${s.date || ""}</check_date>`
    + `<fiscal_year>${s.year || ""}</fiscal_year>`
    + `</transaction>`).join("");
  return `<response><status><result>success</result></status><spending_transactions>${tx}</spending_transactions></response>`;
}

// ---------------------------------------------------------------------------
// 1. FULL LIFECYCLE: solicitation → pending → registered → payment
// ---------------------------------------------------------------------------

test("lifecycle: solicitation notice produces solicitation → pending → registered → payment", () => {
  const notice = {
    request_id: "20250110001",
    agency_name: "Sanitation",
    type_of_notice_description: "Solicitation",
    start_date: "2025-01-10",
    short_title: "Collection Services",
    pin: "08250R0001001",
  };

  const pending = parseContractTransactions(contractsXml([{
    id: "C-1001", vendor: "ACME CORP", pin: "08250R0001001", status: "pending",
    current: "5000000", original: "5000000", received: "2025-03-15", start: "2025-03-01",
  }]));
  const registered = parseContractTransactions(contractsXml([{
    id: "C-1001", vendor: "ACME CORP", pin: "08250R0001001", status: "registered",
    current: "5000000", original: "5000000", spent: "1500000",
    registered: "2025-04-01", start: "2025-03-01", end: "2028-03-01",
  }]));
  const spending = parseSpendingTransactions(spendingXml([
    { id: "S-1", vendor: "ACME CORP", pin: "08250R0001001", amount: "750000", date: "2025-05-15" },
  ]));

  const result = assembleLifecycle(notice, pending, registered, spending, {
    pinStrategy: "exact",
    lookupStatus: { pending: "ok", registered: "ok", spending: "ok" },
  });

  assert.equal(result.ok, true);
  assert.equal(result.pin, "08250R0001001");

  // Stage ordering: solicitation (from City Record), then pending, registered, payment (from Checkbook)
  const stages = result.timeline.map((t) => t.stage);
  assert.deepEqual(stages, ["solicitation", "pending", "registered", "payment"]);

  // Every stage has a machine-readable status
  for (const entry of result.timeline) {
    assert.ok(["matched", "unmatched", "ambiguous", "unknown"].includes(entry.status),
      `stage ${entry.stage} has a valid status: ${entry.status}`);
    assert.ok(entry.source, `stage ${entry.stage} has a source`);
  }

  // All Checkbook stages are matched
  assert.equal(result.timeline[1].status, "matched"); // pending
  assert.equal(result.timeline[2].status, "matched"); // registered
  assert.equal(result.timeline[3].status, "matched"); // payment
});

test("lifecycle: award notice produces award → pending → registered → payment", () => {
  const notice = {
    request_id: "20250110001",
    agency_name: "Sanitation",
    type_of_notice_description: "Award",
    start_date: "2025-02-15",
    short_title: "Collection Services",
    pin: "08250R0001001",
    vendor_name: "ACME CORP",
    contract_amount: "5000000",
  };

  const result = assembleLifecycle(notice, [], [], [], {
    pinStrategy: "exact",
    lookupStatus: { pending: "ok", registered: "ok", spending: "ok" },
  });

  const stages = result.timeline.map((t) => t.stage);
  assert.deepEqual(stages, ["award", "pending", "registered", "payment"]);

  // Award stage carries vendor and amount
  const award = result.timeline[0];
  assert.equal(award.detail.vendor, "ACME CORP");
  assert.equal(award.detail.amount, 5000000);
});

// ---------------------------------------------------------------------------
// 2. LEGACY PIN FALLBACK
// ---------------------------------------------------------------------------

test("legacy PIN: pinBase strips renewal suffix R0\\d+$", () => {
  assert.equal(pinBase("82626R0001001"), "82626");
  assert.equal(pinBase("08250R0001001"), "08250");
  assert.equal(pinBase("82626"), null); // no renewal suffix
  assert.equal(pinBase("82626R01"), "82626"); // minimal suffix
});

test("legacy PIN: pinMatchStrategy tries exact then base", () => {
  const { pins, strategy } = pinMatchStrategy("82626R0001001");
  assert.equal(strategy, "legacy-base");
  assert.equal(pins[0], "82626R0001001"); // exact first
  assert.equal(pins[1], "82626"); // base fallback
});

test("legacy PIN: usablePin rejects junk values", () => {
  assert.ok(!usablePin("N/A"));
  assert.ok(!usablePin("TBD"));
  assert.ok(!usablePin(""));
  assert.ok(!usablePin("SEE BELOW"));
  assert.ok(usablePin("82626R0001001"));
  assert.ok(usablePin("08250"));
});

// ---------------------------------------------------------------------------
// 3. AMENDMENTS
// ---------------------------------------------------------------------------

test("amendments: current ≠ original produces an explicit amendment event", () => {
  const registered = [{
    id: "C-1001", original: 5000000, current: 7500000, registered: "2025-04-01",
  }];
  const amendments = detectAmendments(registered);
  assert.equal(amendments.length, 1);
  assert.equal(amendments[0].delta, 2500000);
  assert.equal(amendments[0].date, "2025-04-01");
});

test("amendments: no amendment when current = original", () => {
  assert.deepEqual(detectAmendments([{ id: "C", original: 100, current: 100 }]), []);
  assert.deepEqual(detectAmendments([{ id: "C", original: 0, current: 100 }]), []);
});

// ---------------------------------------------------------------------------
// 4. NO-MATCH BEHAVIOR
// ---------------------------------------------------------------------------

test("no-match: empty Checkbook results produce explicit unmatched stages (never blank)", () => {
  const notice = {
    request_id: "X", agency_name: "Aging", type_of_notice_description: "Solicitation",
    start_date: "2025-01-10", short_title: "Meals", pin: "09876R0001001",
  };
  const result = assembleLifecycle(notice, [], [], [], {
    lookupStatus: { pending: "ok", registered: "ok", spending: "ok" },
  });

  for (const stage of ["pending", "registered", "payment"]) {
    const entry = result.timeline.find((t) => t.stage === stage);
    assert.equal(entry.status, "unmatched", `${stage} is explicitly unmatched`);
    assert.ok(entry.source, `${stage} still names its source`);
  }
  assert.deepEqual(result.amendments, []);
});

test("no-match: lookup errors produce unknown stages (distinct from unmatched)", () => {
  const notice = {
    request_id: "X", agency_name: "Aging", type_of_notice_description: "Solicitation",
    start_date: "2025-01-10", short_title: "Meals", pin: "09876R0001001",
  };
  const result = assembleLifecycle(notice, [], [], [], {
    lookupStatus: { pending: "error", registered: "error", spending: "error" },
  });

  assert.equal(result.ok, false);
  for (const stage of ["pending", "registered", "payment"]) {
    const entry = result.timeline.find((t) => t.stage === stage);
    assert.equal(entry.status, "unknown", `${stage} is unknown when the lookup failed`);
  }
});

// ---------------------------------------------------------------------------
// 5. CURSOR/CAP BEHAVIOR
// ---------------------------------------------------------------------------

test("cursor/cap: parser handles full-page and partial-page responses", () => {
  // Full page (25 records) — parser extracts all
  const full = Array.from({ length: 25 }, (_, i) => ({
    id: `C-${i}`, vendor: `V${i}`, pin: "P", status: "registered", current: "100",
  }));
  const parsed = parseContractTransactions(contractsXml(full));
  assert.equal(parsed.length, 25);

  // Partial page (3 records)
  const partial = parseContractTransactions(contractsXml(full.slice(0, 3)));
  assert.equal(partial.length, 3);
});

test("cursor/cap: spending parser handles full-page and partial-page responses", () => {
  const full = Array.from({ length: 25 }, (_, i) => ({
    id: `S-${i}`, vendor: `V${i}`, amount: "100", date: "2025-01-01",
  }));
  const parsed = parseSpendingTransactions(spendingXml(full));
  assert.equal(parsed.length, 25);
});

// ---------------------------------------------------------------------------
// 6. SOURCE TIMESTAMPS
// ---------------------------------------------------------------------------

test("source timestamps: each matched stage carries the upstream event date", () => {
  const notice = {
    request_id: "X", agency_name: "Sanitation", type_of_notice_description: "Solicitation",
    start_date: "2025-01-10", short_title: "S", pin: "08250",
  };
  const pending = [{ id: "C", received: "2025-03-15", start: "2025-03-01", current: 1000000, vendor: "V" }];
  const registered = [{ id: "C", registered: "2025-04-01", current: 1000000, original: 1000000, vendor: "V" }];
  const spending = [{ id: "S", amount: 50000, date: "2025-05-20", vendor: "V" }];

  const result = assembleLifecycle(notice, pending, registered, spending, {
    lookupStatus: { pending: "ok", registered: "ok", spending: "ok" },
  });

  const ts = Object.fromEntries(result.timeline.map((t) => [t.stage, t.source_timestamp]));
  assert.equal(ts.solicitation, "2025-01-10");
  assert.equal(ts.pending, "2025-03-15"); // received_date
  assert.equal(ts.registered, "2025-04-01"); // registration_date
  assert.equal(ts.payment, "2025-05-20"); // check_date
});

// ---------------------------------------------------------------------------
// 7. CLASSIFICATION: matched / unmatched / ambiguous / unknown
// ---------------------------------------------------------------------------

test("classification: 0 records → unmatched, 1 → matched, 2+ → ambiguous", () => {
  assert.equal(classifyStage([]), "unmatched");
  assert.equal(classifyStage([{}]), "matched");
  assert.equal(classifyStage([{}, {}]), "ambiguous");
  assert.equal(classifyStage(undefined), "unknown");
});

// ---------------------------------------------------------------------------
// 8. STAGE COMPLETENESS: every stage in STAGES appears in the timeline
// ---------------------------------------------------------------------------

test("stage completeness: STAGES constant lists all five procurement stages", () => {
  assert.deepEqual(STAGES, ["solicitation", "award", "pending", "registered", "payment"]);
});

test("stage completeness: a solicitation notice omits 'award'; an award notice omits 'solicitation'", () => {
  const base = { request_id: "X", agency_name: "A", start_date: "2025-01-01", short_title: "S", pin: "P" };

  const sol = assembleLifecycle(
    { ...base, type_of_notice_description: "Solicitation" }, [], [], [],
    { lookupStatus: { pending: "ok", registered: "ok", spending: "ok" } },
  );
  assert.ok(!sol.timeline.find((t) => t.stage === "award"), "solicitation notice has no award stage");
  assert.ok(sol.timeline.find((t) => t.stage === "solicitation"));

  const awd = assembleLifecycle(
    { ...base, type_of_notice_description: "Award", vendor_name: "V", contract_amount: "100" }, [], [], [],
    { lookupStatus: { pending: "ok", registered: "ok", spending: "ok" } },
  );
  assert.ok(!awd.timeline.find((t) => t.stage === "solicitation"), "award notice has no solicitation stage");
  assert.ok(awd.timeline.find((t) => t.stage === "award"));
});

// ---------------------------------------------------------------------------
// 9. AMBIGUOUS: multiple records → candidates listed
// ---------------------------------------------------------------------------

test("ambiguous: multiple registered contracts list candidates", () => {
  const notice = {
    request_id: "X", agency_name: "A", type_of_notice_description: "Solicitation",
    start_date: "2025-01-01", short_title: "S", pin: "P",
  };
  const registered = [
    { id: "C1", registered: "2025-04-01", current: 1000000, vendor: "V1" },
    { id: "C2", registered: "2025-04-05", current: 2000000, vendor: "V2" },
  ];
  const result = assembleLifecycle(notice, [], registered, [], {
    lookupStatus: { pending: "ok", registered: "ok", spending: "ok" },
  });

  const reg = result.timeline.find((t) => t.stage === "registered");
  assert.equal(reg.status, "ambiguous");
  assert.ok(reg.detail.candidates);
  assert.equal(reg.detail.candidates.length, 2);
});

// ---------------------------------------------------------------------------
// 10. CHECKBOOK SUCCESS DETECTION
// ---------------------------------------------------------------------------

test("checkbookSuccess: validates XML response status", () => {
  assert.ok(checkbookSuccess(contractsXml([{ id: "C" }])));
  assert.ok(checkbookSuccess(spendingXml([{ id: "S" }])));
  assert.ok(!checkbookSuccess("<response><status><result>failure</result></status></response>"));
  assert.ok(!checkbookSuccess(""));
  assert.ok(!checkbookSuccess(null));
});
