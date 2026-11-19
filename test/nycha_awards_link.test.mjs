// NYCHA solicitations linked to NYCHA's own Awarded Contracts list, by RFQ number.
// Run: node --test test/nycha_awards_link.test.mjs
//
// Fixtures in test/fixtures/award-links:
//   nycha_solicitations_raw.json  real City Record Online (dg92-zbpx) rows for the Housing Authority,
//                                 published field set, captured 2026-11-17T10:40Z.
//   nycha/feed-<year>.json        real rows of NYCHA's Awarded Contracts feed, same capture, in the
//                                 feed's own shape, limited to the RFQ numbers the solicitations hold
//                                 plus one "N/A" and one "304842,3" row. Description is blanked: it
//                                 names staff and is not retained.
//   nycha_snapshot_live.json      what the acquisition retains from those pulls (re-derived below).
//   nycha-synthetic-changed-shape/  synthetic: real 2024 and 2025 rows with the amount column renamed and
//                                 the data array renamed, and a challenge-style page.
// Cases the live data does not contain (a contract that started before the notice, an outage) are built
// inline and marked synthetic.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  NYCHA_FALLBACK_REASONS,
  NYCHA_REQUIRED_FIELDS,
  NYCHA_SNAPSHOT_MAX_AGE_DAYS,
  NYCHA_SNAPSHOT_SCHEMA,
  acquireNychaAwardedContracts,
  checkNychaFeedShape,
  nychaDay,
  nychaFeedUrl,
  nychaFeedYears,
  nychaSnapshotUse,
  normalizeNychaRows,
  rfqNumberOf,
} from "../tools/lib/nycha_awarded_contracts.mjs";
import {
  MONEY_AWARD_LINKS_REASONS,
  buildMoneyAwardLinksSnapshot,
  linkSolicitationsToAwards,
  pinRfqNumbers,
} from "../tools/lib/money_award_links.mjs";
import { buildMoneyAwardLinks, readNychaSnapshot } from "../tools/build_money_award_links.mjs";
import { runAcquisition } from "../tools/acquire_nycha_awarded_contracts.mjs";
import { withTempDir } from "../tools/lib/with_temp_dir.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(ROOT, "test", "fixtures", "award-links");
const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const NOW = new Date("2026-11-17T10:45:00.000Z");
const NYCHA_SOL = read(join(FIXTURE, "nycha_solicitations_raw.json"));
const AWD = read(join(FIXTURE, "awards_raw.json"));
const SNAP = read(join(FIXTURE, "nycha_snapshot_live.json"));
const feedBody = (year) => read(join(FIXTURE, "nycha", `feed-${year}.json`));
const feedBuffer = (year) => readFileSync(join(FIXTURE, "nycha", `feed-${year}.json`));
const FIXTURE_YEARS = nychaFeedYears(NOW);

const okResponse = (buffer) => ({
  ok: true,
  status: 200,
  arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length),
});
const yearOf = (url) => new URL(url).searchParams.get("ContractYear");
const fixtureFetch = (calls = []) => async (url) => {
  calls.push(url);
  return okResponse(feedBuffer(yearOf(url)));
};
const noSleep = { sleep: async () => {}, delayMs: 0, minRows: 5 };

const built = (nychaSnapshot = SNAP, solicitations = NYCHA_SOL) => buildMoneyAwardLinksSnapshot(
  { solicitations, awards: AWD, solicitationCount: solicitations.length, awardCount: AWD.length, nychaSnapshot },
  { now: NOW },
);
const byId = (snap, id) => snap.solicitations.find((row) => row.request_id === id);

