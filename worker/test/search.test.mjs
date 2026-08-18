import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import worker from "../src/worker.mjs";
import {
  buildUniversalSearchCoverageView,
  renderUniversalSearchCoverageHtml,
} from "../../site/universal_search_coverage_receipt.mjs";

const NOTICE_SCHEMA = readFileSync(new URL("../migrations/0001_notices.sql", import.meta.url), "utf8");
const FACTS_SCHEMA = readFileSync(new URL("../migrations/0010_notice_facts.sql", import.meta.url), "utf8");
const FTS_SCHEMA = readFileSync(new URL("../migrations/0016_notice_fts.sql", import.meta.url), "utf8");

function database(rows) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(NOTICE_SCHEMA);
  sqlite.exec(FACTS_SCHEMA);
  const add = sqlite.prepare(`INSERT INTO notices
    (request_id, section, agency, type_of_notice, short_title, description,
     start_date, haystack, document_urls, n_documents)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', 0)`);
  for (const row of rows) add.run(
    row.id, row.section, row.agency, row.noticeType, row.title, row.description,
    row.date, row.haystack,
  );
  sqlite.exec(FTS_SCHEMA);
  return {
    sqlite,
    DB: {
      prepare(sql) {
        const statement = sqlite.prepare(sql);
        let args = [];
        const wrapper = {
          bind(...values) { args = values; return wrapper; },
          async all() { return { results: statement.all(...args), meta: { rows_read: 1 } }; },
          async first() { return statement.get(...args) ?? null; },
        };
        return wrapper;
      },
    },
  };
}

const ROWS = [
  {
    id: "20260807025", section: "Procurement", agency: "Police Department",
    noticeType: "Solicitation", title: "NYPD Police Officer Hats", description: "Police equipment procurement.",
    date: "2026-08-14", haystack: "nypd police officer hats police equipment procurement",
  },
  {
    id: "20260729004", section: "Public Hearings and Meetings", agency: "City Council",
    noticeType: "Public Hearing", title: "Subcommittee on Zoning and Franchises meeting", description: "Public zoning hearing.",
    date: "2026-08-06", haystack: "subcommittee zoning franchises meeting public hearing",
  },
  {
    id: "20260804027", section: "Procurement", agency: "Social Services",
    noticeType: "Award", title: "Repository Firewall", description: "Agency budget object code for a current contract.",
    date: "2026-08-10", haystack: "repository firewall agency budget object code current contract award",
  },
  {
    id: "20260710020", section: "Public Comment on Contract Awards", agency: "Health and Mental Hygiene",
    noticeType: "Notice", title: "Pesticides and Mosquito Control Products", description: "E-PIN: 81626S0021001.",
    date: "2026-07-17", haystack: "pesticides mosquito control contract award 81626S0021001",
  },
  {
    id: "20260730029", section: "Public Comment on Contract Awards", agency: "Police Department",
    noticeType: "Notice", title: "Maintenance, support services, software assurance for PhotoManager",
    description: "The NYPD proposed contract has E-PIN: 05626S0013001.",
    date: "2026-08-06", haystack: "maintenance support services software assurance photomanager nypd",
  },
  {
    id: "20260807032", section: "Public Comment on Contract Awards", agency: "Police Department",
    noticeType: "Notice", title: "Fixed Wing aircraft program management support services.",
    description: "The NYPD proposed contract has E-PIN: 05626S0012.",
    date: "2026-08-14", haystack: "fixed wing aircraft police contract 05626S0012",
  },
  {
    id: "20260731016", section: "Public Comment on Contract Awards", agency: "Police Department",
    noticeType: "Notice", title: "Fire Alarm Maintenance and Repair for Manhattan and Bronx",
    description: "The NYPD proposed contract has E-PIN: 05626W0023001.",
    date: "2026-08-07", haystack: "fire alarm maintenance repair police contract 05626W0023001",
  },
  {
    id: "20260728026", section: "Agency Rules", agency: "Buildings",
    noticeType: "Public Hearings", title: "Proposed Rule - Rule relating to Incomplete Inspections",
    description: "A public hearing on incomplete inspections.",
    date: "2026-08-04", haystack: "proposed rule incomplete inspections public hearing",
  },
  {
    id: "20260818001", section: "Procurement", agency: "Health and Mental Hygiene",
    noticeType: "Award", title: "Integrated Visiting 'Rosy' Program",
    description: "Infix-only rat should never publish without a whole token.",
    date: "2026-08-18", haystack: "integrated visiting rosy program infix rate strategy",
  },
  {
    id: "20260818002", section: "Procurement", agency: "Health and Mental Hygiene",
    noticeType: "Award", title: "Community Rat Management Training",
    description: "Whole-token rodent control award.",
    date: "2026-08-18", haystack: "community rat management training rodent control award",
  },
];

