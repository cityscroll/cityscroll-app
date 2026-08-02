import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  compileActionRail,
  solicitationHandoff,
  hearingHandoff,
  ruleHandoff,
  validateAction,
} from "../worker/src/lib/action_registry.mjs";

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
  // RFQ identity + package point at City Record when no public per-RFQ iSupplier URL exists.
  assert.equal(handoff.identifier_url, "https://a856-cityrecord.nyc.gov/RequestDetail/20260617050");
  assert.equal(handoff.package_url, "https://a856-cityrecord.nyc.gov/RequestDetail/20260617050");

  const [action] = compileActionRail(matter, {today: "2026-08-01"});
  assert.equal(action.label_key, "open_nycha_isupplier");
  assert.equal(action.guide.mode, "notice_named");
  assert.doesNotMatch(action.destination, /passport/i);
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

test("exam action windows reuse the official OASys handoff", () => {
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
});

test("exam apply prefers a non-landing official_application_url when published", () => {
  const actions = compileActionRail({
    kind: "exam",
    lifecycle_stage: "open",
    deadline: "2026-08-20",
    exam_number: "7016",
    official_application_url: "https://a856-exams.nyc.gov/oasysweb/apply/7016",
  }, {today: "2026-08-01"});
  assert.equal(actions[0].destination, "https://a856-exams.nyc.gov/oasysweb/apply/7016");
  assert.equal(actions[0].guide?.mode, "deep");
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