test("RFQ number helpers read the leading number, the date, and the numbers in a PIN", () => {
  assert.equal(rfqNumberOf("304842,3"), "304842");
  assert.equal(rfqNumberOf("304842-2,3"), "304842");
  assert.equal(rfqNumberOf("304842"), "304842");
  assert.equal(rfqNumberOf(" 99999 "), "99999");
  assert.equal(rfqNumberOf("N/A"), null);
  assert.equal(rfqNumberOf(""), null);
  assert.equal(rfqNumberOf("RFP 304842"), null);
  assert.equal(rfqNumberOf("1234"), null);
  assert.equal(rfqNumberOf("12345678"), null);
  assert.equal(rfqNumberOf(null), null);
  assert.equal(nychaDay("04/30/2024"), "2024-04-30");
  assert.equal(nychaDay("13/40/2024"), "");
  assert.equal(nychaDay("2024-04-30"), "");
  assert.deepEqual(pinRfqNumbers("503336, 503337, 5033"), ["503336", "503337"]);
  assert.deepEqual(pinRfqNumbers("502112-3"), ["502112"]);
  assert.deepEqual(pinRfqNumbers("510392/510393"), ["510392", "510393"]);
  assert.deepEqual(pinRfqNumbers("RFQ 387932"), ["387932"]);
  assert.deepEqual(pinRfqNumbers("PROP/TERR 23-24"), []);
  assert.deepEqual(pinRfqNumbers("85724B0047"), []);
  assert.deepEqual(pinRfqNumbers(undefined), []);
  assert.equal(nychaFeedUrl(2024), "https://my.nycha.info/PublicSite/Transparency/GetAwardedContracts?ContractYear=2024");
  assert.deepEqual(nychaFeedYears(NOW), [2023, 2024, 2025, 2026, 2027]);
});

test("acquisition: a good pull is checked, retained with size and sha256 per year, and sets no fallback", async () => {
  const calls = [];
  const sleeps = [];
  const snap = await acquireNychaAwardedContracts({
    fetchImpl: fixtureFetch(calls),
    now: NOW,
    minRows: 5,
    sleep: async (ms) => { sleeps.push(ms); },
    delayMs: 2000,
  });
  assert.equal(snap.schema, NYCHA_SNAPSHOT_SCHEMA);
  assert.equal(snap.feed.state, "live");
  assert.equal(snap.feed.fallback_reason, null);
  assert.deepEqual(snap.feed.shape_problems, []);
  assert.equal(calls.length, FIXTURE_YEARS.length);
  assert.deepEqual(sleeps, [2000, 2000, 2000, 2000], "one request at a time with a pause between");
  for (const entry of snap.feed.years) {
    assert.equal(entry.bytes, feedBuffer(entry.year).length);
    assert.match(entry.sha256, /^[0-9a-f]{64}$/);
    assert.equal(entry.row_count, feedBody(entry.year).data.length);
  }
  assert.equal(snap.count, snap.rows.length);
  assert.equal(snap.rfq_numbered_count, snap.rows.filter((row) => row.rfq_number).length);
  assert.deepEqual(snap, SNAP, "the committed snapshot fixture is what the code retains from the raw pulls");
});

test("retained rows keep only the fields the join needs: no description, location, spend or staff names", () => {
  const rows = SNAP.rows;
  assert.ok(rows.length > 10);
  const keys = ["contract_number", "rfq_number_printed", "rfq_number", "vendor_name", "total_amount", "start_date", "contract_year", "procurement_method", "contract_status"].sort();
  for (const row of rows) assert.deepEqual(Object.keys(row).sort(), keys);
  const text = JSON.stringify(SNAP);
  assert.doesNotMatch(text, /Description|Location|AmountSpent|RFQTitle|PROCUR\d/);
  const n304842 = rows.find((row) => row.rfq_number_printed === "304842,3");
  assert.equal(n304842.rfq_number, "304842");
  const na = rows.find((row) => row.rfq_number_printed === "N/A");
  assert.equal(na.rfq_number, null);
  for (let i = 1; i < rows.length; i += 1) {
    assert.ok(`${rows[i - 1].start_date}|${rows[i - 1].contract_number}` <= `${rows[i].start_date}|${rows[i].contract_number}`);
  }
});

const pulls = () => FIXTURE_YEARS.map((year) => ({ year, body: structuredClone(feedBody(year)) }));

