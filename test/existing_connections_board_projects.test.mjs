/**
 * Land use projects recorded in a Community Board's own district.
 *
 * A board page already carried the board's proceedings, committees, people and
 * a geographic pivot; it did not name the land use applications recorded in the
 * board's district, so a reader had to leave the board and rebuild a geographic
 * search elsewhere. These tests cover that list: the exact district join, the
 * compact artifact every board document reads, and the rendered section.
 *
 * Population figures are never written down here. Every count is recomputed
 * from the two committed inputs by a second, deliberately independent pass, so
 * a later source refresh that legitimately moves the numbers reports its own
 * figures instead of failing against a stale fixture. What is pinned is the
 * reasoning: an exact district token joins, a resembling one does not, a
 * multi-district application appears once under each matching board, and shared
 * geography is never a board hearing, recommendation or committee assignment.
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  boardDistrictRegistry,
  buildCommunityBoardDistrictProjects,
  communityDistrictTokens,
  COMMUNITY_BOARD_DISTRICT_PROJECTS_SCHEMA,
} from "../warehouse/lib/community_board_district_projects.mjs";
import {
  communityBoardDistrictProjectsForBoard,
  renderCommunityBoardDistrictProjectsSection,
  COMMUNITY_BOARD_DISTRICT_PROJECTS_ANCHOR,
  COMMUNITY_BOARD_DISTRICT_PROJECTS_OVERFLOW_ANCHOR,
  COMMUNITY_BOARD_DISTRICT_PROJECT_STATES,
  COMMUNITY_BOARD_DISTRICT_PROJECT_VISIBLE_LIMIT,
} from "../site/community_board_district_projects.mjs";
import {
  buildCommunityBoardConstellationView,
  renderCommunityBoardConstellationDocument,
  COMMUNITY_BOARD_RESIDENT_DOCUMENT_LIMIT,
} from "../site/community_board_constellation.mjs";

const require = createRequire(import.meta.url);
globalThis.window = globalThis.window || {};
require("../site/i18n.js");
const SHIPPING_LANGS = globalThis.window.SHIPPING_LANGS;

const read = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));

const GEOGRAPHY = read("site/data/community_board_geography_lookup.json");
const ZAP = read("site/data/zap_projects_warehouse_lookup.json");
const LOOKUP = read("site/data/community_board_district_projects.json");
const REGISTRY = read("site/data/non_council_outcome_sources/source_registry.json");
const SCORECARD = read("site/data/community_board_minutes_scorecard.json");

// The named source-backed cases. Each is addressed by the publisher's own
// identifier so a failure says which record moved rather than which number did.
const BROOKLYN_CB1 = "brooklyn-cb-01";
const BROOKLYN_CB1_DISTRICT = "K01";
const BROOKLYN_CB1_NAMED = ["2024K0358", "2025K0287", "2024K0286", "2024K0240"];
const MANHATTAN_CB6 = "manhattan-cb-06";
const MANHATTAN_CB6_DISTRICT = "M06";
const MANHATTAN_CB6_NAMED = ["2020M0487", "2024M0104", "2023M0399"];
// Two Manhattan CB6 projects whose titles and sponsors read alike and which the
// join must keep apart.
const ALEXANDRIA_P2 = "2020M0487";
const ALEXANDRIA_INTERIM = "2024M0104";

const textOf = (html) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

/**
 * The districts one project row names, recomputed without the module under
 * test: split on commas, trim, and keep only a whole borough-letter-plus-two-
 * digit identifier.
 */
function independentTokens(value) {
  return [...new Set(String(value ?? "")
    .split(",")
    .map((part) => part.trim().toUpperCase())
    .filter((part) => part.length === 3
      && "XKMQR".includes(part[0])
      && part[1] >= "0" && part[1] <= "9"
      && part[2] >= "0" && part[2] <= "9"))];
}

/** Project identifiers recorded in one community district, recomputed. */
function independentProjectIds(districtId) {
  return ZAP.rows
    .filter((row) => independentTokens(row.community_district).includes(districtId))
    .map((row) => row.project_id)
    .sort();
}

function boardSources(overrides = {}) {
  return {
    sourceRegistry: REGISTRY,
    scorecard: SCORECARD,
    geography: GEOGRAPHY,
    communityBoardDistrictProjects: LOOKUP,
    generated_at: SCORECARD.as_of,
    ...overrides,
  };
}

