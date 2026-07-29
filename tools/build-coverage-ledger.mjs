import { aggregateCoverage, validateCoverageEntry } from "../worker/src/lib/coverage_ledger.mjs";
import { readJson, sha256, writeOrCheck } from "./lib/wave4-build.mjs";

const check = process.argv.includes("--check");
const spine = readJson("test/fixtures/wave4/generated/process_spine.json");
const byProcess = new Map();
for (const event of spine.events) {
  const events = byProcess.get(event.process_id) || [];
  events.push(event);
  byProcess.set(event.process_id, events);
}
const expected = {
  planning: ["buyer", "budget", "rationale"],
  tender: ["id", "title", "tender_period", "documents", "number_of_tenderers"],
  award: ["id", "supplier", "value"],
  contract: ["id", "value", "date_signed", "implementation"],
  implementation: ["milestones", "transactions", "status"]
};
const eventStage = (type) => type.split(".")[0] === "tender"
  ? "tender"
  : type.split(".")[0] === "award"
    ? "award"
    : type.split(".")[0] === "contract"
      ? "contract"
      : null;
const observedByType = {
  "tender.notice": ["id", "title", "tender_period"],
  "award.notice": ["id", "supplier", "value"],
  "contract.registered": ["id", "value", "date_signed"]
};

const entries = [];
for (const [processId, events] of byProcess) {
  for (const stage of Object.keys(expected)) {
    const stageEvents = events.filter((event) => eventStage(event.event_type) === stage);
    const confirmed = stageEvents.find((event) => event.join.confidence === "confirmed") || stageEvents[0];
    const observed = [...new Set(stageEvents.flatMap((event) => observedByType[event.event_type] || []))].sort();
    let reason = null;
    if (observed.length < expected[stage].length) {
      reason = stageEvents.some((event) => event.join.confidence === "review")
        ? "unresolved_join"
        : stage === "implementation"
          ? "source_unavailable"
          : "not_published";
    }
    entries.push(validateCoverageEntry({
      process_id: processId,
      stage,
      expected_fields: expected[stage],
      observed_fields: observed,
      source_url: confirmed?.source_url || null,
      source_key: confirmed?.source_key || null,
      fetch_status: confirmed ? "ok" : "not_fetched",
      schema_version: "1.0.0",
      last_success_at: confirmed?.observed_at || null,
      content_hash: confirmed?.content_hash || null,
      join_method: confirmed?.join.method || null,
      join_confidence: confirmed?.join.confidence || "unmatched",
      missing_reason: reason,
      stale: false
    }));
  }
}

const ledger = {
  schema_version: "1.0.0",
  snapshot_date: spine.snapshot_date,
  source_spine_hash: sha256(spine),
  coverage: {
    scope: spine.coverage.scope,
    full_corpus: spine.coverage.full_corpus,
    process_count: byProcess.size
  },
  source_policies: {
    paris_abo: {
      data_quality: "self_reported_unverified",
      reporting_threshold_usd: 5000,
      blank_amount_semantics: "unknown_not_zero"
    }
  },
  processes: [...byProcess.keys()].map((processId) => ({
    process_id: processId,
    stages: entries.filter((entry) => entry.process_id === processId)
  })),
  aggregate: aggregateCoverage(entries)
};

writeOrCheck("test/fixtures/wave4/generated/coverage_ledger.json", ledger, check);
