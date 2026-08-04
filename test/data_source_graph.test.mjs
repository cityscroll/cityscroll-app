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
  assert.equal(graph.sources.length, registry.contracts.length);
  assert.deepEqual(new Set(graph.sources.map((source) => source.id)), new Set(registry.contracts.map((source) => source.id)));
  const documentedNames = [...sourceDocument.matchAll(/^\| (?:live|build-time|manual|disabled) \| [^|]+ \| \[([^\]]+)\]/gm)].map((match) => match[1]);
  assert.deepEqual(new Set(graph.sources.map((source) => source.name)), new Set(documentedNames));
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
  assert.equal((html.match(/data-source-row=/g) || []).length, registry.contracts.length);
  assert.doesNotMatch(html, /<script[^>]+src=/);
});
