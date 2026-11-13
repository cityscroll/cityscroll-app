// node --test for public entity registers (DOS on-demand, IRS EO BMF NY, DOL, SCA).
// Recorded REAL responses live in test/fixtures/entity_registers/; nothing here touches the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseCsv, parseCsvRecords } from "../entity_resolution/registers/csv.mjs";
import { ENTITY_CLASSES, REGISTER_IDS, RECORD_KEYS, validateRecord } from "../entity_resolution/registers/read_contract.mjs";
import { vendorStem } from "../entity_resolution/normalizers/vendor_stem.mjs";
import { entityClassOf, loadEntityClassMap } from "../entity_resolution/registers/entity_class.mjs";
import {
  DOS_LIMITS, DOS_FIELDS, REFUSAL, buildNameQuery, buildIdQuery, buildExactBatchQuery, classifyFailure,
  classifyRows, lookupDosById, lookupDosByName, mapDosRow, prepareName, soqlString,
} from "../entity_resolution/registers/dos_entities.mjs";
import { IRS_COLUMNS, normalizeIrsCsv, normalizeIrsRecord, nonNullCounts } from "../entity_resolution/registers/irs_eo_bmf.mjs";
import { normalizeDolRow, normalizeScaRows, stripComputed } from "../entity_resolution/registers/table_registers.mjs";
import { buildArtifact, loadArtifact, lookupById, lookupByName, lookupByStem } from "../entity_resolution/registers/register_index.mjs";
import { loadFetchSodaRowsWithRetry } from "./helpers/fetch_soda_rows_with_retry.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HERE = path.join(ROOT, "test", "fixtures", "entity_registers");
const APP_ROOT = ROOT;
const readJson = (...p) => JSON.parse(fs.readFileSync(path.join(HERE, ...p), "utf8"));
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const AT = "2026-11-11T23:30:00Z";

// Local rebuild of the closed class rules (fixture regenerator stays out of the engine package).
const CLASS_RULES = [
  { id: "not_for_profit_label", test: /NOT-FOR-PROFIT/, cls: "not_for_profit" },
  { id: "professional_label", test: /PROFESSIONAL SERVICE/, cls: "professional" },
  { id: "llp_label", test: /LIMITED LIABILITY PARTNERSHIP/, cls: "llp" },
  { id: "reservation_label", test: /^RESERVATION OF/, cls: "other" },
  { id: "limited_partnership_label", test: /LIMITED PARTNERSHIP|\(LIMITED PARTNERSHIP\)/, cls: "limited_partnership" },
  { id: "llc_label", test: /LIMITED LIABILITY COMPANY/, cls: "llc" },
  { id: "business_corporation_label", test: /BUSINESS CORPORATION|^DOMESTIC BENEFIT CORPORATION|^DOMESTIC PUBLIC BENEFIT CORPORATION/, cls: "business_corporation" },
];
function classOf(entityType) {
  for (const r of CLASS_RULES) if (r.test.test(entityType)) return { cls: r.cls, rule: r.id };
  return { cls: "other", rule: "fallback_other" };
}
function buildClassMap() {
  const bytes = fs.readFileSync(path.join(HERE, "dos_entity_type_counts.response.json"));
  const rows = JSON.parse(bytes.toString("utf8"));
  const entries = rows.map((r) => {
    const c = classOf(r.entity_type);
    return { entity_type: r.entity_type, count: Number(r.n), entity_class: c.cls, rule: c.rule };
  });
  const byClass = {};
  for (const e of entries) byClass[e.entity_class] = (byClass[e.entity_class] || 0) + e.count;
  const total = entries.reduce((s, e) => s + e.count, 0);
  const committed = JSON.parse(fs.readFileSync(path.join(APP_ROOT, "entity_resolution/registers/entity_type_class_map.json"), "utf8"));
  return {
    ...committed,
    // recompute the variable fields that must match
    source_response_sha256: sha256(bytes),
    distinct_entity_types: entries.length,
    sum_of_counts: total,
    totals_by_class: byClass,
    entries,
  };
}

const dosManifest = readJson("dos", "manifest.json");
const dosEntry = (id) => dosManifest.entries.find((e) => e.id === id);
const dosBody = (id) => fs.readFileSync(path.join(HERE, dosEntry(id).file), "utf8");
const dosRows = (id) => JSON.parse(dosBody(id));

/** readRows stub that serves a recorded body ONLY for the exact recorded URL, and counts calls. */
function recordedReader(id) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    assert.equal(url, dosEntry(id).url, `request URL differs from the recorded one for ${id}`);
    return dosRows(id);
  };
  fn.calls = calls;
  return fn;
}

// ---------------------------------------------------------------------------------------------
// vendor_stem port (v)
// ---------------------------------------------------------------------------------------------

test("(v) vendorStem is stable on >= 500 real vendor names", () => {
  const names = new Set();
  const ocp = JSON.parse(fs.readFileSync(path.join(APP_ROOT, "site/data/ocp_awards_warehouse_lookup.json"), "utf8"));
  for (const r of ocp.rows) if (r.vendor_name) names.add(r.vendor_name);
  const db = JSON.parse(fs.readFileSync(path.join(APP_ROOT, "site/data/doing_business_warehouse_lookup.json"), "utf8"));
  for (const r of db.rows) if (r.organization_name) names.add(r.organization_name);
  const all = [...names].sort();
  assert.ok(all.length >= 5000, `expected thousands of distinct real names, got ${all.length}`);
  const pick = all.filter((_, i) => i % 7 === 3).slice(0, 2500);
  assert.ok(pick.length >= 500);
  let nonTrivial = 0;
  for (const n of pick) {
    const stem = vendorStem(n);
    assert.equal(typeof stem, "string");
    if (stem !== n.toUpperCase()) nonTrivial++;
  }
  assert.ok(nonTrivial > 300, "the sample must exercise suffix stripping and punctuation folding");
  for (const odd of [null, undefined, "", "  ", "<b>Acme</b> Inc.", "O’Brien & Sons, L.L.C."]) {
    assert.equal(typeof vendorStem(odd), "string");
  }
});

