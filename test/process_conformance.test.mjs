import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  CONFORMANCE_HONESTY,
  OBSERVATION_STATUS,
  PROCESS_CONFORMANCE_METHOD,
  PROCESS_CONFORMANCE_SCHEMA,
  MANDATE_RULE_EDGE_TYPE,
  MANDATE_CONFORMANCE_STYLE,
  agencyMandatesConformancePath,
  buildAgencyConformanceView,
  buildProcessConformanceLookup,
  contentTokens,
  evaluateRuleEvidence,
  renderMandatesConformanceSection,
  normalizeObservationCandidate,
  resolveMandateObservation,
  scoreMandateRuleEvidence,
  scoreTopicMatch,
} from "../site/process_conformance.mjs";
import {
  OBSERVATION_STATE,
  buildMandateCategoryConformance,
  mergeMandateCategoryConformance,
} from "../site/mandate_category_conformance.mjs";
import {
  buildAgencyConstellationView,
  renderAgencyConstellationDocument,
} from "../site/agency_constellation.mjs";
import { relatedCivicEdgesForMandate } from "../site/mandate_document.mjs";
import { DEFAULT_CROSS_SPINE_EDGE_POLICY } from "../entity_resolution/cross_domain/edge_policy.mjs";
import {
  PROCUREMENT_DEVIATION_CLASS,
  PROCUREMENT_EVENT_LOG_SCHEMA,
  PROCUREMENT_EXPECTED_PROCESS,
  buildProcurementEventLogEnvelope,
} from "../site/procurement_event_log.mjs";
import {
  AGENCY_LIFECYCLE_CONFORMANCE_METHOD,
  AGENCY_LIFECYCLE_CONFORMANCE_SCHEMA,
  buildAgencyLifecycleConformanceView,
  renderAgencyLifecycleConformance,
} from "../site/agency_lifecycle_conformance.mjs";
import { buildAgencyLifecycleConformanceLookup } from "../tools/build_agency_lifecycle_conformance.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PARKS = "parks-and-recreation";
const LOOKUP = join(ROOT, "site/data/process_conformance_lookup.json");
const OBLIGATIONS = join(ROOT, "site/data/agency_obligations_lookup.json");
const PROCUREMENT_EVENT_LOG_FIXTURE = join(
  ROOT,
  "worker/test/fixtures/lifecycle-coherence/procurement_event_log_cases.json",
);

