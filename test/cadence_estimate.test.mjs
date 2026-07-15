// Pins cadenceEstimate()/cadenceHTML() (w12-04): "is this a yearly bid?" answered in words,
// computed purely from the same paper-trail chain chainHTML() already renders — no new fetch.
//
// Before this card: the notice detail showed the raw award-and-renewal boxes (chainHTML()) but
// never stated the pattern in words — a reader had to eyeball three dated boxes and do the
// arithmetic themselves to answer "is this a yearly bid, and when's the next one?"
//
// Real fixture (pinned 2026-07-15 from the live City Record open dataset, dg92-zbpx): NYC
// Department of Correction PIN base "07219P0148001", "Inmate Phone System" — three Award
// notices under renewal-suffixed PINs (R002/R003/R004), spaced 287 and 246 days apart:
//   $ curl -s ".../dg92-zbpx.json?\$select=request_id,pin,start_date,type_of_notice_description,short_title,contract_amount,vendor_name&\$where=pin%20LIKE%20'07219P0148001%25'&\$order=start_date%20ASC"
//   R002  2021-11-03  Award  "Inmate Phone System - Renewal #2"
//   R003  2022-08-17  Award  "Inmate Phone Systems"
//   R004  2023-04-20  Award  "Inmate Phone System - Renewal No. 4"
//
// A second real fixture (same dataset) exercises the blanket-PIN exclusion: Sanitation PIN
// "82714CC00040" has 21 Award notices, all published the same day (2014-02-28) to 21 different
// demolition/carting vendors — a simultaneous multi-vendor pool, not sequential rebid cycles
// (chainHTML()'s pre-existing blanket_note already calls this out; isBlanketChain()'s
// `chain.length > 5 && every(...)==="Award"` threshold is shared with it, not new here).
// Trimmed to 6 of the 21 real rows — enough to cross the >5 threshold without a wall of fixture
// data. Averaging its same-day gaps would report "about 0 months apart" if not excluded.
//
// Period-generality fixtures (pinned 2026-07-15, live-queried unless noted), added on review
// to prove cadenceEstimate()/cadenceApart() aren't tuned to one gap length:
//
// A real multi-year fixture — NYC Department for the Aging, PIN base "12522P0001001",
// "Older Adult Center(s)" (Crown Heights Preservation Committee Corp.), three Award notices
// 730 and 719 days apart (avg 724.5 days = 24 rounded months = 2 rounded years), crossing
// CADENCE_YEAR_THRESHOLD_MONTHS and exercising the "about N years apart" phrasing on real data:
//   $ curl -s ".../dg92-zbpx.json?\$where=pin%20LIKE%20'12522P0001001%25'%20AND%20agency_name='Aging'&\$order=start_date%20ASC"
//   (no suffix)  2022-07-06  Award  "PROVIDE OLDER ADULT CENTER SERVICES"
//   R002         2024-07-05  Award  "OLDER ADULT CENTERS"
//   R004         2026-06-24  Award  "OLDER ADULT CENTER"
//
// A real irregular-history fixture — NYC HRA, PIN base "06907P0017CNV", "Scatter Site
// Housing"/"PLWA" supportive-housing renewals (Harlem Congregations for Community Improvement,
// Inc.), six Award notices with gaps of 1014/1527/292/261/381 days. Every individual gap is
// already >= CADENCE_MIN_GAP_DAYS (min 261), so this specifically exercises the
// CADENCE_MAX_GAP_RATIO guard (1527/261 = 5.85, over the 4x ceiling) in isolation, not the
// separate min-gap guard the synthetic "same-round correction" case below covers:
//   $ curl -s ".../dg92-zbpx.json?\$where=pin%20LIKE%20'06907P0017CNV%25'%20AND%20agency_name='Dept.%20of%20Social%20Svcs%2FHuman%20Resources%20Administration'&\$order=start_date%20ASC"
//
// A quarterly (~91-day) fixture is CONSTRUCTED, not live-pulled: a broad live search (650+
// same-PIN and renewal-suffix chains scanned across agencies) turned up no real chain
// averaging a 60-120 day gap with a consistent ratio — NYC's own renewal-suffix convention is
// overwhelmingly annual-or-longer option-year cycles, not quarterly recompetes. Marked
// synthetic below rather than mislabeled as observed.
//
//   node --test test/cadence_estimate.test.mjs   (from the crol-list/ dir)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(ROOT, "index.html"), "utf8");
const i18nSrc = readFileSync(join(ROOT, "i18n.js"), "utf8");

