import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildProcurementBrowseQueryArtifacts,
  combineProcurementBrowseQueryShards,
  loadProcurementBrowseQuery,
  PROCUREMENT_BROWSE_QUERY_FIELDS,
  queryProcurementBrowseManifest,
  validateProcurementBrowseQueryManifest,
} from "../site/procurement_browse_query.mjs";
import { filterMoneySnapshot, moneyMethodFacet } from "../site/resident_snapshot_queries.mjs";

const fullBrowse = JSON.parse(readFileSync(
  new URL("../site/data/procurement_browse_rows.json", import.meta.url),
  "utf8",
));
// The query manifest and shards are Pages build artifacts, not committed
// fixtures. Build the test input from the tracked full projection so the
// equivalence proof covers the same deterministic source used in deploy.
const committedArtifacts = buildProcurementBrowseQueryArtifacts({
  ...fullBrowse,
  source_model_fingerprint: "source-fingerprint-fixture",
});
const { manifest: committedManifest, shards: shardPayloads } = committedArtifacts;

const cases = [
  { name: "recent awards", options: { mode: "award", sort: "newest" } },
  { name: "archive", options: { mode: "archive", sort: "newest" } },
  {
    name: "agency and amount scope",
    options: {
      mode: "award", agency: "Housing Preservation and Development", minAmount: 100_000,
      maxAmount: 5_000_000, sort: "amount",
    },
  },
  {
    name: "agency and method scope",
    options: { mode: "archive", agency: "Department of Education", method: "Renewal", sort: "newest" },
  },
  { name: "keyword query", options: { mode: "award", keyword: "bridge", sort: "newest" } },
];

function comparable(row) {
  return Object.fromEntries(PROCUREMENT_BROWSE_QUERY_FIELDS
    .filter((field) => Object.hasOwn(row || {}, field))
    .map((field) => [field, row[field]]));
}

test("bounded Contracts queries are exactly equivalent to the legacy full read", () => {
  assert.equal(validateProcurementBrowseQueryManifest(committedManifest), true);
  assert.equal(committedManifest.row_count, fullBrowse.rows.length);

  for (const { name, options } of cases) {
    const full = filterMoneySnapshot(fullBrowse.rows, { ...options, limit: Number.MAX_SAFE_INTEGER });
    const bounded = queryProcurementBrowseManifest(committedManifest, options);
    assert.deepEqual(
      bounded.ordered_ids,
      full.map((row) => row.procurement_id || row.request_id).filter(Boolean),
      `${name}: stable identity order must match`,
    );
    assert.equal(bounded.total, full.length, `${name}: total must match`);
    assert.deepEqual(bounded.facets.method, moneyMethodFacet(full, Number.MAX_SAFE_INTEGER), `${name}: facets must match`);
    assert.deepEqual(
      bounded.rows.map(comparable),
      full.slice(0, 40).map(comparable),
      `${name}: first-page field values must match`,
    );
  }
});

test("post-paint hydration reassembles every full Browse row without loss", () => {
  const hydrated = combineProcurementBrowseQueryShards(committedManifest, shardPayloads);
  assert.equal(hydrated.length, fullBrowse.rows.length);
  assert.deepEqual(hydrated, fullBrowse.rows);
});

test("query artifacts carry freshness and regenerate changed source rows", () => {
  const changed = {
    ...fullBrowse,
    source_model_fingerprint: "source-fingerprint-after-refresh",
    rows: fullBrowse.rows.map((row, index) => index === 0
      ? { ...row, contract_amount: Number(row.contract_amount || 0) + 1 }
      : row),
  };
  const artifacts = buildProcurementBrowseQueryArtifacts(changed, { shardRows: 3 });
  assert.notEqual(artifacts.manifest.source_model_fingerprint, committedManifest.source_model_fingerprint);
  assert.equal(artifacts.manifest.query_rows[0].contract_amount, changed.rows[0].contract_amount);
  assert.equal(artifacts.manifest.row_count, changed.rows.length);
  assert.equal(combineProcurementBrowseQueryShards(artifacts.manifest, artifacts.shards).length, changed.rows.length);
});

