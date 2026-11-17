/**
 * A money-lens watch that carries one canonical agency ref follows that agency by identity, for solicitations only.
 * Real City Record rows (the 202 open solicitations of 2026-11-17 and every notice since 2026-10-01) are loaded into
 * SQLite and the compiled predicates run as SQL, on both delivery paths: the SODA descriptor (compileSub) and the D1
 * mirror (compileSub_d1 + buildNoticesQuery).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { compileSub } from "../worker/src/lib/compile.mjs";
import { compileSub_d1, toDigestRow } from "../worker/src/lib/compile_d1.mjs";
import { prepareWatchFilter } from "../worker/src/lib/filter.mjs";
import { buildNoticesQuery } from "../worker/src/lib/notices.mjs";
import { mergeSolicitationCoverageRows } from "../worker/src/lib/solicitation_coverage.mjs";
import { resolveAgencyIdentity } from "../site/agency_identity.mjs";
import { composeWatchRuleSentence } from "../site/following_view.mjs";
import {
  exactInstitutionFollow,
  exactInstitutionNoticeMatches,
  institutionCandidateSpellings,
  institutionCandidateTokens,
  moneyAgencyScope,
} from "../site/institution_follow_scope.mjs";

const TODAY = "2026-11-16";
const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/money_agency_ref/${name}`, import.meta.url), "utf8"));
const open = load("open-list.live-2026-11-17.json").notices;
const recent = load("recent-all-types.live-2026-11-17.json").rows;
const spellings = load("agency-spellings.live-2026-11-17.json").spellings;

// One store: the open solicitations plus every recent notice, one row per request id.
const store = [...new Map([...recent, ...open].map((row) => [row.request_id, row])).values()];
const agencyIds = [...new Set(open.map((row) => resolveAgencyIdentity(row.agency_name).canonical_id))];

const db = new DatabaseSync(":memory:");
db.exec(`CREATE TABLE cr (request_id TEXT, start_date TEXT, agency_name TEXT, type_of_notice_description TEXT, section_name TEXT,
  short_title TEXT, due_date TEXT, category_description TEXT, selection_method_description TEXT, pin TEXT)`);
db.exec(`CREATE TABLE notices (request_id TEXT, start_date TEXT, agency TEXT, type_of_notice TEXT, section TEXT, short_title TEXT,
  due_date TEXT, category TEXT, selection_method TEXT, pin TEXT, contract_amount REAL, contract_amount_valid INTEGER, vendor_name TEXT,
  special_case_reason TEXT, due_year INTEGER, haystack TEXT)`);
const insertCr = db.prepare("INSERT INTO cr VALUES (?,?,?,?,?,?,?,?,?,?)");
const insertD1 = db.prepare("INSERT INTO notices VALUES (?,?,?,?,?,?,?,?,?,?,NULL,0,NULL,NULL,?,?)");
for (const row of store) {
  insertCr.run(row.request_id, row.start_date ?? null, row.agency_name ?? null, row.type_of_notice_description ?? null, row.section_name ?? null,
    row.short_title ?? null, row.due_date ?? null, row.category_description ?? null, row.selection_method_description ?? null, row.pin ?? null);
  insertD1.run(row.request_id, row.start_date ?? null, row.agency_name ?? null, row.type_of_notice_description ?? null, row.section_name ?? null,
    row.short_title ?? null, row.due_date ?? null, row.category_description ?? null, row.selection_method_description ?? null, row.pin ?? null,
    row.due_date ? Number(String(row.due_date).slice(0, 4)) : null, `${row.short_title ?? ""} ${row.agency_name ?? ""}`.toLowerCase());
}

const refFilter = (id, extra = {}) => ({ noticeType: "solicitation", entity_refs_all: [`agency:id:${id}`], ...extra });
const sub = (filter, lens = "money") => ({ lens, filter });
const follows = (id) => exactInstitutionFollow(id);
const truth = (id, rows = store) => rows.filter((row) => exactInstitutionNoticeMatches(follows(id), row) && row.type_of_notice_description === "Solicitation" && row.due_date > TODAY);

/** Run a compiled SODA descriptor against the SQLite copy of the City Record, the way delivery does (due page + recent page). */
function runSoda(q) {
  const page = (params) => {
    const where = params.$where;
    const order = params.$order === "start_date DESC" ? "start_date DESC" : "due_date ASC";
    return db.prepare(`SELECT * FROM cr WHERE ${where} ORDER BY ${order} LIMIT ${Number(params.$limit)}`).all();
  };
  let rows = page(q.params);
  if (q.recentParams) rows = mergeSolicitationCoverageRows(rows, page(q.recentParams), { idField: q.idField, cap: q.coverageCap });
  return q.postFilter ? rows.filter(q.postFilter) : rows;
}
/** The D1 fast path as alerts.mjs runs it (buildNoticesQuery SQL, toDigestRow, postFilter, coverage merge). */
function runD1(compiled) {
  const run = (opts) => {
    const { sql, params } = buildNoticesQuery(opts);
    return db.prepare(sql).all(...params).map(toDigestRow);
  };
  let rows = run(compiled.opts);
  if (compiled.postFilter) rows = rows.filter(compiled.postFilter);
  if (compiled.coverageOpts) {
    let recentRows = run(compiled.coverageOpts);
    if (compiled.postFilter) recentRows = recentRows.filter(compiled.postFilter);
    rows = mergeSolicitationCoverageRows(rows, recentRows, { idField: "digest_id" });
  }
  return rows;
}
const ids = (rows) => rows.map((row) => row.request_id).sort();

