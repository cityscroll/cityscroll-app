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

test("resolveMandateObservation never emits compliance verdicts", () => {
  const observed = resolveMandateObservation(
    {
      duty_text: "Promulgate rules relating to special event permits",
      deliverable_type: "rulemaking",
      deadline: { computed_date: "2020-01-01" },
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

test("constellation surfaces mandates conformance for Parks", () => {
  const intelligence = JSON.parse(readFileSync(join(ROOT, "site/data/entity_intelligence_lookup.json"), "utf8"));
  const certification = JSON.parse(readFileSync(join(ROOT, "site/data/exam_certification_constellation.json"), "utf8"));
  const obligations = JSON.parse(readFileSync(OBLIGATIONS, "utf8"));
  const process_conformance = JSON.parse(readFileSync(LOOKUP, "utf8"));
  const view = buildAgencyConstellationView(PARKS, {
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
  assert.match(html, /data-observation-status=/);
  assert.match(html, /expected vs observed|City Record/i);
  assert.match(html, /Share this mandates view|Mandates expected vs observed/);
  assert.doesNotMatch(html, /not a compliance|not a verdict|ignored the law|out of compliance|missed its mandate/i);
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
            deadline: { computed_date: "2020-01-01", text: null },
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