test("shape check passes the real pulls and names each way a changed feed fails", () => {
  assert.deepEqual(checkNychaFeedShape(pulls(), { now: NOW, minRows: 5 }), { ok: true, problems: [] });

  // synthetic: a field renamed, a body that is not {data: []}, a year that stopped matching, an RFQ column that changed.
  const renamed = pulls();
  for (const row of renamed[1].body.data) { row.Total = row.TotalAmount; delete row.TotalAmount; }
  let check = checkNychaFeedShape(renamed, { now: NOW, minRows: 5 });
  assert.equal(check.ok, false);
  assert.match(check.problems.join("|"), /TotalAmount is missing/);

  const wrapped = pulls();
  wrapped[0].body = { results: wrapped[0].body.data };
  check = checkNychaFeedShape(wrapped, { now: NOW, minRows: 5 });
  assert.match(check.problems.join("|"), /not an object with a data array/);

  const wrongYear = pulls();
  wrongYear[2].body.data[0].ContractYear = "2019";
  assert.match(checkNychaFeedShape(wrongYear, { now: NOW, minRows: 5 }).problems.join("|"), /ContractYear has an unexpected value/);

  const badDate = pulls();
  badDate[0].body.data[0].StartDateDisplay = "2023-09-21";
  assert.match(checkNychaFeedShape(badDate, { now: NOW, minRows: 5 }).problems.join("|"), /StartDateDisplay has an unexpected value/);

  const rfq = pulls();
  for (const pull of rfq) for (const row of pull.body.data) if (row.RFQNumber !== "N/A") row.RFQNumber = `RFQ-${row.RFQNumber}-X`;
  assert.match(checkNychaFeedShape(rfq, { now: NOW, minRows: 5 }).problems.join("|"), /RFQ numbers have the 5-7 digit shape/);

  assert.match(checkNychaFeedShape(pulls(), { now: NOW }).problems.join("|"), /only 15 rows read; at least 200 expected/);
  for (const field of NYCHA_REQUIRED_FIELDS) assert.ok(field in feedBody(2023).data[0], field);
});

test("shape check holds the row count to a band around the last good snapshot and keeps closed years whole", () => {
  const previous = structuredClone(SNAP);
  previous.count = 15;
  assert.equal(checkNychaFeedShape(pulls(), { previous, now: NOW, minRows: 5 }).ok, true);
  previous.count = 40; // synthetic: the list was much longer before
  assert.match(checkNychaFeedShape(pulls(), { previous, now: NOW, minRows: 5 }).problems.join("|"), /outside the band/);
  previous.count = 15;
  previous.feed.years.find((entry) => entry.year === 2024).row_count = 20; // synthetic: a closed year lost rows
  assert.match(checkNychaFeedShape(pulls(), { previous, now: NOW, minRows: 5 }).problems.join("|"), /closed year 2024 fell from 20 to 4/);
});

const CHANGED = join(FIXTURE, "nycha-synthetic-changed-shape");

test("feed shape change: the last good rows stay in use and the snapshot says so, with the reason", async () => {
  // synthetic (nycha-synthetic-changed-shape): 2024 comes back with the amount column renamed, 2025 with the data array renamed.
  const changed = (file) => async (url) => {
    if (yearOf(url) !== file.year) return okResponse(feedBuffer(yearOf(url)));
    return okResponse(readFileSync(join(CHANGED, file.name)));
  };
  const later = new Date("2026-11-20T06:40:00.000Z");
  const snap = await acquireNychaAwardedContracts({ fetchImpl: changed({ year: "2024", name: "feed-2024.amount-column-renamed.json" }), now: later, previous: SNAP, ...noSleep });
  assert.equal(snap.feed.state, "snapshot_fallback");
  assert.equal(snap.feed.fallback_reason, "feed_shape_changed");
  assert.equal(snap.feed.fallback_text, NYCHA_FALLBACK_REASONS.feed_shape_changed);
  assert.match(snap.feed.shape_problems.join("|"), /TotalAmount is missing/);
  const envelope = await acquireNychaAwardedContracts({ fetchImpl: changed({ year: "2025", name: "feed-2025.envelope-renamed.json" }), now: later, previous: SNAP, ...noSleep });
  assert.equal(envelope.feed.fallback_reason, "feed_shape_changed");
  assert.match(envelope.feed.shape_problems.join("|"), /year 2025: body is not an object with a data array/);
  assert.equal(snap.feed.fetched_at, SNAP.feed.fetched_at, "the time the retained rows were read does not move");
  assert.equal(snap.feed.checked_at, later.toISOString());
  assert.equal(snap.as_of, "2026-11-17", "the vintage stays at the last good read");
  assert.equal(snap.generated_at, later.toISOString());
  assert.deepEqual(snap.rows, SNAP.rows);
  assert.equal(snap.count, SNAP.count);
  const use = nychaSnapshotUse(snap, "2026-11-20");
  assert.deepEqual([use.state, use.usable, use.age_days], ["snapshot_fallback", true, 3]);
  // and the published artifact says it too
  const art = built(snap);
  assert.equal(art.nycha_feed.state, "snapshot_fallback");
  assert.equal(art.nycha_feed.fallback_reason, "feed_shape_changed");
  assert.equal(art.population.nycha_feed_state, "snapshot_fallback");
  assert.equal(art.population.state, "complete");
  assert.equal(byId(art, "20250206001").reason, "linked_nycha_rfq", "links from the last good list still stand");
});

