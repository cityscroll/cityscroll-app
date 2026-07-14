import { test } from "node:test";
import assert from "node:assert/strict";
import { compileSub } from "../src/lib/compile.mjs";

test("money + minAmount → City Record award query (request_id diff)", () => {
  const q = compileSub({ lens: "money", filter: { minAmount: 1000000 } }, "2026-06-30");
  assert.equal(q.kind, "award");
  assert.equal(q.idField, "request_id");
  assert.match(q.params["$where"], /type_of_notice_description='Award'/);
  assert.match(q.params["$where"], /contract_amount >= 1000000/);
});

test("money + keywords → City Record solicitation/RFP query with $q", () => {
  const q = compileSub({ lens: "money", filter: { keywords: ["construction"] } }, "2026-06-30");
  assert.equal(q.kind, "rfp");
  assert.equal(q.idField, "request_id");
  assert.match(q.params["$where"], /type_of_notice_description='Solicitation'/);
  assert.match(q.params["$where"], /due_date > '2026-06-30'/);
  assert.equal(q.params["$q"], "construction");
});

test("money + agency → agency_name clause applied to both the award and solicitation branches", () => {
  const award = compileSub({ lens: "money", filter: { minAmount: 1000000, agency: "Parks and Recreation" } }, "2026-06-30");
  assert.match(award.params["$where"], /agency_name='Parks and Recreation'/);
  const rfp = compileSub({ lens: "money", filter: { agency: "Buildings" } }, "2026-06-30");
  assert.match(rfp.params["$where"], /agency_name='Buildings'/);
});

test("money + noticeType='award' with NO amount → still the award branch (closes the old amount-implies-type gap)", () => {
  const q = compileSub({ lens: "money", filter: { noticeType: "award", agency: "Sanitation" } }, "2026-06-30");
  assert.equal(q.kind, "award");
  assert.match(q.params["$where"], /type_of_notice_description='Award'/);
  assert.match(q.params["$where"], /agency_name='Sanitation'/);
});

test("money + noticeType='solicitation' overrides the amount-presence heuristic", () => {
  const q = compileSub({ lens: "money", filter: { noticeType: "solicitation", minAmount: 500000 } }, "2026-06-30");
  assert.equal(q.kind, "rfp");
  assert.match(q.params["$where"], /type_of_notice_description='Solicitation'/);
});

test("money + months → due-window upper bound applied to the solicitation branch", () => {
  const q = compileSub({ lens: "money", filter: { months: 3 } }, "2026-06-30");
  assert.match(q.params["$where"], /due_date > '2026-06-30'/);
  assert.match(q.params["$where"], /due_date <= '2026-09-30'/);
});

test("money: category + agency + keywords + noticeType + months all compile together (no one field wins at the expense of the others)", () => {
  const q = compileSub({ lens: "money", filter: {
    keywords: ["construction"], agency: "Buildings", category: "Construction/Construction Services",
    noticeType: "solicitation", months: 2,
  } }, "2026-06-30");
  assert.equal(q.kind, "rfp");
  assert.match(q.params["$where"], /type_of_notice_description='Solicitation'/);
  assert.match(q.params["$where"], /agency_name='Buildings'/);
  assert.match(q.params["$where"], /category_description='Construction\/Construction Services'/);
  assert.match(q.params["$where"], /due_date <= '2026-08-30'/);
  assert.equal(q.params["$q"], "construction");
});

test("land → ZAP query (project_id diff), place alias applied", () => {
  const q = compileSub({ lens: "land", filter: { keywords: ["79 Rivington"], status: "all" } }, "2026-06-30");
  assert.equal(q.kind, "rezone");
  assert.equal(q.idField, "project_id");
  assert.match(q.url, /hgx4-8ukb/);
  assert.equal(q.params["$q"], "Allen Street"); // alias mapped
});

test("rules → City Record section query with agency + $q", () => {
  const q = compileSub({ lens: "rules", filter: { keywords: ["scaffold"], agency: "Buildings" } }, "2026-06-30");
  assert.equal(q.kind, "rules");
  assert.equal(q.idField, "request_id");
  assert.match(q.params["$where"], /section_name='Agency Rules'/);
  assert.match(q.params["$where"], /agency_name='Buildings'/);
  assert.equal(q.params["$q"], "scaffold");
});