function documentFor(bodyId, overrides = {}, options = {}) {
  const view = buildCommunityBoardConstellationView(bodyId, boardSources(overrides));
  assert.ok(view, `no constellation view for ${bodyId}`);
  return { view, html: renderCommunityBoardConstellationDocument(view, options) };
}

function sectionOf(html) {
  const match = html.match(/<section class="[^"]*board-district-projects"[\s\S]*?<\/section>/);
  return match ? match[0] : "";
}

const PAYLOAD = /<script id="civic-object-payload" type="application\/json">([\s\S]*?)<\/script>/;

function payloadOf(html) {
  return JSON.parse(html.match(PAYLOAD)[1].replace(/<\\\/script/gi, "</script"));
}

function withoutPayload(html) {
  return html.replace(PAYLOAD, "");
}

test("the district registry comes from the published board-to-district edges", () => {
  const registry = boardDistrictRegistry(GEOGRAPHY);
  const coversEdges = GEOGRAPHY.public_edges.filter((edge) => edge.type === "covers");
  assert.equal(registry.length, coversEdges.length);
  const boards = new Set(registry.map((row) => row.body_id));
  assert.equal(boards.size, registry.length, "a board holds one district, not several");
  for (const row of registry) {
    assert.match(row.body_id, /^[a-z]+(?:-[a-z]+)*-cb-\d{2}$/);
    assert.match(row.district_id, /^[XKMQR]\d{2}$/);
  }
  // Every board the source registry publishes is addressable through the same
  // canonical registry, so no board is joined by a name or a parsed body id.
  for (const board of REGISTRY.sources.filter((row) => row.body_type === "community_board")) {
    assert.ok(boards.has(board.body_id), `${board.body_id} has no canonical district edge`);
  }
});

test("a district matches on a whole token and never on a substring", () => {
  assert.deepEqual(communityDistrictTokens("K01"), ["K01"]);
  assert.deepEqual(communityDistrictTokens(" K01 , M06 "), ["K01", "M06"]);
  assert.deepEqual(communityDistrictTokens("K01, K01"), ["K01"], "one district counted once");
  assert.deepEqual(communityDistrictTokens("k01"), ["K01"], "case is normalized, not guessed");
  for (const rejected of ["K1", "K011", "K01A", "XK01", "Brooklyn 1", "01", "", null, undefined]) {
    assert.deepEqual(communityDistrictTokens(rejected), [], `${rejected} must not match a district`);
  }
  // K0114 contains "K01" as a substring; a substring match would place the
  // project in Brooklyn CB1, and this is the assertion that says it does not.
  assert.deepEqual(communityDistrictTokens("K0114"), []);
});

test("every board's list reproduces an independent pass over the committed source", () => {
  const rebuilt = buildCommunityBoardDistrictProjects({
    geography: GEOGRAPHY,
    projects: ZAP,
    generatedAt: ZAP.materialized_at,
  });
  assert.equal(rebuilt.schema, COMMUNITY_BOARD_DISTRICT_PROJECTS_SCHEMA);
  assert.deepEqual(rebuilt, LOOKUP, "the committed artifact is what the builder produces");

  const registry = boardDistrictRegistry(GEOGRAPHY);
  let boardsWithProjects = 0;
  const districts = new Set();
  for (const { body_id: bodyId, district_id: districtId } of registry) {
    const expected = independentProjectIds(districtId);
    const entry = LOOKUP.boards[bodyId];
    if (!expected.length) {
      assert.equal(entry, undefined, `${bodyId} has no recorded project and must carry no entry`);
      continue;
    }
    boardsWithProjects += 1;
    districts.add(districtId);
    assert.ok(entry, `${bodyId} (${districtId}) is missing from the artifact`);
    assert.equal(entry.district_id, districtId);
    assert.deepEqual([...entry.projects.map((row) => row.project_id)].sort(), expected,
      `${bodyId} (${districtId}) does not match an independent pass over the source`);
  }
  assert.equal(LOOKUP.counts.boards_with_projects, boardsWithProjects);
  assert.equal(LOOKUP.counts.districts_with_projects, districts.size);
  assert.ok(districts.size > 1, "the join is reproduced across districts, not on one case");
});

