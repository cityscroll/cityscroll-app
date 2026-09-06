import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import {
  DATA_SOURCE_GRAPH_SCHEMA_VERSION,
  DEFAULT_OUTPUT_DIR,
  DESK_CONSUMER_CONTRACT_PATH,
  HTML_OUTPUT,
  JSON_OUTPUT,
  ROOT,
  buildDataSourceGraph,
  checkGraphBuild,
  declaredInputPaths,
  generatedGraphFiles,
  inputManifest,
  latestFreshnessDate,
  renderGraphHtml,
  writeGeneratedGraphFiles,
} from "../tools/data_source_graph.mjs";

const registry = JSON.parse(readFileSync(join(ROOT, "site/data/source_contracts.json"), "utf8"));
const graph = JSON.parse(generatedGraphFiles()[JSON_OUTPUT]);
const sourceDocument = readFileSync(join(ROOT, "docs/data-sources.md"), "utf8");

test("generated topology covers every documented source with all four layers", () => {
  const sourceContracts = graph.sources.filter((source) => source.node_class === "source-contract");
  assert.equal(sourceContracts.length, registry.contracts.length);
  assert.deepEqual(new Set(sourceContracts.map((source) => source.id)), new Set(registry.contracts.map((source) => source.id)));
  assert.ok(Date.parse(graph.current_as_of) >= Date.parse(latestFreshnessDate(registry)));
  const documentedNames = [...sourceDocument.matchAll(/^\| (?:live|build-time|manual|disabled) \| [^|]+ \| \[([^\]]+)\]/gm)].map((match) => match[1]);
  assert.deepEqual(new Set(sourceContracts.map((source) => source.name)), new Set(documentedNames));
  for (const source of graph.sources) {
    assert.ok(source.body, `${source.id} collecting body`);
    assert.ok(source.endpoint.identity, `${source.id} endpoint`);
    assert.ok(source.ingest.job, `${source.id} ingest job`);
    assert.ok(source.ingest.cadence, `${source.id} ingest cadence`);
    assert.ok(source.ingest.transform, `${source.id} transform`);
    assert.ok(source.publisher_cadence, `${source.id} publisher cadence`);
    assert.ok(source.surfaces.length, `${source.id} surface`);
  }
});

test("producer schema version stays in lockstep with the desk consumer contract", () => {
  const contract = JSON.parse(readFileSync(join(ROOT, DESK_CONSUMER_CONTRACT_PATH), "utf8"));
  assert.equal(contract.schema, "cityscroll.data_source_graph.desk_consumer_contract.v1");
  assert.equal(DATA_SOURCE_GRAPH_SCHEMA_VERSION, 4);
  assert.equal(graph.schema_version, DATA_SOURCE_GRAPH_SCHEMA_VERSION);
  assert.equal(contract.producer_schema_version, DATA_SOURCE_GRAPH_SCHEMA_VERSION);
  assert.ok(contract.supported_consumer_versions.includes(DATA_SOURCE_GRAPH_SCHEMA_VERSION));
  assert.equal(graph.counts.candidate_sources, graph.research.candidates);
  assert.ok(graph.sources.some((source) => source.node_class === "candidate-source"));
  assert.ok(graph.sources.every((source) => source.health && source.clocks && source.join_gate));
  assert.equal(graph.extensions.repair_observations, contract.extensions.repair_observations.version);
  assert.ok(Array.isArray(contract.extensions.repair_observations.graph_fields));
  assert.ok(contract.extensions.repair_observations.graph_fields.includes("repair_observations"));
  assert.equal(graph.repair_observations.schema, "cityscroll.repair_observation_set.v1");
  assert.equal(graph.repair_observations.visibility, "private");
  assert.deepEqual(graph.repair_observations.conditions, contract.extensions.repair_observations.conditions);
  assert.deepEqual(graph.repair_observations.dispositions, contract.extensions.repair_observations.dispositions);
  assert.equal(graph.counts.repair_observations, graph.repair_observations.observations.length);
  assert.ok(graph.sources.every((source) => Array.isArray(source.repair_observations ?? [])));
  assert.equal(graph.extensions.repair_queue, contract.extensions.repair_queue.version);
  assert.ok(contract.extensions.repair_queue.graph_fields.includes("repair_queue"));
  assert.equal(graph.repair_queue.schema, "cityscroll.repair_queue.v1");
  assert.equal(graph.repair_queue.visibility, "private");
  assert.deepEqual(graph.repair_queue.states, contract.extensions.repair_queue.states);
  assert.equal(graph.repair_queue.status, "available");
  assert.equal(graph.extensions.operator_overview, contract.extensions.operator_overview.version);
  assert.ok(contract.extensions.operator_overview.graph_fields.includes("operator_overview"));
  assert.equal(graph.operator_overview.schema, "cityscroll.operator_overview.v1");
  assert.equal(graph.operator_overview.visibility, "private");
  assert.match(
    generatedGraphFiles()[HTML_OUTPUT],
    /Trace each collecting body through its endpoint, adapters and runs, receipt-backed three-clock health, join gates, and product surfaces/,
  );
});

