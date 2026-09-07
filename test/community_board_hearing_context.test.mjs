/**
 * Preparing for a community board's budget hearing from the record.
 *
 * The reading under test joins two things this site already held apart: the
 * agenda a board published for one evening, and the previous cycle's register
 * of what the district asked city agencies for and what they answered. Joining
 * them is only useful if it does not merge them, so most of what is pinned
 * here is a separation rather than a value.
 *
 * Populations are recomputed rather than written down. The request count, the
 * number of compared answers and the passage count all come from a second pass
 * over the committed artifacts, so a later acquisition that legitimately moves
 * a number reports its own figure instead of failing against a stale one. What
 * is pinned is the reasoning and the named records:
 *
 *   - the published agenda's three segments at their published times, and the
 *     budget hearing identified as the one that is a public hearing *and*
 *     names a fiscal year — neither test alone separates it from the cannabis
 *     hearing that opens the same evening
 *   - the hearing's fiscal year and the register's fiscal year are different
 *     years, are both stated, and the copy denies that the older list is the
 *     coming agenda
 *   - a statement passage is tied to a request by board, fiscal year, agency,
 *     budget class and the board's own priority. Two of this board's requests
 *     carry byte-identical explanations, so the test proves the explanation
 *     alone is ambiguous and that both requests still resolve separately
 *   - where the city's data publication and the board's own printing of the
 *     same publication disagree, both are retained and both are rendered
 *   - a document whose text layer yielded nothing is presented as a document,
 *     never as one that was read, and the recorded vote to send a letter is
 *     not treated as evidence of the letter's contents
 *   - the journey from a board request through the hearing context to the
 *     official participation action, and the fact that reading or inspecting
 *     submits nothing
 *   - scope, disclosure state and scroll survive inspecting a record and
 *     dismissing it; every destination is a real link that works unscripted
 *
 *   node --test test/community_board_hearing_context.test.mjs
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  attachStatementPassages,
  hearingComparableText,
  hearingParseClockTime,
  hearingParseFiscalYear,
  parseHearingAgendaSegments,
  parseHearingParticipation,
  parseNeedsStatementPassages,
  parseRatifiedResolution,
  parseRegisterDocumentResponses,
  NEEDS_STATEMENT_AGENCY_BINDINGS,
} from "../warehouse/lib/community_board_hearing_context.mjs";
import {
  COMMUNITY_BOARD_HEARING_CONTEXT_ANCHOR,
  HEARING_CONTEXT_STATES,
  HEARING_CONTEXT_STRINGS,
  communityBoardHearingContextForBoard,
  renderCommunityBoardHearingContextSection,
} from "../site/community_board_hearing_context.mjs";
import {
  COMMUNITY_BOARD_BUDGET_REQUESTS_ANCHOR,
  BUDGET_REQUEST_ATTRIBUTE,
  BUDGET_REQUEST_LABELS_ATTRIBUTE,
  communityBoardBudgetRequestsForBoard,
  renderCommunityBoardBudgetRequestsSection,
} from "../site/community_board_budget_requests.mjs";
import {
  BUDGET_REQUEST_BOOT_DIALOG_ID,
  BUDGET_REQUEST_BOOT_READY_ATTRIBUTE,
  bindCommunityBoardBudgetRequests,
} from "../site/community_board_budget_requests_boot.mjs";
import { meetingForSource } from "../tools/build_community_board_hearing_context.mjs";
import { click, keydown, mountDocument } from "./helpers/preview_dom.mjs";

const require = createRequire(import.meta.url);
globalThis.window = globalThis.window || {};
require("../site/i18n.js");
const SHIPPING_LANGS = globalThis.window.SHIPPING_LANGS;

const read = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));

const ARTIFACT = read("site/data/community_board_hearing_context.json");
const OBSERVATION = read("warehouse/fixtures/community-board-hearing-context/brooklyn-cb-14.json");
const FIXTURE_MANIFEST = read("warehouse/fixtures/community-board-hearing-context/manifest.json");
const REGISTER = read("site/data/community_board_budget_register.json");
const CSS = readFileSync(new URL("../site/civic-documents.css", import.meta.url), "utf8");

const BROOKLYN_CB14 = "brooklyn-cb-14";
const REGISTER_DOCUMENT = read(`site/data/community_board_budget_register/${BROOKLYN_CB14}.json`);

// The board's own published times for the evening of the hearing. These are
// the facts a resident acts on, so they are pinned as the publisher wrote them
// rather than recomputed: a silent change here is a resident in the wrong room.
const CANNABIS_HEARING_TIME = "18:30";
const BUDGET_HEARING_TIME = "18:45";
const REGULAR_MEETING_TIME = "19:00";
const HEARING_FISCAL_YEAR = 2028;
const PREVIOUS_FISCAL_YEAR = 2027;

// The Cortelyou Road library expansion, the worked example: a capital request
// whose published answer refers the board to its elected officials.
const CORTELYOU_EXPANSION = "214202702C";
// Two requests to the same agency at the same priority in different budget
// classes, into which this board wrote one identical explanation.
const SHARED_EXPLANATION_CAPITAL = "214202703C";
const SHARED_EXPLANATION_EXPENSE = "214202709E";
// The one request whose answer the city's data publication and the board's own
// register do not print the same way.
const DISCREPANT_RESPONSE = "214202707E";

const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
const textOf = (html) => html
  .replace(/<[^>]*>/g, " ")
  .replace(/&(?:amp|lt|gt|quot|#39);/g, (match) => ENTITIES[match])
  .replace(/\s+/g, " ")
  .trim();

const board = () => ARTIFACT.boards.find((row) => row.board_id === BROOKLYN_CB14);

// One register reading, shared by every assertion here, because the page
// itself builds one and hands the same objects to both surfaces.
const BUDGET_REQUESTS = communityBoardBudgetRequestsForBoard(REGISTER, REGISTER_DOCUMENT, BROOKLYN_CB14);
const budgetRequestsView = () => BUDGET_REQUESTS;

const viewFor = (artifact = ARTIFACT, bodyId = BROOKLYN_CB14) => communityBoardHearingContextForBoard(
  artifact,
  bodyId,
  { budgetRequests: budgetRequestsView() },
);

const renderFor = (lang = "en") => renderCommunityBoardHearingContextSection(viewFor(), { lang });

/**
 * The register's requests, recomputed without the module under test.
 *
 * Only the publications a reader is served take part, matching the register's
 * own selection rule, so nothing here is measured against a release the
 * publisher dated into the future.
 */
