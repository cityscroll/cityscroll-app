#!/usr/bin/env node

import { readFileSync } from "node:fs";

import { classifyCityRecordRuleStage } from "../site/rule_stage.mjs";

const fixture = new URL(
  "../warehouse/fixtures/city-record-agency-rules/agency_rules_history.json",
  import.meta.url,
);
const rows = JSON.parse(readFileSync(fixture, "utf8"));
const generic = rows.filter(
  (row) => String(row?.type_of_notice_description || "").trim().toLowerCase() === "notice",
);
const conflicts = generic
  .map((row) => ({ request_id: row.request_id, stage: classifyCityRecordRuleStage(row) }))
  .filter((row) => row.stage);
const byStage = {};
for (const row of conflicts) byStage[row.stage] = (byStage[row.stage] || 0) + 1;

console.log(JSON.stringify({
  corpus: "warehouse/fixtures/city-record-agency-rules/agency_rules_history.json",
  total_records: rows.length,
  generic_notice_records: generic.length,
  generic_notice_with_specific_lifecycle_stage: conflicts.length,
  by_stage: byStage,
}, null, 2));