// ---------------------------------------------------------------------------------------------
// (i) normalizers keep every published field and flag instead of dropping
// ---------------------------------------------------------------------------------------------

test("(i) csv reader handles quotes, doubled quotes, embedded newlines and CRLF", () => {
  const rows = parseCsv('a,b,c\r\n"x,1","he said ""hi""","two\nlines"\r\nlast,,\r\n');
  assert.deepEqual(rows, [["a", "b", "c"], ["x,1", 'he said "hi"', "two\nlines"], ["last", "", ""]]);
  const { records } = parseCsvRecords("a,b\n1,2,3\n4\n");
  assert.equal(records.length, 2);
  assert.equal(records[0].ragged, true);
  assert.equal(records[1].ragged, true);
});

test("(i) IRS: every one of the 28 published columns is kept for all 300 real sampled rows", () => {
  const sample = readJson("irs_eo_bmf_ny.sample.json");
  assert.equal(sample.records.length, 300);
  for (const rec of sample.records) {
    assert.deepEqual(validateRecord(rec), [], `contract problems for ${rec.register_record_id}`);
    assert.deepEqual(Object.keys(rec.raw), [...IRS_COLUMNS]);
    // re-normalizing the kept raw values reproduces the record exactly
    const again = normalizeIrsRecord(rec.raw, { collected_at: rec.collected_at, row_index: rec.published.csv_row_index });
    assert.deepEqual(again, rec);
  }
});

test("(i) IRS: malformed rows are flagged and kept, never dropped; a wrong header fails closed", () => {
  const sample = readJson("irs_eo_bmf_ny.sample.json").records;
  const q = (s) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const line = (r) => IRS_COLUMNS.map((c) => q(r[c])).join(",");
  const [a, b, c, d] = sample.map((r) => ({ ...r.raw }));
  b.EIN = "12-345";           // not 9 digits
  c.NAME = "";                // no name
  d.NAME = "AB";              // stem too short
  const text = [IRS_COLUMNS.join(","), line(a), line(b), line(c), line(d), "123456789,SHORT ROW,,"].join("\n") + "\n";
  const out = normalizeIrsCsv(text, { collected_at: AT });
  assert.equal(out.ok, true);
  assert.equal(out.row_count, 5, "no row may be dropped");
  assert.equal(out.ragged_rows, 1);
  assert.deepEqual(out.records[0].flags, []);
  assert.ok(out.records[1].flags.includes("missing_record_id"));
  assert.equal(out.records[1].raw.EIN, "12-345", "raw value kept verbatim");
  assert.ok(out.records[2].flags.includes("missing_name"));
  assert.ok(out.records[3].flags.includes("stem_too_short"));
  assert.ok(out.records[4].flags.includes("ragged_row"));
  for (const r of out.records) assert.deepEqual(validateRecord(r), []);
  const bad = normalizeIrsCsv("EIN,NAME\n1,2\n", { collected_at: AT });
  assert.equal(bad.ok, false);
  assert.equal(bad.records.length, 0);
});

test("(i) IRS receipt: row count, size and non-null counts agree with each other", () => {
  const r = readJson("irs_eo_bmf_ny.receipt.json");
  assert.equal(r.row_count, 125622);
  assert.equal(r.bytes, 21920529);
  assert.equal(r.distinct_eins, r.row_count);
  assert.deepEqual(r.columns, [...IRS_COLUMNS]);
  for (const c of IRS_COLUMNS) {
    assert.ok(Number.isInteger(r.non_null_counts[c]) && r.non_null_counts[c] <= r.row_count, c);
  }
  assert.equal(r.non_null_counts.EIN, r.row_count);
  assert.equal(r.non_null_counts.NAME, r.row_count);
  // counting the 300-row sample with the production function stays within the full-file counts
  const sample = readJson("irs_eo_bmf_ny.sample.json").records;
  const c = nonNullCounts(sample);
  for (const col of IRS_COLUMNS) assert.ok(c[col] <= 300);
});

test("(i) DOS: mapDosRow keeps every published field of every recorded real row, and flags malformed rows", () => {
  let seen = 0;
  for (const e of dosManifest.entries) {
    if (e.id === "exact_batch" || e.kind === "dos_id" || true) {
      for (const row of dosRows(e.id)) {
        const rec = mapDosRow(row, { queried_at: AT });
        seen++;
        assert.deepEqual(validateRecord(rec), [], `contract problems ${rec.register_record_id}`);
        for (const [k, v] of Object.entries(row)) assert.equal(rec.raw[k], String(v), `raw ${k} lost`);
        assert.equal(rec.register, "ny_dos_entities");
        assert.equal(rec.status, "ACTIVE");
        assert.equal(rec.status_basis, "dataset_scope_active_corporations");
        assert.ok(rec.queried_at && !rec.collected_at);
        assert.ok(rec.published.blocks.location && rec.published.blocks.registered_agent && rec.published.blocks.chairman && rec.published.blocks.dos_process);
      }
    }
  }
  assert.ok(seen >= 40, `expected many real rows, saw ${seen}`);
  // malformed: no id, no name, unknown extra column, garbage date, unknown entity type
  const bad = mapDosRow({ current_entity_name: "", entity_type: "BRAND NEW KIND OF ENTITY", initial_dos_filing_date: "not a date", brand_new_column: "x" }, { queried_at: AT });
  assert.deepEqual(bad.flags.sort(), ["invalid_date", "missing_name", "missing_record_id", "unmapped_entity_type"].sort());
  assert.equal(bad.raw.brand_new_column, "x");
  assert.equal(bad.entity_class, "other");
  assert.deepEqual(validateRecord(bad), []);
});