test("a page, an outage or a closed door never replaces the snapshot, and a challenge is not retried or worked around", async () => {
  const calls = [];
  const html = async (url) => {
    calls.push(url);
    return okResponse(readFileSync(join(FIXTURE, "nycha-synthetic-changed-shape", "challenge.html")));
  };
  let snap = await acquireNychaAwardedContracts({ fetchImpl: html, now: NOW, previous: SNAP, ...noSleep });
  assert.equal(snap.feed.fallback_reason, "feed_not_json");
  assert.equal(calls.length, 1, "no retry, no second attempt, stops at the first year");

  let attempts = 0;
  const down = async () => { attempts += 1; return { ok: false, status: 503, arrayBuffer: async () => new ArrayBuffer(0) }; };
  const sleeps = [];
  snap = await acquireNychaAwardedContracts({ fetchImpl: down, now: NOW, previous: SNAP, ...noSleep, sleep: async (ms) => { sleeps.push(ms); } });
  assert.equal(snap.feed.fallback_reason, "feed_unreachable");
  assert.equal(attempts, 3, "a server error is retried up to three times, then given up on");
  assert.equal(sleeps.length, 2);

  const forbidden = async () => ({ ok: false, status: 403, arrayBuffer: async () => new ArrayBuffer(0) });
  attempts = 0;
  snap = await acquireNychaAwardedContracts({ fetchImpl: async (...args) => { attempts += 1; return forbidden(...args); }, now: NOW, previous: SNAP, ...noSleep });
  assert.equal(snap.feed.fallback_reason, "feed_unreachable");
  assert.equal(attempts, 1, "a 403 is not retried");

  const boom = async () => { throw new Error("socket hang up"); };
  snap = await acquireNychaAwardedContracts({ fetchImpl: boom, now: NOW, previous: SNAP, ...noSleep });
  assert.equal(snap.feed.fallback_reason, "feed_unreachable");
  assert.deepEqual(snap.rows, SNAP.rows);
});

test("with no earlier snapshot a failed pull throws and nothing is written", async () => {
  const html = async () => okResponse(Buffer.from("<html></html>"));
  await assert.rejects(
    () => acquireNychaAwardedContracts({ fetchImpl: html, now: NOW, previous: null, ...noSleep }),
    /feed_not_json.*no earlier snapshot/,
  );
  const { readdir } = await import("node:fs/promises");
  await withTempDir("nycha-awarded-contracts-", async (dir) => {
    const out = join(dir, "snapshot.json");
    await assert.rejects(() => runAcquisition({ out, fetchImpl: html, now: NOW, ...noSleep }));
    assert.deepEqual(await readdir(dir), []);
    const ok = await runAcquisition({ out, fetchImpl: fixtureFetch(), now: NOW, ...noSleep });
    assert.equal(ok.snapshot.feed.state, "live");
    assert.deepEqual(read(out), SNAP);
    // a second run that fails keeps the rows and records the fallback in the same file
    const second = await runAcquisition({ out, fetchImpl: html, now: new Date("2026-11-18T06:40:00Z"), ...noSleep });
    assert.equal(second.snapshot.feed.state, "snapshot_fallback");
    assert.equal(read(out).feed.fallback_reason, "feed_not_json");
    assert.deepEqual(read(out).rows, SNAP.rows);
  });
});

