import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import edgeWorker from "../site/pages_edge.mjs";
import { buildProcurementSearchDocuments } from "../site/procurement_search_producer.mjs";
import { buildSharedProcurementReadModelShardArtifacts } from "../site/procurement_read_model_shards.mjs";
import { buildProcurementArtifacts } from "../tools/build_shared_procurement_read_model.mjs";

const spine = JSON.parse(readFileSync(
  new URL("../site/data/procurement_spine_sources.json", import.meta.url),
  "utf8",
));
const awards = JSON.parse(readFileSync(
  new URL("../site/data/ocp_awards_warehouse_lookup.json", import.meta.url),
  "utf8",
));
const mtaSources = JSON.parse(readFileSync(
  new URL("../site/data/mta_procurement_sources.json", import.meta.url),
  "utf8",
));
const indexed = JSON.parse(readFileSync(
  new URL("../worker/src/data/keyword_search_index.json", import.meta.url),
  "utf8",
));

const { model, browse } = buildProcurementArtifacts(spine, awards, { mtaSources });
const corpus = buildProcurementSearchDocuments(model);
const modelArtifacts = buildSharedProcurementReadModelShardArtifacts(model);

function normalized(value) {
  return String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function routeEnv() {
  return {
    ASSETS: {
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/data/shared_procurement_read_model.json") return Response.json(modelArtifacts.manifest);
        const shardIndex = modelArtifacts.manifest.shards.findIndex((descriptor) => `/data/${descriptor.path}` === path);
        if (shardIndex >= 0) return Response.json(modelArtifacts.shards[shardIndex]);
        return new Response("asset", { status: 200 });
      },
    },
  };
}

async function procurementRoute(id) {
  return edgeWorker.fetch(new Request(
    `https://cityscroll.org/procurements/${encodeURIComponent(id)}`,
  ), routeEnv());
}

test("every public contract search document has served detail and Browse coverage", () => {
  const modelById = new Map(model.rows.map((row) => [row.procurement_id, row]));
  const browseById = new Map(browse.rows.map((row) => [row.procurement_id, row]));
  const indexedById = new Map(indexed.families.procurements.documents.map((document) => [
    document.object_ref,
    document,
  ]));

  assert.equal(corpus.documents.length, model.rows.length);
  assert.equal(new Set(corpus.documents.map((document) => document.object_ref)).size, corpus.documents.length);
  assert.deepEqual(
    [...indexedById.keys()].sort(),
    corpus.documents.map((document) => document.object_ref).sort(),
    "the committed keyword corpus must be built from the same served object set",
  );

  for (const document of corpus.documents) {
    const row = modelById.get(document.object_ref);
    const browseRow = browseById.get(document.object_ref);
    assert.ok(row, `missing served row for ${document.object_ref}`);
    assert.ok(browseRow, `missing Browse row for ${document.object_ref}`);
    assert.equal(document.canonical_href, browseRow.canonical_href);
    assert.equal(document.canonical_href, `/procurements/${encodeURIComponent(row.procurement_id)}`);
  }

  const publicContractIds = new Set(
    spine.rows.passport_contracts
      .map((row) => normalized(row.contract_id))
      .filter(Boolean),
  );
  for (const contractId of publicContractIds) {
    assert.ok(
      modelById.has(`procurement:contract:${contractId}`),
      `PASSPort contract ${contractId} was not served`,
    );
  }
});

test("reported canonical identities resolve to one source-backed object", async () => {
  const reported = {
    "procurement:contract:CT185720228800365": {
      vendor: "FIREMATIC SUPPLY CO. INC",
      amount: 49689.78,
    },
    "procurement:contract:CT185020228802305": {
      vendor: "TAMEER INC",
      amount: 26112.93,
    },
  };

  for (const [id, expected] of Object.entries(reported)) {
    const rows = model.rows.filter((row) => row.procurement_id === id);
    assert.equal(rows.length, 1, `${id} must identify exactly one procurement object`);
    const row = rows[0];
    assert.deepEqual(row.identity_keys.contract_ids, [id.slice("procurement:contract:".length)]);
    const browseRow = browse.rows.find((candidate) => candidate.procurement_id === id);
    assert.ok(browseRow);
    assert.equal(browseRow.vendor_name, expected.vendor);
    assert.equal(browseRow.contract_amount, expected.amount);

    const response = await procurementRoute(id);
    assert.equal(response.status, 200, id);
    const html = await response.text();
    assert.match(html, /data-civic-object-kind="procurement"/);
    assert.match(html, new RegExp(expected.vendor));
    assert.match(html, new RegExp(expected.amount.toLocaleString("en-US")));
  }

  const moving = browse.rows.find((row) => row.contract_id === "CT100220218800028");
  assert.ok(moving, "the $47,341.46 Moving Services object remains separately addressable");
  assert.equal(moving.short_title, "Moving Services");
  assert.equal(moving.contract_amount, 47341.46);
  assert.notEqual(moving.procurement_id, "procurement:contract:CT185020228802305");
});
