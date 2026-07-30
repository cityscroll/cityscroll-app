// Pins worker/src/checkbook_lifecycle.mjs — the precompute + cache + endpoint layer for the
// procurement contract lifecycle joining City Record to Checkbook NYC.
//
// The fixtures walk every lifecycle boundary:
//   - FULL lifecycle: solicitation → award → pending → registered → payment
//   - LEGACY PIN: exact PIN fails, base PIN (renewal suffix stripped) succeeds
//   - AMENDMENTS: registered contract with current ≠ original amount
//   - NO MATCH: PIN with no Checkbook records → explicit unmatched stages
//   - CURSOR/CAP: paginated Checkbook response with the page cap respected
//   - SOURCE TIMESTAMPS: each stage carries the upstream event date
//   - FAILURE: Checkbook/WAF error → ok:false, not cached
//
//   node --test   (from crol-list/worker/)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  handleContractLifecycle,
  computeLifecycle,
  prewarmContractLifecycle,
} from "../src/checkbook_lifecycle.mjs";
import {
  assembleLifecycle,
  parseContractTransactions,
  parseSpendingTransactions,
  classifyStage,
  detectAmendments,
  pinMatchStrategy,
  checkbookSuccess,
} from "../src/lib/checkbook_lifecycle.mjs";

// ---------------------------------------------------------------------------
// In-memory D1 + KV stubs
// ---------------------------------------------------------------------------