test("a fallback snapshot older than the age limit is not used to say a notice is absent", () => {
  const old = structuredClone(SNAP);
  old.feed.state = "snapshot_fallback";
  assert.equal(nychaSnapshotUse(old, "2026-12-17").usable, true);
  assert.equal(nychaSnapshotUse(old, "2026-12-17").age_days, 30);
  assert.equal(NYCHA_SNAPSHOT_MAX_AGE_DAYS, 30);
  const stale = nychaSnapshotUse(old, "2026-12-18");
  assert.deepEqual([stale.state, stale.usable, stale.reason], ["unavailable", false, "snapshot_too_old"]);
  assert.equal(nychaSnapshotUse(null, "2026-11-17").reason, "no_snapshot");
  assert.equal(nychaSnapshotUse({ schema: "x", rows: [1] }, "2026-11-17").usable, false);

  const art = built(old);
  assert.equal(art.nycha_feed.state, "snapshot_fallback");
  const unusable = buildMoneyAwardLinksSnapshot(
    { solicitations: NYCHA_SOL, awards: AWD, solicitationCount: NYCHA_SOL.length, awardCount: AWD.length, nychaSnapshot: old },
    { now: new Date("2026-12-20T06:40:00Z") },
  );
  assert.equal(unusable.nycha_feed.usable, false);
  assert.equal(unusable.population.state, "incomplete");
  assert.deepEqual(unusable.population.reasons, ["nycha_award_list_unavailable"]);
  for (const row of unusable.solicitations) {
    assert.ok(["nycha_award_list_unavailable", "no_pin"].includes(row.reason), `${row.request_id} ${row.reason}`);
    assert.deepEqual(row.awards, []);
  }
});

test("linked: the RFQ number on the notice equals the number on a listed contract that starts after it", () => {
  const art = built();
  const row = byId(art, "20240423114");
  assert.equal(row.agency_id, "housing-authority");
  assert.equal(row.pin, "503336, 503337, 5033");
  assert.equal(row.pin_shape, "rfq");
  assert.deepEqual(row.rfq_numbers, ["503336", "503337"]);
  assert.equal(row.link_state, "linked");
  assert.equal(row.reason, "linked_nycha_rfq");
  assert.equal(row.link_basis, "nycha_rfq_number");
  assert.equal(row.award_count, 1);
  assert.equal(row.first_award_lag_days, 162);
  const [award] = row.awards;
  assert.deepEqual(Object.keys(award).sort(), [
    "award_amount", "award_date", "contract_number", "contract_pin", "date_kind", "request_id", "rfq_number", "source", "vendor_name",
  ]);
  assert.equal(award.source, "nycha_awarded_contracts");
  assert.equal(award.date_kind, "contract_start");
  assert.equal(award.request_id, null);
  assert.equal(award.contract_pin, null);
  const contract = SNAP.rows.find((c) => c.contract_number === award.contract_number);
  assert.equal(award.vendor_name, contract.vendor_name, "vendor exactly as NYCHA prints it");
  assert.equal(award.award_amount, contract.total_amount);
  assert.equal(award.award_date, contract.start_date);
  assert.ok(award.award_date >= row.solicitation_date);
});

test("linked to several contracts: all are listed in date order with their own vendors, none merged", () => {
  const row = byId(built(), "20250206001");
  assert.equal(row.reason, "linked_nycha_rfq");
  assert.equal(row.award_count, 3);
  assert.deepEqual(row.awards.map((a) => a.contract_number), ["2534200", "2534201", "2534202"].sort((a, b) => {
    const da = SNAP.rows.find((c) => c.contract_number === a).start_date;
    const db = SNAP.rows.find((c) => c.contract_number === b).start_date;
    return da.localeCompare(db) || a.localeCompare(b);
  }));
  assert.equal(new Set(row.awards.map((a) => a.vendor_name)).size, 3);
  for (const award of row.awards) assert.equal(award.rfq_number, "509312");
  const dates = row.awards.map((a) => a.award_date);
  assert.deepEqual(dates, [...dates].sort());
});

