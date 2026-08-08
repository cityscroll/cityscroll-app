import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  compileActionRail,
  solicitationHandoff,
  awardHandoff,
  hearingHandoff,
  ruleHandoff,
  franchiseHandoff,
  packageUrlFromAttachments,
  validateAction,
} from "../worker/src/lib/action_registry.mjs";
import { hearingCalendarICS } from "../site/hearing_attend_pack.mjs";

const require = createRequire(import.meta.url);
const { normalizeHearingRow } = require("../site/hearing_location.js");
const EXAMPLE_EMAIL = ["example", "example.com"].join("@");

const fixture = JSON.parse(readFileSync(new URL("./fixtures/wave4/action-fixtures.json", import.meta.url)));

test("open solicitations compile a searchable handoff, deadline, and watch rail", () => {
  const actions = compileActionRail(fixture.matter, {today: "2026-08-01"});
  assert.deepEqual(actions.map(action => action.type), ["official_application", "calendar", "watch"]);
  assert.equal(new URL(actions[0].destination).pathname, "/rfx.html");
  assert.equal(actions[0].guide.mode, "search_only");
  assert.equal(actions[0].deadline, fixture.matter.deadline);
});

test("NYCHA iSupplier field case never becomes a PASSPort bid", () => {
  const matter = {
    kind: "solicitation",
    agency_name: "Housing Authority",
    pin: "517992",
    title: "SMD_A&CM_RFQ #517992 - Elevator Rehabilitation at Gun Hill Houses",
    deadline: "2026-08-05T11:00:00.000",
    notice_text: "Vendors shall electronically upload all components of the bid into iSupplier. Instructions for registering for iSupplier can be found at nyc.gov/site/nycha/business/isupplier-vendor-registration.page. Approval typically takes 24 to 72 hours.",
    official_notice_url: "https://a856-cityrecord.nyc.gov/RequestDetail/20260617050",
    rfx_detail: {status: "unmatched", reason: "no_epin_pin_join"},
  };
  const handoff = solicitationHandoff(matter);
  assert.equal(handoff.system, "nycha_isupplier");
  assert.equal(handoff.identifier, "517992");
  assert.match(handoff.destination, /nycha\/business\/isupplier-vendor-registration/);
  // The current machine verdict suppresses the unavailable City Record handoff while
  // preserving the notice-extracted response fields and the working iSupplier guide.
  assert.equal(handoff.identifier_url, null);
  assert.equal(handoff.package_url, null);
  assert.equal(handoff.upstream_unavailable_note_key, "next_action_unavailable_handoff");

  const [action] = compileActionRail(matter, {today: "2026-08-01"});
  assert.equal(action.label_key, "open_nycha_isupplier");
  assert.equal(action.guide.mode, "notice_named");
  assert.doesNotMatch(action.destination, /passport/i);
});

test("a recovered City Record pattern restores its notice handoff without a code edit", () => {
  const officialNoticeUrl = "https://a856-cityrecord.nyc.gov/RequestDetail/20260617050";
  const handoff = solicitationHandoff({
    kind: "solicitation",
    agency_name: "Housing Authority",
    pin: "517992",
    title: "Elevator Rehabilitation",
    notice_text: "Upload the bid in iSupplier. Contact the procurement office for response instructions.",
    official_notice_url: officialNoticeUrl,
    action_link_health: {
      patterns: {
        "contracts-city-record-notice": {verdict: "OK", degraded: false},
      },
    },
  });

  assert.equal(handoff.identifier_url, officialNoticeUrl);
  assert.equal(handoff.package_url, officialNoticeUrl);
  assert.equal(handoff.upstream_unavailable_note_key, null);
});

test("matched Released PASSPort RFx with rfp_id deep-links to process_manage_extranet", () => {
  const matter = {
    kind: "solicitation",
    pin: "81026B0003",
    title: "Records Remediation Project",
    deadline: "2026-08-18T13:00:00.000",
    rfx_detail: {
      status: "matched",
      portal: "https://a0333-passportpublic.nyc.gov/rfx.html",
      detail: {
        epin: "81026B0003",
        procurement_name: "81026B0003-Records remediation project",
        rfx_status: "Released",
        rfp_id: "36426",
      },
    },
  };
  const [action] = compileActionRail(matter, {today: "2026-08-01"});
  assert.equal(action.label_key, "search_passport_rfx");
  assert.equal(
    action.destination,
    "https://passport.cityofnewyork.us/page.aspx/en/bpm/process_manage_extranet/36426",
  );
  assert.deepEqual(
    {system: action.guide.system, mode: action.guide.mode, identifier: action.guide.identifier, status: action.guide.status},
    {system: "passport", mode: "matched", identifier: "81026B0003", status: "Released"},
  );
  assert.equal(action.guide.rfp_id, "36426");
});

test("matched PASSPort RFx without rfp_id stays on public browse search recipe", () => {
  const matter = {
    kind: "solicitation",
    pin: "81026B0003",
    title: "Records Remediation Project",
    deadline: "2026-08-18T13:00:00.000",
    rfx_detail: {
      status: "matched",
      portal: "https://a0333-passportpublic.nyc.gov/rfx.html",
      detail: {
        epin: "81026B0003",
        procurement_name: "81026B0003-Records remediation project",
        rfx_status: "Released",
      },
    },
  };
  const [action] = compileActionRail(matter, {today: "2026-08-01"});
  assert.equal(action.destination, "https://a0333-passportpublic.nyc.gov/rfx.html");
  assert.equal(action.guide.mode, "matched");
});

test("unmatched citywide EPIN gets a search recipe instead of a fake deep link", () => {
  const [action] = compileActionRail({
    kind: "solicitation",
    pin: "85726B0060",
    title: "Tub Grinder - Parks",
    deadline: "2026-08-05T10:00:00.000",
    rfx_detail: {status: "unmatched", reason: "no_epin_pin_join"},
  }, {today: "2026-08-01"});
  assert.equal(action.label_key, "search_passport_rfx");
  assert.equal(action.guide.mode, "search_only");
  assert.equal(action.guide.identifier, "85726B0060");
  assert.equal(new URL(action.destination).pathname, "/rfx.html");
});

