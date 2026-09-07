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
import { execFileSync } from "node:child_process";
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

/**
 * The reviewed baseline this feature was measured against, read from the commit
 * that named it. The Zoning Application Portal snapshot is refreshed on its own
 * cadence, so the baseline is pinned here and the live corpus is measured
 * separately below: a source refresh then moves the reported figures for a
 * stated reason instead of failing a gate that pinned a rolling window.
 */
const BASELINE_COMMIT = "4e4cacf891099f88d308430a87beaf08c6fc6569";
const BASELINE_PATH = "site/data/zap_projects_warehouse_lookup.json";

function baselineRows() {
  try {
    const blob = execFileSync(
      "git",
      ["show", `${BASELINE_COMMIT}:${BASELINE_PATH}`],
      { cwd: new URL("..", import.meta.url).pathname, maxBuffer: 1 << 28 },
    ).toString("utf8");
    return JSON.parse(blob);
  } catch {
    return null;
  }
}

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

test("the reviewed baseline repeats 18 exact applicant labels across 42 of 238 projects", (t) => {
  const baseline = baselineRows();
  if (!baseline) {
    t.skip(`the baseline snapshot at ${BASELINE_COMMIT} is not readable in this checkout`);
    return;
  }
  assert.equal(baseline.rows.length, 238);
  const repeated = repeatedLabels(baseline.rows);
  assert.equal(repeated.length, 18);
  assert.equal(repeated.reduce((total, [, group]) => total + group.rows.length, 0), 42);
  for (const [label, ids] of [
    ["GO Quay LLC", ["2024K0358", "2025K0287"]],
    ["The Durst Organization", ["2019M0453", "2019M0455"]],
    ["Phipps Houses", ["2023X0140", "2023X0149"]],
    ["SILVERSTEIN MB LLC", ["2020M0325", "P2014M0309"]],
  ]) {
    const group = buildApplicantProjectIndex(baseline.rows).get(label);
    assert.deepEqual(group.rows.map((row) => row.project_id).sort(), ids);
  }
});

test("the live corpus is measured, not assumed", () => {
  const repeated = repeatedLabels(WAREHOUSE_ROWS);
  const covered = repeated.reduce((total, [, group]) => total + group.rows.length, 0);
  // Reported, not gated: the snapshot rolls, so the exact figures belong in the
  // machine evidence rather than in an equality that a refresh turns into a
  // false regression.
  console.log(JSON.stringify({
    corpus: "zap_projects_warehouse_lookup",
    vintage: WAREHOUSE.materialized_at,
    projects: WAREHOUSE_ROWS.length,
    distinct_applicant_labels: buildApplicantProjectIndex(WAREHOUSE_ROWS).size,
    repeated_labels: repeated.length,
    projects_covered: covered,
  }));
  // The properties that must hold for any corpus.
  assert.ok(WAREHOUSE_ROWS.length > 0, "the retained corpus is never empty");
  assert.ok(repeated.length > 0, "some applicant label repeats");
  assert.ok(covered >= repeated.length * 2, "a repeated label covers at least two projects");
  for (const [, group] of repeated) {
    assert.equal(
      group.rows.length,
      new Set(group.rows.map((row) => row.project_id)).size,
      "every listed project resolves to a distinct retained project id",
    );
  }
});

