import { test } from "node:test";
import assert from "node:assert/strict";
import { compileSub, examOpenWindowBand, rowsForCompiledQuery } from "../src/lib/compile.mjs";

test("money + minAmount → City Record award query (request_id diff)", () => {
  const q = compileSub({ lens: "money", filter: { minAmount: 1000000 } }, "2026-06-30");
  assert.equal(q.kind, "award");
  assert.equal(q.idField, "digest_id");
  assert.match(q.params["$where"], /type_of_notice_description='Award'/);
  assert.match(q.params["$where"], /contract_amount >= 1000000/);
});

test("money + keywords → City Record solicitation/RFP query with $q", () => {
  const q = compileSub({ lens: "money", filter: { keywords: ["construction"] } }, "2026-06-30");
  assert.equal(q.kind, "rfp");
  assert.equal(q.idField, "digest_id");
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

test("money + typed agency scope compiles the same agency predicate used by the scope", () => {
  const q = compileSub({ lens: "money", filter: {
    agency: "Housing Preservation and Development",
    noticeType: "award",
    entity_refs_all: ["agency:id:housing-preservation-and-development"],
    connection_relation: "published_by_agency",
  } }, "2026-08-05");
  assert.equal(q.kind, "award");
  assert.match(q.params["$where"], /agency_name='Housing Preservation and Development'/);
  assert.match(q.params["$where"], /type_of_notice_description='Award'/);
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
  assert.equal(q.params["$where"], "ulurp_non IN ('ULURP','ELURP')");
  const ulurpOnly = compileSub({ lens: "land", filter: { procedure: "ulurp", status: "all" } }, "2026-06-30");
  assert.equal(ulurpOnly.params["$where"], "ulurp_non='ULURP'");
  const family = compileSub({ lens: "land", filter: { family: "acquisition", status: "all" } }, "2026-06-30");
  assert.match(family.params["$where"], /ulurp_non IN \('ULURP','ELURP'\)/);
  assert.match(family.params["$where"], /upper\(actions\) like '%PQ%'/);
  assert.equal(family.postFilter({ actions: "PQ" }), true);
  assert.equal(family.postFilter({ actions: "ZM" }), false);
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

test("meetings → materialized read rows, keyword, location, and date window", () => {
  const q = compileSub({
    lens: "meetings",
    filter: { keywords: ["community board"], borough: "Queens", dateWindow: "week" },
  }, "2026-06-30");
  assert.equal(q.kind, "meetings");
  assert.equal(q.url, null);
  assert.equal(q.idField, "meeting_id");
  assert.ok(q.readRows().every((row) => row.request_id === row.meeting_id));
});

test("meeting keywords search the materialized civic context", () => {
  const q = compileSub({
    lens: "meetings",
    filter: { keywords: ["LANDMARKS 2"], borough: "Manhattan" },
  }, "2026-08-01");
  const rows = q.readRows();
  assert.equal(rows.length, 1);
  assert.match(rows[0].search_text, /LANDMARKS 2/i);
  assert.match(rows[0].search_text, /Washington Square/i);
});

test("section-lens agency quotes are SoQL-escaped", () => {
  const q = compileSub({ lens: "rules", filter: { agency: "O'Neill Dept" } }, "2026-06-30");
  assert.match(q.params["$where"], /agency_name='O''Neill Dept'/);
});

test("meeting subscriptions replay the shared materialized projection", () => {
  const q = compileSub({ lens: "meetings", filter: {} }, "2026-06-30");
  assert.equal(q.kind, "meetings");
  assert.equal(q.idField, "meeting_id");
  assert.equal(q.url, null);
  const rows = q.readRows();
  assert.ok(rows.length > 0);
  assert.ok(rows.every((row) => row.request_id === row.meeting_id));
});

test("an un-offered lens compiles to null (cron skips it)", () => {
  assert.equal(compileSub({ lens: "people", filter: { lookupType: "person", keywords: ["rodriguez"] } }, "2026-06-30"), null);
  assert.equal(compileSub({ lens: "nonsense", filter: {} }, "2026-06-30"), null);
});

test("meetings exact matter compiles to the retained native reader", () => {
  const q = compileSub({
    lens: "meetings",
    filter: { matter_ref: "legistar:nyc:matter:79200", matter_scope_version: 1 },
  }, "2026-08-10");
  assert.equal(q.kind, "council-matter");
  assert.equal(q.nativeReader, "matter-observation-journal");
  assert.equal(q.url, null);
  assert.deepEqual(q.params, {});
  assert.equal(compileSub({
    lens: "meetings",
    filter: { matter_ref: "legistar:nyc:matter:79200", keywords: ["hearings"] },
  }, "2026-08-10"), null);
});

test("legal_code compiles an exact provision replay and rejects broadening extras", () => {
  const q = compileSub({
    lens: "legal_code",
    filter: { provision_id: "nyc-administrative-code:16-120" },
  }, "2026-11-01");
  assert.equal(q.kind, "legal_code");
  assert.equal(q.idField, "alert_id");
  assert.match(q.url, /code_provision_watch_events\.json/);
  assert.equal(compileSub({ lens: "legal_code", filter: {} }, "2026-11-01"), null);
  assert.equal(compileSub({
    lens: "legal_code",
    filter: { provision_id: "nyc-administrative-code:16-120", keywords: ["housing"] },
  }, "2026-11-01"), null);
});

test("exam interest-area watch replays the staffing artifact and keys NOE-posted transitions", () => {
  const q=compileSub({lens:"people",filter:{view:"guide",interestArea:"public-safety"}},"2026-08-03");
  assert.equal(q.kind,"exam");
  assert.equal(q.idField,"alert_id");
  assert.match(q.url,/staffing_exams\.json/);
  const rows=q.transformRows({exams:[
    {exam_number:"7001",title:"Officer",interest_area:"public-safety",application_start:"2026-08-10",application_end:"2026-08-20",notice_url:"https://example.test/noe"},
    {exam_number:"7002",title:"Nurse",interest_area:"health-care",application_start:"2026-08-10",application_end:"2026-08-20"},
  ]});
  assert.equal(rows.length,1);
  assert.equal(rows[0].alert_id,"exam:7001:noe-posted");
  assert.equal(rows[0].open_window_band,"imminent");
  assert.equal(examOpenWindowBand({application_start:"2026-11-02",application_end:"2026-11-16"},"2026-08-03"),"far");
  assert.equal(examOpenWindowBand({application_start:"2026-10-01",application_end:"2026-10-15"},"2026-08-03"),"approaching");
});

test("agency-scoped exam watch returns certified exams only", () => {
  const q = compileSub({
    lens: "people",
    filter: { view: "guide", agency: "Parks and Recreation" },
  }, "2026-08-03");
  const rows = q.transformRows({ exams: [
    { exam_number: "1003", title: "Certified Parks exam", application_start: "2026-09-01", application_end: "2026-09-30" },
    { exam_number: "9998", title: "Unrelated exam", application_start: "2026-09-01", application_end: "2026-09-30" },
  ] });
  assert.deepEqual(rows.map((row) => row.exam_number), ["1003"]);
});

test("entity/vendor → full-text stem query + exact-stem postFilter", () => {
  const q = compileSub({ lens: "entity", filter: { kind: "vendor", name: "Sinergia Inc" } }, "2026-07-02");
  assert.equal(q.kind, "entity");
  assert.equal(q.idField, "digest_id");
  assert.equal(q.params["$q"], "SINERGIA"); // $q not LIKE: punctuated vendor_names must still match
  assert.equal(typeof q.postFilter, "function");
  assert.ok(q.postFilter({ vendor_name: "Sinergia Incorporated" }), "variant matches stem");
  assert.ok(q.postFilter({ vendor_name: "SINERGIA, INC." }), "punctuation variant matches");
  assert.ok(!q.postFilter({ vendor_name: "Sinergia Partners LLC" }), "different stem rejected");
});

test("entity/project → exact project calendar read model", () => {
  const q = compileSub({
    lens: "entity",
    filter: { entity_refs_all: ["project:2026M0001"] },
  }, "2026-08-27");
  assert.equal(q.kind, "project-calendar");
  assert.equal(q.idField, "uid");
  assert.equal(q.url, null);
  assert.deepEqual(q.routeReadModel, {
    kind: "project-calendar",
    project_id: "2026M0001",
    todayISO: "2026-08-27",
  });
  assert.equal(compileSub({
    lens: "entity",
    filter: { entity_refs_all: ["project:2026M0001"], name: "ambiguous" },
  }, "2026-08-27"), null);
});

test("project calendar replay loads the current outcome and projects its milestones", async () => {
  const q = compileSub({
    lens: "entity",
    filter: { entity_refs_all: ["project:2022M0258"] },
  }, "2026-08-27");
  const rows = await rowsForCompiledQuery(q, {
    ALERT_STATE: {
      async get() {
        return JSON.stringify({
          project_id: "2022M0258",
          project_name: "Canal Street rezoning",
          portal_url: "https://zap.planning.nyc.gov/projects/2022M0258",
          milestones: [{
            id: "cpc-review",
            title: "CPC review",
            time: { value: "2026-09-18", basis: "review_meeting" },
          }],
        });
      },
    },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "CPC review");
  assert.equal(rows[0].source.system, "zap-api-outcomes");
  assert.equal(rows[0].provenance.connected_relation, "project_process");
});

test("money + procurement_id compiles the shared snapshot, not City Record SODA", () => {
  const q = compileSub({
    lens: "money",
    filter: { procurement_id: "procurement:contract:CT101520271400806", noticeType: "award" },
  }, "2026-08-18");
  assert.equal(q.kind, "award");
  assert.equal(q.idField, "digest_id");
  assert.equal(q.url, null);
  assert.equal(typeof q.readRows, "function");
  assert.equal(typeof q.mergeRows, "function");
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

test("award queries carry keywords (w6-16: SODA fallback must match the D1 path's filtering)", () => {
  const q = compileSub({ lens: "money", filter: { minAmount: 500000, keywords: ["construction"] } }, "2026-06-30");
  assert.equal(q.kind, "award");
  // Without this, a construction-$500k watch on the SODA fallback receives ALL awards >= $500k.
  assert.equal(q.params["$q"], "construction");
});
