import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  adaptDdcProjectRow,
  adaptMtaCapitalRow,
  adaptPaymentProxy,
  strongestDeliveryEvidence,
  validateDeliveryEvent
} from "../worker/src/lib/delivery_events.mjs";

const source = JSON.parse(readFileSync(new URL("./fixtures/wave4/delivery-events.json", import.meta.url)));
const bundle = JSON.parse(readFileSync(new URL("./fixtures/wave4/generated/delivery_events.json", import.meta.url)));
const events = bundle.processes.flatMap((process) => process.events);

test("two public source families implement the bounded adapter contract", () => {
  const mta = adaptMtaCapitalRow(source.mta_capital_dashboard[0]);
  const ddc = adaptDdcProjectRow(source.ddc_project_data[0]);
  assert.equal(mta.source, "MTA Capital Program Dashboard");
  assert.equal(ddc.source, "NYC DDC project data");
  for (const event of [mta, ddc]) validateDeliveryEvent(event);
});

test("payment is labeled as a proxy and cannot imply completion", () => {
  const proxy = adaptPaymentProxy(source.payment_proxies[0]);
  assert.equal(proxy.evidence_level, "payment_proxy");
  assert.equal(proxy.delivery_status, "unknown");
  assert.match(proxy.label, /not established/);
  assert.throws(() => validateDeliveryEvent({...proxy, delivery_status: "complete"}), /cannot establish/);
});

test("direct acceptance outranks milestone and payment evidence", () => {
  const process = bundle.processes.find((row) => row.events.some((event) => event.evidence_level === "direct_acceptance"));
  assert.equal(strongestDeliveryEvidence(process.events).evidence_level, "direct_acceptance");
  assert.equal(process.delivery_status.delivery_status, "accepted");
});

test("no public delivery source renders unknown rather than inferred completion", () => {
  const unknown = events.find((event) => event.evidence_level === "unknown");
  assert.equal(unknown.delivery_status, "unknown");
  assert.equal(unknown.missing_reason, "not_published");
  assert.ok(unknown.sources_checked.length >= 2);
});
