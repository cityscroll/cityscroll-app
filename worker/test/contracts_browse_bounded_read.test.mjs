// A Contracts browse must answer a bounded query with bounded work.
//
// The regression this pins: the browse provider used to answer by reading the
// whole object-detail family — every shard of the shared procurement read model
// — and materializing every contract in the population before applying the
// filter. That is work proportional to the population on every call, and once
// the population passed about thirteen thousand contracts it exhausted the
// Worker's resource limits and the endpoint stopped answering at all.
//
// The assertions below are the bound, not the timing: browse must never read
// the object-detail family, must stay inside a byte budget that is a property
// of the published index rather than of the population, and must materialize
// only the page it returns. The fixture is sharded the way production is —
// several read-model shards, several filter shards, many detail shards — so a
// filtered page is the sparse selection it is in production rather than a
// contiguous run.

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSharedProcurementReadModel } from "../../site/shared_procurement_read_model.mjs";
import { buildSharedProcurementReadModelShardArtifacts } from "../../site/procurement_read_model_shards.mjs";
import {
  buildProcurementBrowseCapabilityIndexArtifacts,
  procurementBrowseCapabilityReadBudgetBytes,
  serializedProcurementBrowseCapabilityShard,
} from "../../site/procurement_browse_capability_index.mjs";
import { executeContractGet, executeContractsBrowse } from "../../capabilities/contracts.mjs";
import { workerProcurementContracts } from "../src/contracts.mjs";
import { handleMcp } from "../src/mcp.mjs";

const POPULATION = 240;
const KNOWN_TERM = "parks";
// Every fourth contract is a Parks contract, so the term matches a known,
// non-empty subset that is scattered across every detail shard.
const KNOWN_TERM_MATCHES = POPULATION / 4;
// Small enough that the fixture shards several ways, which is the shape the
// published family has: one filter tier read whole, many small detail shards.
const READ_MODEL_SHARD_MAX_BYTES = 96 * 1024;
const FILTER_SHARD_MAX_BYTES = 24 * 1024;
const DETAIL_SHARD_MAX_BYTES = 8 * 1024;
// Elapsed time is measured with the monotonic performance clock, never a wall
// clock: this is a duration ceiling, not a date the code under test reads.
const WALL_CLOCK_CEILING_MS = 2000;
// A capability that cannot read its index has to say so promptly. The declared
// unavailable answer is the whole point: a slow failure is what a caller
// experienced as a dropped request.
const UNAVAILABLE_CEILING_MS = 1000;

function contractRecord(index) {
  const parks = index % 4 === 0;
  const id = String(1000 + index);
  return {
    source_system: "passport_public_contracts",
    source_system_id: `contract:8412600${id}:CTR-${id}`,
    content_hash: `hash-${id}`,
    normalized_snapshot: JSON.stringify({
      ctr_id: `CTR-${id}`,
      epin: `8412600${id}`,
      contract_id: `CT-${id}`,
      title: parks ? `Parks playground reconstruction ${id}` : `Bridge inspection ${id}`,
      vendor: parks ? "Green Fields Contracting" : "HNTB Corporation",
      agency: parks ? "Department of Parks and Recreation" : "Department of Design and Construction",
      current_amount: 100000 + index * 1000,
      status: "Registered",
      registration_date: "2026-07-20",
    }),
    raw_snapshot: "{}",
    ingested_at: "2026-08-18T19:46:32Z",
  };
}

const model = buildSharedProcurementReadModel({
  sourceRecords: Array.from({ length: POPULATION }, (_, index) => contractRecord(index)),
  lifecycleRows: [],
  generatedAt: "2026-09-06T20:00:00Z",
  now: "2026-09-06T20:01:00Z",
});

const modelArtifacts = buildSharedProcurementReadModelShardArtifacts(model, {
  maxShardBytes: READ_MODEL_SHARD_MAX_BYTES,
});
const capabilityArtifacts = buildProcurementBrowseCapabilityIndexArtifacts(model, {
  filterShardMaxBytes: FILTER_SHARD_MAX_BYTES,
  detailShardMaxBytes: DETAIL_SHARD_MAX_BYTES,
});

/** The published tree this fixture stands in for, path by path. */
function publishedTree() {
  const files = new Map();
  files.set("/data/shared_procurement_read_model.json", `${JSON.stringify(modelArtifacts.manifest, null, 2)}\n`);
  modelArtifacts.manifest.shards.forEach((descriptor, index) => {
    files.set(`/data/${descriptor.path}`, `${JSON.stringify(modelArtifacts.shards[index], null, 2)}\n`);
  });
  files.set("/data/procurement_browse_capability.json", `${JSON.stringify(capabilityArtifacts.manifest, null, 2)}\n`);
  capabilityArtifacts.manifest.filter_shards.forEach((descriptor, index) => {
    files.set(`/data/${descriptor.path}`, serializedProcurementBrowseCapabilityShard(capabilityArtifacts.filterShards[index]));
  });
  capabilityArtifacts.manifest.detail_shards.forEach((descriptor, index) => {
    files.set(`/data/${descriptor.path}`, serializedProcurementBrowseCapabilityShard(capabilityArtifacts.detailShards[index]));
  });
  return files;
}

const TREE = publishedTree();
const INDEX_BYTES = new TextEncoder().encode(TREE.get("/data/procurement_browse_capability.json")).byteLength;