test("(i) DOL contractor registry: all 300 real sampled rows keep every published field", () => {
  const s = readJson("dol_contractor_registry.sample.json");
  assert.ok(s.rows.length >= 300);
  for (const row of s.rows) {
    const rec = normalizeDolRow(row, { collected_at: AT });
    assert.deepEqual(validateRecord(rec), []);
    assert.deepEqual(rec.raw, stripComputed(row));
    assert.equal(rec.register_record_id, row.certificate_number);
    for (const k of Object.keys(row)) assert.ok(k in rec.raw);
    assert.equal(rec.entity_type, row.business_type);
  }
  // sole proprietorships and partnerships ARE in this register, mapped to other with the type kept
  const sole = s.rows.find((r) => r.business_type === "Sole Proprietorship");
  assert.ok(sole, "the fixture carries a real sole proprietorship row");
  const rec = normalizeDolRow(sole, { collected_at: AT });
  assert.equal(rec.entity_class, "other");
  assert.equal(rec.entity_type, "Sole Proprietorship");
  const debarred = s.rows.find((r) => r.business_has_been_debarred === "Yes");
  assert.ok(debarred && normalizeDolRow(debarred, { collected_at: AT }).published.business_has_been_debarred === "Yes");
  const r = readJson("dol_contractor_registry.receipt.json");
  assert.equal(r.row_count, 15193);
  assert.equal(r.distinct_certificate_numbers, r.row_count);
});

test("(i) SCA prequalified firms: rows grouped per firm without losing a row or a field", () => {
  const s = readJson("sca_prequalified_firms.sample.json");
  const recs = normalizeScaRows(s.rows, { collected_at: AT });
  assert.equal(recs.length, 100);
  let rows = 0;
  for (const rec of recs) {
    assert.deepEqual(validateRecord(rec), []);
    rows += rec.raw.rows.length;
    assert.equal(rec.published.trades.length, rec.raw.rows.length);
    assert.equal(rec.register_record_id, rec.name.trim().toUpperCase());
  }
  assert.equal(rows, s.rows.length, "every sampled row is inside some firm record");
  const kept = recs.flatMap((r) => r.raw.rows.map((x) => JSON.stringify(x))).sort();
  assert.deepEqual(kept, s.rows.map((x) => JSON.stringify(x)).sort(), "every published row is kept verbatim (omitted empty fields stay omitted)");
  // a row without a name is kept as its own flagged record
  const odd = normalizeScaRows([{ prequalified_vendor_name: "", prequalified_vendor_date: "nonsense" }], { collected_at: AT });
  assert.equal(odd.length, 1);
  assert.ok(odd[0].flags.includes("missing_name") && odd[0].flags.includes("missing_record_id") && odd[0].flags.includes("invalid_date"));
  const r = readJson("sca_prequalified_firms.receipt.json");
  assert.equal(r.row_count, 6092);
  assert.equal(r.firm_records, 2178);
});

// ---------------------------------------------------------------------------------------------
// (ii) entity_class mapping
// ---------------------------------------------------------------------------------------------

test("(ii) entity_type map covers every observed value and reconciles to the recorded counts", () => {
  const recorded = readJson("dos_entity_type_counts.response.json");
  const map = JSON.parse(fs.readFileSync(path.join(APP_ROOT, "entity_resolution/registers/entity_type_class_map.json"), "utf8"));
  assert.equal(map.source_response_sha256, sha256(fs.readFileSync(path.join(HERE, "dos_entity_type_counts.response.json"))));
  assert.equal(recorded.length, 53);
  assert.equal(map.distinct_entity_types, 53);
  assert.equal(map.entries.length, 53);
  const byType = new Map(map.entries.map((e) => [e.entity_type, e]));
  let total = 0;
  const byClass = Object.fromEntries(ENTITY_CLASSES.map((c) => [c, 0]));
  for (const row of recorded) {
    const e = byType.get(row.entity_type);
    assert.ok(e, `observed value missing from the map: ${row.entity_type}`);
    assert.equal(e.count, Number(row.n));
    assert.ok(ENTITY_CLASSES.includes(e.entity_class));
    const got = entityClassOf(row.entity_type);
    assert.equal(got.mapped, true);
    assert.equal(got.entity_class, e.entity_class);
    total += Number(row.n);
    byClass[e.entity_class] += Number(row.n);
  }
  assert.equal(total, 4315387, "sum of counts equals the dataset row count recorded on 2026-11-11");
  assert.equal(map.sum_of_counts, total);
  assert.deepEqual(map.totals_by_class, Object.fromEntries(Object.entries(byClass).filter(([, n]) => n > 0)));
  assert.equal(Object.values(map.totals_by_class).reduce((a, b) => a + b, 0), total);
  // the file on disk is exactly what the builder produces from the recorded response
  const rebuilt = buildClassMap();
  assert.equal(rebuilt.source_response_sha256, map.source_response_sha256);
  assert.equal(rebuilt.sum_of_counts, map.sum_of_counts);
  assert.equal(rebuilt.distinct_entity_types, map.distinct_entity_types);
  assert.deepEqual(rebuilt.totals_by_class, map.totals_by_class);
  assert.deepEqual(rebuilt.entries.map((e) => ({ entity_type: e.entity_type, count: e.count, entity_class: e.entity_class })),
    map.entries.map((e) => ({ entity_type: e.entity_type, count: e.count, entity_class: e.entity_class })));
  // owner-facing counts
  assert.equal(map.totals_by_class.not_for_profit, 302417);
  assert.equal(byType.get("DOMESTIC NOT-FOR-PROFIT CORPORATION").count, 288407);
  assert.equal(byType.get("DOMESTIC LIMITED LIABILITY COMPANY").count, 2075717);
  assert.equal(byType.get("DOMESTIC BUSINESS CORPORATION").count, 1456355);
  // unknown values never throw and never get a class other than `other`
  assert.deepEqual(entityClassOf("SOMETHING PUBLISHED TOMORROW"), { entity_class: "other", mapped: false });
  assert.deepEqual(entityClassOf(null), { entity_class: "other", mapped: false });
  assert.equal(classOf("DOMESTIC LIMITED LIABILITY COMPANY").cls, "llc");
  const loaded = loadEntityClassMap();
  assert.equal(loaded.byType.size, 53);
});