function registerRequests() {
  return REGISTER_DOCUMENT.requests.map((request) => {
    const latest = request.versions.filter((version) => version.servable).at(-1);
    return {
      tracking_code: request.tracking_code,
      fiscal_year: request.fiscal_year,
      request_class: request.request_class,
      agency_label: latest.responsible_agency.source_label,
      rank_value: latest.rank?.value ?? null,
      explanation: latest.explanation ?? null,
      responses: Object.fromEntries(request.versions
        .filter((version) => version.servable && version.response)
        .map((version) => [version.publication, version.response])),
    };
  });
}

test("the published agenda is three segments at the times the board printed", () => {
  const view = viewFor();
  assert.equal(view.state, HEARING_CONTEXT_STATES.AVAILABLE);
  assert.equal(view.hearing.meeting_date, "2026-09-14");

  const times = view.hearing.segments.map((segment) => segment.start_time);
  assert.deepEqual(times, [CANNABIS_HEARING_TIME, BUDGET_HEARING_TIME, REGULAR_MEETING_TIME]);

  const [cannabis, budget, regular] = view.hearing.segments;
  assert.equal(cannabis.kind, "public_hearing");
  assert.equal(budget.kind, "public_hearing");
  assert.equal(regular.kind, "regular_meeting");

  // Both hearings are public hearings, so "public hearing" cannot be what
  // separates the budget one. The named fiscal year is.
  assert.equal(cannabis.budget, false);
  assert.equal(cannabis.fiscal_year, null);
  assert.equal(budget.budget, true);
  assert.equal(budget.fiscal_year, HEARING_FISCAL_YEAR);
  assert.equal(regular.budget, false);
  assert.deepEqual([...budget.budget_classes], ["capital", "expense"]);
  assert.equal(view.hearing.budget_segment.start_time, BUDGET_HEARING_TIME);
});

