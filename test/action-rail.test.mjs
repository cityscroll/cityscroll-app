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

  const [action] = compileActionRail(matter, {today: "2026-08-01"});
  assert.equal(action.label_key, "open_nycha_isupplier");
  assert.equal(action.guide.mode, "notice_named");
  assert.doesNotMatch(action.destination, /passport/i);
});

test("matched Released PASSPort RFx carries searchable identity and status into the guide", () => {
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
  assert.equal(action.label_key, "search_passport_rfx");
  assert.equal(action.destination, "https://a0333-passportpublic.nyc.gov/rfx.html");
  assert.deepEqual(
    {system: action.guide.system, mode: action.guide.mode, identifier: action.guide.identifier, status: action.guide.status},
    {system: "passport", mode: "matched", identifier: "81026B0003", status: "Released"},
  );
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
  assert.equal(unrelated.mode, "notice_only");
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
  assert.deepEqual(actions.map(action => action.type), ["official_application", "calendar", "watch"]);
  assert.equal(actions[0].delivery, "unavailable");
  assert.equal(actions.some(action => action.type === "document"), false);
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
    official_application_url: "https://www.nyc.gov/examsforjobs",
    official_notice_url: "https://www.nyc.gov/site/dcas/employment/exam-schedules-open-competitive-exams.page",
  }, {today: "2026-08-01"});
  assert.equal(actions[0].type, "official_application");
  assert.equal(actions[0].destination, "https://www.nyc.gov/examsforjobs");
});

test("all compiled rails stay at three actions or fewer and validate", () => {
  const actions = compileActionRail(fixture.matter, {today: "2026-08-01"});
  assert.ok(actions.length <= 3);
  actions.forEach(validateAction);
});
