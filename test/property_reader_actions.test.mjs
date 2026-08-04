import assert from "node:assert/strict";
import test from "node:test";

import {
  extractPropertyReaderActions,
  PROPERTY_ACTION_KINDS,
} from "../site/property_reader_actions.mjs";
import { compileActionRail, validateAction } from "../worker/src/lib/action_registry.mjs";

const future = { today: "2026-08-04" };

function kinds(row, options = future) {
  return extractPropertyReaderActions(row, options).actions.map((action) => action.kind);
}

test("each census pattern emits only its literal reader actions", () => {
  const cases = [
    ["pending destruction", {
      short_title: "Official notice of pending destruction of unauthorized tobacco",
      additional_description_1: "For questions regarding the listed products, contact the Civil Enforcement Unit.",
    }, ["inquire_claim"]],
    ["unclaimed property", {
      short_title: "Owners are wanted by the Property Clerk",
      additional_description_1: "Inquiries relating to such property should be made in the Borough concerned, at the following office of the Property Clerk.",
    }, ["inquire_claim"]],
    ["forest sale", {
      short_title: "Forest Management Project timber sale",
      additional_description_1: "Prospective bidders are encouraged to attend the public showing. All bid proposals must be submitted by August 20, 2026.",
    }, ["bid", "inspect"]],
    ["lease RFP", {
      short_title: "Request for Proposals for lease offers",
      additional_description_1: "Submit proposals online at https://example.gov/lease by September 1, 2026. The public can review the terms online.",
    }, ["bid", "review_documents"]],
    ["surplus auction", {
      short_title: "The City is currently selling surplus assets online",
      additional_description_1: "To begin bidding, click Register at https://example.gov/auction. Registration is free.",
    }, ["bid"]],
    ["direct sale", {
      short_title: "Notice of Public Sale of Residential Property",
      additional_description_1: "All bids must be submitted by August 30, 2026 to the Law Department.",
    }, ["bid"]],
    ["medallion result", {
      short_title: "Notice of winning bidders from medallion auction",
      additional_description_1: "The winning bidders are listed below.",
    }, ["review_result"]],
    ["UDAAP", {
      short_title: "Urban Development Action Area Project (UDAAP)",
      event_date: "2026-09-10T10:00:00.000",
      additional_description_1: "Persons wishing to be heard may attend the public hearing. Individuals requesting a sign language interpreter should contact the agency no later than five business days prior.",
    }, ["attend", "request_accommodation"]],
    ["acquisition", {
      short_title: "Public hearing for an acquisition and easement",
      event_date: "2026-09-11T10:00:00.000",
      additional_description_1: "All persons wishing to be heard may attend the public hearing. The appraisal is available for public examination at HPD.",
    }, ["attend", "review_documents"]],
    ["disposition", {
      type_of_notice_description: "Public Hearings",
      short_title: "Proposed disposition area",
      event_date: "2026-09-12T10:00:00.000",
      additional_description_1: "Anyone wishing to be heard may attend the public hearing.",
    }, ["attend"]],
  ];
  for (const [label, row, expected] of cases) {
    assert.deepEqual(kinds(row), expected, label);
  }
});

test("object and comment require literal submission methods and stay absent from hearing boilerplate", () => {
  const baseline = {
    type_of_notice_description: "Public Hearings",
    short_title: "Property disposition",
    additional_description_1: "A public hearing will be held. Persons wishing to be heard may attend. The agreement is available for public examination.",
  };
  assert.deepEqual(kinds(baseline), ["attend", "review_documents"]);

  const futureNotice = {
    ...baseline,
    additional_description_1: "Mail written comments to the agency by September 1. Objections must be mailed to 100 Main Street within 30 days.",
  };
  const extracted = extractPropertyReaderActions(futureNotice, future);
  assert.deepEqual(extracted.actions.map((action) => action.kind), ["comment", "object"]);
  for (const action of extracted.actions) {
    assert.ok(action.methods.some((method) => method.kind === "mail"));
    assert.ok(action.by_when?.label);
  }
});

test("methods, deadlines, and evidence remain source-backed", () => {
  const email = ["example", "example.com"].join("@");
  const body = `All sealed bids must be submitted by email to ${email} no later than September 3, 2026.`;
  const result = extractPropertyReaderActions({
    short_title: "Notice of Public Sale of Residential Property",
    additional_description_1: body,
  }, {
    today: "2026-08-04",
    events: [{
      kind: "bid_deadline",
      deadline: "2026-09-03T17:00:00.000",
      evidence: { field: "additional_description_1", start: 0, end: body.length, text: body },
    }],
  });
  const [action] = result.actions;
  assert.equal(action.kind, "bid");
  assert.equal(action.label, "Bid or submit a proposal");
  assert.equal(action.status, "current");
  assert.equal(action.by_when.value, "2026-09-03T17:00:00.000");
  assert.ok(action.methods.some((method) => method.kind === "email" && method.value === email));
  assert.equal(body.slice(action.how.start, action.how.end), action.how.text);

  const secondSentence = `Introduction only. ${body}`;
  const [later] = extractPropertyReaderActions({
    short_title: "Notice of Public Sale of Residential Property",
    additional_description_1: secondSentence,
  }, future).actions;
  assert.equal(secondSentence.slice(later.how.start, later.how.end), later.how.text);
});

