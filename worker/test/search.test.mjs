import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import worker from "../src/worker.mjs";

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
    id: "20260728026", section: "Agency Rules", agency: "Buildings",
    noticeType: "Public Hearings", title: "Proposed Rule - Rule relating to Incomplete Inspections",
    description: "A public hearing on incomplete inspections.",
    date: "2026-08-04", haystack: "proposed rule incomplete inspections public hearing",
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
    assert.equal(body.results.length, 1);
    assert.deepEqual(Object.keys(body.results[0]).sort(), [
      "canonical_href",
      "classification",
      "coverage_state",
      "domain",
      "object_ref",
      "object_type",
      "outcome",
      "process_role",
      "provenance",
      "schema",
      "search_text",
      "source_family",
      "source_observation_refs",
      "summary",
      "title",
    ].sort());
    assert.deepEqual({
      schema: body.results[0].schema,
      object_ref: body.results[0].object_ref,
      object_type: body.results[0].object_type,
      domain: body.results[0].domain,
      canonical_href: body.results[0].canonical_href,
      title: body.results[0].title,
      summary: body.results[0].summary,
      source_observation_refs: body.results[0].source_observation_refs,
      outcome: body.results[0].outcome,
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

test("the ranked City Record shape projects an exact contract award before presentation", async () => {
  const { sqlite, DB } = database(ROWS);
  try {
    const response = await worker.fetch(new Request("https://api.cityscroll.org/search?q=mosquito"), { DB }, {});
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.results.length, 1);
    assert.deepEqual({
      object_ref: body.results[0].object_ref,
      object_type: body.results[0].object_type,
      domain: body.results[0].domain,
      canonical_href: body.results[0].canonical_href,
      outcome: body.results[0].outcome,
      source_observation_refs: body.results[0].source_observation_refs,
    }, {
      object_ref: "procurement:81626S0021001",
      object_type: "procurement",
      domain: "contracts",
      canonical_href: "/browse/contracts/?mode=award&q=81626S0021001",
      outcome: "indexed",
      source_observation_refs: ["notice:20260710020"],
    });
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
    assert.equal(body.results.length, 1);
    assert.deepEqual({
      object_ref: body.results[0].object_ref,
      object_type: body.results[0].object_type,
      domain: body.results[0].domain,
      canonical_href: body.results[0].canonical_href,
      process_role: body.results[0].process_role,
      method: body.results[0].classification.method,
      source_observation_refs: body.results[0].source_observation_refs,
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
    assert.deepEqual(await empty.json(), { results: [] });
  } finally {
    sqlite.close();
  }
});
