/**
 * Solicitation watches admit eligible native solicitation-stage records
 * through the shared lifecycle + dedup path (alias c4e4a53a5b0fe).
 *
 * City Record and authority-native open opportunities share one eligibility
 * gate before any optional lead-time preference is applied.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  digestIdentity,
  matchProcurementDigestRows,
  mergeProcurementDigestMatches,
  stampDigestIdentity,
  unionMoneyDigestRows,
} from "../site/procurement_digest_compile.mjs";
import { testClockISOString } from "./helpers/test_clock.mjs";
import { compileSub, mergeCompiledRows, useProcurementDigestSnapshot } from "../worker/src/lib/compile.mjs";
import { compileSub_d1, toDigestRow } from "../worker/src/lib/compile_d1.mjs";
import { sanitize } from "../worker/src/lib/filter.mjs";

const CLOCK = "2026-09-11";
const NATIVE_A = "procurement:contract_reporter_number:2138505";
const NATIVE_B = "procurement:solicitation:S48020";
const BID_RESULT = "procurement:solicitation:AW9Y";
const AWARD_A = "procurement:contract:A37703";
const AWARD_B = "procurement:contract:BA2335819";

const digest = JSON.parse(readFileSync(
  new URL("../site/data/procurement_digest_snapshot.json", import.meta.url),
  "utf8",
));

const CITY_RECORD_SOLICITATION = Object.freeze(stampDigestIdentity({
  request_id: "20260707026",
  digest_id: "20260707026",
  short_title: "DOB open solicitation control",
  agency_name: "Department of Buildings",
  type_of_notice_description: "Solicitation",
  due_date: "2026-10-02",
  start_date: "2026-07-07",
  pin: "85026B0001",
}));

const CITY_RECORD_DUPLICATE_PIN = Object.freeze(stampDigestIdentity({
  request_id: "20260911099",
  digest_id: "20260911099",
  short_title: "Unjoined City Record row sharing a native token only",
  agency_name: "MTA Construction & Development",
  type_of_notice_description: "Solicitation",
  due_date: "2026-11-01",
  start_date: "2026-09-01",
  // Same human-visible solicitation token as S48020, without a canonical join.
  pin: "S48020",
}));

function solicitationFilter(extra = {}) {
  return sanitize("money", { noticeType: "solicitation", ...extra });
}

function idsOf(rows) {
  return rows.map((row) => digestIdentity(row)).filter(Boolean).sort();
}

function nativeIds(rows) {
  return rows.map((row) => row.procurement_id).filter(Boolean).sort();
}

/**
 * Row → D1 notices column names that `toDigestRow` reads.
 * `request_id` is the City Record notice id when present; authority-native
 * controls have none, so the shared merge still admits them from the digest.
 */
function asD1NoticeColumns(row, { requestId = null } = {}) {
  const amount = row?.contract_amount;
  const hasAmount = amount != null && Number.isFinite(Number(amount));
  return {
    request_id: requestId,
    start_date: row?.start_date ?? null,
    agency: row?.agency_name ?? null,
    short_title: row?.short_title ?? null,
    pin: row?.pin ?? null,
    contract_amount: hasAmount ? Number(amount) : null,
    contract_amount_valid: hasAmount ? 1 : 0,
    vendor_name: row?.vendor_name ?? null,
    due_date: row?.due_date ?? null,
    section: "Procurement",
    type_of_notice: row?.type_of_notice_description || "Solicitation",
    selection_method: null,
    event_date: null,
    event_addr1: null,
    description: null,
  };
}

function digestRowByProcurementId(procurementId) {
  return (digest.rows || []).find((row) => row?.procurement_id === procurementId) || null;
}

test("A1 agency-matching solicitation watches admit both retained native solicitations before lead-time", () => {
  const clock = testClockISOString();
  assert.match(clock, /^\d{4}-\d{2}-\d{2}T/);

  const nyct = matchProcurementDigestRows(digest, solicitationFilter({
    agency: "MTA - NYC Transit (NYCT)",
  }), { lens: "money", todayISO: CLOCK });
  const cd = matchProcurementDigestRows(digest, solicitationFilter({
    agency: "MTA Construction & Development",
  }), { lens: "money", todayISO: CLOCK });
  const open = matchProcurementDigestRows(digest, solicitationFilter(), {
    lens: "money",
    todayISO: CLOCK,
  });

  assert.deepEqual(nativeIds(nyct), [NATIVE_A]);
  assert.deepEqual(nativeIds(cd), [NATIVE_B]);
  assert.ok(nativeIds(open).includes(NATIVE_A), "2138505 is solicitation-eligible");
  assert.ok(nativeIds(open).includes(NATIVE_B), "S48020 is solicitation-eligible");
  assert.equal(nyct[0].primary_stage, "solicitation");
  assert.equal(cd[0].primary_stage, "solicitation");

  // Eligibility is decided here; optional lead-time preferences apply later.
  assert.equal(Object.prototype.hasOwnProperty.call(open[0], "lead_time_days"), false);
});

