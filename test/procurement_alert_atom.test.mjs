// Pure tests for the opportunity-first procurement alert atom
// (procurement-pursuit-decision, Card 1). Fixtures reused verbatim from
// test/digest_preview_awareness.test.mjs (Fixtures C, E) and
// test/fixtures/procurement_pursuit_decision/fixture-ledger.json (Fixture D
// identity) per the shared fixture-ledger rule — no new commission examples.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PROCUREMENT_ALERT_BODY_STEPS,
  PROCUREMENT_ALERT_SUBJECT_BUDGET,
  agencyAbbreviation,
  buildProcurementAlertAtom,
  buildProcurementAlertBodySections,
  escapeSubjectHtml,
  escapeSubjectText,
  procurementAlertSubject,
  procurementAlertSubjectSegment,
  recognizableTitle,
  selectLeadProcurementAtom,
} from "../site/procurement_alert_atom.mjs";
import { OPPORTUNITY_WINDOW_KIND } from "../site/procurement_opportunity_window.mjs";

// Fixture C — test/digest_preview_awareness.test.mjs, ledger id "C".
const FIXTURE_C_ROW = {
  request_id: "FIX-PREV-SOL-1",
  short_title: "Fixture street materials",
  agency_name: "Department of Transportation",
  type_of_notice_description: "Solicitation",
  due_date: "2026-08-10",
  additional_description_1:
    "Vendors must download the solicitation documents at https://example.com/rfps before submitting.",
};

// Fixture D identity — test/fixtures/procurement_pursuit_decision/fixture-ledger.json id "D".
// Amount/deadline are explicitly "unavailable" per that ledger's expected_unknowns (a raw
// non-canonical estimated_value/opening_date exists but nothing maps to a canonical
// contract_amount/due_date) — not "not_observed" (never captured at all).
const FIXTURE_D_ROW = {
  procurement_id: "procurement:solicitation:S48020",
  title: "CBTC for 6th Ave Line, 63rd St Line and DeKalb Interlocking",
  agency_name: "MTA Construction & Development",
  kind: "solicitation",
};
const FIXTURE_D_OPTS = { amountStatus: "unavailable", deadlineStatus: "unavailable" };

// Fixture E — test/digest_preview_awareness.test.mjs, ledger id "E".
const FIXTURE_E_ROW = {
  request_id: "FIX-PREV-AWD-1",
  short_title: "Fixture award",
  type_of_notice_description: "Award",
  vendor_name: "Acme Snow & Ice LLC",
  contract_amount: 250000,
  pin: "PIN-PREV-1",
};

test("atom shape carries the commission's twelve fields plus matter_kind", () => {
  const atom = buildProcurementAlertAtom(FIXTURE_C_ROW);
  for (const key of [
    "procurement_id", "request_id", "title", "agency", "amount", "deadline",
    "match_reasons", "method", "mwbe", "opportunity_window", "important_dates",
    "cityscroll_url", "official_url",
  ]) {
    assert.ok(Object.prototype.hasOwnProperty.call(atom, key), `missing atom field ${key}`);
  }
  assert.ok(Array.isArray(atom.match_reasons));
  assert.ok(Array.isArray(atom.important_dates));
  assert.equal(typeof atom.matter_kind, "string");
});

test("Fixture C: subject is 'DOT · Fixture street materials · closes Aug 10'", () => {
  const atom = buildProcurementAlertAtom(FIXTURE_C_ROW);
  assert.equal(atom.matter_kind, "solicitation");
  assert.equal(atom.amount.status, "not_observed");
  assert.equal(atom.deadline.status, "observed");
  assert.equal(procurementAlertSubjectSegment(atom), "DOT · Fixture street materials · closes Aug 10");
  assert.equal(procurementAlertSubject({ atoms: [atom] }), "DOT · Fixture street materials · closes Aug 10");
});

