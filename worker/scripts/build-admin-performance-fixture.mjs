import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildAdminPerformanceResponse } from "../src/admin_performance.mjs";
import {
  buildPerformanceSnapshot,
  performanceAnalyticsQueryPlan,
} from "../src/lib/performance_query.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const QUERY_PATH = resolve(ROOT, "test/fixtures/performance_query_weighted.json");
const OUTPUT_PATH = resolve(ROOT, "test/fixtures/admin_performance_available.v1.json");

export function buildAvailableAdminPerformanceFixture() {
  const fixture = JSON.parse(readFileSync(QUERY_PATH, "utf8"));
  const plan = performanceAnalyticsQueryPlan(fixture.query, {
    now: fixture.now,
    configuredSince: fixture.configured_since,
    sampleFloor: fixture.sample_floor,
  });
  const snapshot = buildPerformanceSnapshot(fixture.sql_results, plan, {
    dataHealth: {
      status: "available",
      window_days: 7,
      accepted: 100,
      rejected: 2,
      rejected_by_reason: { unknown_surface: 1, unknown_component: 1 },
      unsupported: 0,
      excluded: { developer: 0, disabled: 0, non_production: 0 },
      storage: { status: "configured", configured_checks: 7, unavailable_checks: 0 },
      latest_accepted_at: "2026-08-19T14:00:00.000Z",
      latest_query_at: fixture.now,
      ingestion_delay_seconds: 1800,
    },
  });
  return buildAdminPerformanceResponse(snapshot);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const rendered = `${JSON.stringify(buildAvailableAdminPerformanceFixture(), null, 2)}\n`;
  if (process.argv.includes("--check")) {
    if (!existsSync(OUTPUT_PATH) || readFileSync(OUTPUT_PATH, "utf8") !== rendered) {
      console.error("admin performance fixture is stale");
      process.exit(1);
    }
    console.log("admin performance fixture ok");
  } else {
    writeFileSync(OUTPUT_PATH, rendered);
    console.log("wrote", OUTPUT_PATH);
  }
}
