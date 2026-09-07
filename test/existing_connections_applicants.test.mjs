/**
 * Other retained land projects that list the exact same published applicant.
 *
 * The positive cases are named source records, so a reader can check them
 * against the publisher. The negative controls are the part that keeps the
 * feature honest: near-miss spellings must stay apart, a label that occurs once
 * must produce no section, and an input that never loaded must never be
 * reported as an answered "no other projects".
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  LAND_SAME_APPLICANT_RELATION,
  LAND_SAME_APPLICANT_SCHEMA,
  buildApplicantProjectIndex,
  landSameApplicantProjectsHTML,
  sameApplicantLabelKey,
  sameApplicantProjectsView,
} from "../site/land_same_applicant_projects.mjs";

const WAREHOUSE = JSON.parse(readFileSync(
  new URL("../site/data/zap_projects_warehouse_lookup.json", import.meta.url),
  "utf8",
));
const WAREHOUSE_ROWS = WAREHOUSE.rows;
const BROWSE_DEFAULTS = JSON.parse(readFileSync(
  new URL("../site/data/land_default_ulurp.json", import.meta.url),
  "utf8",
));

/** The merged corpus the Land route actually holds in the browser. */
function mergedResidentRows() {
  const byId = new Map();
  for (const row of [...WAREHOUSE_ROWS, ...BROWSE_DEFAULTS.projects]) {
    byId.set(row.project_id, { ...(byId.get(row.project_id) || {}), ...row });
  }
  return [...byId.values()];
}

function repeatedLabels(rows) {
  return [...buildApplicantProjectIndex(rows).entries()].filter(([, group]) => group.rows.length > 1);
}

const escape = (value) => String(value ?? "").replace(/[<>&"']/g, (char) => ({
  "<": "&lt;",
  ">": "&gt;",
  "&": "&amp;",
  '"': "&quot;",
  "'": "&#39;",
}[char]));
const translate = (key, vars = {}) => Object.entries(vars)
  .reduce((text, [name, value]) => text.replace(new RegExp(`\\{${name}\\}`, "g"), value), key);
const pluralize = (base, n) => `${base}_${n === 1 ? "one" : "other"}:${n}`;
const render = (view) => landSameApplicantProjectsHTML(view, { t: translate, tn: pluralize, escape });

function viewFor(projectId, rows = WAREHOUSE_ROWS) {
  const row = rows.find((entry) => entry.project_id === projectId);
  assert.ok(row, `${projectId} is present in the retained corpus`);
  return sameApplicantProjectsView({
    projectId,
    applicantLabel: row.primary_applicant,
    rows,
    vintage: WAREHOUSE.materialized_at,
    scope: "retained_land_project_snapshot",
  });
}

test("the retained corpus repeats 18 exact applicant labels across 42 projects", () => {
  assert.equal(WAREHOUSE_ROWS.length, 238);
  const repeated = repeatedLabels(WAREHOUSE_ROWS);
  assert.equal(repeated.length, 18);
  assert.equal(repeated.reduce((total, [, group]) => total + group.rows.length, 0), 42);
  // Every listed project resolves to a distinct retained project id.
  for (const [, group] of repeated) {
    assert.equal(group.rows.length, new Set(group.rows.map((row) => row.project_id)).size);
  }
});

test("the browse-default rows the resident page merges in change the count for stated reasons", () => {
  const merged = mergedResidentRows();
  assert.equal(merged.length, 244);
  const repeated = repeatedLabels(merged);
  // Same 18 labels; two of the six extra completed projects extend an existing
  // label, so the covered-project figure moves from 42 to 44. The count is
  // derived from the corpus, never asserted as a fixed display number.
  assert.equal(repeated.length, 18);
  assert.equal(repeated.reduce((total, [, group]) => total + group.rows.length, 0), 44);
  const extras = merged
    .filter((row) => !WAREHOUSE_ROWS.some((known) => known.project_id === row.project_id))
    .map((row) => row.project_id)
    .sort();
  assert.deepEqual(extras, [
    "2020K0444", "2020M0385", "2020Q0317", "2023M0452", "2024Q0135", "P2012X0048",
  ]);
  assert.deepEqual(
    viewFor("2020M0487", merged).items.map((item) => item.project_id),
    ["2024Q0135", "2025R0309"],
  );
});