test("store sanity: the fixtures hold the 202 open solicitations, other notice types, and 21 agencies", () => {
  assert.equal(open.length, 202);
  assert.equal(agencyIds.length, 21);
  assert.ok(store.length > 202);
  assert.ok(new Set(store.map((row) => row.type_of_notice_description)).size >= 6);
});

// Delivery reads a bounded page, not the whole set: the 25 soonest due plus the 25 most recently published (cap 50), the
// engine's existing coverage rule for every open-solicitation watch. So: nothing outside the agency, ever; every open
// solicitation when the agency has 25 or fewer; at least 25 when it has more (the soonest due are always in).
function assertPage(got, id, label) {
  const want = ids(truth(id));
  const have = ids(got);
  assert.ok(have.every((requestId) => want.includes(requestId)), `${label} ${id}: nothing outside the agency`);
  if (want.length <= 25) assert.deepEqual(have, want, `${label} ${id}`);
  else {
    assert.ok(have.length >= 25, `${label} ${id}: ${have.length} of ${want.length}`);
    const soonest = truth(id).sort((a, b) => a.due_date.localeCompare(b.due_date)).slice(0, 20).map((row) => row.request_id);
    assert.ok(soonest.every((requestId) => have.includes(requestId)), `${label} ${id}: the soonest due are in`);
  }
}

test("every one of today's 21 agencies: the SODA path and the D1 path each return its open solicitations and nothing else", () => {
  let paged = 0;
  for (const id of agencyIds) {
    assert.ok(truth(id).length >= 1, `${id} has an open solicitation`);
    assertPage(runSoda(compileSub(sub(refFilter(id)), TODAY)), id, "SODA");
    assertPage(runD1(compileSub_d1(sub(refFilter(id)), TODAY)), id, "D1");
    if (truth(id).length > 25) paged += 1;
  }
  assert.equal(paged, 2, "design-and-construction (45) and health-and-mental-hygiene (34) are read in pages");
});

test("the product's filter (a spelling hint beside the ref) behaves the same as the bare ref", () => {
  for (const id of agencyIds) {
    const spelling = open.find((row) => resolveAgencyIdentity(row.agency_name).canonical_id === id).agency_name;
    const withHint = refFilter(id, { agency: spelling });
    assert.deepEqual(ids(runSoda(compileSub(sub(withHint), TODAY))), ids(runSoda(compileSub(sub(refFilter(id)), TODAY))), id);
    assert.deepEqual(ids(runD1(compileSub_d1(sub(withHint), TODAY))), ids(runD1(compileSub_d1(sub(refFilter(id)), TODAY))), id);
  }
});