test("a notice-named agency portal is used only with matching system and approved host evidence", () => {
  const handoff = solicitationHandoff({
    kind: "solicitation",
    pin: "ABC-42",
    title: "Bridge inspection services",
    notice_text: "Submit your proposal in OpenGov at https://procurement.opengov.com/portal/example/projects/42 before the deadline.",
  });
  assert.equal(handoff.system, "notice_portal");
  assert.equal(handoff.system_name, "OpenGov");
  assert.equal(handoff.destination, "https://procurement.opengov.com/portal/example/projects/42");

  const unrelated = solicitationHandoff({
    kind: "solicitation",
    pin: "ABC-42",
    notice_text: "Learn more at https://example.com/procurement and submit as instructed in the notice.",
  });
  // Unrelated host without download/submit language near a named portal does not invent a handoff.
  assert.equal(unrelated.system, "notice_extracted");
  assert.equal(unrelated.destination, null);
});

test("an unknown submission system does not duplicate the page's City Record action", () => {
  const actions = compileActionRail({
    kind: "solicitation",
    pin: "8502026HP0099",
    title: "Rehabilitation of public restrooms",
    deadline: "2026-09-01",
    official_notice_url: "https://a856-cityrecord.nyc.gov/RequestDetail/20260701099",
  }, {today: "2026-08-01"});
  // Guide-first (bid_checklist) when no portal — never a second "read City Record" CTA
  assert.deepEqual(actions.map(action => action.type), ["bid_checklist", "calendar", "watch"]);
  assert.equal(actions[0].delivery, "local");
  assert.ok(actions[0].guide);
  assert.equal(actions[0].guide.system, "notice_extracted");
  assert.equal(actions.some(action => action.type === "document"), false);
  assert.doesNotMatch(actions[0].label_key, /response_instructions/);
});

test("EDC-style notice extracts package URL, contact, and due date into a concrete guide", () => {
  const matter = {
    kind: "solicitation",
    agency_name: "Economic Development Corporation",
    pin: "2926",
    title: "Retainer Audit Services RFP",
    deadline: "2026-08-03T16:00:00.000",
    email: "rfprequest@edc.nyc",
    contact_name: "Hugo Job",
    contact_phone: "(212) 618-5462",
    address_to_request: "1 Liberty Plaza, 12th Floor, New York, NY 10006",
    selection_method: "Request for Proposals",
    notice_text: "Detailed submission guidelines are outlined in the RFP. To download a copy of the solicitation documents, please visit https://edc.nyc/rfps. RESPONSES ARE DUE NO LATER THAN 4PM ON Monday, August 3, 2026. Please click the link in the Deadlines section of this project's web page (which can be found on https://edc.nyc/rfps) to electronically upload a proposal.",
    official_notice_url: "https://a856-cityrecord.nyc.gov/RequestDetail/20260625058",
  };
  const handoff = solicitationHandoff(matter);
  assert.equal(handoff.system, "notice_extracted");
  assert.equal(handoff.destination, "https://edc.nyc/rfps");
  assert.equal(handoff.email, "rfprequest@edc.nyc");
  assert.equal(handoff.contact_name, "Hugo Job");
  assert.equal(handoff.package_url, "https://edc.nyc/rfps");

  const [action] = compileActionRail(matter, {today: "2026-08-01"});
  assert.equal(action.delivery, "official_handoff");
  assert.equal(action.label_key, "open_rfp_package");
  assert.equal(action.destination, "https://edc.nyc/rfps");
  assert.equal(action.guide.system, "notice_extracted");
  assert.doesNotMatch(action.label || "", /Use the response instructions/i);
});

test("closed solicitations replace the bid handoff with an honest unavailable state", () => {
  const actions = compileActionRail({...fixture.matter, lifecycle_stage: "closed"}, {today: "2026-08-01"});
  assert.equal(actions[0].delivery, "unavailable");
  assert.equal(actions[0].label_key, "next_action_bid_closed");
  assert.equal(actions[0].destination, undefined);
  assert.deepEqual(actions.map(action => action.type), ["official_application", "document", "watch"]);
});

test("open rule comments and upcoming hearings use their joined deadlines and handoffs", () => {
  const rule = compileActionRail({
    kind: "rule", lifecycle_stage: "comment-open", deadline: "2026-08-12",
    comment_url: "https://rules.cityofnewyork.us/rule/example/",
  }, {today: "2026-08-01"});
  assert.deepEqual(rule.map(action => action.type), ["comment", "calendar", "watch"]);
  assert.equal(rule[0].destination_label, "rules.cityofnewyork.us");
  // Comment-open attaches a rules guide (deadline + how-to-comment), not a bare link.
  assert.equal(rule[0].guide?.system, "rules_extracted");
  assert.equal(rule[0].guide?.mode, "comment_open");
  assert.equal(rule[0].guide?.comment_deadline, "2026-08-12");
  assert.equal(rule[0].guide?.comment_url, "https://rules.cityofnewyork.us/rule/example/");

  const hearing = compileActionRail({
    kind: "hearing", deadline: "2026-08-10T14:30:00.000",
    participation_url: "https://www.nyc.gov/site/mocs/opportunities/franchises-concessions.page",
  }, {today: "2026-08-01"});
  assert.deepEqual(hearing.map(action => action.type), ["attend", "calendar", "watch"]);
  // Non-join agenda URL stays an honest participation link + guide, not "Join online".
  assert.equal(hearing[0].label_key, "participation_link");
  assert.equal(hearing[0].guide?.system, "hearing_extracted");
});