test("Fixture D: subject omits amount and labels the deadline, never fabricates either", () => {
  const atom = buildProcurementAlertAtom(FIXTURE_D_ROW, FIXTURE_D_OPTS);
  assert.equal(atom.matter_kind, "solicitation");
  assert.equal(atom.amount.status, "unavailable");
  assert.equal(atom.deadline.status, "unavailable");
  const subject = procurementAlertSubject({ atoms: [atom] });
  assert.equal(subject, "MTA C&D · CBTC for 6th Ave / 63rd St · deadline not published");
  assert.doesNotMatch(subject, /\$0\b/);
  assert.doesNotMatch(subject, /\d{4}-\d{2}-\d{2}/); // no fabricated due date
  assert.doesNotMatch(subject, /respond now/i);
});

test("multi-match: lead item names the exact remaining count", () => {
  const lead = buildProcurementAlertAtom(FIXTURE_C_ROW);
  const other1 = buildProcurementAlertAtom(FIXTURE_D_ROW, FIXTURE_D_OPTS);
  const other2 = buildProcurementAlertAtom(
    { ...FIXTURE_D_ROW, procurement_id: "procurement:solicitation:S48021", kind: "award" },
  );
  const subject = procurementAlertSubject({ atoms: [lead, other1, other2] });
  assert.equal(subject, "DOT · Fixture street materials · closes Aug 10 (+2)");
});

test("Fixture E: award control never renders a deadline/bid segment, amount stays honest", () => {
  const atom = buildProcurementAlertAtom(FIXTURE_E_ROW);
  assert.equal(atom.matter_kind, "award");
  assert.equal(atom.amount.status, "observed");
  assert.equal(atom.amount.value, 250000);
  const subject = procurementAlertSubject({ atoms: [atom] });
  assert.doesNotMatch(subject, /closes|deadline not published/i);
  assert.doesNotMatch(subject, /\bbid\b/i);
  assert.match(subject, /\$250,000/);
});

test("lead selection rule 1: an actionable solicitation always outranks an award", () => {
  const solicitation = buildProcurementAlertAtom({
    request_id: "sol-1", short_title: "Later solicitation", agency_name: "Finance",
    type_of_notice_description: "Solicitation", due_date: "2026-12-31",
  });
  const award = buildProcurementAlertAtom({
    request_id: "awd-1", short_title: "Sooner award", agency_name: "Finance",
    type_of_notice_description: "Award", contract_amount: 999999,
  });
  const { lead } = selectLeadProcurementAtom([award, solicitation]);
  assert.equal(lead.request_id, "sol-1");
});

test("lead selection rule 2: among solicitations, the nearest known due date wins", () => {
  const soon = buildProcurementAlertAtom({
    request_id: "s-soon", short_title: "Soon", agency_name: "Finance",
    type_of_notice_description: "Solicitation", due_date: "2026-08-01",
  });
  const later = buildProcurementAlertAtom({
    request_id: "s-later", short_title: "Later", agency_name: "Finance",
    type_of_notice_description: "Solicitation", due_date: "2026-09-01",
  });
  const unknown = buildProcurementAlertAtom({
    request_id: "s-unknown", short_title: "Unknown deadline", agency_name: "Finance",
    type_of_notice_description: "Solicitation",
  });
  const { lead } = selectLeadProcurementAtom([later, unknown, soon]);
  assert.equal(lead.request_id, "s-soon");
});

test("lead selection rule 3: among equal-deadline ties, known amount wins", () => {
  const noAmount = buildProcurementAlertAtom({
    request_id: "s-b", short_title: "No amount", agency_name: "Finance",
    type_of_notice_description: "Solicitation", due_date: "2026-08-01",
  });
  const withAmount = buildProcurementAlertAtom({
    request_id: "s-a", short_title: "Has amount", agency_name: "Finance",
    type_of_notice_description: "Solicitation", due_date: "2026-08-01", contract_amount: 100000,
  });
  const { lead } = selectLeadProcurementAtom([noAmount, withAmount]);
  assert.equal(lead.request_id, "s-a");
});

