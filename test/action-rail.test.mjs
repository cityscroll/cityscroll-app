import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compileActionRail, solicitationHandoff, validateAction } from "../worker/src/lib/action_registry.mjs";

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

  const hearing = compileActionRail({
    kind: "hearing", deadline: "2026-08-10T14:30:00.000",
    participation_url: "https://www.nyc.gov/site/mocs/opportunities/franchises-concessions.page",
  }, {today: "2026-08-01"});
  assert.deepEqual(hearing.map(action => action.type), ["attend", "calendar", "watch"]);
});

test("missing hearing participation stays visible without inventing a destination", () => {
  const actions = compileActionRail({kind: "hearing", deadline: "2026-08-10"}, {today: "2026-08-01"});
  assert.equal(actions[0].delivery, "unavailable");
  assert.equal(actions[0].label_key, "next_action_participation_missing");
  assert.equal(actions[0].destination, undefined);
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
