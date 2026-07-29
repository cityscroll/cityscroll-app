import { readJson, sha256, writeOrCheck } from "./lib/wave4-build.mjs";

const check = process.argv.includes("--check");
const spine = readJson("test/fixtures/wave4/generated/process_spine.json");
let ledger = null;
try {
  ledger = readJson("test/fixtures/wave4/generated/coverage_ledger.json");
} catch {}
const stages = [
  {
    stage: "planning",
    mapped_fields: ["buyer", "project_id"],
    source_systems: ["city_record"],
    completeness: "partial",
    missing_fields: ["planning/budget", "planning/rationale"],
    missing_reason: "not_published"
  },
  {
    stage: "tender",
    mapped_fields: ["tender/id", "tender/title", "tender/tenderPeriod"],
    source_systems: ["city_record"],
    completeness: "partial",
    missing_fields: ["tender/documents", "tender/numberOfTenderers"],
    missing_reason: "not_published"
  },
  {
    stage: "award",
    mapped_fields: ["awards/id", "awards/suppliers", "awards/value"],
    source_systems: ["city_record"],
    completeness: "mapped",
    missing_fields: [],
    missing_reason: null
  },
  {
    stage: "contract",
    mapped_fields: ["contracts/id", "contracts/value", "contracts/dateSigned"],
    source_systems: ["checkbook_nyc"],
    completeness: "partial",
    missing_fields: ["contracts/implementation"],
    missing_reason: "not_published"
  },
  {
    stage: "implementation",
    mapped_fields: [],
    source_systems: [],
    completeness: "missing",
    missing_fields: ["implementation/milestones", "implementation/transactions", "implementation/status"],
    missing_reason: "source_unavailable"
  }
];

writeOrCheck("test/fixtures/wave4/generated/ocds-gap-table.json", {
  schema_version: "1.0.0",
  snapshot_date: spine.snapshot_date,
  source_spine_hash: sha256(spine),
  source_coverage_hash: ledger ? sha256(ledger) : null,
  coverage: spine.coverage,
  stages: stages.map((stage) => ({
    ...stage,
    counts: ledger?.aggregate?.[stage.stage] || null
  }))
}, check);