test("source graph declares topology inputs and derives outputs outside the committed tree", () => {
  const paths = declaredInputPaths();
  for (const required of [
    "docs/data-sources.md",
    "site/data/gap_taxonomy.json",
    "site/data/source_contracts.json",
    "site/data/source_health_observations.json",
    "warehouse/datasets.v0.json",
    "worker/wrangler.toml",
    "worker/src/worker.mjs",
  ]) assert.ok(paths.includes(required), required);
  assert.match(graph.sources_hash, /^[a-f0-9]{64}$/);
  assert.equal(DEFAULT_OUTPUT_DIR, "docs");
  const ignore = readFileSync(join(ROOT, ".gitignore"), "utf8");
  assert.match(ignore, /^docs\/data-source-graph\.json$/m);
  assert.match(ignore, /^docs\/data-source-graph\.html$/m);
});

test("partnership-blocked wishlist entries become validated ghost paths", () => {
  const blocked = graph.sources.filter((source) => source.node_class === "blocked-source");
  assert.equal(blocked.length, graph.counts.blocked_sources);
  assert.ok(blocked.length >= 2);
  for (const source of blocked) {
    assert.equal(source.visual_class, "blocked");
    assert.ok(source.data_offered);
    assert.ok(source.body);
    assert.ok(source.endpoint.identity);
    assert.match(source.status, /^(blocked|application-possible|declined)$/);
    assert.ok(source.surfaces.length);
    assert.equal(source.access_mechanisms.filter((mechanism) => mechanism.preferred).length, 1);
    assert.ok(source.policy_citations.every((citation) => /^\d{4}-\d{2}-\d{2}$/.test(citation.date)));
    assert.ok(graph.edges.some((edge) => edge.from === `source:${source.id}` && edge.kind === "requires-access"));
    assert.ok(graph.edges.some((edge) => edge.to === `surface:${source.surfaces[0]}` && edge.kind === "would-serve"));
  }
});

test("GovDeals exposes a preferred DCAS publication route and a secondary client API route", () => {
  const source = graph.sources.find((entry) => entry.id === "dcas-nonfleet-surplus-inventory");
  assert.ok(source);
  assert.equal(source.access_mechanisms.length, 2);
  assert.equal(source.access_mechanisms.find((mechanism) => mechanism.preferred).type, "open-data-publication-request");
  assert.equal(source.access_mechanisms.find((mechanism) => mechanism.type === "registered-client-api").preferred, false);
  assert.match(source.data_offered, /vehicle slice is already published/i);
  assert.ok(source.policy_citations.some((citation) => /Restrictions on Use/.test(citation.section)));
});

