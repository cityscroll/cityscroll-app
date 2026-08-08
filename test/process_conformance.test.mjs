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
  agencyMandatesConformancePath,
  buildAgencyConformanceView,
  buildProcessConformanceLookup,
  contentTokens,
  renderMandatesConformanceSection,
  resolveMandateObservation,
  scoreTopicMatch,
} from "../site/process_conformance.mjs";
import {
  buildAgencyConstellationView,
  renderAgencyConstellationDocument,
} from "../site/agency_constellation.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PARKS = "parks-and-recreation";
const LOOKUP = join(ROOT, "site/data/process_conformance_lookup.json");
const OBLIGATIONS = join(ROOT, "site/data/agency_obligations_lookup.json");

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
    },
    [{
      request_id: "20260514002",
      label: "DPR Proposed Amendment of Rules Relating to Special Event Permits",
      when: "2026-05-18",
      signal_kind: "rule_filing",
      href: "#notice/20260514002",
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
  assert.match(notYet.note, /No matching City Record filing/i);
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
        label: "Expected, not yet in City Record",
      },
    }],
  });
  assert.equal(html, "");
});

test("mandates conformance renders matched rows without absence placeholders", () => {
  const html = renderMandatesConformanceSection({
    status: "matched",
    counts: { observed: 1, expected_not_yet_observed: 1, on_track: 0 },
    items: [{
      mandate_id: "dob-observed",
      duty_text: "Publish the matched report",
      observation: {
        status: OBSERVATION_STATUS.OBSERVED,
        label: "Observed in City Record",
        observed_record: { href: "/notices/1", label: "Matched report" },
      },
    }, {
      mandate_id: "dob-absent",
      duty_text: "Publish the unmatched report",
      observation: {
        status: OBSERVATION_STATUS.EXPECTED_NOT_YET_OBSERVED,
        label: "Expected, not yet in City Record",
      },
    }],
  });
  assert.match(html, /Publish the matched report/);
  assert.doesNotMatch(html, /Publish the unmatched report|Expected, not yet in City Record/);
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
  assert.match(view.copy?.lead || view.honesty?.lead || "", /mandate|City Record/i);
  assert.match(view.share_path, /#mandates-conformance/);
  assert.doesNotMatch(JSON.stringify(view), /agency broke the law|out of compliance|missed its mandate/i);
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

test("constellation surfaces only observed mandates conformance rows for Sanitation", () => {
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
  assert.ok(view.mandates_conformance);
  assert.match(view.mandates_href, /#mandates-conformance/);

  const html = renderAgencyConstellationDocument(view);
  assert.match(html, /id="mandates-conformance"/);
  assert.match(html, /Mandates · expected vs observed|data-process-conformance="v1"/);
  const section = html.match(/<section id="mandates-conformance"[\s\S]*?<\/section>/)?.[0] || "";
  assert.match(section, /data-observation-status=/);
  assert.doesNotMatch(section, /data-observation-status="expected_not_yet_observed"/);
  assert.doesNotMatch(section, /Expected, not yet in City Record/);
  assert.match(html, /expected vs observed|City Record/i);
  assert.match(html, /Share this mandates view|Mandates expected vs observed/);
  assert.doesNotMatch(html, /not a compliance|not a verdict|ignored the law|out of compliance|missed its mandate/i);
  assert.doesNotMatch(html, /awaiting detector|This pass matches|corpus checked|This pass covers/i);
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
            citation: "§1",
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
        start_date: "2026-05-18T00:00:00.000",
        section_name: "Agency Rules",
        type_of_notice_description: "Public Hearings",
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
