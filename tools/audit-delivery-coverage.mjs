import assert from "node:assert/strict";
import { readJson } from "./lib/wave4-build.mjs";

if (!process.argv.includes("--fixtures")) throw new Error("use --fixtures for the bounded adapter audit");
const bundle = readJson("data/delivery_events.json");
assert.deepEqual(bundle.coverage.adapter_families, ["mta_capital_dashboard", "nyc_ddc_project_data"]);
const events = bundle.processes.flatMap((process) => process.events);
assert.ok(events.some((event) => event.evidence_level === "direct_acceptance"));
assert.ok(events.some((event) => event.evidence_level === "published_milestone"));
assert.ok(events.some((event) => event.evidence_level === "payment_proxy"));
assert.ok(events.some((event) => event.evidence_level === "unknown"));
assert.ok(events.filter((event) => event.delivery_status === "unknown").every((event) => event.missing_reason));
console.log(`audited ${events.length} delivery events across ${bundle.coverage.adapter_families.length} adapter families`);