test("procurement fixture emits bounded case-keyed event-log envelopes", () => {
  const fixture = JSON.parse(readFileSync(PROCUREMENT_EVENT_LOG_FIXTURE, "utf8"));
  const envelopes = fixture.cases.map((row) => buildProcurementEventLogEnvelope(row));
  const expectedTrace = [
    "solicitation",
    "bid_deadline",
    "award",
    "registration",
    "payment",
  ];

  assert.deepEqual(PROCUREMENT_EXPECTED_PROCESS.map((stage) => stage.id), expectedTrace);
  assert.ok(envelopes.some((row) => row.fixture_kind === "synthetic"));
  assert.ok(envelopes.some((row) => row.fixture_kind === "real_shaped"));

  for (const [index, envelope] of envelopes.entries()) {
    const fixtureCase = fixture.cases[index];
    assert.equal(envelope.schema, PROCUREMENT_EVENT_LOG_SCHEMA);
    assert.ok(envelope.case_id);
    assert.equal(envelope.data_as_of, fixtureCase.data_as_of);
    assert.deepEqual(envelope.expected_process.trace, expectedTrace);
    assert.deepEqual(envelope.observed_trace, fixtureCase.expected_observed_trace);
    assert.equal(envelope.deviation.class, fixtureCase.expected_deviation_class);
    assert.deepEqual(
      envelope.event_log.map((event) => event.occurred_at),
      envelope.event_log.map((event) => event.occurred_at).toSorted(),
    );
    for (const event of envelope.event_log) {
      assert.equal(event.case_id, envelope.case_id);
      assert.ok(event.activity_label);
      assert.ok(event.clock);
      assert.match(event.source.href, /^https:\/\//);
      assert.doesNotMatch(event.source.href, /example\.|127\.0\.0\.1/);
    }
  }

  const fullCases = envelopes.filter((row) => (
    row.fixture_kind === "synthetic" || row.fixture_kind === "real_shaped"
  ));
  assert.equal(fullCases.length, 2);
  for (const envelope of fullCases) {
    assert.deepEqual(envelope.observed_trace, expectedTrace);
    assert.equal(envelope.deviation.class, PROCUREMENT_DEVIATION_CLASS.CONFORMING);
  }
});

test("missing procurement observations stay evidence-relative and carry data-as-of", () => {
  const fixture = JSON.parse(readFileSync(PROCUREMENT_EVENT_LOG_FIXTURE, "utf8"));
  const missing = buildProcurementEventLogEnvelope(
    fixture.cases.find((row) => row.expected_deviation_class === "missing_open_data"),
  );

  assert.equal(missing.deviation.class, PROCUREMENT_DEVIATION_CLASS.MISSING_OPEN_DATA);
  assert.deepEqual(missing.deviation.missing_activities, ["bid_deadline"]);
  assert.equal(missing.deviation.data_as_of, missing.data_as_of);
  assert.equal(missing.deviation.is_legal_noncompliance, false);
  assert.equal(missing.deviation.adjudication, "not_adjudicated");
  assert.doesNotMatch(missing.deviation.class, /legal|violation|noncompliance/i);
});

test("procurement deviation classification follows the time-ordered observed trace", () => {
  const fixture = JSON.parse(readFileSync(PROCUREMENT_EVENT_LOG_FIXTURE, "utf8"));
  const input = structuredClone(fixture.cases[0]);
  input.case_id = "fixture:procurement:out-of-order-001";
  input.events.find((event) => event.activity === "award").occurred_at = "2025-04-10";
  input.events.find((event) => event.activity === "registration").occurred_at = "2025-03-20";

  const envelope = buildProcurementEventLogEnvelope(input);
  assert.deepEqual(envelope.observed_trace, [
    "solicitation",
    "bid_deadline",
    "registration",
    "award",
    "payment",
  ]);
  assert.equal(envelope.deviation.class, PROCUREMENT_DEVIATION_CLASS.OUT_OF_ORDER_TRACE);
  assert.equal(envelope.deviation.is_legal_noncompliance, false);
});

test("agency procurement lifecycle compares expected stages with traces and aggregates deviations", () => {
  const fixture = JSON.parse(readFileSync(PROCUREMENT_EVENT_LOG_FIXTURE, "utf8"));
  const cases = fixture.cases.slice(0, 2).map((row) => buildProcurementEventLogEnvelope(row));
  const view = buildAgencyLifecycleConformanceView({
    agency_id: "transportation",
    agency_name: "Transportation",
    lifecycle_id: "procurement",
    lifecycle_label: "Procurement lifecycle",
    cases,
  });

  assert.equal(view.schema, AGENCY_LIFECYCLE_CONFORMANCE_SCHEMA);
  assert.equal(view.method, AGENCY_LIFECYCLE_CONFORMANCE_METHOD);
  assert.equal(view.status, "matched");
  assert.equal(view.slice_label, "Transportation · Procurement lifecycle");
  assert.equal(view.data_as_of, "2026-08-15");
  assert.equal(view.case_count, 2);
  assert.deepEqual(view.expected_stages.map((stage) => stage.id), [
    "solicitation",
    "bid_deadline",
    "award",
    "registration",
    "payment",
  ]);
  assert.ok(view.stage_completeness.every((stage) => stage.observed_cases === 2));
  assert.deepEqual(view.deviation_counts, {
    conforming: 2,
    missing_open_data: 0,
    out_of_order_trace: 0,
  });

  const html = renderAgencyLifecycleConformance(view);
  assert.match(html, /Transportation · Procurement lifecycle/);
  assert.match(html, /Expected stages/);
  assert.match(html, /Observed traces/);
  assert.match(html, /Solicitation published/);
  assert.match(html, /2 of 2 cases/);
  assert.match(html, /Method: expected-stage replay of joined public timestamps/);
  assert.match(html, /Data as of 2026-08-15/);
  assert.doesNotMatch(html, /legal|compliance verdict|disclaimer|pipeline|detector/i);
});

test("agency lifecycle stays held when case identity or event clocks are incomplete", () => {
  const fixture = JSON.parse(readFileSync(PROCUREMENT_EVENT_LOG_FIXTURE, "utf8"));
  const complete = buildProcurementEventLogEnvelope(fixture.cases[0]);
  const missingIdentity = { ...complete, case_id: null };
  const missingClock = {
    ...complete,
    event_log: complete.event_log.map((event, index) => (
      index === 0 ? { ...event, clock: null } : event
    )),
  };
  const view = buildAgencyLifecycleConformanceView({
    agency_id: "transportation",
    agency_name: "Transportation",
    lifecycle_id: "procurement",
    lifecycle_label: "Procurement lifecycle",
    cases: [missingIdentity, missingClock],
  });

  assert.equal(view.status, "data_incomplete");
  assert.deepEqual(view.incomplete_fields, ["case_identity", "event_clock"]);
  assert.equal(view.case_count, null);
  assert.equal(view.deviation_counts, null);
  assert.equal(renderAgencyLifecycleConformance(view), "");
});

test("agency constellation renders a complete procurement lifecycle slice", () => {
  const fixture = JSON.parse(readFileSync(PROCUREMENT_EVENT_LOG_FIXTURE, "utf8"));
  const lifecycle = buildAgencyLifecycleConformanceView({
    agency_id: "transportation",
    agency_name: "Transportation",
    cases: fixture.cases.slice(0, 2).map((row) => buildProcurementEventLogEnvelope(row)),
  });
  const view = buildAgencyConstellationView("transportation", {
    agency_lifecycle_conformance: { by_agency: { transportation: lifecycle } },
    generated_at: "2026-08-15T00:00:00Z",
  });

  assert.equal(view.agency_lifecycle_conformance.status, "matched");
  const html = renderAgencyConstellationDocument(view);
  assert.match(html, /id="procurement-lifecycle-conformance"/);
  assert.match(html, /Transportation · Procurement lifecycle/);
  assert.match(html, /Expected stages/);
  assert.match(html, /Observed traces/);
});

test("committed agency lifecycle lookup is reproducible and excludes synthetic cases", () => {
  const fixture = JSON.parse(readFileSync(PROCUREMENT_EVENT_LOG_FIXTURE, "utf8"));
  const expected = buildAgencyLifecycleConformanceLookup(fixture);
  const committed = JSON.parse(readFileSync(
    join(ROOT, "site/data/agency_lifecycle_conformance_lookup.json"),
    "utf8",
  ));

  assert.deepEqual(committed, expected);
  assert.equal(committed.by_agency.transportation.case_count, 2);
  assert.ok(committed.by_agency.transportation.cases.every((row) => (
    !row.case_id.includes("fixture:")
  )));
  const awards = JSON.parse(readFileSync(
    join(ROOT, "site/data/ocp_awards_warehouse_lookup.json"),
    "utf8",
  )).rows;
  for (const row of committed.by_agency.transportation.cases) {
    const requestId = row.case_id.replace(/^notice:/, "");
    const source = awards.find((award) => String(award.request_id) === requestId);
    assert.equal(source?.agency_name, "Transportation");
    assert.equal(source?.start_date, row.event_log[0]?.occurred_at);
  }
});

test("content tokens drop stopwords and keep topic words", () => {
  const tokens = contentTokens(
    "The commissioner shall promulgate rules identifying automated external defibrillators in parks",
  );
  assert.ok(tokens.includes("automated"));
  assert.ok(tokens.includes("defibrillators"));
  assert.ok(!tokens.includes("shall"));
  assert.ok(!tokens.includes("rules"));
});

test("topic match requires shared content tokens", () => {
  const strong = scoreTopicMatch(
    "promulgate rules relating to special event permits",
    { label: "DPR Proposed Amendment of Rules Relating to Special Event Permits" },
  );
  assert.ok(strong.score >= 2);
  assert.ok(strong.shared.includes("special") || strong.shared.includes("event") || strong.shared.includes("permits"));

  const weak = scoreTopicMatch(
    "plant trees on sidewalks",
    { label: "Emergency Rule Regarding 2026 Summer Event Permit Applications" },
  );
  assert.equal(weak.score, 0);
});

test("mandate-to-rule evidence requires body and law agreement, not title overlap alone", () => {
  const mandate = {
    agency_id: "transportation",
    duty_text: "Promulgate rules relating to pedestrian plaza commercial activity",
    deliverable_type: "rulemaking",
    citation: "§ 19-157(c)(2)",
  };
  const candidate = normalizeObservationCandidate({
    agency_id: "transportation",
    agency_name: "Transportation",
    request_id: "20260601001",
    short_title: "Proposed Rules for Pedestrian Plaza Commercial Activity",
    body: "These rules regulate pedestrian plaza commercial activity under § 19-157(c)(2).",
    citation: "§ 19-157(c)(2)",
    start_date: "2026-06-10T00:00:00.000",
    signal_kind: "rule_filing",
  });
  const evidence = scoreMandateRuleEvidence(mandate, candidate);
  assert.ok(evidence.rule_body_overlap.includes("pedestrian"));
  assert.equal(evidence.citation_law_match, true);
  assert.equal(evidence.temporal_compatible, true);
  assert.deepEqual(evidence.negative_evidence, []);
  assert.equal(evidence.publication_tier, "public_inferred");
  assert.equal(evidence.policy_gate.gold_version, DEFAULT_CROSS_SPINE_EDGE_POLICY.gold_version);
  assert.ok(evidence.policy_gate.min_precision >= 0.90);
});

test("reviewed aliases generate a rule candidate but cannot bypass final evidence gates", () => {
  const mandate = {
    agency_id: "sanitation",
    duty_text: "Regulate commercial waste zones",
    deliverable_type: "rulemaking",
    citation: "Administrative Code § 16-1001",
  };
  const candidate = normalizeObservationCandidate({
    agency_id: "sanitation",
    agency_name: "Sanitation",
    request_id: "20260708002",
    short_title: "DSNY Proposed Implementation Dates for Manhattan West CWZs",
    body: "Implementation schedule without the cited mandate text.",
    start_date: "2026-07-15T00:00:00.000",
    signal_kind: "rule_filing",
  });

  const topic = scoreTopicMatch(mandate.duty_text, candidate);
  assert.equal(topic.method, "reviewed_topic_overlap_v1");
  assert.deepEqual(topic.shared, ["commercial", "waste", "zone"]);

  const evidence = evaluateRuleEvidence(mandate, candidate);
  assert.equal(evidence.topic_score, 3);
  assert.equal(evidence.citation_law_match, false);
  assert.deepEqual(evidence.rule_body_overlap, []);
  assert.equal(evidence.publication_eligible, false);
  assert.equal(evidence.publication_tier, "evidence_only");
  assert.equal(evidence.topic_normalization.registry_version, "topic_normalization_v1");
});

test("normalization feeds compact snapshot stamps through the existing rule evaluator", () => {
  const mandate = {
    agency_id: "transportation",
    duty_text: "Promulgate rules relating to pedestrian plaza commercial activity",
    deliverable_type: "rulemaking",
    citation: "Administrative Code § 19-157(c)(2)",
  };
  const candidate = normalizeObservationCandidate({
    agency_id: "transportation",
    agency_name: "Transportation",
    request_id: "20260601001",
    short_title: "Proposed Rules for Pedestrian Plaza Commercial Activity",
    start_date: "2026-06-10T00:00:00.000",
    section_name: "Agency Rules",
    rule_evidence: {
      schema: "cityscroll.rule_evidence_stamp.v1",
      topic_keys: ["pedestrian", "plaza", "commercial", "activity"],
      body_topic_keys: ["pedestrian", "plaza", "commercial", "activity"],
      citation_keys: ["nyc-admin-code:19-157(c)(2)"],
      lifecycle_status: "adopted",
      effective_date: "2026-07-01",
      adoption_date: "2026-06-03",
      negative_evidence: [],
    },
  });
  assert.equal(candidate.body, null);
  assert.equal(candidate.lifecycle_status, "adopted");
  assert.equal(candidate.effective_date, "2026-07-01");
  assert.deepEqual(candidate.body_topic_keys, ["pedestrian", "plaza", "commercial", "activity"]);
  const evidence = evaluateRuleEvidence(mandate, candidate);
  assert.equal(evidence.citation_law_match, true);
  assert.ok(evidence.rule_body_overlap.includes("pedestrian"));
  assert.equal(evidence.publication_eligible, true);
  assert.equal(evidence.policy_gate.gold_version, DEFAULT_CROSS_SPINE_EDGE_POLICY.gold_version);
});

test("rule candidates with adverse status remain evidence-only", () => {
  const observation = resolveMandateObservation({
    agency_id: "transportation",
    duty_text: "Promulgate rules relating to pedestrian plaza commercial activity",
    deliverable_type: "rulemaking",
    citation: "§ 19-157(c)(2)",
  }, [normalizeObservationCandidate({
    agency_id: "transportation",
    agency_name: "Transportation",
    request_id: "20260601002",
    short_title: "Withdrawn Rules for Pedestrian Plaza Commercial Activity",
    body: "Withdrawn rules would regulate pedestrian plaza commercial activity under § 19-157(c)(2).",
    citation: "§ 19-157(c)(2)",
    start_date: "2026-06-10T00:00:00.000",
    signal_kind: "rule_filing",
  })]);
  assert.equal(observation.status, OBSERVATION_STATUS.EVIDENCE_ONLY);
  assert.equal(observation.observed_record, null);
  assert.equal(observation.match.publication, "evidence_only");
  assert.ok(observation.shadow_candidate.features.negative_evidence.includes("adverse_rule_status"));
});

test("does not attach the 2026 Lead Dust notice to 2020 outdoor-dining or food-vending duties", () => {
  const candidate = {
    request_id: "20260522008",
    label: "Amendment of Rules Relating to Lead Dust",
    when: "2026-05-29",
    signal_kind: "rule_filing",
    href: "#notice/20260522008",
    tokens: contentTokens("Amendment of Rules Relating to Lead Dust"),
  };
  for (const dutyText of [
    "Establish guidelines for temporary outdoor dining areas, including guidelines relating to social distancing, protection of the health and safety of patrons and workers, and cleaning.",
    "Establish guidelines for food vending in open spaces, including guidelines relating to spacing of food vendors.",
  ]) {
    const observation = resolveMandateObservation({
      duty_text: dutyText,
      deliverable_type: "rulemaking",
      deadline: { computed_date: "2020-08-02" },
    }, [candidate], { asOf: "2026-08-08" });
    assert.notEqual(observation.status, OBSERVATION_STATUS.OBSERVED);
    assert.equal(observation.observed_record, null);
  }
});

test("does not attach the DOT FHV parking notice to pedestrian-plaza rulemaking, while genuine subject matches survive", () => {
  const pedestrianPlazaDuty =
    "In developing pedestrian plaza-specific rules, consider specified factors including the plaza’s needs, traffic and congestion, public safety, size, usage demands, aesthetics or special character, tourism or economic development, and regulation of commercial activity or expressive matter vending.";
  const fhvParkingCandidate = {
    request_id: "20260714029",
    label: "Notice of Public Hearing and Opportunity to Comment- FHV and Taxi Parking at Commercial Meters and Commercial Vehicle Markings",
    when: "2026-07-22",
    agency_id: "transportation",
    agency_name: "Transportation",
    signal_kind: "rule_filing",
    href: "#notice/20260714029",
    tokens: contentTokens("Notice of Public Hearing and Opportunity to Comment- FHV and Taxi Parking at Commercial Meters and Commercial Vehicle Markings"),
  };
  const falseObservation = resolveMandateObservation({
    obligation_id: "55689-007",
    agency_id: "transportation",
    duty_text: pedestrianPlazaDuty,
    deliverable_type: "rulemaking",
    deadline: { computed_date: null },
    citation: "§ 19-157(c)(2)",
  }, [fhvParkingCandidate], { asOf: "2026-08-08" });
  assert.equal(falseObservation.status, OBSERVATION_STATUS.EXPECTED_NOT_YET_OBSERVED);
  assert.equal(falseObservation.observed_record, null);

  const genuineObservation = resolveMandateObservation({
    obligation_id: "55689-007",
    agency_id: "transportation",
    duty_text: pedestrianPlazaDuty,
    deliverable_type: "rulemaking",
    deadline: { computed_date: null },
    citation: "§ 19-157(c)(2)",
  }, [{
    ...fhvParkingCandidate,
    request_id: "20260601001",
    label: "Proposed Rules for Pedestrian Plaza Commercial Activity",
    href: "#notice/20260601001",
    body: "These rules establish pedestrian plaza commercial activity under § 19-157(c)(2).",
    citation: "§ 19-157(c)(2)",
    tokens: contentTokens("Proposed Rules for Pedestrian Plaza Commercial Activity"),
  }], { asOf: "2026-08-08" });
  assert.equal(genuineObservation.status, OBSERVATION_STATUS.OBSERVED);
  assert.equal(genuineObservation.observed_record.request_id, "20260601001");
});

test("a parsed public rule match materializes a typed provenance-bearing mandate edge", () => {
  const view = buildAgencyConformanceView("transportation", {
    obligationsLookup: {
      by_agency: {
        transportation: {
          obligations: [{
            obligation_id: "55689-007",
            matter_id: "55689",
            agency_id: "transportation",
            agency_name: "Transportation",
            duty_text: "Promulgate rules relating to pedestrian plaza commercial activity.",
            deliverable_type: "rulemaking",
            citation: "Administrative Code § 19-157(c)(2)",
            source: {
              matter_id: "55689",
              legistar_url: "https://nyc.legistar.com/Gateway.aspx?M=L&ID=55689",
            },
          }],
        },
      },
    },
    rulesDomain: {
      rows: [{
        request_id: "20260601001",
        agency_name: "Transportation",
        short_title: "Proposed Rules for Pedestrian Plaza Commercial Activity",
        start_date: "2026-06-10T00:00:00.000",
        section_name: "Agency Rules",
        source_system: "city_record",
        rule_evidence: {
          topic_keys: ["pedestrian", "plaza", "commercial", "activity"],
          body_topic_keys: ["pedestrian", "plaza", "commercial", "activity"],
          citation_keys: ["nyc-admin-code:19-157(c)(2)"],
          lifecycle_status: "proposal",
          negative_evidence: [],
        },
      }],
    },
    asOf: "2026-08-16",
  });

  const item = view.items.find((row) => row.mandate_id === "55689-007");
  assert.equal(item.observation.status, OBSERVATION_STATUS.OBSERVED);
  assert.equal(item.category, "rules");
  assert.equal(item.edge_type, MANDATE_RULE_EDGE_TYPE);
  assert.equal(item.observation.edge.type, MANDATE_RULE_EDGE_TYPE);
  assert.equal(item.observation.edge.from, "mandate:55689-007");
  assert.equal(item.observation.edge.to, "rulemaking:notice:20260601001");
  assert.equal(item.observation.edge.publication_tier, "public_inferred");
  assert.equal(item.observation.edge.provenance.schema, "cityscroll.graph_edge_provenance.v1");
  assert.equal(item.observation.edge.provenance.where.source_system.value, "city_record");
  assert.equal(item.observation.edge.provenance.where.source_record_id.value, "city_record:20260601001");
  assert.equal(item.observation.edge.provenance.where.observed_at.value, "2026-06-10");
  assert.ok(item.observation.edge.provenance.how.method.value);
  assert.equal(item.observation.edge.provenance.confidence.counts_as_verified_total, false);
});

test("rejects a strong subject match when the notice is implausibly late", () => {
  const observation = resolveMandateObservation({
    duty_text: "Promulgate rules for outdoor dining safety",
    deliverable_type: "rulemaking",
    deadline: { computed_date: "2020-08-02" },
  }, [{
    request_id: "20260522008",
    label: "Outdoor Dining Safety Rules",
    when: "2026-05-29",
    signal_kind: "rule_filing",
    href: "#notice/20260522008",
    tokens: contentTokens("Outdoor Dining Safety Rules"),
  }], { asOf: "2026-08-08" });
  assert.equal(observation.status, OBSERVATION_STATUS.EXPECTED_NOT_YET_OBSERVED);
  assert.equal(observation.observed_record, null);
});

test("recurring report mandates accept later filing cycles without matching unrelated reports", () => {
  const mandate = {
    agency_id: "buildings",
    agency_name: "Buildings",
    duty_text: "Publish an annual building safety report",
    deliverable_type: "report",
    recurrence: "annual",
    deadline: { computed_date: "2020-12-31" },
  };
  const filing = normalizeObservationCandidate({
    agency_id: "buildings",
    agency_name: "Buildings",
    request_id: "20260115001",
    short_title: "Annual Building Safety Report 2025",
    start_date: "2026-01-15T00:00:00.000",
    signal_kind: "report_or_study",
    domain: "reports",
  });
  const unrelated = normalizeObservationCandidate({
    agency_id: "buildings",
    agency_name: "Buildings",
    request_id: "20260115002",
    short_title: "Annual Elevator Maintenance Report 2025",
    start_date: "2026-01-15T00:00:00.000",
    signal_kind: "report_or_study",
    domain: "reports",
  });

  const observed = resolveMandateObservation(mandate, [unrelated, filing], {
    asOf: "2026-08-16",
  });
  assert.equal(observed.status, OBSERVATION_STATUS.OBSERVED);
  assert.equal(observed.observed_record.request_id, filing.request_id);

  const unrelatedOnly = resolveMandateObservation(mandate, [unrelated], {
    asOf: "2026-08-16",
  });
  assert.equal(unrelatedOnly.status, OBSERVATION_STATUS.EXPECTED_NOT_YET_OBSERVED);
  assert.equal(unrelatedOnly.observed_record, null);
});

test("resolveMandateObservation never emits compliance verdicts", () => {
  const observed = resolveMandateObservation(
    {
      duty_text: "Promulgate rules relating to special event permits",
      deliverable_type: "rulemaking",
      deadline: { computed_date: "2026-06-01" },
      citation: "Administrative Code § 18-142(a)",
    },
    [{
      request_id: "20260514002",
      label: "DPR Proposed Amendment of Rules Relating to Special Event Permits",
      when: "2026-05-18",
      signal_kind: "rule_filing",
      href: "#notice/20260514002",
      body: "These rules establish special event permits under Administrative Code § 18-142(a).",
      citation: "Administrative Code § 18-142(a)",
      tokens: contentTokens("DPR Proposed Amendment of Rules Relating to Special Event Permits"),
    }],
  );
  assert.equal(observed.status, OBSERVATION_STATUS.OBSERVED);
  assert.equal(observed.is_compliance_verdict, false);
  assert.equal(observed.adjudication, "not_adjudicated");
  assert.equal(observed.observed_record.request_id, "20260514002");
  assert.doesNotMatch(JSON.stringify(observed), /violat|broke the law|missed its mandate|out of compliance/i);

  const pending = resolveMandateObservation(
    {
      duty_text: "Plant cool pavement in parks",
      deliverable_type: "program",
      deadline: { computed_date: "2027-07-01" },
    },
    [],
    { asOf: "2026-08-07" },
  );
  assert.equal(pending.status, OBSERVATION_STATUS.ENRICHMENT_PENDING);

  const onTrack = resolveMandateObservation(
    {
      duty_text: "Promulgate rules for trail maps",
      deliverable_type: "rulemaking",
      deadline: { computed_date: "2028-01-01" },
    },
    [],
    { asOf: "2026-08-07" },
  );
  assert.equal(onTrack.status, OBSERVATION_STATUS.ON_TRACK);

  const notYet = resolveMandateObservation(
    {
      duty_text: "Promulgate rules for automated external defibrillators in parks",
      deliverable_type: "rulemaking",
      deadline: { computed_date: "2020-01-01" },
    },
    [],
    { asOf: "2026-08-07" },
  );
  assert.equal(notYet.status, OBSERVATION_STATUS.EXPECTED_NOT_YET_OBSERVED);
  assert.equal(notYet.label, "Expected; no matching evidence in current sources");
  assert.match(notYet.note, /No matching evidence in current sources/i);
  assert.equal(observed.label, "Evidence found");
});

test("shareable path anchors mandates conformance", () => {
  assert.equal(
    agencyMandatesConformancePath(PARKS),
    "/agencies/parks-and-recreation/#mandates-conformance",
  );
});

test("one conformance run aligns rules, reports, meetings, contracts, and zoning", () => {
  const asOf = "2026-08-15";
  const base = {
    schema: PROCESS_CONFORMANCE_SCHEMA,
    method: PROCESS_CONFORMANCE_METHOD,
    agency_id: PARKS,
    agency_name: "Parks and Recreation",
    status: "matched",
    as_of: asOf,
    counts: { total: 2, observed: 2, detectable: 2 },
    candidate_corpus: { size: 2, sources: ["rules", "reports"], sample: [] },
    items: [
      {
        mandate_id: "parks-rule",
        duty_text: "Adopt rules for park permits",
        deliverable_type: "rulemaking",
        source_href: "https://legistar.council.nyc.gov/LegislationDetail.aspx?ID=1",
        observation: {
          status: OBSERVATION_STATUS.OBSERVED,
          expected_event: { kind: "rule_filing", label: "Rule filing" },
          observed_record: { label: "Park permit rule", href: "/notices/20260815001" },
        },
      },
      {
        mandate_id: "parks-report",
        duty_text: "Publish a park safety report",
        deliverable_type: "report",
        source_href: "https://legistar.council.nyc.gov/LegislationDetail.aspx?ID=2",
        observation: {
          status: OBSERVATION_STATUS.OBSERVED,
          expected_event: { kind: "report_or_study", label: "Report publication" },
          observed_record: { label: "Park safety report", href: "/notices/20260815002" },
        },
      },
    ],
  };
  const categories = [
    ["meetings", "requires_public_hearing", "Public meeting or hearing", "meeting:city-record:20260815003"],
    ["contracts", "implemented_by_contract", "Contract award or registration", "contract:CT1-846-20261234567"],
    ["zoning", "requires_land_use_action", "Land-use or zoning action", "project:2026M0001"],
  ].map(([category, edgeType, label, target], index) => buildMandateCategoryConformance({
    category,
    edgeType,
    expectedKind: category === "meetings" ? "public_hearing" : category === "contracts" ? "procurement_contract" : "land_use_action",
    expectedLabel: label,
    asOf,
    sourceAvailable: true,
    mandates: [{
      obligation_id: `parks-${category}`,
      duty_text: `Parks expected ${category} event`,
      deadline: { computed_date: `2026-0${index + 6}-30` },
      source: { legistar_url: `https://legistar.council.nyc.gov/LegislationDetail.aspx?ID=${index + 3}` },
    }],
    edges: [{
      mandate_id: `parks-${category}`,
      target: { subject_ref: target, label: `${label} record`, href: `/agencies/${PARKS}/?claim=edge-${category}`, when: asOf },
      claim: { claim_id: `edge-${category}`, inspect_href: `/agencies/${PARKS}/?claim=edge-${category}` },
    }],
  }));

  const view = mergeMandateCategoryConformance(base, categories, { asOf });
  assert.deepEqual(view.categories, ["contracts", "meetings", "reports", "rules", "zoning"]);
  assert.equal(view.as_of, asOf);
  assert.equal(view.items.length, 5);
  assert.ok(view.items.every((item) => item.data_as_of === asOf));
  assert.ok(view.items.every((item) => item.observation.observation_state === OBSERVATION_STATE.APPEARED));
  for (const category of ["meetings", "contracts", "zoning"]) {
    const item = view.items.find((row) => row.category === category);
    assert.equal(item.observation.edge.type, categories.find((group) => group.category === category).edge_type);
    assert.match(item.observation.edge.claim_inspect_href, new RegExp(`claim=edge-${category}`));
    assert.match(item.observation.observed_record.href, /^\/agencies\/parks-and-recreation\/\?claim=/);
  }

  const html = renderMandatesConformanceSection(view);
  assert.match(html, /data-conformance-category="meetings"/);
  assert.match(html, /data-conformance-category="contracts"/);
  assert.match(html, /data-conformance-category="zoning"/);
  assert.match(html, /Data as of 2026-08-15/);
  assert.match(html, /View connection details/);
  assert.doesNotMatch(html, /not a compliance|not a verdict|disclaimer|pipeline|detector/i);
});

test("category conformance distinguishes not-yet-observed from incomplete data", () => {
  const mandate = { obligation_id: "m-1", duty_text: "Hold a public hearing" };
  const known = buildMandateCategoryConformance({
    category: "meetings",
    edgeType: "requires_public_hearing",
    expectedKind: "public_hearing",
    expectedLabel: "Public meeting or hearing",
    asOf: "2026-08-15",
    sourceAvailable: true,
    mandates: [mandate],
    edges: [],
  });
  const unknown = buildMandateCategoryConformance({
    category: "meetings",
    edgeType: "requires_public_hearing",
    expectedKind: "public_hearing",
    expectedLabel: "Public meeting or hearing",
    asOf: "2026-08-15",
    sourceAvailable: false,
    mandates: [mandate],
    edges: [],
  });
  assert.equal(known.items[0].observation.observation_state, OBSERVATION_STATE.NOT_YET_OBSERVED);
  assert.equal(unknown.items[0].observation.observation_state, OBSERVATION_STATE.DATA_INCOMPLETE);
  assert.equal(known.items[0].data_as_of, unknown.items[0].data_as_of);
});

test("mandates conformance omits zero-observed views and absence rows", () => {
  const html = renderMandatesConformanceSection({
    status: "matched",
    counts: { observed: 0, expected_not_yet_observed: 22, on_track: 0 },
    items: [{
      mandate_id: "dcas-001",
      duty_text: "Publish an annual report",
      observation: {
        status: OBSERVATION_STATUS.EXPECTED_NOT_YET_OBSERVED,
        label: "Expected; no matching evidence in current sources",
      },
    }],
  });
  assert.equal(html, "");
});

test("mandates conformance renders matched rows without absence placeholders", () => {
  const html = renderMandatesConformanceSection({
    status: "matched",
    counts: { observed: 1, expected_not_yet_observed: 1, on_track: 0 },
    share_path: "/agencies/parks-and-recreation/#mandates-conformance",
    items: [{
      mandate_id: "dob-observed",
      duty_text: "Publish the matched report",
      observation: {
        status: OBSERVATION_STATUS.OBSERVED,
        label: "Evidence found",
        observed_record: { href: "/notices/1", label: "Matched report" },
      },
    }, {
      mandate_id: "dob-absent",
      duty_text: "Publish the unmatched report",
      observation: {
        status: OBSERVATION_STATUS.EXPECTED_NOT_YET_OBSERVED,
        label: "Expected; no matching evidence in current sources",
      },
    }],
  });
  assert.match(html, /Publish the matched report/);
  assert.match(html, /Evidence found/);
  assert.match(html, /1 record appeared/);
  assert.match(html, /class="mandates-conformance-scroll"[^>]*role="region"[^>]*tabindex="0"/);
  assert.match(html, /Scroll to view all mandates/);
  assert.match(html, /Open all mandates/);
  assert.match(MANDATE_CONFORMANCE_STYLE, /\.mandates-conformance-scroll\s*\{[\s\S]*block-size: 28rem/);
  assert.doesNotMatch(html, /City Record:/);
  assert.doesNotMatch(html, /Publish the unmatched report|Expected, not yet in City Record|Expected; no matching evidence in current sources/);
});

test("conformance renders lifecycle facts with only known public destinations", () => {
  const candidate = normalizeObservationCandidate({
    request_id: "20260605008",
    short_title: "Final rule for commercial waste zones",
    href: "javascript:alert(1)",
    domain: "rules",
    rule_evidence: {
      lifecycle_status: "adopted",
      adoption_date: "2026-06-11",
      effective_date: "2026-07-01",
    },
  });
  assert.equal(candidate.href, "/notices/20260605008");
  assert.equal(candidate.lifecycle_status, "adopted");
  assert.equal(candidate.adoption_date, "2026-06-11");
  assert.equal(candidate.effective_date, "2026-07-01");

  const html = renderMandatesConformanceSection({
    status: "matched",
    counts: { observed: 1, expected_not_yet_observed: 3, on_track: 0 },
    graph_neighbors: {
      rules_browse_href: "/browse/rules/",
      meetings_browse_href: "/browse/meetings/",
      contracts_browse_href: "/browse/contracts/",
    },
    items: [{
      mandate_id: "dsny-001",
      duty_text: "Adopt rules for commercial waste zones",
      deliverable_type: "rulemaking",
      recurrence: "annual",
      observation: {
        status: OBSERVATION_STATUS.OBSERVED,
        label: "Evidence found",
        expected_event: { deadline_date: "2026-06-01" },
        observed_record: {
          request_id: candidate.request_id,
          label: candidate.label,
          href: candidate.href,
          when: "2026-06-11",
          lifecycle_label: "Adopted",
          effective_date: "2026-07-01",
        },
      },
    }],
  });
  assert.match(html, /Rule filing · Adopted · on 2026-06-11 · in effect 2026-07-01 · due/);
  assert.match(html, /href="\/notices\/20260605008"/);
  assert.doesNotMatch(html, /javascript:|rulemaking|report_or_study|Availability is not known yet|Mandate connections/);
});

test("Parks conformance view labels real mandates without compliance verdicts", () => {
  assert.ok(existsSync(OBLIGATIONS), "obligations lookup required");
  const obligations = JSON.parse(readFileSync(OBLIGATIONS, "utf8"));
  const rules = existsSync(join(ROOT, "site/data/rules_domain_observations.json"))
    ? JSON.parse(readFileSync(join(ROOT, "site/data/rules_domain_observations.json"), "utf8"))
    : null;
  const intelligence = existsSync(join(ROOT, "site/data/entity_intelligence_lookup.json"))
    ? JSON.parse(readFileSync(join(ROOT, "site/data/entity_intelligence_lookup.json"), "utf8"))
    : null;
  const view = buildAgencyConformanceView(PARKS, {
    obligationsLookup: obligations,
    rulesDomain: rules,
    entityIntelligence: intelligence,
    asOf: "2026-08-07",
  });
  assert.ok(view);
  assert.equal(view.schema, PROCESS_CONFORMANCE_SCHEMA);
  assert.equal(view.method, PROCESS_CONFORMANCE_METHOD);
  assert.ok(view.counts.total >= 20);
  assert.ok(view.counts.detectable >= 1);
  assert.ok(view.items.length >= 1);
  for (const item of view.items) {
    assert.ok(Object.values(OBSERVATION_STATUS).includes(item.observation.status));
    assert.equal(item.observation.is_compliance_verdict, false);
    assert.equal(item.observation.adjudication, "not_adjudicated");
  }
  assert.match(view.copy?.lead || view.honesty?.lead || "", /mandate|evidence|public record/i);
  assert.match(view.share_path, /#mandates-conformance/);
  assert.doesNotMatch(JSON.stringify(view), /agency broke the law|out of compliance|missed its mandate/i);
  for (const item of view.items) {
    if (item.observation.status === OBSERVATION_STATUS.OBSERVED) {
      assert.equal(item.observation.label, "Evidence found");
    }
    if (item.observation.status === OBSERVATION_STATUS.EXPECTED_NOT_YET_OBSERVED) {
      assert.equal(item.observation.label, "Expected; no matching evidence in current sources");
    }
  }
});

test("committed process_conformance lookup covers Parks", () => {
  assert.ok(existsSync(LOOKUP), "process_conformance_lookup.json must be built");
  const lookup = JSON.parse(readFileSync(LOOKUP, "utf8"));
  assert.equal(lookup.schema, PROCESS_CONFORMANCE_SCHEMA);
  assert.ok(lookup.by_agency[PARKS]);
  assert.ok(lookup.by_agency[PARKS].counts.total >= 20);
  assert.equal(lookup.copy?.lead || lookup.honesty?.lead, CONFORMANCE_HONESTY.lead);
  assert.equal(lookup.verified_demo, "agency:id:parks-and-recreation");
});

test("committed conformance lookup carries meetings, contracts, and zoning edges", () => {
  const lookup = JSON.parse(readFileSync(LOOKUP, "utf8"));
  assert.deepEqual(lookup.summary.conformance_categories, [
    "contracts", "meetings", "reports", "rules", "zoning",
  ]);
  assert.deepEqual(lookup.summary.observation_states, [
    OBSERVATION_STATE.APPEARED,
    OBSERVATION_STATE.NOT_YET_OBSERVED,
    OBSERVATION_STATE.DATA_INCOMPLETE,
  ]);
  const fieldCases = [
    ["transportation", "meetings", "requires_public_hearing"],
    ["homeless-services", "contracts", "implemented_by_contract"],
    ["landmarks-preservation-commission", "zoning", "requires_land_use_action"],
  ];
  for (const [agency, category, edgeType] of fieldCases) {
    const bucket = lookup.by_agency[agency];
    const row = bucket.edge_observations.find((item) => (
      item.category === category && item.observation_state === OBSERVATION_STATE.APPEARED
    ));
    assert.ok(row, `${agency} should have an appeared ${category} edge`);
    assert.equal(row.edge_type, edgeType);
    assert.equal(row.data_as_of, lookup.as_of);
    assert.match(row.edge.claim_inspect_href, new RegExp(`^/agencies/${agency}/\\?claim=`));
    assert.match(row.observed_record.href, /^(?:\/|https:\/\/)/);
  }
});

test("production snapshot exposes only provenance-complete standable mandate contract/rule/meeting edges", () => {
  const lookup = JSON.parse(readFileSync(LOOKUP, "utf8"));
  const minimums = [
    ["66056-006", "procurement", 3],
    ["64116-001", "rule", 1],
    ["68103-008", "meeting", 3],
  ];
  const all = minimums.flatMap(([mandateId, kind, minimum]) => {
    const edges = relatedCivicEdgesForMandate(lookup, mandateId);
    const matching = edges.filter((edge) => edge.kind === kind);
    assert.ok(
      matching.length >= minimum,
      `${mandateId} production ${kind} edge count must not regress below ${minimum}`,
    );
    return matching;
  });
  assert.ok(all.length >= 7);
  assert.ok(all.every((edge) => edge.provenance?.schema === "cityscroll.graph_edge_provenance.v1"));
  assert.ok(all.every((edge) => edge.provenance?.where?.source_system?.available === true));
  assert.ok(all.every((edge) => edge.provenance?.where?.source_record_id?.available === true));
  assert.ok(all.every((edge) => edge.provenance?.where?.observed_at?.available === true));
  assert.ok(all.every((edge) => edge.provenance?.how?.method?.available === true));
  assert.ok(all.every((edge) => edge.provenance?.confidence?.standable === true));
  assert.ok(all.filter((edge) => edge.kind === "procurement").every((edge) => edge.verified));
  assert.ok(all.filter((edge) => edge.kind !== "procurement").every((edge) => !edge.verified));

  const meetings = JSON.parse(readFileSync(
    join(ROOT, "site/data/shared_meeting_read_model.json"),
    "utf8",
  ));
  const meetingIds = new Set((meetings.rows || []).map((row) => row.meeting_id));
  assert.ok(all.filter((edge) => edge.kind === "meeting").every((edge) => meetingIds.has(edge.id)));
});

test("constellation surfaces only public Sanitation CWZ rule edges after attachment densify", () => {
  const intelligence = JSON.parse(readFileSync(join(ROOT, "site/data/entity_intelligence_lookup.json"), "utf8"));
  const certification = JSON.parse(readFileSync(join(ROOT, "site/data/exam_certification_constellation.json"), "utf8"));
  const obligations = JSON.parse(readFileSync(OBLIGATIONS, "utf8"));
  const process_conformance = JSON.parse(readFileSync(LOOKUP, "utf8"));
  const view = buildAgencyConstellationView("sanitation", {
    intelligence,
    certification,
    obligations,
    process_conformance,
  });
  const byId = Object.fromEntries(view.categories.map((category) => [category.id, category]));
  assert.equal(byId.obligations.label, "Mandates");
  assert.equal(byId.obligations.status, "matched");
  assert.ok(byId.obligations.conformance);
  // Public CWZ mandate_rule edge densified from GetFile PDF stamps.
  assert.ok((view.mandates_conformance.counts.observed || 0) >= 1);
  assert.match(view.mandates_href, /#mandates-conformance/);

  const html = renderAgencyConstellationDocument(view);
  // Densified public CWZ observation mounts expected-vs-observed + rules bridge.
  assert.match(html, /id="mandates-conformance"/);
  assert.match(html, /id="mandates-rules"/);
  assert.match(html, /What the law calls for · what records show/i);
  assert.match(html, /Evidence found/);
  // Honest rules title: "Rules activity" only when observed_links exist (graph-01).
  if ((view.mandates_rules?.counts?.observed_links || 0) === 0) {
    assert.match(html, /Rulemaking mandates/);
    assert.doesNotMatch(html, /Rulemaking mandates · Rules activity/);
  } else {
    assert.match(html, /Rulemaking mandates · Rules activity/);
  }
  const rulesBridge = html.match(/<section id="mandates-rules"[\s\S]*?<\/section>/)?.[0] || "";
  // Public CWZ edge renders a notice link from the evidence chip (title + ↗, no City Record button).
  assert.match(rulesBridge, /data-mandate-id="64116-001"[^>]*data-observation-status="observed"/);
  assert.match(rulesBridge, /Commercial Waste Zones|#notice\/20260605008|\/notices\/20260605008/);
  assert.doesNotMatch(rulesBridge, /City Record:/);
  // Evidence-only rows may remain listed without public edge links.
  assert.doesNotMatch(html, /not a compliance|not a verdict|ignored the law|out of compliance|missed its mandate/i);
  assert.doesNotMatch(html, /awaiting detector|This pass matches|corpus checked|This pass covers/i);
  assert.doesNotMatch(html, /Observed in City Record|Expected, not yet in City Record/);
});

test("buildProcessConformanceLookup is pure over fixture inputs", () => {
  const lookup = buildProcessConformanceLookup({
    obligationsLookup: {
      by_agency: {
        [PARKS]: {
          agency_id: PARKS,
          agency_name: "Parks and Recreation",
          obligations: [{
            obligation_id: "t-001",
            matter_id: "t",
            duty_text: "Promulgate rules relating to special event permits",
            deliverable_type: "rulemaking",
            deadline: { computed_date: "2026-06-01", text: null },
            recurrence: "one-time",
            citation: "Administrative Code § 18-142(a)",
            source: { legistar_url: "https://example.test/law" },
            certification: { status: "auto_certified" },
          }],
        },
      },
    },
    rulesDomain: {
      rows: [{
        request_id: "20260514002",
        agency_name: "Parks and Recreation",
        short_title: "DPR Proposed Amendment of Rules Relating to Special Event Permits",
        body: "These rules establish special event permits under Administrative Code § 18-142(a).",
        citation: "Administrative Code § 18-142(a)",
        start_date: "2026-05-18T00:00:00.000",
        section_name: "Agency Rules",
        type_of_notice_description: "Public Hearings",
        rule_evidence: {
          schema: "cityscroll.rule_evidence_stamp.v1",
          topic_keys: ["special", "event", "permits"],
          body_topic_keys: ["special", "event", "permits"],
          citation_keys: ["nyc-admin-code:18-142(a)", "nyc-admin-code:18-142"],
          lifecycle_status: "proposal",
          effective_date: null,
          adoption_date: null,
          negative_evidence: [],
        },
      }],
    },
    asOf: "2026-08-07",
    generatedAt: "2026-08-07T00:00:00.000Z",
  });
  assert.equal(lookup.by_agency[PARKS].counts.observed, 1);
  assert.equal(lookup.by_agency[PARKS].observations["t-001"].status, OBSERVATION_STATUS.OBSERVED);
  // Compact artifact: duty text is not duplicated here.
  assert.equal(lookup.by_agency[PARKS].items, undefined);
  assert.ok(lookup.by_agency[PARKS].observations["t-001"].observed_record?.request_id);
});
