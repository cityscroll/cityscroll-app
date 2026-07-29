import {
  adaptAcceptanceRecord,
  adaptDdcProjectRow,
  adaptMtaCapitalRow,
  adaptPaymentProxy,
  strongestDeliveryEvidence,
  unknownDelivery
} from "../worker/src/lib/delivery_events.mjs";
import { readJson, sha256, writeOrCheck } from "./lib/wave4-build.mjs";

const check = process.argv.includes("--check");
const source = readJson("test/fixtures/wave4/delivery-events.json");
const events = [
  ...source.mta_capital_dashboard.map(adaptMtaCapitalRow),
  ...source.ddc_project_data.map(adaptDdcProjectRow),
  ...source.acceptance_records.map(adaptAcceptanceRecord),
  ...source.payment_proxies.map(adaptPaymentProxy),
  ...source.unknown_processes.map(unknownDelivery)
];
const processIds = [...new Set(events.map((event) => event.process_id))];

writeOrCheck("test/fixtures/wave4/generated/delivery_events.json", {
  schema_version: "1.0.0",
  snapshot_date: source.snapshot_date,
  source_snapshot_hash: sha256(source),
  coverage: {
    scope: "Wave 4 adapter fixtures",
    full_corpus: false,
    notice: source.fixture_notice,
    adapter_families: ["mta_capital_dashboard", "nyc_ddc_project_data"]
  },
  processes: processIds.map((process_id) => {
    const processEvents = events.filter((event) => event.process_id === process_id);
    return {
      process_id,
      delivery_status: strongestDeliveryEvidence(processEvents),
      events: processEvents
    };
  })
}, check);