test("re-postings of one RFQ number all link to the same contracts and say how many notices share it", () => {
  const art = built();
  const ids = ["20240123110", "20240223116", "20240412113"];
  const rows = ids.map((id) => byId(art, id));
  for (const row of rows) {
    assert.equal(row.reason, "linked_nycha_rfq");
    assert.deepEqual(row.rfq_numbers, ["502112"]);
    assert.equal(row.rfq_solicitation_count, 3);
  }
  assert.deepEqual(rows[0].awards.map((a) => a.contract_number), rows[2].awards.map((a) => a.contract_number));
  assert.equal(byId(art, "20240423114").rfq_solicitation_count, 1);
});

test("not yet: a notice under a year old whose RFQ number is not on the list is no_award_yet, with the timing class", () => {
  const row = byId(built(), "20260722002");
  assert.equal(row.reason, "nycha_rfq_not_on_list_yet");
  assert.equal(row.link_state, "no_award_yet");
  assert.equal(MONEY_AWARD_LINKS_REASONS[row.reason].gap_class, "timing");
  assert.equal(row.award_count, 0);
  assert.deepEqual(row.awards, []);
  assert.equal(row.link_basis, null);
});

test("unjoinable: an old notice absent from the list, a notice with no PIN, and a PIN with no RFQ number say which", () => {
  const art = built();
  const old = byId(art, "20230202115");
  assert.equal(old.reason, "nycha_rfq_not_on_list");
  assert.equal(old.link_state, "cannot_link");
  assert.match(MONEY_AWARD_LINKS_REASONS[old.reason].text, /does not say whether the notice was awarded under another number or not awarded/);
  const none = byId(art, "20240314101");
  assert.equal(none.reason, "no_pin");
  assert.equal(none.pin_shape, "none");
  assert.deepEqual(none.rfq_numbers, []);
  const text = byId(art, "20230615138");
  assert.equal(text.reason, "nycha_pin_has_no_rfq_number");
  assert.equal(text.pin_shape, "other");
  const slash = byId(art, "20250107040");
  assert.deepEqual(slash.rfq_numbers, ["510392", "510393"]);
  assert.equal(slash.reason, "nycha_rfq_not_on_list");
  for (const row of [old, none, text, slash]) {
    assert.equal(row.award_count, 0);
    assert.deepEqual(row.awards, []);
    assert.equal(row.first_award_lag_days, null);
  }
});

test("a contract that started before the notice is not linked (synthetic: the live list has none)", () => {
  const sol = [{ request_id: "20260101001", start_date: "2026-01-10T00:00:00.000", agency_name: "Housing Authority", pin: "999001" }];
  const snap = structuredClone(SNAP);
  snap.rows.push({
    contract_number: "9990001", rfq_number_printed: "999001,2", rfq_number: "999001", vendor_name: "EXAMPLE SUPPLY CO",
    total_amount: 1000, start_date: "2025-12-01", contract_year: 2025, procurement_method: "SEALED BID", contract_status: "Active",
  });
  const art = built(snap, sol);
  assert.equal(art.solicitations[0].reason, "nycha_award_before_notice");
  assert.equal(art.solicitations[0].link_state, "cannot_link");
  snap.rows.push({ ...snap.rows.at(-1), contract_number: "9990002", start_date: "2026-01-10" });
  assert.equal(built(snap, sol).solicitations[0].reason, "linked_nycha_rfq", "a start date equal to the notice date links");
});

test("nothing is guessed: vendor, title, a similar number or another agency never joins", () => {
  const sol = [
    { request_id: "20260101002", start_date: "2026-01-10T00:00:00.000", agency_name: "Housing Authority", pin: "50331" },
    { request_id: "20260101003", start_date: "2026-01-10T00:00:00.000", agency_name: "Parks and Recreation", pin: "509312" },
  ];
  const art = built(SNAP, sol);
  assert.equal(art.solicitations.find((r) => r.request_id === "20260101002").reason, "nycha_rfq_not_on_list_yet");
  const parks = art.solicitations.find((r) => r.request_id === "20260101003");
  assert.notEqual(parks.reason, "linked_nycha_rfq");
  assert.equal(parks.awards.length, 0);
  assert.equal(art.solicitations.filter((r) => r.reason === "linked_nycha_rfq").length, 0);
});