test("each named source pair lists the other project and excludes itself", () => {
  const pairs = [
    ["GO Quay LLC", "2024K0358", "2025K0287"],
    ["The Durst Organization", "2019M0453", "2019M0455"],
    ["Phipps Houses", "2023X0140", "2023X0149"],
    ["SILVERSTEIN MB LLC", "2020M0325", "P2014M0309"],
  ];
  for (const [label, left, right] of pairs) {
    for (const [subject, other] of [[left, right], [right, left]]) {
      const view = viewFor(subject);
      assert.equal(view.status, "matched");
      assert.equal(view.applicant_label, label);
      assert.equal(view.relation, LAND_SAME_APPLICANT_RELATION);
      assert.deepEqual(view.items.map((item) => item.project_id), [other]);
      assert.equal(view.items.some((item) => item.project_id === subject), false);
    }
  }
});

test("a listed project keeps its published name, status field and milestone date", () => {
  const [item] = viewFor("2024K0358").items;
  assert.equal(item.project_id, "2025K0287");
  assert.equal(item.project_name, "Monitor Point - 56 Quay Demapping");
  assert.equal(item.status, "In Public Review");
  assert.equal(item.status_field, "public_status");
  assert.equal(item.href, "#land/2025K0287");
  const source = WAREHOUSE_ROWS.find((row) => row.project_id === "2025K0287");
  assert.equal(item.public_status, source.public_status);
  assert.equal(item.milestone, source.current_milestone);
  assert.equal(item.milestone_date, source.current_milestone_date);
});

test("the largest group lists every other project, sorted and deduplicated", () => {
  const view = viewFor("2022X0150");
  assert.equal(view.applicant_label, "DPR - Department of Parks & Recreation NYC");
  assert.deepEqual(view.items.map((item) => item.project_id), [
    "2025K0318", "2025Q0314", "2025Q0316", "2026R0186", "P2009M0029", "P2012R0043",
  ]);
  assert.equal(view.total, 6);
  assert.equal(view.truncated, false);
});

test("a repeated project id in the input cannot list the same project twice", () => {
  const rows = WAREHOUSE_ROWS.filter((row) => ["2024K0358", "2025K0287"].includes(row.project_id));
  const view = sameApplicantProjectsView({
    projectId: "2024K0358",
    applicantLabel: "GO Quay LLC",
    rows: [...rows, ...rows],
  });
  assert.deepEqual(view.items.map((item) => item.project_id), ["2025K0287"]);
});

test("a person-shaped applicant is grouped in the applicant position and nowhere else", () => {
  const view = viewFor("2023K0368");
  assert.equal(view.applicant_label, "Eric Palatnik");
  assert.deepEqual(view.items.map((item) => item.project_id), ["2024R0300"]);
  assert.equal(view.relation, "lists_same_applicant");
  const html = render(view);
  // The rendered section may only ever name the applicant relationship. No
  // rendered string turns a published applicant into an owner or a developer.
  assert.match(html, /land_same_applicant_heading/);
  for (const forbidden of [/\bowner\b/i, /\bdeveloper\b/i, /\bparent compan/i, /\bcontrols?\b/i, /\baffiliat/i]) {
    assert.equal(forbidden.test(html), false, `rendered section must not claim ${forbidden}`);
  }
});

test("similar spellings of the same agency stay separate labels", () => {
  const index = buildApplicantProjectIndex(WAREHOUSE_ROWS);
  const spellings = [
    ["DOT - NYC Dept of Transportation", ["P2014R0345", "P2018X0328"]],
    ["NYC DOT Department of Transportation", ["2023Q0424", "2025M0252"]],
  ];
  for (const [label, ids] of spellings) {
    assert.deepEqual(index.get(label).rows.map((row) => row.project_id).sort(), ids);
  }
  assert.equal(viewFor("P2014R0345").items.some((item) => item.project_id === "2023Q0424"), false);
  // Two more publisher spellings of city planning that must not merge either.
  assert.equal(index.has("New York City Department of City Planning"), true);
  assert.equal(index.has("DCP"), false);
});