test("A2 bid-result and award records stay out of solicitation watches; award watches keep prior matches", () => {
  const solicitation = matchProcurementDigestRows(digest, solicitationFilter({
    agency: "MTA Construction & Development",
  }), { lens: "money", todayISO: CLOCK });
  const open = matchProcurementDigestRows(digest, solicitationFilter(), {
    lens: "money",
    todayISO: CLOCK,
  });
  const awardCd = matchProcurementDigestRows(digest, sanitize("money", {
    noticeType: "award",
    agency: "MTA Construction & Development",
  }), { lens: "money", todayISO: CLOCK });
  const awardNycha = matchProcurementDigestRows(digest, sanitize("money", {
    noticeType: "award",
    agency: "NYCHA",
  }), { lens: "money", todayISO: CLOCK });

  for (const rows of [solicitation, open]) {
    assert.equal(nativeIds(rows).includes(BID_RESULT), false, "AW-9Y bid result is not a new open solicitation");
    assert.equal(nativeIds(rows).includes(AWARD_A), false, "A37703 award is not a new open solicitation");
    assert.equal(nativeIds(rows).includes(AWARD_B), false, "BA2335819 award/contract is not a new open solicitation");
  }

  assert.ok(nativeIds(awardCd).includes(AWARD_A), "award watches still match A37703");
  assert.ok(nativeIds(awardNycha).includes(AWARD_B), "award watches still match BA2335819");
  assert.equal(nativeIds(awardCd).includes(NATIVE_B), false, "solicitation-stage rows stay off award watches");
  assert.equal(nativeIds(awardCd).includes(BID_RESULT), false, "bid-opening results stay off award watches");
});

test("A3 exact solicitation follows keep stage and identity; unjoined duplicates stay separate", () => {
  const exact = matchProcurementDigestRows(digest, sanitize("money", {
    procurement_id: NATIVE_B,
  }), { lens: "money", todayISO: CLOCK });
  assert.equal(exact.length, 1);
  assert.equal(exact[0].procurement_id, NATIVE_B);
  assert.equal(exact[0].primary_stage, "solicitation");
  assert.equal(exact[0].digest_id, NATIVE_B);

  const restore = useProcurementDigestSnapshot(digest);
  try {
    const query = compileSub({
      lens: "money",
      filter: sanitize("money", { procurement_id: NATIVE_B }),
    }, CLOCK);
    assert.equal(query.kind, "rfp", "exact solicitation follows compile as solicitations");
    const rows = query.readRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].procurement_id, NATIVE_B);
    assert.equal(rows[0].primary_stage, "solicitation");
  } finally {
    restore();
  }

  const merged = unionMoneyDigestRows(
    [CITY_RECORD_DUPLICATE_PIN],
    matchProcurementDigestRows(digest, solicitationFilter({
      agency: "MTA Construction & Development",
    }), { lens: "money", todayISO: CLOCK }),
  );
  assert.deepEqual(idsOf(merged), [CITY_RECORD_DUPLICATE_PIN.request_id, NATIVE_B].sort());
  assert.equal(merged.length, 2, "City Record and native rows stay distinct without a shared digest identity");
  assert.notEqual(
    digestIdentity(CITY_RECORD_DUPLICATE_PIN),
    digestIdentity(merged.find((row) => row.procurement_id === NATIVE_B)),
    "a shared PIN alone is not a proven canonical join",
  );
});