test("ruleHandoff surfaces comment-by deadline, portal, and hearing attend without inventing fields", () => {
  const EXAMPLE_RULE_EMAIL = ["rules-comments", "example.com"].join("@");
  const matter = {
    kind: "rule",
    lifecycle_stage: "comment-open",
    deadline: "2026-09-15",
    comment_by_date: "2026-09-15",
    comment_url: "https://rules.cityofnewyork.us/rule/dot-example/feed/",
    official_notice_url: "https://rules.cityofnewyork.us/rule/dot-example/",
    hearing_date: "2026-09-10",
    agency_name: "Department of Transportation",
    title: "Proposed outdoor dining rules",
    notice_text: [
      "NOTICE OF PUBLIC HEARING AND OPPORTUNITY TO COMMENT",
      "on proposed rules of the Department of Transportation.",
      `Written comments may be submitted electronically to ${EXAMPLE_RULE_EMAIL}.`,
      "A public hearing will be held on September 10, 2026 at 22 Reade Street, New York, NY 10007.",
      "Join online at https://zoom.us/j/987654321.",
    ].join(" "),
    venue: {mode: "hybrid", building: null, address: "22 Reade Street, New York, NY 10007"},
    street_address_1: "22 Reade Street",
    city: "New York",
    state: "NY",
    zip_code: "10007",
  };
  const handoff = ruleHandoff(matter, {today: "2026-08-02"});
  assert.equal(handoff.system, "rules_extracted");
  assert.equal(handoff.mode, "comment_open");
  assert.equal(handoff.comment_open, true);
  assert.equal(handoff.comment_deadline, "2026-09-15");
  assert.equal(handoff.comment_url, "https://rules.cityofnewyork.us/rule/dot-example/feed/");
  assert.equal(handoff.hearing_date, "2026-09-10");
  assert.equal(handoff.hearing_upcoming, true);
  assert.equal(handoff.participation_url, "https://zoom.us/j/987654321");
  assert.equal(handoff.join_kind, "join");
  assert.match(handoff.venue_address || "", /22 Reade/i);
  assert.equal(handoff.testimony_email, EXAMPLE_RULE_EMAIL);

  const actions = compileActionRail(matter, {today: "2026-08-02"});
  assert.equal(actions[0].type, "comment");
  assert.equal(actions[0].guide?.system, "rules_extracted");
  assert.equal(actions[0].guide?.hearing_date, "2026-09-10");
  assert.deepEqual(actions.map((a) => a.type), ["comment", "calendar", "watch"]);
});

test("hearing-stage rule without comment window still gets attend guide from published fields", () => {
  const actions = compileActionRail({
    kind: "rule",
    lifecycle_stage: "hearing",
    hearing_date: "2026-08-20",
    official_notice_url: "https://rules.cityofnewyork.us/rule/hearing-only/",
    venue: {mode: "in-person", address: "253 Broadway, New York, NY 10007"},
    notice_text: "Public hearing on August 20, 2026 at 253 Broadway.",
  }, {today: "2026-08-02"});
  assert.equal(actions[0].guide?.system, "rules_extracted");
  assert.equal(actions[0].guide?.mode, "hearing");
  assert.equal(actions[0].guide?.hearing_date, "2026-08-20");
  assert.match(actions[0].guide?.venue_address || "", /253 Broadway/i);
  // Calendar uses the upcoming hearing date.
  assert.ok(actions.some((a) => a.type === "calendar"));
  assert.equal(actions.find((a) => a.type === "calendar")?.deadline, "2026-08-20");
});

test("closed rule comment window does not invent a comment portal or hearing", () => {
  const actions = compileActionRail({
    kind: "rule",
    lifecycle_stage: "comment-closed",
    deadline: "2026-07-01",
    official_notice_url: "https://rules.cityofnewyork.us/rule/closed/",
  }, {today: "2026-08-02"});
  assert.equal(actions[0].delivery, "unavailable");
  assert.equal(actions[0].label_key, "next_action_comment_closed");
  assert.equal(actions.some((a) => a.guide), false);
});

test("missing hearing participation stays visible without inventing a destination", () => {
  // No venue, testimony, contact, or URL — only then may we show the participation missing state.
  const actions = compileActionRail({kind: "hearing"}, {today: "2026-08-01"});
  assert.equal(actions[0].delivery, "unavailable");
  assert.equal(actions[0].label_key, "next_action_participation_missing");
  assert.equal(actions[0].destination, undefined);
});

test("hearing with only a date/venue still gets a guide instead of an online-link punt", () => {
  const actions = compileActionRail({
    kind: "hearing",
    deadline: "2026-08-10T14:30:00.000",
    venue: {mode: "in-person", building: null, address: "22 Reade Street, New York, NY, 10007"},
  }, {today: "2026-08-01"});
  assert.equal(actions[0].delivery, "local");
  assert.equal(actions[0].type, "bid_checklist");
  assert.equal(actions[0].label_key, "next_action_hearing_guide");
  assert.equal(actions[0].guide.system, "hearing_extracted");
  assert.equal(actions[0].guide.venue_address, "22 Reade Street, New York, NY, 10007");
  assert.ok(!actions[0].destination);
});