test("solicitations only: awards, hearings, notices and closed solicitations of the same agency are not returned", () => {
  let checked = 0;
  for (const id of agencyIds) {
    const others = store.filter((row) => exactInstitutionNoticeMatches(follows(id), row) && !(row.type_of_notice_description === "Solicitation" && row.due_date > TODAY));
    if (!others.length) continue;
    checked += others.length;
    const got = new Set(ids(runSoda(compileSub(sub(refFilter(id)), TODAY))).concat(ids(runD1(compileSub_d1(sub(refFilter(id)), TODAY)))));
    for (const row of others) assert.equal(got.has(row.request_id), false, `${id}: ${row.type_of_notice_description} ${row.request_id}`);
  }
  assert.ok(checked > 100, `the store holds ${checked} other-type or closed rows of these agencies`);
});

test("related bodies and look-alike spellings are not returned: the identity test decides, the candidate set only narrows", () => {
  // "Transportation" must not pick up the Metropolitan Transportation Authority; "Education" not the Board of Education Retirement System.
  for (const [id, lookalike] of [["transportation", "Metropolitan Transportation Authority"], ["education", "Board of Education Retirement System"], ["housing-authority", "Housing Preservation and Development"]]) {
    const candidate = db.prepare(`SELECT count(*) AS n FROM cr WHERE ${compileSub(sub(refFilter(id)), TODAY).params.$where.split(" AND ").slice(2).join(" AND ")}`).get().n;
    assert.ok(candidate >= truth(id).length);
    const got = runSoda(compileSub(sub(refFilter(id)), TODAY));
    assert.equal(got.some((row) => row.agency_name === lookalike), false, lookalike);
    assert.equal(runD1(compileSub_d1(sub(refFilter(id)), TODAY)).some((row) => row.agency_name === lookalike), false, lookalike);
  }
});

test("candidate set is wider than the agency by little: extra rows the SQL returns before the identity filter", () => {
  let worst = 0;
  for (const id of agencyIds) {
    const q = compileSub(sub(refFilter(id)), TODAY);
    const sql = db.prepare(`SELECT request_id, agency_name FROM cr WHERE ${q.params.$where}`).all();
    const extra = sql.filter((row) => !exactInstitutionNoticeMatches(follows(id), row)).length;
    worst = Math.max(worst, extra);
  }
  assert.ok(worst <= 5, `at most 5 candidate rows per agency are dropped by the identity filter (worst ${worst})`);
});

test("spelling recall: every spelling published since 2026-10-01 that resolves to an agency is in its candidate set; history reported", () => {
  const inSet = (follow, name) => institutionCandidateSpellings(follow).includes(name)
    || (institutionCandidateTokens(follow).length > 0 && institutionCandidateTokens(follow).every((token) => name.toUpperCase().includes(token)));
  const recentNames = [...new Set(recent.map((row) => row.agency_name).concat(open.map((row) => row.agency_name)))];
  const missed = [];
  for (const name of recentNames) {
    const follow = follows(resolveAgencyIdentity(name).canonical_id);
    if (follow.status === "ok" && exactInstitutionNoticeMatches(follow, { agency_name: name }) && !inSet(follow, name)) missed.push(name);
  }
  assert.deepEqual(missed, []);
  // History: spellings the resolver maps to an agency but the candidate set cannot reach (retired spellings and pattern-matched
  // groups such as the community colleges). Reported, not hidden: a new notice under one of these would not be found.
  let all = 0;
  const historical = [];
  for (const { agency_name: name } of spellings) {
    if (!name) continue;
    const follow = follows(resolveAgencyIdentity(name).canonical_id);
    if (follow.status !== "ok" || !exactInstitutionNoticeMatches(follow, { agency_name: name })) continue;
    all += 1;
    if (!inSet(follow, name)) historical.push(name);
  }
  assert.ok(all >= 300);
  assert.ok(historical.length <= 25, `historical spellings not reached: ${historical.length} of ${all}`);
});

