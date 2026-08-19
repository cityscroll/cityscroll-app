#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  classifyPerformanceComponent,
} from "../site/performance_route_classifier.mjs";
import { startBrowserRumCollector } from "../site/rum_collector.mjs";
import {
  buildPerformanceObservability,
  loadPerformanceRegistry,
} from "./build_performance_observability.mjs";
import { parseAdminPerformanceRequest } from "../worker/src/admin_performance.mjs";
import { buildOpsContract } from "../worker/src/lib/ops_contract.mjs";
import {
  PERFORMANCE_SAMPLING_SEMANTICS,
  buildPerformanceSnapshot,
  performanceAnalyticsQueryPlan,
} from "../worker/src/lib/performance_query.mjs";
import {
  handlePerformanceEvents,
  normalizeRumBatch,
} from "../worker/src/performance_events.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROCEDURES_PATH = "data/rum-observatory-handoff/procedures.v1.json";
const PRIVATE_BROWSER_KEYS = [
  "operator_label",
  "owner_source_path",
  "architecture_container_ref",
  "definition",
  "reason",
];
const OBSERVATION_TEMPLATE = Object.freeze({
  schema: "cityscroll.performance_observation.v1",
  state: "measured",
  metric_id: "ttfb_ms",
  metric_version: "1.0.0",
  unit: "ms",
  value: 123.5,
  surface_id: "home",
  component_id: "none",
  device_class: "mobile",
  navigation_type: "navigate",
  delivery_class: "static",
  result_state: "content",
  collector_version: "rum-browser-v1",
  manifest_version: "rum-surfaces-v1",
  release_id: "a".repeat(40),
});

function readJson(relativePath, { root = ROOT } = {}) {
  return JSON.parse(readFileSync(join(root, relativePath), "utf8"));
}

function readText(relativePath, { root = ROOT } = {}) {
  return readFileSync(join(root, relativePath), "utf8");
}

function fail(errors, message) {
  errors.push(message);
}

function keysDeep(value, found = new Set()) {
  if (Array.isArray(value)) value.forEach((item) => keysDeep(item, found));
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      found.add(key);
      keysDeep(item, found);
    }
  }
  return found;
}

export function loadHandoffProcedures({ root = ROOT } = {}) {
  return readJson(PROCEDURES_PATH, { root });
}

export function markdownRepoLinks(markdown, fromFile) {
  const fromDir = dirname(fromFile);
  const links = [];
  const pattern = /\[[^\]]*\]\(([^)]+)\)/g;
  for (const match of markdown.matchAll(pattern)) {
    const raw = match[1].trim();
    if (!raw || raw.startsWith("#")) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
      links.push({ href: raw, kind: "external" });
      continue;
    }
    const [pathPart, hash] = raw.split("#");
    const resolved = pathPart
      ? resolve(fromDir, pathPart)
      : resolve(fromFile);
    links.push({
      href: raw,
      kind: "repo",
      path: resolved,
      hash: hash || null,
    });
  }
  return links;
}

export function checkDocumentationLinks(markdown, fromFile, {
  root = ROOT,
  optionalPaths = [],
} = {}) {
  const errors = [];
  const optional = new Set(optionalPaths.map((path) => resolve(root, path)));
  for (const link of markdownRepoLinks(markdown, fromFile)) {
    if (link.kind !== "repo") continue;
    if (!existsSync(link.path)) {
      if (optional.has(link.path)) continue;
      fail(errors, `broken link ${link.href} from ${fromFile}`);
    }
  }
  return errors;
}

function observation(overrides = {}) {
  return { ...OBSERVATION_TEMPLATE, ...overrides };
}

function batchFrom(fixtureCase) {
  const row = observation(fixtureCase.observation_override || {});
  if (fixtureCase.observation_extra) Object.assign(row, fixtureCase.observation_extra);
  return {
    schema: "cityscroll.rum.batch.v1",
    observations: [row],
    ...(fixtureCase.batch_extra || {}),
  };
}