test("FCRC-style hearing extracts venue, written testimony, and contact steps", () => {
  const row = {
    request_id: "20260716022",
    agency_name: "Parks and Recreation",
    type_of_notice_description: "Public Hearings",
    section_name: "Public Hearings and Meetings",
    short_title: "Notice of Joint Public Hearing: outdoor cafe concession",
    event_date: "2026-08-10T14:30:00.000",
    street_address_1: "255 Greenwich Street",
    street_address_2: "9th Floor",
    city: "New York",
    state: "NY",
    zip_code: "10007",
    additional_description_1: [
      "NOTICE OF A JOINT PUBLIC HEARING of the Franchise and Concession Review Committee",
      "to be held on 8/10/2026, at 255 Greenwich Street, 8th Floor, in Manhattan commencing at 2:30 p.m.",
      "Written testimony may be submitted in advance of the hearing electronically to " + EXAMPLE_EMAIL + ".",
      "All written testimony can be submitted up until the close of the public hearing and will be distributed to the FCRC after the hearing.",
      "A draft copy of the agreement may be obtained by email to " + EXAMPLE_EMAIL + ".",
      "The agenda and related documentation for the hearing will be posted on the MOCS website at",
      "https://www.nyc.gov/site/mocs/opportunities/franchises-concessions.page",
      "For accessibility requests contact " + EXAMPLE_EMAIL + ".",
    ].join(" "),
  };
  const hearing = normalizeHearingRow(row);
  const matter = {
    kind: "hearing",
    deadline: row.event_date,
    event_date: row.event_date,
    notice_text: row.additional_description_1,
    participation_url: hearing.participation?.links?.[0]?.url || null,
    venue: hearing.venue,
    participation: hearing.participation,
    street_address_1: row.street_address_1,
    street_address_2: row.street_address_2,
    city: row.city,
    state: row.state,
    zip_code: row.zip_code,
  };
  const handoff = hearingHandoff(matter);
  assert.equal(handoff.system, "hearing_extracted");
  assert.equal(handoff.has_fields, true);
  assert.equal(handoff.testimony_email, EXAMPLE_EMAIL);
  assert.equal(handoff.testimony_until?.kind, "hearing_close");
  assert.match(handoff.venue_address || "", /255 Greenwich/i);
  assert.ok(handoff.participation_url);
  assert.equal(handoff.join_kind, "link"); // agenda page, not Zoom
  assert.ok(handoff.emails.includes(EXAMPLE_EMAIL));

  const [action] = compileActionRail(matter, {today: "2026-08-01"});
  assert.notEqual(action.label_key, "next_action_participation_missing");
  assert.equal(action.guide?.testimony_email, EXAMPLE_EMAIL);
  assert.equal(action.guide?.system, "hearing_extracted");
});

test("second FCRC-style hearing also yields testimony + venue without a punt", () => {
  const row = {
    request_id: "20260709028",
    agency_name: "Police Department",
    type_of_notice_description: "Public Hearings",
    section_name: "Public Hearings and Meetings",
    short_title: "Concession for Operation and Maintenance of Cafeteria",
    event_date: "2026-08-10T14:30:00.000",
    street_address_1: "255 Greenwich Street",
    street_address_2: "9th Floor",
    city: "New York",
    state: "NY",
    zip_code: "10007",
    additional_description_1: [
      "NOTICE OF A JOINT PUBLIC HEARING of the Franchise and Concession Review Committee",
      "to be held on 8/10/2026, at 255 Greenwich Street, 8th Floor, New York, NY 10007 commencing at 2:30 pm.",
      "Written testimony may be submitted in advance of the hearing electronically to " + EXAMPLE_EMAIL + ".",
      "All written testimony can be submitted up until the close of the public hearing.",
      "A draft copy may be obtained at " + EXAMPLE_EMAIL + ".",
      "Agenda at https://www.nyc.gov/site/mocs/opportunities/franchises-concessions.page",
      "Accessibility: " + EXAMPLE_EMAIL + ".",
    ].join(" "),
  };
  const hearing = normalizeHearingRow(row);
  const matter = {
    kind: "hearing",
    deadline: row.event_date,
    notice_text: row.additional_description_1,
    participation_url: hearing.participation?.links?.[0]?.url || null,
    venue: hearing.venue,
    participation: hearing.participation,
    street_address_1: row.street_address_1,
    city: row.city,
    state: row.state,
    zip_code: row.zip_code,
  };
  const handoff = hearingHandoff(matter);
  assert.equal(handoff.testimony_email, EXAMPLE_EMAIL);
  assert.match(handoff.venue_address || "", /255 Greenwich/i);
  const actions = compileActionRail(matter, {today: "2026-08-01"});
  assert.notEqual(actions[0].label_key, "next_action_participation_missing");
  assert.ok(actions[0].guide);
});

test("Zoom-style join URLs still label as Join online with a hearing guide", () => {
  const [action] = compileActionRail({
    kind: "hearing",
    deadline: "2026-08-20T10:00:00.000",
    participation_url: "https://zoom.us/j/123456789",
    notice_text: "Join the hearing at https://zoom.us/j/123456789. Written testimony may be submitted electronically to " + EXAMPLE_EMAIL + ".",
  }, {today: "2026-08-01"});
  assert.equal(action.label_key, "join_online");
  assert.equal(action.destination, "https://zoom.us/j/123456789");
  assert.equal(action.guide?.join_kind, "join");
  assert.equal(action.guide?.testimony_email, EXAMPLE_EMAIL);
});

test("hearing calendar is a New York-zoned importable event with venue and source", () => {
  const ics = hearingCalendarICS({
    request_id: "20260716022",
    event_date: "2026-08-10T14:30:00.000",
    short_title: "Joint public hearing",
    agency_name: "Franchise and Concession Review Committee",
    venue: {building: "David N. Dinkins Municipal Building", address: "1 Centre Street, New York, NY 10007"},
    official_notice_url: "https://a856-cityrecord.nyc.gov/RequestDetail/20260716022",
  }, {now: "2026-08-03T12:00:00Z"});
  assert.ok(ics.endsWith("\r\n"));
  assert.ok(ics.split("\r\n").every(line => new TextEncoder().encode(line).length <= 75), "RFC 5545 lines stay within 75 octets");
  const unfolded = ics.replace(/\r\n[ \t]/g, "");
  assert.match(unfolded, /BEGIN:VTIMEZONE\r\nTZID:America\/New_York/);
  assert.match(unfolded, /DTSTART;TZID=America\/New_York:20260810T143000/);
  assert.match(unfolded, /DTEND;TZID=America\/New_York:20260810T153000/);
  assert.match(unfolded, /LOCATION:David N\. Dinkins Municipal Building · 1 Centre Street\\, New York\\, NY 10007/);
  assert.match(unfolded, /Official source: https:\/\/a856-cityrecord\.nyc\.gov\/RequestDetail\/20260716022/);
  const components = [...unfolded.matchAll(/^(BEGIN|END):([^\r]+)$/gm)].map(match => [match[1], match[2].trim()]);
  const stack = [];
  for (const [kind, name] of components) {
    if (kind === "BEGIN") stack.push(name);
    else assert.equal(stack.pop(), name, `balanced iCalendar component ${name}`);
  }
  assert.deepEqual(stack, []);
});