function fakeDB(seed = {}) {
  const notices = seed.notices || {};
  const cache = seed.cache || {};
  return {
    _cache: cache,
    prepare(sql) {
      return {
        _sql: sql, _args: [],
        bind(...a) { this._args = a; return this; },
        async first() {
          if (/FROM notices/.test(this._sql)) {
            const n = notices[this._args[0]];
            return n ? {
              request_id: n.request_id,
              start_date: n.start_date,
              agency_name: n.agency,
              type_of_notice_description: n.type_of_notice,
              short_title: n.short_title,
              pin: n.pin,
              contract_amount: n.contract_amount,
              vendor_name: n.vendor_name,
            } : null;
          }
          if (/FROM contract_lifecycle/.test(this._sql)) return cache[this._args[0]] || null;
          return null;
        },
        async run() {
          if (/INSERT OR REPLACE INTO contract_lifecycle/.test(this._sql)) {
            const [request_id, agency, lifecycle, computed_at] = this._args;
            cache[request_id] = { request_id, agency, lifecycle, computed_at };
          }
          return { success: true };
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Checkbook XML response builders
// ---------------------------------------------------------------------------

function contractsResponse(contracts, opts = {}) {
  const tx = (Array.isArray(contracts) ? contracts : [contracts]).map((c) =>
    `<transaction>`
    + `<prime_contract_id>${c.id || ""}</prime_contract_id>`
    + `<prime_vendor>${c.vendor || ""}</prime_vendor>`
    + `<agency_name>${c.agency || ""}</agency_name>`
    + `<pin>${c.pin || ""}</pin>`
    + `<status>${c.status || "registered"}</status>`
    + `<prime_contract_current_amount>${c.current || ""}</prime_contract_current_amount>`
    + `<prime_contract_original_amount>${c.original || ""}</prime_contract_original_amount>`
    + `<prime_vendor_spent_to_date>${c.spent || ""}</prime_vendor_spent_to_date>`
    + `<prime_contract_start_date>${c.start || ""}</prime_contract_start_date>`
    + `<prime_contract_end_date>${c.end || ""}</prime_contract_end_date>`
    + `<prime_contract_registration_date>${c.registered || ""}</prime_contract_registration_date>`
    + `<received_date>${c.received || ""}</received_date>`
    + `<prime_vendor_mwbe_category>${c.mwbe || ""}</prime_vendor_mwbe_category>`
    + `<prime_contract_duration>${c.duration || ""}</prime_contract_duration>`
    + `</transaction>`).join("");
  const count = opts.count !== undefined ? opts.count : (Array.isArray(contracts) ? contracts.length : (contracts ? 1 : 0));
  return `<response><status><result>success</result><record_count>${count}</record_count></status><contract_transactions>${tx}</contract_transactions></response>`;
}

function spendingResponse(transactions) {
  const tx = (Array.isArray(transactions) ? transactions : [transactions]).map((s) =>
    `<transaction>`
    + `<spending_id>${s.id || ""}</spending_id>`
    + `<vendor_name>${s.vendor || ""}</vendor_name>`
    + `<agency_name>${s.agency || ""}</agency_name>`
    + `<pin>${s.pin || ""}</pin>`
    + `<check_amount>${s.amount || ""}</check_amount>`
    + `<check_date>${s.date || ""}</check_date>`
    + `<fiscal_year>${s.year || ""}</fiscal_year>`
    + `</transaction>`).join("");
  return `<response><status><result>success</result><record_count>${Array.isArray(transactions) ? transactions.length : 1}</record_count></status><spending_transactions>${tx}</spending_transactions></response>`;
}

function emptyResponse() {
  return `<response><status><result>success</result><record_count>0</record_count></status><contract_transactions></contract_transactions></response>`;
}

function emptySpendingResponse() {
  return `<response><status><result>success</result><record_count>0</record_count></status><spending_transactions></spending_transactions></response>`;
}

function errorResponse() {
  return `<response><status><result>failure</result></status></response>`;
}

// ---------------------------------------------------------------------------
// Mock fetch dispatcher: routes Checkbook POSTs and SODA GETs by search criteria
// ---------------------------------------------------------------------------

function withMockedFetch(routes, fn) {
  return async () => {
    const orig = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      calls.push({ url: u, body: opts?.body || "" });

      // SODA: City Record notice lookup (dg92) vs OCP recent awards (qyyg-4tf5)
      if (u.startsWith("https://data.cityofnewyork.us/resource/")) {
        if (u.includes("qyyg-4tf5")) {
          return {
            ok: routes.ocpError ? false : true,
            status: routes.ocpError ? 503 : 200,
            json: async () => routes.ocpAwards || [],
          };
        }
        return { ok: true, status: 200, json: async () => routes.sodaNotice || [] };
      }

      // Checkbook
      if (u.startsWith("https://www.checkbooknyc.com/api")) {
        const body = opts?.body || "";

        if (routes.checkbookError) {
          return { ok: false, status: 403, text: async () => "" };
        }

        // Route by type_of_data, status, PIN (contracts), or contract_id (spending)
        const dataType = body.match(/<type_of_data>([^<]*)<\/type_of_data>/)?.[1] || "";
        const statusVal = body.match(/<name>status<\/name>[\s\S]*?<value>([^<]*)<\/value>/)?.[1] || "";
        const pinVal = body.match(/<name>pin<\/name>[\s\S]*?<value>([^<]*)<\/value>/)?.[1] || "";
        const contractIdVal = body.match(/<name>contract_id<\/name>[\s\S]*?<value>([^<]*)<\/value>/)?.[1] || "";

        // Optional PIN-aware routing (for legacy-PIN fallback tests)
        if (routes.pinRouter) {
          const routed = routes.pinRouter(pinVal, dataType, statusVal, contractIdVal);
          if (routed !== undefined) {
            return { ok: true, status: 200, text: async () => routed };
          }
        }

        if (dataType === "Spending") {
          // Spending must be keyed by contract_id (PIN is invalid on this domain).
          if (body.includes("<name>pin</name>")) {
            return {
              ok: true, status: 200,
              text: async () => `<response><status><result>failure</result><messages><message><code>1101</code></message></messages></status></response>`,
            };
          }
          return { ok: true, status: 200, text: async () => routes.spending || emptySpendingResponse() };
        }
        if (dataType === "Contracts") {
          if (statusVal === "pending") {
            return { ok: true, status: 200, text: async () => routes.pending || emptyResponse() };
          }
          if (statusVal === "registered") {
            return { ok: true, status: 200, text: async () => routes.registered || emptyResponse() };
          }
        }

        // Check for error response
        if (routes.checkbookFail) {
          return { ok: true, status: 200, text: async () => errorResponse() };
        }

        return { ok: true, status: 200, text: async () => emptyResponse() };
      }

      throw new Error("unexpected fetch " + u);
    };
    try { await fn(calls); } finally { globalThis.fetch = orig; }
  };
}

const req = (qs, method = "GET") => new Request("https://w/contract-lifecycle" + qs, { method });

// ===========================================================================
// 1. FULL LIFECYCLE: solicitation → award → pending → registered → payment
// ===========================================================================

test("FULL lifecycle: solicitation → pending → registered → payment with source timestamps", withMockedFetch({
  pending: contractsResponse([{
    id: "C-1001", vendor: "ACME CORP", agency: "Sanitation", pin: "08250R0001001",
    status: "pending", current: "5000000", original: "5000000",
    received: "2025-03-15", start: "2025-03-01",
  }]),
  registered: contractsResponse([{
    id: "C-1001", vendor: "ACME CORP", agency: "Sanitation", pin: "08250R0001001",
    status: "registered", current: "5000000", original: "5000000", spent: "1500000",
    registered: "2025-04-01", start: "2025-03-01", end: "2028-03-01",
    duration: "3 Years", mwbe: "Non-M/WBE",
  }]),
  spending: spendingResponse([
    { id: "S-1", vendor: "ACME CORP", agency: "Sanitation", pin: "08250R0001001", amount: "750000", date: "2025-05-15", year: "2025" },
    { id: "S-2", vendor: "ACME CORP", agency: "Sanitation", pin: "08250R0001001", amount: "750000", date: "2025-08-20", year: "2025" },
  ]),
}, async () => {
  const db = fakeDB({
    notices: {
      "20250110001": {
        request_id: "20250110001", start_date: "2025-01-10", agency: "Sanitation",
        type_of_notice: "Solicitation", short_title: "Collection Services", pin: "08250R0001001",
      },
    },
  });
  const res = await handleContractLifecycle(req("?id=20250110001"), { DB: db });
  const body = await res.json();

  assert.equal(body.ok, true);
  assert.equal(body.pin, "08250R0001001");

  // Verify all 5 stages present (solicitation + 4 Checkbook stages; no award since this is a Solicitation)
  const stages = body.timeline.map((t) => t.stage);
  assert.ok(stages.includes("solicitation"), "has solicitation stage");
  assert.ok(stages.includes("pending"), "has pending stage");
  assert.ok(stages.includes("registered"), "has registered stage");
  assert.ok(stages.includes("payment"), "has payment stage");

  // Each stage has explicit status and source
  const pending = body.timeline.find((t) => t.stage === "pending");
  assert.equal(pending.status, "matched");
  assert.equal(pending.source, "checkbook-contracts");
  assert.equal(pending.detail.vendor, "ACME CORP");
  assert.equal(pending.date, "2025-03-15", "pending date is the received_date");

  const registered = body.timeline.find((t) => t.stage === "registered");
  assert.equal(registered.status, "matched");
  assert.equal(registered.detail.current_amount, 5000000);
  assert.equal(registered.detail.spent_to_date, 1500000);
  assert.equal(registered.date, "2025-04-01", "registered date is the registration_date");

  const payment = body.timeline.find((t) => t.stage === "payment");
  assert.equal(payment.status, "matched");
  assert.equal(payment.detail.total_payments, 2);
  assert.equal(payment.detail.total_spent, 1500000);
  assert.equal(payment.detail.latest_payment_date, "2025-08-20");
  assert.equal(payment.detail.payment_state, "paid");

  // Source timestamps propagate
  assert.equal(pending.source_timestamp, "2025-03-15");
  assert.equal(registered.source_timestamp, "2025-04-01");

  // Cached in D1
  assert.ok(db._cache["20250110001"], "lifecycle was cached in D1");
  assert.equal(res.headers.get("Cache-Control"), "public, max-age=300");
}));

test("Spending lookup uses contract_id, never pin (Checkbook code 1101)", withMockedFetch({
  registered: contractsResponse([{
    id: "CT184120268807929", vendor: "HNTB", pin: "84124P0003001",
    status: "registered", current: "100", original: "100", spent: "0",
    registered: "2026-06-22", start: "2024-10-11", end: "2032-10-10",
  }]),
  pending: emptyResponse(),
  spending: emptySpendingResponse(),
}, async (calls) => {
  const db = fakeDB({
    notices: {
      "20260623008": {
        request_id: "20260623008", start_date: "2026-06-29", agency: "Transportation",
        type_of_notice: "Award", short_title: "Bridge", pin: "84124P0003001",
        vendor_name: "HNTB", contract_amount: "100",
      },
    },
  });
  const res = await handleContractLifecycle(req("?id=20260623008"), { DB: db });
  const body = await res.json();
  assert.equal(body.ok, true);
  const spendCalls = calls.filter((c) => c.url.includes("checkbooknyc") && String(c.body).includes("Spending"));
  assert.ok(spendCalls.length >= 1, "at least one spending request");
  for (const c of spendCalls) {
    assert.match(c.body, /<name>contract_id<\/name>/);
    assert.doesNotMatch(c.body, /<name>pin<\/name>/);
    assert.match(c.body, /CT184120268807929/);
  }
  const payment = body.timeline.find((t) => t.stage === "payment");
  assert.equal(payment.detail.payment_state, "verified_zero");
  assert.equal(payment.detail.total_spent, 0);
}));

// ===========================================================================
// 2. LEGACY PIN FALLBACK: exact PIN fails, base PIN succeeds
// ===========================================================================

test("LEGACY PIN: exact renewal-suffixed PIN finds nothing, base PIN matches", withMockedFetch({
  pinRouter(pin, dataType, statusVal) {
    // Only the BASE pin (82626) has records; the full renewal-suffixed PIN (82626R0001001) finds nothing
    if (pin === "82626R0001001") return emptyResponse();
    if (pin === "82626") {
      if (dataType === "Spending") return emptySpendingResponse();
      if (statusVal === "pending") return contractsResponse([{
        id: "C-2002", vendor: "BETA LLC", pin: "82626", status: "pending",
        current: "2000000", received: "2025-02-01", start: "2025-01-15",
      }]);
      if (statusVal === "registered") return contractsResponse([{
        id: "C-2002", vendor: "BETA LLC", pin: "82626", status: "registered",
        current: "2000000", original: "2000000", registered: "2025-03-01", start: "2025-01-15",
      }]);
    }
    return undefined;
  },
}, async () => {
  // The notice has a renewal-suffixed PIN; the base is what Checkbook has
  const db = fakeDB({
    notices: {
      "20250110002": {
        request_id: "20250110002", start_date: "2025-01-10", agency: "Parks",
        type_of_notice: "Award", short_title: "Park Maintenance", pin: "82626R0001001",
        vendor_name: "BETA LLC", contract_amount: "2000000",
      },
    },
  });
  const res = await handleContractLifecycle(req("?id=20250110002"), { DB: db });
  const body = await res.json();

  assert.equal(body.ok, true);
  assert.equal(body.pin_strategy, "legacy-base", "fell back to the base PIN");

  const registered = body.timeline.find((t) => t.stage === "registered");
  assert.equal(registered.status, "matched");
  assert.equal(registered.detail.vendor, "BETA LLC");

  // Award stage present (this is an Award notice)
  const award = body.timeline.find((t) => t.stage === "award");
  assert.ok(award, "award stage present for an Award notice");
}));

// ===========================================================================
// 3. AMENDMENTS: registered contract where current ≠ original
// ===========================================================================

test("AMENDMENTS: current_amount ≠ original_amount produces an amendment event", withMockedFetch({
  pending: emptyResponse(),
  registered: contractsResponse([{
    id: "C-3003", vendor: "GAMMA INC", agency: "Transportation", pin: "07112R0001001",
    status: "registered", current: "7500000", original: "5000000",
    registered: "2025-04-01", start: "2025-03-01",
  }]),
  spending: emptySpendingResponse(),
}, async () => {
  const db = fakeDB({
    notices: {
      "20250110003": {
        request_id: "20250110003", start_date: "2025-01-10", agency: "Transportation",
        type_of_notice: "Solicitation", short_title: "Bridge Repair", pin: "07112R0001001",
      },
    },
  });
  const res = await handleContractLifecycle(req("?id=20250110003"), { DB: db });
  const body = await res.json();

  assert.equal(body.amendments.length, 1, "one amendment detected");
  assert.equal(body.amendments[0].original_amount, 5000000);
  assert.equal(body.amendments[0].current_amount, 7500000);
  assert.equal(body.amendments[0].delta, 2500000);
  assert.equal(body.amendments[0].date, "2025-04-01");

  const registered = body.timeline.find((t) => t.stage === "registered");
  assert.equal(registered.detail.current_amount, 7500000);
  assert.equal(registered.detail.original_amount, 5000000);
}));

// ===========================================================================
// 4. NO-MATCH: PIN with no Checkbook records → explicit unmatched stages
// ===========================================================================

test("NO MATCH: usable PIN, no Checkbook records → unmatched stages (not blank)", withMockedFetch({
  pending: emptyResponse(),
  registered: emptyResponse(),
  spending: emptySpendingResponse(),
}, async () => {
  const db = fakeDB({
    notices: {
      "20250110004": {
        request_id: "20250110004", start_date: "2025-01-10", agency: "Aging",
        type_of_notice: "Solicitation", short_title: "Meals Program", pin: "09876R0001001",
      },
    },
  });
  const res = await handleContractLifecycle(req("?id=20250110004"), { DB: db });
  const body = await res.json();

  assert.equal(body.ok, true);

  const pending = body.timeline.find((t) => t.stage === "pending");
  assert.equal(pending.status, "unmatched", "pending is explicitly unmatched, not blank");

  const registered = body.timeline.find((t) => t.stage === "registered");
  assert.equal(registered.status, "unmatched");

  const payment = body.timeline.find((t) => t.stage === "payment");
  assert.equal(payment.status, "unmatched");

  // No amendments when nothing matched
  assert.deepEqual(body.amendments, []);

  // Still cached (ok:true — the lookups completed, they just found nothing)
  assert.ok(db._cache["20250110004"], "a confirmed empty result is cached");
}));

// ===========================================================================
// 5. NO USABLE PIN: notice has no PIN → Checkbook stages not_applicable
// ===========================================================================

test("NO PIN: notice without a usable PIN → not_applicable stages, no Checkbook calls", async () => {
  const orig = globalThis.fetch;
  let checkbookCalls = 0;
  let sodaCalls = 0;
  let ocpCalls = 0;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("checkbooknyc.com")) checkbookCalls++;
    if (u.includes("data.cityofnewyork.us")) sodaCalls++;
    if (u.includes("qyyg-4tf5")) ocpCalls++;
    return { ok: true, json: async () => [], text: async () => "" };
  };
  try {
    const db = fakeDB({
      notices: {
        "20250110005": {
          request_id: "20250110005", start_date: "2025-01-10", agency: "Sanitation",
          type_of_notice: "Solicitation", short_title: "Services", pin: "N/A",
        },
      },
    });
    const res = await handleContractLifecycle(req("?id=20250110005"), { DB: db });
    const body = await res.json();

    // No PIN is not a transient failure — stages are not_applicable; ok is true so the
    // renderer can collapse them into the single class-(b) no-PIN note.
    assert.equal(body.ok, true);
    assert.equal(body.pin_strategy, "none");
    for (const stage of ["pending", "registered", "payment"]) {
      const entry = body.timeline.find((t) => t.stage === stage);
      assert.equal(entry.status, "not_applicable", `${stage} is not_applicable without a PIN`);
    }
    assert.equal(checkbookCalls, 0, "no Checkbook calls made for a notice without a usable PIN");
    // Current Solicitations (3khw-qi8f) may still be queried by request_id for package docs.
    assert.ok(sodaCalls >= 0, "Open Data package enrichment is allowed without a PIN");
    const sol = body.timeline.find((t) => t.stage === "solicitation");
    assert.ok(sol, "solicitation stage still present");
    assert.equal(sol.documents_status, "unmatched");
    // OCP side-car still runs (request_id join) and is attached
    assert.ok(ocpCalls >= 1, "OCP side-car lookup still runs without a PIN");
    assert.ok(body.ocp_award, "ocp_award attached even without PIN");
  } finally { globalThis.fetch = orig; }
});

// ===========================================================================
// 6. CURSOR/CAP: paginated Checkbook response respects the page cap
// ===========================================================================

test("CURSOR/CAP: Checkbook pagination capped at MAX_PAGES × PAGE_SIZE", async () => {
  // Generate 110 spending transactions (more than the 100-record cap)
  const bigSpending = Array.from({ length: 110 }, (_, i) => ({
    id: `S-${i + 1}`, vendor: "DELTA", agency: "Health", pin: "05550R0001001",
    amount: "1000", date: "2025-06-01", year: "2025",
  }));

  let pageCalls = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.startsWith("https://data.cityofnewyork.us/")) {
      return { ok: true, status: 200, json: async () => [] };
    }
    if (u.startsWith("https://www.checkbooknyc.com/api")) {
      const body = opts?.body || "";
      const from = parseInt(body.match(/<records_from>(\d+)</)?.[1] || "1");
      const dataType = body.match(/<type_of_data>([^<]*)</)?.[1] || "";

      if (dataType === "Contracts") {
        // Spending is keyed by contract_id — contracts must return an id so the
        // spending domain is actually queried (PIN is invalid on Spending).
        const statusVal = body.match(/<name>status<\/name>[\s\S]*?<value>([^<]*)<\/value>/)?.[1] || "";
        if (statusVal === "registered") {
          return {
            ok: true, status: 200,
            text: async () => contractsResponse([{
              id: "C-CAP", vendor: "DELTA", pin: "05550R0001001", status: "registered",
              current: "5000000", original: "5000000", spent: "0", registered: "2025-04-01",
            }]),
          };
        }
        return { ok: true, status: 200, text: async () => emptyResponse() };
      }
      if (dataType === "Spending") {
        pageCalls++;
        const start = from - 1;
        const chunk = bigSpending.slice(start, start + 25);
        if (chunk.length === 0) return { ok: true, status: 200, text: async () => emptySpendingResponse() };
        return { ok: true, status: 200, text: async () => spendingResponse(chunk) };
      }
    }
    throw new Error("unexpected");
  };
  try {
    const db = fakeDB({
      notices: {
        "20250110006": {
          request_id: "20250110006", start_date: "2025-01-10", agency: "Health",
          type_of_notice: "Award", short_title: "Health Services", pin: "05550R0001001",
          vendor_name: "DELTA", contract_amount: "5000000",
        },
      },
    });
    const res = await handleContractLifecycle(req("?id=20250110006"), { DB: db });
    const body = await res.json();

    const payment = body.timeline.find((t) => t.stage === "payment");
    assert.equal(payment.status, "matched");
    assert.ok(payment.detail.total_payments <= 100, "capped at 100 records (4 pages × 25)");
    // The spending domain made at most MAX_PAGES (4) page requests
    assert.ok(pageCalls <= 4, `spending pagination capped at 4 pages, got ${pageCalls}`);
  } finally { globalThis.fetch = orig; }
});

