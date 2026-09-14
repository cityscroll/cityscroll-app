import assert from "node:assert/strict";
import test from "node:test";
import {
  CHECKBOOK_ACQUISITION_STATES,
  checkbookAcquisitionState,
  normalizeCheckbookContractId,
} from "../worker/src/lib/checkbook_lifecycle.mjs";
import {
  EMMONS_CHECKBOOK_ANCHOR,
  computeExactContractLifecycle,
  exactContractRequestXml,
} from "../worker/src/checkbook_lifecycle.mjs";

const CONTRACT = "CT107120258801626";

test("the monitored anchor uses the exact contract key, never the PIN", () => {
  assert.equal(normalizeCheckbookContractId("CT1-071-20258801626"), CONTRACT);
  const request = exactContractRequestXml("CT1-071-20258801626", "registered", 1);
  assert.match(request, /<name>contract_id<\/name>/);
  assert.match(request, new RegExp(`<value>${CONTRACT}<\\/value>`));
  assert.doesNotMatch(request, /<name>pin<\/name>|07124E0044001/);
  assert.equal(EMMONS_CHECKBOOK_ANCHOR.contract_id, CONTRACT);
});

test("acquisition states keep not-run, exact no-match, failure, match, and stale distinct", () => {
  assert.equal(checkbookAcquisitionState(), CHECKBOOK_ACQUISITION_STATES.NOT_RUN);
  assert.equal(checkbookAcquisitionState({ lookupStatus: { pending: "ok", registered: "ok" }, rows: [] }), CHECKBOOK_ACQUISITION_STATES.CHECKED_NO_EXACT_MATCH);
  assert.equal(checkbookAcquisitionState({ lookupStatus: { pending: "error", registered: "ok" } }), CHECKBOOK_ACQUISITION_STATES.TEMPORARILY_UNAVAILABLE);
  assert.equal(checkbookAcquisitionState({ lookupStatus: { pending: "ok", registered: "ok" }, rows: [{ id: CONTRACT }] }), CHECKBOOK_ACQUISITION_STATES.MATCHED);
  assert.equal(checkbookAcquisitionState({ lookupStatus: { pending: "ok", registered: "ok" }, rows: [{ id: CONTRACT }], observedAt: "2020-01-01T00:00:00Z", now: Date.parse("2020-01-03T00:00:00Z") }), CHECKBOOK_ACQUISITION_STATES.STALE);
});

test("exact acquisition projects payment rows with source events and as-of metadata", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, options = {}) => {
    const body = String(options.body || "");
    requests.push(body);
    if (body.includes("<type_of_data>Contracts</type_of_data>")) {
      const status = body.includes(">pending</value>") ? "pending" : "registered";
      const row = status === "registered"
        ? `<transaction><prime_contract_id>${CONTRACT}</prime_contract_id><prime_vendor>BHRAGS HOME CARE CORP</prime_vendor><prime_contract_current_amount>10869881</prime_contract_current_amount><prime_contract_original_amount>10869881</prime_contract_original_amount><prime_vendor_spent_to_date>250</prime_vendor_spent_to_date><prime_contract_registration_date>2024-08-28</prime_contract_registration_date><prime_contract_start_date>2023-10-11</prime_contract_start_date><prime_contract_end_date>2026-06-30</prime_contract_end_date></transaction>`
        : "";
      return new Response(`<response><status><result>success</result></status><contract_transactions>${row}</contract_transactions></response>`);
    }
    return new Response(`<response><status><result>success</result></status><spending_transactions><transaction><document_id>CHK-1</document_id><contract_id>${CONTRACT}</contract_id><payee_name>BHRAGS HOME CARE CORP</payee_name><check_amount>250</check_amount><issue_date>2025-02-03</issue_date><fiscal_year>2025</fiscal_year></transaction></spending_transactions></response>`);
  };
  try {
    const result = await computeExactContractLifecycle({}, CONTRACT, EMMONS_CHECKBOOK_ANCHOR.request_id, {
      request_id: EMMONS_CHECKBOOK_ANCHOR.request_id,
      agency_name: "Homeless Services",
      type_of_notice_description: "Award",
      start_date: "2024-09-05",
      short_title: "Emmons shelter",
      pin: EMMONS_CHECKBOOK_ANCHOR.pin,
    });
    const acquisition = result.lifecycle.checkbook_acquisition;
    const payment = result.lifecycle.timeline.find((entry) => entry.stage === "payment");
    assert.equal(acquisition.state, CHECKBOOK_ACQUISITION_STATES.MATCHED);
    assert.equal(acquisition.contract_id, CONTRACT);
    assert.equal(acquisition.payment_as_of, "2025-02-03");
    assert.equal(payment.detail.payment_rows[0].source_observation_ref, "checkbook_spending:CHK-1");
    assert.match(payment.detail.payment_rows[0].drill_through_href, /CHK-1/);
    assert.equal(requests.filter((body) => body.includes("<type_of_data>Contracts</type_of_data>")).length, 2);
    assert.ok(requests.filter((body) => body.includes("<type_of_data>Contracts</type_of_data>")).every((body) => body.includes(CONTRACT) && !body.includes("07124E0044001")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