test("explicit UTC hearing instants convert to New York while date-only hearings stay honest", () => {
  const instant = hearingCalendarICS({event_date: "2026-08-10T14:30:00Z", request_id: "instant"}, {now: "2026-08-03T12:00:00Z"});
  assert.match(instant, /DTSTART;TZID=America\/New_York:20260810T103000/);
  const dateOnly = hearingCalendarICS({event_date: "2026-08-10", request_id: "day"}, {now: "2026-08-03T12:00:00Z"});
  assert.match(dateOnly, /DTSTART;VALUE=DATE:20260810/);
  assert.doesNotMatch(dateOnly, /DTSTART;TZID=/);
  assert.match(dateOnly, /DTEND;VALUE=DATE:20260811/);
});

test("meeting calendar carries the published remote join URL and both hybrid details", () => {
  const ics = hearingCalendarICS({
    request_id: "hybrid-001",
    event_date: "2026-08-10T14:30:00.000",
    title: "Hybrid public hearing",
    agency: "City Planning Commission",
    meeting_access: {
      mode: "hybrid",
      in_person_location: "Municipal Building, Room 120 · 1 Centre Street, New York, NY 10007",
      remote_join_url: "https://zoom.us/j/123456789",
      dial_in: ["555-0100"],
    },
  }, {now: "2026-08-03T12:00:00Z"});
  const unfolded = ics.replace(/\r\n[ \t]/g, "");
  assert.match(unfolded, /LOCATION:Municipal Building\\, Room 120 · 1 Centre Street\\, New York\\, NY 10007/);
  assert.match(unfolded, /URL:https:\/\/zoom\.us\/j\/123456789/);
  assert.match(unfolded, /Join online: https:\/\/zoom\.us\/j\/123456789/);
  assert.match(unfolded, /Dial-in: 555-0100/);
});

test("testimony pack is neutral, Spanish-first ready, and honest when participation facts are absent", () => {
  const signup = "https://example.com/hearing/register";
  const handoff = hearingHandoff({
    kind: "hearing",
    title: "Curbside management hearing",
    event_date: "2026-08-20T10:00:00.000",
    notice_text: `People who wish to testify must register at ${signup}. Written testimony may be submitted to ${EXAMPLE_EMAIL} until the close of the public hearing.`,
  });
  assert.equal(handoff.testimony_signup_url, signup);
  assert.match(handoff.testimony_starter.en, /^My name is \[name\]/);
  assert.match(handoff.testimony_starter.es, /^Me llamo \[nombre\]/);
  assert.match(handoff.testimony_starter.es, /expediente público/);
  assert.doesNotMatch(handoff.testimony_starter.en, /support|oppose|urge/i);

  const absent = hearingHandoff({kind: "hearing", event_date: "2026-08-20T10:00:00.000"});
  assert.equal(absent.testimony_signup_url, null);
  assert.equal(absent.testimony_email, null);
  assert.equal(absent.testimony_until, null);
  assert.equal(absent.testimony_starter, null);
});

test("upcoming hearing rail names its one-click ICS action", () => {
  const actions = compileActionRail({
    kind: "hearing",
    deadline: "2026-08-20T10:00:00.000",
    official_notice_url: "https://a856-cityrecord.nyc.gov/RequestDetail/20260716022",
  }, {today: "2026-08-01"});
  assert.equal(actions.find(action => action.type === "calendar")?.label_key, "calendar_ics");
});

test("exam action windows use the OASys landing with an honest browse label when unmapped", () => {
  const actions = compileActionRail({
    kind: "exam", lifecycle_stage: "open", deadline: "2026-08-20",
    exam_number: "7016",
    official_application_url: "https://www.nyc.gov/examsforjobs",
    official_notice_url: "https://www.nyc.gov/site/dcas/employment/exam-schedules-open-competitive-exams.page",
  }, {today: "2026-08-01"});
  assert.equal(actions[0].type, "official_application");
  assert.equal(actions[0].destination, "https://www.nyc.gov/examsforjobs");
  assert.equal(actions[0].guide?.system, "oasys");
  assert.equal(actions[0].guide?.mode, "landing");
  assert.equal(actions[0].guide?.identifier, "7016");
  assert.equal(actions[0].label_key, "career_apply_oasys_browse");
});

test("exam apply prefers a non-landing official_application_url when published", () => {
  const actions = compileActionRail({
    kind: "exam",
    lifecycle_stage: "open",
    deadline: "2026-08-20",
    exam_number: "7016",
    official_application_url: "https://a856-exams.nyc.gov/OASysWeb/noe?examId=9629",
  }, {today: "2026-08-01"});
  assert.equal(actions[0].destination, "https://a856-exams.nyc.gov/OASysWeb/noe?examId=9629");
  assert.equal(actions[0].guide?.mode, "deep");
  assert.equal(actions[0].label_key, "career_apply_oasys");
});

test("all compiled rails stay at three actions or fewer and validate", () => {
  const actions = compileActionRail(fixture.matter, {today: "2026-08-01"});
  assert.ok(actions.length <= 3);
  actions.forEach(validateAction);
});

