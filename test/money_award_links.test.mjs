// Solicitation to award link, published for every City Record solicitation since 2023-01-01.
// Run: node --test test/money_award_links.test.mjs
//
// Fixtures in test/fixtures/award-links are real City Record Online (dg92-zbpx) rows captured
// 2026-11-17T07:30Z, limited to the published field set: 13 solicitations and the 11 award notices
// on their PIN stems, plus one award each for two agencies that must read as award-publishing.
// Cases the live data does not contain (an award under another agency, more awards than the
// published cap, a differently spaced agency name) are built inline and marked synthetic.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  MONEY_AWARD_LINKS_AWARD_FIELDS,
  MONEY_AWARD_LINKS_MAX_AWARDS_PER_NOTICE,
  MONEY_AWARD_LINKS_OTHER_AWARDS_LABEL,
  MONEY_AWARD_LINKS_REASONS,
  MONEY_AWARD_LINKS_RULE_VERSION,
  MONEY_AWARD_LINKS_SCHEMA,
  MONEY_AWARD_LINKS_SOLICITATION_FIELDS,
  MONEY_AWARD_LINKS_STATES,
  buildMoneyAwardLinksSnapshot,
  fetchMoneyAwardLinksInputs,
  linkSolicitationsToAwards,
  moneyAwardLinksCountQuery,
  moneyAwardLinksQuery,
  normalizePin,
  pinShape,
  solicitationStem,
  splitAwardPin,
} from "../tools/lib/money_award_links.mjs";
import { buildMoneyAwardLinks } from "../tools/build_money_award_links.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(ROOT, "test", "fixtures", "award-links");
const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const SOL = read(join(FIXTURE, "solicitations_raw.json"));
const AWD = read(join(FIXTURE, "awards_raw.json"));
const NOW = new Date("2026-11-17T07:31:00.000Z");

const snapshot = () => buildMoneyAwardLinksSnapshot(
  { solicitations: SOL, awards: AWD, solicitationCount: SOL.length, awardCount: AWD.length },
  { now: NOW },
);
const byId = (snap, id) => snap.solicitations.find((row) => row.request_id === id);

test("PIN helpers read the stem, the sequence, the renewal suffix and the shape", () => {
  assert.equal(normalizePin(" 85724b0047 "), "85724B0047");
  assert.equal(solicitationStem("85724B0047"), "85724B0047");
  assert.equal(solicitationStem("85724B0047001"), null);
  assert.equal(solicitationStem("2019OPARFQ01"), null);
  assert.deepEqual(splitAwardPin("85724B0047001"), { stem: "85724B0047", tail: "001", recognised: true });
  assert.deepEqual(splitAwardPin("07122P0023001R001"), { stem: "07122P0023", tail: "001R001", recognised: true });
  assert.deepEqual(splitAwardPin("85724B0047"), { stem: "85724B0047", tail: "", recognised: true });
  assert.deepEqual(splitAwardPin("85723B008100"), { stem: "85723B0081", tail: "00", recognised: false });
  assert.deepEqual(splitAwardPin("85619P8208KXLR002"), { stem: "85619P8208", tail: "KXLR002", recognised: false });
  assert.equal(splitAwardPin("CWTP-2024").stem, null);
  assert.equal(pinShape(""), "none");
  assert.equal(pinShape(null), "none");
  assert.equal(pinShape("85724B0047"), "stem");
  assert.equal(pinShape("R149-SB-2024"), "other");
});

test("real capture: every solicitation is published with a state and a reason from the catalogue", () => {
  const snap = snapshot();
  assert.equal(snap.schema, MONEY_AWARD_LINKS_SCHEMA);
  assert.equal(snap.rule_version, MONEY_AWARD_LINKS_RULE_VERSION);
  assert.equal(snap.as_of, "2026-11-17");
  assert.equal(snap.count, SOL.length);
  assert.equal(snap.solicitations.length, SOL.length);
  assert.equal(snap.population.state, "complete");
  assert.deepEqual(snap.population.reasons, []);
  for (const row of snap.solicitations) {
    assert.ok(MONEY_AWARD_LINKS_STATES.includes(row.link_state), row.request_id);
    assert.ok(Object.hasOwn(MONEY_AWARD_LINKS_REASONS, row.reason), row.request_id);
    assert.equal(MONEY_AWARD_LINKS_REASONS[row.reason].state, row.link_state);
  }
});