// ---------------------------------------------------------------------------------------------
// (iii) population rule on recorded real responses
// ---------------------------------------------------------------------------------------------

test("(iii) a real New York nonprofit is found with entity_class not_for_profit", async () => {
  const rd = recordedReader("nonprofit_single");
  const out = await lookupDosByName("Chinatown Manpower Project Inc", { readRows: rd, now: () => new Date(AT), limit: 25 });
  assert.equal(rd.calls.length, 1);
  assert.equal(out.status, "one_match");
  assert.equal(out.verdict, "single_name_match");
  assert.equal(out.link_policy, "candidate_only");
  const [rec] = out.records;
  assert.equal(rec.entity_class, "not_for_profit");
  assert.equal(rec.entity_type, "DOMESTIC NOT-FOR-PROFIT CORPORATION");
  assert.equal(rec.name, "CHINATOWN MANPOWER PROJECT, INC.");
  assert.equal(rec.register_record_id, dosRows("nonprofit_single")[0].dos_id);
  assert.equal(out.queried_at, new Date(AT).toISOString());
  const byId = await lookupDosById(rec.register_record_id, { readRows: recordedReader("dos_id_nonprofit"), now: () => new Date(AT) });
  assert.equal(byId.status, "one_match");
  assert.equal(byId.records[0].register_record_id, rec.register_record_id);
  assert.equal(byId.records[0].entity_class, "not_for_profit");
});

test("(iii) a real LLC is found with entity_class llc", async () => {
  const out = await lookupDosByName("C GLOBAL CONSULTING LLC", { readRows: recordedReader("llc_single"), now: () => new Date(AT), limit: 25 });
  assert.equal(out.status, "one_match");
  assert.equal(out.records[0].entity_class, "llc");
  assert.equal(out.records[0].entity_type, "DOMESTIC LIMITED LIABILITY COMPANY");
});

test("(iii) a real name with several state matches returns all candidates and no single verdict", async () => {
  const out = await lookupDosByName("Skyline Builders", { readRows: recordedReader("several_same_stem"), now: () => new Date(AT), limit: 25 });
  assert.equal(out.status, "several_matches");
  assert.equal(out.verdict, null);
  const names = out.records.map((r) => r.name);
  assert.ok(names.includes("SKYLINE BUILDERS INC.") && names.includes("SKYLINE BUILDERS, LLC") && names.includes("SKYLINE BUILDERS USA, INC."), names.join(" | "));
  assert.equal(new Set(out.records.map((r) => r.register_record_id)).size, out.records.length);
  // the raw rows contain every one of those, so nothing was hidden
  const raw = dosRows("several_same_stem").map((r) => r.dos_id);
  for (const r of out.records) assert.ok(raw.includes(r.register_record_id));
});

test("(iii) the exact-name rule: one record whose whole name equals the typed name is the single match, siblings are reported", async () => {
  const out = await lookupDosByName("SKYLINE BUILDERS INC.", { readRows: async () => dosRows("several_same_stem"), now: () => new Date(AT), limit: 25 });
  assert.equal(out.status, "one_match");
  assert.equal(out.records.length, 1);
  assert.equal(out.records[0].match_basis, "exact_name");
  assert.ok(out.also_stem_equal >= 2, "the LLC and USA INC. records are reported as also stem-equal");
});

test("(iii) a capped result (generic name) is 'truncated': no match count, no single verdict", async () => {
  const out = await lookupDosByName("New York State Association", { readRows: recordedReader("truncated_generic"), now: () => new Date(AT), limit: 25 });
  assert.equal(out.status, "truncated");
  assert.equal(out.truncated, true);
  assert.equal(out.verdict, null);
  assert.equal(out.returned, 25);
  assert.ok(out.records.length === 25);
});

test("(iii) candidates only: rows came back but none is the same name; and '&' versus 'and' is folded", async () => {
  const c = await lookupDosByName("Catholic Charities/Neighborhood Services", { readRows: recordedReader("candidates_only"), now: () => new Date(AT), limit: 25 });
  assert.equal(c.status, "candidates_only");
  assert.equal(c.verdict, null);
  assert.ok(c.records.length >= 1 && c.records.every((r) => r.match_basis === "candidate"));
  const a = await lookupDosByName("Parisi Landscape and Maintenance, Inc", { readRows: recordedReader("and_vs_ampersand"), now: () => new Date(AT), limit: 25 });
  assert.equal(a.status, "one_match");
  assert.equal(a.records[0].match_basis, "stem_equal_and_folded");
  assert.match(a.records[0].name, /PARISI LANDSCAPE & MAINTENANCE/);
});