test("lead selection rule 4: fully tied atoms break on stable id", () => {
  const a = buildProcurementAlertAtom({
    request_id: "z-later-id", short_title: "Tied", agency_name: "Finance",
    type_of_notice_description: "Solicitation", due_date: "2026-08-01",
  });
  const b = buildProcurementAlertAtom({
    request_id: "a-earlier-id", short_title: "Tied", agency_name: "Finance",
    type_of_notice_description: "Solicitation", due_date: "2026-08-01",
  });
  const { lead } = selectLeadProcurementAtom([a, b]);
  assert.equal(lead.request_id, "a-earlier-id");
});

test("amount is never rendered as $0 — zero and negative values are treated as unknown", () => {
  const zero = buildProcurementAlertAtom({ request_id: "z", short_title: "Zero", agency_name: "Finance", contract_amount: 0 });
  const negative = buildProcurementAlertAtom({ request_id: "n", short_title: "Negative", agency_name: "Finance", contract_amount: -5 });
  assert.equal(zero.amount.status, "not_observed");
  assert.equal(negative.amount.status, "not_observed");
  assert.doesNotMatch(procurementAlertSubjectSegment(zero), /\$0\b/);
});

test("rolling-year sentinel deadlines never render as a fabricated closing date", () => {
  const rolling = buildProcurementAlertAtom({
    request_id: "roll-1", short_title: "Rolling", agency_name: "Finance",
    type_of_notice_description: "Solicitation", due_date: "2099-01-01",
  });
  assert.equal(rolling.deadline.status, "not_observed");
  assert.doesNotMatch(procurementAlertSubjectSegment(rolling), /2099|closes/i);
  assert.match(procurementAlertSubjectSegment(rolling), /deadline not published/);
});

test("recognizableTitle collapses a multi-'Line' corridor title and truncates otherwise", () => {
  assert.equal(
    recognizableTitle("CBTC for 6th Ave Line, 63rd St Line and DeKalb Interlocking"),
    "CBTC for 6th Ave / 63rd St",
  );
  assert.equal(recognizableTitle("Fixture street materials"), "Fixture street materials");
  const long = "A".repeat(120);
  const truncated = recognizableTitle(long, 20);
  assert.ok(truncated.length <= 20);
  assert.match(truncated, /…$/);
});

test("subject text strips control characters and header-unsafe newlines", () => {
  assert.equal(escapeSubjectText("Fixture\r\nstreet\tmaterials"), "Fixture street materials");
  assert.equal(escapeSubjectHtml('<script>&"'), "&lt;script&gt;&amp;&quot;");
});

test("full subject stays within the documented budget while keeping the (+N) suffix", () => {
  const longTitle = "Reconstruction of Multiple Playground Facilities Across Several Boroughs and Districts";
  const lead = buildProcurementAlertAtom({
    request_id: "long-1", short_title: longTitle, agency_name: "Parks and Recreation",
    type_of_notice_description: "Solicitation", due_date: "2026-08-10", contract_amount: 4500000,
  });
  const others = Array.from({ length: 5 }, (_, i) => buildProcurementAlertAtom({
    request_id: `extra-${i}`, short_title: "Extra match", agency_name: "Finance", contract_amount: 1,
  }));
  const subject = procurementAlertSubject({ atoms: [lead, ...others] });
  assert.ok(subject.length <= PROCUREMENT_ALERT_SUBJECT_BUDGET);
  assert.match(subject, /\(\+5\)$/);
});

test("agencyAbbreviation reuses agency_identity.mjs and never fabricates an unmatched short form", () => {
  assert.equal(agencyAbbreviation("Department of Transportation"), "DOT");
  assert.equal(agencyAbbreviation("MTA Construction & Development"), "MTA C&D");
  assert.equal(agencyAbbreviation("DOE"), "DOE"); // unmatched raw text stays as-is (never "Doe")
  assert.equal(agencyAbbreviation(""), null);
});

