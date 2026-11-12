// Every open City Record solicitation, published with its count against the publisher count.
// Run: node --test test/money_open_solicitations.test.mjs
//
// Fixtures are real City Record Online (dg92-zbpx) responses captured 2026-11-12T03:26Z:
// 194 open solicitations, the same predicate and fields as money_default_open.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  MONEY_DEFAULT_LIMIT,
  MONEY_DEFAULT_LIST_FIELDS,
  MONEY_OPEN_SOLICITATIONS_MAX_BYTES,
  MONEY_OPEN_SOLICITATIONS_MAX_ROWS,
  MONEY_OPEN_SOLICITATIONS_SCHEMA,
  buildMoneyDefaultOpenSnapshot,
  buildMoneyOpenSolicitationsSnapshot,
  fetchMoneyOpenSolicitations,
  moneyDefaultOpenQuery,
  moneyOpenSolicitationsQuery,
} from "../tools/lib/batch_precompute_snapshots.mjs";
import { buildAll } from "../tools/build_batch_precompute_snapshots.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(ROOT, "test", "fixtures", "batch-precompute");
const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const RAW = read(join(FIXTURE, "money_open_solicitations_raw.json"));
const COUNT = Number(read(join(FIXTURE, "money_open_solicitations_count.json"))[0].n);
const NOW = new Date("2026-11-12T03:26:38.728Z");

// Population members named in the packet: the canary is a human-services solicitation the
// 40-row strip omits; the second is a construction solicitation past row 40; the unaffected
// member is the soonest-due row, already in the strip.
const CANARY = "20261027022";
const SECOND = "20261013013";
const UNAFFECTED = "20260917021";

const ids = (payload) => payload.notices.map((row) => row.request_id);

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test("real capture: all 194 open solicitations are published and the count matches the publisher", () => {
  assert.equal(COUNT, 194);
  assert.equal(RAW.length, 194);
  const snap = buildMoneyOpenSolicitationsSnapshot({ rows: RAW, sourceCount: COUNT }, { now: NOW });
  assert.equal(snap.schema, MONEY_OPEN_SOLICITATIONS_SCHEMA);
  assert.equal(snap.schema_version, 1);
  assert.equal(snap.open_as_of, "2026-11-12");
  assert.deepEqual(snap.population, {
    state: "complete",
    reasons: [],
    source_count: 194,
    published_count: 194,
    rejected_rows: 0,
    distinct_pins: 135,
    rows_without_pin: 6,
  });
  assert.equal(snap.count, 194);
  assert.deepEqual(snap.bounds, { max_rows: MONEY_OPEN_SOLICITATIONS_MAX_ROWS, max_bytes: MONEY_OPEN_SOLICITATIONS_MAX_BYTES });
  const categories = {};
  for (const row of snap.notices) categories[row.category_description] = (categories[row.category_description] || 0) + 1;
  assert.deepEqual(categories, {
    "Construction/Construction Services": 82,
    "Construction Related Services": 19,
    Goods: 7,
    "Goods and Services": 24,
    "Human Services/Client Services": 39,
    "Services (other than human services)": 23,
  });
});

test("population members: canary and another row past the strip are present; the strip row is unchanged", () => {
  const snap = buildMoneyOpenSolicitationsSnapshot({ rows: RAW, sourceCount: COUNT }, { now: NOW });
  const strip = buildMoneyDefaultOpenSnapshot(RAW, { now: NOW });
  const stripIds = ids(strip);
  assert.equal(strip.count, MONEY_DEFAULT_LIMIT);
  const byId = new Map(snap.notices.map((row) => [row.request_id, row]));

  for (const id of [CANARY, SECOND]) {
    assert.ok(byId.has(id), `${id} is published`);
    assert.ok(!stripIds.includes(id), `${id} is outside the 40-row strip`);
  }
  assert.equal(byId.get(CANARY).category_description, "Human Services/Client Services");
  assert.equal(byId.get(CANARY).agency_name, "Housing Authority");
  assert.equal(byId.get(SECOND).category_description, "Construction/Construction Services");

  // The strip is unchanged and is exactly the head of the population.
  assert.deepEqual(stripIds, ids(snap).slice(0, MONEY_DEFAULT_LIMIT));
  assert.deepEqual(byId.get(UNAFFECTED), strip.notices[0]);
  const humanInStrip = strip.notices.filter((row) => row.category_description.startsWith("Human")).length;
  const humanInPopulation = snap.notices.filter((row) => row.category_description.startsWith("Human")).length;
  assert.deepEqual([humanInStrip, humanInPopulation], [1, 39]);
});