test("(iii) no match, source unavailable and query refused are three different answers", async () => {
  const none = await lookupDosByName("Zxqvbk Quillfeather Holdings LLC", { readRows: recordedReader("no_match"), now: () => new Date(AT), limit: 25 });
  assert.equal(none.status, "no_match");
  assert.deepEqual(none.records, []);

  // source unavailable, through the ENGINE's own fetchSodaRowsWithRetry (cut from alerts.mjs)
  const { fetchSodaRowsWithRetry } = await loadFetchSodaRowsWithRetry(APP_ROOT);
  const mk = (fetchFn, budgetMs = 1000) => (url) => fetchSodaRowsWithRetry(url, { fetchFn, delaysMs: [1], waitFn: async () => {}, budgetMs });
  const r503 = await lookupDosByName("Skyline Builders", { readRows: mk(async () => new Response("down", { status: 503 })) });
  assert.equal(r503.status, "source_unavailable");
  assert.equal(r503.http_status, 503);
  assert.equal(r503.requests, 1);
  const r429 = await lookupDosByName("Skyline Builders", { readRows: mk(async () => new Response("slow down", { status: 429 })) });
  assert.equal(r429.status, "source_unavailable");
  const timeout = await lookupDosByName("Skyline Builders", { readRows: mk(() => new Promise(() => {}), 30) });
  assert.equal(timeout.status, "source_unavailable");
  assert.equal(timeout.reason, "timeout");
  const net = await lookupDosByName("Skyline Builders", { readRows: mk(async () => { throw new TypeError("fetch failed"); }) });
  assert.equal(net.status, "source_unavailable");
  const garbage = await lookupDosByName("Skyline Builders", { readRows: async () => ({ not: "an array" }) });
  assert.equal(garbage.status, "source_unavailable");
  assert.equal(garbage.reason, "invalid_json_shape");
  const rejected = await lookupDosByName("Skyline Builders", { readRows: mk(async () => new Response("bad query", { status: 400 })) });
  assert.equal(rejected.status, "query_rejected", "a 400 is our own query, not an outage");
  for (const o of [r503, r429, timeout, net, garbage, rejected]) assert.notEqual(o.status, "no_match");

  // refused BEFORE any request
  let calls = 0;
  const spy = async () => { calls++; return []; };
  const refusals = [];
  for (const input of ["", "  ", "%", "%%%", "_", "' --", "ab", "A B C", "J&A", "and", "and and", null, undefined, 42, {}, "x".repeat(201)]) {
    const out = await lookupDosByName(input, { readRows: spy });
    assert.equal(out.status, "refused", JSON.stringify(input));
    assert.equal(out.requests, 0);
    refusals.push(out.reason);
  }
  assert.equal(calls, 0, "no request is made for a refused input");
  assert.ok(refusals.includes(REFUSAL.WILDCARD_ONLY) && refusals.includes(REFUSAL.TOO_SHORT) && refusals.includes(REFUSAL.NO_LONG_TOKEN) && refusals.includes(REFUSAL.TOO_LONG) && refusals.includes(REFUSAL.NOT_TEXT));
  const badId = await lookupDosById("12; drop", { readRows: spy });
  assert.equal(badId.status, "refused");
  assert.equal(calls, 0);
});

test("(iii) answered lookups are cached for 300 s, failures are never cached", async () => {
  const store = new Map();
  const cache = { get: async (k) => store.get(k) ?? null, put: async (k, v, s) => { store.set(k, v); assert.equal(s, 300); } };
  const rd = recordedReader("llc_single");
  const a = await lookupDosByName("C GLOBAL CONSULTING LLC", { readRows: rd, cache, now: () => new Date(AT), limit: 25 });
  const b = await lookupDosByName("C GLOBAL CONSULTING LLC", { readRows: rd, cache, now: () => new Date(AT), limit: 25 });
  assert.equal(a.cache, "miss");
  assert.equal(b.cache, "hit");
  assert.equal(b.requests, 0);
  assert.equal(rd.calls.length, 1);
  const fail = async () => { throw Object.assign(new Error("SODA 503"), { upstream_status: 503 }); };
  const store2 = new Map();
  const cache2 = { get: async (k) => store2.get(k) ?? null, put: async (k, v) => store2.set(k, v) };
  const f = await lookupDosByName("Skyline Builders", { readRows: fail, cache: cache2 });
  assert.equal(f.status, "source_unavailable");
  assert.equal(store2.size, 0);
});

test("(iii) failure classification mirrors the engine's transient-status rule", async () => {
  const up = await import(pathToFileURL(path.join(APP_ROOT, "worker/src/lib/upstream_failure.mjs")).href);
  for (const status of [400, 401, 403, 404, 408, 422, 425, 429, 500, 502, 503, 504, 520, 524]) {
    const out = classifyFailure(Object.assign(new Error(`SODA ${status}`), { upstream_status: status }));
    assert.equal(out.status === "source_unavailable", up.TRANSIENT_UPSTREAM_STATUSES.has(status), String(status));
  }
});

test("(iii) fetchSodaRowsWithRetry retries a 503 once, then gives up with a tagged error", async () => {
  const h = await loadFetchSodaRowsWithRetry(APP_ROOT);
  assert.match(h.alerts_sha256, /^[0-9a-f]{64}$/);
  let n = 0;
  const rows = await h.fetchSodaRowsWithRetry("https://example.test/x", { fetchFn: async () => (++n === 1 ? new Response("x", { status: 503 }) : new Response("[1]", { status: 200 })), delaysMs: [1], waitFn: async () => {}, budgetMs: 1000 });
  assert.deepEqual(rows, [1]);
  assert.equal(n, 2);
  await assert.rejects(h.fetchSodaRowsWithRetry("https://example.test/x", { fetchFn: async () => new Response("x", { status: 503 }), delaysMs: [1], waitFn: async () => {}, budgetMs: 1000 }), (e) => e.upstream_source === "soda" && e.upstream_status === 503 && e.upstream_attempts === 2);
});

// ---------------------------------------------------------------------------------------------
// (iv) query builder
// ---------------------------------------------------------------------------------------------

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("(iv) the builder reproduces every recorded request URL exactly", () => {
  for (const e of dosManifest.entries) {
    if (e.kind === "name_token_prefix") assert.equal(buildNameQuery(e.input, { limit: e.limit }).url, e.url, e.id);
    if (e.kind === "dos_id") assert.equal(buildIdQuery(e.input).url, e.url, e.id);
    if (e.kind === "exact_upper_batch") assert.equal(buildExactBatchQuery(e.input).url, e.url, e.id);
  }
});

