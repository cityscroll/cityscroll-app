// Contract-forecast prediction retrofit (cs-pred-09).
// Conformance of fc:* rows to cityscroll.prediction.v0, sent-key stability,
// and frozen hit_rate parity after provenance stamping.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  CONTRACT_RENEWAL_MODEL_NAME,
  CONTRACT_RENEWAL_MODEL_VERSION,
  buildContractRenewalPrediction,
  enrichForecastWithPrediction,
  forecastIsDeliverableOn,
  forecastPredictedDate,
  forecastRecordToPrediction,
  forecastSentIdentity,
  forecastSentKvKey,
  cadenceProvenance,
} from "../src/lib/contract_forecast_predictions.mjs";
import {
  validatePrediction,
  predictionBand,
  resolvePredictions,
} from "../src/lib/prediction_contract.mjs";
import {
  scoreForecastAccuracy,
  resolveForecastPredictions,
  pastWindowPredictions,
  checkPredictionHit,
  WINDOW_DAYS,
} from "../src/lib/forecast_score.mjs";
import { matchForecasts } from "../src/alerts.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FROZEN = JSON.parse(
  readFileSync(join(ROOT, "test/fixtures/forecast-accuracy/frozen_set.json"), "utf8"),
);

const LEGACY_ROW = {
  contract_id: "CTA123",
  vendor_name: "SINERGIA INC",
  agency_name: "Design and Construction",
  amount: 1000000,
  registration_date: "2026-07-01",
  expiration_date: "2029-07-01",
  warning_date: "2029-01-02",
  pin: "PIN_SINERGIA_123",
  source: "checkbook",
};

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
    },
  };
}

// ---- prediction contract conformance ------------------------------------

test("enrichForecastWithPrediction stamps valid cityscroll.prediction.v0 provenance", () => {
  const enriched = enrichForecastWithPrediction(LEGACY_ROW, {
    generatedAt: "2026-08-02T13:00:00Z",
  });

  // Product fields remain for every current consumer.
  assert.equal(enriched.contract_id, "CTA123");
  assert.equal(enriched.expiration_date, "2029-07-01");
  assert.equal(enriched.warning_date, "2029-01-02");
  assert.equal(enriched.source, "checkbook");
  assert.equal(enriched.vendor_name, "SINERGIA INC");

  // Prediction provenance.
  assert.equal(enriched.model_name, CONTRACT_RENEWAL_MODEL_NAME);
  assert.equal(enriched.model_version, CONTRACT_RENEWAL_MODEL_VERSION);
  assert.equal(enriched.basis.method, "term_arithmetic");
  assert.ok(Array.isArray(enriched.basis.evidence_event_ids));
  assert.ok(enriched.basis.evidence_event_ids.some((id) => id.includes("CTA123")));
  assert.equal(enriched.status, "open");
  assert.match(enriched.prediction_id, /^pred:[a-f0-9]{24}$/);

  const assertion = forecastRecordToPrediction(enriched);
  assert.equal(validatePrediction(assertion), assertion);
  assert.equal(assertion.predicted_event_kind, "procurement.notice_published");
  assert.deepEqual(assertion.predicted_window, {
    p10: "2029-07-01",
    p50: "2029-07-01",
    p90: "2029-07-01",
  });
});

test("buildContractRenewalPrediction is stable for identical source facts", () => {
  const a = buildContractRenewalPrediction(LEGACY_ROW, { generatedAt: "2026-08-02T13:00:00Z" });
  const b = buildContractRenewalPrediction(LEGACY_ROW, { generatedAt: "2026-08-03T00:00:00Z" });
  // prediction_id is content-stable (subject + kind + model + train_to); generated_at may differ.
  assert.equal(a.prediction_id, b.prediction_id);
});

test("legacy rows without provenance still convert through the generic resolver", () => {
  const assertion = forecastRecordToPrediction(LEGACY_ROW);
  assert.equal(assertion.basis.method, "term_arithmetic");
  assert.equal(forecastPredictedDate(LEGACY_ROW), "2029-07-01");
  assert.equal(forecastPredictedDate({ predicted_window: { p50: "2028-01-01" } }), "2028-01-01");
});

