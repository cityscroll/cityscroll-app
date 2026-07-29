import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { runMocsPlanPipeline } from "../src/mocs_plan.mjs";

const fieldCase = JSON.parse(readFileSync(
  new URL("../../test/fixtures/source_contracts/mocs-field-case.json", import.meta.url),
));

test("the configured and documented MOCS dataset IDs reproduce the field failure", () => {
  assert.equal(fieldCase.configured.dataset_id, "egea-b8r5");
  assert.equal(fieldCase.configured.metadata.assetType, "href");
  assert.deepEqual(fieldCase.configured.metadata.columns, []);
  assert.equal(fieldCase.configured.resource.status, 403);
  assert.match(fieldCase.configured.resource.body.message, /non-tabular/);

  assert.equal(fieldCase.documented.dataset_id, "whpb-ebtd");
  assert.equal(fieldCase.documented.resource.status, 404);
  assert.equal(fieldCase.documented.resource.body.code, "dataset.missing");
});

test("live MOCS field case still matches the recorded source failure", {
  skip: process.env.CITYSCROLL_LIVE_SOURCES !== "1",
}, async () => {
  const configuredMeta = await fetch(
    `https://data.cityofnewyork.us/api/views/${fieldCase.configured.dataset_id}`,
  ).then((response) => response.json());
  assert.equal(configuredMeta.assetType, "href");
  assert.deepEqual(configuredMeta.columns, []);

  for (const source of [fieldCase.configured, fieldCase.documented]) {
    const response = await fetch(
      `https://data.cityofnewyork.us/resource/${source.dataset_id}.json?$limit=1`,
    );
    const body = await response.json();
    assert.equal(response.status, source.resource.status);
    assert.equal(body.error, true);
  }
});

test("disabled MOCS pipeline performs no fetch and removes stale plan rows", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => {
    assert.fail("a disabled source must not be fetched");
  };

  const kvStore = {
    "plan:DESIGN AND CONSTRUCTION": JSON.stringify([{ description: "stale" }]),
    "plan:BUILDINGS": JSON.stringify([{ description: "stale" }]),
    "fc:DESIGN AND CONSTRUCTION": JSON.stringify([{ contract_id: "keep" }]),
  };
  const env = {
    ALERT_STATE: {
      list: async ({ prefix }) => ({
        keys: Object.keys(kvStore).filter((name) => name.startsWith(prefix)).map((name) => ({ name })),
        list_complete: true,
      }),
      delete: async (key) => { delete kvStore[key]; },
    }
  };

  const result = await runMocsPlanPipeline(env);
  assert.deepEqual(result, { status: "disabled", removed: 2 });
  assert.deepEqual(Object.keys(kvStore), ["fc:DESIGN AND CONSTRUCTION"]);
});