export function runNewInstrumentation(fixture, { root = ROOT } = {}) {
  const errors = [];
  const registry = loadPerformanceRegistry(join(root, fixture.canonical_edit));
  if (registry.components.some((entry) => entry.component_id === fixture.example_component.component_id)) {
    fail(errors, "example component must not already exist on the production registry");
  }
  const next = JSON.parse(JSON.stringify(registry));
  next.components.push(fixture.example_component);
  const projections = buildPerformanceObservability(next, { root });
  const componentId = fixture.example_component.component_id;
  const marker = fixture.example_component.public_safe_matcher.marker;
  if (!projections.browser.components.some((entry) => entry.component_id === componentId)) {
    fail(errors, "browser projection missing the new component");
  }
  if (!projections.worker.component_ids.includes(componentId)) {
    fail(errors, "worker projection missing the new component");
  }
  if (!projections.operator.components.some((entry) => entry.component_id === componentId)) {
    fail(errors, "operator projection missing the new component");
  }
  const classified = classifyPerformanceComponent(projections.browser, marker);
  if (classified.component_id !== componentId) {
    fail(errors, `semantic marker ${marker} did not classify as ${componentId}`);
  }
  if (projections.browser.registry_hash !== projections.worker.registry_hash
    || projections.worker.registry_hash !== projections.operator.registry_hash) {
    fail(errors, "generated projections must share one registry_hash");
  }
  const browserKeys = keysDeep(projections.browser);
  for (const privateKey of PRIVATE_BROWSER_KEYS) {
    if (browserKeys.has(privateKey)) fail(errors, `browser projection leaked ${privateKey}`);
  }
  const live = buildPerformanceObservability(registry, { root });
  if (live.browser.components.some((entry) => entry.component_id === componentId)) {
    fail(errors, "in-memory example leaked into the live registry build");
  }
  for (const relativePath of fixture.projections) {
    if (!existsSync(join(root, relativePath))) fail(errors, `missing generated projection ${relativePath}`);
  }
  return errors;
}

export function runPrivacyAudit(fixture) {
  const errors = [];
  const accepted = normalizeRumBatch({
    schema: "cityscroll.rum.batch.v1",
    observations: [observation()],
  });
  if (!accepted.ok) fail(errors, `control batch was rejected: ${accepted.reason}`);

  for (const item of fixture.rejection_cases) {
    const result = normalizeRumBatch(batchFrom(item));
    if (result.ok) fail(errors, `${item.name} was accepted`);
    else if (result.reason !== item.reason) {
      fail(errors, `${item.name} rejected as ${result.reason}, expected ${item.reason}`);
    }
  }

  const source = readText("worker/src/performance_events.mjs");
  for (const key of fixture.forbidden_keys) {
    if (!source.includes(`"${key}"`)) fail(errors, `intake source is missing forbidden key ${key}`);
  }
  return errors;
}

export function runQueryTroubleshooting(fixture, { root = ROOT } = {}) {
  const errors = [];
  const queryFixture = readJson(fixture.query_fixture, { root });
  const matrix = readJson(fixture.state_matrix, { root });
  const queryPlan = performanceAnalyticsQueryPlan(queryFixture.query, {
    now: queryFixture.now,
    configuredSince: queryFixture.configured_since,
    sampleFloor: queryFixture.sample_floor,
  });
  const sql = queryPlan.requests.map((request) => request.sql).join("\n");
  if (!sql.includes("count() AS sampled_count")) fail(errors, "SQL is missing sampled_count");
  if (!sql.includes("sum(_sample_interval) AS estimated_count")) fail(errors, "SQL is missing estimated_count");
  if (!sql.includes("quantileExactWeighted(0.95)")) fail(errors, "SQL is missing weighted p95");
  if (sql.includes("sum(_sample_interval * double1)")) fail(errors, "SQL reused the usage count formula");
  if (PERFORMANCE_SAMPLING_SEMANTICS.method !== fixture.sampling.method) {
    fail(errors, "sampling method drifted from the handoff fixture");
  }

  const available = buildPerformanceSnapshot(queryFixture.sql_results, queryPlan, {
    dataHealth: { status: "available", accepted: 10 },
  });
  if (available.status !== "available") fail(errors, `weighted fixture status is ${available.status}`);
  if (!available.series.some((row) => row.current?.percentiles?.p50 > 0)) {
    fail(errors, "available snapshot is missing weighted percentiles");
  }

  const lowSample = available.series.find((row) => row.current?.status === "insufficient_sample");
  if (!lowSample) fail(errors, "weighted fixture lost the insufficient_sample series");
  if (Object.hasOwn(lowSample.current, "percentiles")) {
    fail(errors, "insufficient_sample still carries percentiles");
  }

  const noData = buildPerformanceSnapshot({ current: [], previous: [], trend: [] }, queryPlan);
  if (noData.status !== "no_data") fail(errors, `empty fixture status is ${noData.status}`);
  if (Object.hasOwn(noData.series[0]?.current || {}, "percentiles")) {
    fail(errors, "no_data synthesized percentiles");
  }

  const expected = new Set(fixture.diagnoses.map((row) => row.reader_state));
  for (const item of matrix.cases) {
    const readerState = item.expected_status || item.expected_coverage_status;
    if (readerState && !expected.has(readerState)) {
      fail(errors, `state matrix ${item.name} is not diagnosed in the handoff fixture`);
    }
    if (item.percentiles_present === false && JSON.stringify(item).includes('"p50":0')) {
      fail(errors, `${item.name} must omit percentiles rather than zero-fill`);
    }
  }
  return errors;
}