test("the browse-default rows the resident page merges in change the count for stated reasons", () => {
  const merged = mergedResidentRows();
  const known = new Set(WAREHOUSE_ROWS.map((row) => row.project_id));
  const extras = merged.filter((row) => !known.has(row.project_id)).map((row) => row.project_id).sort();
  const repeated = repeatedLabels(merged);
  const covered = repeated.reduce((total, [, group]) => total + group.rows.length, 0);
  const snapshotCovered = repeatedLabels(WAREHOUSE_ROWS)
    .reduce((total, [, group]) => total + group.rows.length, 0);
  // The page groups over the corpus it holds, which is the snapshot with the
  // browse-default rows merged on top. The difference is reported with the exact
  // rows that cause it rather than pinned to a number.
  console.log(JSON.stringify({
    corpus: "resident_merge",
    projects: merged.length,
    repeated_labels: repeated.length,
    projects_covered: covered,
    snapshot_projects_covered: snapshotCovered,
    rows_only_in_browse_defaults: extras,
    rows_extending_a_repeated_label: extras.filter(
      (id) => repeated.some(([, group]) => group.rows.some((row) => row.project_id === id)),
    ),
  }));
  assert.equal(merged.length, WAREHOUSE_ROWS.length + extras.length);
  assert.ok(covered >= snapshotCovered, "merging rows in never removes a covered project");
  // Every project the merge adds to a group is one of those extra rows, so the
  // delta is always attributable.
  const addedToGroups = repeated
    .flatMap(([, group]) => group.rows.map((row) => row.project_id))
    .filter((id) => !known.has(id));
  assert.ok(addedToGroups.every((id) => extras.includes(id)));
  assert.equal(covered - snapshotCovered, new Set(addedToGroups).size);
});

const NAMED_PAIRS = [
  ["GO Quay LLC", "2024K0358", "2025K0287"],
  ["The Durst Organization", "2019M0453", "2019M0455"],
  ["Phipps Houses", "2023X0140", "2023X0149"],
  ["SILVERSTEIN MB LLC", "2020M0325", "P2014M0309"],
];

/** A named record is only checkable while the publisher still retains it. */
function presentIn(rows, ...projectIds) {
  return projectIds.every((id) => rows.some((row) => row.project_id === id));
}

test("each named source pair lists the other project and excludes itself", () => {
  const checked = [];
  const absent = [];
  for (const [label, left, right] of NAMED_PAIRS) {
    if (!presentIn(WAREHOUSE_ROWS, left, right)) {
      absent.push(label);
      continue;
    }
    for (const [subject, other] of [[left, right], [right, left]]) {
      const view = viewFor(subject);
      assert.equal(view.status, "matched");
      assert.equal(view.applicant_label, label);
      assert.equal(view.relation, LAND_SAME_APPLICANT_RELATION);
      assert.deepEqual(view.items.map((item) => item.project_id), [other]);
      assert.equal(view.items.some((item) => item.project_id === subject), false);
    }
    checked.push(label);
  }
  console.log(JSON.stringify({ named_pairs_checked: checked, named_pairs_no_longer_retained: absent }));
  assert.ok(checked.length, "at least one named pair is still retained and checkable");
});

test("a listed project keeps its published name, status field and milestone date", () => {
  const [label, subject, other] = NAMED_PAIRS.find(
    ([, left, right]) => presentIn(WAREHOUSE_ROWS, left, right),
  );
  const [item] = viewFor(subject).items;
  const source = WAREHOUSE_ROWS.find((row) => row.project_id === other);
  assert.equal(item.project_id, other);
  assert.equal(item.href, `#land/${other}`);
  assert.equal(item.status_field, "public_status");
  // Every displayed field is the publisher's own value for that record, not a
  // derived or reformatted one.
  assert.equal(item.project_name, source.project_name);
  assert.equal(item.status, source.public_status);
  assert.equal(item.public_status, source.public_status);
  assert.equal(item.milestone, source.current_milestone);
  assert.equal(item.milestone_date, source.current_milestone_date);
  console.log(JSON.stringify({ field_fidelity_label: label, subject, listed: item }));
});

test("the largest group lists every other project, sorted and deduplicated", () => {
  const [label, group] = repeatedLabels(WAREHOUSE_ROWS)
    .sort((left, right) => right[1].rows.length - left[1].rows.length)[0];
  const ids = group.rows.map((row) => row.project_id);
  const view = viewFor(ids[0]);
  assert.equal(view.applicant_label, label);
  assert.deepEqual(
    view.items.map((item) => item.project_id),
    ids.slice(1).sort(),
    "every other project in the group is listed once, in project-id order",
  );
  assert.equal(view.total, ids.length - 1);
  console.log(JSON.stringify({ largest_group_label: label, projects: ids }));
});

