/**
 * Operator exception overview: denominators, distinct conditions, and
 * cadence versus tolerated served age.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  DESK_CONSUMER_CONTRACT_PATH,
  HTML_OUTPUT,
  JSON_OUTPUT,
  ROOT,
  buildDataSourceGraph,
  generatedGraphFiles,
  renderGraphHtml,
} from "../tools/data_source_graph.mjs";
import {
  ACTIONABLE_CONDITIONS,
  OPERATOR_CONDITION_IDS,
  buildOperatorOverview,
} from "../tools/desk_health_overview.mjs";
import { buildRepairQueue, repairIssueKey } from "../tools/repair_queue.mjs";
import { buildRepairObservation } from "../tools/repair_observations.mjs";

const readJson = (path) => JSON.parse(readFileSync(join(ROOT, path), "utf8"));

const AS_OF = "2026-09-05T13:44:00.909Z";

function contract(overrides = {}) {
  return {
    id: "fixture-source",
    name: "Fixture Source",
    owner: "Fixture Publisher",
    status: "live",
    scope: "runtime",
    kind: "socrata",
    landing_page: "https://example.test/source",
    publisher_cadence: "Daily",
    product_freshness: "Daily acquisition.",
    used_for: "A fixture surface that must not be inferred as a product use.",
    delivery_tier: "edge-materialized",
    code_references: [{ path: "tools/data_source_graph.mjs", contains: "buildDataSourceGraph" }],
    freshness_contract: {
      mode: "periodic",
      max_stale_days: 45,
      clock_basis: "checked_acquired",
      serving_max_age_days: 45,
    },
    ...overrides,
  };
}

function observation(sourceId, overrides = {}) {
  return {
    source_id: sourceId,
    contract_fingerprint: "a".repeat(64),
    health: {
      status: "Healthy",
      reason_codes: [],
      clocks: {
        publisher_updated: { at: null, state: "UNKNOWN", basis: null },
        cityscroll_checked_acquired: { at: "2026-09-05T12:00:00.000Z", state: "KNOWN", basis: "acquired_at" },
        cityscroll_serving: { at: "2026-09-05T12:00:00.000Z", state: "KNOWN", basis: "serving" },
      },
    },
    freshness_watchdog: {
      status: "CURRENT",
      reason_codes: [],
      source_contract_id: sourceId,
      observed_at: AS_OF,
    },
    ...overrides,
  };
}

function artifact(overrides = {}) {
  return {
    id: "contracts-registered",
    public_artifact_path: "site/data/analytics_registered_contracts.json",
    primary_routes: ["/browse/contracts/"],
    source_contract_id: "fixture-source",
    normal_refresh_cadence_hours: 24,
    vintage_fields: ["generated_at"],
    ...overrides,
  };
}

test("A1 default overview reports three separate denominators and the exception columns", () => {
  const files = generatedGraphFiles();
  const graph = JSON.parse(files[JSON_OUTPUT]);
  const html = files[HTML_OUTPUT];
  const overview = graph.operator_overview;
  assert.equal(overview.status, "available");
  assert.equal(overview.all_clear, false);
  assert.equal(typeof overview.denominators.actionable_conditions, "number");
  assert.equal(typeof overview.denominators.affected_sources, "number");
  assert.equal(typeof overview.denominators.insufficient_monitoring, "number");
  assert.ok(overview.denominators.definition.actionable_conditions.includes("Distinct actionable condition"));
  assert.ok(overview.denominators.definition.affected_sources.includes("Distinct canonical sources"));
  assert.match(html, /data-denominator="actionable-conditions"/);
  assert.match(html, /data-denominator="affected-sources"/);
  assert.match(html, /data-denominator="insufficient-monitoring"/);
  assert.match(html, /<th>Source<\/th><th>Product uses<\/th><th>Interval<\/th><th>Last success<\/th><th>Served vintage<\/th><th>Condition<\/th><th>Repair state<\/th>/);
  assert.match(html, /id="overviewToggle"/);
  assert.match(html, /aria-pressed="true">Source health</);
  assert.match(html, /id="graphView" hidden/);
  assert.match(html, />Departments</);
  assert.match(html, /id="productFilter"/);
  assert.match(html, /<label for="productFilter">Product<\/label>/);
  assert.match(html, /<label for="publisherFilter">Publisher<\/label>/);
  assert.match(html, /<label for="conditionFilter">Condition<\/label>/);
  assert.match(html, /<label for="modeFilter">Mode<\/label>/);
});

test("A1 missing health input never yields zero exceptions or an all-clear", () => {
  const built = buildDataSourceGraph({
    registry: { contracts: [contract()], first_class_artifacts: [artifact()] },
    healthObservations: null,
    inputs: [],
  });
  assert.equal(built.operator_overview.status, "unavailable");
  assert.equal(built.operator_overview.denominators.actionable_conditions, null);
  assert.equal(built.operator_overview.denominators.affected_sources, null);
  assert.equal(built.operator_overview.denominators.insufficient_monitoring, null);
  assert.equal(built.operator_overview.all_clear, false);
  const html = renderGraphHtml(built);
  assert.match(html, /data-overview-status="unavailable"/);
  assert.match(html, /This is not an all-clear/);
  assert.doesNotMatch(html, /data-denominator="actionable-conditions">0 /);
});

test("A2 Checkbook 45-day tolerance never implies the daily acquisition ran recently", () => {
  const graph = JSON.parse(generatedGraphFiles()[JSON_OUTPUT]);
  const row = graph.operator_overview.rows.find((item) => item.source_id === "checkbook-contracts");
  assert.ok(row, "checkbook-contracts is in the overview");
  assert.equal(row.serving_max_age_days, 45);
  assert.equal(row.cadence_compliance, "overdue");
  assert.ok(["within_tolerance", "measured", "unknown"].includes(row.served_age));
  assert.ok(row.conditions.includes("cadence-noncompliant"));
  assert.ok(row.conditions.includes("unknown-publisher-timestamp"));
  const html = generatedGraphFiles()[HTML_OUTPUT];
  const slice = html.slice(html.indexOf('data-overview-row="checkbook-contracts"'));
  const rowHtml = slice.slice(0, slice.indexOf("</tr>"));
  assert.match(rowHtml, /cadence overdue/);
  assert.doesNotMatch(rowHtml, /ran recently/);
  assert.ok(!rowHtml.includes("Healthy daily"), "serving tolerance is not a daily-acquisition claim");
});

test("A2 historical, manual, disabled, candidate, unknown publisher, missing monitoring, and failed acquisition stay distinct", () => {
  const historical = contract({ id: "hist", name: "Historical Fixture", freshness_contract: { mode: "historical", max_stale_days: 45, serving_max_age_days: 45 } });
  const manual = contract({ id: "man", name: "Manual Fixture", status: "manual", freshness_contract: { mode: "manual-conditional", max_stale_days: 45, serving_max_age_days: 45 } });
  const disabled = contract({ id: "dis", name: "Disabled Fixture", status: "disabled" });
  const live = contract({ id: "live-fail", name: "Failed Fixture" });
  const health = {
    generated_at: AS_OF,
    observations: [
      observation("hist", { health: { status: "Historical", reason_codes: ["historical-source"], clocks: observation("hist").health.clocks } }),
      observation("man", { health: { status: "Manual-refresh", reason_codes: ["manual-refresh-due"], clocks: observation("man").health.clocks } }),
      observation("dis"),
      observation("live-fail", {
        health: {
          status: "Source-unavailable",
          reason_codes: ["acquisition-failed"],
          clocks: {
            publisher_updated: { at: null, state: "UNKNOWN", basis: null },
            cityscroll_checked_acquired: { at: null, state: "UNKNOWN", basis: null },
            cityscroll_serving: { at: null, state: "UNKNOWN", basis: null },
          },
        },
        freshness_watchdog: { status: "STALE", reason_codes: ["monitor-missing"], source_contract_id: "live-fail" },
      }),
    ],
  };
  const built = buildDataSourceGraph({
    registry: {
      contracts: [historical, manual, disabled, live],
      first_class_artifacts: [artifact({ source_contract_id: "live-fail" })],
    },
    healthObservations: health,
    gapTaxonomy: {
      sources: [{
        id: "cand",
        name: "Candidate Fixture",
        source_contract_id: null,
        status: "not_ingested",
        join_keys: ["id"],
        landing_page: "https://example.test/candidate",
        delivery_tier: "live-only",
      }],
    },
    inputs: [],
  });
  const byId = new Map(built.operator_overview.rows.map((row) => [row.source_id, row]));
  assert.ok(byId.get("hist").conditions.includes("historical"));
  assert.ok(byId.get("man").conditions.includes("manual"));
  assert.ok(byId.get("dis").conditions.includes("disabled"));
  assert.ok(byId.get("cand").conditions.includes("candidate"));
  assert.ok(byId.get("live-fail").conditions.includes("failed-acquisition"));
  assert.ok(byId.get("live-fail").conditions.includes("unknown-publisher-timestamp"));
  assert.ok(byId.get("live-fail").conditions.includes("missing-required-monitoring"));
  const html = renderGraphHtml(built);
  for (const label of ["Historical", "Manual", "Disabled", "Candidate", "Unknown publisher timestamp", "Missing required monitoring", "Failed acquisition"]) {
    assert.match(html, new RegExp(label));
  }
});

test("A2 inventory modes do not inflate the three active denominators", () => {
  const overview = buildOperatorOverview({
    sources: [
      { id: "dis", name: "Disabled", node_class: "source-contract", status: "disabled", body: "P", health: { status: "Source-unavailable", reason_codes: [] }, clocks: { publisher_updated: { state: "UNKNOWN" }, cityscroll_checked_acquired: { state: "UNKNOWN" }, cityscroll_serving: { state: "UNKNOWN" } }, freshness_watchdog: { status: "STALE", reason_codes: ["monitor-missing"] }, runs: [], serving_fallback: { active: false } },
      { id: "live", name: "Live", node_class: "source-contract", status: "live", body: "P", health: { status: "Source-unavailable", reason_codes: ["acquisition-failed"] }, clocks: { publisher_updated: { state: "UNKNOWN" }, cityscroll_checked_acquired: { state: "UNKNOWN" }, cityscroll_serving: { state: "UNKNOWN" } }, freshness_watchdog: { status: "STALE", reason_codes: ["monitor-missing"] }, runs: [], serving_fallback: { active: false } },
    ],
    contracts: [
      contract({ id: "dis", status: "disabled" }),
      contract({ id: "live" }),
    ],
    firstClassArtifacts: [artifact({ source_contract_id: "live" })],
    asOf: AS_OF,
    artifactVintageByPath: new Map(),
  });
  assert.equal(overview.denominators.affected_sources, 1);
  assert.equal(overview.denominators.insufficient_monitoring, 1);
  assert.ok(overview.denominators.actionable_conditions >= 1);
  assert.ok(ACTIONABLE_CONDITIONS.every((id) => OPERATOR_CONDITION_IDS.includes(id)));
});

test("A5 filters, selected source, dismiss, retry, and modified-click native links are in the producer", () => {
  const html = generatedGraphFiles()[HTML_OUTPUT];
  assert.match(html, /function filterOverview\(\)/);
  assert.match(html, /function isModifiedClick\(event\)/);
  assert.match(html, /event\.metaKey\|\|event\.ctrlKey\|\|event\.shiftKey\|\|event\.altKey/);
  assert.match(html, /function dismissDetail\(\)/);
  assert.match(html, /id="retryDetail"/);
  assert.match(html, /id="dismissDetail"/);
  assert.match(html, /params\.get\("product"\)/);
  assert.match(html, /params\.get\("publisher"\)/);
  assert.match(html, /params\.get\("condition"\)/);
  assert.match(html, /params\.get\("mode"\)/);
  assert.match(html, /window\.addEventListener\("popstate"/);
  assert.match(html, /min-height:44px/);
  assert.match(html, /overview-table-wrap\{max-width:100%;min-width:0;width:100%;contain:inline-size;overflow-x:auto/);
  assert.match(html, /overflow-wrap:anywhere;white-space:normal/);
  assert.match(html, /The remaining source register is still available/);
  assert.doesNotMatch(html, /refresh publishers|write a card|perform a repair/i);
});

test("A6 retained deployed parity manifests stay bound to their recorded data revision", () => {
  const manifest = readJson("docs/evidence/desk-source-state-parity/capture-manifest.json");
  const before = readJson("docs/evidence/desk-source-state-parity/before.json");
  assert.equal(manifest.data_revision, "0e958926826dadbd0ce9d5996687c821ec196220157b61e648a6d6e349b9405a");
  assert.equal(before.structured_state.data_revision, "ea77100f9a63a8c07f9e60858c72ea69d4c98be310be165a4d60625cd9e8959f");
  assert.equal(manifest.route, "/data-sources?source=checkbook-contracts#source-checkbook-contracts");
  for (const capture of manifest.captures) {
    assert.match(capture.render_content_sha256, /^[a-f0-9]{64}$/);
    assert.ok(Array.isArray(capture.viewport));
  }
  const contract = readJson(DESK_CONSUMER_CONTRACT_PATH);
  assert.equal(contract.extensions.operator_overview.version, 1);
});

test("inspection client never fetches, writes cards, or enqueues repairs", () => {
  const html = generatedGraphFiles()[HTML_OUTPUT];
  const script = html.slice(html.indexOf("<script>"));
  assert.doesNotMatch(script, /\bfetch\(/);
  assert.doesNotMatch(script, /XMLHttpRequest/);
  assert.doesNotMatch(script, /repairQueue\.push|enqueueRepair|writeCard/);
});