test("money location residual points to authenticated PASSPort Sites without claiming universal coverage", () => {
  const source = graph.sources.find((entry) => entry.id === "passport-contract-sites");
  assert.ok(source);
  assert.match(source.data_offered, /candidate source/i);
  assert.match(source.data_offered, /not evidence that every award/i);
  assert.ok(source.surfaces.includes("Money"));
  assert.ok(source.surfaces.includes("Map"));
  assert.ok(source.access_mechanisms.some((mechanism) => mechanism.type === "data-sharing-agreement"));
});

test("blocked-source schema rejects ambiguous preferred routes", () => {
  const fixture = {
    id: "invalid-blocked-source",
    wishlist_gap_id: "gap",
    name: "Invalid",
    data_offered: "Data",
    collecting_body: "Body",
    platform: "Platform",
    status: "blocked",
    status_note: "No access",
    access_mechanisms: [
      { id: "one", type: "api-application", label: "One", preferred: false, requirement: "Apply", citation_ids: ["policy"] },
    ],
    policy_citations: [
      { id: "policy", title: "Policy", url: "https://example.test/policy", section: "Access", date: "2026-08-04" },
    ],
    surfaces: ["Money"],
  };
  assert.throws(
    () => buildDataSourceGraph({ registry: { contracts: [] }, gapTaxonomy: { partnership_blocked_sources: [fixture] }, inputs: [] }),
    /exactly one preferred access mechanism/,
  );
});