test("a multidistrict application appears once under each matching board and once only", () => {
  const multi = ZAP.rows.filter((row) => independentTokens(row.community_district).length > 1);
  assert.ok(multi.length, "the committed source carries at least one multidistrict project");
  const districtToBoards = new Map();
  for (const row of boardDistrictRegistry(GEOGRAPHY)) {
    districtToBoards.set(row.district_id, [...(districtToBoards.get(row.district_id) || []), row.body_id]);
  }
  for (const row of multi) {
    const boards = independentTokens(row.community_district)
      .flatMap((districtId) => districtToBoards.get(districtId) || []);
    assert.ok(boards.length > 1, `${row.project_id} should reach more than one board`);
    for (const bodyId of boards) {
      const ids = LOOKUP.boards[bodyId].projects.map((project) => project.project_id);
      assert.equal(ids.filter((id) => id === row.project_id).length, 1,
        `${row.project_id} must appear exactly once under ${bodyId}`);
    }
  }
});

test("Brooklyn CB1 lists the projects recorded in K01, with the named cases among them", () => {
  const view = communityBoardDistrictProjectsForBoard(LOOKUP, BROOKLYN_CB1);
  assert.ok(view);
  assert.equal(view.state, COMMUNITY_BOARD_DISTRICT_PROJECT_STATES.AVAILABLE);
  assert.equal(view.district_id, BROOKLYN_CB1_DISTRICT);

  const ids = view.projects.map((project) => project.project_id);
  assert.equal(new Set(ids).size, ids.length, "projects are distinct");
  assert.deepEqual([...ids].sort(), independentProjectIds(BROOKLYN_CB1_DISTRICT));
  assert.equal(view.project_count, ids.length);
  for (const named of BROOKLYN_CB1_NAMED) {
    assert.ok(ids.includes(named), `${named} is recorded in ${BROOKLYN_CB1_DISTRICT} and must be listed`);
  }

  const { html } = documentFor(BROOKLYN_CB1);
  const section = sectionOf(html);
  assert.ok(section, "the board document renders the section");
  for (const named of ids) {
    assert.ok(section.includes(`href="/browse/zoning/#land/${named}"`), `${named} is reachable from the board page`);
  }
  // Full published titles, not truncated labels.
  assert.ok(section.includes("Monitor Point - 56 Quay Demapping"));
  assert.ok(section.includes("200 Kent Avenue Rezoning"));
});

test("Manhattan CB6 lists the projects recorded in M06, with the named cases among them", () => {
  const view = communityBoardDistrictProjectsForBoard(LOOKUP, MANHATTAN_CB6);
  assert.ok(view);
  assert.equal(view.district_id, MANHATTAN_CB6_DISTRICT);
  const ids = view.projects.map((project) => project.project_id);
  assert.deepEqual([...ids].sort(), independentProjectIds(MANHATTAN_CB6_DISTRICT));
  for (const named of MANHATTAN_CB6_NAMED) {
    assert.ok(ids.includes(named), `${named} is recorded in ${MANHATTAN_CB6_DISTRICT} and must be listed`);
  }
});

test("two projects that read alike stay two projects", () => {
  const view = communityBoardDistrictProjectsForBoard(LOOKUP, MANHATTAN_CB6);
  const p2 = view.projects.find((project) => project.project_id === ALEXANDRIA_P2);
  const interim = view.projects.find((project) => project.project_id === ALEXANDRIA_INTERIM);
  assert.ok(p2 && interim, "both similarly named projects are listed");
  assert.notEqual(p2.title, interim.title);
  assert.notEqual(p2.href, interim.href);
  assert.notEqual(p2.applicant, interim.applicant, "distinct applicant labels are not collapsed");

  const zapOf = (id) => ZAP.rows.find((row) => row.project_id === id);
  for (const project of view.projects) {
    const source = zapOf(project.project_id);
    assert.equal(project.title, source.project_name, "the published title is carried exactly");
    assert.equal(project.applicant, source.primary_applicant || null, "the published applicant label is carried exactly");
    assert.equal(project.public_status, source.public_status || null, "the recorded status is carried exactly");
  }
});

test("a board whose district records no project renders nothing at all", () => {
  const registry = boardDistrictRegistry(GEOGRAPHY);
  const empty = registry.filter(({ district_id: districtId }) => independentProjectIds(districtId).length === 0);
  assert.ok(empty.length, "the committed source leaves at least one district with no project");
  for (const { body_id: bodyId } of empty) {
    assert.equal(communityBoardDistrictProjectsForBoard(LOOKUP, bodyId), null);
    const { html } = documentFor(bodyId);
    assert.equal(sectionOf(html), "", `${bodyId} must render no empty optional section`);
    assert.ok(!html.includes(COMMUNITY_BOARD_DISTRICT_PROJECTS_ANCHOR));
    assert.ok(!html.includes("Land use projects in this district"));
  }
});