test("a repeated project id in the input cannot list the same project twice", () => {
  const [label, subject, other] = NAMED_PAIRS.find(
    ([, left, right]) => presentIn(WAREHOUSE_ROWS, left, right),
  );
  const rows = WAREHOUSE_ROWS.filter((row) => [subject, other].includes(row.project_id));
  const view = sameApplicantProjectsView({ projectId: subject, applicantLabel: label, rows: [...rows, ...rows] });
  assert.deepEqual(view.items.map((item) => item.project_id), [other]);
});

test("a person-shaped applicant is grouped in the applicant position and nowhere else", (t) => {
  if (!presentIn(WAREHOUSE_ROWS, "2023K0368", "2024R0300")) {
    t.skip("the named person-shaped applicant is no longer retained in this corpus");
    return;
  }
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

test("similar spellings of the same agency stay separate labels", (t) => {
  const index = buildApplicantProjectIndex(WAREHOUSE_ROWS);
  const spellings = ["DOT - NYC Dept of Transportation", "NYC DOT Department of Transportation"];
  if (!spellings.every((label) => index.has(label))) {
    t.skip("neither near-miss transportation spelling is retained in this corpus");
    return;
  }
  const [first, second] = spellings.map((label) => index.get(label).rows.map((row) => row.project_id).sort());
  console.log(JSON.stringify(Object.fromEntries(spellings.map((label, at) => [label, [first, second][at]]))));
  // Two publisher spellings of one department, kept apart because the strings
  // differ. Neither group may contain a project from the other.
  assert.equal(first.some((id) => second.includes(id)), false);
  assert.equal(viewFor(first[0]).items.some((item) => second.includes(item.project_id)), false);
  // An abbreviation is not a label: nothing resolves a spelling to an acronym.
  assert.equal(index.has("DCP"), false);
  assert.equal(index.has("DOT"), false);
});

test("only whitespace and control characters are normalised away", () => {
  assert.equal(sameApplicantLabelKey("  GO   Quay\tLLC "), "GO Quay LLC");
  assert.notEqual(sameApplicantLabelKey("go quay llc"), sameApplicantLabelKey("GO Quay LLC"));
  assert.notEqual(sameApplicantLabelKey("GO Quay, LLC"), sameApplicantLabelKey("GO Quay LLC"));
});

test("a singleton label produces a measured negative, and no section", () => {
  const index = buildApplicantProjectIndex(WAREHOUSE_ROWS);
  const singleton = WAREHOUSE_ROWS.find(
    (row) => index.get(sameApplicantLabelKey(row.primary_applicant))?.rows.length === 1,
  );
  assert.ok(singleton, "the corpus has at least one applicant label that occurs once");
  const view = viewFor(singleton.project_id);
  console.log(JSON.stringify({ singleton_project: singleton.project_id, label: view.applicant_label }));
  assert.equal(view.status, "not_observed");
  assert.equal(view.gap, "single_project_with_this_applicant");
  assert.equal(view.total, 0);
  assert.equal(render(view), "");
});

test("a project with no published applicant produces no section", () => {
  const view = sameApplicantProjectsView({
    projectId: WAREHOUSE_ROWS[0].project_id,
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
  assert.match(source, /landSameApplicantProjectsSectionHTML\(/);
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

test("the served-page capture manifest covers both viewports for every journey", () => {
  const manifest = JSON.parse(readFileSync(
    new URL("../docs/screenshots/land-same-applicant-projects/manifest.json", import.meta.url),
    "utf8",
  ));
  assert.equal(manifest.feature, "land-same-applicant-projects");
  // The manifest records the source vintage its captures observed. That is a
  // historical fact, so it is reconciled against the shipped snapshot and
  // reported, not equated: the snapshot is refreshed on its own cadence, and an
  // equality here would turn an unrelated dataset refresh into a failure. What
  // must hold is that the evidence cannot come from a future snapshot.
  const captured = Date.parse(manifest.data_vintage);
  const shipped = Date.parse(WAREHOUSE.materialized_at);
  assert.ok(Number.isFinite(captured), "the manifest names the source vintage it observed");
  assert.ok(captured <= shipped, "the manifest claims a source vintage newer than the shipped snapshot");
  console.log(JSON.stringify({
    capture_data_vintage: manifest.data_vintage,
    shipped_data_vintage: WAREHOUSE.materialized_at,
    captures_are_current: manifest.data_vintage === WAREHOUSE.materialized_at,
  }));
  const specimens = [
    "positive-pair",
    "positive-largest",
    "positive-person",
    "translated-es",
    "negative-singleton",
    "negative-failed-load",
    "back-navigation",
    "keyboard",
    "rtl-ar",
    "no-javascript",
  ];
  const names = new Set(manifest.files.map((row) => row.name));
  for (const specimen of specimens) {
    for (const width of [390, 1440]) {
      assert.ok(names.has(`${specimen}-${width}.png`), `missing capture ${specimen}-${width}`);
    }
  }
  assert.equal(manifest.files.length, specimens.length * 2);
  for (const row of manifest.files) {
    for (const field of ["route", "viewport", "revision", "data_vintage", "assertion", "sha256", "bytes"]) {
      assert.ok(row[field], `${row.name} is missing ${field}`);
    }
    assert.match(row.route, /#land\/|\/browse\/zoning\//);
    assert.deepEqual(row.axe?.failing_violations ?? [], [], `${row.name} failed the axe gate`);
  }
  // The read-backs are the evidence, not the images: each one carries the DOM
  // state the assertion was made against.
  const byName = new Map(manifest.files.map((row) => [row.name, row]));
  const pair = byName.get("positive-pair-1440.png").evidence;
  assert.ok(pair.applicant_label, "the pair capture names the applicant label it grouped on");
  assert.equal(pair.items.length, 1);
  assert.equal(pair.items[0].href, `#land/${pair.items[0].project_id}`);
  assert.equal(pair.relation, "lists_same_applicant");
  for (const name of ["negative-singleton-1440.png", "negative-failed-load-1440.png"]) {
    const negative = byName.get(name).evidence;
    assert.equal(negative.present, false);
    assert.deepEqual(negative.negative_claim, [], `${name} rendered a claim instead of staying silent`);
  }
  const back = byName.get("back-navigation-1440.png").evidence;
  // Forward to the listed project, then back to the one the reader started on,
  // with the section still expanded.
  assert.equal(back.forward.project_ref, `project:${pair.items[0].project_id}`);
  assert.equal(back.restored.project_ref, pair.project_ref);
  assert.equal(back.restored.open, true);
  const spanish = byName.get("translated-es-1440.png").evidence;
  const english = byName.get("positive-pair-1440.png").evidence;
  assert.equal(spanish.heading, "Otros proyectos que registran este solicitante");
  assert.notEqual(spanish.heading, english.heading, "the section's own copy is translated");
  // The published project name and the publisher's own status are not.
  assert.equal(spanish.items[0].name, english.items[0].name);
  assert.equal(spanish.items[0].status, english.items[0].status);
  const rtl = byName.get("rtl-ar-390.png").evidence;
  assert.equal(rtl.rtl.direction, "rtl");
  assert.equal(rtl.rtl.link_dir, "ltr");
  assert.ok(rtl.rtl.document_scroll_width <= rtl.rtl.viewport_width, "the narrow RTL page gained horizontal scroll");
  assert.deepEqual(byName.get("no-javascript-1440.png").evidence, {
    rows: 0, section: 0, negative_claim: [],
  });
});
