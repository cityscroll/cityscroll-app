// The Now listing adapter: one card, one accurately named next step.
//
// Reproduces the reported defect against the real English dictionary and the
// real compiled action rail, then pins the corrected contract:
//
//   A1 no card promises steps "below" that are not below it, and the control
//      names the page the link actually opens
//   A2 the kind badge, the date label and the control are three distinct
//      statements; none of them is a second printing of another
//   A3 internal navigation and external submission are visibly different
//   A4 a valid Comment or Apply action is preserved, and the label reviewed by
//      whoever owns the action is not rewritten here
//
//   node --test test/now_view.test.mjs

import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

import { buildNowSurface } from "../site/now_surface.mjs";
import { NOW_ACTION_SCENT_TODAY, nowActionScentSources as sources } from "./fixtures/now_action_scent_fixtures.mjs";

const require = createRequire(import.meta.url);
const CrolActions = require("../site/action_registry.js");

const TODAY = NOW_ACTION_SCENT_TODAY;

// The real shipping dictionary, so an assertion about copy is an assertion
// about what a reader is actually shown rather than about a key name.
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => "en", setItem: () => {} };
globalThis.location = { search: "", href: "https://cityscroll.org/" };
require("../site/i18n.js");
const STRINGS = globalThis.STRINGS.en;

const box = { innerHTML: "" };
globalThis.$ = () => box;
globalThis.announce = () => {};
globalThis.fdt = (value) => String(value);
globalThis.t = (key, values = {}) => {
  const template = STRINGS[key];
  if (template == null) return key;
  return Object.entries(values).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, value), template);
};

const { renderNowSurface } = await import("../site/now_view.mjs");

function renderCards() {
  box.innerHTML = "";
  renderNowSurface(buildNowSurface(sources(), { today: TODAY, compileActionRail: CrolActions.compileActionRail }));
  const cards = new Map();
  for (const [markup] of box.innerHTML.matchAll(/<article class="now-card"[\s\S]*?<\/article>/g)) {
    cards.set(markup.match(/data-now-item="([^"]*)"/)[1], markup);
  }
  return cards;
}

function badgeOf(card) {
  return card.match(/<span class="tag (?:urgency|open)">([^<]*)</)[1];
}

function dateLabelOf(card) {
  return card.match(/<p class="now-card-when"[^>]*><b>[^<]*<\/b>(?:<span>([^<]*)<\/span>)?/)?.[1] || "";
}

function controlsOf(card) {
  const actions = card.match(/<div class="actions">([\s\S]*?)<\/div>/)[1];
  return [...actions.matchAll(/<a class="(act[^"]*)" href="([^"]*)"([^>]*)>([\s\S]*?)<\/a>/g)].map((match) => ({
    className: match[1],
    href: match[2],
    attributes: match[3],
    markup: match[4],
    // What a sighted reader sees: the arrow is decorative and the new-tab
    // disclosure is for assistive technology, so neither is part of the name
    // the control is judged by.
    label: match[4]
      .replace(/<span\b[^>]*class="sr-only"[^>]*>[\s\S]*?<\/span>/g, "")
      .replace(/<span\b[^>]*aria-hidden="true"[^>]*>[\s\S]*?<\/span>/g, "")
      .replace(/<[^>]*>/g, "")
      .trim(),
    accessibleName: match[4]
      .replace(/<span\b[^>]*aria-hidden="true"[^>]*>[\s\S]*?<\/span>/g, "")
      .replace(/<[^>]*>/g, "")
      .replace(/\s+/g, " ")
      .trim(),
  }));
}

/* ---------- A1: the reported defect ---------- */

