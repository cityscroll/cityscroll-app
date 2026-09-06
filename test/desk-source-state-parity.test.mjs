import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  DATA_SOURCE_GRAPH_SCHEMA_VERSION,
  DESK_CONSUMER_CONTRACT_PATH,
  JSON_OUTPUT,
  ROOT,
  generatedGraphFiles,
  renderGraphHtml,
} from "../tools/data_source_graph.mjs";

const readJson = (path) => JSON.parse(readFileSync(join(ROOT, path), "utf8"));
const registry = readJson("site/data/source_contracts.json");
const observations = readJson("site/data/source_health_observations.json");
const contract = readJson(DESK_CONSUMER_CONTRACT_PATH);
const graph = JSON.parse(generatedGraphFiles()[JSON_OUTPUT]);
const contractRows = graph.sources.filter((source) => source.node_class === "source-contract");

test("the authenticated graph stays inside the deployed additive compatibility envelope", () => {
  assert.equal(DATA_SOURCE_GRAPH_SCHEMA_VERSION, 4);
  assert.equal(graph.schema_version, 4);
  assert.equal(contract.producer_schema_version, 4);
  assert.ok(contract.supported_consumer_versions.includes(4));
  assert.equal(contract.compatibility, "additive_superset");

  const extension = contract.extensions.repair_observations;
  assert.equal(extension.version, 1);
  assert.equal(graph.extensions.repair_observations, extension.version);
  assert.equal(graph.repair_observations.schema, extension.set_schema);
  assert.equal(graph.repair_observations.visibility, "private");
  assert.deepEqual(graph.repair_observations.conditions, extension.conditions);
  assert.deepEqual(graph.repair_observations.dispositions, extension.dispositions);

  const queueExtension = contract.extensions.repair_queue;
  assert.equal(queueExtension.version, 1);
  assert.equal(graph.extensions.repair_queue, queueExtension.version);
  const publication = contract.extensions.publication_cycle;
  assert.equal(publication.version, 1);
  assert.equal(graph.extensions.publication_cycle, publication.version);
  assert.ok(graph.publication_cycle);
  assert.ok(graph.publication_cycle.clocks.last_monitor_attempt);
  assert.ok(graph.publication_cycle.clocks.last_successful_observation);
  assert.ok("evidence_revision" in graph.publication_cycle.clocks);
  assert.ok(graph.publication_cycle.clocks.last_successful_desk_publication);
  assert.equal(graph.repair_queue.schema, queueExtension.queue_schema);
  assert.equal(graph.repair_queue.visibility, "private");
  assert.deepEqual(graph.repair_queue.states, queueExtension.states);

  const overviewExtension = contract.extensions.operator_overview;
  assert.equal(overviewExtension.version, 1);
  assert.equal(graph.extensions.operator_overview, overviewExtension.version);
  assert.equal(graph.operator_overview.schema, overviewExtension.overview_schema);
  assert.equal(graph.operator_overview.visibility, "private");
  assert.deepEqual(graph.operator_overview.condition_ids, overviewExtension.conditions);
});

test("every registry contract and health observation has one explicit disposition", () => {
  const registryIds = registry.contracts.map((source) => source.id);
  const graphIds = contractRows.map((source) => source.id);
  const observationIds = observations.observations.map((observation) => observation.source_id);

  assert.equal(graphIds.length, registryIds.length);
  assert.equal(new Set(graphIds).size, graphIds.length);
  assert.deepEqual(new Set(graphIds), new Set(registryIds));
  assert.equal(new Set(observationIds).size, observationIds.length);
  assert.deepEqual(new Set(observationIds), new Set(registryIds));
  assert.ok(contractRows.every((source) => ["live", "build-time", "manual", "disabled"].includes(source.status)));
  assert.equal(graph.sources.filter((source) => source.node_class === "candidate-source").length, graph.counts.candidate_sources);
  assert.equal(graph.sources.filter((source) => source.node_class === "blocked-source").length, graph.counts.blocked_sources);
});

test("representative source state preserves identity, clocks, health, coverage, fallback, and revision", () => {
  const healthById = new Map(observations.observations.map((observation) => [observation.source_id, observation]));
  const registryById = new Map(registry.contracts.map((source) => [source.id, source]));
  const representativeIds = [
    "checkbook-contracts",
    "checkbook-spending",
    "passport-public-rfx",
    "nyc-council-legistar",
    "ibo-fiscal-history",
  ];

  assert.match(graph.sources_hash, /^[a-f0-9]{64}$/);
  for (const id of representativeIds) {
    const source = graph.sources.find((candidate) => candidate.id === id);
    const observation = healthById.get(id);
    const registrySource = registryById.get(id);
    assert.ok(source, id);
    assert.ok(observation, `${id} observation`);
    assert.equal(source.name, registrySource.name);
    assert.equal(source.body, registrySource.owner);
    assert.equal(source.status, registrySource.status);
    assert.deepEqual(source.clocks, observation.health.clocks);
    assert.equal(source.health.status, observation.health.status);
    assert.deepEqual(source.health.reason_codes, observation.health.reason_codes);
    assert.deepEqual(source.serving_fallback, observation.serving_fallback || { active: false, valid: false, status: "not-active" });
    assert.deepEqual(source.join_gate, observation.relationship_coverage);
    assert.equal(typeof source.coverage, "string", `${id} source coverage`);
    assert.equal(typeof source.join_gate, "object", `${id} join coverage`);
  }

  for (const id of ["passport-public-rfx", "nyc-council-legistar"]) {
    const clocks = graph.sources.find((source) => source.id === id).clocks;
    for (const clock of Object.values(clocks)) {
      assert.equal(clock.state, "UNKNOWN");
      assert.equal(clock.at, null);
    }
  }
});

test("selected-source URLs survive reload and retain a no-JavaScript destination", () => {
  const html = renderGraphHtml(graph);
  for (const source of contractRows) {
    assert.match(html, new RegExp(`id="source-${source.id}"`));
    assert.match(html, new RegExp(`href="\\?source=${source.id}#source-${source.id}"`));
  }
  assert.match(html, /<noscript>/);
  assert.match(html, /new URLSearchParams\(window\.location\.search\)/);
  assert.match(html, /window\.addEventListener\("popstate"/);
  assert.match(html, /function revealSelectedSourceLayer\(\)/);
  assert.match(html, /#detailLayer\[hidden\]\{display:block!important\}/);
  assert.match(html, /\.repair-view\{min-width:0;max-width:100%\}/);
  assert.match(html, /\.queue-list\{display:grid;min-width:0;max-width:100%;grid-template-columns:minmax\(0,1fr\)/);
  assert.match(html, /\.queue-detail\{display:grid;grid-template-columns:minmax\(0,max-content\) minmax\(0,1fr\)/);
  assert.match(html, /\.queue-table-wrap\{max-width:100%;min-width:0;width:100%;contain:inline-size;overflow-x:auto/);
  assert.match(html, /class="queue-table-wrap" tabindex="0" role="region" aria-label="Affected scopes for/);
  assert.match(html, /Source not found/);
});