test("property → Property Disposition section query, newest first", () => {
  const q = compileSub({ lens: "property", filter: {} }, "2026-06-30");
  assert.equal(q.kind, "property");
  assert.match(q.params["$where"], /section_name='Property Disposition'/);
  assert.equal(q.params["$order"], "start_date DESC");
  assert.equal(q.params["$q"], undefined);
});

test("meetings → upcoming events only, soonest first", () => {
  const q = compileSub({ lens: "meetings", filter: { keywords: ["community board"] } }, "2026-06-30");
  assert.equal(q.kind, "meetings");
  assert.match(q.params["$where"], /section_name='Public Hearings and Meetings'/);
  assert.match(q.params["$where"], /event_date > '2026-06-30'/);
  assert.equal(q.params["$order"], "event_date ASC");
  assert.equal(q.params["$q"], "community board");
});

test("section-lens agency quotes are SoQL-escaped", () => {
  const q = compileSub({ lens: "rules", filter: { agency: "O'Neill Dept" } }, "2026-06-30");
  assert.match(q.params["$where"], /agency_name='O''Neill Dept'/);
});

test("section-lens select carries event_date + street_address_1 for the digest", () => {
  const q = compileSub({ lens: "meetings", filter: {} }, "2026-06-30");
  assert.match(q.params["$select"], /event_date/);
  assert.match(q.params["$select"], /street_address_1/);
});

test("an un-offered lens compiles to null (cron skips it)", () => {
  assert.equal(compileSub({ lens: "people", filter: { lookupType: "person", keywords: ["rodriguez"] } }, "2026-06-30"), null);
  assert.equal(compileSub({ lens: "nonsense", filter: {} }, "2026-06-30"), null);
});

test("entity/vendor → full-text stem query + exact-stem postFilter", () => {
  const q = compileSub({ lens: "entity", filter: { kind: "vendor", name: "Sinergia Inc" } }, "2026-07-02");
  assert.equal(q.kind, "entity");
  assert.equal(q.idField, "request_id");
  assert.equal(q.params["$q"], "SINERGIA"); // $q not LIKE: punctuated vendor_names must still match
  assert.equal(typeof q.postFilter, "function");
  assert.ok(q.postFilter({ vendor_name: "Sinergia Incorporated" }), "variant matches stem");
  assert.ok(q.postFilter({ vendor_name: "SINERGIA, INC." }), "punctuation variant matches");
  assert.ok(!q.postFilter({ vendor_name: "Sinergia Partners LLC" }), "different stem rejected");
});

test("entity/agency → exact agency query, all sections", () => {
  const q = compileSub({ lens: "entity", filter: { kind: "agency", name: "Design and Construction" } }, "2026-07-02");
  assert.match(q.params["$where"], /agency_name='Design and Construction'/);
  assert.ok(!/section_name/.test(q.params["$where"]), "follows the agency across every section");
  assert.equal(q.postFilter, undefined);
});

test("entity: empty or too-short names compile to null", () => {
  assert.equal(compileSub({ lens: "entity", filter: { kind: "vendor", name: "" } }, "2026-07-02"), null);
  assert.equal(compileSub({ lens: "entity", filter: { kind: "vendor", name: "AB" } }, "2026-07-02"), null);
});

test("entityvendor: a punctuated vendor name must match its own row (DEMATTEIS bug)", () => {
  const q = compileSub({ lens: "entity", filter: { kind: "vendor", name: "Leon D. Dematteis Construction Corp" } }, "2026-06-30");
  // The compiled query must be able to select the vendor's own row. The stem strips
  // punctuation but vendor_name keeps it, so a stem-prefix LIKE can never match
  // "LEON D. DEMATTEIS CONSTRUCTION CORP" — the watch silently matched nothing.
  const row = { vendor_name: "LEON D. DEMATTEIS CONSTRUCTION CORP" };
  const toks = (s) => String(s).toUpperCase().replace(/[^A-Z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  if (q.params.$q) {
    const hay = new Set(toks(row.vendor_name));
    assert.ok(toks(q.params.$q).every(t => hay.has(t)), "$q tokens all present in the vendor's own name");
  } else {
    const m = /upper\(vendor_name\) like '([^']*)%'/.exec(q.params.$where || "");
    assert.ok(m && row.vendor_name.toUpperCase().startsWith(m[1]), "server-side match must accept the vendor's own name");
  }
  assert.ok(!q.postFilter || q.postFilter(row), "postFilter keeps the vendor's own row");
});