test("a refreshed source artifact is served and stale shards fall back", async () => {
  const changed = {
    ...fullBrowse,
    source_model_fingerprint: "source-fingerprint-after-refresh",
    rows: fullBrowse.rows.map((row, index) => index === 0
      ? { ...row, contract_amount: Number(row.contract_amount || 0) + 1 }
      : row),
  };
  const artifacts = buildProcurementBrowseQueryArtifacts(changed, { shardRows: 3 });
  const calls = [];
  const result = await loadProcurementBrowseQuery({
    fetchImpl: async (url) => {
      calls.push(url);
      if (url === "manifest") return response(true, artifacts.manifest);
      if (url === "legacy") return response(true, fullBrowse);
      const index = artifacts.manifest.shards.findIndex((descriptor) => `data/${descriptor.path}` === url);
      return response(index >= 0, index >= 0 ? artifacts.shards[index] : null);
    },
    manifestUrl: "manifest",
    legacyUrl: "legacy",
    options: { mode: "award" },
  });
  assert.equal(result.source, "bounded-query");
  assert.equal((await result.hydrate()).rows[0].contract_amount, changed.rows[0].contract_amount);
  assert.equal((await result.hydrate()).manifest.source_model_fingerprint, changed.source_model_fingerprint);
  assert.ok(!calls.includes("legacy"));

  const stale = artifacts.shards.map((shard, index) => index === 0
    ? { ...shard, source_fingerprint: "stale-source" }
    : shard);
  const fallback = await loadProcurementBrowseQuery({
    fetchImpl: async (url) => {
      if (url === "manifest") return response(true, artifacts.manifest);
      if (url === "legacy") return response(true, fullBrowse);
      const index = artifacts.manifest.shards.findIndex((descriptor) => `data/${descriptor.path}` === url);
      return response(true, stale[index]);
    },
    manifestUrl: "manifest",
    legacyUrl: "legacy",
    options: { mode: "archive" },
  });
  assert.equal((await fallback.hydrate()).source, "legacy-full");
  assert.deepEqual((await fallback.hydrate()).rows, fullBrowse.rows);
});

function response(ok, payload) {
  return { ok, async json() { return payload; } };
}

test("bounded-artifact failure falls back to the complete legacy read", async () => {
  const calls = [];
  const result = await loadProcurementBrowseQuery({
    fetchImpl: async (url) => {
      calls.push(url);
      if (url === "manifest") return response(false, null);
      return response(true, fullBrowse);
    },
    manifestUrl: "manifest",
    legacyUrl: "legacy",
    options: { mode: "award" },
  });
  assert.equal(result.source, "legacy-full");
  assert.deepEqual(result.rows, fullBrowse.rows);
  assert.deepEqual((await result.hydrate()).rows, fullBrowse.rows);
  assert.deepEqual(calls, ["manifest", "legacy"]);
});

test("a hydration shard failure falls back instead of exposing a truncated set", async () => {
  const calls = [];
  const result = await loadProcurementBrowseQuery({
    fetchImpl: async (url) => {
      calls.push(url);
      if (url === "manifest") return response(true, committedManifest);
      if (url.includes("shard-000")) return response(false, null);
      return response(true, fullBrowse);
    },
    manifestUrl: "manifest",
    legacyUrl: "legacy",
    options: { mode: "archive" },
  });
  assert.equal(result.source, "bounded-query");
  assert.equal(result.rows.length, 40);
  const hydrated = await result.hydrate();
  assert.equal(hydrated.source, "legacy-full");
  assert.deepEqual(hydrated.rows, fullBrowse.rows);
  assert.ok(calls.includes("legacy"));
});
