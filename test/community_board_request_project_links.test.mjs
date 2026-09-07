/**
 * The capital project a community board budget request names, and everything
 * this reading refuses to call a capital project.
 *
 * Some published answers name a project by its code outright; some boards name
 * one in their own submission. Joining those two bodies of records on anything
 * looser than a whole published identifier goes wrong in ways the retained data
 * demonstrates: "Bathgate" is a Bronx playground in a request and the published
 * code of an unrelated campus project, "LaGuardia" is an airport in a request
 * and the published code of a college streetscape, a library branch expansion
 * is not that branch's HVAC replacement, and HWX100SBCS is not HWX100SBC.
 *
 * So what is checked here is the reasoning, not a number:
 *
 *   - a candidate is a whole published code carrying a digit, and nothing else
 *     is a candidate, whichever list an ordinary word also appears on
 *   - a candidate is not a relation. Only a reviewed decision, whose passage,
 *     agency and scope still hold in the retained publications, is rendered
 *   - a rendered relation is never fulfilment: the boundary sentence is present
 *     in every shipping language, and where the published answer qualifies the
 *     reference the answer's own words are quoted rather than paraphrased
 *   - the request and the project keep separate dates. The answer carries its
 *     publication date; the phase, the money and the forecast each carry the
 *     capital record they were read from
 *   - a request with no reviewed link renders nothing at all
 *   - the inspect affordance carries the project with the record, and a reader
 *     with no scripting already has all of it in the row
 *
 *   node --test test/community_board_request_project_links.test.mjs
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import {
  REQUEST_PROJECT_MINIMUM_CODE_LENGTH,
  REQUEST_PROJECT_REVIEWED_LINKS,
  REQUEST_PROJECT_REVIEWED_REFUSALS,
  requestProjectCandidates,
  requestProjectCodesInPassage,
} from "../warehouse/lib/community_board_request_project_links.mjs";
import {
  REQUEST_PROJECT_LINK_CLASS,
  REQUEST_PROJECT_STRINGS,
  communityBoardRequestProjectLinkIndex,
  renderRequestProjectLink,
  renderRequestProjectLinks,
} from "../site/community_board_request_project_links.mjs";
import {
  BUDGET_REQUEST_ATTRIBUTE,
  communityBoardBudgetRequestsForBoard,
  renderCommunityBoardBudgetRequestsSection,
} from "../site/community_board_budget_requests.mjs";
import {
  BUDGET_REQUEST_BOOT_DIALOG_ID,
  bindCommunityBoardBudgetRequests,
  readBudgetRequestRow,
} from "../site/community_board_budget_requests_boot.mjs";
import { click, mountDocument } from "./helpers/preview_dom.mjs";

const require = createRequire(import.meta.url);
globalThis.window = globalThis.window || {};
require("../site/i18n.js");
const SHIPPING_LANGS = globalThis.window.SHIPPING_LANGS;

const read = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));

const LINKS = read("site/data/community_board_request_project_links.json");
const REGISTER = read("site/data/community_board_budget_register.json");
const DOCUMENT_DIR = new URL("../site/data/community_board_budget_register/", import.meta.url);
const DOCUMENTS = readdirSync(DOCUMENT_DIR)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => JSON.parse(readFileSync(new URL(name, DOCUMENT_DIR), "utf8")));
const CSS = readFileSync(new URL("../site/civic-documents.css", import.meta.url), "utf8");

/* The named records, addressed by the publishers' own identifiers, so a failure
   says which record moved rather than which number did. */

// Bronx 3 asked for the reconstruction of a street; the answer names the Select
// Bus Service capital project the work is being done under.
const BRONX_CB3 = "bronx-cb-03";
const BRONX_SBS_REQUEST = "103202717C";
const BRONX_SBS_PROJECT = "HWX100SBC";

// Two Brooklyn 4 requests whose answers name the Wyckoff Avenue reconstruction,
// and the Queens 5 request for the same street whose answer says the Queens
// segment was taken out of that project.
const BROOKLYN_CB4 = "brooklyn-cb-04";
const WYCKOFF_REQUESTS = ["204202703CS", "204202704CS"];
const QUEENS_CB5 = "queens-cb-05";
const QUEENS_WYCKOFF_REQUEST = "405202716C";
const WYCKOFF_PROJECT = "HWK876";

// Brooklyn 3's trench restoration: the answer calls the project "in Design",
// and the capital record read later calls it construction procurement.
const BROOKLYN_CB3 = "brooklyn-cb-03";
const TRENCH_REQUEST = "203202719C";

