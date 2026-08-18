import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import edgeWorker, { edgeRequestKind } from "../site/pages_edge.mjs";
import { procurementCanonicalHref } from "../site/procurement_object_contract.mjs";
import { buildSharedProcurementReadModel } from "../site/shared_procurement_read_model.mjs";

const cohort = JSON.parse(readFileSync(
  new URL("./fixtures/procurement_search/golden_cohort.json", import.meta.url),
  "utf8",
));
const model = buildSharedProcurementReadModel({
  sourceRecords: cohort.source_records,
  generatedAt: cohort.generated_at,
});

test("canonical procurement route resolves without request_id", async () => {
  const object = model.rows.find((row) => row.procurement_id === "procurement:contract:CT101520271400806");
  const href = procurementCanonicalHref(object);
  assert.equal(edgeRequestKind(`https://cityscroll.org${href}`), "procurement");
  const env = {
    ASSETS: {
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/data/shared_procurement_read_model.json") {
          return Response.json(model);
        }
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
