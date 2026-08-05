import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import {
  DEFAULT_OUTPUT_DIR,
  HTML_OUTPUT,
  JSON_OUTPUT,
  ROOT,
  buildDataSourceGraph,
  checkGraphBuild,
  declaredInputPaths,
  generatedGraphFiles,
  inputManifest,
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

test("source graph declares topology inputs and derives outputs outside the committed tree", () => {
  const paths = declaredInputPaths();
  for (const required of [
    "docs/data-sources.md",
    "site/data/gap_taxonomy.json",
    "site/data/source_contracts.json",
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
});
