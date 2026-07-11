// Tests for worker/src/lib/forecast_score.mjs
// Uses mock D1 and KV bindings — no real database or network calls.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  predictionWindow,
  agencyStem,
  pinPrefix,
  checkPredictionHit,
  collectPredictions,
  pastWindowPredictions,
  scoreForecastAccuracy,
  WINDOW_DAYS,
} from "../src/lib/forecast_score.mjs";

// ---- unit helpers -------------------------------------------------------

test("predictionWindow: ±30 days around a date", () => {
  const [lo, hi] = predictionWindow("2026-06-01", 30);
  assert.equal(lo, "2026-05-02");
  assert.equal(hi, "2026-07-01");
});

test("predictionWindow: invalid date returns [null, null]", () => {
  const [lo, hi] = predictionWindow("not-a-date", 30);
  assert.equal(lo, null);
  assert.equal(hi, null);
});

test("agencyStem: normalises to first two words, upper-case, no punctuation", () => {
  assert.equal(agencyStem("NYC Dept. of Design & Construction"), "NYC DEPT");
  assert.equal(agencyStem("Department of Buildings"), "DEPARTMENT OF");
  assert.equal(agencyStem(null), "");
  assert.equal(agencyStem(""), "");
});

test("pinPrefix: first 4 characters", () => {
  assert.equal(pinPrefix("84624-PA-01"), "8462");
  assert.equal(pinPrefix("AB12XYZ"), "AB12");
  assert.equal(pinPrefix(null), "");
  assert.equal(pinPrefix(""), "");
});

test("WINDOW_DAYS constant is 30", () => {
  assert.equal(WINDOW_DAYS, 30);
});

// ---- mock D1 -----------------------------------------------------------

// Minimal D1 mock: prepare(sql).bind(...params).first() / all()
function mockDb(rows = []) {
  return {
    prepare(sql) {
      return {
        bind(..._params) {
          return {
            async first() { return rows[0] ?? null; },
            async all() { return { results: rows }; },
          };
        },
      };
    },
  };
}

// ---- checkPredictionHit ------------------------------------------------

test("checkPredictionHit: returns true when D1 has a matching Solicitation in window", async () => {
  const db = mockDb([{ request_id: "SOL-001" }]); // one matching row
  const hit = await checkPredictionHit({
    expiration_date: "2026-06-01",
    agency_name: "Design and Construction",
  }, db);
  assert.equal(hit, true);
});

test("checkPredictionHit: returns false when D1 has no matching row", async () => {
  const db = mockDb([]); // empty results
  const hit = await checkPredictionHit({
    expiration_date: "2026-06-01",
    agency_name: "Design and Construction",
  }, db);
  assert.equal(hit, false);
});

test("checkPredictionHit: returns false when prediction has no date", async () => {
  const db = mockDb([{ request_id: "SOL-001" }]);
  const hit = await checkPredictionHit({ agency_name: "Buildings" }, db);
  assert.equal(hit, false);
});

test("checkPredictionHit: falls back to PIN prefix when agency stem is short", async () => {
  // Agency name is empty — PIN path is the only one attempted
  const db = mockDb([{ request_id: "SOL-002" }]);
  const hit = await checkPredictionHit({
    expiration_date: "2026-06-01",
    agency_name: "",
    pin: "84624-PA-01",
  }, db);
  // With a 4-char PIN prefix and a matching row, should hit
  assert.equal(hit, true);
});

test("checkPredictionHit: no hit when both agency stem and pin are absent", async () => {
  const db = mockDb([{ request_id: "SOL-003" }]);
  const hit = await checkPredictionHit({
    expiration_date: "2026-06-01",
    agency_name: "",
    pin: "",
  }, db);
  assert.equal(hit, false);
});

// ---- collectPredictions ------------------------------------------------

function kv(map = {}) {
  return {
    async get(k) { return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null; },
    async put(k, v) { map[k] = v; },
    async list({ prefix = "" } = {}) {
      const keys = Object.keys(map)
        .filter((k) => k.startsWith(prefix))
        .map((k) => ({ name: k }));
      return { keys, list_complete: true };
    },
  };
}