test("linked by PIN stem: one award, vendor and amount as printed, dated after the notice", () => {
  const row = byId(snapshot(), "20221222117");
  assert.equal(row.link_state, "linked");
  assert.equal(row.reason, "linked_pin_stem");
  assert.equal(row.link_basis, "pin_stem");
  assert.equal(row.pin, "82623B0012");
  assert.equal(row.agency_id, "environmental-protection");
  assert.equal(row.cohort_year, 2023);
  assert.equal(row.solicitation_date, "2023-01-03");
  assert.equal(row.award_count, 1);
  assert.deepEqual(row.awards, [{
    source: "city_record_award_notices",
    request_id: "20230725107",
    award_date: "2023-07-31",
    date_kind: "notice_date",
    contract_pin: "82623B0012001",
    contract_number: null,
    rfq_number: null,
    vendor_name: "VITAL PLUMBING INC",
    award_amount: 985500,
  }]);
  assert.equal(row.first_award_lag_days, 209);
  assert.equal(row.response_due_date, null);
  assert.deepEqual(row.linked_award, row.awards[0]);
  assert.deepEqual(row.other_awards, []);
  assert.equal(row.other_awards_label, null);
  assert.equal(row.other_awards_omitted, 0);
});

test("multi-award: several contract PINs on one stem are all published, in date order, with each vendor as printed", () => {
  const row = byId(snapshot(), "20240130111");
  assert.equal(row.link_state, "linked");
  assert.equal(row.award_count, 2);
  assert.deepEqual(row.awards.map((a) => [a.contract_pin, a.vendor_name, a.award_amount]), [
    ["80624B0004002", "Alert Process Service LLC", 2068085],
    ["80624B0004001", "Nationwide Court Services Inc", 2579221],
  ]);
  assert.equal(row.first_award_lag_days, 224);
  assert.equal(row.response_due_date, null);
  assert.deepEqual(row.linked_award, row.awards[0]);
  assert.deepEqual(row.other_awards, [row.awards[1]]);
  assert.equal(row.other_awards_label, MONEY_AWARD_LINKS_OTHER_AWARDS_LABEL);
  assert.equal(row.other_awards_omitted, 0);
  // A renewal notice on the same contract is one more award entry, with its suffix visible.
  const renewal = byId(snapshot(), "20230119113");
  assert.deepEqual(renewal.awards.map((a) => a.contract_pin), ["07122P0023001", "07122P0023001R001"]);
});

test("linked by exact PIN when the solicitation PIN is not a bid stem", () => {
  const row = byId(snapshot(), "20240607121");
  assert.equal(row.pin_shape, "other");
  assert.equal(row.link_state, "linked");
  assert.equal(row.reason, "linked_pin_exact");
  assert.equal(row.link_basis, "pin_exact");
  assert.equal(row.award_count, 2);
});

test("not yet: a stem-shaped PIN with no award notice says so and carries no award", () => {
  const row = byId(snapshot(), "20231128108");
  assert.equal(row.link_state, "no_award_yet");
  assert.equal(row.reason, "no_award_published_yet");
  assert.equal(row.link_basis, null);
  assert.equal(row.award_count, 0);
  assert.deepEqual(row.awards, []);
  assert.equal(row.linked_award, null);
  assert.deepEqual(row.other_awards, []);
  assert.equal(row.other_awards_label, null);
  assert.equal(row.first_award_lag_days, null);
});

test("cannot be linked, with the reason: PIN shape, no PIN, agency without award notices", () => {
  const snap = snapshot();
  const shape = byId(snap, "20231220102");
  assert.equal(shape.link_state, "cannot_link");
  assert.equal(shape.reason, "pin_shape_not_joinable");
  assert.equal(shape.pin_shape, "other");
  const noPin = byId(snap, "20240202101");
  assert.equal(noPin.reason, "no_pin");
  assert.equal(noPin.pin, null);
  for (const id of ["20240102102", "20221222101"]) {
    const row = byId(snap, id);
    assert.equal(row.link_state, "cannot_link");
    assert.equal(row.reason, "agency_awards_not_in_city_record");
  }
  assert.match(MONEY_AWARD_LINKS_REASONS.pin_shape_not_joinable.text, /not in the bid-stem shape/);
});

