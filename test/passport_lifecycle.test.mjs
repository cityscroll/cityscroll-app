// Characterization: PASSPort Public EPIN↔PIN join + lifecycle enrichment.
//
// Real field cases from 2026-07-30 dumps (test/fixtures/passport/join_cases.json).
// Proves strict join methods, pending/RFx enrichment, and unmatched gap copy register.
//
//   node --test test/passport_lifecycle.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  buildEpinIndex,
  joinPinToEpin,
  normId,
  isPassportPendingStatus,
} from "../worker/src/lib/passport_join.mjs";
import {
  parseContractsDump,
  parseRfxDump,
  mapContractRow,
  mapRfxRow,
} from "../worker/src/lib/passport_parse.mjs";
import { enrichLifecycleWithPassport, parseUsDate } from "../worker/src/lib/passport_lifecycle.mjs";
import { assembleLifecycle } from "../worker/src/lib/checkbook_lifecycle.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const cases = JSON.parse(
  readFileSync(join(ROOT, "test/fixtures/passport/join_cases.json"), "utf8"),
);

test("join measurement topline is above usefulness threshold and recorded", () => {
  const m = cases.join_measurement_topline;
  assert.equal(m.universe_count, 7254);
  assert.ok(m.either_contracts_or_rfx_rate >= 0.3, "either-source rate must clear ~30% usefulness bar");
  assert.ok(m.award_to_contracts_rate >= 0.3);
  assert.ok(m.solicitation_to_rfx_rate >= 0.3);
});

test("strict join: exact award PIN → contract EPIN", () => {
  const { notice, passport_contract, expected_join_method } = cases.joined_award;
  const idx = buildEpinIndex([passport_contract.epin]);
  const hit = joinPinToEpin(notice.pin, idx);
  assert.deepEqual(hit, { method: expected_join_method, epin: normId(passport_contract.epin) });
});

test("strict join: exact solicitation PIN → RFx EPIN", () => {
  const { notice, passport_rfx, expected_join_method } = cases.joined_solicitation;
  const idx = buildEpinIndex([passport_rfx.epin]);
  const hit = joinPinToEpin(notice.pin, idx);
  assert.deepEqual(hit, { method: expected_join_method, epin: normId(passport_rfx.epin) });
});

test("strict join: EPIN is prefix of longer award PIN", () => {
  const { pin, epin, expected_method } = cases.prefix_join;
  const idx = buildEpinIndex([epin]);
  const hit = joinPinToEpin(pin, idx);
  assert.equal(hit?.method, expected_method);
  assert.equal(hit?.epin, normId(epin));
});

test("strict join rejects weak shared-prefix false positives", () => {
  // 26026N0011014 must not join 26026N0011098 (same first 11 chars, different body).
  const idx = buildEpinIndex(["26026N0011098"]);
  const hit = joinPinToEpin("26026N0011014", idx);
  assert.equal(hit, null);
});

test("unjoinable real PINs do not join empty indexes or unrelated EPINs", () => {
  const idx = buildEpinIndex(["81626W0043001", "81026B0003"]);
  assert.equal(joinPinToEpin(cases.unjoinable_award.notice.pin, idx), null);
  assert.equal(joinPinToEpin(cases.unjoinable_solicitation.notice.pin, idx), null);
});

test("parseUsDate handles PASSPort portal date strings", () => {
  assert.equal(parseUsDate("7/28/2026 9:00:00 AM"), "2026-07-28");
  assert.equal(parseUsDate("07/23/2026"), "2026-07-23");
  assert.equal(parseUsDate("2026-07-23T00:00:00"), "2026-07-23");
});

test("mapContractRow / mapRfxRow align to portal column order", () => {
  const ctr = mapContractRow([
    "5755276", "81626W0043001", "CT1-816-20278801775", "Title", "AGENCY", "VENDOR",
    "Program", "Method", "Type", "Registered", "$250,000.00", "$250,000.00",
    "$0", "$0", "09/01/2026", "08/31/2032", "07/23/2026", "Industry", "", "", "", "",
  ]);
  assert.equal(ctr.epin, "81626W0043001");
  assert.equal(ctr.vendor, "VENDOR");
  assert.equal(ctr.current_amount, 250000);

  const rfx = mapRfxRow([
    "36426", "36025", "Program", "Industry", "81026B0003", "Name", "AGENCY",
    "Released", "7/28/2026 9:00:00 AM", "8/18/2026 1:00:00 PM", "Commodity", "Competitive Sealed Bid",
  ]);
  assert.equal(rfx.epin, "81026B0003");
  assert.equal(rfx.rfx_status, "Released");
  assert.equal(rfx.procurement_method, "Competitive Sealed Bid");
});

