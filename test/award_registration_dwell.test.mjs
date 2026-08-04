import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  HUMAN_SERVICES_CATEGORY,
  REGISTRATION_STATUS_FOUND,
  REGISTRATION_STATUS_UNKNOWN,
  isHumanServicesAward,
  isoDay,
  daysBetween,
  buildRegistrationIndex,
  buildAwardRegistrationDwellReport,
  observeAwardRegistrationDwell,
  summarizeDwellObservations,
  empiricalQuantile,
} from "../worker/src/lib/award_registration_dwell.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIX_AWARDS = join(
  ROOT,
  "warehouse/fixtures/award-registration-dwell/city_record_hs_awards.json",
);
const FIX_REG = join(
  ROOT,
  "warehouse/fixtures/award-registration-dwell/passport_registrations.json",
);

function loadFixture() {
  const awards = JSON.parse(readFileSync(FIX_AWARDS, "utf8"));
  const contracts = JSON.parse(readFileSync(FIX_REG, "utf8"));
  return { awards, regIndex: buildRegistrationIndex(contracts) };
}

describe("award_registration_dwell helpers", () => {
  it("parses ISO and US dates", () => {
    assert.equal(isoDay("2024-07-29T00:00:00.000"), "2024-07-29");
    assert.equal(isoDay("08/13/2024"), "2024-08-13");
    assert.equal(isoDay(""), null);
    assert.equal(isoDay(null), null);
  });

  it("computes signed dwell in days", () => {
    assert.equal(daysBetween("2024-07-29", "2024-08-13"), 15);
    assert.equal(daysBetween("2025-01-15", "2025-01-15"), 0);
    assert.equal(daysBetween("2025-04-01", "2025-03-15"), -17);
  });

  it("identifies human-services awards only", () => {
    assert.equal(
      isHumanServicesAward({
        type_of_notice_description: "Award",
        category_description: HUMAN_SERVICES_CATEGORY,
      }),
      true,
    );
    assert.equal(
      isHumanServicesAward({
        type_of_notice_description: "Award",
        category_description: "Goods",
      }),
      false,
    );
    assert.equal(
      isHumanServicesAward({
        type_of_notice_description: "Solicitation",
        category_description: HUMAN_SERVICES_CATEGORY,
      }),
      false,
    );
  });

  it("empirical quantiles are nearest-rank", () => {
    assert.equal(empiricalQuantile([1, 2, 3, 4], 0.5), 2);
    assert.equal(empiricalQuantile([10], 0.9), 10);
    assert.equal(empiricalQuantile([], 0.5), null);
  });
});

describe("award_registration_dwell observations", () => {
  it("labels found dwell when registration joins", () => {
    const { awards, regIndex } = loadFixture();
    const row = awards.find((a) => a.request_id === "20240723114");
    const obs = observeAwardRegistrationDwell(row, regIndex);
    assert.equal(obs.registration_status, REGISTRATION_STATUS_FOUND);
    assert.equal(obs.award_date, "2024-07-29");
    assert.equal(obs.registration_date, "2024-08-13");
    assert.equal(obs.dwell_days, 15);
    assert.equal(obs.join_method, "exact");
    assert.equal(obs.registration_source, "passport");
  });

  it("allows true zero dwell for same-day found registration", () => {
    const { awards, regIndex } = loadFixture();
    const row = awards.find((a) => a.request_id === "20250115001");
    const obs = observeAwardRegistrationDwell(row, regIndex);
    assert.equal(obs.registration_status, REGISTRATION_STATUS_FOUND);
    assert.equal(obs.dwell_days, 0);
  });

  it("uses explicit unknown (not zero) when registration is unfound", () => {
    const { awards, regIndex } = loadFixture();
    const row = awards.find((a) => a.request_id === "20250301002");
    const obs = observeAwardRegistrationDwell(row, regIndex);
    assert.equal(obs.registration_status, REGISTRATION_STATUS_UNKNOWN);
    assert.equal(obs.dwell_days, null);
    assert.equal(obs.registration_date, null);
  });

  it("keeps signed negative dwell when registration precedes award notice", () => {
    const { awards, regIndex } = loadFixture();
    const row = awards.find((a) => a.request_id === "20250401003");
    const obs = observeAwardRegistrationDwell(row, regIndex);
    assert.equal(obs.registration_status, REGISTRATION_STATUS_FOUND);
    assert.equal(obs.dwell_days, -17);
  });

  it("stays unknown when EPIN joins but registration_date is empty", () => {
    const { awards, regIndex } = loadFixture();
    const row = awards.find((a) => a.request_id === "20250601004");
    const obs = observeAwardRegistrationDwell(row, regIndex);
    assert.equal(obs.registration_status, REGISTRATION_STATUS_UNKNOWN);
    assert.equal(obs.dwell_days, null);
    assert.equal(obs.join_method, "exact");
    assert.equal(obs.registration_epin, "26025N0011014");
  });
});

describe("award_registration_dwell report", () => {
  it("filters to HS awards and summarizes honesty-safe distribution", () => {
    const { awards, regIndex } = loadFixture();
    const report = buildAwardRegistrationDwellReport(awards, regIndex, {
      generatedAt: "2026-08-03T12:00:00.000Z",
      corpus: { mode: "fixture" },
    });

    assert.equal(report.model_name, "award_registration_dwell");
    // 5 HS awards (Goods + Solicitation filtered out)
    assert.equal(report.stats.n_awards, 5);
    assert.equal(report.stats.n_found, 3);
    assert.equal(report.stats.n_unknown, 2);
    assert.equal(report.stats.honesty_violations, 0);
    assert.equal(report.stats.dwell_days_non_negative.n, 2); // 15 and 0
    assert.equal(report.stats.dwell_days_non_negative.p50, 0);
    assert.equal(report.stats.dwell_days_registration_prior.n, 1);
    assert.equal(report.stats.dwell_days_registration_prior.p50, 17);

    // No unknown observation may carry a numeric dwell (incl. 0).
    for (const obs of report.observations) {
      if (obs.registration_status === REGISTRATION_STATUS_UNKNOWN) {
        assert.equal(obs.dwell_days, null);
      }
    }
  });

  it("summarize rejects unknown zeros as honesty violations", () => {
    const bad = summarizeDwellObservations([
      {
        registration_status: REGISTRATION_STATUS_UNKNOWN,
        dwell_days: 0,
      },
    ]);
    assert.equal(bad.honesty_violations, 1);
  });
});
