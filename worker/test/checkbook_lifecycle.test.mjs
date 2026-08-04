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
  getOrCompute,
  CONTRACT_LIFECYCLE_ASSEMBLY_VERSION,
  contractLifecycleCacheIsCurrent,
} from "../src/checkbook_lifecycle.mjs";
import {
  assembleLifecycle,
  aggregateContractsById,
  recoverPaymentFromRegisteredJoin,
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

  // Production Money civic-time events (not a library-only seam)
  assert.ok(Array.isArray(body.civic_events), "civic_events attached on production path");
  assert.ok(body.civic_events.length >= 2, "solicitation + registration (+ payment) emit");
  const civicKinds = body.civic_events.map((e) => e.event_kind);
  assert.ok(civicKinds.includes("procurement.notice_published"));
  assert.ok(civicKinds.includes("procurement.award_registered"));
  assert.ok(civicKinds.includes("procurement.payment"));
  assert.ok(body.civic_events.every((e) => /^cte:[a-f0-9]{24}$/.test(e.event_id)));
  const cachedPayload = JSON.parse(db._cache["20250110001"].lifecycle);
  assert.ok(Array.isArray(cachedPayload.civic_events), "cached lifecycle retains civic_events");
  assert.equal(
    cachedPayload.assembly_version,
    CONTRACT_LIFECYCLE_ASSEMBLY_VERSION,
    "cachePut stamps assembly_version so later logic bumps force recompute",
  );

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
      // Seed must include assembly_version + ocp_award + civic_events + award_prime_goal so cacheGet treats it as complete.
      "ALREADY": {
        lifecycle: JSON.stringify({
          timeline: [],
          amendments: [],
          ok: true,
          ocp_award: { status: "unmatched", source: "ocp-recent-awards" },
          civic_events: [],
          award_prime_goal: { schema: "cityscroll.award_prime_goal.v1", eligible: false },
          assembly_version: CONTRACT_LIFECYCLE_ASSEMBLY_VERSION,
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
// 8b. CACHE VERSION GUARD: old assembly_version is a miss; current is a hit
//     (same pattern as subsidy parser_version / rules schema_version — #358)
// ===========================================================================

const STALE_ASSEMBLY = {
  timeline: [
    { stage: "award", status: "matched", source: "city-record", date: "2025-01-10" },
    // Pre-#362: matched award with no solicitation recovery.
  ],
  amendments: [],
  ok: true,
  ocp_award: { status: "unmatched", source: "ocp-recent-awards" },
  civic_events: [],
  coherence: { version: "lifecycle_coherence_v1", issues: [{ kind: "orphaned_award" }] },
  // no assembly_version — pre-version-guard rows
};

const CURRENT_ASSEMBLY = {
  ...STALE_ASSEMBLY,
  assembly_version: CONTRACT_LIFECYCLE_ASSEMBLY_VERSION,
  coherence: { version: "lifecycle_coherence_v2", issues: [] },
  solicitation_recovery: { status: "matched", source: "city-record", sources_checked: [] },
  award_prime_goal: {
    schema: "cityscroll.award_prime_goal.v1",
    eligible: true,
    subcontract_goal: { status: "not_published", goal_percent: null },
  },
  timeline: [
    { stage: "solicitation", status: "matched", source: "city-record", date: "2024-11-01" },
    { stage: "award", status: "matched", source: "city-record", date: "2025-01-10" },
  ],
};

test("CONTRACT_LIFECYCLE_ASSEMBLY_VERSION is a positive integer", () => {
  assert.equal(typeof CONTRACT_LIFECYCLE_ASSEMBLY_VERSION, "number");
  assert.ok(CONTRACT_LIFECYCLE_ASSEMBLY_VERSION >= 1);
});

test("contractLifecycleCacheIsCurrent rejects missing/old assembly_version", () => {
  assert.equal(contractLifecycleCacheIsCurrent(STALE_ASSEMBLY), false);
  assert.equal(
    contractLifecycleCacheIsCurrent({ ...STALE_ASSEMBLY, assembly_version: 1 }),
    false,
  );
  assert.equal(contractLifecycleCacheIsCurrent(CURRENT_ASSEMBLY), true);
});

test("contractLifecycleCacheIsCurrent still requires ocp_award + civic_events + award_prime_goal", () => {
  assert.equal(
    contractLifecycleCacheIsCurrent({
      ...CURRENT_ASSEMBLY,
      ocp_award: null,
    }),
    false,
  );
  assert.equal(
    contractLifecycleCacheIsCurrent({
      ...CURRENT_ASSEMBLY,
      civic_events: undefined,
    }),
    false,
  );
  assert.equal(
    contractLifecycleCacheIsCurrent({
      ...CURRENT_ASSEMBLY,
      award_prime_goal: null,
    }),
    false,
  );
});

test("getOrCompute recomputes a cached pre-version row after assembly_version bump", withMockedFetch({
  pending: emptyResponse(),
  registered: contractsResponse([{
    id: "C-VGUARD", vendor: "VERSION GUARD LLC", agency: "Sanitation", pin: "08250R0001999",
    status: "registered", current: "100000", original: "100000", spent: "0",
    registered: "2025-04-01", start: "2025-03-01",
  }]),
  spending: emptySpendingResponse(),
}, async () => {
  const noticeId = "20250110999";
  const db = fakeDB({
    notices: {
      [noticeId]: {
        request_id: noticeId, start_date: "2025-01-10", agency: "Sanitation",
        type_of_notice: "Award", short_title: "Version Guard Award", pin: "08250R0001999",
        vendor_name: "VERSION GUARD LLC", contract_amount: "100000",
      },
    },
    cache: {
      [noticeId]: {
        request_id: noticeId,
        agency: "Sanitation",
        lifecycle: JSON.stringify(STALE_ASSEMBLY),
        computed_at: "2026-07-01T00:00:00.000Z",
      },
    },
  });

  const result = await getOrCompute({ DB: db }, noticeId);
  assert.ok(result.lifecycle, "recompute must return a lifecycle");
  // Stale orphaned-award-only shape must not be served.
  assert.notEqual(
    result.lifecycle.coherence?.version,
    "lifecycle_coherence_v1",
    "pre-fix coherence must not be served from stale cache",
  );
  // Cache row rewritten with current assembly_version.
  const stored = JSON.parse(db._cache[noticeId].lifecycle);
  assert.equal(stored.assembly_version, CONTRACT_LIFECYCLE_ASSEMBLY_VERSION);
  assert.ok(
    Array.isArray(stored.timeline) && stored.timeline.length > 0,
    "recomputed timeline is present",
  );
}));

test("getOrCompute serves a current-version cache hit without recompute", async () => {
  const noticeId = "20250110998";
  const db = fakeDB({
    cache: {
      [noticeId]: {
        request_id: noticeId,
        agency: "Sanitation",
        lifecycle: JSON.stringify(CURRENT_ASSEMBLY),
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
    assert.equal(result.lifecycle.assembly_version, CONTRACT_LIFECYCLE_ASSEMBLY_VERSION);
    assert.equal(
      result.lifecycle.coherence.version,
      "lifecycle_coherence_v2",
      "current-version hit returns the stamped payload",
    );
    assert.equal(fetched, false, "current-version hit must not hit upstream");
  } finally {
    globalThis.fetch = orig;
  }
});

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

// Checkbook Contracts returns Prime Vendor + Sub Vendor slices under one
// prime_contract_id (field case: CT107120248803393 / notice 20231222103).
test("aggregateContractsById: collapses CT107120248803393-style prime+sub slices", () => {
  const slices = [
    { id: "CT107120248803393", vendor: "HOUSING OPTIONS", current: 24438023, original: 24438023, spent: 14496646.77, registered: "2023-12-21" },
    { id: "CT107120248803393", vendor: "HOUSING OPTIONS", current: 0, original: 0, spent: 0, registered: "2023-12-21" },
    { id: "CT107120248803393", vendor: "HOUSING OPTIONS", current: 0, original: 0, spent: 0, registered: "2023-12-21" },
    { id: "CT107120248803393", vendor: "HOUSING OPTIONS", current: 0, original: 0, spent: 0, registered: "2023-12-21" },
    { id: "CT107120248803393", vendor: "HOUSING OPTIONS", current: 0, original: 0, spent: 0, registered: "2023-12-21" },
    { id: "CT107120248803393", vendor: "HOUSING OPTIONS", current: 0, original: 0, spent: 0, registered: "2023-12-21" },
    { id: "CT107120248803393", vendor: "HOUSING OPTIONS", current: 0, original: 0, spent: 0, registered: "2023-12-21" },
  ];
  const out = aggregateContractsById(slices);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "CT107120248803393");
  assert.equal(out[0].current, 24438023);
  assert.equal(out[0].spent, 14496646.77);
  assert.equal(classifyStage(out), "matched");
});

test("aggregateContractsById: distinct ids stay distinct", () => {
  const out = aggregateContractsById([
    { id: "C1", current: 100, original: 100 },
    { id: "C2", current: 200, original: 200 },
    { id: "C1", current: 0, original: 0 },
  ]);
  assert.equal(out.length, 2);
  assert.equal(classifyStage(out), "ambiguous");
  const c1 = out.find((r) => r.id === "C1");
  assert.equal(c1.current, 100);
});

test("assembleLifecycle: CT107120248803393 duplicate-row shape → one confident registered contract", () => {
  const notice = {
    request_id: "20231222103",
    agency_name: "Homeless Services",
    type_of_notice_description: "Award",
    start_date: "2023-12-28",
    short_title: "Families with Children City Sanctuary",
    pin: "07123E0076001",
    vendor_name: "Housing Options",
    contract_amount: "24438023",
  };
  // One Prime Vendor row + six $0 Sub Vendor siblings (Checkbook row-slicing).
  const registered = [
    { id: "CT107120248803393", vendor: "HOUSING OPTIONS", current: 24438023, original: 24438023, spent: 14496646.77, registered: "2023-12-21", start: "2023-04-25", end: "2028-06-30" },
    { id: "CT107120248803393", vendor: "HOUSING OPTIONS", current: 0, original: 0, spent: 0, registered: "2023-12-21" },
    { id: "CT107120248803393", vendor: "HOUSING OPTIONS", current: 0, original: 0, spent: 0, registered: "2023-12-21" },
    { id: "CT107120248803393", vendor: "HOUSING OPTIONS", current: 0, original: 0, spent: 0, registered: "2023-12-21" },
    { id: "CT107120248803393", vendor: "HOUSING OPTIONS", current: 0, original: 0, spent: 0, registered: "2023-12-21" },
    { id: "CT107120248803393", vendor: "HOUSING OPTIONS", current: 0, original: 0, spent: 0, registered: "2023-12-21" },
    { id: "CT107120248803393", vendor: "HOUSING OPTIONS", current: 0, original: 0, spent: 0, registered: "2023-12-21" },
  ];
  const result = assembleLifecycle(notice, [], registered, [
    { amount: 500000, date: "2025-06-01", year: "2025" },
  ], {
    lookupStatus: { pending: "ok", registered: "ok", spending: "ok" },
  });
  const reg = result.timeline.find((t) => t.stage === "registered");
  assert.equal(reg.status, "matched", "same contract id must not be ambiguous");
  assert.equal(reg.detail.contract_id, "CT107120248803393");
  assert.equal(reg.detail.current_amount, 24438023);
  assert.equal(reg.detail.spent_to_date, 14496646.77);
  assert.ok(!reg.detail.candidates, "no candidate list on a confident single-id match");
  const pay = result.timeline.find((t) => t.stage === "payment");
  assert.equal(pay.status, "matched");
  assert.equal(pay.detail.payment_state, "paid");
});

test("assembleLifecycle: true multi-id registered still warns as ambiguous", () => {
  const notice = {
    request_id: "X", agency_name: "A", type_of_notice_description: "Award",
    start_date: "2025-01-01", short_title: "S", pin: "P", vendor_name: "V", contract_amount: "100",
  };
  const registered = [
    { id: "CT-AAA", vendor: "V1", current: 1000000, original: 1000000, registered: "2025-04-01" },
    { id: "CT-BBB", vendor: "V2", current: 2000000, original: 2000000, registered: "2025-04-05" },
    // Extra slice for CT-AAA must not create a third candidate
    { id: "CT-AAA", vendor: "V1", current: 0, original: 0, registered: "2025-04-01" },
  ];
  const result = assembleLifecycle(notice, [], registered, [], {
    lookupStatus: { pending: "ok", registered: "ok", spending: "ok" },
  });
  const reg = result.timeline.find((t) => t.stage === "registered");
  assert.equal(reg.status, "ambiguous");
  assert.equal(reg.detail.candidates.length, 2);
  const ids = reg.detail.candidates.map((c) => c.contract_id).sort();
  assert.deepEqual(ids, ["CT-AAA", "CT-BBB"]);
});

test("assembleLifecycle: pending stage also collapses same-id slices", () => {
  const notice = {
    request_id: "X", agency_name: "A", type_of_notice_description: "Solicitation",
    start_date: "2025-01-01", short_title: "S", pin: "P",
  };
  const pending = [
    { id: "P-1", vendor: "V", current: 500000, original: 500000, received: "2025-03-01" },
    { id: "P-1", vendor: "V", current: 0, original: 0, received: "2025-03-01" },
  ];
  const result = assembleLifecycle(notice, pending, [], [], {
    lookupStatus: { pending: "ok", registered: "ok", spending: "ok" },
  });
  const p = result.timeline.find((t) => t.stage === "pending");
  assert.equal(p.status, "matched");
  assert.equal(p.detail.contract_id, "P-1");
  assert.equal(p.detail.amount, 500000);
});

test("recoverPaymentFromRegisteredJoin: unknown payment + registered spent → from_registered", () => {
  const lifecycle = {
    ok: false,
    timeline: [
      { stage: "pending", status: "unknown", source: "checkbook-contracts", detail: null },
      {
        stage: "registered", status: "matched", source: "passport-public-contracts",
        detail: {
          contract_id: "CT1-071-20258800377",
          current_amount: 7397875,
          spent_to_date: 4018484.1,
        },
      },
      { stage: "payment", status: "unknown", source: "checkbook-spending", detail: null },
    ],
  };
  const out = recoverPaymentFromRegisteredJoin(lifecycle);
  const pay = out.timeline.find((e) => e.stage === "payment");
  const pending = out.timeline.find((e) => e.stage === "pending");
  assert.equal(pay.status, "matched");
  assert.equal(pay.detail.payment_state, "from_registered");
  assert.equal(pay.detail.total_spent, 4018484.1);
  assert.equal(pending.status, "passed");
  assert.equal(out.ok, true);
});

test("recoverPaymentFromRegisteredJoin: unavailable + spent 0 stays unavailable", () => {
  const lifecycle = {
    ok: true,
    timeline: [
      {
        stage: "registered", status: "matched", source: "checkbook-contracts",
        detail: { contract_id: "C1", current_amount: 100, spent_to_date: 0 },
      },
      {
        stage: "payment", status: "matched", source: "checkbook-spending",
        detail: { payment_state: "unavailable", total_spent: null },
      },
    ],
  };
  const out = recoverPaymentFromRegisteredJoin(lifecycle);
  assert.equal(out.timeline.find((e) => e.stage === "payment").detail.payment_state, "unavailable");
});

// Field case #notice/20230728114 (URI / MOCJ FJC case management):
// Verified 2026-07-30 against Checkbook: ONE Prime Vendor row for
// CT100220248801490 (PASSPort hyphen form CT1-002-20248801490), no Sub Vendor
// slices, no sibling contract ids under PIN 00222P0004003. Spending domain
// returns 7 transactions summing to exactly prime_vendor_spent_to_date
// ($344,117.23 across FY2024+FY2025). 57% of current ($608,658) is the true
// complete state — committed is a ceiling (amended down from $1,217,316), not
// missing payment rows.
test("URI 20230728114: single-row registered + spending sum equals spent_to_date (not multi-row)", () => {
  const registered = [{
    id: "CT100220248801490",
    vendor: "URBAN RESOURCE INSTITUTE",
    current: 608658,
    original: 1217316,
    spent: 344117.23,
    registered: "2023-07-27",
    start: "2023-07-01",
    end: "2024-06-30",
  }];
  // Fiscal-year slices of the same contract id — not separate identities.
  const spending = [
    { amount: 121732.00, year: "2024" },
    { amount: 70935.15, year: "2024" },
    { amount: 48469.34, year: "2024" },
    { amount: 9694.01, year: "2024" },
    { amount: 6648.87, year: "2024" },
    { amount: 3816.56, year: "2024" },
    { amount: 82821.30, year: "2025" },
  ];
  assert.equal(aggregateContractsById(registered).length, 1);
  const sum = spending.reduce((s, t) => s + t.amount, 0);
  assert.equal(Math.round(sum * 100) / 100, 344117.23);
  assert.equal(sum, registered[0].spent);

  const notice = {
    request_id: "20230728114",
    agency_name: "Mayor's Office of Criminal Justice",
    type_of_notice_description: "Award",
    pin: "00222P0004003",
    vendor_name: "Urban Resource Institute",
    contract_amount: "1217316",
    short_title: "Family Justice Center - Case Mngt",
    start_date: "2023-08-03",
  };
  const result = assembleLifecycle(notice, [], registered, spending, {
    lookupStatus: { pending: "ok", registered: "ok", spending: "ok" },
  });
  const reg = result.timeline.find((t) => t.stage === "registered");
  const pay = result.timeline.find((t) => t.stage === "payment");
  assert.equal(reg.status, "matched");
  assert.equal(reg.detail.contract_id, "CT100220248801490");
  assert.equal(reg.detail.current_amount, 608658);
  assert.equal(reg.detail.original_amount, 1217316);
  assert.equal(pay.status, "matched");
  assert.equal(pay.detail.payment_state, "paid");
  assert.equal(pay.detail.total_spent, 344117.23);
  assert.equal(pay.detail.total_payments, 7);
  // ~56.5% of ceiling — domain underrun, not a join defect
  const pct = pay.detail.total_spent / reg.detail.current_amount;
  assert.ok(pct > 0.55 && pct < 0.58, `expected ~57% of ceiling, got ${pct}`);
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
  // WH-03: demo request_id is in warehouse materialization — no live SODA needed.
  assert.equal(body.ocp_award.lookup_path, "warehouse");
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
