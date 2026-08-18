import { test } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/worker.mjs";
import {
  handleSourceHealth,
  unavailablePublicSourceHealth,
} from "../src/source_health.mjs";

test("GET /source-health serves only the committed public artifact", async () => {
  const response = await worker.fetch(
    new Request("https://api.cityscroll.org/source-health"),
    {},
    {},
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  assert.match(response.headers.get("Content-Type"), /^application\/json/);
  const body = await response.json();
  assert.equal(body.schema, "cityscroll.public_source_health.v1");
  assert.equal(body.available, true);
  assert.equal(body.source_count, body.sources.length);
  assert.ok(body.sources.length > 0);
  assert.doesNotMatch(JSON.stringify(body), /contract_fingerprint|auth_token_env|runbook|raw_error_body|row_count/i);
});

test("source-health endpoint is read-only", async () => {
  const response = await handleSourceHealth(new Request("https://api.cityscroll.org/source-health", {
    method: "POST",
  }));
  assert.equal(response.status, 405);
});

test("unavailable or unsafe public data returns honest nulls without private errors", async () => {
  const unavailable = unavailablePublicSourceHealth();
  assert.deepEqual(unavailable, {
    schema: "cityscroll.public_source_health.v1",
    generated_at: null,
    available: false,
    source_count: null,
    sources: null,
  });

  const response = await handleSourceHealth(
    new Request("https://api.cityscroll.org/source-health"),
    {
      projection: {
        schema: "cityscroll.public_source_health.v1",
        generated_at: "2026-08-18T12:00:00.000Z",
        available: true,
        source_count: 1,
        sources: [{ source_id: "unsafe", raw_error_body: "secret upstream body" }],
      },
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), unavailable);
});
