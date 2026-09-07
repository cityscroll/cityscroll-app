/**
 * The budget requests a community board made, and the answers city agencies
 * published for them, read from a board and from an agency.
 *
 * The retained register already held both sides of this: one row per request
 * per budget publication, so the same request reappears in the next publication
 * of the same fiscal cycle carrying the answer as it stood that day. What it
 * had no reader for was the two questions residents actually arrive with —
 * "what did my board ask for, and what came back?" and "what have the districts
 * asked this agency for?" — which are the same records approached from opposite
 * ends and must never disagree.
 *
 * Population figures are never written down here. Every count is recomputed
 * from the committed register by a second, deliberately independent pass, so a
 * later publication that legitimately moves the numbers reports its own figures
 * instead of failing against a stale fixture. What is pinned is the reasoning
 * and the named records:
 *
 *   - the full tracking code inside one fiscal cycle is the identity, so a
 *     capital request and an expense request that share digits stay apart
 *   - only the publications a reader is served take part; the publisher's
 *     forward-dated release reaches no reader and no comparison
 *   - an answer that reads differently and an answer whose publisher wrapper
 *     moved are two findings, and the second is not a civic outcome
 *   - a priority number is scoped to one agency and one budget type, and is
 *     never presented as a place in a citywide queue
 *   - the board list and the agency list are the same population, request for
 *     request, and each links into the other at the scope the reader is in
 *   - three separate states on both surfaces: retained requests, a
 *     register-qualified absence, and a register that could not be read
 *   - two affordances with two meanings: ordinary anchors that need no
 *     scripting, and a native button that inspects one record in place, with
 *     focus, Tab containment, Escape and focus return
 *
 *   node --test test/community_board_request_responses.test.mjs
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import {
  agencyBudgetRequestsForAgency,
  budgetRequestGroupSlug,
  communityBoardBudgetRequestsForBoard,
  renderAgencyBudgetRequestsSection,
  renderCommunityBoardBudgetRequestsSection,
  AGENCY_BUDGET_REQUESTS_ANCHOR,
  BUDGET_REQUEST_AGENCY_ROWS_PER_BOARD,
  BUDGET_REQUEST_ATTRIBUTE,
  BUDGET_REQUEST_LABELS_ATTRIBUTE,
  BUDGET_REQUEST_STATES,
  BUDGET_REQUEST_STRINGS,
  BUDGET_REQUEST_VISIBLE_BOARDS,
  BUDGET_REQUEST_VISIBLE_GROUPS,
  COMMUNITY_BOARD_BUDGET_REQUESTS_ANCHOR,
} from "../site/community_board_budget_requests.mjs";
import {
  bindCommunityBoardBudgetRequests,
  parseBudgetRequestLabels,
  readBudgetRequestRow,
  BUDGET_REQUEST_BOOT_DIALOG_ID,
  BUDGET_REQUEST_BOOT_READY_ATTRIBUTE,
  BUDGET_REQUEST_BOOT_TITLE_ID,
} from "../site/community_board_budget_requests_boot.mjs";
import { budgetRequestsSection } from "../site/agency_constellation_sections/budget_requests.mjs";
import { click, keydown, mountDocument } from "./helpers/preview_dom.mjs";

const require = createRequire(import.meta.url);
globalThis.window = globalThis.window || {};
require("../site/i18n.js");
const SHIPPING_LANGS = globalThis.window.SHIPPING_LANGS;

const read = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));

const REGISTER = read("site/data/community_board_budget_register.json");
const DOCUMENT_DIR = new URL("../site/data/community_board_budget_register/", import.meta.url);
const DOCUMENTS = readdirSync(DOCUMENT_DIR)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => JSON.parse(readFileSync(new URL(name, DOCUMENT_DIR), "utf8")));
const BOARD_LOOKUP = read("site/data/community_board_constellation_lookup.json");
const BOARD_NAMES = Object.fromEntries(
  Object.entries(BOARD_LOOKUP.by_id || {}).map(([id, row]) => [id, row?.display_name || id]),
);
const CSS = readFileSync(new URL("../site/civic-documents.css", import.meta.url), "utf8");

// The named source-backed cases, addressed by the publisher's own identifiers,
// so a failure says which record moved rather than which number did.
const BROOKLYN_CB14 = "brooklyn-cb-14";
const BROOKLYN_CB15 = "brooklyn-cb-15";
// The Cortelyou Road library expansion: a capital request answered by referring
// the board to its elected officials, in both publications a reader is served.
const CORTELYOU_EXPANSION = "214202702C";
// The bus-stop sidewalk, curb and bus-pad request whose answer was rewritten
// between the two publications to report one location's resurfacing.
const BUS_STOP_MAINTENANCE = "214202710C";
// Two Newkirk Plaza requests, addressed to two different bodies, answered
// differently. They must never merge.
const NEWKIRK_PLAZA_DOT = "214202725E";
const NEWKIRK_PLAZA_TRANSIT = "214202735E";
// The Summer Youth Employment request whose text changed only because the
// publisher's wrapper sentence moved.
const WRAPPER_ONLY = "214202727E";
// Shore Boulevard Promenade: supported by the agency, without capital funding.
const SHORE_BOULEVARD = "215202712C";

const NAMED_AGENCIES = ["environmental-protection", "transportation", "parks-and-recreation"];

const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
const textOf = (html) => html
  .replace(/<[^>]*>/g, " ")
  .replace(/&(?:amp|lt|gt|quot|#39);/g, (match) => ENTITIES[match])
  .replace(/\s+/g, " ")
  .trim();

/**
 * The register, recomputed without the module under test.
 *
 * Walk the committed board documents, keep only the versions a reader is
 * served, key each request on the publisher's full tracking code inside its
 * board, and record the agency the last served version names. Nothing here
 * imports the reading it is checking.
 */
function independentRegister() {
  const servable = new Set(REGISTER.publication_selection.servable);
  const byBoard = new Map();
  for (const document of DOCUMENTS) {
    const rows = new Map();
    for (const request of document.requests || []) {
      const versions = (request.versions || []).filter((version) => servable.has(version.publication));
      if (!versions.length) continue;
      const last = versions[versions.length - 1];
      rows.set(request.tracking_code, {
        board_id: request.board_id,
        fiscal_year: request.fiscal_year,
        request_class: request.request_class,
        agency_id: last.responsible_agency.binding === "bound" ? last.responsible_agency.agency_id : null,
        source_label: last.responsible_agency.source_label,
        rank: last.rank?.value ?? null,
        responses: versions.map((version) => version.response),
        publications: versions.map((version) => version.publication),
      });
    }
    byBoard.set(document.board_id, rows);
  }
  return byBoard;
}