test("award notices that predate the solicitation, or carry an unreadable contract number, are not linked", () => {
  const snap = snapshot();
  const before = byId(snap, "20240206112");
  assert.equal(before.reason, "award_before_notice");
  assert.equal(before.link_state, "cannot_link");
  assert.equal(before.award_count, 0);
  const tail = byId(snap, "20230216117");
  assert.equal(tail.reason, "award_pin_tail_unrecognised");
  assert.equal(tail.link_state, "cannot_link");
});

test("a solicitation re-posted on the same stem says how many notices share the stem", () => {
  const snap = snapshot();
  const both = snap.solicitations.filter((row) => row.pin === "85723B0048");
  assert.equal(both.length, 2);
  for (const row of both) {
    assert.equal(row.stem_solicitation_count, 2);
    assert.equal(row.link_state, "linked");
  }
  assert.equal(byId(snap, "20240607121").stem_solicitation_count, null);
});

test("synthetic: an award on the stem under another agency is not linked", () => {
  const sol = [{ request_id: "20260101001", start_date: "2026-01-02T00:00:00.000", agency_name: "Transportation", pin: "84126B0001" }];
  const awards = [
    { request_id: "20260301001", start_date: "2026-03-02T00:00:00.000", agency_name: "Transportation", pin: "84125O0001001", vendor_name: "Other Co" },
    { request_id: "20260301002", start_date: "2026-03-02T00:00:00.000", agency_name: "Parks and Recreation", pin: "84126B0001001", vendor_name: "A Vendor" },
  ];
  const { rows } = linkSolicitationsToAwards(sol, awards);
  assert.equal(rows[0].reason, "award_other_agency");
  assert.equal(rows[0].link_state, "cannot_link");
  assert.equal(rows[0].award_count, 0);
});

test("synthetic: agency names compare after trimming, spacing and case; dates compare as days", () => {
  const sol = [{ request_id: "20260101001", start_date: "2026-01-02T00:00:00.000", agency_name: "Parks  and Recreation ", pin: "84126b0001" }];
  const awards = [
    { request_id: "20260102001", start_date: "2026-01-02T00:00:00.000", agency_name: "parks and recreation", pin: "84126B0001001", contract_amount: "1,250.50", vendor_name: "  A Vendor, Inc.  " },
    { request_id: "20251231001", start_date: "2025-12-31T00:00:00.000", agency_name: "Parks and Recreation", pin: "84126B0001002", vendor_name: "Too Early LLC" },
  ];
  const { rows } = linkSolicitationsToAwards(sol, awards);
  assert.equal(rows[0].link_state, "linked");
  assert.equal(rows[0].award_count, 1);
  assert.equal(rows[0].awards[0].vendor_name, "A Vendor, Inc.");
  assert.equal(rows[0].awards[0].award_amount, 1250.5);
  assert.equal(rows[0].first_award_lag_days, 0);
});

test("synthetic: two City Record spellings of one agency are the same agency", () => {
  const sol = [{ request_id: "20260101001", start_date: "2026-01-02T00:00:00.000", agency_name: "Human Resources Administration", pin: "06926B0001" }];
  const awards = [{
    request_id: "20260301001", start_date: "2026-03-02T00:00:00.000", agency_name: "Dept. of Social Svcs/Human Resources Administration",
    pin: "06926B0001001", contract_amount: "5", vendor_name: "A Vendor",
  }];
  const { rows } = linkSolicitationsToAwards(sol, awards);
  assert.equal(rows[0].link_state, "linked");
  assert.equal(rows[0].agency_id, "human-resources-administration");
});

test("synthetic: several awards, the earliest after the printed due date is the link", () => {
  const sol = [{
    request_id: "20260101001",
    start_date: "2026-01-02T00:00:00.000",
    due_date: "2026-02-15T14:00:00.000",
    agency_name: "Transportation",
    pin: "84126B0001",
  }];
  const awards = [
    { request_id: "20260201001", start_date: "2026-02-01T00:00:00.000", agency_name: "Transportation", pin: "84126B0001001", contract_amount: "10", vendor_name: "Before Due Co" },
    { request_id: "20260215001", start_date: "2026-02-15T00:00:00.000", agency_name: "Transportation", pin: "84126B0001002", contract_amount: "20", vendor_name: "On Due Day Co" },
    { request_id: "20260301001", start_date: "2026-03-01T00:00:00.000", agency_name: "Transportation", pin: "84126B0001003", contract_amount: "30", vendor_name: "After Due Co" },
    { request_id: "20260401001", start_date: "2026-04-01T00:00:00.000", agency_name: "Transportation", pin: "84126B0001003R001", contract_amount: "40", vendor_name: "Later Co" },
  ];
  const { rows } = linkSolicitationsToAwards(sol, awards);
  assert.equal(rows[0].link_state, "linked");
  assert.equal(rows[0].award_count, 4);
  assert.equal(rows[0].response_due_date, "2026-02-15");
  assert.equal(rows[0].linked_award.vendor_name, "After Due Co");
  assert.equal(rows[0].linked_award.award_date, "2026-03-01");
  assert.deepEqual(rows[0].other_awards.map((award) => award.vendor_name), ["Before Due Co", "On Due Day Co", "Later Co"]);
  assert.equal(rows[0].other_awards_label, MONEY_AWARD_LINKS_OTHER_AWARDS_LABEL);
  assert.equal(rows[0].first_award_lag_days, 30);
});