test("A1: a procurement card no longer promises response steps below a card that has none", () => {
  const card = renderCards().get("money:bid-open");
  assert.ok(card, "expected the open solicitation to reach the act-by lane");

  // The defect as reported: one sentence printed twice, positioned against a
  // document the card is not.
  assert.doesNotMatch(card, /Follow the response steps below/);
  assert.doesNotMatch(card, /\bbelow\b/i, "nothing on a listing card is below it");

  const [control] = controlsOf(card);
  assert.equal(control.label, "View response instructions");
  assert.equal(control.href, "/notices/bid-open", "the control names the page it actually opens");
});

test("A1: the full notice keeps the instruction that is true where the steps really are", () => {
  // The compiled action still carries the notice document's own reviewed
  // wording; only the listing re-points it. Rewriting the source instruction
  // globally would break the page where it is correct.
  assert.equal(STRINGS.next_action_response_guide, "Follow the response steps below");
  const action = CrolActions.compileActionRail({
    kind: "solicitation",
    request_id: "bid-open",
    title: "Bridge inspection services",
    agency_name: "Transportation",
    type_of_notice_description: "Solicitation",
    lifecycle_stage: "open",
    due_date: "2026-08-04T14:00:00",
  }, { today: TODAY }).find((entry) => entry.type === "bid_checklist");
  assert.equal(action.label_key, "next_action_response_guide");
  // The re-point is safe precisely because this label is only ever compiled
  // with a local destination: the notice document it points at is the page
  // that carries the steps. It can never re-label an external handoff.
  assert.equal(action.delivery, "local");
});

/* ---------- A2: three statements, not one repeated ---------- */

test("A2: kind badge, date label and control say three different things on every act-by card", () => {
  const cards = renderCards();
  const actBy = ["money:bid-open", "staffing:7001", "rules:rule-comment:comment",
    "property:property-actions:objection_deadline:2026-08-06"];
  const comparable = (value) => value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

  for (const id of actBy) {
    const card = cards.get(id);
    assert.ok(card, id);
    const badge = comparable(badgeOf(card));
    const dateLabel = comparable(dateLabelOf(card));
    const labels = controlsOf(card).map((control) => comparable(control.label));
    assert.ok(badge, `${id} states the kind of window`);
    assert.ok(labels.length, `${id} offers a next step`);
    for (const label of labels) {
      assert.notEqual(label, badge, `${id} prints its control's name a second time as a badge`);
      if (dateLabel) assert.notEqual(label, dateLabel, `${id} prints its control's name a second time as a date label`);
    }
    if (dateLabel) assert.notEqual(badge, dateLabel, `${id} states the same thing as badge and as date label`);
  }
});

test("A2: the badge names the window and the card keeps its civic facts primary", () => {
  const cards = renderCards();
  assert.equal(badgeOf(cards.get("money:bid-open")), "Response window");
  assert.equal(badgeOf(cards.get("staffing:7001")), "Application window");
  assert.equal(badgeOf(cards.get("rules:rule-comment:comment")), "Comment window");
  assert.equal(badgeOf(cards.get("property:property-actions:objection_deadline:2026-08-06")), "Objection window");

  // A badge is never a raw implementation slug, whatever kind arrives.
  for (const card of cards.values()) {
    assert.doesNotMatch(badgeOf(card), /_/, "a kind slug is not resident copy");
  }

  // Title, exact date, agency and the publishing source stay on the card.
  const card = cards.get("money:bid-open");
  assert.match(card, /Bridge inspection services/);
  assert.match(card, /2026-08-04T14:00:00/);
  assert.match(card, /Transportation/);
  assert.match(card, /Responses due/);
  assert.match(card, /now-source-badge/);
});

/* ---------- A3: navigation and handoff are visibly different ---------- */