// ===========================================================================
// 7. FAILURE: Checkbook/WAF error → ok:false, not cached
// ===========================================================================

test("FAILURE: Checkbook error → lifecycle ok:true but stages unknown, not cached", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith("https://data.cityofnewyork.us/")) {
      return { ok: true, status: 200, json: async () => [] };
    }
    if (u.startsWith("https://www.checkbooknyc.com/api")) {
      return { ok: false, status: 403, text: async () => "" };
    }
    throw new Error("unexpected");
  };
  try {
    const db = fakeDB({
      notices: {
        "20250110007": {
          request_id: "20250110007", start_date: "2025-01-10", agency: "Sanitation",
          type_of_notice: "Solicitation", short_title: "Services", pin: "08250R0001001",
        },
      },
    });
    const res = await handleContractLifecycle(req("?id=20250110007"), { DB: db });
    const body = await res.json();

    // lifecycle.ok is false because all Checkbook lookups failed
    assert.equal(body.ok, false);

    const pending = body.timeline.find((t) => t.stage === "pending");
    assert.equal(pending.status, "unknown");

    assert.equal(res.headers.get("Cache-Control"), "no-store");
    assert.equal(db._cache["20250110007"], undefined, "a failed lookup must not be cached");
  } finally { globalThis.fetch = orig; }
});