function extractFn(name) {
  let start = src.indexOf("async function " + name + "(");
  if (start === -1) start = src.indexOf("function " + name + "(");
  assert.notEqual(start, -1, `function ${name} not found in index.html`);
  let depth = 0, seen = false;
  for (let j = src.indexOf("{", start); j < src.length; j++) {
    if (src[j] === "{") { depth++; seen = true; }
    else if (src[j] === "}" && --depth === 0 && seen) return src.slice(start, j + 1);
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}
function extractConst(name) {
  const m = src.match(new RegExp(`^const ${name} = .*$`, "m"));
  assert.ok(m, `const ${name} not found`);
  return m[0] + "\n";
}

const windowStub = { LANG: "en", LANG_META: { en: { intlDate: "en-US" } } };
const { t, tn } = new Function("window", i18nSrc + "\nreturn { t: window.t, tn: window.tn };")(windowStub);

const { isBlanketChain, cadenceEstimate, cadenceMonthYear, cadenceApart, cadenceHTML } = new Function(
  "t", "tn", "window",
  extractFn("daysBetween") +
  extractConst("CADENCE_MIN_AWARDS") + extractConst("CADENCE_MIN_GAP_DAYS") + extractConst("CADENCE_MAX_GAP_RATIO") +
  extractConst("CADENCE_YEAR_THRESHOLD_MONTHS") +
  extractFn("isBlanketChain") + extractFn("cadenceEstimate") + extractFn("cadenceMonthYear") +
  extractFn("cadenceApart") + extractFn("cadenceHTML") +
  "return { isBlanketChain, cadenceEstimate, cadenceMonthYear, cadenceApart, cadenceHTML };"
)(t, tn, windowStub);

// Real DOC "Inmate Phone System" renewal chain — see file header for the live query.
const inmatePhoneChain = [
  { request_id: "20211028125", pin: "07219P0148001R002", start_date: "2021-11-03", type_of_notice_description: "Award", short_title: "Inmate Phone System - Renewal #2", contract_amount: "2250000", vendor_name: "Securus Technologies LLC" },
  { request_id: "20220811115", pin: "07219P0148001R003", start_date: "2022-08-17", type_of_notice_description: "Award", short_title: "Inmate Phone Systems", contract_amount: "3000000", vendor_name: "Securus Technologies LLC" },
  { request_id: "20230414106", pin: "07219P0148001R004", start_date: "2023-04-20", type_of_notice_description: "Award", short_title: "Inmate Phone System - Renewal No. 4", contract_amount: "5395600", vendor_name: "Securus Technologies LLC" },
];

// Real Sanitation blanket-code chain — 6 (of 21) simultaneous same-day awards to different
// vendors, PIN "82714CC00040".
const blanketChain = [
  { request_id: "20140226007", pin: "82714CC00040", start_date: "2014-02-28", type_of_notice_description: "Award", short_title: "Demolition and carting services", contract_amount: "117636.5", vendor_name: "Abruzzi Contracting Inc." },
  { request_id: "20140226013", pin: "82714CC00040", start_date: "2014-02-28", type_of_notice_description: "Award", short_title: "Demolition and carting services", contract_amount: "12312", vendor_name: "Statewide Demolition Corp." },
  { request_id: "20140226004", pin: "82714CC00040", start_date: "2014-02-28", type_of_notice_description: "Award", short_title: "Demolition and carting services", contract_amount: "13500", vendor_name: "Cliffco II, Inc." },
  { request_id: "20140226019", pin: "82714CC00040", start_date: "2014-02-28", type_of_notice_description: "Award", short_title: "Demolition and carting services", contract_amount: "14850", vendor_name: "Gpd 90 Services Inc." },
  { request_id: "20140226012", pin: "82714CC00040", start_date: "2014-02-28", type_of_notice_description: "Award", short_title: "Demolition and carting services", contract_amount: "11970", vendor_name: "JRM Construction Corp." },
  { request_id: "20140226016", pin: "82714CC00040", start_date: "2014-02-28", type_of_notice_description: "Award", short_title: "Demolition and carting services", contract_amount: "12150", vendor_name: "Paul Toth Excavation, Inc." },
];

// Real Dept for the Aging renewal chain — 730/719-day gaps, crosses the year threshold.
const agingMultiYearChain = [
  { request_id: "20220630118", pin: "12522P0001001", start_date: "2022-07-06", type_of_notice_description: "Award", short_title: "PROVIDE OLDER ADULT CENTER SERVICES", contract_amount: "542461", vendor_name: "Crown Heights Preservation Committee Corp." },
  { request_id: "20240628111", pin: "12522P0001001R002", start_date: "2024-07-05", type_of_notice_description: "Award", short_title: "OLDER ADULT CENTERS", contract_amount: "558749", vendor_name: "Crown Heights Preservation Committee Corp." },
  { request_id: "20260617014", pin: "12522P0001001R004", start_date: "2026-06-24", type_of_notice_description: "Award", short_title: "OLDER ADULT CENTER", contract_amount: "738202", vendor_name: "Crown Heights Preservation Committee Corp." },
];

// Real HRA scatter-site supportive-housing renewal chain — every gap individually clears
// CADENCE_MIN_GAP_DAYS (min 261) but the ratio between the widest and narrowest gap (5.85x)
// blows past CADENCE_MAX_GAP_RATIO, isolating that guard from the separate min-gap guard.
const socialServicesIrregularChain = [
  { request_id: "20110113010", pin: "06907P0017CNVR002", start_date: "2011-01-21", type_of_notice_description: "Award", short_title: "SCATTER SITE HOUSING", contract_amount: "5123751", vendor_name: "Harlem Congregations for Community Improvement, Inc." },
  { request_id: "20131017012", pin: "06907P0017CNVR003", start_date: "2013-10-31", type_of_notice_description: "Award", short_title: "SCATTER SITE 1 HOUSING AND SERVICES FOR HIV AIDS/FAMILY", contract_amount: "5123751", vendor_name: "HARLEM CONGREGATIONS FOR COMMUNITY IMPROVEMENT, INC" },
  { request_id: "20171227009", pin: "06907P0017CNVN001", start_date: "2018-01-05", type_of_notice_description: "Award", short_title: "NON-EMERGENCY SCATTER SITE HOUSING AND SUPPORTIVE SERVICES FOR PLWAS", contract_amount: "1848559", vendor_name: "Harlem Congregations for Community Improvement Inc." },
  { request_id: "20181016002", pin: "06907P0017CNVN002", start_date: "2018-10-24", type_of_notice_description: "Award", short_title: "NON EMERGENCY SCATTER SITE HOUSING AND SUPPORT SERVICES FOR PLWA'S - 60 UNITS", contract_amount: "1931963", vendor_name: "Harlem Congregations for Community Improvement, Inc." },
  { request_id: "20190708008", pin: "06907P0017CNVN003", start_date: "2019-07-12", type_of_notice_description: "Award", short_title: "PROVISION OF NON-EMERGENCY SCATTER-HOUSING AND SUPPORT FOR PLWAS - 60 UNITS", contract_amount: "1978597", vendor_name: "Harlem Congregations for Community Improvement Inc." },
  { request_id: "20200720114", pin: "06907P0017CNVN004", start_date: "2020-07-27", type_of_notice_description: "Award", short_title: "Non-Emergency Scatter-Housing and Support for PLWAs - 60 Units", contract_amount: "2006903", vendor_name: "Harlem Congregations for Community Improvement Inc." },
];

// Constructed (not live-pulled) quarterly chain — see file header for why. Three Award notices
// exactly 91 days apart.
const quarterlyChain = [
  { request_id: "Q1", pin: "TESTPIN0001", start_date: "2020-01-01", type_of_notice_description: "Award", short_title: "Quarterly janitorial services", contract_amount: "50000", vendor_name: "Test Vendor LLC" },
  { request_id: "Q2", pin: "TESTPIN0001R002", start_date: "2020-04-01", type_of_notice_description: "Award", short_title: "Quarterly janitorial services", contract_amount: "50000", vendor_name: "Test Vendor LLC" },
  { request_id: "Q3", pin: "TESTPIN0001R003", start_date: "2020-07-01", type_of_notice_description: "Award", short_title: "Quarterly janitorial services", contract_amount: "50000", vendor_name: "Test Vendor LLC" },
];

test("cadenceEstimate: real 3-cycle chain (DOC Inmate Phone System) — count, avg months, projected next date", () => {
  const est = cadenceEstimate(inmatePhoneChain);
  assert.ok(est, "expected a cadence estimate from a real 3-award chain");
  assert.equal(est.count, 3);
  // gaps: 2021-11-03 -> 2022-08-17 = 287 days; 2022-08-17 -> 2023-04-20 = 246 days; avg 266.5
  // days, rounded to 267 -> 2023-04-20 + 267 days
  assert.equal(est.avgMonths, 9);
  assert.equal(est.nextDate.toISOString().slice(0, 10), "2024-01-12");
});

test("cadenceHTML: states the cadence plainly, with its basis, labeled as an estimate", () => {
  const html = cadenceHTML(cadenceEstimate(inmatePhoneChain));
  assert.match(html, /3 prior awards/);
  assert.match(html, /about 9 months apart/);
  assert.match(html, /Next solicitation expected around Jan 2024/);
  assert.match(html, /class="tag renewal">Estimate<\/span>/);
});

test("cadenceEstimate: before this card there was no way to answer this from a 2-award chain — returns null (insufficient evidence, never guess)", () => {
  assert.equal(cadenceEstimate(inmatePhoneChain.slice(0, 2)), null);
});

test("cadenceEstimate: a single-notice chain has no cadence to report", () => {
  assert.equal(cadenceEstimate([inmatePhoneChain[0]]), null);
});

test("isBlanketChain: real Sanitation blanket-PIN chain (5 same-day awards) is recognized as a blanket code", () => {
  assert.equal(isBlanketChain(blanketChain), true);
});

test("cadenceEstimate: refuses the blanket-PIN chain rather than reporting a nonsense same-day cadence", () => {
  assert.equal(cadenceEstimate(blanketChain), null);
});

test("cadenceHTML: renders nothing when there is no estimate", () => {
  assert.equal(cadenceHTML(null), "");
});

test("cadenceEstimate: a wildly inconsistent gap pattern is not averaged into a false cadence", () => {
  const erratic = [
    { start_date: "2018-01-01", type_of_notice_description: "Award" },
    { start_date: "2018-03-01", type_of_notice_description: "Award" }, // 59 days later
    { start_date: "2023-06-01", type_of_notice_description: "Award" }, // ~1918 days later
  ];
  assert.equal(cadenceEstimate(erratic), null);
});

test("cadenceEstimate: a same-round correction (gap under a month) is not mistaken for a rebid cycle", () => {
  const correction = [
    { start_date: "2020-01-01", type_of_notice_description: "Award" },
    { start_date: "2020-01-15", type_of_notice_description: "Award" }, // 14 days — a correction, not a renewal
    { start_date: "2021-01-01", type_of_notice_description: "Award" },
  ];
  assert.equal(cadenceEstimate(correction), null);
});

test("cadenceMonthYear: formats a Date as month/year in the active locale", () => {
  assert.equal(cadenceMonthYear(new Date("2027-03-15")), "Mar 2027");
});

test("cadenceEstimate: quarterly cadence (91-day gaps) — reports in months, not years", () => {
  const est = cadenceEstimate(quarterlyChain);
  assert.ok(est, "expected a cadence estimate from a real 3-award chain");
  assert.equal(est.count, 3);
  assert.equal(est.avgMonths, 3);
  assert.equal(est.nextDate.toISOString().slice(0, 10), "2020-09-30");
});

test("cadenceHTML: quarterly cadence renders in months (\"about 3 months apart\"), below the year threshold", () => {
  const html = cadenceHTML(cadenceEstimate(quarterlyChain));
  assert.match(html, /about 3 months apart/);
  assert.doesNotMatch(html, /years? apart/);
});

test("cadenceEstimate: real multi-year chain (Dept for the Aging, 730/719-day gaps) — reports both avgMonths and avgYears", () => {
  const est = cadenceEstimate(agingMultiYearChain);
  assert.ok(est, "expected a cadence estimate from a real 3-award chain");
  assert.equal(est.count, 3);
  // gaps: 2022-07-06 -> 2024-07-05 = 730 days; 2024-07-05 -> 2026-06-24 = 719 days; avg 724.5
  // days = 24 rounded months (>= CADENCE_YEAR_THRESHOLD_MONTHS) = 2 rounded years
  assert.equal(est.avgMonths, 24);
  assert.equal(est.avgYears, 2);
  assert.equal(est.nextDate.toISOString().slice(0, 10), "2028-06-18");
});

test("cadenceHTML: multi-year cadence renders in years (\"about 2 years apart\"), not raw months", () => {
  const html = cadenceHTML(cadenceEstimate(agingMultiYearChain));
  assert.match(html, /3 prior awards/);
  assert.match(html, /about 2 years apart/);
  assert.doesNotMatch(html, /24 months/);
  assert.match(html, /Next solicitation expected around Jun 2028/);
});

test("cadenceApart: exactly at CADENCE_YEAR_THRESHOLD_MONTHS switches to years, one month under stays in months", () => {
  assert.equal(cadenceApart({ avgMonths: 23, avgYears: 2 }), "about 23 months apart");
  assert.equal(cadenceApart({ avgMonths: 24, avgYears: 2 }), "about 2 years apart");
});

test("cadenceEstimate: real irregular-history chain (HRA scatter-site renewals) — the max/min gap ratio guard renders nothing", () => {
  // Every individual gap already clears CADENCE_MIN_GAP_DAYS (min 261 days) — this chain is
  // refused specifically because the widest gap (1527 days) is 5.85x the narrowest (261 days),
  // over CADENCE_MAX_GAP_RATIO, not because any single gap looks like a same-round correction.
  assert.equal(cadenceEstimate(socialServicesIrregularChain), null);
});
