import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildMoneyLedger, summarizeMoneyEvents, validateMoneyEvent } from "../worker/src/lib/money_events.mjs";

const source = JSON.parse(readFileSync(new URL("./fixtures/wave4/money-events.json", import.meta.url)));
const ledger = JSON.parse(readFileSync(new URL("./fixtures/wave4/generated/money_ledger.json", import.meta.url)));

test("award, registration, amendments, payments, and reversals stay typed", () => {
  for (const event of source.events) validateMoneyEvent(event);
  const types = new Set(source.events.map((event) => event.event_type));
  for (const type of ["awarded", "registered", "amended", "paid", "reversed"]) assert.ok(types.has(type));
});

test("award value never collapses into paid-to-date", () => {
  const process = ledger.processes.find((row) => row.process_id.includes("84124p0003001"));
  assert.equal(process.totals.amount_types.awarded.value, 1825000);
  assert.equal(process.totals.paid_net.value, 400000);
  assert.notEqual(process.totals.amount_types.awarded.value, process.totals.paid_net.value);
  assert.equal(process.totals.as_of, ledger.snapshot_date);
});

test("ledger build is deterministic and fiscal/source qualifiers survive", () => {
  assert.deepEqual(buildMoneyLedger(source.events, source.snapshot_date), ledger.processes);
  const selfReported = ledger.processes.flatMap((row) => row.events)
    .find((event) => event.quality === "self_reported_unverified");
  assert.equal(selfReported.authority_class, "IDA");
  assert.ok(selfReported.hearing_process_id);
  assert.equal(ledger.source_policies.paris_abo.reporting_threshold_usd, 5000);
});

test("late-contract lag is evidence and a candidate feature, never a verdict", () => {
  const late = ledger.late_contracts[0];
  assert.deepEqual(late.role, ["joined_evidence", "candidate_forecast_feature", "alarm_context"]);
  assert.doesNotMatch(JSON.stringify(late), /misconduct|corruption|overcharge/i);
});

test("invalid reversals are refused", () => {
  const paid = source.events.find((event) => event.event_type === "paid");
  assert.throws(() => validateMoneyEvent({...paid, event_type: "reversed", amount: 12}), /reversal/);
  assert.deepEqual(summarizeMoneyEvents([paid], "2026-07-28").paid_net, {currency: "USD", value: 412000});
});