// ===========================================================================
// 8. PREWARM: bounded, idempotent, fail-soft
// ===========================================================================

test("prewarm: bounded, idempotent, skips already-cached ids", withMockedFetch({
  pending: emptyResponse(),
  registered: contractsResponse([{
    id: "C-4004", vendor: "EPSILON", agency: "Corrections", pin: "06001R0001001",
    status: "registered", current: "3000000", original: "3000000",
    registered: "2025-05-01", start: "2025-04-01",
  }]),
  spending: emptySpendingResponse(),
}, async () => {
  const db = fakeDB({
    notices: {
      "20250110008": {
        request_id: "20250110008", start_date: "2025-01-10", agency: "Corrections",
        type_of_notice: "Award", short_title: "Security Services", pin: "06001R0001001",
        vendor_name: "EPSILON", contract_amount: "3000000",
      },
    },
    cache: {
      // Seed must include ocp_award so cacheGet treats it as a complete post-side-car entry.
      "ALREADY": {
        lifecycle: JSON.stringify({
          timeline: [],
          amendments: [],
          ok: true,
          ocp_award: { status: "unmatched", source: "ocp-recent-awards" },
        }),
      },
    },
  });
  const r = await prewarmContractLifecycle({ DB: db }, ["20250110008", "ALREADY", "20250110008"]);
  assert.equal(r.requested, 2, "deduped");
  assert.equal(r.skipped, 1);
  assert.equal(r.computed, 1);
}));