test("GET /search returns ranked validated SearchDocument records from the FTS5 mirror", async () => {
  const { sqlite, DB } = database(ROWS);
  try {
    const response = await worker.fetch(
      new Request("https://api.cityscroll.org/search?q=zoning", {
        headers: { Origin: "https://cityscroll.org", Accept: "application/json" },
      }),
      { DB },
      {},
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.schema, "cityscroll.keyword_search_response.v1");
    assert.equal(body.match_mode, "keyword");
    assert.equal(body.coverage.schema, "cityscroll.universal_search_coverage.v1");
    assert.equal(body.coverage.snapshot.state, "incomplete");
    assert.equal(body.coverage.complete_count, null);
    assert.deepEqual(body.lanes.map((lane) => lane.id), [
      "contracts",
      "people",
      "agencies",
      "people-organizations",
      "community_boards",
      "land",
      "rules",
      "meetings",
      "exams",
    ]);
    for (const lane of body.lanes) {
      assert.ok(["matched", "empty", "unknown", "not_covered"].includes(lane.status));
      assert.ok(Object.hasOwn(lane, "count"));
      assert.ok(Object.hasOwn(lane, "as_of"));
      assert.equal(typeof lane.source, "string");
      assert.equal(lane.match_mode, "keyword");
      assert.ok(Array.isArray(lane.cards));
    }
    assert.ok(body.results.length >= 1);
    const target = body.results.find((result) => result.object_ref === "notice:20260729004");
    assert.ok(target);
    assert.deepEqual({
      schema: target.schema,
      object_ref: target.object_ref,
      object_type: target.object_type,
      domain: target.domain,
      canonical_href: target.canonical_href,
      title: target.title,
      summary: target.summary,
      source_observation_refs: target.source_observation_refs,
      outcome: target.outcome,
    }, {
      schema: "cityscroll.search_document.v1",
      object_ref: "notice:20260729004",
      object_type: "unclassified",
      domain: null,
      canonical_href: "/notices/20260729004",
      title: "Subcommittee on Zoning and Franchises meeting",
      summary: "Public zoning hearing.",
      source_observation_refs: ["notice:20260729004"],
      outcome: "evidence_only",
    });
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://cityscroll.org");
  } finally {
    sqlite.close();
  }
});

test("GET /search resolves one contract by exact object and source observation refs", async () => {
  const { sqlite, DB } = database(ROWS);
  try {
    const params = new URLSearchParams({
      object_ref: "procurement:05626S0013001",
      source_ref: "notice:20260730029",
    });
    const response = await worker.fetch(
      new Request(`https://api.cityscroll.org/search?${params}`, {
        headers: { Origin: "https://cityscroll.org", Accept: "application/json" },
      }),
      { DB },
      {},
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.match_mode, "exact_object_ref");
    assert.deepEqual(body.results.map((document) => document.object_ref), [
      "procurement:05626S0013001",
    ]);

    const mismatch = await worker.fetch(
      new Request("https://api.cityscroll.org/search?object_ref=procurement%3A05626S0013001&source_ref=notice%3A20260731016", {
        headers: { Origin: "https://cityscroll.org", Accept: "application/json" },
      }),
      { DB },
      {},
    );
    assert.equal(mismatch.status, 200);
    assert.deepEqual((await mismatch.json()).results, []);

    const award = await worker.fetch(
      new Request("https://api.cityscroll.org/search?object_ref=procurement%3A02EA43001R0X00&source_ref=ocp_award%3A20030520019", {
        headers: { Origin: "https://cityscroll.org", Accept: "application/json" },
      }),
      { DB },
      {},
    );
    assert.equal(award.status, 200);
    assert.deepEqual((await award.json()).results.map((document) => document.object_ref), [
      "procurement:02EA43001R0X00",
    ]);
  } finally {
    sqlite.close();
  }
});