test("collectPredictions: gathers fc:* and plan:* entries", async () => {
  const store = kv({
    "fc:DESIGN AND CONSTRUCTION": JSON.stringify([
      { expiration_date: "2026-06-01", agency_name: "Design and Construction" },
    ]),
    "plan:BUILDINGS": JSON.stringify([
      { description: "A plan", release_quarter: "Q2 FY2027" },
    ]),
  });
  const preds = await collectPredictions(store);
  assert.equal(preds.length, 2);
});

test("collectPredictions: skips keys that don't start with an uppercase letter after fc:", async () => {
  // "fc:sent:X" is a de-dup sentinel, not a forecast array
  const store = kv({
    "fc:sent:CTA123:sub:foo": "1",
    "fc:AGENCY": JSON.stringify([{ expiration_date: "2026-01-01" }]),
  });
  const preds = await collectPredictions(store);
  assert.equal(preds.length, 1);
});

test("collectPredictions: returns [] when KV is unavailable", async () => {
  const broken = { list: async () => { throw new Error("offline"); } };
  const preds = await collectPredictions(broken);
  assert.deepEqual(preds, []);
});

// ---- pastWindowPredictions ---------------------------------------------

test("pastWindowPredictions: keeps only predictions whose window has closed", () => {
  const preds = [
    { expiration_date: "2025-01-01" }, // window closed long ago
    { expiration_date: "2026-07-10" }, // window closes 2026-08-09 — future
    { expiration_date: "2026-01-01" }, // window closed 2026-01-31 — past
  ];
  const past = pastWindowPredictions(preds, "2026-07-10");
  assert.equal(past.length, 2);
});

test("pastWindowPredictions: excludes predictions with no date", () => {
  const preds = [{ description: "no date here" }];
  const past = pastWindowPredictions(preds, "2026-07-10");
  assert.equal(past.length, 0);
});

// ---- scoreForecastAccuracy end-to-end ----------------------------------

test("scoreForecastAccuracy: scored=0 when no past-window predictions", async () => {
  const futureDate = "2099-01-01";
  const env = {
    ALERT_STATE: kv({
      "fc:AGENCY": JSON.stringify([{ expiration_date: futureDate, agency_name: "Agency" }]),
    }),
  };
  const db = mockDb([]); // no Solicitation notices
  const result = await scoreForecastAccuracy(env, db, "2026-07-10");
  assert.equal(result.scored, 0);
  assert.equal(result.hits, 0);
  assert.equal(result.hit_rate, null);
  assert.equal(result.window_days, 30);
  assert.ok(result.note, "small-sample note should be present when scored < 20");
});

test("scoreForecastAccuracy: counts hit when D1 returns matching row", async () => {
  const env = {
    ALERT_STATE: kv({
      "fc:BUILDINGS": JSON.stringify([
        { expiration_date: "2025-06-01", agency_name: "Buildings" },
      ]),
    }),
  };
  const db = mockDb([{ request_id: "SOL-HIT" }]); // always returns a hit
  const result = await scoreForecastAccuracy(env, db, "2026-07-10");
  assert.equal(result.scored, 1);
  assert.equal(result.hits, 1);
  assert.equal(result.hit_rate, 1.0);
  assert.ok(result.note); // n=1 < 20 → small-sample note
  assert.match(result.note, /early/);
});

test("scoreForecastAccuracy: hit_rate is null when scored=0", async () => {
  const env = { ALERT_STATE: kv({}) };
  const db = mockDb([]);
  const result = await scoreForecastAccuracy(env, db, "2026-07-10");
  assert.equal(result.hit_rate, null);
});

test("scoreForecastAccuracy: note is null when sample >= 20", async () => {
  // Build 20 past-window predictions
  const pastPreds = Array.from({ length: 20 }, (_, i) => ({
    expiration_date: `2025-01-${String(i + 1).padStart(2, "0")}`,
    agency_name: "Test Agency",
  }));
  const env = {
    ALERT_STATE: kv({
      "fc:TEST AGENCY": JSON.stringify(pastPreds),
    }),
  };
  const db = mockDb([{ request_id: "SOL-X" }]);
  const result = await scoreForecastAccuracy(env, db, "2026-07-10");
  assert.equal(result.scored, 20);
  assert.equal(result.note, null); // large enough sample — no warning
});
