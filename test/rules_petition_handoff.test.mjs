import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NYC_RULES_PETITION_SOURCES,
  buildPetitionHandoff,
  classifyPetitionActionTarget,
  measurePetitionCoverage,
  renderPetitionHandoff,
} from "../site/rules_petition.mjs";
import institutionPetitionProcedures from "../site/data/institution_petition_procedures.json" with { type: "json" };
import { buildRulemakingObjects } from "../worker/src/lib/rulemaking.mjs";
import { renderRulemakingDocument } from "../site/rulemaking_document.mjs";
import { buildAgencyConstellationView } from "../site/agency_constellation_model.mjs";
import { renderAgencyConstellationDocument } from "../site/agency_constellation.mjs";
import { rulesCardInteractionProjection } from "../site/rules_card_interaction.mjs";
import { publisherAgencyRows } from "../tools/lib/agency_publisher_crosswalk.mjs";
import agencyCrosswalk from "../worker/src/data/agency_crosswalk.json" with { type: "json" };

const RESOLUTION = {
  matched: true,
  canonical_id: "transportation",
  canonical_name: "Transportation",
  source_system: "nyc_rules",
  source_url: NYC_RULES_PETITION_SOURCES.page_url,
};

const SBS_RESOLUTION = {
  matched: true,
  canonical_id: "small-business-services",
  canonical_name: "Department of Small Business Services",
  source_system: "nyc_rules",
  source_url: NYC_RULES_PETITION_SOURCES.page_url,
};

const SBS_PROCEDURE = institutionPetitionProcedures.by_agency["small-business-services"];

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
  assert.equal(handoff.action_target, "action_only_guidance");
  assert.equal(handoff.procedure_basis, "general_official_guidance");
  assert.equal(handoff.institution_procedure, null);
  assert.equal(handoff.response.scope, "general_official_guidance");
  assert.equal(handoff.official.workflow_availability.form_vintage, "2025-06");
  assert.equal(handoff.official.workflow_availability.guidance_vintage, "2026-02");
  assert.equal(handoff.official.workflow_availability.procedure_page_vintage, null);
  assert.equal(handoff.coverage.workflow_missing_is_not_unavailable, true);
  assert.equal(handoff.coverage.unsupported_dates, "unknown");
});

test("unresolved agency identity never becomes a named petition destination", () => {
  const handoff = buildPetitionHandoff();
  assert.equal(handoff.state, "agency_unknown");
  assert.equal(handoff.agency, null);
  assert.equal(handoff.contact_state, "lookup_fallback");
  const html = renderPetitionHandoff(handoff);
  assert.match(html, /official agency-contact lookup/);
  assert.doesNotMatch(html, /mailto:/);
  assert.equal(handoff.action_target, "action_only_guidance");
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
  assert.match(html, /How to petition an agency about this rule/);
  assert.match(html, /different from commenting on an already-proposed rule/);
  assert.match(html, /different again from speaking at a public hearing/);
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
  assert.match(html, /How to petition an agency about this rule/);
  assert.match(html, /NYC Rules requirement/);
  assert.equal(object.petition_handoff.action_target, "action_only_guidance");
  assert.equal(object.interaction.kinetic_actions.at(-1).label, "Petition agency to amend or repeal");
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
  // Resolved identity keeps the official handoff available, but the destination
  // is the City's general guidance until this body's own procedure is indexed.
  assert.equal(view.petition_handoff.action_target, "action_only_guidance");
  assert.match(html, /How to petition a city agency/);
  assert.match(html, /agency-petition/);
  assert.match(html, /official petition form/);
  assert.match(html, /official guidance/);
  assert.doesNotMatch(html, /Petition this agency/);
});

test("generic rulemaking clocks never invent the 60-day petition expectation", () => {
  const handoff = buildPetitionHandoff({
    agency_resolution: RESOLUTION,
    sources: { page_url: null, response_source_url: null, form_url: null, guidance_url: null },
    rulemaking_clock_days: 60,
    generic_clock_days: 60,
    emergency_clock_days: 60,
  });
  assert.equal(handoff.response.days, null);
  assert.equal(handoff.response.basis, "unknown");
  assert.equal(handoff.action_target, "target_unknown");
  assert.equal(handoff.official.workflow_availability.form, "missing");
  assert.equal(handoff.coverage.official_form, "missing");
  assert.equal(handoff.coverage.workflow_missing_is_not_unavailable, true);
  const html = renderPetitionHandoff(handoff);
  assert.doesNotMatch(html, /within 60 days/);
  assert.match(html, /not stated in the indexed official sources/);
});

