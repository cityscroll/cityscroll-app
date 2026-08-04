import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  isHumanServicesAwardNotice,
  normalizeDwellObservation,
  lookupAwardRegistrationDwell,
  buildAwardRegistrationDwellStrip,
  formatAwardRegistrationDwellStrip,
  buildCompactDwellLookup,
  REGISTRATION_STATUS_FOUND,
  REGISTRATION_STATUS_UNKNOWN,
} from "../site/award_registration_dwell_view.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const HS_AWARD = {
  request_id: "20240723114",
  type_of_notice_description: "Award",
  category_description: "Human Services/Client Services",
  agency_name: "Homeless Services",
};

function stubT(key, params = {}) {
  const templates = {
    award_reg_dwell_after_html:
      "Registered {days} days after the award notice ({award} → {registration}).",
    award_reg_dwell_before_html:
      "Registered {days} days before the City Record award notice (PASSPort {registration} · award notice {award}).",
    award_reg_dwell_same_day_html:
      "Registered the same day as the award notice ({award}).",
    award_reg_dwell_unknown_html:
      "PASSPort registration date not matched for this award.",
    award_reg_dwell_payment_frame_html:
      "Registration starts the payment clock — $0 paid right after registration is normal. Spending often lags invoicing.",
  };
  let s = templates[key] || key;
  for (const [k, v] of Object.entries(params || {})) {
    s = s.replaceAll(`{${k}}`, String(v));
  }
  return s;
}

describe("award_registration_dwell_view eligibility", () => {
  it("accepts Human Services Award notices only", () => {
    assert.equal(isHumanServicesAwardNotice(HS_AWARD), true);
    assert.equal(
      isHumanServicesAwardNotice({
        ...HS_AWARD,
        type_of_notice_description: "Solicitation",
      }),
      false,
    );
    assert.equal(
      isHumanServicesAwardNotice({
        ...HS_AWARD,
        category_description: "Goods",
      }),
      false,
    );
  });
});

describe("award_registration_dwell_view lookup + normalize", () => {
  it("normalizes compact found tuples and unknown markers", () => {
    const found = normalizeDwellObservation(
      [15, "2024-07-29", "2024-08-13"],
      "20240723114",
    );
    assert.equal(found.registration_status, REGISTRATION_STATUS_FOUND);
    assert.equal(found.dwell_days, 15);
    assert.equal(found.award_date, "2024-07-29");
    assert.equal(found.registration_date, "2024-08-13");

    const unk = normalizeDwellObservation(1, "x");
    assert.equal(unk.registration_status, REGISTRATION_STATUS_UNKNOWN);
    assert.equal(unk.dwell_days, null);
  });

  it("looks up compact found and unknown maps", () => {
    const lookup = {
      found: { "20240723114": [15, "2024-07-29", "2024-08-13"] },
      unknown: { "20260728008": 1 },
    };
    const f = lookupAwardRegistrationDwell(lookup, "20240723114");
    assert.equal(f.dwell_days, 15);
    const u = lookupAwardRegistrationDwell(lookup, "20260728008");
    assert.equal(u.registration_status, REGISTRATION_STATUS_UNKNOWN);
    assert.equal(u.dwell_days, null);
    assert.equal(lookupAwardRegistrationDwell(lookup, "missing"), null);
  });
});

