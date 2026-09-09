#!/usr/bin/env node
// Remeasure the served population without changing frozen publisher reviews,
// acquisition receipts, disposition decisions, or their historical dates.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { readProcurementBrowsePopulation } from "../../tools/lib/procurement_browse_population_io.mjs";

const path = "warehouse/fixtures/authority-native-procurement/institution_source_census.v1.json";
const census = JSON.parse(readFileSync(path));
const browse = readProcurementBrowsePopulation("site/data/procurement_browse_rows.json");
const spine = JSON.parse(readFileSync("site/data/procurement_spine_sources.json"));
const shared = JSON.parse(readFileSync("site/data/shared_procurement_read_model.json"));
const sources = (row) => [...new Set(row.source_systems || (row.source_observation_refs || []).map((ref) => ref.split(":", 1)[0]))];
const countsFor = (rows) => {
  const counts = { city_record: 0, passport_public_contracts: 0, checkbook_contracts: 0 };
  const combinations = {};
  for (const row of rows) {
    const names = sources(row).filter((name) => Object.hasOwn(counts, name)).sort();
    for (const name of names) counts[name] += 1;
    const key = names.join("+");
    combinations[key] = (combinations[key] || 0) + 1;
  }
  return { counts, combinations };
};
for (const entry of Object.values(census.existing_snapshot.artifacts)) {
  entry.sha256 = createHash("sha256").update(readFileSync(entry.path)).digest("hex");
}
census.existing_snapshot.artifacts.browse_rows.row_count = browse.rows.length;
census.existing_snapshot.artifacts.spine_sources.passport_contract_rows = spine.rows.passport_contracts.length;
census.existing_snapshot.artifacts.shared_read_model.object_count = shared.counts.total;
census.existing_snapshot.generated_at = shared.generated_at;
census.existing_snapshot.served_source_counts = countsFor(browse.rows).counts;
const doe = browse.rows.filter((row) => /department of education|^education$|education admin|^doe$/i.test(row.agency_name || ""));
const { counts, combinations } = countsFor(doe);
const measured = census.doe_missing_record_census;
// source_snapshot_generated_at and source_row_counts belong to the frozen
// source review. These new served counts have their own materialization clock.
measured.served_measurement = { artifact: "site/data/procurement_browse_rows.json", generated_at: shared.generated_at };
measured.doe_canonical_rows = doe.length;
measured.doe_rows_by_source = counts;
measured.doe_source_combinations = combinations;
measured.already_served_rows = {
  checkbook_only: combinations.checkbook_contracts || 0,
  passport_only: combinations.passport_public_contracts || 0,
  city_record_and_passport: combinations["city_record+passport_public_contracts"] || 0,
  all_three: combinations["checkbook_contracts+city_record+passport_public_contracts"] || 0,
  total: doe.length,
};
writeFileSync(path, `${JSON.stringify(census, null, 2)}\n`);
console.log("Recounted served institution census; frozen source review was not repeated.");