test("synthetic: when every joined award is on or before the due date, none is the link", () => {
  const sol = [{
    request_id: "20260101001",
    start_date: "2026-01-02T00:00:00.000",
    due_date: "2026-06-01T00:00:00.000",
    agency_name: "Transportation",
    pin: "84126B0001",
  }];
  const awards = [
    { request_id: "20260201001", start_date: "2026-02-01T00:00:00.000", agency_name: "Transportation", pin: "84126B0001001", vendor_name: "Early Co" },
    { request_id: "20260301001", start_date: "2026-03-01T00:00:00.000", agency_name: "Transportation", pin: "84126B0001002", vendor_name: "Also Early Co" },
  ];
  const { rows } = linkSolicitationsToAwards(sol, awards);
  assert.equal(rows[0].link_state, "linked");
  assert.equal(rows[0].linked_award, null);
  assert.equal(rows[0].other_awards.length, 2);
  assert.equal(rows[0].other_awards_label, MONEY_AWARD_LINKS_OTHER_AWARDS_LABEL);
});

test("synthetic: one joined award stays the link even when it is not after the due date", () => {
  const sol = [{
    request_id: "20260101001",
    start_date: "2026-01-02T00:00:00.000",
    due_date: "2026-06-01T00:00:00.000",
    agency_name: "Transportation",
    pin: "84126B0001",
  }];
  const awards = [
    { request_id: "20260201001", start_date: "2026-02-01T00:00:00.000", agency_name: "Transportation", pin: "84126B0001001", vendor_name: "Only Co" },
  ];
  const { rows } = linkSolicitationsToAwards(sol, awards);
  assert.equal(rows[0].linked_award.vendor_name, "Only Co");
  assert.deepEqual(rows[0].other_awards, []);
  assert.equal(rows[0].other_awards_label, null);
});

test("synthetic: a due date the publisher did not print stays empty", () => {
  const sol = [{ request_id: "20260101001", start_date: "2026-01-02T00:00:00.000", agency_name: "Transportation", pin: "84126B0001", due_date: "" }];
  const awards = [
    { request_id: "20260201001", start_date: "2026-02-01T00:00:00.000", agency_name: "Transportation", pin: "84126B0001001", vendor_name: "First Co" },
    { request_id: "20260301001", start_date: "2026-03-01T00:00:00.000", agency_name: "Transportation", pin: "84126B0001002", vendor_name: "Second Co" },
  ];
  const { rows } = linkSolicitationsToAwards(sol, awards);
  assert.equal(rows[0].response_due_date, null);
  assert.equal(rows[0].linked_award.vendor_name, "First Co");
  assert.equal(rows[0].other_awards[0].vendor_name, "Second Co");
});

test("synthetic: more awards than the cap publish the cap and the true count", () => {
  const sol = [{ request_id: "20260101001", start_date: "2026-01-02T00:00:00.000", agency_name: "Citywide Administrative Services", pin: "85726B0099" }];
  const awards = Array.from({ length: MONEY_AWARD_LINKS_MAX_AWARDS_PER_NOTICE + 5 }, (_, i) => ({
    request_id: `2026030${String(i).padStart(4, "0")}`.slice(0, 11),
    start_date: "2026-03-02T00:00:00.000",
    agency_name: "Citywide Administrative Services",
    pin: `85726B0099${String(i + 1).padStart(3, "0")}`,
    contract_amount: "100",
    vendor_name: `Vendor ${i}`,
  }));
  const { rows } = linkSolicitationsToAwards(sol, awards);
  assert.equal(rows[0].award_count, MONEY_AWARD_LINKS_MAX_AWARDS_PER_NOTICE + 5);
  assert.equal(rows[0].awards.length, MONEY_AWARD_LINKS_MAX_AWARDS_PER_NOTICE);
});