test("property hearing with BBL leads with attend/prepare and ZoLa parcel lookup", () => {
  const actions = compileActionRail({
    kind: "property",
    disposition_stage: "hearing",
    section_name: "Property Disposition",
    type_of_notice_description: "Public Hearings",
    deadline: "2026-09-15T10:00:00.000",
    bbl: "1006440001",
    official_notice_url: "https://a856-cityrecord.nyc.gov/RequestDetail/20241112003",
    title: "Disposition hearing Manhattan Block 644 Lot 1",
  }, {today: "2026-08-01"});
  assert.ok(actions.length <= 3);
  actions.forEach(validateAction);
  assert.ok(actions.some((a) => a.type === "attend" || a.type === "calendar"));
  const zola = actions.find((a) => a.label_key === "property_action_lookup_zola");
  assert.ok(zola, "expected ZoLa parcel action when BBL is known");
  assert.match(zola.destination, /zola\.planning\.nyc\.gov/);
  assert.equal(zola.guide?.system, "parcel_lookup");
  assert.equal(zola.guide?.bbl, "1006440001");
});

test("property auction without package URL still surfaces parcel lookup — never a bare notice punt alone", () => {
  const actions = compileActionRail({
    kind: "property",
    disposition_stage: "auction_or_rfp",
    section_name: "Property Disposition",
    type_of_notice_description: "Sale",
    bbl: "3044440001",
    official_notice_url: "https://a856-cityrecord.nyc.gov/RequestDetail/20220504006",
    title: "REQUEST FOR PROPOSALS - INDUSTRY ROAD",
    notice_text: "NYCEDC is pleased to release this Request for Proposals for Industry Road.",
  }, {today: "2026-08-01"});
  actions.forEach(validateAction);
  assert.ok(actions.some((a) => a.label_key === "property_action_lookup_zola"));
  assert.ok(actions.every((a) => a.delivery !== "unavailable" || a.type === "attend"));
});

test("property award/conveyance with BBL opens ZoLa as primary parcel action", () => {
  const actions = compileActionRail({
    kind: "property",
    disposition_stage: "award_or_conveyance",
    bbl: "1006440001",
    official_notice_url: "https://a856-cityrecord.nyc.gov/RequestDetail/20241112003",
    owner_name: "Make it Zesty LLC",
  }, {today: "2026-08-01"});
  assert.equal(actions[0].label_key, "property_action_lookup_zola");
  assert.equal(actions[0].guide.owner_name, "Make it Zesty LLC");
  actions.forEach(validateAction);
});

test("property surplus auction commercial payload leads with marketplace bid handoff", () => {
  const actions = compileActionRail({
    kind: "property",
    disposition_stage: "auction_or_rfp",
    section_name: "Property Disposition",
    type_of_notice_description: "Sale",
    title: "AUTO AUCTION",
    official_notice_url: "https://a856-cityrecord.nyc.gov/RequestDetail/20251106024",
    notice_text: "The City posts vehicle and heavy machinery auctions online at https://www.govdeals.com/en/nyc-dcas-fleet. Registration is free.",
    commercial: {
      item: { category: "vehicle", label: "Vehicles" },
      sale_method: { method: "online_auction" },
      participation: {
        package_url: "https://www.govdeals.com/en/nyc-dcas-fleet",
        has_fields: true,
        steps: [{ kind: "registration", text: "Registration is free" }],
      },
    },
  }, {today: "2026-08-01"});
  actions.forEach(validateAction);
  const bid = actions[0];
  assert.equal(bid.label_key, "property_action_open_rfp");
  assert.match(bid.destination, /govdeals\.com/);
  assert.equal(bid.guide?.system, "notice_extracted");
  assert.equal(bid.guide?.commercial_item, "vehicle");
  assert.ok(Array.isArray(bid.guide?.commercial_steps));
});

test("attachment GetFile with DocumentID becomes package_url when body has no package link", () => {
  // Field shape: T0 attachment inventory (Cannonsville timber notice family).
  // Bare GetFile without DocumentID must not be promoted (search_page, not deep package).
  const deep =
    "https://a856-cityrecord.nyc.gov/Search/GetFile?sectionId=3&requestId=20240515016&requestStatus=Archived&documentId=37470";
  const bare = "https://a856-cityrecord.nyc.gov/Search/GetFile";
  assert.equal(
    packageUrlFromAttachments([
      { title: "Volume report", url: deep },
    ]),
    deep,
  );
  assert.equal(packageUrlFromAttachments([{ url: bare }]), null);
  assert.equal(packageUrlFromAttachments([]), null);

  const actions = compileActionRail({
    kind: "property",
    disposition_stage: "auction_or_rfp",
    section_name: "Property Disposition",
    type_of_notice_description: "Sale",
    title: "Timber sale",
    official_notice_url: "https://a856-cityrecord.nyc.gov/RequestDetail/20240515016",
    // Body has no download/package language — only the attachment inventory.
    notice_text: "The City will sell hardwood sawtimber from forest management project 5116.",
    attachments: [
      {
        title: "Description, maps, and volume report",
        url: deep,
        text_status: "ok",
      },
    ],
  }, { today: "2026-08-01" });
  actions.forEach(validateAction);
  const primary = actions[0];
  assert.equal(primary.label_key, "property_action_open_rfp");
  assert.equal(primary.destination, deep);
  assert.equal(primary.guide?.package_url, deep);
});

// --- Franchise / FCRC stage-tied action rail (phase spine + notice fields) ---

