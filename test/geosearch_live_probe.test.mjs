/**
 * nyc-geosearch live probe: transient non-JSON / empty / gateway bodies are
 * upstream_unavailable (with retry), while a JSON body that fails the
 * FeatureCollection shape remains schema drift.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { sourceContractIssueBody } from "../tools/external_schedule_runner.mjs";
import { sourceContractFailureClass } from "../tools/repair_findings.mjs";
import {
  responseBodyExcerpt,
  verifyGeosearch,
} from "../tools/verify_source_contracts.mjs";

const CONTRACT = {
  id: "nyc-geosearch",
  kind: "geosearch",
  endpoint: "https://geosearch.planninglabs.nyc/v2/search",
};

const PROBE_OPTIONS = { unavailableRetry: 1, unavailableBackoffMs: 0 };

function featureCollection(overrides = {}) {
  return {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: {
        label: "City Hall, New York, NY, USA",
        borough: "Manhattan",
        ...overrides.properties,
      },
      ...overrides.feature,
    }],
    ...overrides,
  };
}

test("responseBodyExcerpt collapses whitespace and bounds length", () => {
  assert.equal(responseBodyExcerpt(""), "(empty)");
  assert.equal(responseBodyExcerpt("   "), "(empty)");
  assert.equal(responseBodyExcerpt("<html>\n  gateway\n</html>"), "<html> gateway </html>");
  assert.equal(responseBodyExcerpt("x".repeat(200), 20), `${"x".repeat(20)}…`);
});

test("a non-JSON HTML body is upstream_unavailable with status and excerpt, after one retry", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("<html><h1>Bad Gateway</h1></html>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
  };

  const error = await verifyGeosearch(CONTRACT, PROBE_OPTIONS).catch((reason) => reason);
  assert.match(error.message, /upstream_unavailable HTTP 200/);
  assert.match(error.message, /body=<html><h1>Bad Gateway<\/h1><\/html>/);
  assert.doesNotMatch(error.message, /response is not JSON/);
  assert.equal(calls, 2);

  assert.equal(sourceContractFailureClass(error.message), "source-contract-outage");
  const body = sourceContractIssueBody({ id: CONTRACT.id, detail: error.message }, null);
  assert.match(body, /^Classification: outage\./m);
  assert.doesNotMatch(body, /schema drift/);
});

test("a 5xx gateway response is upstream_unavailable, not schema drift", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  // labeledFetch already retries 5xx once; return 502 on every attempt.
  globalThis.fetch = async () => new Response("<html>502 Bad Gateway</html>", {
    status: 502,
    headers: { "Content-Type": "text/html" },
  });

  const error = await verifyGeosearch(CONTRACT, PROBE_OPTIONS).catch((reason) => reason);
  assert.match(error.message, /upstream_unavailable HTTP 502/);
  assert.match(error.message, /body=<html>502 Bad Gateway<\/html>/);
  assert.equal(sourceContractFailureClass(error.message), "source-contract-outage");
  assert.match(
    sourceContractIssueBody({ id: CONTRACT.id, detail: error.message }, null),
    /^Classification: outage\./m,
  );
});

test("an empty body is upstream_unavailable with an empty excerpt", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response("", {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

  const error = await verifyGeosearch(CONTRACT, PROBE_OPTIONS).catch((reason) => reason);
  assert.match(error.message, /upstream_unavailable HTTP 200/);
  assert.match(error.message, /body=\(empty\)/);
  assert.equal(sourceContractFailureClass(error.message), "source-contract-outage");
});

test("a JSON body that fails the FeatureCollection shape is schema drift without retry", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ type: "FeatureCollection", features: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  await assert.rejects(
    verifyGeosearch(CONTRACT, PROBE_OPTIONS),
    /response has no feature label/,
  );
  assert.equal(calls, 1);

  const driftDetail = "nyc-geosearch: response has no feature label";
  assert.equal(sourceContractFailureClass(driftDetail), "source-contract-schema-drift");
  assert.match(
    sourceContractIssueBody({ id: CONTRACT.id, detail: driftDetail }, null),
    /^Classification: schema drift\./m,
  );
});

test("a JSON body missing borough is schema drift", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(JSON.stringify({
    type: "FeatureCollection",
    features: [{ type: "Feature", properties: { label: "City Hall, New York, NY, USA" } }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });

  await assert.rejects(verifyGeosearch(CONTRACT, PROBE_OPTIONS), /response has no borough/);
});

test("a transient non-JSON body that recovers on retry is healthy", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response("<html>temporary</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    }
    return new Response(JSON.stringify(featureCollection()), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const detail = await verifyGeosearch(CONTRACT, PROBE_OPTIONS);
  assert.equal(detail, "availability and schema");
  assert.equal(calls, 2);
});