test("rows keep list-card fields only; contact and description fields are not republished", () => {
  const withContacts = RAW.map((row) => ({ ...row, contact_name: "x", email: "x@example.invalid", contact_phone: "1", additional_description_1: "long" }));
  const snap = buildMoneyOpenSolicitationsSnapshot({ rows: withContacts, sourceCount: COUNT }, { now: NOW });
  for (const row of snap.notices) {
    for (const key of Object.keys(row)) assert.ok(MONEY_DEFAULT_LIST_FIELDS.includes(key), key);
  }
});

test("the query is the strip's predicate and fields, ordered with a tiebreak, one row past the bound", () => {
  const strip = moneyDefaultOpenQuery(NOW);
  const full = moneyOpenSolicitationsQuery(NOW);
  assert.equal(full.$where, strip.$where);
  assert.equal(full.$select, strip.$select);
  assert.equal(full.$order, "due_date ASC, request_id ASC");
  assert.equal(full.$limit, String(MONEY_OPEN_SOLICITATIONS_MAX_ROWS + 1));
});

test("failure: publisher count differs from the rows pulled -> incomplete count_mismatch", () => {
  const snap = buildMoneyOpenSolicitationsSnapshot({ rows: RAW.slice(0, 190), sourceCount: COUNT }, { now: NOW });
  assert.equal(snap.population.state, "incomplete");
  assert.deepEqual(snap.population.reasons, ["count_mismatch"]);
  assert.equal(snap.population.source_count, 194);
  assert.equal(snap.population.published_count, 190);
});

test("failure: a row missing request_id, or a duplicate, is rejected and the pull is incomplete", () => {
  const missing = RAW.map((row, index) => (index === 5 ? { ...row, request_id: undefined } : row));
  const snap = buildMoneyOpenSolicitationsSnapshot({ rows: missing, sourceCount: COUNT }, { now: NOW });
  assert.equal(snap.population.state, "incomplete");
  assert.deepEqual(snap.population.reasons, ["invalid_rows"]);
  assert.equal(snap.population.rejected_rows, 1);
  assert.equal(snap.count, 193);
  assert.ok(!snap.notices.some((row) => row.request_id === undefined));

  const duplicated = [...RAW.slice(0, 193), RAW[0]];
  const dup = buildMoneyOpenSolicitationsSnapshot({ rows: duplicated, sourceCount: COUNT }, { now: NOW });
  assert.deepEqual(dup.population.reasons, ["invalid_rows"]);
  assert.equal(dup.count, 193);
});

test("failure: a population over the row bound is published capped and marked row_cap, never as complete", () => {
  const snap = buildMoneyOpenSolicitationsSnapshot({ rows: RAW, sourceCount: COUNT }, { now: NOW, maxRows: 100 });
  assert.equal(snap.population.state, "incomplete");
  assert.deepEqual(snap.population.reasons, ["row_cap"]);
  assert.equal(snap.count, 100);
  assert.equal(snap.population.source_count, 194);
  assert.deepEqual(ids(snap), RAW.slice(0, 100).map((row) => row.request_id), "the soonest-due rows are kept");
});

test("failure: an artifact over the byte bound is refused so the last good file stays", () => {
  assert.throws(
    () => buildMoneyOpenSolicitationsSnapshot({ rows: RAW, sourceCount: COUNT }, { now: NOW, maxBytes: 64 * 1024 }),
    /exceeds the 65536-byte bound/,
  );
});

test("failure: a missing or malformed publisher count is refused", () => {
  assert.throws(() => buildMoneyOpenSolicitationsSnapshot({ rows: RAW }, { now: NOW }), /publisher count/);
  assert.throws(() => buildMoneyOpenSolicitationsSnapshot({ rows: RAW, sourceCount: "many" }, { now: NOW }), /publisher count/);
});

