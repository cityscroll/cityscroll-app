// Field case (mailbox): owner's construction alert
//   { lens: money, keywords: ["construction"], minAmount: 500000,
//     category: "Construction/Construction Services" }
// last delivered ~2026-07-25 (request_id 20260720004, "1 new since Jul 24").
// City Record then published another matching award on 2026-07-27 (20260721018,
// $637k Hunts Point dock Reconstruction) — but no digest reached the mailbox.
//
// Root cause: the D1 fast path ordered money+amount queries by contract_amount DESC
// LIMIT 25. Multi-billion mega-contracts permanently fill that window; a $637k
// award never appears, so the digest sees zero "new" rows while SODA (start_date
// DESC) would have matched. Fix: compileSub_d1 sets orderBy: "start_date" for money.
import { test } from "node:test";
import assert from "node:assert/strict";
import { subToD1Opts, compileSub_d1, toDigestRow } from "../src/lib/compile_d1.mjs";
import { buildNoticesQuery } from "../src/lib/notices.mjs";
import { compileSub } from "../src/lib/compile.mjs";
import { processOneSub } from "../src/alerts.mjs";

const OWNER_FILTER = {
  keywords: ["construction"],
  minAmount: 500000,
  category: "Construction/Construction Services",
};

// Published City Record awards (SODA evidence, 2026-07-30 query).
const NOTICE_JUL_24 = {
  request_id: "20260720004",
  start_date: "2026-07-24",
  agency: "Design and Construction",
  short_title: "Queens Civil Courthouse Plaza and Exterior Renovation",
  contract_amount: 4392582,
  contract_amount_valid: 1,
  category: "Construction/Construction Services",
  type_of_notice: "Award",
  section: "Procurement",
  description: "Courthouse plaza renovation and exterior construction work.",
  haystack: "queens civil courthouse plaza and exterior renovation construction design",
  vendor_name: null,
  pin: "85026C0001",
};
const NOTICE_JUL_27 = {
  request_id: "20260721018",
  start_date: "2026-07-27",
  agency: "Parks and Recreation",
  short_title: "X336-119M Hunts Point Riverside Park Dock Reconstruction",
  contract_amount: 637056,
  contract_amount_valid: 1,
  category: "Construction/Construction Services",
  type_of_notice: "Award",
  section: "Procurement",
  description: "Dock reconstruction at Hunts Point Riverside Park.",
  haystack: "x336-119m hunts point riverside park dock reconstruction parks",
  vendor_name: null,
  pin: "84626B0001",
};
// Mega-contracts that fill amount-ordered LIMIT 25 (real magnitude class from SODA).
function megaAwards(n = 30) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      request_id: `MEGA${String(i).padStart(4, "0")}`,
      start_date: "2024-07-01",
      agency: "Design and Construction",
      short_title: `Mega construction design-build program ${i}`,
      contract_amount: 3_000_000_000 - i * 10_000_000,
      contract_amount_valid: 1,
      category: "Construction/Construction Services",
      type_of_notice: "Award",
      section: "Procurement",
      description: "Borough-based jail construction design build.",
      haystack: "mega construction design build program",
      vendor_name: null,
      pin: `PIN-MEGA-${i}`,
    });
  }
  return out;
}

/** Minimal in-memory D1 that runs the subset of SQL buildNoticesQuery emits. */
function fakeD1(rows) {
  return {
    prepare(sql) {
      return {
        bind(...params) {
          return {
            async all() {
              // Extremely small interpreter for the digest query shape.
              let list = rows.slice();
              // Apply filters by inspecting SQL + params order (params are positional).
              // We re-derive via the same opts rather than parsing SQL.
              return { results: list };
            },
          };
        },
      };
    },
  };
}