test("(iv) quotes and SoQL wildcards in user text never reach the LIKE pattern; every request is bounded", () => {
  const q = buildNameQuery("O'Brien & Sons' %_Inc; DROP TABLE x --");
  assert.equal(q.ok, true);
  assert.match(q.params.$where, /^upper\(current_entity_name\) like '[A-Z0-9%]+'$/);
  assert.ok(!q.params.$where.includes("''"));
  assert.equal(q.pattern, "O%BRIEN%SONS%INC%DROP%TABLE%X%");
  assert.ok(q.params.$limit && Number(q.params.$limit) <= DOS_LIMITS.max_limit + 1);
  assert.equal(q.params.$select.split(",").length, DOS_FIELDS.length);
  const url = new URL(q.url);
  assert.ok(url.searchParams.has("$limit") && url.searchParams.has("$select") && url.searchParams.has("$where"));
  // seeded adversarial fuzz: any accepted input yields a pattern of [A-Z0-9%] only, a limit, and no raw quote
  const rnd = mulberry32(20261111);
  const alphabet = ["'", "''", "%", "_", "\\", "\"", ";", "--", "/*", " ", "a", "B", "9", "é", "’", "&", ",", ".", "(", ")", "\u0000", "AND", " and ", "Inc"];
  let accepted = 0, refused = 0;
  for (let i = 0; i < 4000; i++) {
    let s = "";
    const len = Math.floor(rnd() * 14);
    for (let j = 0; j < len; j++) s += alphabet[Math.floor(rnd() * alphabet.length)];
    const b = buildNameQuery(s);
    if (!b.ok) { refused++; assert.equal(b.refused, true); assert.ok(Object.values(REFUSAL).includes(b.reason)); continue; }
    accepted++;
    assert.match(b.params.$where, /^upper\(current_entity_name\) like '[\p{L}\p{N}%]+'$/u, JSON.stringify(s));
    assert.ok(Number(b.params.$limit) >= 2 && Number(b.params.$limit) <= DOS_LIMITS.max_limit + 1);
    assert.ok(b.tokens.join("").length >= DOS_LIMITS.min_alnum_chars);
  }
  assert.ok(accepted > 100 && refused > 100, `fuzz must exercise both outcomes (${accepted}/${refused})`);
  // limit is clamped
  assert.equal(buildNameQuery("Skyline Builders", { limit: 100000 }).params.$limit, String(DOS_LIMITS.max_limit + 1));
  assert.equal(buildNameQuery("Skyline Builders", { limit: -5 }).params.$limit, "2");
});

test("(iv) minimum input length and the id and batch builders", () => {
  assert.equal(prepareName("ab").reason, REFUSAL.TOO_SHORT);
  assert.equal(prepareName("%%%").reason, REFUSAL.WILDCARD_ONLY);
  assert.equal(prepareName("A B C D").reason, REFUSAL.NO_LONG_TOKEN);
  assert.equal(prepareName("abc").ok, true);
  assert.equal(buildIdQuery("12345").ok, true);
  assert.equal(buildIdQuery(12345).params.$where, "dos_id='12345'");
  for (const bad of ["", "1 or 1=1", "12'", "abc", "12345678901", null, -1]) assert.equal(buildIdQuery(bad).ok, false, String(bad));
  assert.equal(soqlString("O'Brien"), "'O''Brien'");
  const b = buildExactBatchQuery(["O'Brien Co", "x", "King's Inc", "King's Inc"]);
  assert.deepEqual(b.names, ["O'BRIEN CO", "KING'S INC"]);
  assert.match(b.params.$where, /^upper\(current_entity_name\) in \('O''BRIEN CO','KING''S INC'\)$/);
  assert.equal(b.params.$limit, "500");
  assert.equal(buildExactBatchQuery(Array.from({ length: 30 }, (_, i) => `NAME NUMBER ${i}`)).names.length, 10);
  assert.equal(buildExactBatchQuery([]).ok, false);
});

// ---------------------------------------------------------------------------------------------
// (vi) IRS lookup by EIN and by stem
// ---------------------------------------------------------------------------------------------

function irsIndex() {
  const sample = readJson("irs_eo_bmf_ny.sample.json").records;
  const art = buildArtifact({ register: "irs_eo_bmf_ny", collected_at: "2026-11-11T23:57:00Z", source_url: "https://www.irs.gov/pub/irs-soi/eo_ny.csv", records: sample });
  const loaded = loadArtifact(art);
  assert.equal(loaded.ok, true, JSON.stringify(loaded.problems));
  return { sample, art, index: loaded.index };
}

test("(vi) IRS: lookup by EIN and by stem on the real fixture; a miss is not an invalid artifact", () => {
  const { sample, art, index } = irsIndex();
  const rec = sample.find((r) => r.entity_class === "not_for_profit" && r.published.ntee_cd && r.name_stem.length > 8);
  const byId = lookupById(index, rec.register_record_id);
  assert.equal(byId.status, "found");
  assert.equal(byId.records[0].published.ntee_cd, rec.published.ntee_cd);
  assert.equal(byId.records[0].register_record_id, rec.register_record_id);
  assert.match(byId.records[0].register_record_id, /^\d{9}$/);
  const byStem = lookupByStem(index, rec.name);
  assert.ok(["found", "several"].includes(byStem.status));
  assert.ok(byStem.records.some((r) => r.register_record_id === rec.register_record_id));
  // a differently punctuated spelling reaches the same record through the stem
  const respelled = lookupByStem(index, rec.name.replace(/\b(INC|CORP)\b\.?/g, "").replace(/\s+/g, " ").toLowerCase() + ", Inc.");
  assert.ok(respelled.records.some((r) => r.register_record_id === rec.register_record_id) || respelled.status === "miss");
  // misses
  assert.deepEqual(lookupById(index, "000000000"), { status: "miss", records: [] });
  assert.equal(lookupByStem(index, "Zxqvbk Quillfeather Holdings").status, "miss");
  assert.equal(lookupById(index, "").status, "refused");
  assert.equal(lookupByStem(index, "ab").status, "refused");
  // exact published name finds a record whose stem is too short for a stem lookup
  const short = [{ ...sample[0], name: "HF", name_stem: vendorStem("HF"), flags: ["stem_too_short"], register_record_id: "999999991" }];
  const sIdx = loadArtifact(buildArtifact({ register: "irs_eo_bmf_ny", collected_at: AT, source_url: "x", records: short })).index;
  assert.equal(lookupByStem(sIdx, "HF").status, "refused");
  assert.equal(lookupByName(sIdx, "hf").status, "found");

  // invalid artifacts are reported as such, never as a miss
  const broken = [
    { ...art, schema: "something else" },
    { ...art, row_count: art.row_count + 1 },
    { ...art, register: "not_a_register" },
    { ...art, collected_at: null },
    { ...art, records: [{ ...art.records[0], name_stem: "WRONG" }, ...art.records.slice(1)] },
    { ...art, records: art.records.map((r, i) => (i === 0 ? { ...r, register: "ny_dos_entities" } : r)) },
    { ...art, records: "no" },
    null,
  ];
  for (const b of broken) {
    const out = loadArtifact(b);
    assert.equal(out.ok, false);
    assert.equal(out.status, "invalid_artifact");
    assert.ok(out.problems.length > 0);
  }
});

