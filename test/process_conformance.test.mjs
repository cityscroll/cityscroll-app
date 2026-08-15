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
  buildAgencyConstellationView,
  renderAgencyConstellationDocument,
} from "../site/agency_constellation.mjs";
import { DEFAULT_CROSS_SPINE_EDGE_POLICY } from "../entity_resolution/cross_domain/edge_policy.mjs";
import {
  PROCUREMENT_DEVIATION_CLASS,
  PROCUREMENT_EVENT_LOG_SCHEMA,
  PROCUREMENT_EXPECTED_PROCESS,
  buildProcurementEventLogEnvelope,
} from "../site/procurement_event_log.mjs";

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
  assert.match(html, /1 filing found/);
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
