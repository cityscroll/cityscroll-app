import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NYC_RULES_PETITION_SOURCES,
  buildPetitionHandoff,
  renderPetitionHandoff,
} from "../site/rules_petition.mjs";
import { buildRulemakingObjects } from "../worker/src/lib/rulemaking.mjs";
import { renderRulemakingDocument } from "../site/rulemaking_document.mjs";
import { buildAgencyConstellationView } from "../site/agency_constellation_model.mjs";
import { renderAgencyConstellationDocument } from "../site/agency_constellation.mjs";

const RESOLUTION = {
  matched: true,
  canonical_id: "transportation",
  canonical_name: "Transportation",
  source_system: "nyc_rules",
  source_url: NYC_RULES_PETITION_SOURCES.page_url,
};

test("petition workflow keeps official purpose, response, and outcomes source-qualified", () => {
  const handoff = buildPetitionHandoff({ agency_resolution: RESOLUTION });
  assert.equal(handoff.state, "ready");
  assert.equal(handoff.agency.ref, "agency:id:transportation");
  assert.deepEqual(handoff.purpose, [
    "Propose a new rule",
    "Amend an existing rule",
    "Repeal an existing rule",
  ]);
  assert.equal(handoff.response.days, 60);
  assert.equal(handoff.response.basis, "source_stated");
  assert.equal(handoff.response.source_url, NYC_RULES_PETITION_SOURCES.page_url);
  assert.deepEqual(handoff.official.indexed_sources.map((source) => source.role), [
    "petition_procedure", "petition_guidance", "petition_form", "agency_contact_lookup",
  ]);
  assert.equal(handoff.procedure_source.basis, "source_stated");
  assert.equal(handoff.outcomes_source.source_url, NYC_RULES_PETITION_SOURCES.page_url);
  assert.deepEqual(handoff.outcomes.map((outcome) => outcome.id), ["decline", "proceed"]);
  assert.deepEqual(handoff.submission, { cityscroll_submits: false, tracks_submission: false });
});

test("unresolved agency identity never becomes a named petition destination", () => {
  const handoff = buildPetitionHandoff();
  assert.equal(handoff.state, "agency_unknown");
  assert.equal(handoff.agency, null);
  assert.equal(handoff.contact_state, "lookup_fallback");
  const html = renderPetitionHandoff(handoff);
  assert.match(html, /official agency-contact lookup/);
  assert.doesNotMatch(html, /mailto:/);
});

test("unresolved contacts use the official lookup, while source-backed contacts remain explicit", () => {
  const fallback = buildPetitionHandoff({ agency_resolution: RESOLUTION, contact: { email: "not-verified@example.com" } });
  assert.equal(fallback.contact, null);
  assert.equal(fallback.contact_state, "lookup_fallback");
  const resolved = buildPetitionHandoff({
    agency_resolution: RESOLUTION,
    contact: {
      email: "rules@example.gov",
      address: "1 Civic Center",
      source_url: NYC_RULES_PETITION_SOURCES.contact_lookup_url,
    },
  });
  assert.equal(resolved.contact_state, "resolved");
  assert.equal(resolved.contact.email, "rules@example.gov");
  assert.equal(resolved.contact.address, "1 Civic Center");
});

test("petition guidance distinguishes rulemaking petitions from comments and stays action-only", () => {
  const html = renderPetitionHandoff(buildPetitionHandoff({ agency_resolution: RESOLUTION }), { mode: "rule" });
  assert.match(html, /How to petition Transportation/);
  assert.match(html, /different from commenting on an already-proposed rule/);
  assert.match(html, /official petition form/);
  assert.match(html, /official guidance/);
  assert.match(html, /within 60 days/);
  assert.match(html, /declines and gives its reason/);
  assert.match(html, /proceeds and initiates CAPA rulemaking/);
  assert.match(html, /does not submit or track petitions/);
  assert.match(html, /Drafting prompts/);
  assert.match(html, /does not save, submit, or track a petition draft/);
  assert.doesNotMatch(html, /<form\b|type="submit"/i);
});

test("effective rulemaking exposes an agency-specific petition handoff", () => {
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
        agency_name: "DOT",
        adoption_published_at: "2026-07-14",
        effective_date: "2026-08-13",
      },
      events: [
        { event_type: "adoption", valid_at: "2026-07-14", status: "occurred" },
        { event_type: "effective", valid_at: "2026-08-13", status: "occurred" },
      ],
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
  const object = buildRulemakingObjects(rows, { now: "2026-08-27" })[0];
  assert.equal(object.petition_handoff.agency.name, "Transportation");
  assert.equal(object.interaction.lifecycle_state, "effective");
  assert.equal(object.interaction.kinetic_actions.at(-1).kind, "petition");
  const html = renderRulemakingDocument(object);
  assert.match(html, /How to petition Transportation/);
  assert.match(html, /NYC Rules requirement/);
});

test("rulemaking does not promote a City Record-only agency label into NYC Rules identity", () => {
  const subject = "rulemaking:unresolved:fixture";
  const rows = [
    {
      request_id: "20260317027",
      agency: "An Unresolved Agency",
      title: "A rulemaking with no NYC Rules agency resolution",
      notice_date: "2026-03-25",
      stage: "effective",
      rulemaking_subject_ref: subject,
      rulemaking_join: { matched: true, confidence: "high", notice_count: 2 },
      nyc_rules: {
        url: "https://rules.cityofnewyork.us/rule/unresolved-fixture/",
        adoption_published_at: "2026-07-14",
        effective_date: "2026-08-13",
      },
    },
    {
      request_id: "20260706042",
      agency: "An Unresolved Agency",
      title: "Notice of Adoption: unresolved fixture",
      notice_date: "2026-07-14",
      stage: "effective",
      rulemaking_subject_ref: subject,
      rulemaking_join: { matched: true, confidence: "high", notice_count: 2 },
    },
  ];
  const object = buildRulemakingObjects(rows, { now: "2026-08-27" })[0];
  assert.equal(object.petition_handoff.state, "agency_unknown");
  assert.equal(object.petition_handoff.agency, null);
  assert.equal(object.interaction.kinetic_actions.at(-1).label, "Petition agency to amend or repeal");
  assert.match(renderRulemakingDocument(object), /could not resolve the responsible agency/);
  assert.match(renderRulemakingDocument(object), /official agency-contact lookup/);
});

test("resolved agency page exposes the petition entry point and complete official handoff", () => {
  const view = buildAgencyConstellationView("DOT", {});
  assert.equal(view.petition_handoff.state, "ready");
  assert.equal(view.petition_handoff.agency.name, "Transportation");
  const html = renderAgencyConstellationDocument(view);
  assert.match(html, /Petition this agency/);
  assert.match(html, /agency-petition/);
  assert.match(html, /official petition form/);
  assert.match(html, /official guidance/);
});
