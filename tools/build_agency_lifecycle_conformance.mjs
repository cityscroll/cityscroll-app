#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AGENCY_LIFECYCLE_CONFORMANCE_METHOD,
  AGENCY_LIFECYCLE_CONFORMANCE_SCHEMA,
  buildAgencyLifecycleConformanceView,
} from "../site/agency_lifecycle_conformance.mjs";
import { buildProcurementEventLogEnvelope } from "../site/procurement_event_log.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INPUT = join(ROOT, "worker/test/fixtures/lifecycle-coherence/procurement_event_log_cases.json");
const OUTPUT = join(ROOT, "site/data/agency_lifecycle_conformance_lookup.json");

export function buildAgencyLifecycleConformanceLookup(input) {
  const grouped = new Map();
  for (const row of Array.isArray(input?.cases) ? input.cases : []) {
    if (!row?.agency_id || !row?.agency_name || row.fixture_kind === "synthetic") continue;
    if (!grouped.has(row.agency_id)) {
      grouped.set(row.agency_id, { agency_name: row.agency_name, cases: [] });
    }
    grouped.get(row.agency_id).cases.push(buildProcurementEventLogEnvelope(row));
  }
  const byAgency = {};
  for (const [agencyId, group] of grouped) {
    const view = buildAgencyLifecycleConformanceView({
      agency_id: agencyId,
      agency_name: group.agency_name,
      lifecycle_id: "procurement",
      lifecycle_label: "Procurement lifecycle",
      cases: group.cases,
    });
    if (view.status === "matched") byAgency[agencyId] = view;
  }
  const days = Object.values(byAgency).map((view) => view.data_as_of).filter(Boolean).sort();
  return {
    schema: `${AGENCY_LIFECYCLE_CONFORMANCE_SCHEMA}.lookup`,
    method: AGENCY_LIFECYCLE_CONFORMANCE_METHOD,
    generated_at: days.length ? `${days[0]}T00:00:00.000Z` : null,
    agency_count: Object.keys(byAgency).length,
    by_agency: byAgency,
  };
}

export function writeAgencyLifecycleConformanceLookup({ check = false } = {}) {
  const input = JSON.parse(readFileSync(INPUT, "utf8"));
  const output = `${JSON.stringify(buildAgencyLifecycleConformanceLookup(input), null, 2)}\n`;
  const stale = !existsSync(OUTPUT) || readFileSync(OUTPUT, "utf8") !== output;
  if (check && stale) {
    console.error("Agency lifecycle conformance lookup is stale; rebuild it before continuing");
    process.exitCode = 1;
    return;
  }
  if (!check && stale) writeFileSync(OUTPUT, output);
  console.log(stale ? "Agency lifecycle conformance lookup built" : "Agency lifecycle conformance lookup is current");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeAgencyLifecycleConformanceLookup({ check: process.argv.includes("--check") });
}