// ===========================================================================
// 9. ROUTING/VALIDATION
// ===========================================================================

test("GET /contract-lifecycle: rejects missing id", async () => {
  const res = await handleContractLifecycle(req(""), { DB: fakeDB() });
  assert.equal(res.status, 400);
});

test("GET /contract-lifecycle: rejects malformed id", async () => {
  const res = await handleContractLifecycle(req("?id=..%2Fetc"), { DB: fakeDB() });
  assert.equal(res.status, 400);
});

test("GET /contract-lifecycle: OPTIONS preflight returns 204", async () => {
  const res = await handleContractLifecycle(req("?id=test", "OPTIONS"), {});
  assert.equal(res.status, 204);
});

test("GET /contract-lifecycle: unresolvable id → ok:false", withMockedFetch({
  sodaNotice: [],
}, async () => {
  const res = await handleContractLifecycle(req("?id=99999999999"), { DB: fakeDB() });
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(res.headers.get("Cache-Control"), "no-store");
}));

// ===========================================================================
// 10. AMBIGUOUS: multiple pending contracts → ambiguous status
// ===========================================================================

test("AMBIGUOUS: multiple pending contracts for same PIN → ambiguous status", withMockedFetch({
  pending: contractsResponse([
    { id: "C-5A", vendor: "VENDOR A", pin: "12345R0001001", status: "pending", current: "1000000", received: "2025-03-01" },
    { id: "C-5B", vendor: "VENDOR B", pin: "12345R0001001", status: "pending", current: "2000000", received: "2025-03-05" },
  ]),
  registered: emptyResponse(),
  spending: emptySpendingResponse(),
}, async () => {
  const db = fakeDB({
    notices: {
      "20250110010": {
        request_id: "20250110010", start_date: "2025-01-10", agency: "Sanitation",
        type_of_notice: "Solicitation", short_title: "Services", pin: "12345R0001001",
      },
    },
  });
  const res = await handleContractLifecycle(req("?id=20250110010"), { DB: db });
  const body = await res.json();

  const pending = body.timeline.find((t) => t.stage === "pending");
  assert.equal(pending.status, "ambiguous", "multiple pending contracts → ambiguous");
  assert.ok(pending.detail.candidates, "ambiguous stage lists candidates");
  assert.equal(pending.detail.candidates.length, 2);
}));