test("A4 D1, fallback, and text-query branches share lifecycle eligibility and dedup", () => {
  const filter = solicitationFilter({ agency: "MTA Construction & Development" });
  const sub = { lens: "money", filter };
  const restore = useProcurementDigestSnapshot(digest);
  try {
    const fallback = compileSub(sub, CLOCK);
    assert.equal(fallback.kind, "rfp");
    assert.match(String(fallback.params?.$where || ""), /Solicitation/);
    assert.equal(typeof fallback.mergeRows, "function");

    // Alerts compile the same subscription for D1, map mirror rows through
    // toDigestRow, apply d1.postFilter when set, then mergeCompiledRows against
    // the fallback compilation (shared merge surface).
    const d1 = compileSub_d1(sub, CLOCK);
    assert.equal(d1?.opts?.noticeType, "Solicitation");
    assert.equal(d1?.opts?.agency, "MTA Construction & Development");
    // Agency money watches do not set postFilter; vendor and exact-institution
    // watches do. Recording undefined here is a fact about this watch.
    assert.equal(
      d1.postFilter,
      undefined,
      "agency solicitation watch leaves D1 postFilter undefined (vendor/exact-institution set one)",
    );

    const textQuery = compileSub({
      lens: "money",
      filter: sanitize("money", {
        noticeType: "solicitation",
        text_query: { version: 1, all: [[{ kind: "term", value: "CBTC" }]], none: [] },
      }),
    }, CLOCK);
    assert.equal(textQuery.kind, "rfp");
    assert.equal(typeof textQuery.mergeRows, "function");

    const nativeA = digestRowByProcurementId(NATIVE_A);
    const nativeB = digestRowByProcurementId(NATIVE_B);
    assert.ok(nativeA, "retained native control 2138505");
    assert.ok(nativeB, "retained native control S48020");

    // Hand the native controls in D1 column shape through the production mapper.
    let mappedNatives = [nativeA, nativeB].map((row) => asD1NoticeColumns(row)).map(toDigestRow);
    if (typeof d1.postFilter === "function") {
      mappedNatives = mappedNatives.filter(d1.postFilter);
    }
    assert.equal(mappedNatives.length, 2);
    assert.equal(mappedNatives[0].agency_name, nativeA.agency_name);
    assert.equal(mappedNatives[1].agency_name, nativeB.agency_name);
    assert.equal(mappedNatives[0].short_title, nativeA.short_title);
    assert.equal(mappedNatives[1].short_title, nativeB.short_title);
    // Authority-native rows are not City Record notices; after toDigestRow they
    // carry no request_id, so digest identity stays with the shared merge path.
    assert.equal(digestIdentity(stampDigestIdentity(mappedNatives[0])), null);
    assert.equal(digestIdentity(stampDigestIdentity(mappedNatives[1])), null);

    const cityRecordControls = [CITY_RECORD_SOLICITATION, CITY_RECORD_DUPLICATE_PIN];
    let mappedCity = cityRecordControls
      .map((row) => asD1NoticeColumns(row, { requestId: row.request_id }))
      .map(toDigestRow);
    if (typeof d1.postFilter === "function") {
      mappedCity = mappedCity.filter(d1.postFilter);
    }

    const viaFallback = mergeCompiledRows(fallback, cityRecordControls);
    const viaD1 = mergeCompiledRows(fallback, [...mappedNatives, ...mappedCity]);
    const viaText = textQuery.mergeRows([]);
    const viaMatch = matchProcurementDigestRows(digest, filter, { lens: "money", todayISO: CLOCK });
    const viaMerge = mergeProcurementDigestMatches(sub, cityRecordControls, digest, CLOCK);

    assert.deepEqual(idsOf(viaD1), idsOf(viaFallback));
    assert.deepEqual(nativeIds(viaD1), nativeIds(viaFallback));
    assert.deepEqual(nativeIds(viaFallback), [NATIVE_B]);
    assert.ok(idsOf(viaFallback).includes(CITY_RECORD_SOLICITATION.request_id));
    assert.ok(idsOf(viaFallback).includes(CITY_RECORD_DUPLICATE_PIN.request_id));
    assert.ok(idsOf(viaFallback).includes(NATIVE_B));
    assert.equal(idsOf(viaFallback).length, new Set(idsOf(viaFallback)).size);
    assert.equal(idsOf(viaD1).length, new Set(idsOf(viaD1)).size);

    assert.deepEqual(nativeIds(viaMatch), [NATIVE_B]);
    assert.deepEqual(nativeIds(viaMerge.filter((row) => row.procurement_id)), [NATIVE_B]);
    assert.deepEqual(idsOf(viaMerge), idsOf(viaFallback));

    // Positive native control through the text-query owned materialization path.
    assert.ok(nativeIds(viaText).includes(NATIVE_B));
    for (const rows of [viaFallback, viaD1, viaText]) {
      assert.equal(nativeIds(rows).includes(BID_RESULT), false);
      assert.equal(nativeIds(rows).includes(AWARD_A), false);
      assert.equal(nativeIds(rows).includes(AWARD_B), false);
    }

    // Positive City Record control: a solicitation notice identity survives merge
    // beside the native row without collapsing on title/PIN similarity.
    assert.ok(idsOf(viaFallback).includes("20260707026"));
    assert.ok(idsOf(viaD1).includes("20260707026"));
  } finally {
    restore();
  }
});
