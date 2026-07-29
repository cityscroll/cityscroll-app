import assert from "node:assert/strict";
import { readJson } from "./lib/wave4-build.mjs";
import { summarizeMoneyEvents } from "../worker/src/lib/money_events.mjs";

if (!process.argv.includes("--fixtures")) throw new Error("use --fixtures for the bounded reconciliation");
const source = readJson("test/fixtures/wave4/money-events.json");
const ledger = readJson("test/fixtures/wave4/generated/money_ledger.json");

for (const process of ledger.processes) {
  const events = source.events.filter((event) => event.process_id === process.process_id);
  assert.deepEqual(process.totals, summarizeMoneyEvents(events, source.snapshot_date));
  assert.notEqual(process.totals.amount_types.awarded.value, process.totals.paid_net.value,
    "award value and cash paid must remain separate");
}

const abo = source.events.filter((event) => event.source_system === "paris_abo");
assert.ok(abo.every((event) => event.quality === "self_reported_unverified"));
assert.ok(abo.every((event) => event.amount >= ledger.source_policies.paris_abo.reporting_threshold_usd));
console.log(`reconciled ${ledger.processes.length} fixture ledgers`);