test("measured bound: the real 194-row artifact uses about a quarter of the byte bound", () => {
  const snap = buildMoneyOpenSolicitationsSnapshot({ rows: RAW, sourceCount: COUNT }, { now: NOW });
  const bytes = Buffer.byteLength(`${JSON.stringify(snap, null, 2)}\n`);
  assert.ok(bytes < 100 * 1024, `${bytes} bytes`);
  const perRow = bytes / snap.count;
  assert.ok(perRow * MONEY_OPEN_SOLICITATIONS_MAX_ROWS < MONEY_OPEN_SOLICITATIONS_MAX_BYTES, "500 average rows fit the bound");
});

test("acquisition: count then one bounded page, through the retrying fetch", async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    return String(url).includes("count") ? jsonResponse([{ n: "194" }]) : jsonResponse(RAW);
  };
  const result = await fetchMoneyOpenSolicitations(fetchImpl, NOW, { log: () => {} });
  assert.equal(result.sourceCount, 194);
  assert.equal(result.rows.length, 194);
  assert.equal(urls.length, 2);
  const page = new URL(urls[1]);
  assert.equal(page.searchParams.get("$limit"), "501");
  assert.equal(page.searchParams.get("$order"), "due_date ASC, request_id ASC");
});

test("failure: a page that keeps failing or timing out throws instead of returning a short list", async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes("count")) return jsonResponse([{ n: "194" }]);
    throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  };
  await assert.rejects(
    fetchMoneyOpenSolicitations(fetchImpl, NOW, { log: () => {}, sleep: async () => {}, retry: { maxAttempts: 2 } }),
    /timeout/,
  );
  const unavailable = async () => jsonResponse({}, 503);
  await assert.rejects(
    fetchMoneyOpenSolicitations(unavailable, NOW, { log: () => {}, sleep: async () => {}, retry: { maxAttempts: 2 } }),
    /HTTP 503/,
  );
});

test("builder: the population is its own run; a failed pull throws and the 40-row strip run is untouched", async () => {
  const failing = async (url) => {
    const text = decodeURIComponent(String(url));
    if (text.includes("count(*)")) return jsonResponse({}, 503);
    if (text.includes("$group=agency_name")) return jsonResponse([{ agency_name: "Parks and Recreation" }]);
    return jsonResponse(RAW.slice(0, 40));
  };
  await assert.rejects(buildAll({ fetchImpl: failing, now: NOW, moneyOpenSolicitationsOnly: true }), /HTTP 503/);
  const strip = await buildAll({ fetchImpl: failing, now: NOW, moneyOnly: true });
  assert.equal(strip.money_default_open.count, 40);
  assert.equal(strip.money_open_solicitations, undefined, "--money-only never builds or overwrites the population");
});

test("builder fixture mode builds the committed shape from the retained capture", async () => {
  const built = await buildAll({ fixture: true, now: NOW, moneyOpenSolicitationsOnly: true });
  assert.deepEqual(Object.keys(built), ["money_open_solicitations"]);
  assert.equal(built.money_open_solicitations.population.state, "complete");
  assert.equal(built.money_open_solicitations.count, 194);
});

test("committed artifact: parses, states its count against the source count, and is within its bounds", () => {
  const path = join(ROOT, "site/data/money_open_solicitations.json");
  const text = readFileSync(path, "utf8");
  const committed = JSON.parse(text);
  assert.equal(committed.schema, MONEY_OPEN_SOLICITATIONS_SCHEMA);
  assert.equal(committed.count, committed.notices.length);
  assert.equal(committed.population.published_count, committed.notices.length);
  if (committed.population.state === "complete") {
    assert.deepEqual(committed.population.reasons, []);
    assert.equal(committed.population.source_count, committed.population.published_count);
  } else {
    assert.ok(committed.population.reasons.length > 0);
  }
  assert.ok(committed.notices.length <= committed.bounds.max_rows);
  assert.ok(Buffer.byteLength(text) <= committed.bounds.max_bytes);
  assert.equal(new Set(ids(committed)).size, committed.notices.length);
});