test("the shared timed-event payload supplies auction windows without re-extraction", () => {
  const source = "To begin bidding, register at https://example.gov/auction.";
  const [action] = extractPropertyReaderActions({
    short_title: "Surplus assets online auction",
    additional_description_1: source,
    commercial: { timed_events: [{
      kind: "auction_window",
      start: "2026-08-10T09:00:00.000",
      end: "2026-08-20T17:00:00.000",
      source_span: { field: "additional_description_1", text: source },
    }] },
  }, future).actions;
  assert.equal(action.by_when.kind, "auction_window");
  assert.equal(action.by_when.value, "2026-08-20T17:00:00.000");
  assert.equal(action.by_when.source.text, source);
});

test("past dated actions become historical context, while evergreen inquiry stays undated", () => {
  const past = extractPropertyReaderActions({
    short_title: "Urban Development Action Area Project",
    start_date: "2025-01-01",
    event_date: "2025-02-01T10:00:00.000",
    additional_description_1: "Persons wishing to be heard may attend the public hearing.",
  }, future);
  assert.equal(past.actions[0].status, "historical");
  assert.equal(past.actionable.length, 0);

  const claim = extractPropertyReaderActions({
    short_title: "Owners are wanted by the Property Clerk",
    start_date: "2016-01-01",
    additional_description_1: "Inquiries relating to such property should be made at the Property Clerk office.",
  }, future);
  assert.equal(claim.actions[0].status, "undated");
  assert.equal(claim.actionable.length, 1);
});

test("a relative accommodation request follows the hearing's live/past state until a typed deadline lands", () => {
  const base = {
    short_title: "Urban Development Action Area Project",
    additional_description_1: "Individuals requesting a sign language interpreter should contact the agency no later than five business days prior to the public hearing.",
  };
  const upcoming = extractPropertyReaderActions({ ...base, event_date: "2026-09-12" }, future).actions[0];
  const past = extractPropertyReaderActions({ ...base, event_date: "2026-07-12" }, future).actions[0];
  assert.equal(upcoming.status, "undated");
  assert.equal(upcoming.by_when.value, null);
  assert.match(upcoming.by_when.label, /five business days prior/i);
  assert.equal(past.status, "historical");
});

test("action vocabulary is closed and duplicate actions are not emitted", () => {
  const result = extractPropertyReaderActions({
    short_title: "Forest Management timber sale",
    additional_description_1: "Bids must be submitted by August 20. Bids must be submitted by August 20.",
  }, future);
  assert.equal(result.actions.length, 1);
  assert.ok(PROPERTY_ACTION_KINDS.includes(result.actions[0].kind));
});

test("property actions render through the existing action rail contract", () => {
  const row = {
    short_title: "Forest Management timber sale",
    start_date: "2026-08-01",
    additional_description_1: "All bid proposals must be submitted online at https://example.gov/timber by September 3, 2026.",
  };
  const readerActions = extractPropertyReaderActions(row, {
    today: "2026-08-04",
    events: [{ kind: "bid_deadline", deadline: "2026-09-03", source_span: { text: row.additional_description_1 } }],
  });
  const actions = compileActionRail({
    kind: "property",
    section_name: "Property Disposition",
    official_notice_url: "https://a856-cityrecord.nyc.gov/RequestDetail/20260801001",
    reader_actions: readerActions,
  }, { today: "2026-08-04" });
  actions.forEach(validateAction);
  assert.equal(actions[0].guide.system, "property_reader_actions");
  assert.equal(actions[0].guide.actions[0].kind, "bid");
  assert.equal(actions[0].destination, "https://example.gov/timber");
  assert.equal(actions.some((action) => action.type === "calendar"), false, "bid dates do not use the hearing attend pack");
  assert.ok(actions.some((action) => action.type === "watch"));
});

test("an upcoming property hearing reuses the attend-pack calendar action", () => {
  const row = {
    type_of_notice_description: "Public Hearings",
    short_title: "Property disposition hearing",
    event_date: "2026-09-12T10:00:00.000",
    additional_description_1: "Anyone wishing to be heard may attend the public hearing.",
  };
  const readerActions = extractPropertyReaderActions(row, future);
  const actions = compileActionRail({
    kind: "property",
    deadline: row.event_date,
    event_date: row.event_date,
    official_notice_url: "https://a856-cityrecord.nyc.gov/RequestDetail/20260912001",
    reader_actions: readerActions,
  }, future);
  assert.equal(actions[0].type, "attend");
  assert.equal(actions[0].guide.attendance.system, "hearing_extracted");
  assert.equal(actions.find((action) => action.type === "calendar")?.deadline, row.event_date);
});

test("historical property actions are context, not a live attend or bid call", () => {
  const row = {
    short_title: "Urban Development Action Area Project",
    start_date: "2025-01-01",
    event_date: "2025-02-01",
    additional_description_1: "Persons wishing to be heard may attend the public hearing.",
  };
  const readerActions = extractPropertyReaderActions(row, future);
  const actions = compileActionRail({
    kind: "property",
    official_notice_url: "https://a856-cityrecord.nyc.gov/RequestDetail/20250101001",
    reader_actions: readerActions,
  }, future);
  assert.equal(actions[0].type, "document");
  assert.equal(actions[0].label_key, "read_official_notice");
  assert.equal(actions.some((action) => action.type === "attend" || action.type === "official_application"), false);
});