const INDEPENDENT = independentRegister();

function boardView(bodyId, { register = REGISTER, document: doc } = {}) {
  const source = doc !== undefined ? doc : DOCUMENTS.find((row) => row.board_id === bodyId);
  return communityBoardBudgetRequestsForBoard(register, source, bodyId);
}

function boardSection(bodyId, options = {}) {
  return renderCommunityBoardBudgetRequestsSection(boardView(bodyId), options);
}

function agencyView(agencyId, { register = REGISTER, documents = DOCUMENTS } = {}) {
  return agencyBudgetRequestsForAgency(register, documents, agencyId, { boardNames: BOARD_NAMES });
}

function agencySection(agencyId, options = {}) {
  return renderAgencyBudgetRequestsSection(agencyView(agencyId), options);
}

function requestOf(bodyId, code) {
  const view = boardView(bodyId);
  const found = view.groups.flatMap((group) => group.requests).find((row) => row.tracking_code === code);
  assert.ok(found, `${bodyId} carries no request ${code}`);
  return found;
}

function groupOf(bodyId, code) {
  const view = boardView(bodyId);
  const found = view.groups.find((group) => group.requests.some((row) => row.tracking_code === code));
  assert.ok(found, `${bodyId} groups no request ${code}`);
  return found;
}

/* ---------- the population, recomputed ---------- */

test("the board reading reproduces the retained register, board for board", () => {
  let boards = 0;
  for (const [boardId, rows] of INDEPENDENT) {
    const view = boardView(boardId);
    assert.equal(view.state, rows.size ? BUDGET_REQUEST_STATES.AVAILABLE : BUDGET_REQUEST_STATES.NONE_RECORDED);
    assert.equal(view.request_count, rows.size, `${boardId} request count`);
    const seen = view.groups.flatMap((group) => group.requests);
    assert.equal(seen.length, rows.size, `${boardId} renders every retained request once`);
    for (const request of seen) {
      const expected = rows.get(request.tracking_code);
      assert.ok(expected, `${boardId} invented ${request.tracking_code}`);
      assert.equal(request.agency.agency_id, expected.agency_id);
      assert.equal(request.agency.source_label, expected.source_label);
      assert.equal(request.fiscal_year, expected.fiscal_year);
      assert.equal(request.rank?.value ?? null, expected.rank);
      assert.deepEqual(request.answers.map((answer) => answer.response), expected.responses);
    }
    boards += 1;
  }
  assert.equal(boards, DOCUMENTS.length);
  assert.ok(boards >= 59, "every community district's document takes part");
});

test("only the publications a reader is served reach a reader, or a comparison", () => {
  // The publisher's forward-dated release is retained for diagnosis. Serving it
  // would answer a resident with an answer nobody has been given yet.
  const diagnostic = new Set(REGISTER.publication_selection.diagnostic_only);
  assert.ok(diagnostic.size >= 1, "the register retains at least one publication a reader is not served");
  const servable = REGISTER.publication_selection.servable;
  for (const boardId of [BROOKLYN_CB14, BROOKLYN_CB15]) {
    for (const request of boardView(boardId).groups.flatMap((group) => group.requests)) {
      assert.deepEqual(request.answers.map((answer) => answer.publication), servable);
      for (const answer of request.answers) assert.ok(!diagnostic.has(answer.publication));
    }
  }
  const rendered = boardSection(BROOKLYN_CB14);
  for (const publication of diagnostic) assert.ok(!rendered.includes(publication), `${publication} reached a reader`);
});

test("identity is the publisher's full tracking code, so a shared number never merges two requests", () => {
  const view = boardView(BROOKLYN_CB14);
  const codes = view.groups.flatMap((group) => group.requests).map((row) => row.tracking_code);
  assert.equal(new Set(codes).size, codes.length, "a tracking code is carried once");
  // The suffix carries the budget class. Two requests whose digits match and
  // whose suffix does not are two requests, and the reading must not fold them.
  const byDigits = new Map();
  for (const code of codes) {
    const digits = code.slice(0, 9);
    byDigits.set(digits, [...(byDigits.get(digits) || []), code]);
  }
  const shared = [...byDigits.values()].filter((group) => group.length > 1);
  for (const group of shared) assert.equal(new Set(group).size, group.length);
});

test("the agency reading reproduces the same population from the other end", () => {
  for (const agencyId of NAMED_AGENCIES) {
    let expected = 0;
    const expectedBoards = new Set();
    for (const [boardId, rows] of INDEPENDENT) {
      for (const row of rows.values()) {
        if (row.agency_id !== agencyId) continue;
        expected += 1;
        expectedBoards.add(boardId);
      }
    }
    const view = agencyView(agencyId);
    assert.equal(view.state, BUDGET_REQUEST_STATES.AVAILABLE);
    assert.equal(view.request_count, expected, `${agencyId} request count`);
    assert.equal(view.board_count, expectedBoards.size, `${agencyId} board count`);
    assert.equal(
      view.boards.reduce((total, board) => total + board.request_count, 0),
      expected,
      `${agencyId} per-board counts sum to its stated population`,
    );
    // The two surfaces are the same records, not two similar lists.
    for (const board of view.boards) {
      const fromBoard = boardView(board.board_id).groups
        .filter((group) => group.agency.agency_id === agencyId)
        .flatMap((group) => group.requests)
        .map((row) => row.tracking_code)
        .sort();
      assert.deepEqual(board.requests.map((row) => row.tracking_code).sort(), fromBoard);
    }
  }
});

/* ---------- the named records ---------- */

