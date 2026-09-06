/**
 * Operator overview joins declared artifacts and the existing repair-queue
 * identity. It does not infer dependency edges from labels and does not
 * create a second diagnostic contract.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  HTML_OUTPUT,
  JSON_OUTPUT,
  ROOT,
  buildDataSourceGraph,
  generatedGraphFiles,
  renderGraphHtml,
} from "../tools/data_source_graph.mjs";
import { buildOperatorOverview, publicReference } from "../tools/desk_health_overview.mjs";
import {
  buildRepairQueue,
  repairIssueKey,
} from "../tools/repair_queue.mjs";
import { buildRepairObservation } from "../tools/repair_observations.mjs";

const readJson = (path) => JSON.parse(readFileSync(join(ROOT, path), "utf8"));
const AS_OF = "2026-09-05T13:44:00.909Z";

function observation({
  scope = "fixture-cb-01:upcoming_meetings",
  condition = "source-retrieval-failed",
  adapter = "html_pdf_v1",
  contractId = "board-sources",
} = {}) {
  return buildRepairObservation({
    condition,
    detail_code: "source_not_checked",
    source_contract_id: contractId,
    source_id: scope,
    adapter,
    origin_url: "https://example.gov/fixture/calendar",
    scope_kind: "community_board_source_role",
    scope_id: scope,
    body_id: scope.split(":")[0],
    role: scope.split(":")[1],
    affected_record_count: 0,
    publisher: "Fixture Community Board",
    code_paths: ["site/community_board_source_adapters.mjs"],
    observed_at: AS_OF,
    source_vintage: AS_OF,
    code_revision: "ca8ad3ee60fb2678",
    evidence_locator: "site/data/community_board_meeting_index.json#/receipts/0",
    receipt_ref: "site/data/non_council_outcome_sources/verification_receipts/fixture.json",
    receipt_status: "unknown",
    fetch_status: "browser-required",
  });
}

test("A3 Contracts filter reaches declared registered and payment artifacts for Checkbook", () => {
  const graph = JSON.parse(generatedGraphFiles()[JSON_OUTPUT]);
  const html = generatedGraphFiles()[HTML_OUTPUT];
  const contracts = graph.operator_overview.rows.find((row) => row.source_id === "checkbook-contracts");
  const spending = graph.operator_overview.rows.find((row) => row.source_id === "checkbook-spending");
  assert.ok(contracts);
  assert.ok(spending);
  assert.ok(contracts.product_families.includes("contracts"));
  assert.ok(spending.product_families.includes("contracts"));
  assert.ok(contracts.product_uses.some((use) => use.artifact_id === "contracts-registered" && use.public_artifact_path === "site/data/analytics_registered_contracts.json"));
  assert.ok(spending.product_uses.some((use) => use.artifact_id === "contracts-payments" && use.public_artifact_path === "site/data/analytics_payments.json"));
  assert.ok(contracts.product_uses.every((use) => use.primary_routes.includes("/browse/contracts/")));
  assert.ok(spending.product_uses.every((use) => use.primary_routes.includes("/browse/contracts/")));
  assert.match(html, /data-product-route="\/browse\/contracts\/"/);
  assert.match(html, /analytics_registered_contracts\.json/);
  assert.match(html, /analytics_payments\.json/);
});

test("A3 fresh acquisition with stale serving, eligible fallback, failed stage, and unverified edges", () => {
  const freshStale = {
    id: "fresh-stale",
    name: "Fresh Stale Fixture",
    owner: "Fixture Publisher",
    status: "live",
    scope: "runtime",
    kind: "socrata",
    landing_page: "https://example.test/fresh",
    publisher_cadence: "Daily",
    product_freshness: "Daily.",
    used_for: "Money contracts payments that must not become a declared edge.",
    delivery_tier: "edge-materialized",
    code_references: [{ path: "tools/data_source_graph.mjs", contains: "buildDataSourceGraph" }],
    freshness_contract: { mode: "periodic", max_stale_days: 45, clock_basis: "checked_acquired", serving_max_age_days: 45 },
  };
  const fallback = {
    ...freshStale,
    id: "fallback-source",
    name: "Fallback Fixture",
    used_for: "Meetings land property labels also must not invent a route.",
  };
  const unlabeled = {
    ...freshStale,
    id: "unlabeled-source",
    name: "Unlabeled Fixture",
    used_for: "Contracts payments registered awards still unverified without a declared artifact.",
  };
  const health = {
    generated_at: AS_OF,
    observations: [
      {
        source_id: "fresh-stale",
        health: {
          status: "Degraded",
          reason_codes: ["serving-clock-stale"],
          clocks: {
            publisher_updated: { at: "2026-09-05T12:00:00.000Z", state: "KNOWN", basis: "publisher" },
            cityscroll_checked_acquired: { at: "2026-09-05T12:00:00.000Z", state: "KNOWN", basis: "acquired_at" },
            cityscroll_serving: { at: "2026-07-01T00:00:00.000Z", state: "KNOWN", basis: "serving" },
          },
        },
        freshness_watchdog: { status: "CURRENT", reason_codes: [], source_contract_id: "fresh-stale" },
        operator: {
          runs: [
            { adapter: "serve-stage", status: "failed", at: AS_OF, exact_error: "serve timeout", run_id: "serve-1" },
            { adapter: "acquire-stage", status: "succeeded", at: AS_OF, run_id: "acq-1" },
          ],
        },
      },
      {
        source_id: "fallback-source",
        health: {
          status: "Degraded",
          reason_codes: ["acquisition-failed", "serving-valid-fallback"],
          clocks: {
            publisher_updated: { at: "2026-09-01T00:00:00.000Z", state: "KNOWN", basis: "publisher" },
            cityscroll_checked_acquired: { at: "2026-09-05T10:00:00.000Z", state: "KNOWN", basis: "acquired_at" },
            cityscroll_serving: { at: "2026-09-04T00:00:00.000Z", state: "KNOWN", basis: "serve_contract:fixture" },
          },
        },
        serving: { status: "fallback" },
        freshness_watchdog: { status: "CURRENT", reason_codes: [], source_contract_id: "fallback-source" },
      },
      {
        source_id: "unlabeled-source",
        health: {
          status: "Healthy",
          reason_codes: [],
          clocks: {
            publisher_updated: { at: "2026-09-05T12:00:00.000Z", state: "KNOWN", basis: "publisher" },
            cityscroll_checked_acquired: { at: "2026-09-05T12:00:00.000Z", state: "KNOWN", basis: "acquired_at" },
            cityscroll_serving: { at: "2026-09-05T12:00:00.000Z", state: "KNOWN", basis: "serving" },
          },
        },
        freshness_watchdog: { status: "CURRENT", reason_codes: [], source_contract_id: "unlabeled-source" },
      },
    ],
  };
  const built = buildDataSourceGraph({
    registry: {
      contracts: [freshStale, fallback, unlabeled],
      first_class_artifacts: [{
        id: "contracts-registered",
        public_artifact_path: "site/data/analytics_registered_contracts.json",
        primary_routes: ["/browse/contracts/"],
        source_contract_id: "fresh-stale",
        normal_refresh_cadence_hours: 24,
        vintage_fields: ["generated_at"],
      }],
    },
    healthObservations: health,
    inputs: [],
  });
  const byId = new Map(built.operator_overview.rows.map((row) => [row.source_id, row]));
  assert.ok(byId.get("fresh-stale").conditions.includes("fresh-acquisition-stale-serving"));
  assert.ok(byId.get("fresh-stale").failed_stages.some((stage) => stage.adapter === "serve-stage"));
  assert.ok(byId.get("fresh-stale").healthy_siblings.some((stage) => stage.adapter === "acquire-stage"));
  assert.ok(byId.get("fallback-source").conditions.includes("eligible-fallback"));
  assert.ok(byId.get("fallback-source").conditions.includes("failed-acquisition"));
  assert.equal(byId.get("unlabeled-source").dependency_edge, "unverified");
  assert.deepEqual(byId.get("unlabeled-source").product_uses, []);
  assert.ok(byId.get("unlabeled-source").conditions.includes("unknown-dependency"));
  const html = renderGraphHtml(built);
  assert.match(html, /data-dependency="unverified"/);
  assert.doesNotMatch(html, /inferred from label/);
  const unlabeledHtml = html.slice(html.indexOf('data-overview-row="unlabeled-source"'));
  assert.doesNotMatch(unlabeledHtml.slice(0, unlabeledHtml.indexOf("</tr>")), /\/browse\/contracts\//);
});

test("A4 two occurrences of one cause remain one repair group with distinct affected-source counts", () => {
  const observations = [
    observation({ scope: "fixture-cb-01:upcoming_meetings" }),
    observation({ scope: "fixture-cb-02:upcoming_meetings" }),
  ];
  const queue = buildRepairQueue({ observations, observedAt: AS_OF });
  assert.equal(queue.issue_count, 1);
  assert.equal(queue.issues[0].affected_scopes, 2);
  assert.equal(queue.issues[0].issue_key, repairIssueKey({
    source_contract_id: "board-sources",
    condition: "source-retrieval-failed",
    adapter: "html_pdf_v1",
  }));
  const overview = buildOperatorOverview({
    sources: [{
      id: "board-sources",
      name: "Board sources",
      node_class: "source-contract",
      status: "live",
      body: "Community Boards",
      health: { status: "Degraded", reason_codes: [] },
      clocks: {
        publisher_updated: { state: "UNKNOWN" },
        cityscroll_checked_acquired: { state: "UNKNOWN" },
        cityscroll_serving: { state: "UNKNOWN" },
      },
      freshness_watchdog: { status: "STALE", reason_codes: ["monitor-missing"] },
      runs: [],
      serving_fallback: { active: false },
    }],
    contracts: [{
      id: "board-sources",
      name: "Board sources",
      owner: "Community Boards",
      status: "live",
      freshness_contract: { mode: "periodic", serving_max_age_days: 45 },
    }],
    firstClassArtifacts: [],
    repairQueue: queue,
    asOf: AS_OF,
    artifactVintageByPath: new Map(),
  });
  const groups = overview.rows[0].repair.groups;
  assert.equal(groups.length, 1);
  assert.equal(groups[0].affected_scopes, 2);
  assert.equal(groups[0].affected_sources, 1);
});

test("A4 owner-only references are dropped and no second diagnostic contract is introduced", () => {
  assert.equal(publicReference("file:///tmp/secret"), null);
  assert.equal(publicReference(["backstage", "://local/issue"].join("")), null);
  assert.equal(publicReference("https://github.com/cityscroll/cityscroll-app/blob/main/docs/meeting-source-completeness-audit.md"), "https://github.com/cityscroll/cityscroll-app/blob/main/docs/meeting-source-completeness-audit.md");
  const html = generatedGraphFiles()[HTML_OUTPUT];
  for (const marker of [["backstage", "://"].join(""), "file://", "/Users/", "http://localhost"]) {
    assert.ok(!html.includes(marker), marker);
  }
  assert.match(html, /cityscroll.operator_overview.v1/);
  assert.doesNotMatch(html, /card-synthesis|synthesizeCard|alternateDiagnostic/);
  const graph = JSON.parse(generatedGraphFiles()[JSON_OUTPUT]);
  const committed = graph.repair_queue.issues[0];
  const row = graph.operator_overview.rows.find((item) => item.source_id === committed.identity.source_contract_id);
  assert.ok(row);
  assert.ok(row.repair.groups.some((group) => group.issue_key === committed.issue_key));
  assert.equal(row.repair.groups.find((group) => group.issue_key === committed.issue_key).affected_scopes, committed.affected_scopes);
});

test("A6 non-JavaScript destinations remain ordinary links", () => {
  const html = generatedGraphFiles()[HTML_OUTPUT];
  assert.match(html, /<noscript>/);
  assert.match(html, /href="\?source=checkbook-contracts#source-checkbook-contracts"/);
  assert.match(html, /class="overview-source table-source" href="\?source=/);
  assert.match(html, /if\(isModifiedClick\(event\)\)return/);
});