test("the meeting record the agenda hangs on is one this site already publishes", () => {
  const view = viewFor();
  assert.ok(view.hearing.href, "the hearing must reach a meeting route");
  assert.match(view.hearing.href, /^\/meetings\//);
  assert.ok(view.hearing.source_url.startsWith("https://"));

  // The route comes from the retained meeting index rather than being composed
  // here, so a board with no such meeting resolves to nothing rather than to a
  // plausible-looking address that would answer nobody.
  const index = { institution_edges: [] };
  assert.equal(meetingForSource({ boardId: BROOKLYN_CB14, sourceUrl: view.hearing.source_url, index }), null);
});

test("the hearing's fiscal year and the register's are different years, and the copy says so", () => {
  const view = viewFor();
  assert.equal(view.previous_cycle.fiscal_year, PREVIOUS_FISCAL_YEAR);
  assert.notEqual(view.hearing.budget_segment.fiscal_year, view.previous_cycle.fiscal_year);

  const html = renderFor();
  const text = textOf(html);
  assert.match(html, new RegExp(`data-previous-fiscal-year="${PREVIOUS_FISCAL_YEAR}"`));
  assert.match(html, new RegExp(`data-upcoming-fiscal-year="${HEARING_FISCAL_YEAR}"`));
  assert.ok(text.includes(String(PREVIOUS_FISCAL_YEAR)), "the previous cycle's year is named");
  assert.ok(text.includes(String(HEARING_FISCAL_YEAR)), "the hearing's year is named");
  assert.ok(
    text.includes(HEARING_CONTEXT_STRINGS.en.cbhc_previous_boundary),
    "the page must deny that the previous cycle's list is the coming agenda",
  );
});

test("the previous cycle's request count is the register's own, recomputed", () => {
  const requests = registerRequests();
  assert.equal(viewFor().previous_cycle.request_count, requests.length);
  assert.ok(requests.length > 0);
  for (const request of requests) assert.equal(request.fiscal_year, PREVIOUS_FISCAL_YEAR);
});

test("a statement passage is tied by identity, because the wording is ambiguous", () => {
  const requests = registerRequests();
  const capital = requests.find((request) => request.tracking_code === SHARED_EXPLANATION_CAPITAL);
  const expense = requests.find((request) => request.tracking_code === SHARED_EXPLANATION_EXPENSE);

  // The premise: these two requests carry the same explanation, differ in
  // budget class, and agree on agency and priority. Matching on wording would
  // have to pick one of them arbitrarily.
  assert.equal(hearingComparableText(capital.explanation), hearingComparableText(expense.explanation));
  assert.equal(capital.agency_label, expense.agency_label);
  assert.equal(capital.rank_value, expense.rank_value);
  assert.notEqual(capital.request_class, expense.request_class);

  const passages = viewFor().previous_cycle.passages;
  const byCode = new Map(passages.map((passage) => [passage.tracking_code, passage]));
  for (const code of [SHARED_EXPLANATION_CAPITAL, SHARED_EXPLANATION_EXPENSE, CORTELYOU_EXPANSION]) {
    assert.ok(byCode.has(code), `${code} resolves to its own passage`);
  }
  assert.notEqual(byCode.get(SHARED_EXPLANATION_CAPITAL).budget_class, byCode.get(SHARED_EXPLANATION_EXPENSE).budget_class);

  for (const passage of passages) {
    assert.deepEqual(
      [...passage.identity_keys],
      ["board_id", "fiscal_year", "responsible_agency", "budget_class", "board_priority"],
    );
  }
});

test("a passage whose identity is ambiguous is not attached to a request", () => {
  const requests = registerRequests();
  const passage = {
    budget_class: "capital",
    rank_value: "01",
    agency_abbreviation: "DCP",
    title: "Ambiguous",
    passage: "Two requests satisfy these keys.",
  };
  // Force the ambiguity the identity keys are there to catch: two candidates
  // under one agency, one class and one priority.
  const candidates = [
    { ...requests[0], tracking_code: "214202790C", request_class: "capital", rank_value: "01", agency_label: "Department of City Planning" },
    { ...requests[0], tracking_code: "214202791C", request_class: "capital", rank_value: "01", agency_label: "Department of City Planning" },
  ];
  const { attached, unattached } = attachStatementPassages({ passages: [passage], requests: candidates });
  assert.equal(attached.length, 0);
  assert.equal(unattached.length, 1);
  assert.equal(unattached[0].reason, "ambiguous_identity");
  assert.deepEqual(unattached[0].candidate_tracking_codes, ["214202790C", "214202791C"]);

  // And an agency short form with no reviewed binding ties to nothing rather
  // than being matched loosely onto a similar-looking label.
  const unbound = attachStatementPassages({
    passages: [{ ...passage, agency_abbreviation: "ZZZ" }],
    requests: candidates,
  });
  assert.equal(unbound.attached.length, 0);
  assert.equal(unbound.unattached[0].reason, "no_matching_request");
  assert.ok(!("ZZZ" in NEEDS_STATEMENT_AGENCY_BINDINGS));
});

test("the worked example carries the board's words, the answer, and its own request row", () => {
  const view = viewFor();
  const passage = view.previous_cycle.worked_example;
  const request = view.previous_cycle.worked_example_request;
  assert.equal(passage.tracking_code, CORTELYOU_EXPANSION);
  assert.equal(request.tracking_code, CORTELYOU_EXPANSION);

  // The record taught here is the same object the list below shows, so the two
  // renderings cannot drift.
  const listed = budgetRequestsView().groups
    .flatMap((group) => group.requests)
    .find((row) => row.tracking_code === CORTELYOU_EXPANSION);
  assert.equal(request, listed);

  const html = renderFor();
  assert.ok(html.includes(passage.passage), "the statement passage is rendered verbatim");
  assert.ok(html.includes(request.latest_answer.response), "the published answer is rendered verbatim");
  assert.ok(
    textOf(html).includes(HEARING_CONTEXT_STRINGS.en.cbhc_example_identity),
    "the page states that the tie is by identity rather than wording",
  );
});

test("the two publishers' renderings of one answer are both kept", () => {
  const requests = registerRequests();
  const byCode = new Map(requests.map((request) => [request.tracking_code, request]));
  const rows = OBSERVATION.previous_cycle.response_source_disagreements;
  assert.ok(rows.length >= 1, "at least one disagreement is retained");

  const codes = rows.map((row) => row.tracking_code);
  assert.ok(codes.includes(DISCREPANT_RESPONSE));

  for (const row of rows) {
    const register = byCode.get(row.tracking_code).responses[row.publication];
    // Both versions survive, and they really do differ once typography is set
    // aside — so neither was quietly rewritten into the other.
    assert.equal(register, row.register_response);
    assert.notEqual(hearingComparableText(row.register_response), hearingComparableText(row.board_document_response));
  }

  const view = viewFor();
  const rendered = view.previous_cycle.disagreements.find((row) => row.tracking_code === DISCREPANT_RESPONSE);
  const html = renderFor();
  assert.ok(html.includes(rendered.register_response));
  assert.ok(html.includes(rendered.board_document_response));
  assert.equal(view.previous_cycle.responses_compared, OBSERVATION.previous_cycle.responses_compared);
  assert.ok(view.previous_cycle.responses_compared >= view.previous_cycle.disagreements.length);
});

test("a document with no readable text is presented as unread, never as read", () => {
  const view = viewFor();
  const documents = view.previous_cycle.documents;
  assert.ok(documents.length >= 1);

  const unread = documents.filter((document) => document.extraction_state !== "extracted");
  assert.ok(unread.length >= 1, "the scanned letter of comment is retained without being read");
  for (const document of unread) {
    assert.equal(document.extracted_characters, 0);
    assert.ok(document.source_url.startsWith("https://"), "an unread document is still linked where it was published");
  }

  const html = renderFor();
  for (const document of unread) {
    assert.match(html, new RegExp(`data-document-id="${document.id}"[^>]*data-extraction-state="not_extracted"`));
  }
  const text = textOf(html);
  assert.ok(text.includes(HEARING_CONTEXT_STRINGS.en.cbhc_document_unread_zero));
  assert.ok(!text.includes(HEARING_CONTEXT_STRINGS.en.cbhc_document_read.replace(/\.$/, "") + " " + "letter"));
});

test("the recorded vote is a vote, not the contents of the letter it sent", () => {
  const resolution = viewFor().previous_cycle.ratified_resolution;
  assert.equal(resolution.tally_text, "25-0-1");
  assert.equal(resolution.meeting_date, "2026-03-09");
  assert.match(resolution.action, /^to send a Letter of Comment/);

  const text = textOf(renderFor());
  assert.ok(text.includes("25-0-1"));
  assert.ok(
    text.includes(HEARING_CONTEXT_STRINGS.en.cbhc_vote_boundary),
    "the page must deny that the vote records what the letter says",
  );

  // The parser reads a tally only from an explicit resolution sentence.
  assert.equal(parseRatifiedResolution("The board discussed a letter on March 9, 2026."), null);
  assert.deepEqual(
    parseRatifiedResolution("On a motion, it was: RESOLVED (12-3-1) to adopt the report.").tally,
    { in_favor: 12, opposed: 3, abstaining: 1 },
  );
});

test("the journey ends at the board's own action, and nothing here submits", () => {
  const view = viewFor();
  const html = renderFor();
  const participation = view.hearing.participation;

  // A resident who arrived on a request can reach the requests list, the
  // meeting record and the board's own registration form, each as an ordinary
  // link that works with no scripting.
  assert.match(html, new RegExp(`href="#${COMMUNITY_BOARD_BUDGET_REQUESTS_ANCHOR}"`));
  assert.ok(html.includes(`href="${view.hearing.href}"`));
  assert.ok(participation.speaking_registration_url.startsWith("https://"));
  assert.ok(html.includes(`href="${participation.speaking_registration_url}"`));
  assert.ok(
    participation.written_testimony_passage && /written testimony/i.test(participation.written_testimony_passage),
    "the publisher's own written-testimony instruction is carried",
  );
  assert.ok(html.includes(participation.written_testimony_passage));

  // Nothing on this surface posts anything. The registration form is a link
  // out to the board, not an embedded form, and the section contains no form,
  // no submit control and no field.
  assert.ok(!/<form\b/i.test(html));
  assert.ok(!/<input\b/i.test(html));
  assert.ok(!/type="submit"/i.test(html));
  assert.ok(!/<iframe\b/i.test(html));
  assert.ok(
    textOf(html).includes(HEARING_CONTEXT_STRINGS.en.cbhc_register_boundary),
    "the page says in words that it takes nothing",
  );
});

test("inspecting a record leaves scope, disclosure and scroll where they were", () => {
  const requests = budgetRequestsView();
  const { doc, container } = mountDocument(
    `${renderCommunityBoardHearingContextSection(viewFor(), { lang: "en" })}`
    + `${renderCommunityBoardBudgetRequestsSection(requests, { lang: "en" })}`,
  );
  const section = container.querySelector("[data-community-board-hearing-context]");
  assert.ok(section, "the hearing section is in the document");

  // The affordance is hidden until the behaviour behind it is listening.
  assert.equal(section.getAttribute(BUDGET_REQUEST_BOOT_READY_ATTRIBUTE), null);
  assert.ok(CSS.includes(".board-budget-request-inspect {"));
  assert.ok(CSS.includes(`[${BUDGET_REQUEST_BOOT_READY_ATTRIBUTE}] .board-budget-request-inspect {`));
  assert.ok(section.getAttribute(BUDGET_REQUEST_LABELS_ATTRIBUTE), "the section carries the dialog's labels");

  const controller = bindCommunityBoardBudgetRequests(section);
  assert.ok(controller, "the shared inspect behaviour binds this section");
  assert.equal(section.getAttribute(BUDGET_REQUEST_BOOT_READY_ATTRIBUTE), "");

  // A collapsed agency group in the list below stands for the reader's scope.
  const collapsed = container.querySelectorAll("[data-budget-request-group-collapsed]");
  const collapsedBefore = collapsed.length;
  const button = section.querySelector(`[${BUDGET_REQUEST_ATTRIBUTE}]`);
  assert.ok(button, "the worked example carries an inspect button");
  assert.equal(button.getAttribute("type"), "button", "inspection is a button, never a link");

  click(button);
  const dialog = doc.getElementById(BUDGET_REQUEST_BOOT_DIALOG_ID);
  assert.ok(dialog.open, "the record opens");
  assert.ok(dialog.textContent.includes(CORTELYOU_EXPANSION));

  keydown(dialog, "Escape");
  controller.close();
  assert.equal(dialog.open, false, "dismissing closes the record");
  assert.equal(container.querySelectorAll("[data-budget-request-group-collapsed]").length, collapsedBefore);
  assert.ok(
    container.querySelector(`[data-tracking-code="${CORTELYOU_EXPANSION}"]`),
    "the row the reader came from is still where it was",
  );
  // Nothing navigated: the destination out of the worked example is still an
  // ordinary link the reader has not followed.
  assert.ok(section.querySelector(".board-budget-request-agency-link, .ui-constellation-link"));
  controller.destroy();
});

test("every shipping language renders the whole reading", () => {
  assert.ok(Array.isArray(SHIPPING_LANGS) && SHIPPING_LANGS.length >= 2);
  const keys = Object.keys(HEARING_CONTEXT_STRINGS.en);
  for (const lang of SHIPPING_LANGS) {
    assert.ok(HEARING_CONTEXT_STRINGS[lang], `${lang} has its own strings`);
    assert.deepEqual(
      Object.keys(HEARING_CONTEXT_STRINGS[lang]).sort(),
      keys.slice().sort(),
      `${lang} carries every string`,
    );
    for (const [key, value] of Object.entries(HEARING_CONTEXT_STRINGS[lang])) {
      assert.ok(String(value).trim(), `${lang}.${key} is not empty`);
      if (lang === "en") continue;
      const placeholders = (key) => [...String(key).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
      assert.deepEqual(
        placeholders(value),
        placeholders(HEARING_CONTEXT_STRINGS.en[key]),
        `${lang}.${key} keeps the same placeholders`,
      );
    }

    const html = renderCommunityBoardHearingContextSection(viewFor(), { lang });
    const text = textOf(html);
    assert.ok(html.includes(`id="${COMMUNITY_BOARD_HEARING_CONTEXT_ANCHOR}"`));
    assert.ok(text.includes(HEARING_CONTEXT_STRINGS[lang].cbhc_heading));
    assert.ok(text.includes(HEARING_CONTEXT_STRINGS[lang].cbhc_register_boundary));
    // The publisher's own words stay in the language they were published in,
    // whatever the frame around them is rendered in.
    assert.ok(html.includes(viewFor().previous_cycle.worked_example.passage));
    assert.match(html, /lang="en" dir="ltr"/);
    if (lang !== "en") assert.ok(html.includes(`lang="${lang}"`));
  }
});

test("a board this reading does not cover carries no section, and a failure says so", () => {
  assert.equal(communityBoardHearingContextForBoard(ARTIFACT, "queens-cb-07", {}), null);
  assert.equal(renderCommunityBoardHearingContextSection(null, {}), "");

  const failed = viewFor({ error: "hearing context unreadable" });
  assert.equal(failed.state, HEARING_CONTEXT_STATES.UNAVAILABLE);
  const html = renderCommunityBoardHearingContextSection(failed, { lang: "en" });
  assert.ok(textOf(html).includes(HEARING_CONTEXT_STRINGS.en.cbhc_unavailable));
  // A failure to read is never rendered as a board without a hearing.
  assert.ok(!html.includes(CANNABIS_HEARING_TIME));
  assert.ok(!html.includes(String(HEARING_FISCAL_YEAR)));
});

test("the retained observation is what the artifact was built from", () => {
  const entry = FIXTURE_MANIFEST.boards.find((row) => row.board_id === BROOKLYN_CB14);
  assert.ok(entry, "the manifest names this board's fixture");
  assert.equal(entry.segment_count, OBSERVATION.hearing.segments.length);
  assert.equal(entry.document_count, OBSERVATION.previous_cycle.documents.length);
  assert.equal(entry.hearing_date, OBSERVATION.hearing.meeting_date);

  const published = board();
  assert.equal(published.hearing.source_sha256, OBSERVATION.hearing.receipt.content_sha256);
  for (const document of published.previous_cycle.documents) {
    const observed = OBSERVATION.previous_cycle.documents.find((row) => row.id === document.id);
    assert.equal(document.content_sha256, observed.receipt.content_sha256);
    assert.equal(document.source_url, observed.source_url);
  }
  // Nothing was published that the acquisition failed to confirm.
  assert.deepEqual(published.previous_cycle.document_failures, []);
});

test("the parsers read published structure, and refuse to guess", () => {
  const agenda = parseHearingAgendaSegments(
    '<ul class="wp-block-list schedule-ul">'
    + "<li><strong>6:45 PM &#8211; Public Hearing on Budgets for Fiscal Year 2028</strong>"
    + '<ol class="agenda-ol"><li class="agenda-text">A detail.</li></ol></li>'
    + "<li><strong>To be announced</strong></li>"
    + "</ul><p></p>",
  );
  assert.equal(agenda.length, 1, "a segment with no published time is not invented");
  assert.equal(agenda[0].start_time, "18:45");
  assert.equal(agenda[0].fiscal_year, 2028);
  assert.deepEqual(agenda[0].detail, ["A detail."]);

  assert.equal(hearingParseClockTime("noon"), null);
  assert.equal(hearingParseClockTime("12:00 AM"), "00:00");
  // A bare four-digit number is a street number as often as a year.
  assert.equal(hearingParseFiscalYear("461 Coney Island Avenue, 2028 building"), null);
  assert.equal(hearingParseFiscalYear("Budgets for FY2028"), 2028);

  assert.deepEqual(parseNeedsStatementPassages("Some prose with no summary section."), []);
  assert.deepEqual(parseRegisterDocumentResponses("<page><line xMin=\"1\" yMin=\"1\"><word>Nothing</word></line></page>"), []);

  const participation = parseHearingParticipation("<h4>Something else</h4><p>Text.</p>", "https://example.org/");
  assert.equal(participation.speaking_registration_url, null);
  assert.equal(participation.written_testimony_passage, null);
});

/*
 * The served read-back.
 *
 * The assertions above prove the reading; these prove it was read back from
 * pages as they are served, at two viewports, with and without scripting, by
 * keyboard, in every shipping language, and with the retained reading
 * deliberately unreadable. The receipt is textual by construction: route,
 * viewport, revision, data vintage, assertion and content hashes, with the
 * rendered images kept under an ignored local path.
 */
const CAPTURES = read("docs/evidence/hearing-preparation/manifest.json");

const captureFor = (name) => CAPTURES.captures.find((entry) => entry.case === name);

test("every capture names its route, viewport, revision, vintage and assertion", () => {
  assert.ok(CAPTURES.captures.length >= 20, "the read-back covers every case");
  assert.equal(CAPTURES.revision.length, 40);
  assert.ok(CAPTURES.data_vintage.community_board_hearing_context);
  assert.ok(CAPTURES.data_vintage.community_board_budget_register);
  assert.equal(CAPTURES.axe_all_pass, true);

  for (const entry of CAPTURES.captures) {
    assert.ok(entry.route, `${entry.case} names its route`);
    assert.ok(entry.viewport.width > 0 && entry.viewport.height > 0, `${entry.case} names its viewport`);
    assert.equal(entry.revision, CAPTURES.revision);
    assert.deepEqual(entry.data_vintage, CAPTURES.data_vintage);
    assert.ok(entry.assertion.length > 40, `${entry.case} states what was proved`);
    assert.match(entry.render_sha256, /^[0-9a-f]{64}$/);
    if (entry.screenshot) {
      // The image itself stays local; only its hash and its ignored path are
      // recorded, so the evidence never becomes a committed binary.
      assert.match(entry.screenshot, /^\.artifacts\//);
      assert.match(entry.screenshot_sha256, /^[0-9a-f]{64}$/);
    }
    if (entry.observed.collects_nothing) {
      assert.deepEqual(
        entry.observed.collects_nothing,
        { forms: 0, fields: 0, submits: 0, frames: 0 },
        `${entry.case} collects nothing`,
      );
    }
  }
});

test("the captured pages carry the agenda, both fiscal years and no overflow", () => {
  for (const name of ["hearing-context-narrow-touch", "hearing-context-desktop"]) {
    const entry = captureFor(name);
    assert.equal(entry.observed.state, HEARING_CONTEXT_STATES.AVAILABLE);
    assert.equal(entry.observed.no_horizontal_overflow, true, `${name} does not scroll sideways`);
    assert.ok(entry.observed.smallest_target_px >= 24, `${name} keeps a comfortable touch target`);
    assert.equal(entry.observed.unresolved_key_rendered, false);
    assert.equal(entry.observed.budget_segments, 1, `${name} marks exactly one budget hearing`);
    assert.equal(entry.observed.hearing_fiscal_year_attribute, String(HEARING_FISCAL_YEAR));
    assert.equal(entry.observed.previous_fiscal_year_attribute, String(PREVIOUS_FISCAL_YEAR));
    assert.equal(entry.observed.upcoming_fiscal_year_attribute, String(HEARING_FISCAL_YEAR));
    assert.deepEqual(
      entry.observed.segments.map((segment) => segment.start),
      [CANNABIS_HEARING_TIME, BUDGET_HEARING_TIME, REGULAR_MEETING_TIME],
    );
    assert.equal(entry.observed.states_previous_cycle_boundary, true);
    assert.equal(entry.observed.states_identity_join, true);
    assert.equal(entry.observed.states_submits_nothing, true);
    assert.equal(entry.observed.worked_example_row_present, true);
    assert.equal(entry.observed.links.native, true, `${name} uses real destination links`);
    assert.equal(entry.observed.links.reachable, entry.observed.links.visible);
    assert.equal(entry.observed.links.scripted, 0);
    assert.equal(entry.observed.inspect_controls.native, true);
    assert.equal(entry.observed.inspect_controls.nested_in_link, 0);
  }
});

test("the captured scripting-free pages carry the reading and offer no dead control", () => {
  for (const name of ["hearing-context-no-javascript-narrow-touch", "hearing-context-no-javascript-desktop"]) {
    const entry = captureFor(name);
    assert.equal(entry.javascript, "disabled");
    assert.equal(entry.observed.state, HEARING_CONTEXT_STATES.AVAILABLE);
    assert.equal(entry.observed.visible_inspect_controls, 0, `${name} offers no control that would not work`);
    assert.equal(entry.observed.agenda_times_present, true);
    assert.equal(entry.observed.statement_passage_present, true);
    assert.equal(entry.observed.published_answer_present, true);
    assert.equal(entry.observed.registration_link_present, true);
    assert.equal(entry.observed.no_horizontal_overflow, true);
  }
});

test("the captured journey keeps the reader where they were and submits nothing", () => {
  for (const name of ["hearing-context-journey-narrow-touch", "hearing-context-journey-desktop"]) {
    const entry = captureFor(name);
    assert.equal(entry.observed.dialog_named_the_record, true);
    assert.equal(entry.observed.url_unchanged, true);
    assert.equal(entry.observed.scroll_preserved, true);
    assert.equal(entry.observed.list_preserved, true);
    assert.equal(entry.observed.focus_returned_to_control, true);
    assert.equal(entry.observed.registration_is_a_link, true);
    assert.match(entry.observed.registration_destination, /^https:\/\//);
  }
  const keyboard = captureFor("hearing-context-keyboard-desktop");
  assert.equal(keyboard.observed.control_focusable, true);
  assert.equal(keyboard.observed.focus_moved_into_the_record, true);
  assert.equal(keyboard.observed.escape_dismissed_the_record, true);
  assert.equal(keyboard.observed.focus_returned_to_control, true);
});

test("the captured documents page states what was read and what was not", () => {
  const entry = captureFor("hearing-context-documents-desktop");
  assert.ok(entry.observed.unread_document_rows >= 1);
  assert.equal(entry.observed.states_unread_document, true);
  assert.equal(entry.observed.states_vote_boundary, true);
  assert.equal(entry.observed.states_two_publishers, true);
  assert.equal(
    entry.observed.unread_documents_still_linked,
    entry.observed.unread_document_rows,
    "a document this site has not read is still linked where the board published it",
  );
});

test("the captured language pages keep the publisher's wording in its own language", () => {
  const languages = new Set();
  for (const entry of CAPTURES.captures) {
    if (!entry.case.startsWith("hearing-context-language-")) continue;
    languages.add(entry.language);
    assert.equal(entry.observed.unresolved_key_rendered, false, `${entry.case} resolves every label`);
    assert.equal(entry.observed.published_agenda_wording_preserved, true);
    assert.equal(entry.observed.statement_passage_preserved, true);
    assert.equal(entry.observed.published_answer_preserved, true);
    assert.equal(entry.observed.no_horizontal_overflow, true, `${entry.case} does not scroll sideways`);
    if (entry.language === "ar" || entry.language === "ur") assert.equal(entry.observed.direction, "rtl");
  }
  for (const lang of ["en", ...SHIPPING_LANGS]) assert.ok(languages.has(lang), `no capture in ${lang}`);
});

test("the captured failure page stays a failure, with no agenda it cannot stand behind", () => {
  const entry = captureFor("hearing-context-failed-load");
  assert.equal(entry.observed.state, HEARING_CONTEXT_STATES.UNAVAILABLE);
  assert.equal(entry.observed.budget_segments, 0);
  assert.equal(entry.observed.agenda_absent, true);
  assert.equal(entry.observed.hearing_year_absent, true);
  assert.equal(entry.observed.visible_inspect_controls, 0);
  assert.equal(entry.observed.no_horizontal_overflow, true);
});