test("the Cortelyou library expansion keeps its answer, its scoped priority and its fiscal year", () => {
  const request = requestOf(BROOKLYN_CB14, CORTELYOU_EXPANSION);
  assert.equal(request.fiscal_year, 2027);
  assert.equal(request.request_class, "capital");
  assert.equal(request.rank.value, "02");
  assert.equal(request.rank.scope, "agency_and_request_class");
  assert.equal(request.rank.district_wide, false);
  assert.equal(request.answers.length, 2);
  for (const answer of request.answers) {
    assert.match(answer.response, /brought to the attention of your Elected Officials/);
  }
  // Both served publications carry the same answer. The reading says that in as
  // many words rather than leaving a reader to compare two paragraphs, and it
  // never reports a change the register did not measure.
  assert.equal(request.changed_answer, false);
  assert.equal(request.answers[1].changed, false);
  assert.equal(request.answers[1].wrapper_only, false);
  const rendered = textOf(boardSection(BROOKLYN_CB14));
  assert.ok(rendered.includes("This answer reads the same as the one published May 12, 2026."));
  assert.ok(rendered.includes("Priority 02 among this board's capital requests to this agency"));
  assert.ok(rendered.includes("Fiscal year 2027"));
});

test("a rewritten answer is shown beside the one before it, with the difference named", () => {
  const request = requestOf(BROOKLYN_CB14, BUS_STOP_MAINTENANCE);
  assert.equal(request.changed_answer, true);
  const [first, second] = request.answers;
  assert.equal(first.changed, null, "the first published answer has nothing before it to differ from");
  assert.equal(second.changed, true);
  assert.equal(second.wrapper_only, false);
  assert.match(first.response, /Sidewalks are the responsibility of the adjacent property owner/);
  assert.match(second.response, /resurfaced in Summer 2025/);
  const rendered = boardSection(BROOKLYN_CB14);
  const text = textOf(rendered);
  assert.ok(text.includes("Published May 12, 2026"));
  assert.ok(text.includes("Published June 30, 2026"));
  assert.ok(text.includes("This answer reads differently from the one published May 12, 2026."));
});

test("a reported piece of work is not the request, and the board's own words stay whole", () => {
  // The later answer reports one location's resurfacing. The request is the
  // broader sidewalk, curb and bus-pad ask across the district's bus stops, and
  // the row keeps both without letting the answer rewrite the question.
  const request = requestOf(BROOKLYN_CB14, BUS_STOP_MAINTENANCE);
  assert.match(request.explanation, /sidewalks, curbs, street and bus pads are maintained at all bus stops/);
  assert.match(request.explanation, /Church Avenue and East 18th street/);
  const rendered = textOf(boardSection(BROOKLYN_CB14));
  assert.ok(rendered.includes("sidewalks, curbs, street and bus pads are maintained at all bus stops"));
  assert.ok(rendered.includes("resurfaced in Summer 2025"));
  // Nothing turns either into a status for the request as a whole.
  for (const invented of ["Completed", "Fulfilled", "Delivered", "Resolved", "Closed"]) {
    assert.ok(!rendered.includes(`${invented}:`), `${invented} is asserted as a request status`);
  }
});

test("the two Newkirk Plaza requests stay two requests with two bodies and two answers", () => {
  const dot = requestOf(BROOKLYN_CB14, NEWKIRK_PLAZA_DOT);
  const transit = requestOf(BROOKLYN_CB14, NEWKIRK_PLAZA_TRANSIT);
  assert.notEqual(dot.agency.agency_id, transit.agency.agency_id);
  assert.notEqual(groupOf(BROOKLYN_CB14, NEWKIRK_PLAZA_DOT).slug, groupOf(BROOKLYN_CB14, NEWKIRK_PLAZA_TRANSIT).slug);
  assert.notEqual(dot.latest_answer.response, transit.latest_answer.response);
  assert.match(dot.latest_answer.response, /does not support but can address the need alternatively/i);
  assert.match(transit.latest_answer.response, /does not support and cannot accommodate/i);
  const rendered = boardSection(BROOKLYN_CB14);
  assert.ok(rendered.includes(`id="${dot.anchor}"`));
  assert.ok(rendered.includes(`id="${transit.anchor}"`));
  assert.notEqual(dot.anchor, transit.anchor);
});

test("a supported request without funding is neither a rejection nor a completion", () => {
  const request = requestOf(BROOKLYN_CB15, SHORE_BOULEVARD);
  assert.match(request.latest_answer.response, /Agency supports but cannot accommodate/);
  assert.match(request.latest_answer.response, /do not have capital funding available/);
  const rendered = textOf(boardSection(BROOKLYN_CB15));
  assert.ok(rendered.includes("Agency supports but cannot accommodate"));
  assert.ok(rendered.includes("do not have capital funding available"));
  // The published sentence is the whole finding. Nothing beside it relabels a
  // supported-but-unfunded answer as either a refusal or a delivery.
  assert.ok(!/\bRejected\b/.test(rendered));
  assert.ok(!/\brequest (was )?completed\b/i.test(rendered.replace(/already been completed/gi, "")));
});

/* ---------- what a change is, and is not ---------- */

