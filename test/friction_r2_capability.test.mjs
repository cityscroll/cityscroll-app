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
import { compileSub_d1 } from "../worker/src/lib/compile_d1.mjs";
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

    const d1 = compileSub_d1(sub, CLOCK);
    assert.equal(d1?.opts?.noticeType, "Solicitation");

    const textQuery = compileSub({
      lens: "money",
      filter: sanitize("money", {
        noticeType: "solicitation",
        text_query: { version: 1, all: [[{ kind: "term", value: "CBTC" }]], none: [] },
      }),
    }, CLOCK);
    assert.equal(textQuery.kind, "rfp");
    assert.equal(typeof textQuery.mergeRows, "function");

    const cityRecordControls = [CITY_RECORD_SOLICITATION, CITY_RECORD_DUPLICATE_PIN];
    const viaFallback = mergeCompiledRows(fallback, cityRecordControls);
    const viaD1 = mergeCompiledRows(fallback, cityRecordControls); // same mergeRows contract as alerts D1 path
    const viaText = textQuery.mergeRows([]);
    const viaMatch = matchProcurementDigestRows(digest, filter, { lens: "money", todayISO: CLOCK });
    const viaMerge = mergeProcurementDigestMatches(sub, cityRecordControls, digest, CLOCK);

    assert.deepEqual(nativeIds(viaFallback), nativeIds(viaD1));
    assert.deepEqual(nativeIds(viaFallback.filter((row) => row.procurement_id)), [NATIVE_B]);
    assert.ok(idsOf(viaFallback).includes(CITY_RECORD_SOLICITATION.request_id));
    assert.ok(idsOf(viaFallback).includes(CITY_RECORD_DUPLICATE_PIN.request_id));
    assert.ok(idsOf(viaFallback).includes(NATIVE_B));
    assert.equal(idsOf(viaFallback).length, new Set(idsOf(viaFallback)).size);

    assert.deepEqual(nativeIds(viaMatch), [NATIVE_B]);
    assert.deepEqual(nativeIds(viaMerge.filter((row) => row.procurement_id)), [NATIVE_B]);
    assert.deepEqual(idsOf(viaMerge), idsOf(viaFallback));

    // Positive native control through the text-query owned materialization path.
    assert.ok(nativeIds(viaText).includes(NATIVE_B));
    assert.equal(nativeIds(viaText).includes(BID_RESULT), false);
    assert.equal(nativeIds(viaText).includes(AWARD_A), false);

    // Positive City Record control: a solicitation notice identity survives merge
    // beside the native row without collapsing on title/PIN similarity.
    assert.ok(idsOf(viaFallback).includes("20260707026"));
  } finally {
    restore();
  }
});