test("only whitespace and control characters are normalised away", () => {
  assert.equal(sameApplicantLabelKey("  GO   Quay\tLLC "), "GO Quay LLC");
  assert.notEqual(sameApplicantLabelKey("go quay llc"), sameApplicantLabelKey("GO Quay LLC"));
  assert.notEqual(sameApplicantLabelKey("GO Quay, LLC"), sameApplicantLabelKey("GO Quay LLC"));
});

test("a singleton label produces a measured negative, and no section", () => {
  const view = viewFor("2018X0438");
  assert.equal(view.applicant_label, "Sedgwick Holdings LLC");
  assert.equal(view.status, "not_observed");
  assert.equal(view.gap, "single_project_with_this_applicant");
  assert.equal(view.total, 0);
  assert.equal(render(view), "");
});

test("a project with no published applicant produces no section", () => {
  const view = sameApplicantProjectsView({
    projectId: "2018X0438",
    applicantLabel: null,
    rows: WAREHOUSE_ROWS,
  });
  assert.equal(view.status, "not_observed");
  assert.equal(view.gap, "applicant_not_published");
  assert.equal(render(view), "");
});

test("a failed load stays unavailable and never becomes a no-other-projects claim", () => {
  for (const rows of [null, undefined, "", 0, { rows: [] }]) {
    const view = sameApplicantProjectsView({
      projectId: "2024K0358",
      applicantLabel: "GO Quay LLC",
      rows,
    });
    assert.equal(view.status, "unavailable");
    assert.equal(view.gap, "project_snapshot_unavailable");
    assert.equal(view.total, null, "an unavailable input has no count, not a count of zero");
    assert.equal(render(view), "");
  }
  // An empty-but-loaded corpus is a different, answerable state.
  const empty = sameApplicantProjectsView({
    projectId: "2024K0358",
    applicantLabel: "GO Quay LLC",
    rows: [],
  });
  assert.equal(empty.status, "not_observed");
  assert.equal(empty.total, 0);
});