// Interpret buildNoticesQuery against in-memory rows (no SQL engine in unit tests).
function filterRows(allRows, opts) {
  const { sql, params } = buildNoticesQuery(opts);
  let list = allRows.slice();
  // Apply the same predicates the SQL would — keep this in lockstep with notices.mjs.
  if (opts.category) list = list.filter((r) => r.category === opts.category);
  if (opts.noticeType) list = list.filter((r) => r.type_of_notice === opts.noticeType);
  if (opts.minAmount != null) {
    list = list.filter((r) => r.contract_amount_valid === 1 && r.contract_amount >= opts.minAmount);
  }
  if (opts.maxAmount != null) {
    list = list.filter((r) => r.contract_amount_valid === 1 && r.contract_amount <= opts.maxAmount);
  }
  for (const g of opts.termGroups || []) {
    list = list.filter((r) => g.some((t) => String(r.haystack || "").includes(String(t).toLowerCase())));
  }
  if (opts.sinceDate) list = list.filter((r) => String(r.start_date) >= opts.sinceDate);

  const order = opts.orderBy;
  if (order === "start_date" || (sql.includes("ORDER BY start_date DESC") && !sql.includes("contract_amount DESC, start_date"))) {
    list.sort((a, b) => String(b.start_date).localeCompare(String(a.start_date)));
  } else if (sql.includes("contract_amount DESC")) {
    list.sort((a, b) => (b.contract_amount || 0) - (a.contract_amount || 0));
  }
  const lim = opts.limit ?? 15;
  return { sql, rows: list.slice(0, lim) };
}

test("owner construction filter: SODA compile uses start_date DESC (digest recency)", () => {
  const q = compileSub({ lens: "money", filter: OWNER_FILTER }, "2026-07-30");
  assert.equal(q.params["$order"], "start_date DESC");
  assert.match(q.params["$where"], /category_description='Construction\/Construction Services'/);
  assert.match(q.params["$where"], /contract_amount >= 500000/);
  assert.equal(q.params["$q"], "construction");
});

test("owner construction filter: D1 opts force start_date order (not amount)", () => {
  const opts = subToD1Opts({ lens: "money", filter: OWNER_FILTER }, "2026-07-30");
  assert.equal(opts.orderBy, "start_date");
  assert.equal(opts.minAmount, 500000);
  assert.equal(opts.category, "Construction/Construction Services");
  const { sql } = buildNoticesQuery(opts);
  assert.match(sql, /ORDER BY start_date DESC/);
  assert.doesNotMatch(sql, /ORDER BY contract_amount DESC/);
});

test("before: amount-ordered LIMIT 25 hides Jul 27 $637k award under mega-contracts", () => {
  const corpus = [...megaAwards(30), NOTICE_JUL_24, NOTICE_JUL_27];
  const broken = filterRows(corpus, {
    noticeType: "Award",
    minAmount: 500000,
    category: "Construction/Construction Services",
    termGroups: [["construction"]],
    limit: 25,
    // deliberate old default — no orderBy
  });
  assert.equal(broken.rows.length, 25);
  assert.ok(!broken.rows.some((r) => r.request_id === "20260721018"),
    "amount DESC permanently excludes 20260721018");
  assert.ok(!broken.rows.some((r) => r.request_id === "20260720004"),
    "amount DESC also excludes the Jul 24 award that once delivered");
});

test("after: start_date order surfaces Jul 27 20260721018 (and Jul 24 20260720004) for digests", () => {
  const corpus = [...megaAwards(30), NOTICE_JUL_24, NOTICE_JUL_27];
  const opts = subToD1Opts({ lens: "money", filter: OWNER_FILTER }, "2026-07-30");
  const fixed = filterRows(corpus, opts);
  const ids = fixed.rows.map((r) => r.request_id);
  assert.ok(ids.includes("20260721018"), "Jul 27 Hunts Point dock Reconstruction must match");
  assert.ok(ids.includes("20260720004"), "Jul 24 Courthouse renovation must still match");
  // Newest first
  assert.ok(ids.indexOf("20260721018") < ids.indexOf("20260720004"));
});

