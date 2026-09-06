import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildProcurementBrowseQueryArtifacts,
  loadProcurementBrowseQuery,
} from "../site/procurement_browse_query.mjs";
import { filterMoneySnapshot } from "../site/resident_snapshot_queries.mjs";
import {
  moneyBoundedAwardArchiveEligible,
  moneyBoundedAwardArchiveFallbackReason,
} from "../site/procurement_browse_read_path.mjs";
import { readProcurementBrowsePopulation } from "../tools/lib/procurement_browse_population_io.mjs";

const moneyListSource = readFileSync(new URL("../site/app/money-list.mjs", import.meta.url), "utf8");

test("search() wires the bounded read-path decision into the compact-first-page branch", () => {
  assert.match(moneyListSource, /from "\.\.\/procurement_browse_read_path\.mjs"/);
  assert.match(moneyListSource, /eligible:compactFirstPage.*=moneyBrowseReadPath\(/);
  assert.match(moneyListSource, /loadMoneyProcurementSnapshot\({\.\.\.common,method:methodSel},\[\]\)/);
});

test("Award and Archive route around the full snapshot for any facet the compact rows carry", () => {
  const base = { mode: "award", needsSearch: false, analyticalScopeActive: false, entityRefs: [], contractIdentity: null };
  assert.equal(moneyBoundedAwardArchiveEligible(base), true);
  assert.equal(moneyBoundedAwardArchiveFallbackReason(base), null);
  for (const mode of ["award", "archive"]) {
    assert.equal(moneyBoundedAwardArchiveEligible({ ...base, mode }), true, `${mode}: zero filters`);
    // Every locally-indexed facet — agency, method, amount band, category,
    // exclusion, process state, and sort — stays on the bounded path: none of
    // them is a reason to fall back to the full resident snapshot.
    assert.equal(moneyBoundedAwardArchiveEligible({ ...base, mode }), true, `${mode}: with facets`);
  }
});

test("Open and All RFPs never route to the bounded path: the shards do not index the solicitation feed", () => {
  const base = { needsSearch: false, analyticalScopeActive: false, entityRefs: [], contractIdentity: null };
  for (const mode of ["open", "allrfp"]) {
    assert.equal(moneyBoundedAwardArchiveEligible({ ...base, mode }), false, mode);
    assert.equal(moneyBoundedAwardArchiveFallbackReason({ ...base, mode }), "mode_not_indexed", mode);
  }
});

test("A query the shards cannot answer falls back to the full read, with the reason recorded", () => {
  const base = { mode: "award", needsSearch: false, analyticalScopeActive: false, entityRefs: [], contractIdentity: null };
  assert.equal(moneyBoundedAwardArchiveEligible({ ...base, needsSearch: true }), false);
  assert.equal(moneyBoundedAwardArchiveFallbackReason({ ...base, needsSearch: true }), "keyword_or_reference_search");
  assert.equal(moneyBoundedAwardArchiveEligible({ ...base, analyticalScopeActive: true }), false);
  assert.equal(moneyBoundedAwardArchiveFallbackReason({ ...base, analyticalScopeActive: true }), "analytics_scope");
  assert.equal(moneyBoundedAwardArchiveEligible({ ...base, entityRefs: ["agency:id:1"] }), false);
  assert.equal(moneyBoundedAwardArchiveFallbackReason({ ...base, entityRefs: ["agency:id:1"] }), "entity_scope");
  assert.equal(moneyBoundedAwardArchiveEligible({ ...base, contractIdentity: { object_ref: "procurement:x" } }), false);
  assert.equal(moneyBoundedAwardArchiveFallbackReason({ ...base, contractIdentity: { object_ref: "procurement:x" } }), "entity_scope");
});

const fullBrowse = readProcurementBrowsePopulation(
  new URL("../site/data/procurement_browse_rows.json", import.meta.url),
);
const { manifest, shards, queryRowsArtifact } = buildProcurementBrowseQueryArtifacts({
  ...fullBrowse,
  source_model_fingerprint: "browse-contracts-first-page-fixture-fingerprint",
});

// Every combination `moneyBoundedAwardArchiveEligible` now waves through: the
// zero-filter first page plus every locally-indexed facet (agency, method,
// amount band, exclusion, process state, sort) that used to force the full
// resident-snapshot read.
const FIXTURE_QUERIES = [
  { name: "award, no filters", options: { mode: "award", sort: "newest" } },
  { name: "archive, no filters", options: { mode: "archive", sort: "newest" } },
  {
    name: "award, agency + amount band + amount sort",
    options: { mode: "award", agency: "Youth and Community Development", minAmount: 1, maxAmount: 500_000_000, sort: "amount" },
  },
  {
    name: "archive, agency + method",
    options: { mode: "archive", agency: "Youth and Community Development", method: "Renewal", sort: "newest" },
  },
  {
    name: "award, exclude special methods",
    options: { mode: "award", excludeSpecial: true, sort: "newest" },
  },
  {
    name: "archive, process state",
    options: { mode: "archive", processStates: ["registered"], sort: "newest" },
  },
];

function response(ok, payload) {
  return { ok, async json() { return payload; } };
}

function fetchImpl(calls) {
  return async (url) => {
    calls.push(url);
    if (url === "manifest") return response(true, manifest);
    if (url === "data/procurement_browse_query_rows.json") return response(true, queryRowsArtifact);
    const index = manifest.shards.findIndex((descriptor) => `data/${descriptor.path}` === url);
    if (index >= 0) return response(true, shards[index]);
    throw new Error(`unexpected fetch ${url}`);
  };
}

test("the bounded path and the full path yield the same first 40 rows for every fixture query", async () => {
  for (const { name, options } of FIXTURE_QUERIES) {
    assert.equal(moneyBoundedAwardArchiveEligible({
      mode: options.mode, needsSearch: false, analyticalScopeActive: false, entityRefs: [], contractIdentity: null,
    }), true, `${name}: must be eligible for the bounded path`);
    const calls = [];
    const bounded = await loadProcurementBrowseQuery({
      fetchImpl: fetchImpl(calls),
      manifestUrl: "manifest",
      options,
    });
    const full = filterMoneySnapshot(fullBrowse.rows, { ...options, limit: 40 });
    assert.deepEqual(
      bounded.rows.map((row) => row.procurement_id || row.request_id),
      full.map((row) => row.procurement_id || row.request_id),
      `${name}: first 40 rows must match identically`,
    );
    // A1: rendering the first 40 rows never needed the full snapshot artifact.
    assert.deepEqual(calls.filter((url) => url.includes("money_resident_snapshot")), [], `${name}: no snapshot fetch`);
    assert.deepEqual(calls.filter((url) => url === "data/procurement_browse_rows.json"), [], `${name}: no unpublished monolith fetch`);
  }
});

test("a cold non-default Contracts trace paints the first 40 rows before the resident snapshot is ever requested", async () => {
  // This mirrors the read-path decision in site/app/money-list.mjs search():
  // the resident-snapshot fetch is deferred until after the bounded first
  // page has painted, not started ahead of it.
  const events = [];
  const options = { mode: "award", agency: "Youth and Community Development", sort: "newest" };
  const eligible = moneyBoundedAwardArchiveEligible({
    mode: options.mode, needsSearch: false, analyticalScopeActive: false, entityRefs: [], contractIdentity: null,
  });
  assert.equal(eligible, true);

  function loadMoneyResidentSnapshotStub() {
    events.push("resident-snapshot-fetch-issued");
    return Promise.resolve({ rows: [] });
  }

  const calls = [];
  const canonicalFirstPage = await loadProcurementBrowseQuery({
    fetchImpl: fetchImpl(calls),
    manifestUrl: "manifest",
    options,
  });
  events.push("first-40-rows-painted");
  // Hydration/reconciliation only fires the resident-snapshot fetch after paint.
  void Promise.resolve(canonicalFirstPage.hydrate()).then(() => loadMoneyResidentSnapshotStub());
  await canonicalFirstPage.hydrate();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(events, ["first-40-rows-painted", "resident-snapshot-fetch-issued"]);
  assert.deepEqual(calls.filter((url) => url.includes("money_resident_snapshot")), []);
});
