// Characterization: matter-centric Council meeting outcomes (scan list).
// Replaces the N× four-stage lifecycle chain dump with summary chips, short
// titles, outcome badges, and progressive disclosure.
//
//   node --test test/meeting_view_readability.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildMeetingOutcomes } from "../worker/src/lib/meeting_outcomes.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(ROOT, "site", "index.html"), "utf8");
const i18nSrc = readFileSync(join(ROOT, "site", "i18n.js"), "utf8");
const fixture = JSON.parse(
  readFileSync(join(ROOT, "test/contract/fixtures/meeting_outcomes.json"), "utf8"),
);

function extractFn(name) {
  let start = src.indexOf("async function " + name + "(");
  if (start === -1) start = src.indexOf("function " + name + "(");
  assert.notEqual(start, -1, `function ${name} not found`);
  let depth = 0, seen = false;
  for (let j = src.indexOf("{", start); j < src.length; j++) {
    if (src[j] === "{") { depth++; seen = true; }
    else if (src[j] === "}" && --depth === 0 && seen) return src.slice(start, j + 1);
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

const windowStub = { LANG: "en", LANG_META: { en: { intlDate: "en-US" } } };
const { t } = new Function("window", i18nSrc + "\nreturn { t: window.t };")(windowStub);
function fdate(s) { return s ? String(s).slice(0, 10) : ""; }
function cleanText(s) { return String(s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(); }
function escUiHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const {
  meetingOutcomeBucket,
  collapseMeetingAgenda,
  meetingOutcomesHTML,
  matterDetailUrl,
  nonCouncilWhereHTML,
  nonCouncilHearingOutcomesHTML,
} = new Function(
  "t", "fdate", "cleanText", "escUiHtml",
  `
  const extSR = () => '<span class="sr-only"> (opens in new tab)</span>';
  const EXT_ATTRS = 'target="_blank" rel="noopener noreferrer"';
  ` +
  extractFn("meetingOutcomeBucket") +
  extractFn("meetingMatterShortTitle") +
  extractFn("matterDetailUrl") +
  extractFn("nonCouncilBodyLinks") +
  extractFn("nonCouncilWhereHTML") +
  extractFn("nonCouncilStageLabel") +
  extractFn("nonCouncilHearingOutcomesHTML") +
  extractFn("collapseMeetingAgenda") +
  extractFn("meetingVotesHTML") +
  extractFn("isCityCouncilNotice") +
  extractFn("meetingOutcomesHTML") +
  `return { meetingOutcomeBucket, collapseMeetingAgenda, meetingOutcomesHTML, matterDetailUrl, nonCouncilWhereHTML, nonCouncilHearingOutcomesHTML };`,
)(t, fdate, cleanText, escUiHtml);

test("outcome bucket maps approve / hold / refer", () => {
  assert.equal(meetingOutcomeBucket("Approved by Subcommittee"), "approved");
  assert.equal(meetingOutcomeBucket("P-C Item Approved by Subcommittee with Companion Resolution"), "approved");
  assert.equal(meetingOutcomeBucket("Hearing Held by Committee"), "held");
  assert.equal(meetingOutcomeBucket("Hearing on P-C Item by Comm"), "held");
  assert.equal(meetingOutcomeBucket("Referred to Committee"), "referred");
});

test("collapse groups two action rows into one matter", () => {
  const collapsed = collapseMeetingAgenda([
    {
      title: "Application (Public School 15 Annex) long legal text",
      matters: [{ matter_id: "1", matter_file: "LU 0091-2026", title: "Landmarks, Public School 15 Annex, Brooklyn (N 1).", outcome: "Hearing Held by Committee", votes: [] }],
    },
    {
      title: "Application (Public School 15 Annex) long legal text",
      matters: [{ matter_id: "1", matter_file: "LU 0091-2026", title: "Landmarks, Public School 15 Annex, Brooklyn (N 1).", outcome: "Approved by Subcommittee", passed: "Pass", votes: [{ result: "Pass", counts: { aye: 0, nay: 0, abstain: 7 } }] }],
    },
    { title: "Roll Call", matters: [] },
  ]);
  assert.equal(collapsed.matters.length, 1);
  assert.equal(collapsed.actionRows, 2);
  assert.equal(collapsed.procedural, 1);
  assert.equal(collapsed.matters[0].actions.length, 2);
  assert.equal(collapsed.matters[0].finalOutcome, "Approved by Subcommittee");
});

test("fixture HTML is a scannable agenda, not a 4-stage chain dump", () => {
  const model = buildMeetingOutcomes(
    fixture.notices,
    fixture.events,
    fixture.event_items,
    fixture.votes,
    fixture.attachments,
  );
  const html = meetingOutcomesHTML(model.records[0]);
  assert.match(html, /meeting-summary/);
  assert.match(html, /meeting-badge--approved/);
  assert.match(html, /Transit Improvement Funding/);
  assert.match(html, /aye 6/);
  assert.match(html, /nay 3/);
  assert.match(html, /Staff report/);
  assert.match(html, /Meeting documents|Agenda/);
  // Zero-zero tallies must not appear when counts are empty of aye/nay signal
  // (fixture has real 6–3, so this is a structural guard via class names).
  assert.match(html, /meeting-more/);
  assert.doesNotMatch(html, /class="chain meeting-spine"/);
});

test("multi-matter multi-action meeting collapses and suppresses empty tallies", () => {
  const html = meetingOutcomesHTML({
    join: { matched: true },
    council_event: {
      body_name: "Subcommittee on Landmarks",
      event_date: "2026-07-14",
      event_url: "https://nyc.legistar.com/MeetingDetail.aspx?LEGID=22526",
      documents: [
        { name: "Agenda", url: "https://example.test/a.pdf" },
        { name: "Minutes", url: "https://example.test/m.pdf" },
      ],
    },
    agenda_items: [
      {
        title: "Application number N 1 (Public School 15 Annex) submitted by LPC.",
        matters: [{
          matter_id: "79062",
          matter_file: "LU 0091-2026",
          title: "Landmarks, Public School 15 Annex, Brooklyn (N 260340 HIK).",
          outcome: "Hearing Held by Committee",
          votes: [{ result: "Hearing Held by Committee", counts: { aye: 0, nay: 0, abstain: 7 } }],
        }],
      },
      {
        title: "Application number N 1 (Public School 15 Annex) submitted by LPC.",
        matters: [{
          matter_id: "79062",
          matter_file: "LU 0091-2026",
          title: "Landmarks, Public School 15 Annex, Brooklyn (N 260340 HIK).",
          outcome: "Approved by Subcommittee",
          passed: "Pass",
          votes: [{ result: "Pass", counts: { aye: 0, nay: 0, abstain: 7 } }],
        }],
      },
      {
        title: "Application number N 2 (Church of Saint Mary) submitted by LPC.",
        matters: [{
          matter_id: "79063",
          matter_file: "LU 0092-2026",
          title: "Landmarks, Church of Saint Mary, Manhattan (N 260338 HIM).",
          outcome: "Hearing Held by Committee",
          votes: [],
        }],
      },
      {
        title: "Application number N 2 (Church of Saint Mary) submitted by LPC.",
        matters: [{
          matter_id: "79063",
          matter_file: "LU 0092-2026",
          title: "Landmarks, Church of Saint Mary, Manhattan (N 260338 HIM).",
          outcome: "Approved by Subcommittee",
          passed: "Pass",
          votes: [{ result: "Pass", counts: { aye: 0, nay: 0, abstain: 7 } }],
        }],
      },
      { title: "Roll Call", matters: [] },
    ],
  });
  assert.equal((html.match(/data-meeting-matter/g) || []).length, 2);
  assert.match(html, /Public School 15 Annex/);
  assert.match(html, /Church of Saint Mary/);
  assert.match(html, /2<\/strong> approved|2.*approved/i);
  // Event PDFs once each, not per action row
  assert.equal((html.match(/example\.test\/a\.pdf/g) || []).length, 1);
  assert.equal((html.match(/example\.test\/m\.pdf/g) || []).length, 1);
  // Empty aye/nay tallies suppressed
  assert.doesNotMatch(html, /aye 0 · nay 0/);
  // Numeric Legistar MatterIds deep-link via Gateway M=L (not plain text)
  assert.match(html, /Gateway\.aspx\?M=L&amp;ID=79062|Gateway\.aspx\?M=L&ID=79062/);
  assert.match(html, /meeting-matter-link/);
  assert.match(html, /LU 0091-2026/);
});

test("matterDetailUrl only accepts numeric Legistar MatterIds", () => {
  assert.match(matterDetailUrl("79062"), /Gateway\.aspx\?M=L&ID=79062/);
  assert.equal(matterDetailUrl("mat-001"), null);
  assert.equal(matterDetailUrl(""), null);
  assert.equal(matterDetailUrl(null), null);
});

test("non-Council unmatched outcomes render real HTTPS landings", () => {
  const html = meetingOutcomesHTML(
    { join: { matched: false } },
    {
      request_id: "20260701001",
      start_date: "2026-06-20",
      event_date: "2026-07-01",
      agency_name: "Manhattan Borough President",
      section_name: "Public Hearings and Meetings",
      short_title: "Manhattan Borough President public hearing",
    },
  );
  assert.match(html, /manhattanbp\.nyc\.gov/);
  assert.match(html, /community-boards/);
  assert.match(html, /href="https:\/\//);
  // No longer a bare text-only "where" with zero outbound
  assert.doesNotMatch(html, /where: t\("meeting_outcomes_non_council_where"\)/);
  // Process spine: notice → hearing → outcome → minutes with chain presentation
  assert.match(html, /data-non-council-spine="1"/);
  assert.match(html, /class="chain"/);
  assert.match(html, /aria-hidden="true"/); // connectors are decorative
  assert.match(html, /data-gap-class="not_published"/);
  assert.equal((html.match(/data-gap-class="not_published"/g) || []).length, 2);
});

test("nonCouncilHearingOutcomesHTML fills notice+hearing dates when present", () => {
  const html = nonCouncilHearingOutcomesHTML({
    request_id: "20260701001",
    start_date: "2026-06-20",
    event_date: "2026-07-01",
    agency_name: "Manhattan Borough President",
    short_title: "ULURP hearing",
  });
  assert.match(html, /2026-06-20|06\/20\/2026|Jun/); // fdate stub is ISO slice
  assert.match(html, /2026-07-01/);
  assert.match(html, /Notice published|Hearing|Outcome|Minutes/i);
});