test("day-by-day evidence: which days the owner filter SHOULD have matched (Jul 25–30)", () => {
  // Notices with start_date on each day (from live SODA as of 2026-07-30 investigation).
  // Cron at 13:00 UTC on day D sees rows already in the dataset (start_date ≤ D).
  // Expected owner matches (request_ids) after accounting for seen:
  //   Jul 25 cron: 20260720004 (start 07-24) — delivered ("1 new since Jul 24")
  //   Jul 26: none new
  //   Jul 27–28: 20260721018 (start 07-27) — MUST match; mailbox silence is the bug
  //   Jul 29–30: none new (20260724022 is category Construction ≥$500k but SODA $q
  //             does not hit the category field; title has no "construction")
  const expectedFresh = {
    "2026-07-25": ["20260720004"],
    "2026-07-26": [],
    "2026-07-27": ["20260721018"],
    "2026-07-28": ["20260721018"], // still fresh if never delivered
    "2026-07-29": ["20260721018"],
    "2026-07-30": ["20260721018"],
  };
  const publishedByStart = {
    "2026-07-24": [NOTICE_JUL_24],
    "2026-07-27": [NOTICE_JUL_27],
  };
  for (const day of Object.keys(expectedFresh)) {
    const opts = subToD1Opts({ lens: "money", filter: OWNER_FILTER }, day);
    const corpus = [
      ...megaAwards(30),
      ...Object.entries(publishedByStart)
        .filter(([d]) => d <= day)
        .flatMap(([, rows]) => rows),
    ];
    const { rows } = filterRows(corpus, opts);
    const seen = new Set(megaAwards(30).map((r) => r.request_id));
    // After the Jul 25 delivery, 20260720004 is marked seen.
    if (day >= "2026-07-26") seen.add("20260720004");
    const freshIds = rows.filter((r) => !seen.has(r.request_id)).map((r) => r.request_id)
      .filter((id) => !String(id).startsWith("MEGA"));
    assert.deepEqual(freshIds.sort(), expectedFresh[day].slice().sort(),
      `${day}: expected fresh ${expectedFresh[day]}, got ${freshIds}`);
  }
});

test("processOneSub over D1-shaped rows: Jul 27 notice sends after recency fix", async () => {
  const today = "2026-07-28"; // cron the morning after publish
  const subKey = "sub:owner@example.com:construction";
  const ALERT_STATE = {
    store: new Map(),
    async get(k) { return this.store.has(k) ? this.store.get(k) : null; },
    async put(k, v) { this.store.set(k, String(v)); },
  };
  // Seen: Jul 24 delivery + every mega-contract id (as if amount-ordered runs had
  // already stamped them, or they never appear under start_date order in the top 25).
  const priorSeen = ["20260720004", ...megaAwards(30).map((r) => r.request_id)];
  await ALERT_STATE.put(`seen:${subKey}`, JSON.stringify(priorSeen));
  await ALERT_STATE.put(`lastsent:${subKey}`, "2026-07-25");

  // Build the D1 result the fixed query would return (newest first, includes Jul 27).
  const opts = subToD1Opts({ lens: "money", filter: OWNER_FILTER }, today);
  const corpus = [...megaAwards(30), NOTICE_JUL_24, NOTICE_JUL_27];
  const { rows: d1rows } = filterRows(corpus, opts);
  assert.ok(d1rows.some((r) => r.request_id === "20260721018"));

  // Stub DB: isMirrorFresh + prepare().bind().all()
  const DB = {
    prepare(sql) {
      if (String(sql).includes("ingest_state")) {
        return {
          bind() {
            return { async first() { return { v: today }; } };
          },
        };
      }
      return {
        bind() {
          return {
            async all() {
              return { results: d1rows };
            },
          };
        },
      };
    },
  };

  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("api.resend.com")) {
      sent.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ id: "e1" }) };
    }
    // Must not fall through to SODA for this test — D1 is fresh.
    throw new Error("unexpected fetch (D1 should serve): " + url);
  };
  try {
    const r = await processOneSub(
      {
        DB, ALERT_STATE,
        RESEND_API_KEY: "rk", TOKEN_SECRET: "s".repeat(32),
        CONFIRM_BASE: "https://api.cityscroll.org", ALERTS_LIVE: "true",
      },
      {
        key: subKey, email: "owner@example.com", lens: "money",
        filter: OWNER_FILTER, freq: "daily", channel: "email",
        createdAt: "2026-07-01T00:00:00.000Z",
      },
      {
        FROM: "CityScroll <alerts@cityscroll.org>", LIVE: true,
        heartbeatDays: 14, today, isMonday: false,
        counts: () => ({ "per-run": 0, daily: 0 }),
        caps: { "per-run": 25, daily: 50 },
        onSent: async () => {},
      },
    );
    assert.equal(r.error, undefined, JSON.stringify(r));
    assert.equal(r.sent, true, "must send for 20260721018: " + JSON.stringify(r));
    assert.equal(r.new, 1);
    assert.equal(sent.length, 1);
    assert.match(sent[0].html, /20260721018|Hunts Point|Dock Reconstruction/i);
  } finally {
    globalThis.fetch = realFetch;
  }
});