test("proposed rulemaking is not a petition workflow even when official form URLs exist", () => {
  assert.equal(classifyPetitionActionTarget({
    agency: { name: "Small Business Services" },
    procedure_evidence: SBS_PROCEDURE,
    form_url: NYC_RULES_PETITION_SOURCES.form_url,
    entry_point: "effective_rule",
    lifecycle_state: "comment_hearing_open",
  }), "no_supported_workflow");
  const proposed = buildPetitionHandoff({
    agency_resolution: RESOLUTION,
    entry_point: "effective_rule",
    lifecycle_state: "proposed",
  });
  assert.equal(proposed.action_target, "no_supported_workflow");
  assert.equal(renderPetitionHandoff(proposed, { mode: "rule" }), "");
});

test("contact coverage keeps resolved, unresolved, and lookup fallbacks separate", () => {
  const resolved = buildPetitionHandoff({
    agency_resolution: RESOLUTION,
    contact: {
      email: "rules@example.gov",
      source_url: NYC_RULES_PETITION_SOURCES.contact_lookup_url,
    },
  });
  const fallback = buildPetitionHandoff({ agency_resolution: RESOLUTION });
  const unresolved = buildPetitionHandoff({
    agency_resolution: RESOLUTION,
    sources: { contact_lookup_url: null },
  });
  assert.equal(resolved.contact_state, "resolved");
  assert.equal(fallback.contact_state, "lookup_fallback");
  assert.equal(unresolved.contact_state, "unresolved");
  const coverage = measurePetitionCoverage([resolved, fallback, unresolved]);
  assert.deepEqual(coverage.contacts, { resolved: 1, unresolved: 1, lookup_fallback: 1 });
  assert.equal(coverage.action_targets.exact_petition_target, 0);
  assert.equal(coverage.action_targets.action_only_guidance, 3);
  assert.deepEqual(coverage.procedure_basis, {
    institution_procedure: 0,
    general_official_guidance: 3,
    unknown: 0,
  });
});