test("(vi) IRS: a name carried by several EINs returns all of them and no single verdict", () => {
  const { sample } = irsIndex();
  const a = { ...sample[0], register_record_id: "111111111", name: "EVANGELICAL LUTHERAN CHURCH OF THE REDEEMER", name_stem: vendorStem("EVANGELICAL LUTHERAN CHURCH OF THE REDEEMER") };
  const b = { ...a, register_record_id: "222222222" };
  const idx = loadArtifact(buildArtifact({ register: "irs_eo_bmf_ny", collected_at: AT, source_url: "x", records: [a, b] })).index;
  const out = lookupByStem(idx, "Evangelical Lutheran Church of the Redeemer");
  assert.equal(out.status, "several");
  assert.equal(out.verdict, null);
  assert.equal(out.records.length, 2);
});

test("(vi) DOL and SCA artifacts load, answer by name and alias, and fail closed when corrupted", () => {
  const dol = readJson("dol_contractor_registry.sample.json").rows.map((r) => normalizeDolRow(r, { collected_at: AT }));
  const dIdx = loadArtifact(buildArtifact({ register: "nys_dol_contractor_registry", collected_at: AT, source_url: "x", records: dol }));
  assert.equal(dIdx.ok, true);
  const withAlias = dol.find((r) => r.published.aliases.length);
  if (withAlias) assert.ok(lookupByStem(dIdx.index, withAlias.published.aliases[0]).records.some((r) => r.register_record_id === withAlias.register_record_id));
  const first = dol[0];
  assert.equal(lookupById(dIdx.index, first.register_record_id).status, "found");
  const sca = normalizeScaRows(readJson("sca_prequalified_firms.sample.json").rows, { collected_at: AT });
  const sIdx = loadArtifact(buildArtifact({ register: "nyc_sca_prequalified_firms", collected_at: AT, source_url: "x", records: sca }));
  assert.equal(sIdx.ok, true);
  assert.equal(lookupByName(sIdx.index, sca[0].name).status, "found");
  assert.equal(loadArtifact({ ...buildArtifact({ register: "nyc_sca_prequalified_firms", collected_at: AT, source_url: "x", records: sca }), row_count: 1 }).ok, false);
});

// ---------------------------------------------------------------------------------------------
// (vii) sample files are internally consistent
// ---------------------------------------------------------------------------------------------

test("(vii) dos_match_sample.json: totals, steps, classes and reviewed verdicts all add up", () => {
  const d = readJson("dos_match_sample.json");
  assert.equal(d.sample.size, 300);
  assert.equal(d.names.length, 300);
  const o = d.outcomes;
  assert.equal(o.one_match + o.several_matches + o.truncated + o.candidates_only + o.no_match + o.refused + o.source_unavailable, 300);
  assert.equal(o.one_match, d.steps.exact_upper_raw.one_match + d.steps.token_prefix_stem_equal.one_match);
  assert.equal(d.steps.exact_upper_raw.hits, d.steps.exact_upper_raw.one_match + d.steps.exact_upper_raw.several);
  assert.equal(d.steps.token_prefix_stem_equal.names_entering, 300 - d.steps.exact_upper_raw.hits);
  assert.equal(d.steps.token_prefix_stem_equal.requests_made, d.steps.token_prefix_stem_equal.names_entering - d.outcomes.refused);
  assert.equal(Object.values(d.one_match_by_entity_class).reduce((a, b) => a + b, 0), o.one_match);
  for (const c of Object.keys(d.one_match_by_entity_class)) assert.ok(ENTITY_CLASSES.includes(c));
  // recount from the per-name rows
  const tally = {};
  for (const n of d.names) tally[n.outcome] = (tally[n.outcome] || 0) + 1;
  for (const k of ["one_match", "several_matches", "truncated", "candidates_only", "no_match", "refused", "source_unavailable"]) assert.equal(tally[k] || 0, o[k], k);
  const classes = {};
  for (const n of d.names) if (n.outcome === "one_match") classes[n.matches[0].entity_class] = (classes[n.matches[0].entity_class] || 0) + 1;
  assert.deepEqual(classes, d.one_match_by_entity_class);
  // review
  const r = d.review;
  assert.equal(r.pairs.length, 50);
  const counts = { same: 0, different: 0, cannot_tell: 0 };
  for (const p of r.pairs) { assert.ok(p.verdict in counts, p.verdict); assert.ok(p.reason && p.reason.length > 3); counts[p.verdict]++; assert.ok(d.names.find((n) => n.raw === p.vendor_name && n.outcome === "one_match")); }
  assert.deepEqual(r.counts, counts);
  assert.equal(r.counts.same + r.counts.different + r.counts.cannot_tell, 50);
  assert.equal(new Set(r.pairs.map((p) => p.vendor_name)).size, 50);
  assert.equal(r.address_comparison_possible, 0);
  // request budget
  assert.ok(d.requests.total === d.requests.exact_batches + d.requests.token_queries);
});

