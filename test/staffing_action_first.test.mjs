import { SITE_SOURCE } from "./helpers/site_source.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = SITE_SOURCE;

test("Exams owns the action guide while Staffing retains its appointment ledger", () => {
  const exams = html.slice(html.indexOf('id="tab-exams"'), html.indexOf('id="tab-alerts"'));
  const staffing = html.slice(html.indexOf('id="tab-people"'), html.indexOf('id="tab-land"'));
  const guide = exams.indexOf('<div class="career-guide" id="career-guide">');
  const browser = exams.indexOf('id="career-browser-heading"');
  const ledger = staffing.indexOf('<details class="staffing-ledger" id="staffing-ledger">');
  const appointments = staffing.indexOf('id="staffing-feed-heading"');

  assert.ok(guide >= 0, "the exam guide should live on the Exams route");
  assert.ok(browser > guide, "the action browser should lead the Exams guide");
  assert.ok(ledger >= 0, "the Staffing route should retain the appointments ledger");
  assert.ok(appointments > ledger, "the personnel feed should live inside the collapsed ledger");
  assert.doesNotMatch(staffing, /id="career-guide"/, "Staffing must not own the Exams guide");
  assert.doesNotMatch(
    staffing.slice(ledger, appointments),
    /<details[^>]*\sopen(?:\s|>)/,
    "the appointments ledger should be collapsed by default",
  );
  assert.doesNotMatch(html, /id="staffing-upcoming-list"/, "the duplicate exam teaser is removed");
});

test("the secondary personnel archive has a positive, durable label", () => {
  const ledgerStart = html.indexOf('<details class="staffing-ledger" id="staffing-ledger">');
  const ledgerEnd = html.indexOf("</details>", ledgerStart);
  const ledger = html.slice(ledgerStart, ledgerEnd);

  assert.match(ledger, /<summary[^>]*>Appointment record<\/summary>/);
  assert.doesNotMatch(ledger, /What happened|no action|not actionable/i);
});

test("action cards expose resident next steps before optional detail", () => {
  const start = html.indexOf("function careerCardHTML(exam)");
  const end = html.indexOf("function careerFilters()", start);
  const card = html.slice(start, end);

  assert.match(card, /career-action-facts/);
  assert.match(card, /career_application_fee/);
  // Differentiator-first: fee + salary lead; OASys apply remains the primary action.
  assert.match(card, /career_starting_salary/);
  assert.match(card, /careerDiffLeadsHTML/);
  assert.match(card, /examListForecastHTML/);
  assert.match(card, /const expanded=selected/);
  assert.ok(card.indexOf("career-action-facts") < card.indexOf("const expanded=selected"));
});

test("exam results are grouped by action intent instead of publisher order", () => {
  assert.match(html, /function careerActionGroup\(exam, today\)/);
  assert.match(html, /function careerResultsHTML\(exams\)/);
  assert.match(html, /career_group_open/);
  assert.match(html, /career_group_upcoming/);
  assert.match(html, /career_group_continuous/);
  assert.match(html, /career_group_other/);
});
