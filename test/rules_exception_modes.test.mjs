import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import gold from "./fixtures/rules_exception_modes/gold.v1.json" with { type: "json" };
import coverageReceipt from "../docs/evidence/rules-exception-modes/coverage.json" with { type: "json" };
import {
  EXCEPTION_MODE_IDS,
  RULES_EXCEPTION_MODES_SCHEMA,
  buildRulesExceptionModesProjection,
  measureExceptionModeCoverage,
  renderRulesExceptionModes,
} from "../site/rules_exception_modes.mjs";
import { RULE_EVENT_TYPES, RULES_PHASES } from "../site/rules_phase_spine.mjs";
import { buildRulemakingObjects } from "../worker/src/lib/rulemaking.mjs";
import { renderRulemakingDocument } from "../site/rulemaking_document.mjs";
import { detectNodePageCruft } from "../site/civic_document_chrome.mjs";

function byId(id) {
  return gold.cases.find((item) => item.id === id);
}

function projectionFor(id) {
  return buildRulesExceptionModesProjection(byId(id));
}

function stateOf(projection, mode) {
  return projection.assertions.find((item) => item.mode === mode)?.state;
}

test("gold pack covers the required exception-mode fixtures", () => {
  assert.deepEqual(gold.cases.map((item) => item.id), [
    "confirmed-emergency",
    "immediate-effectiveness",
    "expiry",
    "qualifying-extension",
    "ordinary-plus-exception-branch",
    "explicit-unanticipated",
    "absent-unanticipated",
    "hearing-waived",
    "public-purpose",
    "conflicting-dates",
    "weak-missing-passage",
    "unsupported-candidate",
  ]);
});

test("emergency fixtures keep finding, immediate effect, expiration, and extension as separate facts", () => {
  const confirmed = projectionFor("confirmed-emergency");
  assert.equal(confirmed.procedure_mode, "emergency");
  assert.equal(stateOf(confirmed, "emergency_finding"), "established");
  assert.equal(stateOf(confirmed, "emergency_effective_date"), "established");
  assert.equal(stateOf(confirmed, "emergency_expiration"), "established");
  assert.equal(confirmed.assertions.find((item) => item.mode === "emergency_effective_date").date.value, "2026-05-03");
  assert.equal(confirmed.assertions.find((item) => item.mode === "emergency_expiration").date.value, "2026-07-02");
  assert.equal(stateOf(confirmed, "emergency_extension"), "unknown");
  assert.equal(confirmed.invariants.missing_extension_is_not_expiration, true);

  const immediate = projectionFor("immediate-effectiveness");
  assert.equal(stateOf(immediate, "emergency_effective_date"), "established");
  assert.equal(immediate.assertions.find((item) => item.mode === "emergency_effective_date").date.precision, "immediate");
  assert.equal(stateOf(immediate, "emergency_expiration"), "unknown");
  assert.equal(immediate.invariants.unknown_is_not_expired, true);

  const expiry = projectionFor("expiry");
  assert.equal(stateOf(expiry, "emergency_expiration"), "established");
  assert.equal(expiry.assertions.find((item) => item.mode === "emergency_expiration").date.value, "2026-07-02");

  const extension = projectionFor("qualifying-extension");
  assert.equal(stateOf(extension, "emergency_extension"), "established");
  assert.equal(extension.assertions.find((item) => item.mode === "emergency_extension").date.value, "2026-09-01");
});

test("ordinary-plus-exception keeps the four-phase spine and five event types", () => {
  const projection = projectionFor("ordinary-plus-exception-branch");
  assert.equal(projection.procedure_mode, "emergency");
  assert.deepEqual(projection.ordinary_phases, [...RULES_PHASES]);
  assert.deepEqual(projection.ordinary_event_types, [...RULE_EVENT_TYPES]);
  assert.deepEqual(projection.fabricated_phases, []);
  assert.deepEqual(projection.fabricated_events, []);
  assert.deepEqual(projection.ordinary_events.map((event) => event.event_type), ["proposal_published", "comment_close"]);
  assert.ok(!projection.ordinary_event_types.includes("emergency"));
  assert.ok(!projection.ordinary_phases.includes("emergency"));
});