test("build output detects a declared input change without regeneration", () => {
  mkdirSync(join(ROOT, ".generated"), { recursive: true });
  const outputDir = mkdtempSync(join(ROOT, ".generated/data-source-graph-test-"));
  try {
    const inputPath = join(outputDir, "declared-input.json");
    const manifestPath = relative(ROOT, inputPath);
    writeFileSync(inputPath, '{"version":1}\n');
    const inputs = inputManifest([manifestPath]);
    writeGeneratedGraphFiles({ outputDir, inputs });
    assert.deepEqual(checkGraphBuild({ outputDir, inputs }), []);

    writeFileSync(inputPath, '{"version":2}\n');
    const changedInputs = inputManifest([manifestPath]);
    assert.deepEqual(checkGraphBuild({ outputDir, inputs: changedInputs }), [JSON_OUTPUT, HTML_OUTPUT]);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test("a new source contract appears without hand-editing diagram markup", () => {
  const synthetic = {
    id: "new-source-fixture",
    name: "New Source Fixture",
    owner: "NYC Test Department",
    status: "live",
    scope: "runtime",
    kind: "socrata",
    dataset_id: "abcd-1234",
    landing_page: "https://data.cityofnewyork.us/d/abcd-1234",
    delivery_tier: "live-only",
    publisher_cadence: "Daily",
    product_freshness: "Queried when requested.",
    used_for: "A new test surface.",
  };
  const built = buildDataSourceGraph({ registry: { contracts: [...registry.contracts, synthetic] }, inputs: [] });
  assert.ok(built.sources.some((source) => source.id === synthetic.id));
  assert.match(renderGraphHtml(built), /New Source Fixture/);
});

test("authenticated graph joins source health, operator runs, receipts, clocks, fallback, and join gates", () => {
  const synthetic = {
    id: "desk-health-fixture",
    name: "Desk Health Fixture",
    owner: "NYC Test Department",
    status: "live",
    scope: "runtime",
    kind: "socrata",
    dataset_id: "desk-1234",
    landing_page: "https://data.cityofnewyork.us/d/desk-1234",
    delivery_tier: "edge-materialized",
    publisher_cadence: "Daily",
    product_freshness: "Serves a retained snapshot after acquisition failure.",
    used_for: "A test contracts surface.",
    code_references: [{ path: "worker/src/fixture.mjs", contains: "fixtureAdapter" }],
  };
  const health = {
    schema: "cityscroll.source_health_observations.v1",
    generated_at: "2026-08-18T12:00:00.000Z",
    observations: [{
      source_id: synthetic.id,
      contract_fingerprint: "a".repeat(64),
      health: {
        status: "Degraded",
        reason_codes: ["acquisition-failed", "serving-valid-fallback"],
        clocks: {
          publisher_updated: { at: "2026-08-17T00:00:00.000Z", state: "KNOWN", basis: "rowsUpdatedAt" },
          cityscroll_checked_acquired: { at: "2026-08-18T10:00:00.000Z", state: "KNOWN", basis: "checked_at" },
          cityscroll_serving: { at: "2026-08-18T09:00:00.000Z", state: "KNOWN", basis: "serve_contract:fixture" },
        },
      },
      relationship_coverage: {
        status: "held",
        join_status: "held",
        row_count: 12,
        measured_at: "2026-08-18T08:00:00.000Z",
        reason_codes: ["relationship-join-held"],
      },
      evidence: [{
        kind: "external-schedule-receipt",
        path: ".external-schedule-state/results/source-contracts-live/fixture.json",
        at: "2026-08-18T10:00:00.000Z",
        status: "failed",
      }],
      operator: {
        runs: [{
          adapter: "source-contracts-live",
          run_id: "2026-08-18-source-0",
          at: "2026-08-18T10:00:00.000Z",
          status: "failed",
          receipt_ref: ".external-schedule-state/results/source-contracts-live/fixture.json",
          exact_error: "HTTP 503 from publisher",
        }],
      },
    }],
  };
  const built = buildDataSourceGraph({ registry: { contracts: [synthetic] }, healthObservations: health, inputs: [] });
  const source = built.sources.find((entry) => entry.id === synthetic.id);
  assert.equal(source.contract_fingerprint, "a".repeat(64));
  assert.equal(source.health.status, "Degraded");
  assert.deepEqual(Object.keys(source.clocks).sort(), [
    "cityscroll_checked_acquired",
    "cityscroll_serving",
    "publisher_updated",
  ]);
  assert.equal(source.serving_fallback.active, true);
  assert.equal(source.join_gate.status, "held");
  assert.equal(source.receipts[0].path, health.observations[0].evidence[0].path);
  assert.equal(source.runs[0].exact_error, "HTTP 503 from publisher");
  assert.ok(source.adapters.some((adapter) => /fixtureAdapter|source-contracts-live/.test(adapter)));

  const html = renderGraphHtml(built);
  for (const expected of [
    "Publisher updated",
    "CityScroll checked / acquired",
    "CityScroll serving",
    "Serving fallback",
    "Join gate",
    "HTTP 503 from publisher",
    "external-schedule-receipt",
  ]) assert.match(html, new RegExp(expected));
});

test("candidate and access-blocked research stay backstage as generated ghost paths", () => {
  const built = buildDataSourceGraph({
    registry: { contracts: [] },
    gapTaxonomy: {
      sources: [{
        id: "candidate-fixture",
        name: "Candidate Fixture",
        source_contract_id: null,
        status: "not_ingested",
        join_keys: ["candidate_id"],
        join_coverage: {},
        landing_page: "https://example.test/candidate",
        delivery_tier: "live-only",
      }],
      partnership_blocked_sources: [{
        id: "blocked-fixture",
        wishlist_gap_id: "blocked-gap",
        name: "Blocked Fixture",
        data_offered: "Restricted fixture rows",
        collecting_body: "NYC Fixture Department",
        platform: "Restricted platform",
        status: "blocked",
        status_note: "Access is not yet authorized.",
        access_mechanisms: [{ id: "request", type: "request", label: "Request access", preferred: true, requirement: "Apply", citation_ids: ["policy"] }],
        policy_citations: [{ id: "policy", title: "Access policy", url: "https://example.test/policy", section: "Access", date: "2026-08-18" }],
        surfaces: ["Money"],
      }],
    },
    inputs: [],
  });
  const candidate = built.sources.find((source) => source.id === "candidate-fixture");
  assert.equal(candidate.node_class, "candidate-source");
  assert.equal(candidate.research_state.status, "not_ingested");
  assert.ok(built.edges.some((edge) => edge.from === "source:candidate-fixture" && edge.kind === "would-ingest"));
  assert.deepEqual(built.research, { candidates: 1, blocked: 1 });
  assert.match(renderGraphHtml(built), /Candidate research/);
});

test("current-as-of is the latest real registry or receipt date", () => {
  assert.equal(latestFreshnessDate({ contracts: [] }), null);
  const base = {
    id: "freshness-fixture",
    name: "Freshness Fixture",
    owner: "NYC Test Department",
    status: "live",
    scope: "runtime",
    kind: "socrata",
    publisher_cadence: "Daily",
    product_freshness: "Queried when requested.",
    used_for: "A freshness test surface.",
    join_measurement: { observed_on: "2026-08-11" },
  };
  const built = buildDataSourceGraph({ registry: { contracts: [base] }, inputs: [] });
  assert.equal(built.current_as_of, "2026-08-11");
  assert.match(renderGraphHtml(built), /Current as of Aug 11, 2026/);

  const newer = { ...base, join_measurement: { observed_on: "2026-08-12" } };
  const advanced = buildDataSourceGraph({ registry: { contracts: [newer] }, inputs: [] });
  assert.equal(advanced.current_as_of, "2026-08-12");
  assert.match(renderGraphHtml(advanced), /Current as of Aug 12, 2026/);
});

test("a rehearsal cron does not replace the production ingest cadence", () => {
  const built = buildDataSourceGraph({
    registry: { contracts: [registry.contracts.find((source) => source.id === "city-record")] },
    wranglerText: '[triggers]\ncrons = ["0 10 * * *", "0 13 * * *"]',
    workerText: "ingestNotices",
    inputs: [],
  });
  assert.deepEqual(built.cron.expressions, ["0 10 * * *", "0 13 * * *"]);
  assert.equal(built.sources[0].ingest.cadence, "Daily at 13:00 UTC (0 13 * * *)");
});

test("self-contained renderer keeps graph detail and table views available", () => {
  const html = generatedGraphFiles()[HTML_OUTPUT];
  assert.match(html, /<svg id="sourceGraph"/);
  assert.match(html, /id="details"/);
  assert.match(html, /selectSource\(s\.id\)/);
  assert.match(html, /id="tableView"/);
  assert.match(html, /blocked-edge/);
  assert.match(html, /Access mechanisms/);
  assert.equal((html.match(/data-source-row=/g) || []).length, graph.sources.length);
  assert.doesNotMatch(html, /<script[^>]+src=/);
  assert.match(html, /wishlist=s\.wishlist\?'<h3>Wishlist<\/h3><p>'\+escapeHtml\(s\.wishlist\.label\)\+'<\/p>':''/);
  assert.doesNotMatch(html, /wishlist=s\.wishlist\?'<h3>Wishlist<\/h3><p><a href=/);
});

test("person hub and influence sources map to Officials with measured coverage", () => {
  const byId = Object.fromEntries(graph.sources.map((source) => [source.id, source]));
  for (const id of ["nyc-council-members", "city-clerk-elobbyist", "cfb-campaign-contributions"]) {
    assert.ok(byId[id], id);
    assert.ok(byId[id].surfaces.includes("Officials"), `${id} surfaces`);
    assert.doesNotMatch(byId[id].surfaces.join(" "), /\bLand\b/);
    assert.match(byId[id].coverage, /Ship|Publish|Usefulness|precision|PersonId|person hub/i);
  }
  const spending = byId["checkbook-spending"];
  assert.ok(spending.surfaces.includes("Money"));
  assert.match(spending.coverage, /payment retention|Follow-the-Dollars/i);
  const agencies = byId["nyc-agencies"];
  assert.ok(agencies.surfaces.includes("Agency profiles"));
  assert.equal(agencies.surfaces.includes("Officials"), false);
});