test("the rendered section is an expanded native disclosure of native links", () => {
  const html = render(viewFor("2024K0358"));
  assert.match(html, /<details class="land-same-applicant-disclosure"[^>]*open>/);
  assert.match(html, /<summary class="land-same-applicant-summary">/);
  assert.match(html, /<a class="land-same-applicant-link" href="#land\/2025K0287"/);
  assert.match(html, /data-project-ref="project:2024K0358"/);
  assert.match(html, /data-applicant-label="GO Quay LLC"/);
  assert.match(html, /data-same-applicant-total="1"/);
  assert.match(html, /land_same_applicant_count_one:1/);
  // Inspecting the list must not navigate, subscribe or post anywhere.
  for (const forbidden of [/<button/, /<form/, /onclick=/, /target="_blank"/, /https?:\/\//]) {
    assert.equal(forbidden.test(html), false, `disclosure must not contain ${forbidden}`);
  }
});

test("published text is escaped and marked as source language", () => {
  const view = sameApplicantProjectsView({
    projectId: "2024K0358",
    applicantLabel: 'Quote " & <script>',
    rows: [
      { project_id: "2024K0358", primary_applicant: 'Quote " & <script>' },
      {
        project_id: "2025K0287",
        primary_applicant: 'Quote " & <script>',
        project_name: '<img src=x onerror="boom">',
        public_status: "Filed",
      },
    ],
  });
  const html = render(view);
  assert.equal(html.includes("<script>"), false);
  assert.equal(html.includes("<img"), false);
  assert.match(html, /&lt;img src=x onerror=&quot;boom&quot;&gt;/);
  assert.match(html, /data-applicant-label="Quote &quot; &amp; &lt;script&gt;"/);
  assert.match(html, /<span class="land-same-applicant-status" lang="en" dir="ltr"/);
});

test("a project with no published milestone or status says so rather than showing nothing", () => {
  const view = sameApplicantProjectsView({
    projectId: "A001",
    applicantLabel: "Shared Label",
    rows: [
      { project_id: "A001", primary_applicant: "Shared Label" },
      { project_id: "A002", primary_applicant: "Shared Label" },
    ],
  });
  const html = render(view);
  assert.match(html, /land_same_applicant_status_unpublished/);
  assert.match(html, /land_same_applicant_milestone_unpublished/);
  assert.match(html, /land_same_applicant_name_unpublished/);
  assert.equal(html.includes(">0<"), false);
});

test("a group larger than the display bound keeps an exact visible total", () => {
  const rows = Array.from({ length: 15 }, (unused, index) => ({
    project_id: `B${String(index).padStart(3, "0")}`,
    primary_applicant: "Shared Label",
    project_name: `Project ${index}`,
    public_status: "Filed",
  }));
  const view = sameApplicantProjectsView({ projectId: "B000", applicantLabel: "Shared Label", rows });
  assert.equal(view.total, 14);
  assert.equal(view.items.length, 12);
  assert.equal(view.truncated, true);
  assert.match(render(view), /land_same_applicant_truncated/);
});

test("the view is a pure read of the rows it is handed", () => {
  const view = viewFor("2024K0358");
  assert.equal(view.schema, LAND_SAME_APPLICANT_SCHEMA);
  assert.equal(view.vintage, WAREHOUSE.materialized_at);
  assert.equal(view.scope, "retained_land_project_snapshot");
  assert.equal(WAREHOUSE.mode, "soda_sell_facing");
  assert.equal(WAREHOUSE.replaces_live_fetch.soda_dataset, "hgx4-8ukb");
});

test("every language ships the strings this section renders", async () => {
  globalThis.window = globalThis.window || globalThis;
  const { STRINGS, SHIPPING_LANGS } = await import("../site/i18n.js").then((module) => module.default || globalThis);
  const dictionaries = STRINGS || globalThis.STRINGS;
  const langs = SHIPPING_LANGS || globalThis.SHIPPING_LANGS;
  const keys = [
    "land_same_applicant_heading",
    "land_same_applicant_count_one",
    "land_same_applicant_count_other",
    "land_same_applicant_note",
    "land_same_applicant_name_unpublished",
    "land_same_applicant_status_unpublished",
    "land_same_applicant_milestone_unpublished",
    "land_same_applicant_truncated",
    "land_same_applicant_vintage",
  ];
  for (const lang of ["en", ...langs]) {
    for (const key of keys) {
      assert.equal(typeof dictionaries[lang]?.[key], "string", `${lang} is missing ${key}`);
      assert.ok(dictionaries[lang][key].length, `${lang}.${key} is empty`);
    }
    assert.match(dictionaries[lang].land_same_applicant_truncated, /\{shown\}/);
    assert.match(dictionaries[lang].land_same_applicant_truncated, /\{total\}/);
    assert.match(dictionaries[lang].land_same_applicant_vintage, /\{date\}/);
    assert.match(dictionaries[lang].land_same_applicant_count_other, /\{n\}/);
  }
});

test("the land renderer hosts the section in the applicant area without fanning out", () => {
  const source = readFileSync(new URL("../site/app/land.mjs", import.meta.url), "utf8");
  assert.match(source, /<div id="land-same-applicant-host"><\/div>/);
  assert.match(source, /paintSameApplicantProjects\(detail,record,selection\)/);
  assert.match(source, /import\("\.\.\/land_same_applicant_projects\.mjs"\)/);
  // The grouping reuses the already-loaded bounded snapshot promise; it must not
  // introduce its own fetch of a publisher or a per-project endpoint.
  const paint = source.slice(
    source.indexOf("async function paintSameApplicantProjects"),
    source.indexOf("const ZAPBBL="),
  );
  assert.match(paint, /loadLandProjectsSnapshot\(\)/);
  for (const forbidden of [/fetch\(/, /workerFetch\(/, /data\.cityofnewyork\.us/]) {
    assert.equal(forbidden.test(paint), false, `paint must not call ${forbidden}`);
  }
});