// The negative controls, each a real record.
const BATHGATE_BOARD = "bronx-cb-06";
const BATHGATE_REQUEST = "106202704C";
const LAGUARDIA_BOARD = "bronx-cb-07";
const LAGUARDIA_REQUEST = "107202734E";
const BROOKLYN_CB14 = "brooklyn-cb-14";
const CORTELYOU_EXPANSION = "214202702C";
const NEWKIRK_BRIDGES = "214202708C";
const BURIAL_GROUND = "214202701CS";
const QUEENS_CB12 = "queens-cb-12";
const SOUTH_JAMAICA_REQUEST = "412202704CS";

const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
/** Rendered markup as a reader hears it: tags gone, entities decoded, and the
    whitespace an element boundary leaves before punctuation closed up again. */
const textOf = (html) => html
  .replace(/<[^>]*>/g, " ")
  .replace(/&(?:amp|lt|gt|quot|#39);/g, (match) => ENTITIES[match])
  .replace(/\s+/g, " ")
  .replace(/\s+([,.;:])/g, "$1")
  .trim();

const INDEX = communityBoardRequestProjectLinkIndex(LINKS);

function documentFor(boardId) {
  const found = DOCUMENTS.find((row) => row.board_id === boardId);
  assert.ok(found, `the register carries no document for ${boardId}`);
  return found;
}

function requestFor(boardId, trackingCode) {
  const found = documentFor(boardId).requests.find((row) => row.tracking_code === trackingCode);
  assert.ok(found, `${boardId} carries no request ${trackingCode}`);
  return found;
}

function linkFor(boardId, trackingCode, projectCode) {
  const held = INDEX.forRequest(boardId, trackingCode);
  assert.ok(held, `${boardId} ${trackingCode} carries no reviewed link`);
  const found = held.find((row) => row.project_code === projectCode);
  assert.ok(found, `${boardId} ${trackingCode} carries no link to ${projectCode}`);
  return found;
}

function relationFor(boardId, trackingCode, projectCode) {
  const found = LINKS.relations.find((row) => (
    row.request.board_id === boardId
    && row.request.tracking_code === trackingCode
    && row.evidence.project_code === projectCode
  ));
  assert.ok(found, `no materialized relation ${boardId} ${trackingCode} -> ${projectCode}`);
  return found;
}

function boardSection(boardId, { lang = "en", links = LINKS } = {}) {
  const view = communityBoardBudgetRequestsForBoard(REGISTER, documentFor(boardId), boardId, { projectLinks: links });
  return renderCommunityBoardBudgetRequestsSection(view, { lang });
}

/**
 * The published capital project codes, recomputed from the retained payload
 * without the projection under test.
 */
function publishedCapitalCodes() {
  const dir = new URL("../site/data/procurement_planning_payload/", import.meta.url);
  const codes = new Set();
  for (const name of readdirSync(dir).sort()) {
    if (!name.startsWith("capital-projects-") || !name.endsWith(".json")) continue;
    const shard = JSON.parse(readFileSync(new URL(name, dir), "utf8"));
    for (const row of shard.rows || []) if (row?.fms_id) codes.add(String(row.fms_id).toUpperCase());
  }
  return codes;
}

const PUBLISHED_CODES = publishedCapitalCodes();

/* ---------- what may become a candidate at all ---------- */

test("a candidate is a whole published code that carries a digit", () => {
  assert.deepEqual(
    requestProjectCodesInPassage("reconstructing the SBS BX 6 route under capital project HWX100SBC in 2026", PUBLISHED_CODES),
    [{ code: "HWX100SBC", published_spelling: "HWX100SBC" }],
  );
  // The city publishes both of these as project codes. Neither carries a digit,
  // so neither is ever proposed from an ordinary sentence that uses the word.
  assert.equal(PUBLISHED_CODES.has("BATHGATE"), true);
  assert.equal(PUBLISHED_CODES.has("LAGUARDIA"), true);
  assert.deepEqual(requestProjectCodesInPassage("The playground and benches area in Bathgate Playground need to be upgraded.", PUBLISHED_CODES), []);
  assert.deepEqual(requestProjectCodesInPassage("Add a new Select Bus Service line from the Fordham Road area to LaGuardia Airport.", PUBLISHED_CODES), []);
});

test("a longer published code is not the shorter code it begins with", () => {
  assert.equal(PUBLISHED_CODES.has("HWX100SBC"), true);
  assert.deepEqual(requestProjectCodesInPassage("HWX100SBCS-REI Services TO#002A", PUBLISHED_CODES), []);
});

test("a code shorter than the floor is never proposed", () => {
  assert.equal(REQUEST_PROJECT_MINIMUM_CODE_LENGTH, 6);
  const short = [...PUBLISHED_CODES].filter((code) => code.length < REQUEST_PROJECT_MINIMUM_CODE_LENGTH && /\d/.test(code));
  assert.ok(short.length, "the publisher carries no short code to check the floor against");
  for (const code of short.slice(0, 5)) {
    assert.deepEqual(requestProjectCodesInPassage(`work under ${code} continues`, PUBLISHED_CODES), []);
  }
});

test("one spelling difference is looked through, and it is recorded as published", () => {
  const found = requestProjectCodesInPassage("RECONSTRUCT WYCKOFF AVENUE ... - HWK 876.", PUBLISHED_CODES);
  assert.deepEqual(found, [{ code: "HWK876", published_spelling: "HWK 876" }]);
});

/* ---------- the materialization, recomputed ---------- */

test("every reviewed relation is still a candidate in the passage it was reviewed from", () => {
  for (const relation of LINKS.relations) {
    const request = requestFor(relation.request.board_id, relation.request.tracking_code);
    const candidates = requestProjectCandidates(request, PUBLISHED_CODES);
    const candidate = candidates.find((row) => row.project_code === relation.evidence.project_code);
    assert.ok(candidate, `${relation.request.tracking_code} no longer names ${relation.evidence.project_code}`);
    assert.ok(candidate.named_in.includes(relation.evidence.reviewed_named_in));
    assert.deepEqual(candidate.named_in, relation.evidence.named_in);
  }
  assert.equal(LINKS.relations.length, REQUEST_PROJECT_REVIEWED_LINKS.length);
});

test("no request carries a rendered link that no reviewed decision covers", () => {
  const reviewed = new Set(REQUEST_PROJECT_REVIEWED_LINKS.map((row) => `${row.board_id}|${row.tracking_code}|${row.project_code}`));
  for (const relation of LINKS.relations) {
    const key = `${relation.request.board_id}|${relation.request.tracking_code}|${relation.evidence.project_code}`;
    assert.ok(reviewed.has(key), `${key} is rendered without a reviewed decision`);
  }
  // A candidate nobody has reviewed is retained in the artifact and rendered to
  // nobody, so the queue is visible without being published as a finding.
  for (const pending of LINKS.candidates_pending_review) {
    assert.equal(INDEX.forRequest(pending.board_id, pending.tracking_code), null);
  }
});

test("every reviewed quotation is still verbatim in a publication a reader is served", () => {
  const servable = new Set(REGISTER.publication_selection.servable);
  for (const relation of LINKS.relations) {
    const quote = relation.review.scope_difference_quote;
    assert.ok(quote, `${relation.request.tracking_code} carries no published wording for its scope difference`);
    const request = requestFor(relation.request.board_id, relation.request.tracking_code);
    const version = request.versions.find((row) => row.publication === quote.publication);
    assert.ok(version && servable.has(version.publication));
    const field = quote.named_in === "response" ? version.response : version.explanation;
    assert.ok(String(field).includes(quote.quote), `${relation.request.tracking_code} quotation is not verbatim`);
  }
});

/* ---------- the accepted records ---------- */

test("the Bronx 3 street reconstruction reaches the project its answer names", () => {
  const link = linkFor(BRONX_CB3, BRONX_SBS_REQUEST, BRONX_SBS_PROJECT);
  assert.equal(link.named_in, "response");
  assert.equal(link.managing_agency, "DDC");
  assert.equal(link.project_name, "South Bronx East-West Crosstown SBS");
  assert.equal(link.current_phase, "Construction");
  assert.equal(link.project_budget, 57611798.46);
  assert.equal(link.recorded_project_spending, 8931746);
  assert.equal(link.reporting_period, "202605");
  assert.equal(link.from_latest_retained_release, true);
  assert.match(link.passage, /capital project HWX100SBC/);
  assert.ok(link.project_scope, "the project record publishes no scope");
  assert.equal(link.managing.href, "/agencies/design-and-construction/");
  assert.deepEqual(link.sponsoring.map((row) => row.href), ["/agencies/transportation/"]);

  const rendered = renderRequestProjectLink(link, { lang: "en" });
  const text = textOf(rendered);
  assert.match(text, /Phase Construction, from the capital record for May 2026\./);
  assert.match(text, /Project budget \$57,611,798/);
  assert.match(text, /recorded project spending \$8,931,746/);
  assert.match(text, /from the capital record dated May 18, 2026\./);
  assert.ok(text.includes(link.project_scope), "the scope is not rendered beside the link");
  assert.match(rendered, /href="\/agencies\/design-and-construction\/"/);
  assert.match(rendered, /href="\/agencies\/transportation\/"/);
});

test("the two Brooklyn 4 requests and the Queens 5 one read the same project three ways", () => {
  for (const trackingCode of WYCKOFF_REQUESTS) {
    const link = linkFor(BROOKLYN_CB4, trackingCode, WYCKOFF_PROJECT);
    assert.equal(link.named_in, "response");
    assert.equal(link.current_phase, "Design");
    assert.equal(link.published_spelling, null, "the Brooklyn answers spell the code as the city publishes it");
  }

  const queens = linkFor(QUEENS_CB5, QUEENS_WYCKOFF_REQUEST, WYCKOFF_PROJECT);
  assert.equal(queens.named_in, "board_submission");
  assert.equal(queens.published_spelling, "HWK 876");
  assert.equal(queens.current_phase, "Design");
  assert.equal(queens.reporting_period, "202605");
  // The whole point of the Queens record: the answer says this district's
  // segment came out of the project, and the relationship has to say so.
  assert.match(queens.difference_quote, /the Queens segment was removed and improved via in-house resurfacing/);

  const text = textOf(renderRequestProjectLink(queens, { lang: "en" }));
  assert.match(text, /Named in the board's own submission\. The published answer does not name it\./);
  assert.match(text, /The passage spells it HWK 876\. The city publishes the project as HWK876\./);
  assert.match(text, /the Queens segment was removed and improved via in-house resurfacing/);
  assert.match(text, /Phase Design, from the capital record for May 2026\./);
});

test("the answer's date and the project's dates never become one clock", () => {
  const link = linkFor(BROOKLYN_CB3, TRENCH_REQUEST, "HWTRK1");
  // The published answer calls the project "in Design"; the capital record read
  // afterwards calls it construction procurement. Both are kept, each dated.
  assert.match(link.difference_quote, /currently in Design at DDC/);
  assert.equal(link.current_phase, "Construction Procurement");
  const text = textOf(renderRequestProjectLink(link, { lang: "en" }));
  assert.match(text, /Named in the answer published June 30, 2026\./);
  assert.match(text, /Phase Construction Procurement, from the capital record for May 2026\./);
});

test("a project record older than the latest release says so", () => {
  const stale = LINKS.relations.filter((row) => row.capital_project.observation.from_latest_retained_release === false);
  assert.ok(stale.length, "no retained project is older than the current release");
  for (const relation of stale) {
    const link = linkFor(relation.request.board_id, relation.request.tracking_code, relation.evidence.project_code);
    const text = textOf(renderRequestProjectLink(link, { lang: "en" }));
    assert.match(text, /most recent capital record retained for this project, and it is older than/);
  }
});

test("a code published under two managing agencies keeps them apart", () => {
  const shared = LINKS.relations.filter((row) => row.capital_project.also_published_under_managing_agencies.length);
  assert.ok(shared.length, "no reviewed project shares its code with another managing agency");
  for (const relation of shared) {
    const link = linkFor(relation.request.board_id, relation.request.tracking_code, relation.evidence.project_code);
    assert.match(textOf(renderRequestProjectLink(link, { lang: "en" })), /which is a different record/);
  }
});

/* ---------- the negative controls ---------- */

test("an ordinary word that is also a published code is refused, and never proposed", () => {
  for (const [boardId, trackingCode, code] of [
    [BATHGATE_BOARD, BATHGATE_REQUEST, "BATHGATE"],
    [LAGUARDIA_BOARD, LAGUARDIA_REQUEST, "LAGUARDIA"],
  ]) {
    const refusal = LINKS.reviewed_refusals.find((row) => (
      row.request.tracking_code === trackingCode && row.project_code === code
    ));
    assert.ok(refusal, `${trackingCode} carries no reviewed refusal for ${code}`);
    assert.equal(refusal.refusal_class, "ordinary_word_published_as_code");
    assert.equal(refusal.published_as_a_project_code, true);
    assert.equal(refusal.was_a_candidate, false);
    assert.equal(INDEX.forRequest(boardId, trackingCode), null);
    assert.equal(requestProjectCandidates(requestFor(boardId, trackingCode), PUBLISHED_CODES).length, 0);
  }
});

test("a facility or street name that reads alike is never a relation", () => {
  for (const [trackingCode, code] of [[CORTELYOU_EXPANSION, "LBM25CTIF"], [NEWKIRK_BRIDGES, "HBK243140"]]) {
    const refusal = LINKS.reviewed_refusals.find((row) => (
      row.request.tracking_code === trackingCode && row.project_code === code
    ));
    assert.ok(refusal, `${trackingCode} carries no reviewed refusal for ${code}`);
    assert.equal(refusal.refusal_class, "name_similarity_only");
    assert.equal(refusal.published_as_a_project_code, true);
    assert.equal(refusal.was_a_candidate, false);
    assert.equal(INDEX.forRequest(BROOKLYN_CB14, trackingCode), null);
    const request = requestFor(BROOKLYN_CB14, trackingCode);
    for (const version of request.versions) {
      assert.equal(String(version.response || "").includes(code), false);
      assert.equal(String(version.explanation || "").includes(code), false);
    }
  }
});

test("a request that names a project only in prose proposes nothing", () => {
  const refusal = LINKS.reviewed_refusals.find((row) => row.request.tracking_code === BURIAL_GROUND);
  assert.ok(refusal);
  assert.equal(refusal.refusal_class, "no_published_identifier");
  assert.equal(refusal.project_code, null);
  assert.equal(INDEX.forRequest(BROOKLYN_CB14, BURIAL_GROUND), null);
  assert.equal(requestProjectCandidates(requestFor(BROOKLYN_CB14, BURIAL_GROUND), PUBLISHED_CODES).length, 0);
});

test("a candidate whose scope was not established stays a candidate", () => {
  const refusal = LINKS.reviewed_refusals.find((row) => row.request.tracking_code === SOUTH_JAMAICA_REQUEST);
  assert.ok(refusal);
  assert.equal(refusal.refusal_class, "scope_not_established");
  assert.equal(refusal.was_a_candidate, true);
  assert.equal(refusal.published_as_a_project_code, true);
  // The rule proposed it and the review refused it: both have to be true, or
  // the control is proving nothing about review.
  const candidates = requestProjectCandidates(requestFor(QUEENS_CB12, SOUTH_JAMAICA_REQUEST), PUBLISHED_CODES);
  assert.deepEqual(candidates.map((row) => row.project_code), [refusal.project_code]);
  assert.equal(INDEX.forRequest(QUEENS_CB12, SOUTH_JAMAICA_REQUEST), null);
  assert.equal(REQUEST_PROJECT_REVIEWED_REFUSALS.length, LINKS.reviewed_refusals.length);
});

/* ---------- what the rendered page does and does not say ---------- */

test("an absent link adds nothing to the row", () => {
  const section = boardSection(BROOKLYN_CB14);
  assert.equal(section.includes(REQUEST_PROJECT_LINK_CLASS), false, "a board with no reviewed link renders a project block");
  assert.equal(renderRequestProjectLinks(null, { lang: "en" }), "");
  assert.equal(renderRequestProjectLinks([], { lang: "en" }), "");

  const bronx = boardSection(BRONX_CB3);
  const blocks = bronx.match(/class="board-request-project"/g) || [];
  assert.equal(blocks.length, INDEX.forRequest(BRONX_CB3, BRONX_SBS_REQUEST).length);
});

test("a missing or unrecognised materialization removes the relation and nothing else", () => {
  const withNothing = boardSection(BRONX_CB3, { links: null });
  assert.equal(withNothing.includes(REQUEST_PROJECT_LINK_CLASS), false);
  assert.ok(withNothing.includes(BRONX_SBS_REQUEST), "the request itself stopped rendering");

  const tampered = { ...LINKS, policy: { ...LINKS.policy, relation_is_not_fulfilment: false } };
  assert.equal(communityBoardRequestProjectLinkIndex(tampered).available, false);
  assert.equal(boardSection(BRONX_CB3, { links: tampered }).includes(REQUEST_PROJECT_LINK_CLASS), false);
});

test("every rendered link carries the boundary that it is not fulfilment", () => {
  for (const relation of LINKS.relations) {
    const link = linkFor(relation.request.board_id, relation.request.tracking_code, relation.evidence.project_code);
    const text = textOf(renderRequestProjectLink(link, { lang: "en" }));
    assert.ok(text.includes(REQUEST_PROJECT_STRINGS.en.crpl_boundary), `${relation.request.tracking_code} renders no boundary`);
    for (const claim of [/\bthis request is funded\b/i, /\bhas been delivered\b/i, /\brequest was completed\b/i]) {
      assert.equal(claim.test(text), false, `${relation.request.tracking_code} reads as fulfilment`);
    }
  }
});

test("every destination is a real anchor, and the block needs no scripting", () => {
  const rendered = renderRequestProjectLink(linkFor(BRONX_CB3, BRONX_SBS_REQUEST, BRONX_SBS_PROJECT), { lang: "en" });
  assert.equal(/<button/.test(rendered), false, "the block installs a control of its own");
  assert.equal(/onclick|data-action=/.test(rendered), false);
  const hrefs = [...rendered.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(hrefs.length >= 3);
  for (const href of hrefs) {
    assert.ok(href.startsWith("/agencies/") || href.startsWith("https://"), `unexpected destination ${href}`);
  }
  assert.ok(hrefs.includes("https://data.cityofnewyork.us/d/fb86-vt7u"));
});

test("the rendered block styles itself in logical properties, so it mirrors in Arabic and Urdu", () => {
  assert.match(CSS, /\.board-request-project \{/);
  const block = CSS.slice(CSS.indexOf(".board-request-project {"));
  assert.match(block, /padding-inline-start/);
  assert.match(block, /border-inline-start/);
  assert.equal(/\.board-request-project \{[^}]*(?:padding-left|border-left|margin-left)/.test(CSS), false);
  // Destinations wrap rather than pushing the row sideways on a narrow screen.
  assert.match(CSS, /\.board-request-project-actions \{[^}]*flex-wrap: wrap/);
});

/* ---------- the reader's own language ---------- */

test("the copy ships in every language this site serves", () => {
  assert.deepEqual(Object.keys(REQUEST_PROJECT_STRINGS).sort(), ["en", ...SHIPPING_LANGS].sort());
  const keys = Object.keys(REQUEST_PROJECT_STRINGS.en);
  assert.ok(keys.length >= 12);
  for (const lang of Object.keys(REQUEST_PROJECT_STRINGS)) {
    assert.deepEqual(Object.keys(REQUEST_PROJECT_STRINGS[lang]).sort(), keys.slice().sort(), `${lang} key set`);
    for (const key of keys) {
      const value = REQUEST_PROJECT_STRINGS[lang][key];
      assert.ok(typeof value === "string" && value.trim(), `${lang} ${key} is empty`);
      const slots = (REQUEST_PROJECT_STRINGS.en[key].match(/\{\w+\}/g) || []).sort();
      assert.deepEqual((value.match(/\{\w+\}/g) || []).sort(), slots, `${lang} ${key} placeholders`);
    }
  }
});

test("a translated page keeps the boundary and leaves the publisher's own wording alone", () => {
  const link = linkFor(BRONX_CB3, BRONX_SBS_REQUEST, BRONX_SBS_PROJECT);
  for (const lang of ["en", ...SHIPPING_LANGS]) {
    const rendered = renderRequestProjectLink(link, { lang });
    const text = textOf(rendered);
    assert.ok(text.includes(REQUEST_PROJECT_STRINGS[lang].crpl_boundary), `${lang} boundary`);
    assert.ok(text.includes(link.passage), `${lang} passage is not the publisher's own`);
    assert.ok(text.includes(link.project_name), `${lang} project name`);
    assert.match(rendered, /lang="en" dir="ltr"/);
    assert.ok(boardSection(BRONX_CB3, { lang }).includes(REQUEST_PROJECT_LINK_CLASS), `${lang} board page`);
  }
});

/* ---------- inspecting one record ---------- */

test("the project travels with the record the inspect control lifts out", () => {
  const { doc, container } = mountDocument(boardSection(BRONX_CB3));
  const section = container.querySelector("[data-community-board-budget-requests]");
  const controller = bindCommunityBoardBudgetRequests(section);
  assert.ok(controller);
  const control = container.querySelector(`[${BUDGET_REQUEST_ATTRIBUTE}="${BRONX_SBS_REQUEST}"]`);
  assert.ok(control, "the named request offers no inspect control");
  const record = readBudgetRequestRow(control.closest("li.board-budget-request"));
  assert.equal(record.projects.length, 1);
  const project = record.projects[0];
  const link = linkFor(BRONX_CB3, BRONX_SBS_REQUEST, BRONX_SBS_PROJECT);
  assert.ok(project.identity.includes(BRONX_SBS_PROJECT));
  assert.ok(project.passage.includes(link.passage));
  assert.ok(project.boundary.includes(REQUEST_PROJECT_STRINGS.en.crpl_boundary));
  assert.equal(project.observations.length >= 3, true);
  assert.deepEqual(
    project.actions.map((action) => action.href),
    ["/agencies/design-and-construction/", "/agencies/transportation/", "https://data.cityofnewyork.us/d/fb86-vt7u"],
  );

  click(control);
  const dialog = doc.getElementById(BUDGET_REQUEST_BOOT_DIALOG_ID);
  assert.ok(dialog.open || dialog.hasAttribute("open"));
  const painted = String(dialog.textContent || "");
  assert.ok(painted.includes(BRONX_SBS_PROJECT), "the dialog drops the project");
  assert.ok(painted.includes(REQUEST_PROJECT_STRINGS.en.crpl_boundary), "the dialog drops the boundary");
  for (const observation of project.observations) assert.ok(painted.includes(observation));
  controller.destroy();
});

test("a reader with no scripting already has the whole block in the row", () => {
  const section = boardSection(BRONX_CB3);
  const { container } = mountDocument(section);
  // Nothing is bound, so nothing is ready and no control is offered; the block
  // and every one of its destinations are in the document regardless.
  assert.equal(container.querySelector("[data-community-board-budget-requests]").hasAttribute("data-budget-requests-ready"), false);
  const link = linkFor(BRONX_CB3, BRONX_SBS_REQUEST, BRONX_SBS_PROJECT);
  const text = textOf(section);
  assert.ok(text.includes(link.passage));
  assert.ok(text.includes(link.project_scope));
  assert.ok(text.includes(REQUEST_PROJECT_STRINGS.en.crpl_boundary));
  assert.equal(container.querySelectorAll(".board-request-project-action").length, 3);
});

/* ---------- the served read-back ---------- */

const CAPTURE = read("docs/evidence/board-request-project-links/manifest.json");

test("the capture manifest names every case the relation has to survive", () => {
  assert.equal(CAPTURE.schema, "cityscroll.board_request_project_capture.v1");
  assert.ok(CAPTURE.captures.length >= 20);
  for (const capture of CAPTURE.captures) {
    for (const field of ["case", "route", "viewport", "revision", "data_vintage", "assertion", "render_sha256"]) {
      assert.ok(capture[field], `${capture.case} carries no ${field}`);
    }
    assert.match(capture.revision, /^[0-9a-f]{40}$/);
    assert.match(capture.render_sha256, /^[0-9a-f]{64}$/);
    // The convention this change keeps: no image binary is committed. A capture
    // that took a screenshot names it under the ignored artifact directory and
    // records its digest here instead.
    if (capture.screenshot) {
      assert.ok(capture.screenshot.startsWith(".artifacts/"), `${capture.case} stores an image outside the ignored path`);
      assert.match(capture.screenshot_sha256, /^[0-9a-f]{64}$/);
    }
  }
  const widths = new Set(CAPTURE.captures.map((capture) => capture.viewport.width));
  assert.ok(widths.has(390) && widths.has(1440), "both viewports are not covered");
  const cases = CAPTURE.captures.map((capture) => capture.case);
  for (const named of ["keyboard", "journey", "no-javascript", "failed-load", "materialization-absent", "scope-difference", "narrow-baseline"]) {
    assert.ok(cases.some((value) => value.includes(named)), `no capture covers ${named}`);
  }
  const languages = new Set(CAPTURE.captures.map((capture) => capture.language));
  for (const lang of ["en", ...SHIPPING_LANGS]) assert.ok(languages.has(lang), `no capture in ${lang}`);
  assert.equal(CAPTURE.axe_all_pass, true);
});

test("the captured population is the relation's own, at the vintage it names", () => {
  assert.equal(CAPTURE.data_vintage.community_board_budget_register, REGISTER.acquired_at);
  assert.equal(CAPTURE.data_vintage.request_project_links_reviewed_on, LINKS.reviewed_on);
  assert.equal(
    CAPTURE.data_vintage.capital_projects_latest_release,
    LINKS.source_scope.capital_projects.latest_retained_release,
  );
  assert.equal(CAPTURE.counts.relations, LINKS.counts.relations);
  assert.equal(CAPTURE.counts.reviewed_refusals, LINKS.counts.reviewed_refusals);
  assert.equal(CAPTURE.positive_project, BRONX_SBS_PROJECT);
});

test("every served page states the boundary on every block it renders", () => {
  const rendered = CAPTURE.captures.filter((capture) => (capture.observed.project_blocks || 0) > 0);
  assert.ok(rendered.length >= 15);
  for (const capture of rendered) {
    assert.equal(capture.observed.states_boundary, true, `${capture.case} renders no boundary`);
    assert.equal(capture.observed.boundary_on_every_block, true, `${capture.case} leaves a block unbounded`);
    assert.equal(capture.observed.claims_fulfilment, false, `${capture.case} reads as fulfilment`);
    assert.equal(capture.observed.unresolved_key_rendered, false, `${capture.case} leaves a label unresolved`);
    assert.ok(capture.observed.observation_lines >= capture.observed.project_blocks * 2);
    assert.equal(capture.observed.destinations.native, true, `${capture.case} offers a destination that is not an anchor`);
    assert.equal(capture.observed.destinations.new_tab, 0);
    assert.equal(capture.observed.destinations.scripted, 0);
    assert.equal(capture.observed.destinations.reachable, capture.observed.destinations.visible);
    assert.equal(capture.observed.project_block_fits_its_row, true, `${capture.case} block is wider than its row`);
  }
});

test("a page that scrolls sideways on a narrow screen does so without this block", () => {
  const narrow = CAPTURE.captures.filter((capture) => (
    capture.viewport.width === 390 && capture.observed.no_horizontal_overflow === false
  ));
  for (const capture of narrow) {
    // Rows this change never touched are already wider than the viewport there,
    // and the baseline capture proves it with the relation removed entirely.
    assert.ok(capture.observed.row_overflow.overflowing_without_a_project_block > 0, `${capture.case} overflow`);
    assert.equal(capture.observed.project_block_fits_its_row, true);
  }
  const baseline = CAPTURE.captures.find((capture) => capture.case.includes("narrow-baseline"));
  assert.ok(baseline);
  assert.equal(baseline.observed.project_blocks, 0);
  assert.ok(baseline.observed.row_overflow.overflowing > 0);
  assert.equal(baseline.observed.row_overflow.overflowing, baseline.observed.row_overflow.overflowing_without_a_project_block);
});

test("the captured scripting-free pages carry the whole block and offer no dead control", () => {
  const fallbacks = CAPTURE.captures.filter((capture) => capture.javascript === "disabled");
  assert.ok(fallbacks.length >= 2, "both viewports read back with scripting off");
  for (const capture of fallbacks) {
    assert.equal(capture.observed.ready_for_inspection, false);
    assert.equal(capture.observed.visible_inspect_controls, 0);
    assert.equal(capture.observed.project_blocks, 1);
    assert.equal(capture.observed.names_the_project, true);
    assert.equal(capture.observed.states_phase_and_period, true);
    assert.equal(capture.observed.states_money_with_its_own_date, true);
    assert.equal(capture.observed.states_project_scope, true);
    assert.equal(capture.observed.destinations.count, 3);
  }
});

test("the captured journey keeps the reader's scope, list and place", () => {
  const journeys = CAPTURE.captures.filter((capture) => capture.surface === "journey");
  assert.ok(journeys.length >= 2);
  for (const journey of journeys) {
    assert.equal(journey.observed.scope_before, journey.observed.scope_after);
    assert.equal(journey.observed.rows_before, journey.observed.rows_after);
    assert.equal(journey.observed.project_blocks_before, journey.observed.project_blocks_after);
    assert.equal(journey.observed.dialog_dismissed, true);
    assert.equal(journey.observed.returned_by_history, true);
    assert.equal(journey.observed.scroll_restored, true);
    assert.equal(journey.observed.scroll_preserved_through_inspection, true);
    assert.equal(journey.observed.left_for_path, "/agencies/design-and-construction/");
    assert.equal(journey.observed.dialog_carries_the_project, true);
    assert.equal(journey.observed.dialog_carries_the_boundary, true);
    assert.equal(journey.observed.dialog_carries_observation_dates, true);
    assert.ok(journey.observed.dialog_destinations.includes("/agencies/design-and-construction/"));
  }
});

test("the captured keyboard pass drives the whole affordance without a pointer", () => {
  const keyboard = CAPTURE.captures.find((capture) => capture.surface === "keyboard");
  assert.ok(keyboard);
  assert.equal(keyboard.observed.destinations_reachable.reachable, keyboard.observed.destinations_reachable.visible);
  assert.equal(keyboard.observed.opened_with_keyboard, true);
  assert.equal(keyboard.observed.dialog_carries_the_project, true);
  assert.equal(keyboard.observed.dialog_carries_the_boundary, true);
  assert.equal(keyboard.observed.tab_stays_inside, true);
  assert.equal(keyboard.observed.dismissed_with_escape, true);
  assert.equal(keyboard.observed.focus_returned_to_control, true);
  assert.ok(keyboard.observed.smallest_target_px >= CAPTURE.min_target_px, "WCAG 2.5.8 target size");
});

test("the captured failure and the captured absence both add nothing", () => {
  for (const named of ["failed-load", "materialization-absent"]) {
    const capture = CAPTURE.captures.find((row) => row.case.includes(named));
    assert.ok(capture, `no capture for ${named}`);
    assert.equal(capture.observed.project_blocks, 0);
    assert.equal(capture.observed.observation_lines, 0);
    assert.equal(capture.observed.states_boundary, false);
    assert.equal(capture.observed.unresolved_key_rendered, false);
  }
  const absent = CAPTURE.captures.find((row) => row.case.includes("materialization-absent"));
  assert.ok(absent.observed.rendered_rows > 0, "the requests themselves stopped rendering");
});

test("the captured translations keep the publisher's own wording in its own language", () => {
  for (const lang of ["en", ...SHIPPING_LANGS]) {
    const capture = CAPTURE.captures.find((row) => row.case === `board-request-project-language-${lang}`);
    assert.ok(capture, `no language capture for ${lang}`);
    assert.equal(capture.observed.states_boundary, true, `${lang} boundary`);
    assert.equal(capture.observed.published_wording_preserved, true, `${lang} publisher passage`);
    assert.equal(capture.observed.published_project_name_preserved, true, `${lang} project name`);
    // English is the document's own language, so the section carries no
    // override; every other language marks its direction, and the two
    // right-to-left ones mirror.
    assert.equal(capture.observed.language, lang === "en" ? null : lang);
    assert.equal(capture.observed.direction, lang === "en" ? null : (lang === "ar" || lang === "ur" ? "rtl" : "ltr"));
  }
});

test("the captured scope difference is stated in the answer's own words", () => {
  const captures = CAPTURE.captures.filter((row) => row.case.includes("scope-difference"));
  assert.ok(captures.length >= 2);
  for (const capture of captures) {
    assert.equal(capture.observed.states_scope_difference, true);
  }
  const served = captures.find((row) => row.case.endsWith("desktop"));
  assert.equal(served.observed.states_named_by_the_board, true);
  assert.equal(served.observed.states_published_spelling, true);
  assert.equal(served.observed.states_project_phase, true);
});
