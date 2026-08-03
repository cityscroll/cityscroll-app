import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");

test("staffing landing follows act now, coming up, then history", () => {
  const guide = html.indexOf('<div class="career-guide" id="career-guide">');
  const browser = html.indexOf('id="career-browser-heading"');
  const ledger = html.indexOf('<details class="staffing-ledger" id="staffing-ledger">');
  const appointments = html.indexOf('id="staffing-feed-heading"');

  assert.ok(guide >= 0, "the exam guide should be visible on the default Staffing route");
  assert.ok(browser > guide, "the action browser should lead the visible exam guide");
  assert.ok(ledger > browser, "the appointments ledger should follow the exam browser");
  assert.ok(appointments > ledger, "the personnel feed should live inside the collapsed ledger");
  assert.doesNotMatch(
    html.slice(ledger, appointments),
    /<details[^>]*\sopen(?:\s|>)/,
    "the appointments ledger should be collapsed by default",
  );
  assert.doesNotMatch(html, /id="staffing-upcoming-list"/, "the duplicate exam teaser is removed");
});

test("action cards expose resident next steps before optional detail", () => {
  const start = html.indexOf("function careerCardHTML(exam)");
  const end = html.indexOf("function careerFilters()", start);
  const card = html.slice(start, end);

  assert.match(card, /career-action-facts/);
  assert.match(card, /career_application_fee/);
  assert.match(card, /career_no_account_label/);
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