test("a moved publisher wrapper is reported as a moved wrapper, never as a new answer", () => {
  const request = requestOf(BROOKLYN_CB14, WRAPPER_ONLY);
  const later = request.answers[1];
  assert.equal(later.wrapper_only, true);
  assert.equal(later.changed, false);
  assert.equal(request.changed_answer, false, "a wrapper change is not a changed answer");
  assert.match(request.answers[0].response, /^This request has already been completed/);
  assert.match(later.response, /^OMB supports the agency's position as follows/);
  const text = textOf(boardSection(BROOKLYN_CB14));
  assert.ok(text.includes(
    "Between May 12, 2026 and this publication only the publisher's wrapper sentence changed. "
    + "The answer itself reads the same.",
  ));
});

test("the changed-answer count is the register's own measure, on both surfaces", () => {
  const view = boardView(BROOKLYN_CB14);
  let expected = 0;
  for (const request of DOCUMENTS.find((row) => row.board_id === BROOKLYN_CB14).requests) {
    if ((request.response_comparisons || []).some((row) => row.differs_after_boilerplate_removed)) expected += 1;
  }
  assert.equal(view.changed_answer_count, expected);
  const rendered = textOf(boardSection(BROOKLYN_CB14));
  assert.ok(rendered.includes(`${expected} requests carry an answer that reads differently in the later publication.`));
  const agency = agencyView("transportation");
  assert.equal(
    agency.changed_answer_count,
    agency.boards.reduce((total, board) => total + board.changed_answer_count, 0),
  );
});

test("nothing on either surface scores how an agency answered", () => {
  // The boundary is about this site's own copy. A published answer may quote
  // any figure the agency likes, and rewriting one to satisfy a rule here would
  // be the misreport; what must not exist is a total this site computed.
  for (const strings of Object.values(BUDGET_REQUEST_STRINGS)) {
    for (const [key, value] of Object.entries(strings)) {
      for (const pattern of [/\d+\s*%/, /\bfulfil?l?ment\b/i, /\bsuccess rate\b/i, /\bapproval rate\b/i]) {
        assert.equal(pattern.exec(value), null, `${key} scores an agency: ${pattern}`);
      }
    }
  }
  const view = agencyView("parks-and-recreation");
  // The only aggregates either surface publishes are the register's own counts:
  // how many requests, how many boards, and how many answers read differently.
  assert.deepEqual(
    Object.keys(view).filter((key) => key.endsWith("_count")).sort(),
    ["board_count", "changed_answer_count", "request_count"],
  );
  const rendered = agencySection("parks-and-recreation");
  assert.equal(/data-[a-z-]*(rate|score|percent)/.exec(rendered), null);
  // And the page says so in as many words, so the absence is a stated boundary
  // rather than something a reader has to notice.
  assert.ok(textOf(rendered).includes("none of it scores how the agency answered"));
});

test("a request the board gave no location for keeps the absence, and none is a coordinate", () => {
  const request = requestOf(BROOKLYN_CB14, BUS_STOP_MAINTENANCE);
  assert.equal(request.location, null);
  const located = requestOf(BROOKLYN_CB14, CORTELYOU_EXPANSION);
  assert.equal(located.location, "1305 CORTELYOU ROAD, Brooklyn, NY, USA");
  const text = textOf(boardSection(BROOKLYN_CB14));
  assert.ok(text.includes("The board gave no location for this request."));
  assert.ok(text.includes("Location the board gave: 1305 CORTELYOU ROAD, Brooklyn, NY, USA"));
  // A street the board typed is not a mapped point, and nothing here publishes
  // one: no coordinate pair reaches either surface.
  for (const rendered of [boardSection(BROOKLYN_CB14), agencySection("transportation")]) {
    assert.equal(/-7[34]\.\d{4,}/.exec(rendered), null, "a longitude reached the page");
    assert.equal(/\blatitude\b/i.exec(rendered), null, "a latitude reached the page");
  }
});

test("no adapter diagnostic reaches a resident-facing surface", () => {
  const surfaces = [boardSection(BROOKLYN_CB14), agencySection("transportation")];
  for (const rendered of surfaces) {
    for (const term of [
      "shared_agency_alias_register", "reviewed_exact_publisher_alias", "no_existing_institution",
      "cityscroll.community_board", "cityscroll.agency_budget", "agency_and_request_class",
      "publisher_boro", "diagnostic_only", "retained_fixture", "board_binding",
    ]) {
      assert.ok(!rendered.includes(term), `${term} reached a reader`);
    }
  }
});

/* ---------- scope, continuity and the two surfaces ---------- */

test("the agency scope is an address, so it survives leaving the page and coming back", () => {
  const view = boardView(BROOKLYN_CB14);
  assert.ok(view.groups.length > BUDGET_REQUEST_VISIBLE_GROUPS, "this board exercises the disclosure");
  const rendered = boardSection(BROOKLYN_CB14);
  for (const group of view.groups) {
    assert.equal(group.anchor, `${COMMUNITY_BOARD_BUDGET_REQUESTS_ANCHOR}-${group.slug}`);
    assert.ok(rendered.includes(`id="${group.anchor}"`), `${group.slug} has no address`);
    assert.ok(rendered.includes(`href="#${group.anchor}"`), `${group.slug} cannot be chosen`);
  }
  // Everything past the opening set is closed by the document's own stylesheet
  // and opened by the page's fragment. No script takes part, so the browser's
  // own Back restores the chosen agency and the reader's place with it.
  const collapsed = view.groups.filter((group) => group.collapsed);
  assert.equal(collapsed.length, view.groups.length - BUDGET_REQUEST_VISIBLE_GROUPS);
  assert.ok(CSS.includes(".board-budget-request-group[data-budget-request-group-collapsed] > .board-budget-request-list"));
  assert.ok(CSS.includes(".board-budget-request-group[data-budget-request-group-collapsed]:target > .board-budget-request-list {\n  display: grid;\n}"));
});

test("every request is addressable on its own, so a reader can return to one", () => {
  const rendered = boardSection(BROOKLYN_CB14);
  const view = boardView(BROOKLYN_CB14);
  for (const request of view.groups.flatMap((group) => group.requests)) {
    assert.equal(request.anchor, `budget-request-${request.tracking_code.toLowerCase()}`);
    assert.ok(rendered.includes(`id="${request.anchor}"`));
  }
});

test("each surface links into the other at the scope the reader is already in", () => {
  const boardRendered = boardSection(BROOKLYN_CB14);
  assert.ok(boardRendered.includes(`href="/agencies/transportation/#${AGENCY_BUDGET_REQUESTS_ANCHOR}-${BROOKLYN_CB14}"`));
  assert.ok(boardRendered.includes('href="/agencies/transportation/"'), "the group opens the agency itself");
  const agencyRendered = agencySection("transportation");
  assert.ok(agencyRendered.includes(
    `href="/community-boards/${BROOKLYN_CB14}/#${COMMUNITY_BOARD_BUDGET_REQUESTS_ANCHOR}-transportation"`,
  ));
  assert.ok(agencyRendered.includes(`id="${AGENCY_BUDGET_REQUESTS_ANCHOR}-${BROOKLYN_CB14}"`));
});

test("an agency the register names but this site has no page for keeps its published spelling", () => {
  const group = boardView(BROOKLYN_CB14).groups.find((row) => row.agency.binding === "unbound");
  assert.ok(group, "this board exercises the unbound case");
  assert.equal(group.agency.href, null);
  assert.equal(budgetRequestGroupSlug(group.agency), group.slug);
  assert.match(group.slug, /^named-/, "an unbound label can never collide with a route identity");
  const text = textOf(boardSection(BROOKLYN_CB14));
  assert.ok(text.includes(group.agency.source_label));
  assert.ok(text.includes("This site carries no page for this agency, so its name stays as the city published it."));
});

test("the agency page states the whole population and hands off for the rest", () => {
  const view = agencyView("parks-and-recreation");
  const rendered = agencySection("parks-and-recreation");
  assert.ok(rendered.includes(`data-request-count="${view.request_count}"`));
  assert.ok(textOf(rendered).includes(
    `${view.request_count} community board budget requests for fiscal year 2027 name this agency`,
  ));
  // Every board that asked is listed and reachable, in its own priority order.
  for (const board of view.boards) {
    assert.ok(rendered.includes(`id="${board.anchor}"`), `${board.board_id} is not listed`);
    assert.ok(board.board_scope_href, `${board.board_id} has no destination`);
  }
  // The rows themselves are bounded: a board past the opening set is navigation,
  // and one inside it shows the head of its list and says where the rest are.
  const opened = view.boards.filter((board) => !board.collapsed);
  assert.equal(opened.length, Math.min(view.boards.length, BUDGET_REQUEST_VISIBLE_BOARDS));
  const rows = (rendered.match(/class="node-record board-budget-request"/g) || []).length;
  assert.equal(
    rows,
    opened.reduce((total, board) => total + Math.min(board.request_count, BUDGET_REQUEST_AGENCY_ROWS_PER_BOARD), 0),
  );
  assert.ok(textOf(rendered).includes("are listed on the board's own page"));
});

/* ---------- states ---------- */

test("a board the register holds nothing for says that about the register", () => {
  const view = boardView(BROOKLYN_CB14, { document: { board_id: BROOKLYN_CB14, requests: [] } });
  assert.equal(view.state, BUDGET_REQUEST_STATES.NONE_RECORDED);
  assert.equal(view.request_count, 0);
  const text = textOf(renderCommunityBoardBudgetRequestsSection(view));
  assert.ok(text.includes("The city's budget register holds no request from this board"));
  assert.ok(text.includes("it is not a record that this board asked for nothing"));
  assert.ok(text.includes("A request is what the board asked for."));
});

test("a register that could not be read is a stated failure, never an empty list", () => {
  const failed = boardView(BROOKLYN_CB14, { document: { error: "register unreadable" } });
  assert.equal(failed.state, BUDGET_REQUEST_STATES.UNAVAILABLE);
  const text = textOf(renderCommunityBoardBudgetRequestsSection(failed));
  assert.ok(text.includes("That is a failure to read the register, not a board with no requests."));
  assert.ok(text.includes("Reload this page to try again"));

  const agencyFailed = agencyBudgetRequestsForAgency({ error: "unreadable" }, [], "transportation", {});
  assert.equal(agencyFailed.state, BUDGET_REQUEST_STATES.UNAVAILABLE);
  const agencyText = textOf(renderAgencyBudgetRequestsSection(agencyFailed));
  assert.ok(agencyText.includes("not an agency no board asked anything of"));
  // The two failures read differently from the two absences, which is the whole
  // point of keeping them apart.
  assert.notEqual(text, agencyText);
  const agencyEmpty = agencyView("this-agency-does-not-exist");
  assert.equal(agencyEmpty.state, BUDGET_REQUEST_STATES.NONE_RECORDED);
  assert.ok(textOf(renderAgencyBudgetRequestsSection(agencyEmpty)).includes(
    "records no community board request naming this agency",
  ));
});

test("the register's own provenance reaches the reader, on both surfaces", () => {
  for (const rendered of [boardSection(BROOKLYN_CB14), agencySection("transportation")]) {
    const text = textOf(rendered);
    assert.ok(text.includes("New York City Office of Management and Budget"));
    assert.ok(text.includes("Register of Community Board Budget Requests"));
    assert.ok(text.includes(`Read ${new Intl.DateTimeFormat("en-US", {
      month: "long", day: "numeric", year: "numeric", timeZone: "UTC",
    }).format(new Date(`${REGISTER.publication_selection.as_of}T00:00:00Z`))}`));
    assert.ok(rendered.includes(`href="${REGISTER.source.source_url}"`));
  }
});

/* ---------- affordances ---------- */

test("inspection is a native button beside the links, never inside one", () => {
  const rendered = boardSection(BROOKLYN_CB14);
  const buttons = rendered.match(/<button class="board-budget-request-inspect"[^>]*>/g) || [];
  assert.equal(buttons.length, boardView(BROOKLYN_CB14).request_count);
  for (const button of buttons) {
    assert.ok(button.includes('type="button"'));
    assert.match(button, /aria-label="Inspect request \d{9}(?:C|E|CS) and the answers published for it"/);
  }
  // No control is nested inside an anchor, where a click would mean two things.
  assert.equal(/<a\b[^>]*>(?:(?!<\/a>)[\s\S])*<button/.exec(rendered), null);
  // The stylesheet is what keeps the control out of a scripting-free page.
  assert.ok(CSS.includes(".board-budget-request-inspect {\n  display: none;\n}"));
  assert.ok(CSS.includes("[data-budget-requests-ready] .board-budget-request-inspect {"));
});

test("a document with no scripting at all still carries every fact", () => {
  const rendered = boardSection(BROOKLYN_CB14);
  const withoutScripts = rendered.replace(/<script[\s\S]*?<\/script>/g, "");
  assert.equal(withoutScripts, rendered, "the section ships no script of its own");
  const text = textOf(rendered);
  const request = requestOf(BROOKLYN_CB14, BUS_STOP_MAINTENANCE);
  for (const fact of [
    request.title,
    request.tracking_code,
    request.explanation,
    request.answers[0].response,
    request.answers[1].response,
  ]) {
    assert.ok(text.includes(fact), `a scripting-free reader loses: ${fact.slice(0, 48)}`);
  }
});

test("binding reveals the inspect control, and only then", () => {
  const { doc, container } = mountDocument(boardSection(BROOKLYN_CB14));
  const section = container.querySelector("[data-community-board-budget-requests]");
  assert.equal(section.hasAttribute(BUDGET_REQUEST_BOOT_READY_ATTRIBUTE), false);
  const controller = bindCommunityBoardBudgetRequests(section);
  assert.ok(controller);
  assert.equal(section.hasAttribute(BUDGET_REQUEST_BOOT_READY_ATTRIBUTE), true);
  controller.destroy();
  assert.equal(section.hasAttribute(BUDGET_REQUEST_BOOT_READY_ATTRIBUTE), false);
  assert.ok(doc);
});

test("binding one section twice installs nothing twice", () => {
  const { container } = mountDocument(boardSection(BROOKLYN_CB15));
  const section = container.querySelector("[data-community-board-budget-requests]");
  assert.ok(bindCommunityBoardBudgetRequests(section));
  assert.equal(bindCommunityBoardBudgetRequests(section), null);
});

test("labels this version does not recognise leave the controls hidden", () => {
  assert.equal(parseBudgetRequestLabels(""), null);
  assert.equal(parseBudgetRequestLabels("{"), null);
  assert.equal(parseBudgetRequestLabels(JSON.stringify({ v: 99, close: "Close" })), null);
  const rendered = boardSection(BROOKLYN_CB14)
    .replace(new RegExp(`${BUDGET_REQUEST_LABELS_ATTRIBUTE}="[^"]*"`), `${BUDGET_REQUEST_LABELS_ATTRIBUTE}="{}"`);
  const { container } = mountDocument(rendered);
  const section = container.querySelector("[data-community-board-budget-requests]");
  assert.equal(bindCommunityBoardBudgetRequests(section), null);
  assert.equal(section.hasAttribute(BUDGET_REQUEST_BOOT_READY_ATTRIBUTE), false);
});

test("inspecting one record shows the same record the row already shows", () => {
  const { doc, container } = mountDocument(boardSection(BROOKLYN_CB14));
  const section = container.querySelector("[data-community-board-budget-requests]");
  const controller = bindCommunityBoardBudgetRequests(section);
  const control = container.querySelector(`[${BUDGET_REQUEST_ATTRIBUTE}="${BUS_STOP_MAINTENANCE}"]`);
  assert.ok(control, "the named request offers no control");
  const row = control.closest("li.board-budget-request");
  const record = readBudgetRequestRow(row);
  const request = requestOf(BROOKLYN_CB14, BUS_STOP_MAINTENANCE);
  assert.equal(record.title, request.title);
  assert.equal(record.explanation, request.explanation);
  assert.deepEqual(record.answers.map((answer) => answer.text), request.answers.map((answer) => answer.response));

  click(control);
  const dialog = doc.getElementById(BUDGET_REQUEST_BOOT_DIALOG_ID);
  assert.ok(dialog.open || dialog.hasAttribute("open"));
  const painted = dialog.textContent;
  assert.equal(dialog.querySelector(`#${BUDGET_REQUEST_BOOT_TITLE_ID}`).textContent, request.title);
  assert.ok(painted.includes(request.answers[0].response));
  assert.ok(painted.includes(request.answers[1].response));
  assert.ok(painted.includes("A request is what the board asked for."));
  assert.ok(painted.includes("This answer reads differently from the one published May 12, 2026."));
  assert.equal(dialog.getAttribute("aria-labelledby"), BUDGET_REQUEST_BOOT_TITLE_ID);
  controller.destroy();
});

test("dismissing returns focus to the control it was opened from", () => {
  const { doc, container } = mountDocument(boardSection(BROOKLYN_CB14));
  const section = container.querySelector("[data-community-board-budget-requests]");
  const controller = bindCommunityBoardBudgetRequests(section);
  const control = container.querySelector(`[${BUDGET_REQUEST_ATTRIBUTE}="${CORTELYOU_EXPANSION}"]`);
  click(control);
  const dialog = doc.getElementById(BUDGET_REQUEST_BOOT_DIALOG_ID);
  const close = dialog.querySelector("[data-budget-request-close]");
  assert.equal(doc.activeElement, close, "focus moves into the record that opened");
  click(close);
  assert.equal(doc.activeElement, control);
  controller.destroy();
});

test("Escape dismisses the record on the non-modal fallback path", () => {
  const { doc, container } = mountDocument(boardSection(BROOKLYN_CB14));
  const section = container.querySelector("[data-community-board-budget-requests]");
  const controller = bindCommunityBoardBudgetRequests(section);
  const dialog = doc.getElementById(BUDGET_REQUEST_BOOT_DIALOG_ID);
  // A browser without showModal gets the same dismissal contract, announced
  // rather than inherited.
  dialog.showModal = undefined;
  const control = container.querySelector(`[${BUDGET_REQUEST_ATTRIBUTE}="${CORTELYOU_EXPANSION}"]`);
  click(control);
  assert.equal(dialog.open, true);
  assert.equal(dialog.getAttribute("aria-modal"), "true");
  keydown(dialog, "Escape");
  assert.equal(dialog.open, false);
  assert.equal(doc.activeElement, control);
  controller.destroy();
});

test("Tab stays inside the record on the non-modal fallback path", () => {
  const { doc, container } = mountDocument(boardSection(BROOKLYN_CB14));
  const section = container.querySelector("[data-community-board-budget-requests]");
  const controller = bindCommunityBoardBudgetRequests(section);
  const dialog = doc.getElementById(BUDGET_REQUEST_BOOT_DIALOG_ID);
  dialog.showModal = undefined;
  click(container.querySelector(`[${BUDGET_REQUEST_ATTRIBUTE}="${BUS_STOP_MAINTENANCE}"]`));
  const focusable = dialog.querySelectorAll("a[href], button:not([disabled])");
  assert.ok(focusable.length >= 2, "the record offers a way out as well as a way to close it");
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  last.focus();
  keydown(dialog, "Tab");
  assert.equal(doc.activeElement, first);
  keydown(dialog, "Tab", { shiftKey: true });
  assert.equal(doc.activeElement, last);
  controller.destroy();
});

test("inspecting a second record replaces the first rather than stacking", () => {
  const { doc, container } = mountDocument(boardSection(BROOKLYN_CB14));
  const section = container.querySelector("[data-community-board-budget-requests]");
  const controller = bindCommunityBoardBudgetRequests(section);
  click(container.querySelector(`[${BUDGET_REQUEST_ATTRIBUTE}="${CORTELYOU_EXPANSION}"]`));
  click(container.querySelector(`[${BUDGET_REQUEST_ATTRIBUTE}="${BUS_STOP_MAINTENANCE}"]`));
  const dialog = doc.getElementById(BUDGET_REQUEST_BOOT_DIALOG_ID);
  const titles = dialog.querySelectorAll(".budget-request-dialog-title");
  assert.equal(titles.length, 1);
  assert.equal(titles[0].textContent, requestOf(BROOKLYN_CB14, BUS_STOP_MAINTENANCE).title);
  controller.destroy();
});

test("the agency surface offers the same inspection over the same records", () => {
  const { doc, container } = mountDocument(agencySection("transportation"));
  const section = container.querySelector("[data-agency-budget-requests]");
  const controller = bindCommunityBoardBudgetRequests(section);
  assert.ok(controller, "the agency section binds the same behaviour");
  const control = container.querySelector(`[${BUDGET_REQUEST_ATTRIBUTE}]`);
  click(control);
  const dialog = doc.getElementById(BUDGET_REQUEST_BOOT_DIALOG_ID);
  assert.ok(dialog.textContent.includes("A request is what the board asked for."));
  controller.destroy();
});

/* ---------- language ---------- */

test("both surfaces ship in every shipping language, with the source text preserved", () => {
  assert.deepEqual(Object.keys(BUDGET_REQUEST_STRINGS).sort(), ["en", ...SHIPPING_LANGS].sort());
  const keys = Object.keys(BUDGET_REQUEST_STRINGS.en);
  const request = requestOf(BROOKLYN_CB14, BUS_STOP_MAINTENANCE);
  for (const lang of Object.keys(BUDGET_REQUEST_STRINGS)) {
    assert.deepEqual(Object.keys(BUDGET_REQUEST_STRINGS[lang]).sort(), keys.slice().sort(), `${lang} key set`);
    for (const rendered of [boardSection(BROOKLYN_CB14, { lang }), agencySection("transportation", { lang })]) {
      const text = textOf(rendered);
      assert.ok(text.includes(BUDGET_REQUEST_STRINGS[lang].cbbr_boundary), `${lang} boundary`);
      // The publisher's own words are not translated, and they keep their own
      // language and direction inside a translated page.
      assert.ok(text.includes(request.agency.source_label), `${lang} drops the published agency name`);
      assert.ok(!/\{\w+\}/.test(text), `${lang} leaves an unresolved placeholder`);
    }
    const board = boardSection(BROOKLYN_CB14, { lang });
    assert.ok(board.includes(`<span lang="en" dir="ltr">${request.answers[0].response}`));
    if (lang !== "en") {
      assert.ok(board.includes(`lang="${lang}"`), `${lang} section is not marked`);
      assert.ok(board.includes(`dir="${["ar", "ur"].includes(lang) ? "rtl" : "ltr"}"`));
    }
  }
});

test("the translated absence and failure states keep their own meaning", () => {
  for (const lang of Object.keys(BUDGET_REQUEST_STRINGS)) {
    const empty = textOf(renderCommunityBoardBudgetRequestsSection(
      boardView(BROOKLYN_CB14, { document: { board_id: BROOKLYN_CB14, requests: [] } }),
      { lang },
    ));
    const failed = textOf(renderCommunityBoardBudgetRequestsSection(
      boardView(BROOKLYN_CB14, { document: { error: "unreadable" } }),
      { lang },
    ));
    assert.ok(empty.includes(BUDGET_REQUEST_STRINGS[lang].cbbr_empty), `${lang} absence`);
    assert.ok(failed.includes(BUDGET_REQUEST_STRINGS[lang].cbbr_unavailable), `${lang} failure`);
    assert.notEqual(empty, failed, `${lang} says the same thing for both`);
  }
});

/* ---------- the documents ---------- */

test("the board document carries the section, and everything it already had", async () => {
  const { buildCommunityBoardConstellationMaterialization } = await import(
    "../tools/build_community_board_constellation_documents.mjs"
  );
  const { documents } = buildCommunityBoardConstellationMaterialization();
  const entry = documents.find(([path]) => path.includes(`community-boards/${BROOKLYN_CB14}/`));
  assert.ok(entry, "the board has no document");
  const html = entry[1];
  assert.ok(html.includes(`id="${COMMUNITY_BOARD_BUDGET_REQUESTS_ANCHOR}"`));
  assert.ok(html.includes("Budget requests this district made to city agencies"));
  assert.ok(html.includes("community_board_budget_requests_boot.mjs"));
  // Nothing the page already carried is displaced by the new section.
  for (const kept of [
    "Positions this board recorded on land use projects",
    "civic-object-payload",
    "Connected civic objects",
  ]) {
    assert.ok(html.includes(kept), `the document lost: ${kept}`);
  }
  // The embedded object payload keeps the counts and the provenance and drops
  // the rows, so a page that already renders them does not carry them twice.
  const payload = JSON.parse(html.match(
    /<script id="civic-object-payload" type="application\/json">([\s\S]*?)<\/script>/,
  )[1].replace(/<\\\/script/gi, "</script"));
  assert.equal(payload.budget_requests.request_count, boardView(BROOKLYN_CB14).request_count);
  assert.equal(payload.budget_requests.groups, undefined);
  assert.equal(payload.budget_requests.agencies.length, boardView(BROOKLYN_CB14).agency_count);
});

test("the agency section is written into the document, not fetched after it", () => {
  // A resident who arrives from their own board reads the answer with scripting
  // off, the way they can on the board page.
  assert.equal(budgetRequestsSection.static, true);
  assert.equal(budgetRequestsSection.render({ view: {}, displayView: {} }), "");
  const rendered = budgetRequestsSection.render({ view: { budget_requests: agencyView("transportation") }, displayView: {} });
  assert.ok(rendered.includes(`id="${AGENCY_BUDGET_REQUESTS_ANCHOR}"`));
});

/* ---------- the teaching ---------- */

test("the guide teaches the reading with these records, not with an invented one", () => {
  // The article is wrapped prose, so it is compared with its line breaks
  // collapsed: a sentence the guide quotes must match the surface's own copy
  // regardless of where the paragraph happens to wrap.
  const article = readFileSync(
    new URL("../site/guide/_articles/read-a-budget-request-and-the-answer.md", import.meta.url),
    "utf8",
  ).replace(/\s+/g, " ");
  for (const code of [BUS_STOP_MAINTENANCE, WRAPPER_ONLY, NEWKIRK_PLAZA_DOT, NEWKIRK_PLAZA_TRANSIT]) {
    assert.ok(article.includes(code), `the guide never reaches ${code}`);
  }
  // Every quoted label is a string the surface actually renders.
  const rendered = textOf(boardSection(BROOKLYN_CB14));
  for (const quoted of [
    "Budget requests this district made to city agencies",
    "Choose an agency",
    "Priority 03 among this board's capital requests to this agency",
    "This answer reads differently from the one published May 12, 2026.",
  ]) {
    assert.ok(article.includes(quoted), `the guide does not teach: ${quoted}`);
    assert.ok(rendered.includes(quoted), `the guide quotes copy the page does not render: ${quoted}`);
  }
  assert.ok(article.includes(REGISTER.source.source_url), "the guide does not name where the records come from");
  // The three boundaries the reading exists to hold open are all taught.
  assert.ok(/not funding, not a commitment, and not delivery/.test(article));
  assert.ok(/There is no score/.test(article));
  assert.ok(/not a citywide rank/.test(article));
});

/* ---------- the capture manifest ---------- */

const CAPTURE = read("docs/evidence/board-budget-requests/manifest.json");

test("the capture manifest is the proof, and no image binary is committed", () => {
  const files = readdirSync(new URL("../docs/evidence/board-budget-requests/", import.meta.url));
  assert.deepEqual(files.sort(), ["manifest.json"]);
  assert.match(CAPTURE.revision, /^[0-9a-f]{40}$/);
  assert.ok(CAPTURE.captures.length >= 8, "a single capture is not a proof");
  for (const capture of CAPTURE.captures) {
    // A fixture route carries the surface it reproduces plus the condition it
    // was rendered under, so a receipt never claims a state was read from a
    // page that does not serve it.
    assert.match(capture.route, /^\/(community-boards|agencies)\/[a-z0-9-]+\/( \(.+\))?$/);
    assert.ok(Number.isInteger(capture.viewport.width) && Number.isInteger(capture.viewport.height));
    assert.equal(capture.revision, CAPTURE.revision);
    assert.ok(capture.data_vintage.community_board_budget_register);
    assert.ok(capture.assertion.length > 40, "an assertion this short proves nothing");
    assert.match(capture.render_sha256, /^[0-9a-f]{64}$/);
    // A screenshot is named and hashed, and stays under the ignored local path
    // the amendment requires; the receipt is what is committed.
    if (capture.screenshot) {
      assert.match(capture.screenshot, /^\.artifacts\//);
      assert.match(capture.screenshot_sha256, /^[0-9a-f]{64}$/);
    }
  }
});

test("the captures cover both viewports, both surfaces, both fallbacks and every language", () => {
  const widths = new Set(CAPTURE.captures.map((capture) => capture.viewport.width));
  assert.ok(widths.has(390) && widths.has(1440), "a narrow touch viewport and a desktop one");
  const surfaces = new Set(CAPTURE.captures.map((capture) => capture.surface));
  assert.ok(surfaces.has("community_board_document"));
  assert.ok(surfaces.has("agency_document"));
  const scripting = new Set(CAPTURE.captures.map((capture) => capture.javascript));
  assert.ok(scripting.has("enabled") && scripting.has("disabled"));
  const languages = new Set(CAPTURE.captures.flatMap((capture) => capture.language || []));
  for (const lang of SHIPPING_LANGS) assert.ok(languages.has(lang), `no capture in ${lang}`);
  const cases = new Set(CAPTURE.captures.map((capture) => capture.case));
  for (const named of ["scope-journey", "keyboard", "failed-load", "narrow-touch"]) {
    assert.ok([...cases].some((value) => value.includes(named)), `no capture covers ${named}`);
  }
});

test("the captured population is the register's own, at the vintage it names", () => {
  assert.equal(CAPTURE.data_vintage.community_board_budget_register, REGISTER.acquired_at);
  assert.equal(CAPTURE.counts.requests, REGISTER.counts.requests);
  assert.equal(CAPTURE.counts.board_requests[BROOKLYN_CB14], boardView(BROOKLYN_CB14).request_count);
  for (const agencyId of NAMED_AGENCIES) {
    assert.equal(CAPTURE.counts.agency_requests[agencyId], agencyView(agencyId).request_count);
  }
});

test("the captured journey preserves the chosen agency, the scroll and the list", () => {
  const journey = CAPTURE.captures.find((capture) => capture.case.includes("scope-journey"));
  assert.ok(journey, "no captured journey");
  assert.equal(journey.observed.scope_before, journey.observed.scope_after);
  assert.equal(journey.observed.scroll_before, journey.observed.scroll_after);
  assert.equal(journey.observed.rows_before, journey.observed.rows_after);
  assert.equal(journey.observed.dialog_dismissed, true);
  assert.equal(journey.observed.returned_by_history, true);
});

test("the captured keyboard pass drives the whole affordance without a pointer", () => {
  const keyboard = CAPTURE.captures.find((capture) => capture.case.includes("keyboard"));
  assert.ok(keyboard, "no captured keyboard pass");
  assert.equal(keyboard.observed.opened_with_keyboard, true);
  assert.equal(keyboard.observed.dismissed_with_escape, true);
  assert.equal(keyboard.observed.focus_returned_to_control, true);
  assert.ok(keyboard.observed.smallest_target_px >= 24, "WCAG 2.5.8 target size");
});

test("the captured scripting-free pages carry the record and offer no dead control", () => {
  const fallbacks = CAPTURE.captures.filter((capture) => capture.javascript === "disabled");
  assert.ok(fallbacks.length >= 2, "both surfaces read back with scripting off");
  for (const capture of fallbacks) {
    assert.equal(capture.observed.ready_for_inspection, false);
    assert.equal(capture.observed.visible_inspect_controls, 0);
    assert.ok(capture.observed.rendered_rows > 0);
    assert.equal(capture.observed.no_horizontal_overflow, true);
    assert.ok(capture.observed.answers_visible > 0, "the answers are the record and must be readable");
  }
});

test("the captured failure page stays a failure, with its source still reachable", () => {
  const failure = CAPTURE.captures.find((capture) => capture.case.includes("failed-load"));
  assert.ok(failure, "no captured failure");
  assert.equal(failure.observed.state, BUDGET_REQUEST_STATES.UNAVAILABLE);
  assert.equal(failure.observed.rendered_rows, 0);
  assert.equal(failure.observed.source_link_present, true);
  assert.ok(failure.assertion.includes("failure"));
});