test("franchise public_hearing extracts venue/testimony as guide, not a link-only punt", () => {
  const matter = {
    kind: "franchise",
    franchise_stage: "public_hearing",
    lifecycle_stage: "public_hearing",
    deadline: "2026-08-10T14:30:00.000",
    event_date: "2026-08-10T14:30:00.000",
    official_notice_url: "https://a856-cityrecord.nyc.gov/RequestDetail/20260716022",
    notice_text: [
      "NOTICE OF A JOINT PUBLIC HEARING of the Franchise and Concession Review Committee",
      "to be held on 8/10/2026, at 255 Greenwich Street, 8th Floor, in Manhattan.",
      "Written testimony may be submitted electronically to " + EXAMPLE_EMAIL + ".",
      "Agenda at https://www.nyc.gov/site/mocs/opportunities/franchises-concessions.page",
    ].join(" "),
    venue: { mode: "in-person", building: null, address: "255 Greenwich Street, New York, NY, 10007" },
    participation_url: "https://www.nyc.gov/site/mocs/opportunities/franchises-concessions.page",
  };
  const handoff = franchiseHandoff(matter);
  assert.equal(handoff.stage, "public_hearing");
  assert.equal(handoff.has_fields, true);
  assert.equal(handoff.testimony_email, EXAMPLE_EMAIL);
  assert.match(handoff.venue_address || "", /255 Greenwich/i);

  const [action] = compileActionRail(matter, { today: "2026-08-01" });
  assert.notEqual(action.label_key, "next_action_participation_missing");
  assert.notEqual(action.label_key, "next_action_watch");
  assert.ok(action.guide);
  assert.equal(action.guide.testimony_email, EXAMPLE_EMAIL);
  // Primary is not watch-only and not a bare "use the official notice" punt.
  assert.ok(["attend", "bid_checklist", "document"].includes(action.type));
});

test("franchise solicitation leads with package or response guide, never award bid CTA", () => {
  const matter = {
    kind: "franchise",
    franchise_stage: "solicitation",
    lifecycle_stage: "solicitation",
    deadline: "2026-09-01T17:00:00.000",
    official_notice_url: "https://a856-cityrecord.nyc.gov/RequestDetail/full-chain-solicitation",
    title: "Request for Proposals — Information Services Franchise",
    notice_text: "Submit proposals by email to " + EXAMPLE_EMAIL + ". Package at https://www.nyc.gov/site/doitt/business/franchises.page",
    email: EXAMPLE_EMAIL,
  };
  const handoff = franchiseHandoff(matter);
  assert.equal(handoff.stage, "solicitation");
  assert.equal(handoff.has_fields, true);
  const actions = compileActionRail(matter, { today: "2026-08-01" });
  assert.ok(actions.length >= 1);
  assert.notEqual(actions[0].label_key, "next_action_watch");
  // No award "bid" framing on a franchise solicitation rail primary.
  assert.notEqual(actions[0].type, "rsvp");
  actions.forEach(validateAction);
});

test("franchise solicitation cannot reintroduce a degraded City Record notice as its package", () => {
  const handoff = franchiseHandoff({
    franchise_stage: "solicitation",
    kind: "solicitation",
    pin: "FRANCHISE-42",
    package_url: "https://a856-cityrecord.nyc.gov/RequestDetail/20260706006",
    official_notice_url: "https://a856-cityrecord.nyc.gov/RequestDetail/20260706006",
  });
  assert.equal(handoff.destination, null);
  assert.equal(handoff.package_url, null);
  assert.equal(handoff.upstream_unavailable_note_key, "next_action_unavailable_handoff");
});

test("franchise award primary is review award, never bid or solicitation submit", () => {
  const actions = compileActionRail({
    kind: "franchise",
    franchise_stage: "award",
    lifecycle_stage: "award",
    official_notice_url: "https://a856-cityrecord.nyc.gov/RequestDetail/full-chain-award",
    title: "Award of Information Services Franchise",
  }, { today: "2026-08-01" });
  assert.equal(actions[0].label_key, "franchise_phase_action_award");
  assert.equal(actions[0].type, "document");
  assert.ok(!actions.some((a) => a.type === "official_application"));
  actions.forEach(validateAction);
});

test("franchise committee_meeting past date degrades to event-passed, not invent attend", () => {
  const actions = compileActionRail({
    kind: "franchise",
    franchise_stage: "committee_meeting",
    lifecycle_stage: "committee_meeting",
    deadline: "2025-01-01T14:30:00.000",
    event_date: "2025-01-01T14:30:00.000",
    official_notice_url: "https://a856-cityrecord.nyc.gov/RequestDetail/full-chain-meeting",
    venue: { mode: "in-person", address: "22 Reade Street" },
  }, { today: "2026-08-01" });
  assert.equal(actions[0].delivery, "unavailable");
  assert.equal(actions[0].label_key, "next_action_event_passed");
  actions.forEach(validateAction);
});

// --- Award / selection next-action rail (Money lens: stop the watch-only punt) ---

test("registered Award notice leads with Checkbook registration, not watch or bid", () => {
  const matter = {
    kind: "award",
    type_of_notice_description: "Award",
    vendor_name: "ACME CORP",
    contract_amount: 1500000,
    pin: "08250R0001001",
    official_notice_url: "https://a856-cityrecord.nyc.gov/RequestDetail/20231222103",
    registration: {
      status: "matched",
      date: "2025-04-01",
      detail: {
        contract_id: "CT123456",
        vendor: "ACME CORP",
        registration_date: "2025-04-01",
        current_amount: 1500000,
        spent_to_date: 750000,
      },
    },
    payment: {
      status: "matched",
      detail: { total_spent: 750000, payment_state: "paid", total_payments: 2 },
    },
  };
  const handoff = awardHandoff(matter);
  assert.equal(handoff.system, "award_lifecycle");
  assert.equal(handoff.mode, "registered");
  assert.equal(handoff.vendor, "ACME CORP");
  assert.equal(handoff.amount, "$1,500,000");
  assert.equal(handoff.spent, "$750,000");
  assert.equal(handoff.registered, true);
  assert.match(handoff.destination, /checkbooknyc\.com/);
  assert.doesNotMatch(handoff.label_key, /bid/i);

  const actions = compileActionRail(matter, {today: "2026-08-01"});
  actions.forEach(validateAction);
  assert.equal(actions[0].delivery, "official_handoff");
  assert.equal(actions[0].label_key, "next_action_award_checkbook");
  assert.equal(actions[0].guide.label_key, "next_action_award_registered");
  assert.equal(actions[0].guide.system, "award_lifecycle");
  assert.equal(actions[0].type, "document");
  assert.doesNotMatch(actions[0].label_key, /bid|passport|response/i);
  assert.equal(actions[0].type === "official_application", false);
  // Primary is not watch — watch may still be secondary.
  assert.notEqual(actions[0].type, "watch");
  assert.ok(actions.some((a) => a.type === "watch"));
});