test("six lanes retain typed bounded results and honest empty states", async () => {
  const { sqlite, DB } = database(ROWS);
  try {
    const response = await worker.fetch(
      new Request("https://api.cityscroll.org/search?q=mosquitos"),
      { DB },
      {},
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    const lanes = Object.fromEntries(body.lanes.map((lane) => [lane.id, lane]));
    assert.equal(lanes.contracts.status, "matched");
    assert.equal(lanes.contracts.cards[0].object_type, "procurement");
    assert.match(lanes.contracts.cards[0].canonical_href, /^\/browse\/contracts\//);
    assert.equal(lanes.contracts.cards[0].match_evidence.source_identifier, "notice:20260710020");
    assert.deepEqual(lanes.contracts.cards[0].match_evidence.token_offsets, [2, 3]);
    assert.equal(lanes.contracts.cards[0].provenance.producer, "city_record_search_document.v1");
    assert.equal(lanes.rules.status, "empty");
    assert.equal(lanes.rules.count, 0);
  } finally {
    sqlite.close();
  }
});

test("a missing notice mirror leaves static family lanes independently usable", async () => {
  const response = await worker.fetch(
    new Request("https://api.cityscroll.org/search?q=parks"),
    {},
    {},
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  const lanes = Object.fromEntries(body.lanes.map((lane) => [lane.id, lane]));
  // Rules still need the notice mirror. Contracts may publish Vendor collection
  // hits without it; People/agency static families stay independently usable.
  assert.equal(lanes.rules.status, "unknown");
  assert.equal(lanes.rules.count, null);
  assert.equal(body.coverage.by_lens.notices.state, "provider_unavailable");
  if (lanes.contracts.status === "matched") {
    assert.ok(lanes.contracts.cards.some((card) => card.object_type === "vendor"));
  } else {
    assert.equal(lanes.contracts.status, "unknown");
    assert.equal(lanes.contracts.count, null);
  }
  assert.equal(lanes["people-organizations"].status, "matched");
  assert.ok(lanes["people-organizations"].cards.some((card) => card.object_type === "agency"));
});

test("People uses its complete production provider for worker recall and coverage", async () => {
  const response = await worker.fetch(
    new Request("https://api.cityscroll.org/search?q=Christopher%20Marte"),
    {},
    {},
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(body.results.some((result) => result.object_ref === "person:7801"));
  assert.deepEqual({
    participated: body.coverage.by_lens.people.participated,
    state: body.coverage.by_lens.people.state,
    indexed_count: body.coverage.by_lens.people.indexed_count,
  }, {
    participated: true,
    state: "matched",
    indexed_count: 215,
  });

  const peopleCoverage = buildUniversalSearchCoverageView(body.coverage).lenses
    .find((lens) => lens.lens === "people");
  assert.equal(peopleCoverage?.state_label, "indexed");
  assert.match(
    renderUniversalSearchCoverageHtml(body.coverage),
    /data-coverage-lens="people" data-coverage-state="matched"><span>People<\/span><strong>1 match · indexed<\/strong>/,
  );
});

test("Community boards uses its dedicated production provider for recall and indexed coverage", async () => {
  const response = await worker.fetch(
    new Request("https://api.cityscroll.org/search?q=Bronx%20Community%20Board%201"),
    {},
    {},
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  const lanes = Object.fromEntries(body.lanes.map((lane) => [lane.id, lane]));
  assert.equal(lanes.community_boards?.status, "matched");
  assert.ok(lanes.community_boards?.cards.some((card) => card.object_ref === "community-board:bronx-cb-01"));
  assert.ok(body.results.some((result) => result.object_ref === "community-board:bronx-cb-01"));
  assert.deepEqual({
    participated: body.coverage.by_lens.community_boards.participated,
    state: body.coverage.by_lens.community_boards.state,
    indexed_count: body.coverage.by_lens.community_boards.indexed_count,
  }, {
    participated: true,
    state: "matched",
    indexed_count: 59,
  });

  const communityBoardCoverage = buildUniversalSearchCoverageView(body.coverage).lenses
    .find((lens) => lens.lens === "community_boards");
  assert.equal(communityBoardCoverage?.state_label, "indexed");
  assert.match(
    renderUniversalSearchCoverageHtml(body.coverage),
    /data-coverage-lens="community_boards" data-coverage-state="matched"><span>Community boards<\/span><strong>1 match · indexed<\/strong>/,
  );
});

test("Vendors uses its complete production provider for worker recall and coverage", async () => {
  const response = await worker.fetch(
    new Request("https://api.cityscroll.org/search?q=Accenture"),
    {},
    {},
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(body.results.some((result) => (
    result.object_ref === "vendor:stem:ACCENTURE"
    && result.object_type === "vendor"
    && result.canonical_href === "/vendors/ACCENTURE/"
  )));
  assert.deepEqual({
    participated: body.coverage.by_lens.vendors.participated,
    state: body.coverage.by_lens.vendors.state,
    indexed_count: body.coverage.by_lens.vendors.indexed_count,
  }, {
    participated: true,
    state: "matched",
    indexed_count: 132,
  });

  const vendorsCoverage = buildUniversalSearchCoverageView(body.coverage).lenses
    .find((lens) => lens.lens === "vendors");
  assert.equal(vendorsCoverage?.state_label, "indexed");
  assert.match(
    renderUniversalSearchCoverageHtml(body.coverage),
    /data-coverage-lens="vendors" data-coverage-state="matched"><span>Vendors<\/span><strong>1 match · indexed<\/strong>/,
  );
});

test("Parcels use the exact-BBL production corpus for worker recall and coverage", async () => {
  const exact = await worker.fetch(
    new Request("https://api.cityscroll.org/search?q=1000730008"),
    {},
    {},
  );
  assert.equal(exact.status, 200);
  const exactBody = await exact.json();
  const parcel = exactBody.results.find((result) => result.object_ref === "bbl:1000730008");
  assert.ok(parcel);
  assert.equal(parcel.object_type, "parcel");
  assert.equal(parcel.domain, "property");
  assert.equal(parcel.canonical_href, "/parcels/1000730008/");
  assert.equal(exactBody.results.some((result) => result.object_type === "land_use_project"
    && result.object_ref === "bbl:1000730008"), false);
  assert.deepEqual({
    participated: exactBody.coverage.by_lens.parcels.participated,
    state: exactBody.coverage.by_lens.parcels.state,
    indexed_count: exactBody.coverage.by_lens.parcels.indexed_count,
  }, {
    participated: true,
    state: "matched",
    indexed_count: 320,
  });

  const address = await worker.fetch(
    new Request("https://api.cityscroll.org/search?q=PIER-16%20SOUTH%20STREET"),
    {},
    {},
  );
  assert.equal(address.status, 200);
  const addressBody = await address.json();
  assert.ok(addressBody.results.some((result) => (
    result.object_ref === "bbl:1000730008" && result.object_type === "parcel"
  )));
  assert.equal(addressBody.results.some((result) => (
    result.object_type === "parcel" && result.object_ref !== "bbl:1000730008"
  )), false);
  assert.equal(addressBody.coverage.by_lens.parcels.matched_count, 1);

  const parcelsCoverage = buildUniversalSearchCoverageView(exactBody.coverage).lenses
    .find((lens) => lens.lens === "parcels");
  assert.equal(parcelsCoverage?.label, "Properties");
  assert.equal(parcelsCoverage?.state_label, "indexed");
  assert.match(
    renderUniversalSearchCoverageHtml(addressBody.coverage),
    /data-coverage-lens="parcels" data-coverage-state="matched"><span>Properties<\/span><strong>1 match · indexed<\/strong>/,
  );
});

test("Committees use the published graph production corpus for worker recall and coverage", async () => {
  const response = await worker.fetch(
    new Request("https://api.cityscroll.org/search?q=Committee%20on%20Finance"),
    {},
    {},
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  const committee = body.results.find((result) => result.object_ref === "committee:11");
  assert.ok(committee);
  assert.equal(committee.object_type, "committee");
  assert.equal(committee.domain, "meetings");
  assert.equal(committee.canonical_href, "/committees/11/");
  assert.equal(committee.title, "Committee on Finance");
  assert.deepEqual({
    participated: body.coverage.by_lens.committees.participated,
    state: body.coverage.by_lens.committees.state,
    indexed_count: body.coverage.by_lens.committees.indexed_count,
  }, {
    participated: true,
    state: "matched",
    indexed_count: 96,
  });

  const committeesCoverage = buildUniversalSearchCoverageView(body.coverage).lenses
    .find((lens) => lens.lens === "committees");
  assert.equal(committeesCoverage?.state_label, "indexed");
  assert.match(
    renderUniversalSearchCoverageHtml(body.coverage),
    /data-coverage-lens="committees" data-coverage-state="matched"><span>Committees<\/span><strong>1 match · indexed<\/strong>/,
  );
});

test("common civic terms return relevant records through the same FTS route", async () => {
  const { sqlite, DB } = database(ROWS);
  try {
    for (const query of ["police", "zoning", "budget", "contract", "hearing"]) {
      const response = await worker.fetch(new Request(`https://api.cityscroll.org/search?q=${query}`), { DB }, {});
      assert.equal(response.status, 200, query);
      const body = await response.json();
      assert.ok(body.results.length > 0, query);
      assert.ok(body.results.some((result) => result.search_text.toLowerCase().includes(query)), query);
      assert.ok(body.results.every((result) => result.object_type !== "mandate"), query);
    }
  } finally {
    sqlite.close();
  }
});

test("q=rat is a whole token across contracts and meetings, never an infix", async () => {
  const { sqlite, DB } = database(ROWS);
  try {
    const response = await worker.fetch(
      new Request("https://api.cityscroll.org/search?q=rat", {
        headers: { Origin: "https://cityscroll.org", Accept: "application/json" },
      }),
      { DB },
      {},
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    const lanes = Object.fromEntries(body.lanes.map((lane) => [lane.id, lane]));
    assert.equal(lanes.contracts.status, "matched");
    assert.ok(lanes.contracts.count >= 1);
    assert.ok(lanes.contracts.count < 20, `expected token-rat contracts, got ${lanes.contracts.count}`);
    assert.equal(lanes.meetings.status, "matched");
    assert.ok(lanes.meetings.cards.some((card) => (
      card.title === "New Rules Relating to Rat Inspections"
      && card.keyword_evidence?.status === "matched"
    )));

    const titles = body.results.map((result) => result.title);
    assert.equal(titles.some((title) => /integrated visiting/i.test(title)), false);
    assert.equal(titles.some((title) => /indirect rate/i.test(title)), false);
    assert.ok(titles.some((title) => /community rat management/i.test(title)));
    assert.ok(titles.some((title) => title === "New Rules Relating to Rat Inspections"));

    for (const result of body.results) {
      assert.equal(result.keyword_evidence?.status, "matched", result.title);
      assert.ok(result.match_evidence?.snippet?.text, result.title);
      assert.match(
        result.match_evidence.snippet.text.slice(
          result.match_evidence.snippet.mark_start,
          result.match_evidence.snippet.mark_end,
        ),
        /^rats?$/i,
        result.title,
      );
    }
  } finally {
    sqlite.close();
  }
});

test("the ranked City Record shape projects an exact contract award before presentation", async () => {
  const { sqlite, DB } = database(ROWS);
  try {
    const response = await worker.fetch(new Request("https://api.cityscroll.org/search?q=mosquito"), { DB }, {});
    assert.equal(response.status, 200);
    const body = await response.json();
    const target = body.results.find((result) => result.object_ref === "procurement:81626S0021001");
    assert.ok(target);
    assert.deepEqual({
      object_ref: target.object_ref,
      object_type: target.object_type,
      domain: target.domain,
      canonical_href: target.canonical_href,
      outcome: target.outcome,
      source_observation_refs: target.source_observation_refs,
    }, {
      object_ref: "procurement:81626S0021001",
      object_type: "procurement",
      domain: "contracts",
      canonical_href: "/browse/contracts/?mode=award&q=81626S0021001",
      outcome: "indexed",
      source_observation_refs: ["notice:20260710020"],
    });
    assert.ok(body.results.some((result) => (
      result.provenance.producer === "contract_award_search_document.v1"
      && /mosquito/i.test(result.search_text)
    )), "the complete retained OCP award corpus is federated into the real route");
  } finally {
    sqlite.close();
  }
});

test("current contract PINs remain findable through D1 even before the award warehouse refreshes", async () => {
  const { sqlite, DB } = database(ROWS);
  try {
    for (const pin of ["05626S0012", "05626W0023001"]) {
      const response = await worker.fetch(new Request(`https://api.cityscroll.org/search?q=${pin}`), { DB }, {});
      assert.equal(response.status, 200, pin);
      const body = await response.json();
      const document = body.results.find((result) => result.object_ref === `procurement:${pin}`);
      assert.ok(document, pin);
      assert.equal(document.domain, "contracts", pin);
      assert.equal(document.object_type, "procurement", pin);
      assert.equal(document.process_role, "award", pin);
      assert.equal(document.provenance.browse_record.pin, pin);
    }
  } finally {
    sqlite.close();
  }
});

test("the search route emits rules only from the bounded rule projection", async () => {
  const { sqlite, DB } = database(ROWS);
  try {
    const response = await worker.fetch(
      new Request("https://api.cityscroll.org/search?q=incomplete"),
      { DB },
      {},
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    const rules = body.results.filter((result) => result.domain === "rules");
    assert.equal(rules.length, 1);
    assert.deepEqual({
      object_ref: rules[0].object_ref,
      object_type: rules[0].object_type,
      domain: rules[0].domain,
      canonical_href: rules[0].canonical_href,
      process_role: rules[0].process_role,
      method: rules[0].classification.method,
      source_observation_refs: rules[0].source_observation_refs,
    }, {
      object_ref: "rulemaking:notice:20260728026",
      object_type: "rulemaking",
      domain: "rules",
      canonical_href: "/browse/rules/?q=20260728026",
      process_role: "public_process",
      method: "canonical_rule_projection",
      source_observation_refs: ["notice:20260728026"],
    });
  } finally {
    sqlite.close();
  }
});

test("GET /search rejects a missing query and preserves empty result sets", async () => {
  const { sqlite, DB } = database(ROWS);
  try {
    const missing = await worker.fetch(new Request("https://api.cityscroll.org/search"), { DB }, {});
    assert.equal(missing.status, 400);

    const empty = await worker.fetch(new Request("https://api.cityscroll.org/search?q=zzzz-no-match"), { DB }, {});
    assert.equal(empty.status, 200);
    const body = await empty.json();
    assert.deepEqual(body.results, []);
    assert.equal(body.lanes.length, 9);
    assert.ok(body.lanes.every((lane) => lane.status !== "matched"));
  } finally {
    sqlite.close();
  }
});

test("Agencies uses its dedicated production provider for worker recall and coverage", async () => {
  const response = await worker.fetch(
    new Request("https://api.cityscroll.org/search?q=Department%20of%20Parks%20and%20Recreation"),
    {},
    {},
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(body.results.some((result) => result.object_ref === "agency:id:parks-and-recreation"));

  const lanes = Object.fromEntries(body.lanes.map((lane) => [lane.id, lane]));
  assert.equal(lanes.agencies.status, "matched");
  assert.equal(lanes.agencies.count, 1);
  assert.equal(body.coverage.by_lens.agencies.state, "matched");
  assert.equal(body.coverage.by_lens.agencies.participated, true);
  assert.equal(typeof body.coverage.by_lens.agencies.indexed_count, "number");

  const agenciesCoverage = buildUniversalSearchCoverageView(body.coverage).lenses
    .find((lane) => lane.lens === "agencies");
  assert.equal(agenciesCoverage?.state_label, "indexed");

  assert.match(
    renderUniversalSearchCoverageHtml(body.coverage),
    /data-coverage-lens="agencies" data-coverage-state="matched"><span>Agencies<\/span><strong>1 match · indexed<\/strong>/,
  );
});