test("a published institution procedure grounds an exact petition target end to end", () => {
  const handoff = buildPetitionHandoff({
    agency_resolution: SBS_RESOLUTION,
    procedure_evidence: SBS_PROCEDURE,
    entry_point: "agency",
  });
  assert.equal(handoff.action_target, "exact_petition_target");
  assert.equal(handoff.procedure_basis, "institution_procedure");
  assert.equal(
    handoff.official.receiving_body,
    "Office of the General Counsel, NYC Department of Small Business Services",
  );
  const procedureUrl = "https://rules.cityofnewyork.us/rule/petitions-for-agency-rulemaking/";
  assert.equal(handoff.official.institution_procedure_url, procedureUrl);
  // Receiving body, destination and response explanation all cite the same
  // published procedure rather than the City-wide petition page.
  assert.equal(handoff.response.scope, "institution_procedure");
  assert.equal(handoff.response.source_url, procedureUrl);
  assert.equal(handoff.response.days, 60);
  assert.match(handoff.response.statement, /deny it in writing with its reasons/);
  assert.equal(handoff.procedure_source.source_url, procedureUrl);
  assert.equal(handoff.institution_procedure.legal_basis, "NYC Charter § 1043(g); 66 RCNY ch. 20");
  assert.equal(handoff.institution_procedure.effective_date, "2026-07-09");
  assert.equal(handoff.official.indexed_sources[0].role, "institution_petition_procedure");
  assert.deepEqual(handoff.submission, { cityscroll_submits: false, tracks_submission: false });

  const html = renderPetitionHandoff(handoff);
  assert.match(html, /Petition this agency/);
  assert.match(html, /Where this petition goes:/);
  assert.match(html, /Office of the General Counsel, NYC Department of Small Business Services/);
  assert.match(html, new RegExp(`href="${procedureUrl}"`));
  assert.match(html, /Read the published petition procedure/);
  assert.match(html, /agency&#39;s published response requirement/);
  assert.doesNotMatch(html, /<form\b|type="submit"/i);
  assert.match(html, /does not submit or track petitions/);
});

test("the SBS profile journey reaches its exact target while the NYCEDC profile stays general", () => {
  const rows = publisherAgencyRows(agencyCrosswalk);
  const sbs = buildAgencyConstellationView("small-business-services", { publisher_agency_rows: rows });
  const edc = buildAgencyConstellationView("economic-development-corporation", { publisher_agency_rows: rows });

  assert.equal(sbs.petition_handoff.action_target, "exact_petition_target");
  const sbsHtml = renderAgencyConstellationDocument(sbs);
  assert.match(sbsHtml, /Petition this agency/);
  assert.match(sbsHtml, /Office of the General Counsel/);
  assert.match(sbsHtml, /data-action-target="exact_petition_target"/);

  // Both bodies resolve to a canonical identity and both see the same generic
  // City form. Only the one with a published procedure gets an exact target.
  assert.equal(edc.petition_handoff.state, "ready");
  assert.equal(edc.petition_handoff.agency.name, "Economic Development Corporation");
  assert.equal(edc.petition_handoff.official.form_url, sbs.petition_handoff.official.form_url);
  assert.equal(edc.petition_handoff.action_target, "action_only_guidance");
  assert.equal(edc.petition_handoff.official.receiving_body, null);
  const edcHtml = renderAgencyConstellationDocument(edc);
  assert.doesNotMatch(edcHtml, /Petition this agency/);
  assert.match(edcHtml, /How to petition a city agency/);
  assert.match(edcHtml, /general rulemaking-petition guidance/);
  // General guidance stays useful and reachable.
  assert.match(edcHtml, /official petition form/);
  assert.match(edcHtml, /official guidance/);
});

test("absent procedure evidence is missing evidence, not a legal prohibition", () => {
  const edc = buildAgencyConstellationView("economic-development-corporation", {
    publisher_agency_rows: publisherAgencyRows(agencyCrosswalk),
  });
  const html = renderAgencyConstellationDocument(edc);
  assert.match(html, /has not indexed a published petition procedure/);
  assert.match(html, /not a finding that you cannot petition this body/);
  for (const forbidden of [/cannot petition/i, /not eligible/i, /prohibit/i, /forbidden/i, /may not petition/i]) {
    assert.doesNotMatch(html.replace(/not a finding that you cannot petition this body/g, ""), forbidden);
  }
  assert.equal(edc.petition_handoff.coverage.missing_procedure_evidence_is_not_prohibition, true);
  assert.equal(edc.petition_handoff.coverage.institution_procedure_evidence, "absent");
});

test("one institution's petition procedure never grounds a target on another", () => {
  // The SBS procedure offered against an NYCEDC resolution must not transfer.
  const transferred = buildPetitionHandoff({
    agency_resolution: {
      matched: true,
      canonical_id: "economic-development-corporation",
      canonical_name: "Economic Development Corporation",
      source_system: "nyc_rules",
      source_url: NYC_RULES_PETITION_SOURCES.page_url,
    },
    procedure_evidence: SBS_PROCEDURE,
    entry_point: "agency",
  });
  assert.equal(transferred.institution_procedure, null);
  assert.equal(transferred.action_target, "action_only_guidance");
  assert.equal(transferred.official.receiving_body, null);

  // Nor does evidence scoped to a different procedure.
  const wrongProcedure = buildPetitionHandoff({
    agency_resolution: SBS_RESOLUTION,
    procedure_evidence: { ...SBS_PROCEDURE, applies_to: "public_comment" },
    entry_point: "agency",
  });
  assert.equal(wrongProcedure.action_target, "action_only_guidance");

  // Nor evidence with no receiving body or no published procedure URL.
  for (const broken of [{ receiving_body: "" }, { procedure_url: "https://edc.nyc/petitions" }]) {
    const handoff = buildPetitionHandoff({
      agency_resolution: SBS_RESOLUTION,
      procedure_evidence: { ...SBS_PROCEDURE, ...broken },
      entry_point: "agency",
    });
    assert.equal(handoff.action_target, "action_only_guidance");
  }
});

test("a failed contact enrichment leaves the verified procedure link usable", () => {
  // Enrichment can fail two ways: it returns nothing, or it returns something
  // no official source backs. Neither may cost the reader the destination the
  // published procedure already gives them.
  const unbacked = buildPetitionHandoff({
    agency_resolution: SBS_RESOLUTION,
    procedure_evidence: SBS_PROCEDURE,
    contact: { address: "an address no official source backs" },
    sources: { contact_lookup_url: null },
    entry_point: "agency",
  });
  const offHost = buildPetitionHandoff({
    agency_resolution: SBS_RESOLUTION,
    procedure_evidence: SBS_PROCEDURE,
    contact: { address: "1 Civic Center", source_url: "https://not-an-official-host.invalid/contacts" },
    sources: { contact_lookup_url: null },
    entry_point: "agency",
  });
  for (const handoff of [unbacked, offHost]) {
    assert.equal(handoff.contact, null);
    assert.equal(handoff.contact_state, "unresolved");
    assert.equal(handoff.action_target, "exact_petition_target");
    const html = renderPetitionHandoff(handoff);
    assert.doesNotMatch(html, /mailto:/);
    assert.doesNotMatch(html, /1 Civic Center|no official source backs/);
    assert.match(html, /An official submission contact is not resolved here/);
    assert.match(html, /The published procedure above still tells you where to send the petition/);
    assert.match(html, new RegExp(`href="${SBS_PROCEDURE.procedure_url}"`));
  }
});

test("petition, comment, hearing and testimony stay separate lifecycle actions", () => {
  const open = rulesCardInteractionProjection({
    rulemaking_id: "rulemaking:sbs:lifecycle",
    title: "A proposed rule",
    fine_stage: "comment-open",
    comment_by_date: "2026-10-01",
    hearing_date: "2026-09-25",
    comment_url: "https://rules.cityofnewyork.us/rule/lifecycle-fixture/#comments",
    hearing_url: "https://rules.cityofnewyork.us/rule/lifecycle-fixture/#hearing",
    testimony_url: "https://rules.cityofnewyork.us/rule/lifecycle-fixture/#testimony",
    official_source_url: "https://rules.cityofnewyork.us/rule/lifecycle-fixture/",
    petition_handoff: buildPetitionHandoff({
      agency_resolution: SBS_RESOLUTION,
      procedure_evidence: SBS_PROCEDURE,
      entry_point: "effective_rule",
      lifecycle_state: "comment_hearing_open",
    }),
    now: "2026-09-10",
  });
  const openKinds = open.kinetic_actions.map((action) => action.kind);
  assert.ok(openKinds.includes("comment"));
  assert.ok(openKinds.includes("attend"));
  assert.ok(openKinds.includes("testify"));
  // An open comment period is not a petition surface, even for a body whose own
  // petition procedure is fully evidenced.
  assert.ok(!openKinds.includes("petition"));

  const effective = rulesCardInteractionProjection({
    rulemaking_id: "rulemaking:sbs:lifecycle",
    title: "An effective rule",
    fine_stage: "effective",
    effective_date: "2026-07-09",
    final_rule_url: "https://rules.cityofnewyork.us/rule/lifecycle-fixture/",
    official_source_url: "https://rules.cityofnewyork.us/rule/lifecycle-fixture/",
    petition_handoff: buildPetitionHandoff({
      agency_resolution: SBS_RESOLUTION,
      procedure_evidence: SBS_PROCEDURE,
      entry_point: "effective_rule",
      lifecycle_state: "effective",
    }),
    now: "2026-09-10",
  });
  const petition = effective.kinetic_actions.find((action) => action.kind === "petition");
  assert.ok(petition);
  assert.equal(petition.label, "How to petition Department of Small Business Services");
  assert.equal(petition.href, SBS_PROCEDURE.procedure_url);
  const effectiveKinds = effective.kinetic_actions.map((action) => action.kind);
  assert.ok(!effectiveKinds.includes("comment"));
  assert.ok(!effectiveKinds.includes("attend"));
});

test("coverage separates grounded institution procedures from general guidance", () => {
  const grounded = buildPetitionHandoff({
    agency_resolution: SBS_RESOLUTION,
    procedure_evidence: SBS_PROCEDURE,
    entry_point: "agency",
  });
  const general = buildPetitionHandoff({ agency_resolution: RESOLUTION, entry_point: "agency" });
  const coverage = measurePetitionCoverage([grounded, general]);
  assert.equal(coverage.action_targets.exact_petition_target, 1);
  assert.equal(coverage.action_targets.action_only_guidance, 1);
  assert.deepEqual(coverage.procedure_basis, {
    institution_procedure: 1,
    general_official_guidance: 1,
    unknown: 0,
  });
  assert.equal(coverage.institution_procedure_evidence.applicable, 1);
  assert.equal(coverage.institution_procedure_evidence.absent, 1);
  assert.equal(coverage.institution_procedure_evidence.missing_procedure_evidence_is_not_prohibition, true);
  assert.deepEqual(coverage.auto_submission, { cityscroll_submits: 0, tracks_submission: 0 });
});
