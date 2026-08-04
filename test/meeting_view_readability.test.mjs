import { SITE_SOURCE } from "./helpers/site_source.mjs";
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
import { buildPhaseViewForMatter } from "../site/meeting_phase_spine.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = SITE_SOURCE;
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
  meetingMatterPhaseHTML,
  matterDetailUrl,
  nonCouncilWhereHTML,
  nonCouncilHearingOutcomesHTML,
  officialHref,
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
  extractFn("officialIdFromPerson") +
  extractFn("officialHref") +
  extractFn("collectRollCallPeople") +
  extractFn("meetingRollCallChipHTML") +
  extractFn("meetingRollCallTableHTML") +
  extractFn("meetingVotesHTML") +
  extractFn("isCityCouncilNotice") +
  extractFn("meetingPhaseLabel") +
  extractFn("meetingPhaseGapHTML") +
  extractFn("meetingPhasePanelHTML") +
  extractFn("meetingPhaseStepperHTML") +
  extractFn("meetingPhaseLeadHTML") +
  extractFn("meetingMatterPhaseHTML") +
  extractFn("meetingOutcomesHTML") +
  `return { meetingOutcomeBucket, collapseMeetingAgenda, meetingOutcomesHTML, meetingMatterPhaseHTML, matterDetailUrl, nonCouncilWhereHTML, nonCouncilHearingOutcomesHTML, meetingRollCallChipHTML, meetingVotesHTML, officialHref };`,
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

test("non-Council unmatched outcomes stay absent", () => {
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
  assert.equal(html, "");
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
  assert.match(html, /Notice published|Hearing/i);
  assert.doesNotMatch(html, /data-gap-class|stage-name">(?:Outcome|Minutes)</i);
});

test("phase tools render lead → stepper → panels on fixture spines", () => {
  const model = buildMeetingOutcomes(
    fixture.notices,
    fixture.events,
    fixture.event_items,
    fixture.votes,
    fixture.attachments,
  );
  const phaseTools = { buildPhaseViewForMatter };
  const html = meetingOutcomesHTML(model.records[0], null, phaseTools);
  assert.match(html, /meeting-phase-stepper/);
  assert.match(html, /meeting-spine-lead/);
  assert.match(html, /data-meeting-matter-phase/);
  assert.match(html, /data-meeting-phase-panel="decision"/);
  assert.match(html, /data-meeting-phase-panel="record"/);
  // Scan list still one row per matter (attribute boundary so phase wrappers do not count).
  assert.equal((html.match(/data-meeting-matter(?:=|[\s>])/g) || []).length, 1);
  // Not a flat 4-stage chain dump of labels in order.
  assert.doesNotMatch(html, /class="chain meeting-spine"/);
  assert.match(html, /How this timeline works|meeting_phase_how/);
});

test("meetingMatterPhaseHTML is empty for empty views", () => {
  assert.equal(meetingMatterPhaseHTML(null), "");
  assert.equal(meetingMatterPhaseHTML({ empty: true }), "");
});

test("roll-call chip surfaces on matter card when by_person is retained", () => {
  const html = meetingOutcomesHTML({
    request_id: "20260706036",
    join: { matched: true },
    council_event: {
      event_id: "22526",
      body_name: "Subcommittee on Landmarks",
      event_date: "2026-07-14",
    },
    agenda_items: [
      {
        title: "Demo matter",
        matters: [
          {
            matter_id: "79193",
            matter_file: "LU 0112-2026",
            title: "East Harlem Article XI",
            outcome: "Approved by Subcommittee",
            votes: [
              {
                result: "Passed",
                vote_identity: "roll_call",
                counts: { aye: 6, nay: 0, abstain: 1 },
                by_person: [
                  {
                    person_id: "7801",
                    person_name: "Christopher Marte",
                    vote_value: "Affirmative",
                    vote_bucket: "aye",
                    official: {
                      id: "official:7801",
                      entity_type: "official",
                      display_name: "Christopher Marte",
                    },
                  },
                  {
                    person_id: "7825",
                    person_name: "Alexa Avilés",
                    vote_value: "Affirmative",
                    vote_bucket: "aye",
                    official: {
                      id: "official:7825",
                      entity_type: "official",
                      display_name: "Alexa Avilés",
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
  // Chip is on the matter card, not only inside collapsed detail
  assert.match(html, /meeting-roll-call-chip/);
  assert.match(html, /data-vote-identity="roll_call"/);
  assert.match(html, /data-official-count="2"/);
  // Names deep-link to event-scoped official skim
  assert.match(html, /#official\/7801/);
  assert.match(html, /notice=20260706036/);
  assert.match(html, /event=22526/);
  assert.match(html, /Christopher Marte/);
  // Full roll call in decision panel is an accessible table with person links
  assert.match(html, /meeting-roll-call-table/);
  assert.match(html, /<th scope="col">/);
  assert.match(html, /scope="row"/);
  assert.match(html, /meeting-official-link/);
});

test("tally_only votes do not invent a roll-call chip", () => {
  const html = meetingOutcomesHTML({
    request_id: "x",
    join: { matched: true },
    council_event: { event_id: "1", body_name: "City Council" },
    agenda_items: [
      {
        title: "Voice vote",
        matters: [
          {
            matter_id: "9",
            matter_file: "Res 1",
            title: "Voice",
            outcome: "Approved",
            votes: [
              {
                result: "Passed",
                vote_identity: "tally_only",
                counts: { aye: 5, nay: 0 },
                by_person: [],
              },
            ],
          },
        ],
      },
    ],
  });
  assert.doesNotMatch(html, /meeting-roll-call-chip/);
  assert.doesNotMatch(html, /data-vote-identity="roll_call"/);
});

test("officialHref builds event-scoped deep link", () => {
  assert.equal(
    officialHref("7801", { eventId: "22526", noticeId: "20260706036" }),
    "#official/7801?event=22526&notice=20260706036",
  );
  assert.equal(officialHref("", { eventId: "1" }), "");
});