/** Serve the fixture tree over fetch and record exactly what a call read. */
function measuredFetch() {
  const reads = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    const body = TREE.get(path);
    if (body === undefined) return new Response("not found", { status: 404 });
    reads.push({ path, bytes: new TextEncoder().encode(body).byteLength });
    return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return {
    reads,
    restore() { globalThis.fetch = original; },
    get bytes() { return reads.reduce((total, read) => total + read.bytes, 0); },
  };
}

class MockKV {
  async get() { return null; }
  async put() {}
}

function mcpRequest(args) {
  return new Request("https://api.cityscroll.org/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.99" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "browse_contracts", arguments: args },
    }),
  });
}

test("the fixture is sharded the way the published families are", () => {
  assert.ok(modelArtifacts.manifest.shards.length > 1, "read model must span several shards");
  assert.ok(capabilityArtifacts.manifest.filter_shards.length > 1, "filter tier must span several shards");
  assert.ok(capabilityArtifacts.manifest.detail_shards.length > 8, "detail tier must be many small shards");
  assert.equal(capabilityArtifacts.manifest.entry_count, POPULATION);
});

test("the exact production request answers with results and reads bounded bytes", async () => {
  const measured = measuredFetch();
  try {
    const startedAt = performance.now();
    const response = await handleMcp(mcpRequest({ query: KNOWN_TERM }), { SUBS: new MockKV() });
    const elapsedMs = performance.now() - startedAt;
    assert.equal(response.status, 200);
    const result = (await response.json()).result.structuredContent;

    // A correct, non-empty answer for a known term.
    assert.equal(result.availability, "complete");
    assert.equal(result.total_matches, KNOWN_TERM_MATCHES);
    assert.equal(result.results.length, 25);
    assert.ok(result.results.every((contract) => JSON.stringify(contract.fields).toLowerCase().includes(KNOWN_TERM)));
    assert.deepEqual(
      result.results.map((contract) => contract.procurement_id),
      [...result.results].map((contract) => contract.procurement_id).sort((left, right) => left.localeCompare(right)),
    );

    // The object-detail family is what a browse must never read: it is the
    // whole population, and reading it is what exhausted the Worker.
    const detailFamilyReads = measured.reads.filter((read) => read.path.startsWith("/data/shared_procurement_read_model"));
    assert.deepEqual(detailFamilyReads, [], "browse must not read the shared read model");

    // The byte budget is a property of the published index — the filter tier
    // plus at most one detail shard per returned row — not of the population.
    const budget = procurementBrowseCapabilityReadBudgetBytes(capabilityArtifacts.manifest, 25, INDEX_BYTES);
    assert.ok(measured.bytes <= budget, `read ${measured.bytes} bytes, budget ${budget}`);

    // One detail shard per returned row at worst, and never more.
    const detailReads = measured.reads.filter((read) => read.path.includes("/procurement_browse_capability/detail-"));
    assert.ok(detailReads.length <= result.results.length, `read ${detailReads.length} detail shards for 25 rows`);

    assert.ok(elapsedMs < WALL_CLOCK_CEILING_MS, `took ${Math.round(elapsedMs)}ms`);
  } finally {
    measured.restore();
  }
});

test("a larger page stays inside the same shape of budget", async () => {
  const measured = measuredFetch();
  try {
    const response = await handleMcp(mcpRequest({ query: KNOWN_TERM, limit: 60 }), { SUBS: new MockKV() });
    const result = (await response.json()).result.structuredContent;
    assert.equal(result.results.length, 60);
    assert.equal(result.total_matches, KNOWN_TERM_MATCHES);
    const budget = procurementBrowseCapabilityReadBudgetBytes(capabilityArtifacts.manifest, 60, INDEX_BYTES);
    assert.ok(measured.bytes <= budget, `read ${measured.bytes} bytes, budget ${budget}`);
    const detailReads = measured.reads.filter((read) => read.path.includes("/procurement_browse_capability/detail-"));
    assert.ok(detailReads.length <= 60);
  } finally {
    measured.restore();
  }
});

test("a browse row is the same projection as the object read", async () => {
  const measured = measuredFetch();
  try {
    const browse = await executeContractsBrowse(workerProcurementContracts({}).browse, { query: KNOWN_TERM, limit: 3 });
    for (const contract of browse.results) {
      const object = await executeContractGet(workerProcurementContracts({}).get, { procurementId: contract.procurement_id });
      assert.equal(object.availability, "available");
      assert.deepEqual(contract, object.contract);
    }
  } finally {
    measured.restore();
  }
});

test("an unpublished index reports the capability unavailable instead of failing the request", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response("not found", { status: 404 });
  try {
    const startedAt = performance.now();
    const response = await handleMcp(mcpRequest({ query: KNOWN_TERM }), { SUBS: new MockKV() });
    const elapsedMs = performance.now() - startedAt;
    assert.equal(response.status, 200);
    const result = (await response.json()).result.structuredContent;
    assert.equal(result.availability, "unavailable");
    assert.equal(result.error, "unavailable");
    assert.equal(result.results, null);
    assert.ok(elapsedMs < UNAVAILABLE_CEILING_MS, `took ${Math.round(elapsedMs)}ms`);
  } finally {
    globalThis.fetch = original;
  }
});