// ---- sent-key golden (no resend storm) -----------------------------------

test("forecast sent-key golden: identity stays fc:<contract_id>:<sub_key>", () => {
  const subKey = "sub:test-key";
  assert.equal(forecastSentIdentity("CTA123", subKey), "fc:CTA123:sub:test-key");
  assert.equal(forecastSentKvKey("CTA123", subKey), "sent:fc:CTA123:sub:test-key");
  // Historical proactive_alerts shape — must not change.
  assert.equal(forecastSentKvKey("CTA123", "sub:test-key"), "sent:fc:CTA123:sub:test-key");
});

test("matchForecasts uses historical sent keys for already-delivered forecasts (no resend)", async () => {
  const today = "2026-08-02";
  const subKey = "sub:golden-fc";
  const enriched = enrichForecastWithPrediction({
    ...LEGACY_ROW,
    warning_date: today,
  }, { generatedAt: "2026-08-02T12:00:00Z" });

  const store = {
    "fc:DESIGN AND CONSTRUCTION": JSON.stringify([enriched]),
    // Already delivered under the pre-retrofit key shape.
    [`sent:fc:CTA123:${subKey}`]: "1",
  };
  const env = { ALERT_STATE: kv(store), ALERTS_LIVE: "true" };
  const sub = {
    key: subKey,
    lens: "entity",
    filter: { name: "Design and Construction" },
  };

  const matched = await matchForecasts(env, sub, today);
  assert.deepEqual(matched, [], "already-sent forecast must not re-fire after provenance retrofit");
});

test("matchForecasts fires once on warning_date and writes the golden sent key", async () => {
  const today = "2026-08-02";
  const subKey = "sub:new-fc";
  const enriched = enrichForecastWithPrediction({
    ...LEGACY_ROW,
    warning_date: today,
  }, { generatedAt: "2026-08-02T12:00:00Z" });

  const store = {
    "fc:DESIGN AND CONSTRUCTION": JSON.stringify([enriched]),
  };
  const env = { ALERT_STATE: kv(store), ALERTS_LIVE: "true" };
  const sub = {
    key: subKey,
    lens: "entity",
    filter: { name: "Design and Construction" },
  };

  assert.equal(forecastIsDeliverableOn(enriched, today), true);
  const matched = await matchForecasts(env, sub, today);
  assert.equal(matched.length, 1);
  assert.equal(matched[0].contract_id, "CTA123");
  assert.equal(matched[0].prediction_id, enriched.prediction_id);
  assert.equal(await env.ALERT_STATE.get(`sent:fc:CTA123:${subKey}`), "1");

  // Second pass: still suppressed.
  assert.equal((await matchForecasts(env, sub, today)).length, 0);
});

// ---- generic resolver + frozen hit_rate ---------------------------------

function mockDbForFrozen(hitAgencies) {
  const hits = new Set((hitAgencies || []).map((a) => String(a).toUpperCase()));
  return {
    prepare(sql) {
      return {
        bind(...params) {
          return {
            async first() {
              // Agency path: third bind is LIKE pattern "%STEM%"
              if (sql.includes("upper(agency) LIKE")) {
                const pat = String(params[2] || "").replace(/%/g, "").toUpperCase();
                if ([...hits].some((h) => h.includes(pat) || pat.includes(h.split(" ")[0]))) {
                  return { request_id: "SOL-HIT" };
                }
                return null;
              }
              // PIN path unused in frozen expected hits for miss agency
              return null;
            },
            async all() { return { results: [] }; },
          };
        },
      };
    },
  };
}

