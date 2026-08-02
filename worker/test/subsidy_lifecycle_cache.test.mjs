// Pins D1 cache invalidation for subsidy lifecycle: parser_version must force
// recompute of pre-fix rows so honesty fixes (hearing money, short place,
// feed-down gap kinds) are not stuck behind a matched-but-stale cache forever.
//
//   node --test test/subsidy_lifecycle_cache.test.mjs   (from worker/)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SUBSIDY_PARSER_VERSION,
  subsidyCacheIsCurrent,
  getOrCompute,
} from "../src/subsidy_lifecycle.mjs";

function fakeDB(seed = {}) {
  const notices = seed.notices || {};
  const cache = seed.cache || {};
  return {
    _notices: notices,
    _cache: cache,
    prepare(sql) {
      return {
        _sql: sql,
        _args: [],
        bind(...args) {
          this._args = args;
          return this;
        },
        async first() {
          if (/FROM notices/.test(this._sql)) {
            const n = notices[this._args[0]];
            if (!n) return null;
            return {
              request_id: n.request_id,
              start_date: n.start_date,
              agency_name: n.agency_name || n.agency,
              type_of_notice_description: n.type_of_notice_description,
              short_title: n.short_title,
              additional_description_1: n.additional_description_1 || "",
              additional_description_2: n.additional_description_2 || "",
              additional_description_3: n.additional_description_3 || "",
              other_info_1: n.other_info_1 || "",
              other_info_2: n.other_info_2 || "",
              other_info_3: n.other_info_3 || "",
              pin: n.pin || null,
              vendor_name: n.vendor_name || null,
              contract_amount: n.contract_amount || null,
            };
          }
          if (/FROM subsidy_lifecycle/.test(this._sql)) {
            return cache[this._args[0]] || null;
          }
          return null;
        },
        async run() {
          if (/CREATE TABLE|CREATE INDEX/i.test(this._sql)) return { success: true };
          if (/INSERT OR REPLACE INTO subsidy_lifecycle/.test(this._sql)) {
            const [request_id, agency, lifecycle, computed_at] = this._args;
            cache[request_id] = { request_id, agency, lifecycle, computed_at };
          }
          return { success: true };
        },
      };
    },
  };
}

const STALE_LIFECYCLE = {
  // Pre-honesty-fix shape: matched hearing, no parser_version, null cost, not_published gaps.
  source_status: "ok",
  join: { matched: true, method: "city-record-hearing", feed_status: "unavailable" },
  money: { total_project_cost: null, total_development_cost: null },
  place: { address: "SUPPLEMENTAL NOTICE OF PUBLIC HEARING…" },
  timeline: [
    { stage: "hearing", status: "matched" },
    { stage: "board_decision", status: "unmatched", gap_kind: "not_published" },
  ],
};

const FRESH_LIFECYCLE = {
  ...STALE_LIFECYCLE,
  parser_version: SUBSIDY_PARSER_VERSION,
  money: {
    total_project_cost: { value: 10667606, currency: "USD", status: "matched" },
    total_development_cost: null,
  },
  place: { address: "4425-4429 1st Avenue, Brooklyn, NY" },
  timeline: [
    { stage: "hearing", status: "matched" },
    { stage: "board_decision", status: "unmatched", gap_kind: "not_yet_ingested" },
  ],
};

test("SUBSIDY_PARSER_VERSION is a positive integer", () => {
  assert.equal(typeof SUBSIDY_PARSER_VERSION, "number");
  assert.ok(SUBSIDY_PARSER_VERSION >= 1);
});

test("subsidyCacheIsCurrent rejects missing parser_version (pre-fix rows)", () => {
  assert.equal(subsidyCacheIsCurrent(STALE_LIFECYCLE), false);
  assert.equal(subsidyCacheIsCurrent({ ...STALE_LIFECYCLE, parser_version: 1 }), false);
  assert.equal(subsidyCacheIsCurrent(FRESH_LIFECYCLE), true);
});

test("subsidyCacheIsCurrent rejects source_status unavailable even with current version", () => {
  assert.equal(
    subsidyCacheIsCurrent({
      ...FRESH_LIFECYCLE,
      source_status: "unavailable",
    }),
    false,
  );
});

test("getOrCompute recomputes a cached pre-fix row after parser_version bump", async () => {
  const noticeId = "20220525018";
  const notice = {
    request_id: noticeId,
    start_date: "2022-05-25",
    agency_name: "New York City Industrial Development Agency",
    type_of_notice_description: "Public Hearing",
    short_title: "Global Wood Distributors LLC",
    additional_description_1:
      "SUPPLEMENTAL NOTICE OF PUBLIC HEARING Total Project Cost: $10,667,606 "
      + "Project Location: 4425-4429 1st Avenue, Brooklyn, NY 11232",
  };
  const db = fakeDB({
    notices: { [noticeId]: notice },
    cache: {
      [noticeId]: {
        request_id: noticeId,
        agency: notice.agency_name,
        lifecycle: JSON.stringify(STALE_LIFECYCLE),
        computed_at: "2026-07-01T00:00:00.000Z",
      },
    },
  });

  // Feed is blocked → City Record hearing derivation still produces a join.
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (/edc\.nyc|financial-public-documents/i.test(u)) {
      return {
        ok: true,
        status: 200,
        text: async () => "<html>Just a moment… cf-browser-verification challenge-platform</html>",
      };
    }
    // SODA notice lookup fallback (unused when D1 has the notice).
    return { ok: true, status: 200, json: async () => [notice] };
  };

  try {
    const result = await getOrCompute({ DB: db }, noticeId);
    assert.ok(result.lifecycle, "recompute must return a lifecycle");
    const money = result.lifecycle.money || {};
    // Recompute must leave a non-null project cost (stale null is the bug).
    // total_project_cost is a number on hearing-derived joins.
    assert.equal(money.total_project_cost, 10667606,
      "stale null cost must not be served from pre-fix cache");
    // Cache row rewritten with current parser_version.
    const stored = JSON.parse(db._cache[noticeId].lifecycle);
    assert.equal(stored.parser_version, SUBSIDY_PARSER_VERSION);
  } finally {
    globalThis.fetch = orig;
  }
});

test("getOrCompute serves a current-version cache hit without recompute", async () => {
  const noticeId = "20220525018";
  const db = fakeDB({
    cache: {
      [noticeId]: {
        request_id: noticeId,
        agency: "NYCIDA",
        lifecycle: JSON.stringify(FRESH_LIFECYCLE),
        computed_at: "2026-08-02T12:00:00.000Z",
      },
    },
  });
  let fetched = false;
  const orig = globalThis.fetch;
  globalThis.fetch = async () => {
    fetched = true;
    return { ok: false, status: 503, text: async () => "", json: async () => [] };
  };
  try {
    const result = await getOrCompute({ DB: db }, noticeId);
    assert.equal(result.ok, true);
    assert.equal(result.lifecycle.parser_version, SUBSIDY_PARSER_VERSION);
    assert.equal(result.lifecycle.money.total_project_cost.value ?? result.lifecycle.money.total_project_cost, 10667606);
    assert.equal(fetched, false, "current-version hit must not hit upstream");
  } finally {
    globalThis.fetch = orig;
  }
});