test("parseContractsDump / parseRfxDump read var public_*_data arrays", () => {
  const ctrJs = 'var public_ctr_data = [\n["1","81626W0043001","CT1","T","A","V","P","M","Ty","Registered","$1","$1","","","01/01/2026","01/01/2027","01/02/2026","I","","","",""],\n];';
  const rows = parseContractsDump(ctrJs);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].epin, "81626W0043001");

  const rfxJs = 'var public_rfx_data = [\n["1","2","P","I","81026B0003","Name","A","Released","1/1/2026","2/1/2026","C","Bid"],\n];';
  const rfx = parseRfxDump(rfxJs);
  assert.equal(rfx.length, 1);
  assert.equal(rfx[0].epin, "81026B0003");
});

test("enrichment: Checkbook-unmatched pending filled from PASSPort In Progress", () => {
  const notice = cases.pending_passport_contract.synthetic_notice;
  const pp = cases.pending_passport_contract.passport_contract;
  assert.equal(isPassportPendingStatus(pp.status), true);

  const base = assembleLifecycle(notice, [], [], [], {
    pinStrategy: "exact",
    lookupStatus: { pending: "ok", registered: "ok", spending: "ok" },
  });
  const pending = base.timeline.find((e) => e.stage === "pending");
  assert.equal(pending.status, "unmatched");

  const enriched = enrichLifecycleWithPassport(base, notice, {
    contracts: [pp],
    rfx: [],
    lookupStatus: { contracts: "ok", rfx: "ok" },
  });
  const filled = enriched.timeline.find((e) => e.stage === "pending");
  assert.equal(filled.status, "matched");
  assert.equal(filled.source, "passport-public-contracts");
  assert.equal(filled.detail.passport_record_id, pp.ctr_id);
  assert.equal(filled.detail.vendor, "DELL MARKETING LP");
  assert.equal(filled.detail.passport_status, "In Progress");
});

test("enrichment: solicitation gains RFx detail on exact EPIN join", () => {
  const { notice, passport_rfx } = cases.joined_solicitation;
  const base = assembleLifecycle(notice, [], [], [], {
    pinStrategy: "exact",
    lookupStatus: { pending: "ok", registered: "ok", spending: "ok" },
  });
  const enriched = enrichLifecycleWithPassport(base, notice, {
    contracts: [],
    rfx: [passport_rfx],
    lookupStatus: { contracts: "ok", rfx: "ok" },
  });
  const sol = enriched.timeline.find((e) => e.stage === "solicitation");
  assert.equal(sol.rfx.status, "matched");
  assert.equal(sol.detail.rfx.procurement_method, "Competitive Sealed Bid");
  assert.equal(enriched.rfx_detail.status, "matched");
});

test("enrichment: zero RFx rows stamps root unmatched (not null) so pending ≠ miss", () => {
  const { notice } = cases.joined_solicitation;
  const base = assembleLifecycle(notice, [], [], [], {
    pinStrategy: "exact",
    lookupStatus: { pending: "ok", registered: "ok", spending: "ok" },
  });
  const enriched = enrichLifecycleWithPassport(base, notice, {
    contracts: [],
    rfx: [],
    lookupStatus: { contracts: "ok", rfx: "ok" },
  });
  assert.ok(enriched.rfx_detail, "root rfx_detail must be present after lookup");
  assert.equal(enriched.rfx_detail.status, "unmatched");
  assert.equal(enriched.rfx_detail.reason, "no_epin_pin_join");
  assert.equal(enriched.passport.rfx_found, 0);
});

test("enrichment: multi-row same EPIN stamps root ambiguous with candidates", () => {
  const { notice, passport_rfx } = cases.joined_solicitation;
  const twin = { ...passport_rfx, rfp_id: String(Number(passport_rfx.rfp_id || 1) + 1), procurement_name: "Twin RFx" };
  const base = assembleLifecycle(notice, [], [], [], {
    pinStrategy: "exact",
    lookupStatus: { pending: "ok", registered: "ok", spending: "ok" },
  });
  const enriched = enrichLifecycleWithPassport(base, notice, {
    contracts: [],
    rfx: [passport_rfx, twin],
    lookupStatus: { contracts: "ok", rfx: "ok" },
  });
  assert.equal(enriched.rfx_detail.status, "ambiguous");
  assert.equal(enriched.rfx_detail.candidates.length, 2);
  assert.equal(enriched.passport.rfx_found, 2);
});