test("coverage: totals, cohort years and agencies each add up to the published rows", () => {
  const snap = snapshot();
  const { totals, by_cohort_year: years, by_agency: agencies } = snap.coverage;
  assert.equal(totals.solicitations, SOL.length);
  assert.equal(totals.linked + totals.no_award_yet + totals.cannot_link, SOL.length);
  assert.equal(totals.linked, totals.linked_pin_stem + totals.linked_pin_exact);
  assert.equal(Object.values(totals.by_reason).reduce((a, b) => a + b, 0), SOL.length);
  assert.equal(Object.values(years).reduce((n, y) => n + y.solicitations, 0), SOL.length);
  assert.equal(agencies.reduce((n, a) => n + a.solicitations, 0), SOL.length);
  assert.deepEqual(Object.keys(years), ["2023", "2024"]);
  assert.equal(years["2023"].stem_shaped, 5);
  assert.equal(totals.linked_pct_of_stem_shaped, Math.round((1000 * totals.linked_pin_stem) / totals.stem_shaped) / 10);
  assert.deepEqual(Object.keys(totals.by_reason).sort(), Object.keys(MONEY_AWARD_LINKS_REASONS).sort());
});

test("the published rows hold no contact fields, no markup and only declared keys", () => {
  const snap = snapshot();
  const text = JSON.stringify(snap);
  assert.doesNotMatch(text, /contact_|"email"|phone|vendor_address/);
  assert.doesNotMatch(JSON.stringify(snap.solicitations), /[<>]/);
  const rowKeys = [
    "request_id", "pin", "agency_name", "agency_id", "cohort_year", "solicitation_date",
    "response_due_date", "pin_shape", "stem_solicitation_count", "rfq_numbers", "rfq_solicitation_count",
    "link_state", "reason", "link_basis", "award_count", "first_award_lag_days", "awards",
    "linked_award", "other_awards", "other_awards_label", "other_awards_omitted",
  ].sort();
  for (const row of snap.solicitations) assert.deepEqual(Object.keys(row).sort(), rowKeys);
  assert.deepEqual(MONEY_AWARD_LINKS_SOLICITATION_FIELDS, ["request_id", "start_date", "agency_name", "pin", "due_date"]);
  assert.equal(MONEY_AWARD_LINKS_AWARD_FIELDS.includes("email"), false);
});

test("a short pull is published marked incomplete with its reason, never as complete", () => {
  const snap = buildMoneyAwardLinksSnapshot(
    { solicitations: SOL, awards: AWD, solicitationCount: SOL.length + 4, awardCount: AWD.length },
    { now: NOW },
  );
  assert.equal(snap.population.state, "incomplete");
  assert.deepEqual(snap.population.reasons, ["solicitation_count_mismatch"]);
  const capped = buildMoneyAwardLinksSnapshot(
    { solicitations: SOL, awards: AWD, solicitationCount: SOL.length, awardCount: AWD.length },
    { now: NOW, maxRows: 5 },
  );
  assert.equal(capped.population.state, "incomplete");
  assert.deepEqual(capped.population.reasons, ["row_cap"]);
  assert.equal(capped.count, 5);
});

test("an artifact over its byte bound is refused so the last good file stays", () => {
  assert.throws(
    () => buildMoneyAwardLinksSnapshot(
      { solicitations: SOL, awards: AWD, solicitationCount: SOL.length, awardCount: AWD.length },
      { now: NOW, maxBytes: 2000 },
    ),
    /exceeds the 2000-byte bound; last good artifact retained/,
  );
});

test("queries select only the published fields, from 2023-01-01, procurement section only", () => {
  const s = moneyAwardLinksQuery("Solicitation", { limit: 10 });
  const a = moneyAwardLinksQuery("Award", { limit: 10 });
  assert.equal(s.$select, "request_id,start_date,agency_name,pin,due_date");
  assert.equal(a.$select, "request_id,start_date,agency_name,pin,contract_amount,vendor_name");
  assert.match(s.$where, /type_of_notice_description='Solicitation'/);
  assert.match(a.$where, /type_of_notice_description='Award'/);
  assert.match(a.$where, /section_name='Procurement' AND .*start_date>='2023-01-01T00:00:00'/);
  assert.equal(s.$limit, "10");
  assert.equal(moneyAwardLinksCountQuery("Award").$select, "count(*) AS n");
});

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test("a failed or empty pull throws before anything is published", async () => {
  const log = () => {};
  const failing = async () => jsonResponse({ error: true, message: "boom" }, 200);
  await assert.rejects(fetchMoneyAwardLinksInputs(failing, { log }), /SODA error/);
  const http = async () => jsonResponse([], 500);
  await assert.rejects(fetchMoneyAwardLinksInputs(http, { log, retry: { maxAttempts: 1 } }), /HTTP 500/);
  const empty = async (url) => jsonResponse(String(url).includes("count") || String(url).includes("count%28") ? [{ n: "0" }] : []);
  await assert.rejects(fetchMoneyAwardLinksInputs(empty, { log }), /no rows; last good artifact retained/);
});