export function runDeskContract(fixture, { root = ROOT } = {}) {
  const errors = [];
  const manifest = readJson(fixture.manifest, { root });
  if (manifest.response_schema !== fixture.response_schema) {
    fail(errors, "Desk contract schema drifted");
  }
  if (manifest.endpoint !== fixture.endpoint) fail(errors, "Desk endpoint drifted");
  for (const relativePath of [
    fixture.manifest,
    fixture.followup,
    fixture.acceptance_test,
    manifest.reference_response.path,
    manifest.edge_states.path,
    manifest.ops_contract_path,
  ]) {
    if (!existsSync(join(root, relativePath))) fail(errors, `missing Desk contract path ${relativePath}`);
  }
  const ops = buildOpsContract({ generated_at: readJson(manifest.ops_contract_path, { root }).generated_at });
  if (ops.performance.consumer_handoff.manifest !== fixture.manifest) {
    fail(errors, "ops-contract does not advertise the Desk handoff manifest");
  }
  const overview = parseAdminPerformanceRequest(new Request(
    `https://worker.invalid/admin/performance${manifest.views.overview.query}`,
  ));
  if (overview.window !== "7d") fail(errors, "overview query is no longer the committed 7d window");
  return errors;
}

function fakeKV() {
  const store = new Map();
  return {
    store,
    async get(key) { return store.get(key) ?? null; },
    async put(key, value) { store.set(key, value); },
  };
}

export async function runRollback(fixture, { root = ROOT } = {}) {
  const errors = [];
  const wrangler = readText("worker/wrangler.toml", { root });
  if (!/^RUM_INGEST_ENABLED = "(?:true|false)"$/m.test(wrangler)) {
    fail(errors, "wrangler is missing the independent ingest switch");
  }
  const manifest = readJson("site/data/performance-classification-manifest.v1.json", { root });
  if (typeof manifest.collector?.production_enabled !== "boolean") {
    fail(errors, "public collector contract is missing production_enabled");
  }

  const points = [];
  const response = await handlePerformanceEvents(new Request("https://api.cityscroll.org/performance-events", {
    method: "POST",
    headers: { Origin: "https://cityscroll.org", "Content-Type": "application/json" },
    body: JSON.stringify({
      schema: "cityscroll.rum.batch.v1",
      observations: [observation()],
    }),
  }), {
    RUM_INGEST_ENABLED: "false",
    ANALYTICS_ENVIRONMENT: "production",
    RUM_ANALYTICS: { writeDataPoint(value) { points.push(value); } },
    ALERT_STATE: fakeKV(),
  }, { nowMs: Date.parse("2026-08-19T14:30:00Z") });
  if (response.status !== 204) fail(errors, `ingest-off returned ${response.status}`);
  if (points.length) fail(errors, "ingest-off still wrote Analytics Engine points");

  const collector = await startBrowserRumCollector({
    testOnly: false,
    manifest,
    pathname: "/",
    sink: { record() { errors.push("collector recorded without the test capability"); } },
  });
  if (collector.state !== "disabled") {
    fail(errors, `browser collector without testOnly is ${collector.state}`);
  }

  const queryFixture = readJson("worker/test/fixtures/performance_query_weighted.json", { root });
  const snapshot = buildPerformanceSnapshot(
    queryFixture.sql_results,
    performanceAnalyticsQueryPlan(queryFixture.query, {
      now: queryFixture.now,
      configuredSince: queryFixture.configured_since,
      sampleFloor: queryFixture.sample_floor,
    }),
    { dataHealth: { status: "available", accepted: 10 } },
  );
  if (!snapshot.series?.length) fail(errors, "historical query snapshot vanished after ingest-off");

  for (const relativePath of fixture.rollback_proof) {
    if (!existsSync(join(root, relativePath))) fail(errors, `missing rollback proof ${relativePath}`);
  }
  return errors;
}