test("frozen fixture hit_rate is identical for legacy and retrofitted rows", async () => {
  const today = FROZEN.today;
  const legacy = FROZEN.predictions;
  const retrofitted = legacy.map((row) =>
    enrichForecastWithPrediction(row, { generatedAt: "2026-07-01T00:00:00Z" }),
  );

  const db = mockDbForFrozen(FROZEN.d1_hit_agencies);

  async function score(rows) {
    const env = {
      ALERT_STATE: kv({
        "fc:FROZEN": JSON.stringify(rows),
      }),
    };
    return scoreForecastAccuracy(env, db, today);
  }

  const legacyResult = await score(legacy);
  const retrofitResult = await score(retrofitted);

  assert.equal(legacyResult.scored, FROZEN.expected.scored);
  assert.equal(legacyResult.hits, FROZEN.expected.hits);
  assert.equal(legacyResult.hit_rate, FROZEN.expected.hit_rate);
  assert.equal(legacyResult.window_days, FROZEN.expected.window_days);

  assert.equal(retrofitResult.scored, legacyResult.scored);
  assert.equal(retrofitResult.hits, legacyResult.hits);
  assert.equal(retrofitResult.hit_rate, legacyResult.hit_rate);
  assert.equal(retrofitResult.window_days, legacyResult.window_days);
});

test("resolveForecastPredictions uses the generic contract resolver", () => {
  const enriched = enrichForecastWithPrediction(LEGACY_ROW, {
    generatedAt: "2026-08-02T13:00:00Z",
  });
  const hitEvent = {
    event_id: "cte:sol-1",
    subject_ref: "contract:CTA123",
    event_kind: "procurement.notice_published",
    valid_at: "2029-07-01",
  };
  const resolved = resolveForecastPredictions([enriched], [hitEvent], {
    graceDays: WINDOW_DAYS,
  });
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].status, "resolved_hit");
  assert.equal(resolved[0].resolved_by_event_id, "cte:sol-1");

  // Direct resolvePredictions path on converted assertions matches.
  const viaContract = resolvePredictions(
    [forecastRecordToPrediction(enriched)],
    [hitEvent],
    { graceDays: WINDOW_DAYS },
  );
  assert.equal(viaContract[0].status, "resolved_hit");
});

test("pastWindowPredictions reads predicted_window.p50 when present", () => {
  const rows = [
    enrichForecastWithPrediction({
      contract_id: "CT1",
      expiration_date: "2025-01-01",
      registration_date: "2022-01-01",
      warning_date: "2024-07-05",
      source: "checkbook",
    }),
  ];
  const past = pastWindowPredictions(rows, "2026-07-10");
  assert.equal(past.length, 1);
});

test("cadenceProvenance tags method cadence without inventing dates", () => {
  const prov = cadenceProvenance({
    count: 3,
    nextDate: new Date("2024-01-12T00:00:00Z"),
  });
  assert.equal(prov.method, "cadence");
  assert.equal(prov.n, 3);
  assert.equal(prov.next_date, "2024-01-12");
  assert.equal(prov.model_name, "award_cadence");
});

test("warning_date delivery maps to product approaching fire (deliverable check)", () => {
  assert.equal(
    forecastIsDeliverableOn({ warning_date: "2026-08-02" }, "2026-08-02"),
    true,
  );
  assert.equal(
    forecastIsDeliverableOn({ warning_date: "2026-08-01" }, "2026-08-02"),
    false,
  );
});

test("checkPredictionHit still hits on retrofitted rows via expiration/p50", async () => {
  const enriched = enrichForecastWithPrediction({
    contract_id: "CT-X",
    agency_name: "Buildings",
    expiration_date: "2026-06-01",
    registration_date: "2023-06-01",
    warning_date: "2025-12-03",
    source: "checkbook",
  });
  const db = {
    prepare() {
      return {
        bind() {
          return {
            async first() { return { request_id: "SOL-001" }; },
          };
        },
      };
    },
  };
  assert.equal(await checkPredictionHit(enriched, db), true);
});

test("open renewal forecast band at warning_date horizon is approaching or far", () => {
  // p50 = expiration 2029-07-01; at warning_date 2029-01-02 days to median = 180 → far
  // (product still delivers on warning_date; band grammar is separate ontology label)
  const enriched = enrichForecastWithPrediction(LEGACY_ROW, {
    generatedAt: "2026-08-02T13:00:00Z",
  });
  const assertion = forecastRecordToPrediction(enriched);
  assert.equal(predictionBand(assertion, { now: "2029-01-02" }), "far");
  assert.equal(predictionBand(assertion, { now: "2029-05-01" }), "approaching");
});