test("body hierarchy follows the commission's eight-step order", () => {
  assert.deepEqual(PROCUREMENT_ALERT_BODY_STEPS, [
    "identity", "timing", "match_reasons", "commercial_facts",
    "response_window", "context", "review_on_cityscroll", "official_action",
  ]);
  const atom = buildProcurementAlertAtom(FIXTURE_C_ROW, { match_reasons: ["street materials"] });
  const sections = buildProcurementAlertBodySections(atom);
  assert.deepEqual(sections.map((s) => s.key), PROCUREMENT_ALERT_BODY_STEPS);
  const matchReasonsStep = sections.find((s) => s.key === "match_reasons");
  const reviewStep = sections.find((s) => s.key === "review_on_cityscroll");
  const officialStep = sections.find((s) => s.key === "official_action");
  assert.ok(matchReasonsStep.step < reviewStep.step);
  assert.ok(matchReasonsStep.step < officialStep.step);
  assert.deepEqual(matchReasonsStep.reasons, ["street materials"]);
});

test("procurement-object rows and City Record notice rows normalize to the same atom shape", () => {
  const cityRecordRow = FIXTURE_C_ROW; // request_id-first City Record notice
  const procurementObjectRow = FIXTURE_D_ROW; // procurement_id-first procurement object
  const a = buildProcurementAlertAtom(cityRecordRow);
  const b = buildProcurementAlertAtom(procurementObjectRow, FIXTURE_D_OPTS);
  assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort());
});

// Card 2 (procurement_opportunity_window.mjs) landed after this atom shipped;
// the atom's opportunity_window field wires the real derivation rather than a
// passthrough stub. Fixture A's own City Record start_date/due_date pair
// (test/fixtures/procurement_pursuit_decision/fixture-ledger.json id "A")
// reused verbatim.
test("opportunity_window derives the real notice-to-due window from a row's own start_date/due_date", () => {
  const row = {
    request_id: "20260701001",
    short_title: "Playground reconstruction",
    agency_name: "Department of Parks and Recreation",
    type_of_notice_description: "Solicitation",
    start_date: "2026-07-02",
    due_date: "2026-08-05",
  };
  const atom = buildProcurementAlertAtom(row);
  assert.equal(atom.opportunity_window.available, true);
  assert.equal(atom.opportunity_window.kind, OPPORTUNITY_WINDOW_KIND.NOTICE_TO_DUE_WINDOW);
  assert.equal(atom.opportunity_window.days, 34);
  assert.equal(atom.opportunity_window.source_observation_ref, "city_record:20260701001");
  assert.match(atom.opportunity_window.label, /Notice-to-due window: 34 calendar days/);
});

test("opportunity_window prefers an exact PASSPort release_date over City Record publication", () => {
  const row = {
    request_id: "20260701001",
    short_title: "Playground reconstruction",
    agency_name: "Department of Parks and Recreation",
    type_of_notice_description: "Solicitation",
    start_date: "2026-07-02",
    release_date: "2026-07-01",
    due_date: "2026-08-05",
  };
  const atom = buildProcurementAlertAtom(row);
  assert.equal(atom.opportunity_window.kind, OPPORTUNITY_WINDOW_KIND.RESPONSE_WINDOW);
  assert.equal(atom.opportunity_window.days, 35);
  assert.equal(atom.opportunity_window.source_system, "passport_public_rfx");
});

test("opportunity_window fails closed (never a fabricated 0-day span) when boundary dates are missing", () => {
  const atom = buildProcurementAlertAtom({ request_id: "sparse-1", short_title: "Sparse", agency_name: "MTA" });
  assert.equal(atom.opportunity_window.available, false);
  assert.equal(atom.opportunity_window.days, null);
  assert.equal(atom.opportunity_window.label, "Window unavailable");
});

test("an explicit opportunity_window (already computed from the full object/observations record) is never re-derived", () => {
  const precomputed = { schema: "cityscroll.procurement_opportunity_window.v1", available: true, days: 999 };
  const atom = buildProcurementAlertAtom(
    { request_id: "x", short_title: "X", agency_name: "Finance", start_date: "2026-07-02", due_date: "2026-08-05" },
    { opportunity_window: precomputed },
  );
  assert.equal(atom.opportunity_window, precomputed);
});