test("Award with vendor and amount but no Checkbook join is guide-first, not watch-only", () => {
  const matter = {
    kind: "award",
    type_of_notice_description: "Award",
    vendor_name: "HNTB New York Engineering and Architecture P.C.",
    contract_amount: 4020000,
    pin: "84124P0003001",
    official_notice_url: "https://a856-cityrecord.nyc.gov/RequestDetail/20240723114",
  };
  const handoff = awardHandoff(matter);
  assert.equal(handoff.mode, "award");
  assert.equal(handoff.has_fields, true);
  assert.equal(handoff.vendor, "HNTB New York Engineering and Architecture P.C.");
  assert.match(handoff.amount, /\$4[,.]?020[,.]?000|\$4,020,000/);

  const [action] = compileActionRail(matter, {today: "2026-08-01"});
  // PIN yields a Checkbook search destination when present.
  assert.ok(action.guide);
  assert.equal(action.guide.system, "award_lifecycle");
  assert.equal(action.label_key, "next_action_award_checkbook");
  assert.equal(action.guide.label_key, "next_action_award_to");
  assert.equal(action.label_vars.vendor, "HNTB New York Engineering and Architecture P.C.");
  assert.doesNotMatch(action.label_key, /bid|watch/i);
  assert.doesNotMatch(String(action.label || ""), /bid|Watch this notice/i);
});

test("Intent to Award is a selection-phase guide, never a solicitation bid CTA", () => {
  const matter = {
    kind: "award",
    type_of_notice_description: "Intent to Award",
    vendor_name: "BETA LLC",
    contract_amount: 2000000,
    pin: "82626B0001",
    official_notice_url: "https://a856-cityrecord.nyc.gov/RequestDetail/20260601001",
  };
  const handoff = awardHandoff(matter);
  assert.equal(handoff.mode, "selection");
  assert.equal(handoff.selection_phase, "intent_to_award");
  assert.equal(handoff.destination, null, "selection without registration stays guide-first");
  assert.equal(handoff.vendor, "BETA LLC");

  const actions = compileActionRail(matter, {today: "2026-08-01"});
  actions.forEach(validateAction);
  assert.equal(actions[0].type, "bid_checklist");
  assert.equal(actions[0].delivery, "local");
  assert.equal(actions[0].guide.mode, "selection");
  assert.equal(actions[0].guide.selection_phase, "intent_to_award");
  assert.equal(actions[0].label_key, "next_action_award_to");
  // Never a PASSPort / iSupplier / open-bid primary.
  assert.doesNotMatch(actions[0].label_key, /passport|isupplier|bid_closed|response_guide|open_rfp/i);
  assert.equal(actions.some((a) => a.type === "official_application"), false);
});

test("Intent to Negotiate is selection-phase, not a submit-a-bid rail", () => {
  const actions = compileActionRail({
    type_of_notice_description: "Intent to Negotiate",
    pin: "8502026HP0099",
    agency_name: "Parks and Recreation",
    title: "Intent to Negotiate — park maintenance",
    official_notice_url: "https://a856-cityrecord.nyc.gov/RequestDetail/20260701099",
  }, {today: "2026-08-01"});
  actions.forEach(validateAction);
  assert.equal(actions[0].guide?.system, "award_lifecycle");
  assert.equal(actions[0].guide?.mode, "selection");
  assert.equal(actions[0].guide?.selection_phase, "intent_to_negotiate");
  assert.equal(actions[0].label_key, "next_action_intent_to_negotiate");
  assert.equal(actions[0].type === "official_application", false);
  assert.doesNotMatch(actions[0].label_key, /passport|isupplier|open_rfp|response/i);
});

test("Vendor List is selection-phase on the award rail", () => {
  const handoff = awardHandoff({
    type_of_notice_description: "Vendor List",
    pin: "12345",
  });
  assert.equal(handoff.mode, "selection");
  assert.equal(handoff.selection_phase, "vendor_list");
  assert.equal(handoff.label_key, "next_action_vendor_list");
});

test("Award without vendor, amount, or lifecycle degrades to notice + watch", () => {
  const actions = compileActionRail({
    kind: "award",
    type_of_notice_description: "Award",
    official_notice_url: "https://a856-cityrecord.nyc.gov/RequestDetail/20260101001",
  }, {today: "2026-08-01"});
  actions.forEach(validateAction);
  assert.deepEqual(actions.map((a) => a.type), ["document", "watch"]);
  assert.equal(actions[0].label_key, "read_official_notice");
  assert.equal(actions[0].guide, undefined);
});

test("pending Checkbook registration surfaces pending CTA on Award", () => {
  const handoff = awardHandoff({
    kind: "award",
    type_of_notice_description: "Award",
    vendor_name: "GAMMA INC",
    pin: "07112R0001001",
    pending: {
      status: "matched",
      detail: { contract_id: "CT999", vendor: "GAMMA INC", amount: 3000000 },
    },
  });
  assert.equal(handoff.mode, "pending");
  assert.equal(handoff.pending_registration, true);
  assert.equal(handoff.label_key, "next_action_award_pending");
  assert.match(handoff.destination, /checkbooknyc\.com/);
});