test("unanticipated, hearing-waived, and public-purpose claims require an explicit source passage", () => {
  const explicit = projectionFor("explicit-unanticipated");
  assert.equal(stateOf(explicit, "unanticipated_in_agenda"), "established");
  assert.match(explicit.assertions.find((item) => item.mode === "unanticipated_in_agenda").source.passage, /not anticipated in the agency's regulatory agenda/i);

  const absent = projectionFor("absent-unanticipated");
  assert.equal(stateOf(absent, "unanticipated_in_agenda"), "absent");
  assert.equal(absent.invariants.absent_is_not_unanticipated, true);
  assert.equal(absent.procedure_mode, "standard");

  const waived = projectionFor("hearing-waived");
  assert.equal(stateOf(waived, "hearing_waived"), "established");
  assert.equal(stateOf(waived, "public_purpose"), "established");

  const purpose = projectionFor("public-purpose");
  assert.equal(stateOf(purpose, "public_purpose"), "established");
  assert.equal(stateOf(purpose, "hearing_waived"), "absent");

  const unsupported = projectionFor("unsupported-candidate");
  assert.equal(stateOf(unsupported, "hearing_waived"), "absent");
  assert.equal(stateOf(unsupported, "public_purpose"), "absent");
  assert.equal(stateOf(unsupported, "unanticipated_in_agenda"), "absent");
});

test("conflicting dates, weak passages, and unsupported candidates stay unresolved", () => {
  const conflict = projectionFor("conflicting-dates");
  assert.equal(stateOf(conflict, "emergency_expiration"), "conflict");
  assert.deepEqual(conflict.assertions.find((item) => item.mode === "emergency_expiration").date.values, [
    "2026-07-02",
    "2026-08-01",
  ]);

  const weak = projectionFor("weak-missing-passage");
  assert.equal(stateOf(weak, "emergency_finding"), "unsupported");
  assert.equal(weak.procedure_mode, "standard");
  assert.equal(stateOf(weak, "emergency_expiration"), "absent");
});

test("projection is deterministic and never invents lifecycle dots", () => {
  const first = projectionFor("ordinary-plus-exception-branch");
  const second = projectionFor("ordinary-plus-exception-branch");
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(first.schema, RULES_EXCEPTION_MODES_SCHEMA);
  for (const projection of gold.cases.map((item) => buildRulesExceptionModesProjection(item))) {
    assert.deepEqual(projection.ordinary_phases, ["proposal", "public_process", "adoption", "effective"]);
    assert.deepEqual(projection.ordinary_event_types, [
      "proposal_published",
      "public_hearing",
      "comment_close",
      "adoption",
      "effective",
    ]);
    assert.equal(projection.fabricated_events.length, 0);
    assert.equal(projection.assertions.length, EXCEPTION_MODE_IDS.length);
  }
});

test("exception receipts report per-mode coverage independently and omit a blended rate", () => {
  const measured = measureExceptionModeCoverage(gold.cases);
  assert.equal(measured.blended_exception_rate, null);
  assert.deepEqual(Object.keys(measured.per_mode), [...EXCEPTION_MODE_IDS]);
  assert.equal(measured.per_mode.emergency_finding.established, 6);
  assert.equal(measured.per_mode.emergency_finding.unsupported, 1);
  assert.equal(measured.per_mode.emergency_effective_date.established, 3);
  assert.equal(measured.per_mode.emergency_expiration.established, 3);
  assert.equal(measured.per_mode.emergency_expiration.conflict, 1);
  assert.equal(measured.per_mode.emergency_expiration.unknown, 2);
  assert.equal(measured.per_mode.emergency_extension.established, 1);
  assert.equal(measured.per_mode.unanticipated_in_agenda.established, 1);
  assert.equal(measured.per_mode.unanticipated_in_agenda.absent, 11);
  assert.equal(measured.per_mode.hearing_waived.established, 1);
  assert.equal(measured.per_mode.public_purpose.established, 2);
  assert.equal(measured.procedure_projection.emergency_branches, 6);
  assert.equal(measured.procedure_projection.unsupported_exception_candidates, 1);
  assert.equal(measured.procedure_projection.ordinary_spine, 7);
  assert.equal(measured.date_evidence.unknown_is_not_expired, true);
  assert.equal(measured.date_evidence.absent_is_not_unanticipated, true);
  assert.deepEqual(measured.per_mode, coverageReceipt.per_mode);
  assert.deepEqual(measured.procedure_projection, coverageReceipt.procedure_projection);
  assert.equal(Object.hasOwn(measured, "exception_rate"), false);
});

test("resident labels stay source-backed and omit unsupported or absent claims", () => {
  const html = renderRulesExceptionModes(projectionFor("ordinary-plus-exception-branch"));
  assert.match(html, /Emergency procedure/);
  assert.match(html, /Effective immediately: May 3, 2026/);
  assert.match(html, /Temporary authority ends/);
  assert.match(html, /Ordinary rulemaking/);
  assert.match(html, /Proposal published · May 28, 2026/);
  assert.match(html, /data-procedure-mode="emergency"/);
  const visible = html.replace(/<[^>]+>/g, " ");
  assert.doesNotMatch(visible, /unanticipated/);
  assert.doesNotMatch(visible, /hearing_waived|emergency_finding|public_purpose/);

  const absentHtml = renderRulesExceptionModes(projectionFor("absent-unanticipated"));
  assert.equal(absentHtml, "");

  const conflictHtml = renderRulesExceptionModes(projectionFor("conflicting-dates"));
  assert.match(conflictHtml, /more than one date/);
  assert.doesNotMatch(conflictHtml, /expired/);

  const unknownHtml = renderRulesExceptionModes(projectionFor("immediate-effectiveness"));
  assert.match(unknownHtml, /does not state when this emergency authority ends/);
  assert.doesNotMatch(unknownHtml, /expired/);
});

test("rulemaking case files attach exception modes without rewriting ordinary events", () => {
  const subject = "rulemaking:dohmh:emergency-lead";
  const rows = [
    {
      request_id: "20260503010",
      agency: "Health",
      title: "Emergency Rule Relating to Lead Paint",
      notice_date: "2026-05-03",
      stage: "effective",
      rulemaking_subject_ref: subject,
      rulemaking_join: { matched: true, confidence: "high", notice_count: 2 },
      nyc_rules: {
        url: "https://rules.cityofnewyork.us/rule/emergency-lead/",
        title: "Emergency Rule Relating to Lead Paint",
        agency_name: "DOHMH",
        effective_date: "2026-05-03",
      },
      events: [
        { event_type: "proposal_published", valid_at: "2026-05-28", status: "occurred" },
        { event_type: "comment_close", valid_at: "2026-06-30", status: "scheduled" },
      ],
      exception_source_documents: byId("confirmed-emergency").documents,
    },
    {
      request_id: "20260528011",
      agency: "Health",
      title: "Proposed Rule Relating to Lead Paint",
      notice_date: "2026-05-28",
      stage: "proposed",
      rulemaking_subject_ref: subject,
      rulemaking_join: { matched: true, confidence: "high", notice_count: 2 },
    },
  ];
  const [object] = buildRulemakingObjects(rows, { now: "2026-06-01" });
  assert.equal(object.exception_modes.procedure_mode, "emergency");
  assert.equal(object.procedure_mode, "emergency");
  assert.deepEqual(object.phases.map((phase) => phase.id), [...RULES_PHASES]);
  assert.ok(object.events.every((event) => RULE_EVENT_TYPES.includes(event.event_type)));
  assert.ok(!object.events.some((event) => event.event_type === "emergency"));
  const html = renderRulemakingDocument(object, { now: "2026-06-01" });
  assert.match(html, /Emergency procedure/);
  assert.match(html, /Effective immediately: May 3, 2026/);
  assert.match(html, /Ordinary rulemaking/);
  assert.doesNotMatch(html, /data-event-type="emergency"/);
  assert.deepEqual(detectNodePageCruft(html), []);
});

test("ordinary DOT bicycle-racks case file does not invent an exception mode", () => {
  const subject = "rulemaking:dot:bicycle-racks";
  const rows = [
    {
      request_id: "20260317026",
      agency: "DOT",
      title: "DOT Proposed Rules Relating to City-Owned Bicycle Racks",
      notice_date: "2026-03-25",
      stage: "proposed",
      rulemaking_subject_ref: subject,
      rulemaking_join: { matched: true, confidence: "high", notice_count: 2 },
      nyc_rules: {
        url: "https://rules.cityofnewyork.us/rule/city-owned-bicycle-racks/",
        title: "City-Owned Bicycle Racks",
        agency_name: "DOT",
        effective_date: "2026-08-13",
      },
      events: [
        { event_type: "adoption", valid_at: "2026-07-14", status: "occurred" },
        { event_type: "effective", valid_at: "2026-08-13", status: "occurred" },
      ],
      exception_source_documents: byId("absent-unanticipated").documents,
    },
    {
      request_id: "20260706041",
      agency: "DOT",
      title: "Notice of Adoption: City-Owned Bicycle Racks",
      notice_date: "2026-07-14",
      stage: "effective",
      rulemaking_subject_ref: subject,
      rulemaking_join: { matched: true, confidence: "high", notice_count: 2 },
    },
  ];
  const [object] = buildRulemakingObjects(rows, { now: "2026-08-27" });
  assert.equal(object.exception_modes.procedure_mode, "standard");
  assert.equal(stateOf(object.exception_modes, "unanticipated_in_agenda"), "absent");
  const html = renderRulemakingDocument(object, { now: "2026-08-27" });
  assert.doesNotMatch(html, /Emergency procedure|Not anticipated in the regulatory agenda|Hearing waived/);
  assert.match(html, /In effect since August 13, 2026/);
});