test("a good pull reads counts, then one page of each notice type", async () => {
  const log = () => {};
  const calls = [];
  const ok = async (url) => {
    const text = decodeURIComponent(String(url));
    calls.push(text);
    if (text.includes("count(*)")) return jsonResponse([{ n: text.includes("'Award'") ? String(AWD.length) : String(SOL.length) }]);
    return jsonResponse(text.includes("'Award'") ? AWD : SOL);
  };
  const inputs = await fetchMoneyAwardLinksInputs(ok, { log });
  assert.equal(inputs.solicitationCount, SOL.length);
  assert.equal(inputs.awardCount, AWD.length);
  assert.equal(calls.length, 4);
  assert.ok(calls.every((url) => url.startsWith("https://data.cityofnewyork.us/resource/dg92-zbpx.json?")));
});

test("the offline build reads the fixtures through the build entry point", async () => {
  const snap = await buildMoneyAwardLinks({ fixture: true, now: NOW });
  assert.equal(snap.count, SOL.length + read(join(FIXTURE, "nycha_solicitations_raw.json")).length);
  assert.equal(snap.population.state, "complete");
});

// The committed artifact changes on every refresh. These checks pin invariants, never the counts.
const COMMITTED = join(ROOT, "site", "data", "money_award_links.json");
test("committed artifact: consistent with its own rule", { skip: !existsSync(COMMITTED) }, () => {
  const art = read(COMMITTED);
  assert.equal(art.schema, MONEY_AWARD_LINKS_SCHEMA);
  assert.equal(art.rule_version, MONEY_AWARD_LINKS_RULE_VERSION);
  assert.match(art.as_of, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(art.generated_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(art.count, art.solicitations.length);
  assert.equal(art.population.state, "complete");
  assert.equal(art.coverage.totals.solicitations, art.count);
  const ids = new Set();
  for (const row of art.solicitations) {
    assert.ok(!ids.has(row.request_id));
    ids.add(row.request_id);
    assert.equal(MONEY_AWARD_LINKS_REASONS[row.reason]?.state, row.link_state, row.request_id);
    assert.ok(row.solicitation_date >= "2023-01-01");
    const listed = (row.linked_award ? 1 : 0) + row.other_awards.length + row.other_awards_omitted;
    assert.equal(listed, row.award_count, row.request_id);
    if (row.other_awards.length) assert.equal(row.other_awards_label, MONEY_AWARD_LINKS_OTHER_AWARDS_LABEL);
    else assert.equal(row.other_awards_label, null);
    if (row.link_state === "linked") {
      assert.ok(row.awards.length >= 1 && row.award_count >= row.awards.length, row.request_id);
      for (const award of row.awards) {
        assert.ok(award.award_date >= row.solicitation_date, row.request_id);
        if (award.source === "city_record_award_notices") assert.ok(award.contract_pin && award.request_id, row.request_id);
        else assert.ok(award.contract_number && award.request_id === null, row.request_id);
        if (row.link_basis === "pin_stem") assert.ok(award.contract_pin.startsWith(row.pin), row.request_id);
      }
      if (row.award_count === 1) assert.deepEqual(row.linked_award, row.awards[0]);
      if (!row.response_due_date && row.awards.length) assert.deepEqual(row.linked_award, row.awards[0]);
      if (row.response_due_date && row.linked_award) {
        assert.ok(row.linked_award.award_date > row.response_due_date, row.request_id);
      }
    } else {
      assert.equal(row.award_count, 0);
      assert.deepEqual(row.awards, []);
      assert.equal(row.linked_award, null);
      assert.deepEqual(row.other_awards, []);
      assert.equal(row.link_basis, null);
    }
  }
});