test("without the NYCHA list the notices read as before: this agency's awards are not in the City Record", () => {
  const legacy = buildMoneyAwardLinksSnapshot(
    { solicitations: NYCHA_SOL, awards: AWD, solicitationCount: NYCHA_SOL.length, awardCount: AWD.length },
    { now: NOW },
  );
  for (const row of legacy.solicitations) assert.ok(["agency_awards_not_in_city_record"].includes(row.reason), row.reason);
  assert.equal(legacy.nycha_feed.state, "not_read");
  assert.equal(legacy.coverage.nycha, undefined);
  const out = linkSolicitationsToAwards(NYCHA_SOL, AWD);
  assert.ok(out.rows.every((row) => row.reason === "agency_awards_not_in_city_record"));
});

test("City Record rows are unchanged by the NYCHA list except for the source and date-kind they now carry", () => {
  const plain = JSON.parse(readFileSync(join(FIXTURE, "solicitations_raw.json"), "utf8"));
  const withList = buildMoneyAwardLinksSnapshot(
    { solicitations: plain, awards: AWD, solicitationCount: plain.length, awardCount: AWD.length, nychaSnapshot: SNAP },
    { now: NOW },
  );
  const without = buildMoneyAwardLinksSnapshot(
    { solicitations: plain, awards: AWD, solicitationCount: plain.length, awardCount: AWD.length },
    { now: NOW },
  );
  // the one Housing Authority row in this fixture is the only row that may differ
  const notNycha = (rows) => rows.filter((row) => row.agency_id !== "housing-authority");
  assert.deepEqual(notNycha(withList.solicitations), notNycha(without.solicitations));
  for (const row of withList.solicitations) for (const award of row.awards) {
    assert.equal(award.source, "city_record_award_notices");
    assert.equal(award.date_kind, "notice_date");
    assert.equal(award.contract_number, null);
  }
});

test("coverage: NYCHA's own link rate by cohort year, and the citywide share without and with the list", () => {
  const art = built();
  const n = art.coverage.nycha;
  assert.equal(n.totals.solicitations, NYCHA_SOL.length);
  const sum = (key) => Object.values(n.by_cohort_year).reduce((acc, year) => acc + year[key], 0);
  for (const key of ["solicitations", "with_rfq_number", "linked", "not_on_list_yet", "not_on_list", "no_pin", "pin_has_no_rfq_number"]) {
    assert.equal(sum(key), n.totals[key], key);
  }
  assert.equal(n.totals.linked, 6);
  assert.equal(n.totals.not_on_list_yet, 1);
  assert.equal(n.totals.not_on_list, 2);
  assert.equal(n.totals.no_pin, 1);
  assert.equal(n.totals.pin_has_no_rfq_number, 1);
  assert.equal(n.totals.linked_pct_of_all, 54.5);
  const share = n.all_solicitations.totals;
  assert.equal(share.solicitations, art.count);
  assert.equal(share.linked_with_nycha_list - share.linked_without_nycha_list, n.totals.linked);
  assert.equal(share.linked_with_nycha_list, art.coverage.totals.linked);
  assert.equal(art.coverage.totals.linked_nycha_rfq, n.totals.linked);
  // the City Record measures do not move: NYCHA lags are reported on their own
  const base = buildMoneyAwardLinksSnapshot(
    { solicitations: NYCHA_SOL, awards: AWD, solicitationCount: NYCHA_SOL.length, awardCount: AWD.length },
    { now: NOW },
  );
  assert.equal(art.coverage.median_lag_days, base.coverage.median_lag_days);
});

test("the artifact names NYCHA's list as a source, states the rule, and says what the dates and totals are", () => {
  const art = built();
  assert.equal(art.nycha_rule_version, "nycha-rfq-number-v1");
  assert.match(art.nycha_join_rule, /Nothing is guessed from titles or vendor names/);
  assert.match(art.nycha_join_rule, /not award dates/);
  assert.equal(art.sources.nycha_awarded_contracts.name, "NYCHA Awarded Contracts");
  assert.equal(art.sources.nycha_awarded_contracts.url, "https://my.nycha.info/PublicSite/Transparency/AwardedContracts");
  assert.equal(art.sources.city_record_award_notices.dataset, "dg92-zbpx");
  assert.equal(art.nycha_feed.state, "live");
  assert.equal(art.nycha_feed.contracts_read, SNAP.count);
  assert.equal(art.population.state, "complete");
  assert.doesNotMatch(JSON.stringify(art.solicitations), /[<>]/);
  for (const [code, reason] of Object.entries(MONEY_AWARD_LINKS_REASONS)) {
    assert.ok(reason.text.length > 20 && ["linked", "no_award_yet", "cannot_link"].includes(reason.state), code);
  }
  assert.doesNotMatch(JSON.stringify(art), /\b(lost|loser|why .* lost|ranked|score)\b/i);
});