test("the baseline problem this replaces: the entity follow's own spelling list does not reach H+H, EDC, Navy Yard or City University", () => {
  for (const id of ["nyc-health-hospitals", "economic-development-corporation", "brooklyn-navy-yard-development-corp", "city-university"]) {
    const follow = follows(id);
    const printed = open.filter((row) => exactInstitutionNoticeMatches(follow, row));
    assert.ok(printed.length >= 1);
    assert.equal(printed.some((row) => follow.publisher_names.includes(row.agency_name)), false, `${id}: publisher_names alone find none of its open notices`);
    assert.ok(printed.every((row) => institutionCandidateTokens(follow).every((token) => row.agency_name.toUpperCase().includes(token))), `${id}: the candidate words do`);
  }
});

test("fail closed: an agency ref that cannot be honoured exactly means the watch does not compile, on both paths", () => {
  const refused = [
    refFilter("environmental-protection", { entity_refs_all: ["agency:id:environmental-protection", "agency:id:education"] }),
    { noticeType: "solicitation", entity_refs_all: ["agency:name:environmental-protection"] },
    { noticeType: "solicitation", entity_refs_all: ["agency:id:brooklyn-cb-15"] },
    refFilter("environmental-protection", { text_query: { v: 1, all: ["pipe"] } }),
    refFilter("environmental-protection", { procurement_id: "ABC123" }),
  ];
  for (const filter of refused) {
    assert.equal(compileSub(sub(filter), TODAY), null, JSON.stringify(filter));
    assert.equal(compileSub_d1(sub(filter), TODAY), null, JSON.stringify(filter));
  }
  assert.equal(moneyAgencyScope({ entity_refs_all: ["agency:id:a", "agency:id:b"] }).status, "unsupported");
  assert.equal(moneyAgencyScope({ entity_refs_all: ["vendor:stem:acme"] }).status, "none");
  assert.equal(moneyAgencyScope({}).status, "none");
});

test("a filter with no agency ref compiles exactly as before", () => {
  const exact = compileSub(sub({ noticeType: "solicitation", agency: "Environmental Protection" }), TODAY);
  assert.equal(exact.params.$where, `type_of_notice_description='Solicitation' AND due_date > '${TODAY}' AND agency_name='Environmental Protection'`);
  assert.equal(Object.hasOwn(exact, "postFilter"), false);
  const d1 = compileSub_d1(sub({ noticeType: "solicitation", agency: "Environmental Protection" }), TODAY);
  assert.equal(d1.opts.agency, "Environmental Protection");
  assert.equal(Object.hasOwn(d1.opts, "agencyAny"), false);
  assert.equal(d1.postFilter, undefined);
  const plain = compileSub(sub({ noticeType: "solicitation", keywords: ["pipe"] }), TODAY);
  assert.equal(plain.params.$where, `type_of_notice_description='Solicitation' AND due_date > '${TODAY}'`);
});

test("awards: the same agency scope applies to an award watch", () => {
  const id = "environmental-protection";
  const q = compileSub(sub({ noticeType: "award", entity_refs_all: [`agency:id:${id}`] }), TODAY);
  assert.match(q.params.$where, /type_of_notice_description='Award'/);
  assert.match(q.params.$where, /upper\(agency_name\) like '%ENVIRONMENTAL%'/);
  assert.equal(typeof q.postFilter, "function");
});

test("the saved shape survives the engine's own filter sanitizer and reads as a solicitation follow", () => {
  const filter = refFilter("environmental-protection", { agency: "Environmental Protection" });
  const prepared = prepareWatchFilter("money", filter);
  assert.equal(prepared.ok, true);
  const kept = prepared.filter ?? prepared;
  assert.deepEqual(kept.entity_refs_all, ["agency:id:environmental-protection"]);
  assert.equal(kept.noticeType, "solicitation");
  assert.equal(kept.agency, "Environmental Protection");
  assert.match(composeWatchRuleSentence("money", filter), /from Environmental Protection for open solicitations/);
});

test("compiled output is deterministic and carries no unescaped input", () => {
  const first = compileSub(sub(refFilter("teachers-retirement-system")), TODAY).params.$where;
  assert.equal(first, compileSub(sub(refFilter("teachers-retirement-system")), TODAY).params.$where);
  assert.match(first, /agency_name in \('Teachers'' Retirement System'/);
  assert.doesNotMatch(first, /[^']'Teachers' Retirement/);
});
