import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMocsPlanRow, runMocsPlanPipeline } from "../src/mocs_plan.mjs";

test("parseMocsPlanRow normalizes various Socrata field variants", () => {
  const row1 = {
    agency: "Design and Construction",
    description: "Build Precinct 123",
    value_band: "$1M - $5M",
    release_quarter: "Q3 FY2027"
  };
  assert.deepEqual(parseMocsPlanRow(row1), {
    agency: "Design and Construction",
    description: "Build Precinct 123",
    value_band: "$1M - $5M",
    release_quarter: "Q3 FY2027"
  });

  const row2 = {
    purchasing_agency: "Buildings",
    contracting_action: "Scaffold audit",
    estimated_cost: "$200K",
    anticipated_release_quarter: "Q4 FY2026"
  };
  assert.deepEqual(parseMocsPlanRow(row2), {
    agency: "Buildings",
    description: "Scaffold audit",
    value_band: "$200K",
    release_quarter: "Q4 FY2026"
  });
});

test("runMocsPlanPipeline fetches MOCS dataset, parses stems, and saves to KV", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(url, /egea-b8r5\.json/);
    return {
      ok: true,
      json: async () => [
        {
          agency: "Design and Construction",
          description: "Precinct CM",
          value_band: "$1M-$5M",
          release_quarter: "Q3 FY2027"
        },
        {
          agency: "Design and Construction",
          description: "Precinct General Contracting",
          value_band: "$5M+",
          release_quarter: "Q4 FY2027"
        }
      ]
    };
  };

  const kvStore = {};
  const env = {
    ALERT_STATE: {
      put: async (key, val) => {
        kvStore[key] = val;
      }
    }
  };

  const res = await runMocsPlanPipeline(env, "egea-b8r5");
  globalThis.fetch = originalFetch; // restore

  assert.equal(res.status, "success");
  assert.ok(kvStore["plan:DESIGN AND CONSTRUCTION"]);
  
  const plans = JSON.parse(kvStore["plan:DESIGN AND CONSTRUCTION"]);
  assert.equal(plans.length, 2);
  assert.equal(plans[0].description, "Precinct CM");
  assert.equal(plans[1].description, "Precinct General Contracting");
});