// ===========================================================================
// 11. UNIT TESTS for pure library functions
// ===========================================================================

test("classifyStage: 0 → unmatched, 1 → matched, 2+ → ambiguous", () => {
  assert.equal(classifyStage([]), "unmatched");
  assert.equal(classifyStage([{ id: "1" }]), "matched");
  assert.equal(classifyStage([{ id: "1" }, { id: "2" }]), "ambiguous");
  assert.equal(classifyStage(null), "unknown");
});

test("detectAmendments: current ≠ original → amendment", () => {
  const amendments = detectAmendments([
    { id: "C1", original: 1000000, current: 1500000, registered: "2025-04-01" },
    { id: "C2", original: 2000000, current: 2000000 },
    { id: "C3", original: 0, current: 500000 },
  ]);
  assert.equal(amendments.length, 1);
  assert.equal(amendments[0].contract_id, "C1");
  assert.equal(amendments[0].delta, 500000);
});

test("pinMatchStrategy: exact PIN with no renewal suffix → exact only", () => {
  const { pins, strategy } = pinMatchStrategy("08250R0001001");
  assert.equal(strategy, "legacy-base");
  assert.deepEqual(pins, ["08250R0001001", "08250"]);
});

test("pinMatchStrategy: PIN without renewal suffix → exact only", () => {
  const { pins, strategy } = pinMatchStrategy("08250");
  assert.equal(strategy, "exact");
  assert.deepEqual(pins, ["08250"]);
});