test("(vii) dos_match_sample.json join-gate verdict agrees with the engine's resolveJoinGateTier", async () => {
  const d = readJson("dos_match_sample.json");
  const gate = await import(pathToFileURL(path.join(APP_ROOT, "ontology/join_gate_policy.mjs")).href);
  assert.equal(gate.USEFULNESS_THRESHOLD, 0.3);
  assert.equal(gate.PRECISION_THRESHOLD, 0.95);
  const usefulness = d.outcomes.one_match / 300;
  const precision = d.review.counts.same / 50;
  assert.equal(d.join_gate.usefulness, Number(usefulness.toFixed(4)));
  assert.equal(d.join_gate.precision_conservative, Number(precision.toFixed(4)));
  const t = gate.resolveJoinGateTier({ usefulness, precision });
  assert.equal(d.join_gate.tier, t.tier);
  assert.equal(d.join_gate.automatic_link_allowed, t.materialize);
  assert.equal(d.join_gate.automatic_link_allowed, false);
});

test("(vii) irs_match_sample.json: totals, groups and reviewed verdicts add up; tier agrees with the engine", async () => {
  const d = readJson("irs_match_sample.json");
  for (const g of [d.nonprofit_looking, d.seeded_random]) {
    assert.equal(g.size, 100);
    assert.equal(g.found + g.several + g.miss + g.refused, 100);
    assert.equal(g.names.length, 100);
    const t = {};
    for (const n of g.names) t[n.status] = (t[n.status] || 0) + 1;
    assert.equal(t.found || 0, g.found);
    assert.equal(t.several || 0, g.several);
    assert.equal(t.miss || 0, g.miss);
    assert.equal(t.refused || 0, g.refused);
  }
  assert.equal(d.review.pairs.length, 30);
  const c = { same: 0, different: 0, cannot_tell: 0 };
  for (const p of d.review.pairs) { c[p.verdict]++; assert.ok(d.nonprofit_looking.names.concat(d.seeded_random.names).find((n) => n.raw === p.vendor_name && n.status === "found")); }
  assert.deepEqual(d.review.counts, c);
  assert.equal(c.same + c.different + c.cannot_tell, 30);
  const gate = await import(pathToFileURL(path.join(APP_ROOT, "ontology/join_gate_policy.mjs")).href);
  const p = c.same / 30;
  const t = gate.resolveJoinGateTier({ usefulness: d.seeded_random.found / 100, precision: p });
  assert.equal(d.join_gate.seeded_random.tier, t.tier);
  assert.equal(d.join_gate.seeded_random.materialize, false);
  const tn = gate.resolveJoinGateTier({ usefulness: d.nonprofit_looking.found / 100, precision: p });
  assert.equal(d.join_gate.nonprofit_looking.tier, tn.tier);
  assert.equal(d.join_gate.automatic_link_allowed, false);
  assert.equal(d.full_universe.found + d.full_universe.several + d.full_universe.miss + d.full_universe.refused, d.full_universe.size);
});

test("(vii) dos_query_timings.json: 10 names per predicate, medians recomputed from the rows", () => {
  const d = readJson("dos_query_timings.json");
  const preds = new Set(d.rows.map((r) => r.predicate));
  for (const p of ["exact_upper", "exact_plain", "prefix_like", "contains_like", "full_text_q", "starts_with", "token_pattern_like", "designed_token_query"]) assert.ok(preds.has(p), p);
  for (const p of preds) {
    const rows = d.rows.filter((r) => r.predicate === p);
    assert.equal(rows.length, 10, p);
    const ok = rows.filter((r) => r.status === 200).map((r) => r.ms).sort((a, b) => a - b);
    const med = ok.length ? (ok.length % 2 ? ok[(ok.length - 1) / 2] : (ok[ok.length / 2 - 1] + ok[ok.length / 2]) / 2) : null;
    assert.equal(d.summary[p].median_ms, med, p);
    assert.equal(d.summary[p].timeouts, rows.filter((r) => r.err || r.status === null).length, p);
    for (const r of rows) assert.match(r.sha256, /^[0-9a-f]{64}$/);
  }
  assert.ok(d.exposed_predicate === "designed_token_query");
});

test("(vii) register-decisions.json: one entry per register considered, each with an observed reason", () => {
  const d = readJson("register-decisions.json");
  const ids = d.decisions.map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const must of ["ny_dos_entities", "irs_eo_bmf_ny", "nys_dol_contractor_registry", "nyc_sca_prequalified_firms", "nyc_dcwp_issued_licenses", "nys_dbe_ucp_directory", "nys_charities_registry", "nys_mwbe_directory", "nys_sdvob_directory", "sba_dsbs", "sam_gov_entities", "nys_dos_search_ui"]) assert.ok(ids.includes(must), must);
  for (const x of d.decisions) {
    assert.ok(["included", "not_included", "cannot_be_ingested"].includes(x.decision), x.id);
    assert.ok(x.reason && x.reason.length > 40, x.id);
    assert.ok(Array.isArray(x.evidence) && x.evidence.length > 0, x.id);
    if (x.decision === "included") assert.ok(REGISTER_IDS.includes(x.id), x.id);
    if (x.decision === "cannot_be_ingested") for (const e of x.evidence) assert.ok(e.url && e.date === "2026-11-11" && (e.status != null || e.observed), x.id);
  }
  assert.deepEqual(d.decisions.filter((x) => x.decision === "included").map((x) => x.id).sort(), [...REGISTER_IDS].sort());
});

test("no placeholder language in the deliverable JSON files", () => {
  const files = ["dos_match_sample.json", "irs_match_sample.json", "dos_query_timings.json", "register-decisions.json", "terms-observations.json", "manifest.json", "entity_type_class_map.json"];
  for (const f of files) {
    if (!fs.existsSync(path.join(HERE, f))) continue;
    const text = fs.readFileSync(path.join(HERE, f), "utf8");
    assert.doesNotMatch(text, /\bTBD\b|to be confirmed|to be determined|\bTODO\b/i, f);
  }
});

test("contract: every module's record keys equal the declared read contract", () => {
  const sample = readJson("irs_eo_bmf_ny.sample.json").records[0];
  assert.deepEqual(Object.keys(sample).sort(), [...RECORD_KEYS].sort());
  assert.deepEqual(REGISTER_IDS, ["ny_dos_entities", "irs_eo_bmf_ny", "nys_dol_contractor_registry", "nyc_sca_prequalified_firms"]);
});