describe("award_registration_dwell_view strip model", () => {
  it("renders registered N days after award for positive dwell", () => {
    const strip = buildAwardRegistrationDwellStrip(HS_AWARD, null, {
      observation: {
        registration_status: "found",
        dwell_days: 44,
        award_date: "2026-04-28",
        registration_date: "2026-06-11",
      },
    });
    assert.equal(strip.status, "found");
    assert.equal(strip.dwell_days, 44);
    assert.equal(strip.line_key, "award_reg_dwell_after_html");
    assert.equal(strip.line_params.days, "44");
    assert.equal(strip.honesty_frame_key, "award_reg_dwell_payment_frame_html");
    const fmt = formatAwardRegistrationDwellStrip(strip, stubT);
    assert.match(fmt.line, /Registered 44 days after the award notice/);
    assert.match(fmt.frame, /payment clock/i);
  });

  it("allows true zero dwell as same-day, never as unknown instant", () => {
    const strip = buildAwardRegistrationDwellStrip(HS_AWARD, null, {
      observation: {
        registration_status: "found",
        dwell_days: 0,
        award_date: "2025-01-15",
        registration_date: "2025-01-15",
      },
    });
    assert.equal(strip.dwell_days, 0);
    assert.equal(strip.line_key, "award_reg_dwell_same_day_html");
    const fmt = formatAwardRegistrationDwellStrip(strip, stubT);
    assert.match(fmt.line, /same day/i);
    assert.doesNotMatch(fmt.line, /0 days/);
  });

  it("keeps signed negative dwell (registration before award notice)", () => {
    const strip = buildAwardRegistrationDwellStrip(HS_AWARD, null, {
      observation: {
        registration_status: "found",
        dwell_days: -7,
        award_date: "2026-08-03",
        registration_date: "2026-07-27",
      },
    });
    assert.equal(strip.dwell_days, -7);
    assert.equal(strip.line_key, "award_reg_dwell_before_html");
    assert.equal(strip.line_params.days, "7");
    const fmt = formatAwardRegistrationDwellStrip(strip, stubT);
    assert.match(fmt.line, /7 days before/);
  });

  it("unknown is one quiet line with null dwell — never zero", () => {
    const strip = buildAwardRegistrationDwellStrip(HS_AWARD, null, {
      observation: {
        registration_status: "unknown",
        dwell_days: null,
      },
    });
    assert.equal(strip.status, "unknown");
    assert.equal(strip.dwell_days, null);
    assert.equal(strip.render, "quiet");
    assert.equal(strip.honesty_frame_key, null);
    const fmt = formatAwardRegistrationDwellStrip(strip, stubT);
    assert.match(fmt.line, /not matched/i);
    assert.equal(fmt.frame, null);
  });

  it("unknown with numeric dwell is coerced — never paints 0 / instant", () => {
    const strip = buildAwardRegistrationDwellStrip(HS_AWARD, null, {
      observation: {
        registration_status: "unknown",
        dwell_days: 0, // must never render as instant
      },
    });
    assert.equal(strip.status, "unknown");
    assert.equal(strip.dwell_days, null);
    const fmt = formatAwardRegistrationDwellStrip(strip, stubT);
    assert.doesNotMatch(fmt.line, /\b0\b/);
    assert.doesNotMatch(fmt.line, /same day|instant/i);
  });

  it("non-HS notices get clean absence", () => {
    const strip = buildAwardRegistrationDwellStrip(
      {
        request_id: "x",
        type_of_notice_description: "Award",
        category_description: "Goods",
      },
      { found: { x: [5, "2024-01-01", "2024-01-06"] } },
    );
    assert.equal(strip, null);
  });

  it("HS award not in corpus gets clean absence", () => {
    const strip = buildAwardRegistrationDwellStrip(HS_AWARD, {
      found: {},
      unknown: {},
    });
    assert.equal(strip, null);
  });
});

describe("award_registration_dwell_view compact lookup builder", () => {
  it("builds compact found/unknown maps with honesty filter", () => {
    const compact = buildCompactDwellLookup({
      model_name: "award_registration_dwell",
      model_version: "1.0.0",
      generated_at: "1970-01-01T00:00:00.000Z",
      found: [
        {
          request_id: "a",
          dwell_days: 15,
          award_date: "2024-07-29",
          registration_date: "2024-08-13",
        },
        { request_id: "bad", dwell_days: null }, // dropped
      ],
      unknown: [
        { request_id: "u", dwell_days: null },
        { request_id: "poison", dwell_days: 0 }, // honesty drop
      ],
    });
    assert.deepEqual(compact.found.a, [15, "2024-07-29", "2024-08-13"]);
    assert.equal(compact.found.bad, undefined);
    assert.equal(compact.unknown.u, 1);
    assert.equal(compact.unknown.poison, undefined);
    assert.equal(compact.n_found, 1);
    assert.equal(compact.n_unknown, 1);
  });
});

describe("award_registration_dwell_view committed lookup", () => {
  it("ships a compact lookup that resolves field-case awards", () => {
    const path = join(ROOT, "site/data/award_registration_dwell_lookup.json");
    assert.equal(existsSync(path), true, "lookup artifact must be committed");
    const lookup = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(lookup.honesty?.unknown_never_zero, true);
    assert.ok(lookup.n_found > 0);
    assert.ok(lookup.n_unknown > 0);

    // Fixture-known award id may be found or (with live corpus) signed prior;
    // either way it must not be unknown-with-zero.
    const row = lookupAwardRegistrationDwell(lookup, "20240723114");
    if (row) {
      if (row.registration_status === REGISTRATION_STATUS_FOUND) {
        assert.equal(typeof row.dwell_days, "number");
        assert.ok(Number.isFinite(row.dwell_days));
      } else {
        assert.equal(row.dwell_days, null);
      }
    }

    // Any unknown row in the map must not invent a dwell.
    const sampleUnk = Object.keys(lookup.unknown || {}).slice(0, 5);
    for (const id of sampleUnk) {
      const u = lookupAwardRegistrationDwell(lookup, id);
      assert.equal(u.registration_status, REGISTRATION_STATUS_UNKNOWN);
      assert.equal(u.dwell_days, null);
    }
  });
});