export function runDeferredGovernance(fixture, { root = ROOT, handoffDoc } = {}) {
  const errors = [];
  if (fixture.status !== "not_implemented") fail(errors, "deferred-governance fixture is not marked not_implemented");
  const doc = handoffDoc || "";
  for (const candidate of fixture.candidates) {
    if (!doc.includes(candidate.id) && !doc.includes(candidate.title)) {
      fail(errors, `handoff doc is missing deferred candidate ${candidate.id}`);
    }
  }
  const runtimePattern = new RegExp(fixture.forbidden_runtime_patterns.join("|"));
  for (const relativePath of fixture.runtime_paths) {
    const path = join(root, relativePath);
    if (!existsSync(path)) continue;
    const lines = readFileSync(path, "utf8").split("\n");
    lines.forEach((line, index) => {
      const stripped = line.replace(/\/\/.*$/, "").trim();
      if (!stripped) return;
      if (runtimePattern.test(stripped)) {
        fail(errors, `${relativePath}:${index + 1} implements deferred governance: ${stripped}`);
      }
    });
  }
  return errors;
}

export async function runProcedure(id, { root = ROOT } = {}) {
  const inventory = loadHandoffProcedures({ root });
  const entry = inventory.procedures.find((item) => item.id === id);
  if (!entry) throw new Error(`unknown procedure ${id}`);
  const fixture = readJson(entry.fixture, { root });
  const handoffPath = join(root, inventory.handoff_doc);
  const handoffDoc = readFileSync(handoffPath, "utf8");
  if (!handoffDoc.includes(`## ${entry.heading}`)) {
    return [`handoff doc is missing heading ${entry.heading}`];
  }
  if (!handoffDoc.includes(entry.command)) {
    return [`handoff doc is missing command ${entry.command}`];
  }
  switch (id) {
    case "new-instrumentation":
      return runNewInstrumentation(fixture, { root });
    case "privacy-audit":
      return runPrivacyAudit(fixture);
    case "query-troubleshooting":
      return runQueryTroubleshooting(fixture, { root });
    case "desk-contract":
      return runDeskContract(fixture, { root });
    case "rollback":
      return runRollback(fixture, { root });
    case "deferred-governance":
      return runDeferredGovernance(fixture, { root, handoffDoc });
    default:
      return [`unhandled procedure ${id}`];
  }
}

export async function runHandoffCheck({ root = ROOT } = {}) {
  const inventory = loadHandoffProcedures({ root });
  const errors = [];
  const handoffPath = join(root, inventory.handoff_doc);
  const queryDocPath = join(root, inventory.query_semantics_doc);
  if (!existsSync(handoffPath)) fail(errors, `missing handoff doc ${inventory.handoff_doc}`);
  if (!existsSync(queryDocPath)) fail(errors, `missing query semantics ${inventory.query_semantics_doc}`);
  const handoffDoc = existsSync(handoffPath) ? readFileSync(handoffPath, "utf8") : "";
  const optionalPaths = [];
  const operatorPath = inventory.operator_protocol?.path;
  if (operatorPath) {
    if (existsSync(join(root, operatorPath))) {
      const protocol = readText(operatorPath, { root });
      for (const needle of inventory.operator_protocol.when_present_must_contain || []) {
        if (!protocol.includes(needle)) fail(errors, `${operatorPath} is missing ${needle}`);
      }
    } else if (inventory.operator_protocol.optional) {
      optionalPaths.push(operatorPath);
    } else {
      fail(errors, `missing operator protocol ${operatorPath}`);
    }
  }
  errors.push(...checkDocumentationLinks(handoffDoc, handoffPath, { root, optionalPaths }));
  if (existsSync(queryDocPath)) {
    errors.push(...checkDocumentationLinks(readFileSync(queryDocPath, "utf8"), queryDocPath, { root, optionalPaths }));
  }
  for (const entry of inventory.procedures) {
    errors.push(...await runProcedure(entry.id, { root }));
  }
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const procedureFlag = process.argv.indexOf("--procedure");
  const procedureId = procedureFlag === -1 ? null : process.argv[procedureFlag + 1];
  const errors = procedureId
    ? await runProcedure(procedureId)
    : await runHandoffCheck();
  if (errors.length) {
    for (const error of errors) console.error(error);
    process.exit(1);
  }
  console.log(procedureId ? `${procedureId} ok` : "rum observatory handoff ok");
}
