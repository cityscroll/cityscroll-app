import { test } from "node:test";
import assert from "node:assert/strict";
import { handleForecast } from "../src/checkbook.mjs";
import { handleInv } from "../src/inv.mjs";

function kv(map = {}) {
  return {
    get: async (k) => (Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null),
    put: async (k, v) => { map[k] = v; },
    list: async (options = {}) => {
      const prefix = options.prefix || "";
      const keys = Object.keys(map)
        .filter((k) => k.startsWith(prefix))
        .map((k) => ({ name: k }));
      return { keys, list_complete: true };
    }
  };
}

test("GET /forecast returns forecasts matching stem prefix", async () => {
  const env = {
    ALERT_STATE: kv({
      "fc:DESIGN AND CONSTRUCTION": JSON.stringify([
        { contract_id: "CTA1", expiration_date: "2029-07-01" }
      ]),
      "plan:DESIGN AND CONSTRUCTION": JSON.stringify([
        { description: "Precinct CM", release_quarter: "Q3 FY2027" }
      ])
    })
  };

  const req = new Request("https://w/forecast?q=Design%20and%20Construction", { method: "GET" });
  const r = await handleForecast(req, env);
  
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.length, 2);
  assert.equal(body[0].contract_id, "CTA1");
  assert.equal(body[1].description, "Precinct CM");
});

test("GET /inv/:id fetches shared snapshot if exists in SUBS", async () => {
  const env = {
    SUBS: kv({
      "inv:shared123": JSON.stringify({ name: "My Inv", items: [] })
    })
  };

  const req = new Request("https://w/inv/shared123", { method: "GET" });
  const r = await handleInv(req, env, "/inv/shared123");
  
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.name, "My Inv");
});

test("GET /inv/:id returns agency forecasts if not found as shared snapshot", async () => {
  const env = {
    SUBS: kv(),
    ALERT_STATE: kv({
      "fc:SINERGIA": JSON.stringify([
        { contract_id: "CTA9", expiration_date: "2028-01-01" }
      ])
    })
  };

  const req = new Request("https://w/inv/SINERGIA", { method: "GET" });
  const r = await handleInv(req, env, "/inv/SINERGIA");
  
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.id, "SINERGIA");
  assert.equal(body.forecasts.length, 1);
  assert.equal(body.forecasts[0].contract_id, "CTA9");
});