test("enrichment: registered stage filled from PASSPort Registered when Checkbook unmatched", () => {
  const { notice, passport_contract } = cases.joined_award;
  const base = assembleLifecycle(notice, [], [], [], {
    pinStrategy: "exact",
    lookupStatus: { pending: "ok", registered: "ok", spending: "ok" },
  });
  assert.equal(base.timeline.find((e) => e.stage === "registered").status, "unmatched");

  const enriched = enrichLifecycleWithPassport(base, notice, {
    contracts: [passport_contract],
    rfx: [],
    lookupStatus: { contracts: "ok", rfx: "ok" },
  });
  const reg = enriched.timeline.find((e) => e.stage === "registered");
  assert.equal(reg.status, "matched");
  assert.equal(reg.source, "passport-public-contracts");
  assert.equal(reg.detail.passport_record_id, passport_contract.ctr_id);
  assert.equal(reg.detail.contract_id, "CT1-816-20278801775");
  assert.equal(reg.detail.vendor, "MAKE IT ZESTY LLC");
});

// Field case #notice/20240723114 shape: Checkbook total failure leaves payment unknown;
// PASSPort fills registered with paid_amount — payment stage must recover so panels agree.
test("enrichment: PASSPort registered paid_amount recovers payment stage (no unavailable split)", () => {
  const notice = {
    request_id: "20240723114",
    agency_name: "Homeless Services",
    type_of_notice_description: "Award",
    pin: "07124N0022001",
    vendor_name: "Acacia Network Housing Inc.",
    contract_amount: "7397875",
    short_title: "NAE-Millennium Adult Family Facility",
    start_date: "2024-07-29",
  };
  // Simulate Checkbook total failure (pending/registered/spending all error/unknown).
  const base = assembleLifecycle(notice, [], [], null, {
    pinStrategy: "exact",
    lookupStatus: { pending: "error", registered: "error", spending: "error" },
  });
  assert.equal(base.timeline.find((e) => e.stage === "registered").status, "unknown");
  assert.equal(base.timeline.find((e) => e.stage === "payment").status, "unknown");
  assert.equal(base.ok, false);

  const passportContract = {
    epin: "07124N0022001",
    epin_norm: "07124N0022001",
    contract_id: "CT1-071-20258800377",
    ctr_id: "CT1-071-20258800377",
    vendor: "ACACIA NETWORK HOUSING INC",
    status: "Registered",
    award_amount: 7397875,
    current_amount: 7397875,
    paid_amount: 4018484.1,
    start_date: "07/01/2024",
    end_date: "06/30/2025",
    registration_date: "07/22/2024",
  };
  const enriched = enrichLifecycleWithPassport(base, notice, {
    contracts: [passportContract],
    rfx: [],
    lookupStatus: { contracts: "ok", rfx: "ok" },
  });
  const reg = enriched.timeline.find((e) => e.stage === "registered");
  const pay = enriched.timeline.find((e) => e.stage === "payment");
  assert.equal(reg.status, "matched");
  assert.equal(reg.detail.spent_to_date, 4018484.1);
  assert.equal(pay.status, "matched", "payment recovered from PASSPort paid_amount");
  assert.equal(pay.detail.payment_state, "from_registered");
  assert.equal(pay.detail.total_spent, 4018484.1);
  assert.equal(enriched.ok, true, "no remaining unknown stages after recovery");
});

test("enrichment: unjoinable notice keeps unmatched pending with PASSPort in gap_sources", () => {
  const notice = cases.unjoinable_award.notice;
  const base = assembleLifecycle(notice, [], [], [], {
    pinStrategy: "exact",
    lookupStatus: { pending: "ok", registered: "ok", spending: "ok" },
  });
  const enriched = enrichLifecycleWithPassport(base, notice, {
    contracts: [],
    rfx: [],
    lookupStatus: { contracts: "ok", rfx: "ok" },
  });
  const pending = enriched.timeline.find((e) => e.stage === "pending");
  assert.equal(pending.status, "unmatched");
  assert.ok(pending.gap_sources.includes("passport-public-contracts"));
});

test("source contracts encode measured join rates", () => {
  const reg = JSON.parse(readFileSync(join(ROOT, "site/data/source_contracts.json"), "utf8"));
  const ctr = reg.contracts.find((c) => c.id === "passport-public-contracts");
  const rfx = reg.contracts.find((c) => c.id === "passport-public-rfx");
  assert.ok(ctr);
  assert.ok(rfx);
  assert.equal(ctr.endpoint, "https://a0333-passportpublic.nyc.gov/dataJs/contractData.js");
  assert.equal(rfx.endpoint, "https://a0333-passportpublic.nyc.gov/dataJs/rfxData.js");
  assert.equal(ctr.delivery_tier, "edge-materialized");
  assert.ok(ctr.join_measurement.rates.award_to_contracts.rate >= 0.3);
  assert.ok(rfx.join_measurement.rates.solicitation_to_rfx.rate >= 0.3);
  assert.ok(rfx.join_measurement.rates.either_contracts_or_rfx.rate >= 0.3);
  assert.match(ctr.join_measurement.verdict, /Above usefulness/i);
});