test("the offline build reads the fixture snapshot and publishes NYCHA rows beside the City Record rows", async () => {
  const snap = await buildMoneyAwardLinks({ fixture: true, now: NOW });
  assert.equal(snap.nycha_feed.state, "live");
  const plain = read(join(FIXTURE, "solicitations_raw.json"));
  const housing = plain.filter((row) => row.agency_name === "Housing Authority").length;
  assert.equal(snap.solicitations.filter((row) => row.agency_id === "housing-authority").length, NYCHA_SOL.length + housing);
  assert.equal(snap.population.state, "complete");
  const missing = await buildMoneyAwardLinks({ fixture: true, now: NOW, nychaSnapshot: null });
  assert.equal(missing.population.state, "incomplete");
  assert.equal(missing.nycha_feed.state, "unavailable");
});

// The committed files change on every refresh. These checks pin invariants, never the counts.
const SNAP_PATH = join(ROOT, "site", "data", "nycha_awarded_contracts_snapshot.json");
const ART_PATH = join(ROOT, "site", "data", "money_award_links.json");
test("committed snapshot: shape, order, and nothing beyond the retained fields", { skip: !existsSync(SNAP_PATH) }, async () => {
  const snap = await readNychaSnapshot();
  assert.equal(snap.schema, NYCHA_SNAPSHOT_SCHEMA);
  assert.ok(["live", "snapshot_fallback"].includes(snap.feed.state));
  assert.match(snap.feed.fetched_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(snap.count, snap.rows.length);
  assert.equal(snap.feed.years.reduce((n, y) => n + y.row_count, 0), snap.count);
  for (const y of snap.feed.years) assert.match(y.sha256, /^[0-9a-f]{64}$/);
  const ids = new Set();
  for (const row of snap.rows) {
    assert.ok(row.start_date >= "2023-01-01");
    assert.ok(row.rfq_number === null || /^[0-9]{5,7}$/.test(row.rfq_number));
    assert.ok(row.rfq_number === rfqNumberOf(row.rfq_number_printed));
    ids.add(row.contract_number);
  }
  assert.equal(ids.size, snap.rows.length);
  assert.deepEqual(normalizeNychaRows([]), []);
  assert.doesNotMatch(JSON.stringify(snap), /Description|AmountSpent|PROCUR\d/);
});

test("committed artifact: every NYCHA link is a contract on the committed list, same RFQ number, not before the notice", { skip: !existsSync(SNAP_PATH) || !existsSync(ART_PATH) }, async () => {
  const snap = await readNychaSnapshot();
  const art = read(ART_PATH);
  assert.equal(art.population.state, "complete");
  assert.ok(["live", "snapshot_fallback"].includes(art.nycha_feed.state));
  const byContract = new Map(snap.rows.map((row) => [row.contract_number, row]));
  let linked = 0;
  for (const row of art.solicitations) {
    if (row.agency_id !== "housing-authority") continue;
    if (row.link_state === "linked") {
      linked += 1;
      assert.equal(row.reason, "linked_nycha_rfq");
      for (const award of row.awards) {
        const contract = byContract.get(award.contract_number);
        assert.ok(contract, award.contract_number);
        assert.ok(row.rfq_numbers.includes(contract.rfq_number), row.request_id);
        assert.ok(contract.start_date >= row.solicitation_date, row.request_id);
        assert.equal(award.vendor_name, contract.vendor_name);
      }
    } else assert.deepEqual(row.awards, []);
  }
  assert.equal(linked, art.coverage.nycha.totals.linked);
});