test("a failed read is a stated failure with a source, never an empty district", () => {
  const failed = communityBoardDistrictProjectsForBoard(
    { error: "artifact unreadable", source: LOOKUP.source },
    BROOKLYN_CB1,
  );
  assert.ok(failed);
  assert.equal(failed.state, COMMUNITY_BOARD_DISTRICT_PROJECT_STATES.UNAVAILABLE);
  assert.deepEqual(failed.projects, []);

  const html = renderCommunityBoardDistrictProjectsSection(failed);
  const text = textOf(html);
  assert.ok(html.includes('data-district-projects-state="unavailable"'), "the machine channel carries the failure");
  assert.match(text, /could not be loaded/, "the visible channel carries the failure too");
  assert.match(text, /not a district with no projects/, "the failure is distinguished from an empty result");
  assert.ok(html.includes(`href="${LOOKUP.source.source_url}"`), "the published source stays reachable");
  assert.match(text, /Reload this page/, "a retry path is offered");
  // A board with no recorded project is a different thing and renders nothing.
  assert.equal(renderCommunityBoardDistrictProjectsSection(null), "");

  // The whole document keeps working: the failure replaces the list, not the page.
  const { html: doc } = documentFor(BROOKLYN_CB1, {
    communityBoardDistrictProjects: { error: "artifact unreadable", source: LOOKUP.source },
  });
  assert.ok(doc.includes('data-district-projects-state="unavailable"'));
  assert.ok(!doc.includes('href="/browse/zoning/#land/2024K0358"'));
});