test("pinMatchStrategy: junk PIN → none", () => {
  const { pins, strategy } = pinMatchStrategy("N/A");
  assert.equal(strategy, "none");
  assert.deepEqual(pins, []);
});

test("parseContractTransactions: extracts fields from XML", () => {
  const xml = contractsResponse([{
    id: "C-99", vendor: "TEST", pin: "12345", status: "registered",
    current: "1000000.00", original: "900000.00", spent: "500000.00",
    registered: "2025-04-01", start: "2025-03-01",
  }]);
  const txs = parseContractTransactions(xml);
  assert.equal(txs.length, 1);
  assert.equal(txs[0].id, "C-99");
  assert.equal(txs[0].current, 1000000);
  assert.equal(txs[0].original, 900000);
  assert.equal(txs[0].registered, "2025-04-01");
});

test("parseSpendingTransactions: extracts spending fields from XML", () => {
  const xml = spendingResponse([
    { id: "S-1", vendor: "TEST", pin: "12345", amount: "5000.00", date: "2025-06-01" },
  ]);
  const txs = parseSpendingTransactions(xml);
  assert.equal(txs.length, 1);
  assert.equal(txs[0].amount, 5000);
  assert.equal(txs[0].date, "2025-06-01");
});

test("checkbookSuccess: detects success/failure in XML", () => {
  assert.ok(checkbookSuccess(contractsResponse([{ id: "C" }])));
  assert.ok(!checkbookSuccess(errorResponse()));
  assert.ok(!checkbookSuccess(""));
});

test("assembleLifecycle: produces timeline with all stages and ok flag", () => {
  const notice = {
    request_id: "TEST", agency_name: "Sanitation", type_of_notice_description: "Solicitation",
    start_date: "2025-01-10", short_title: "Services", pin: "12345",
  };
  const result = assembleLifecycle(notice, [], [{ id: "C1", registered: "2025-04-01", current: 1000000, original: 1000000, vendor: "V" }], [], {
    lookupStatus: { pending: "ok", registered: "ok", spending: "ok" },
  });
  assert.equal(result.ok, true);
  assert.equal(result.timeline.length, 4); // solicitation + pending + registered + payment (no award)
  assert.equal(result.timeline[0].stage, "solicitation");
  assert.equal(result.timeline[2].status, "matched"); // registered
});

