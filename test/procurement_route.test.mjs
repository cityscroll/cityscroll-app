import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import edgeWorker, { edgeRequestKind } from "../site/pages_edge.mjs";
import { procurementCanonicalHref } from "../site/procurement_object_contract.mjs";
import { buildSharedProcurementReadModel } from "../site/shared_procurement_read_model.mjs";
import { buildSharedProcurementReadModelShardArtifacts } from "../site/procurement_read_model_shards.mjs";

const cohort = JSON.parse(readFileSync(
  new URL("./fixtures/procurement_search/golden_cohort.json", import.meta.url),
  "utf8",
));
const model = buildSharedProcurementReadModel({
  sourceRecords: cohort.source_records,
  generatedAt: cohort.generated_at,
});
const modelArtifacts = buildSharedProcurementReadModelShardArtifacts(model);

test("canonical procurement route resolves without request_id", async () => {
  const object = model.rows.find((row) => row.procurement_id === "procurement:contract:CT101520271400806");
  const href = procurementCanonicalHref(object);
  assert.equal(edgeRequestKind(`https://cityscroll.org${href}`), "procurement");
  const env = {
    ASSETS: {
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/data/shared_procurement_read_model.json") {
          return Response.json(modelArtifacts.manifest);
        }
        const shardIndex = modelArtifacts.manifest.shards.findIndex((descriptor) => `/data/${descriptor.path}` === path);
        if (shardIndex >= 0) return Response.json(modelArtifacts.shards[shardIndex]);
        return new Response("asset", { status: 200 });
      },
    },
  };
  const response = await edgeWorker.fetch(new Request(`https://cityscroll.org${href}`), env);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /data-civic-object-kind="procurement"/);
  assert.match(html, /Small purchase legal services/);
  assert.match(html, /registered/i);
  assert.doesNotMatch(html, /request_id|not yet|no data/i);
});

test("A8 named assertion: resident procurement detail reads only materialized assets", async () => {
  const object = model.rows.find((row) => row.procurement_id === "procurement:contract:CT101520271400806");
  const href = procurementCanonicalHref(object);
  const assetPaths = [];
  let requestTimeNetworkCalls = 0;
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    requestTimeNetworkCalls += 1;
    throw new Error("request-time network access");
  };
  try {
    const env = {
      ASSETS: {
        async fetch(request) {
          const path = new URL(request.url).pathname;
          assetPaths.push(path);
          if (path === "/data/shared_procurement_read_model.json") return Response.json(modelArtifacts.manifest);
          const shardIndex = modelArtifacts.manifest.shards.findIndex((descriptor) => `/data/${descriptor.path}` === path);
          if (shardIndex >= 0) return Response.json(modelArtifacts.shards[shardIndex]);
          return new Response("asset", { status: 200 });
        },
      },
    };
    const response = await edgeWorker.fetch(new Request(`https://cityscroll.org${href}`), env);
    assert.equal(response.status, 200);
  } finally {
    globalThis.fetch = priorFetch;
  }
  assert.equal(requestTimeNetworkCalls, 0);
  assert.ok(assetPaths.length >= 2);
  assert.ok(assetPaths.every((path) => path === "/data/shared_procurement_read_model.json" || path.startsWith("/data/shared_procurement_read_model/")));
  assert.equal(assetPaths.some((path) => /analytics|checkbook|passport|city.?record|soda/i.test(path)), false);
});