test("A3: an external submission is presented as a handoff and internal navigation is not", () => {
  const cards = renderCards();
  const [submit, details] = controlsOf(cards.get("rules:rule-comment:comment"));

  assert.equal(submit.href, "https://rules.cityofnewyork.us/rule/energy-code/");
  assert.match(submit.attributes, /target="_blank"/);
  assert.match(submit.attributes, /rel="noopener noreferrer"/);
  assert.match(submit.markup, /aria-hidden="true">↗/, "a handoff carries a visible signifier");
  assert.match(submit.markup, /class="sr-only"/, "and announces the new tab it opens");
  assert.equal(submit.label, "Comment", "the visible name is the action, not the signifier");
  assert.equal(submit.accessibleName, "Comment (opens in new tab)",
    "the accessible name carries the disclosure the glyph makes visually");

  // Leaving the site is never the only way on from a card.
  assert.equal(details.href, "/notices/rule-comment");
  assert.equal(details.attributes, "");
  assert.doesNotMatch(details.markup, /↗|sr-only/);

  // An internal-only card carries no handoff dressing at all.
  const [internal] = controlsOf(cards.get("money:bid-open"));
  assert.equal(internal.attributes, "");
  assert.doesNotMatch(internal.markup, /↗|target=|sr-only/);
});

test("A3: an absolute destination on a host this site owns stays internal navigation", () => {
  // The adapter used to test the destination for "https://" and hand every
  // match to a new tab, which sent a reader off-site to reach this site.
  const owned = { ...sources() };
  owned.meetings.hearings[0].source_url = "https://cityscroll.org/notices/hearing-next";
  box.innerHTML = "";
  renderNowSurface(buildNowSurface(owned, { today: TODAY, compileActionRail: CrolActions.compileActionRail }));
  const card = box.innerHTML.match(/<article class="now-card" data-now-item="meetings:hearing-next"[\s\S]*?<\/article>/)[0];
  for (const control of controlsOf(card)) {
    assert.doesNotMatch(control.href, /^https:\/\/cityscroll\.org/);
    assert.equal(control.attributes, "");
  }
});

/* ---------- A4: positive controls ---------- */

test("A4: a valid Comment action is preserved with its own reviewed wording", () => {
  const [comment] = controlsOf(renderCards().get("rules:rule-comment:comment"));
  assert.equal(comment.label, STRINGS.rule_comment_btn);
  assert.equal(comment.label, "Comment");
});

test("A4: an application card keeps the label its own rail compiled, rather than one invented per kind", () => {
  // The rail compiled a landing-page handoff and named it accordingly. The
  // listing used to overwrite that with "Apply in OASys", promising an
  // application form at a page that lists exams.
  const [apply, details] = controlsOf(renderCards().get("staffing:7001"));
  assert.equal(apply.href, "https://www.nyc.gov/examsforjobs");
  assert.equal(apply.label, STRINGS.career_apply_oasys_browse);
  assert.equal(apply.label, "Browse OASys exams");
  assert.notEqual(apply.label, STRINGS.career_apply_oasys);
  assert.equal(details.href, "/exams/7001/");
});

test("A4: an objection card keeps its action and names the destination it opens", () => {
  const [control] = controlsOf(renderCards().get("property:property-actions:objection_deadline:2026-08-06"));
  assert.equal(control.label, STRINGS.property_action_open_notice);
  assert.equal(control.href, "/notices/property-actions");
});

test("A4: an event with no compiled action still offers the ordinary way on", () => {
  const [control] = controlsOf(renderCards().get("meetings:hearing-next"));
  assert.equal(control.label, STRINGS.now_open_details);
  assert.equal(control.href, "/notices/hearing-next");
});

/* ---------- failure recovery ---------- */

test("failure: an unavailable source leaves every other card and its named action intact", () => {
  const degraded = sources();
  degraded.rules = { status: "unavailable", reason: "timeout", rules: [] };
  box.innerHTML = "";
  renderNowSurface(buildNowSurface(degraded, { today: TODAY, compileActionRail: CrolActions.compileActionRail }));
  assert.match(box.innerHTML, /View response instructions/);
  assert.match(box.innerHTML, /Browse OASys exams/);
  assert.doesNotMatch(box.innerHTML, /Loading/);
});