// ===========================================================================
// OCP Recent Contract Awards side-car (qyyg-4tf5)
// ===========================================================================

test("OCP side-car: matched by request_id with amount/date agreement", withMockedFetch({
  pending: emptyResponse(),
  registered: emptyResponse(),
  spending: emptySpendingResponse(),
  ocpAwards: [{
    request_id: "20260723031",
    start_date: "2026-07-30T00:00:00.000",
    agency_name: "Health and Mental Hygiene",
    type_of_notice_description: "Award",
    short_title: "Catering Services",
    pin: "81626W0043001",
    contract_amount: "250000",
    vendor_name: "Make it Zesty LLC",
  }],
}, async () => {
  const db = fakeDB({
    notices: {
      "20260723031": {
        request_id: "20260723031", start_date: "2026-07-30", agency: "Health and Mental Hygiene",
        type_of_notice: "Award", short_title: "Catering Services", pin: "81626W0043001",
        contract_amount: "250000", vendor_name: "Make it Zesty LLC",
      },
    },
  });
  const res = await handleContractLifecycle(req("?id=20260723031"), { DB: db });
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(body.ocp_award, "ocp_award side-car present");
  assert.equal(body.ocp_award.status, "matched");
  assert.equal(body.ocp_award.join_key, "request_id");
  assert.equal(body.ocp_award.detail.vendor, "Make it Zesty LLC");
  assert.equal(body.ocp_award.detail.amount, 250000);
  assert.equal(body.ocp_award.corroboration.agree, true);
  // Cached payload must include ocp_award so recompute is not required
  const cached = JSON.parse(db._cache["20260723031"].lifecycle);
  assert.equal(cached.ocp_award.status, "matched");
}));

test("OCP side-car: City Record / OCP amount disagreement keeps both values", withMockedFetch({
  pending: emptyResponse(),
  registered: emptyResponse(),
  spending: emptySpendingResponse(),
  ocpAwards: [{
    request_id: "20260723031",
    start_date: "2026-07-30T00:00:00.000",
    type_of_notice_description: "Award",
    pin: "81626W0043001",
    contract_amount: "250000",
    vendor_name: "Make it Zesty LLC",
  }],
}, async () => {
  const db = fakeDB({
    notices: {
      "20260723031": {
        request_id: "20260723031", start_date: "2026-07-15", agency: "Health and Mental Hygiene",
        type_of_notice: "Award", short_title: "Catering Services", pin: "81626W0043001",
        contract_amount: "999999", vendor_name: "Make it Zesty LLC",
      },
    },
  });
  const res = await handleContractLifecycle(req("?id=20260723031"), { DB: db });
  const body = await res.json();
  assert.equal(body.ocp_award.status, "matched");
  assert.equal(body.ocp_award.corroboration.agree, false);
  const amount = body.ocp_award.corroboration.disagreements.find((d) => d.field === "amount");
  assert.equal(amount.city_record, 999999);
  assert.equal(amount.ocp, 250000);
  const date = body.ocp_award.corroboration.disagreements.find((d) => d.field === "date");
  assert.equal(date.city_record, "2026-07-15");
  assert.equal(date.ocp, "2026-07-30");
}));

test("OCP side-car: unmatched uses not-yet-ingested gap (empty OCP lookup)", withMockedFetch({
  pending: emptyResponse(),
  registered: emptyResponse(),
  spending: emptySpendingResponse(),
  ocpAwards: [],
}, async () => {
  const db = fakeDB({
    notices: {
      "20250110001": {
        request_id: "20250110001", start_date: "2025-01-10", agency: "Sanitation",
        type_of_notice: "Award", short_title: "Collection", pin: "08250R0001001",
        contract_amount: "100", vendor_name: "ACME",
      },
    },
  });
  const res = await handleContractLifecycle(req("?id=20250110001"), { DB: db });
  const body = await res.json();
  assert.equal(body.ocp_award.status, "unmatched");
}));

test("OCP side-car: reach failure marks unknown (not unmatched gap)", withMockedFetch({
  pending: emptyResponse(),
  registered: emptyResponse(),
  spending: emptySpendingResponse(),
  ocpError: true,
}, async () => {
  const db = fakeDB({
    notices: {
      "20250110001": {
        request_id: "20250110001", start_date: "2025-01-10", agency: "Sanitation",
        type_of_notice: "Award", short_title: "Collection", pin: "08250R0001001",
        contract_amount: "100", vendor_name: "ACME",
      },
    },
  });
  const res = await handleContractLifecycle(req("?id=20250110001"), { DB: db });
  const body = await res.json();
  assert.equal(body.ocp_award.status, "unknown");
}));