test("the visible list is bounded and the rest are reachable by their exact count", () => {
  const overflowing = Object.keys(LOOKUP.boards)
    .map((bodyId) => communityBoardDistrictProjectsForBoard(LOOKUP, bodyId))
    .filter((view) => view.project_count > COMMUNITY_BOARD_DISTRICT_PROJECT_VISIBLE_LIMIT);
  assert.ok(overflowing.length, "at least one district records more projects than the visible bound");

  for (const view of overflowing) {
    assert.equal(view.visible_count, COMMUNITY_BOARD_DISTRICT_PROJECT_VISIBLE_LIMIT);
    assert.equal(view.overflow_count, view.project_count - view.visible_count);
    const html = renderCommunityBoardDistrictProjectsSection(view);
    assert.ok(html.includes(`data-district-projects-overflow="${view.overflow_count}"`));
    assert.match(textOf(html), new RegExp(`Show the (?:1 )?other ${view.overflow_count === 1 ? "" : `${view.overflow_count} `}projects?`));
    const rendered = [...html.matchAll(/data-project-id="([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(rendered, view.projects.map((project) => project.project_id),
      "every project is in the document, in order, whether or not it is visible first");
    assert.ok(rendered.length <= COMMUNITY_BOARD_RESIDENT_DOCUMENT_LIMIT,
      "the section stays inside the document's own resident record bound");
    // The expansion lives in the URL, because that is the only part of the page
    // a browser puts back when the reader presses Back.
    assert.ok(html.includes(`href="#${COMMUNITY_BOARD_DISTRICT_PROJECTS_OVERFLOW_ANCHOR}"`),
      "opening the rest of the list is a plain fragment link");
    assert.ok(html.includes(`id="${COMMUNITY_BOARD_DISTRICT_PROJECTS_OVERFLOW_ANCHOR}"`));
    assert.ok(html.includes(`href="#${COMMUNITY_BOARD_DISTRICT_PROJECTS_ANCHOR}"`),
      "closing it again is the same kind of link");
    assert.ok(!html.includes("<details"), "the expansion is not held in element state a browser will not restore");
  }

  const small = Object.keys(LOOKUP.boards)
    .map((bodyId) => communityBoardDistrictProjectsForBoard(LOOKUP, bodyId))
    .find((view) => view.project_count <= COMMUNITY_BOARD_DISTRICT_PROJECT_VISIBLE_LIMIT);
  assert.ok(small);
  assert.equal(small.overflow_count, 0);
  assert.ok(!renderCommunityBoardDistrictProjectsSection(small).includes("board-district-projects-overflow"),
    "a short list gets no disclosure it does not need");
});

test("ordering is stable and comes from the source, not from row order", () => {
  const view = communityBoardDistrictProjectsForBoard(LOOKUP, BROOKLYN_CB1);
  const dated = view.projects.filter((project) => project.status_recorded_on);
  for (let index = 1; index < dated.length; index += 1) {
    assert.ok(dated[index - 1].status_recorded_on >= dated[index].status_recorded_on,
      "most recently recorded first");
  }
  const undatedStart = view.projects.findIndex((project) => !project.status_recorded_on);
  if (undatedStart !== -1) {
    assert.ok(view.projects.slice(undatedStart).every((project) => !project.status_recorded_on),
      "projects with no recorded date sort after the dated ones rather than being dropped");
  }
  assert.equal(
    renderCommunityBoardDistrictProjectsSection(view),
    renderCommunityBoardDistrictProjectsSection(communityBoardDistrictProjectsForBoard(LOOKUP, BROOKLYN_CB1)),
    "the same inputs render the same markup",
  );
});

test("the section says what geography establishes and what it does not", () => {
  const html = renderCommunityBoardDistrictProjectsSection(
    communityBoardDistrictProjectsForBoard(LOOKUP, BROOKLYN_CB1),
  );
  const text = textOf(html);
  assert.match(text, /Land use projects in this district/);
  assert.match(text, new RegExp(`recorded in community district ${BROOKLYN_CB1_DISTRICT}`));
  assert.match(text, /does not mean this board held a hearing on it, made a recommendation about it, assigned it to a committee, or has any role in it/);
  // The list is a location, so it must not borrow the vocabulary of review.
  assert.ok(!/\bconsiders\b|\breviewed by\b|\bvoted\b|\bapproved by this board\b/i.test(text));
  assert.ok(!html.includes("data-relation="), "no typed review relation is minted from geography");
  // The recorded status is carried, and it is labelled as recorded rather than current.
  assert.match(text, /Recorded status: In Public Review/);
  assert.match(text, /Observed \w+ \d{1,2}, \d{4}/, "the observation date of the source is stated");
});

test("every project link is an ordinary anchor to the canonical project route", () => {
  const html = renderCommunityBoardDistrictProjectsSection(
    communityBoardDistrictProjectsForBoard(LOOKUP, BROOKLYN_CB1),
  );
  const anchors = [...html.matchAll(/<a\b[^>]*>/g)].map((match) => match[0]);
  assert.ok(anchors.length >= 2);
  for (const anchor of anchors) {
    assert.ok(/href="/.test(anchor), "a link is a link");
    assert.ok(!/target=/.test(anchor), "nothing opens in a new tab, so a modified click still decides");
    assert.ok(!/\bon[a-z]+=/.test(anchor), "no scripted handler stands between the reader and the link");
    assert.ok(!/javascript:/i.test(anchor));
  }
  for (const project of communityBoardDistrictProjectsForBoard(LOOKUP, BROOKLYN_CB1).projects) {
    assert.equal(project.href, `/browse/zoning/#land/${project.project_id}`);
  }
  // The disclosure inspects in place: it addresses this page's own fragment and
  // adds no document navigation, no watch and no subscription.
  assert.ok(!/data-(?:watch|follow|subscribe)/.test(html));
  const disclosure = [...html.matchAll(/<a\b[^>]*class="[^"]*board-district-projects-(?:more|less)[^"]*"[^>]*>/g)];
  assert.equal(disclosure.length, 2);
  for (const anchor of disclosure) {
    assert.match(anchor[0], /href="#[a-z-]+"/, "the disclosure stays on this page");
  }
});

test("the section ships in every shipping language with the source text preserved", () => {
  const view = communityBoardDistrictProjectsForBoard(LOOKUP, BROOKLYN_CB1);
  const english = renderCommunityBoardDistrictProjectsSection(view, { lang: "en" });
  for (const lang of ["en", ...SHIPPING_LANGS]) {
    const html = renderCommunityBoardDistrictProjectsSection(view, { lang });
    const text = textOf(html);
    assert.ok(html, `${lang} renders the section`);
    if (lang !== "en") {
      assert.notEqual(text, textOf(english), `${lang} renders translated copy, not the English string`);
      assert.ok(html.includes(`lang="${lang}"`), `${lang} declares its language`);
      assert.ok(html.includes(`dir="${["ar", "ur"].includes(lang) ? "rtl" : "ltr"}"`), `${lang} declares its direction`);
    }
    assert.ok(!/\bcbdp_[a-z_]+\b/.test(text), `${lang} resolves every key rather than rendering it`);
    // Publisher text is not translated, and it keeps its own language and
    // direction inside a page rendered in another one.
    assert.ok(html.includes('<strong lang="en" dir="ltr">Monitor Point</strong>'), `${lang} keeps the published title`);
    assert.ok(html.includes('<span lang="en" dir="ltr">GO Quay LLC</span>'), `${lang} keeps the published applicant label`);
    assert.ok(html.includes('<span lang="en" dir="ltr">In Public Review</span>'), `${lang} keeps the recorded status`);
    for (const project of view.projects) {
      assert.ok(html.includes(`href="${project.href}"`), `${lang} keeps every project reachable`);
    }
  }
});

test("the board document keeps everything it already carried", () => {
  const { html } = documentFor(BROOKLYN_CB1);
  assert.equal(html.match(/data-community-board-district-projects="1"/g).length, 1,
    "the section is rendered once");
  assert.ok(html.indexOf('data-community-board-about="1"') < html.indexOf('data-community-board-district-projects="1"'),
    "the list sits beside the board's own information rather than ahead of it");
  const withoutProjects = renderCommunityBoardConstellationDocument(
    buildCommunityBoardConstellationView(BROOKLYN_CB1, boardSources({ communityBoardDistrictProjects: null })),
  );
  // Removing the new section changes the rendered page only by that section.
  // The document's own JSON payload legitimately gains the same records, which
  // is what the existing Download JSON action then carries.
  assert.equal(withoutPayload(html.replace(sectionOf(html), "")), withoutPayload(withoutProjects));
  assert.ok(payloadOf(html).district_projects, "the document payload carries the same records");
  assert.equal(payloadOf(withoutProjects).district_projects, undefined);
});

test("the board calendar and committee links are untouched by the new section", () => {
  const boardWithMeetings = Object.keys(LOOKUP.boards).find((bodyId) => {
    const { html } = documentFor(bodyId);
    return html.includes('data-board-proceedings-view="1"');
  });
  if (!boardWithMeetings) return;
  const { html } = documentFor(boardWithMeetings);
  assert.ok(html.includes('data-board-proceedings-panel="month"'));
  assert.ok(html.includes('data-board-proceedings-panel="list"'));
  const withoutProjects = renderCommunityBoardConstellationDocument(
    buildCommunityBoardConstellationView(boardWithMeetings, boardSources({ communityBoardDistrictProjects: null })),
  );
  const calendar = (markup) => markup.slice(markup.indexOf('data-board-proceedings-view="1"'));
  assert.equal(calendar(html), calendar(withoutProjects), "the Month/List calendar renders identically");
});

test("the document stylesheet is what collapses the overflow", () => {
  const css = readFileSync(new URL("../site/civic-documents.css", import.meta.url), "utf8");
  assert.match(css, /\.board-district-projects-overflow > \.board-district-projects-overflow-list[\s\S]*?display: none;/,
    "the rest of the list starts collapsed");
  assert.match(css, /\.board-district-projects-overflow:target > \.board-district-projects-overflow-list[\s\S]*?display: grid;/,
    "the page's own fragment is what opens it");
  // With no stylesheet at all every project simply renders, which is the right
  // way for this to fail.
  assert.ok(!/board-district-projects-overflow-list[^{]*\{[^}]*visibility/.test(css));
});

test("the artifact records its own source vintage and its own boundary", () => {
  assert.equal(LOOKUP.source.observed_on, ZAP.materialized_at);
  assert.equal(LOOKUP.source.dataset_id, ZAP.dataset_id);
  assert.equal(LOOKUP.source.boundary_vintage, GEOGRAPHY.boundary_vintage);
  assert.equal(LOOKUP.counts.retained_projects, ZAP.rows.length);
  assert.equal(
    LOOKUP.counts.board_project_rows,
    Object.values(LOOKUP.boards).reduce((total, entry) => total + entry.projects.length, 0),
  );
  assert.ok(LOOKUP.counts.matched_projects <= LOOKUP.counts.retained_projects);
  // A project the source places in no community district is not silently
  // counted as zero anywhere; it is simply absent from every board.
  assert.equal(
    LOOKUP.counts.matched_projects,
    ZAP.rows.filter((row) => independentTokens(row.community_district).length > 0).length,
  );
});
