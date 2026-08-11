import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  REPORTS_DOMAIN_SCHEMA,
  buildReportsDomainDocument,
  isAnnualReportPublicationTitle,
  isReportPublicationRow,
  mandateRequiresCityRecordAnnualReport,
  stampReportObservationRow,
} from "../site/reports_domain_observations.mjs";
import {
  collectAgencyObservationCandidates,
  resolveMandateObservation,
  scoreTopicMatch,
  OBSERVATION_STATUS,
} from "../site/process_conformance.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(ROOT, "test/fixtures/reports_domain_observations.json");
const COMMITTED = join(ROOT, "site/data/reports_domain_observations.json");

test("report publication classifier keeps annual reports and drops concept / procurement noise", () => {
  assert.equal(isReportPublicationRow({
    short_title: "NYC Commission on Human Rights FY25 Annual Report",
    section_name: "Special Materials",
  }), true);
  assert.equal(isAnnualReportPublicationTitle("FY24 CCHR Annual Report"), true);
  assert.equal(isReportPublicationRow({
    short_title: "Notice of Concept Report for Article 16 Outpatient Clinic Services",
    section_name: "Special Materials",
  }), false);
  assert.equal(isReportPublicationRow({
    short_title: "Waste Characterization Study",
    section_name: "Procurement",
    type_of_notice_description: "Solicitation",
  }), false);
  assert.equal(isReportPublicationRow({
    short_title: "Crystal Reports Professional Maintenance",
    section_name: "Special Materials",
  }), false);
});

test("City Record annual-report duty detector is structural", () => {
  assert.equal(
    mandateRequiresCityRecordAnnualReport(
      "Submit an annual report to the mayor and the council, publish it in the City Record.",
    ),
    true,
  );
  assert.equal(
    mandateRequiresCityRecordAnnualReport("Submit a quarterly progress update to the mayor."),
    false,
  );
});

test("structural annual-report join fires for CCHR field case", () => {
  const score = scoreTopicMatch(
    "Submit an annual report to the mayor and the council, publish it in the City Record, and include specified information.",
    {
      label: "NYC Commission on Human Rights FY25 Annual Report",
      signal_kind: "report_or_study",
      domain: "reports",
      annual_report: true,
      tokens: ["commission", "human", "rights", "annual"],
    },
  );
  assert.equal(score.method, "city_record_annual_report_publication_v1");
  assert.ok(score.score >= 2);
  assert.deepEqual(score.shared, ["annual", "report"]);
});

test("stamp + resolve produce a filing receipt without fabricating non-matches", () => {
  const stamped = stampReportObservationRow({
    request_id: "20251001039",
    agency_name: "Commission on Human Rights",
    short_title: "NYC Commission on Human Rights FY25 Annual Report",
    start_date: "2025-10-01T00:00:00.000",
    section_name: "Special Materials",
    type_of_notice_description: "Notice",
  });
  assert.ok(stamped);
  assert.equal(stamped.signal_kind, "report_or_study");
  assert.equal(stamped.report_evidence.annual_report, true);

  const observed = resolveMandateObservation({
    obligation_id: "53107-001",
    agency_id: "commission-on-human-rights",
    deliverable_type: "report",
    duty_text: "Submit an annual report to the mayor and the council, publish it in the City Record, and include specified information regarding inquiries.",
    deadline: { computed_date: "2025-12-31" },
  }, [ {
    ...stamped,
    agency_id: "commission-on-human-rights",
    label: stamped.short_title,
    when: "2025-10-01",
    signal_kind: "report_or_study",
    domain: "reports",
    annual_report: true,
    tokens: stamped.report_evidence.topic_keys,
  } ], { asOf: "2026-08-01" });
  assert.equal(observed.status, OBSERVATION_STATUS.OBSERVED);
  assert.equal(observed.observed_record.request_id, "20251001039");

  const miss = resolveMandateObservation({
    obligation_id: "x",
    agency_id: "commission-on-human-rights",
    deliverable_type: "report",
    duty_text: "Submit a climate survey results report to the mayor.",
    deadline: { computed_date: "2025-12-31" },
  }, [ {
    ...stamped,
    agency_id: "commission-on-human-rights",
    label: stamped.short_title,
    when: "2025-10-01",
    signal_kind: "report_or_study",
    domain: "reports",
    annual_report: true,
    tokens: stamped.report_evidence.topic_keys,
  } ], { asOf: "2026-08-01" });
  assert.notEqual(miss.status, OBSERVATION_STATUS.OBSERVED);
});

test("fixture and committed reports domain documents are non-empty and schema-valid", () => {
  assert.ok(existsSync(FIXTURE), "fixture required");
  const fixture = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const doc = buildReportsDomainDocument(fixture.rows || fixture);
  assert.equal(doc.schema, REPORTS_DOMAIN_SCHEMA);
  assert.ok(doc.row_count >= 3);
  assert.ok(doc.rows.every((row) => row.signal_kind === "report_or_study"));
  assert.ok(doc.rows.some((row) => /annual report/i.test(row.short_title)));

  if (existsSync(COMMITTED)) {
    const live = JSON.parse(readFileSync(COMMITTED, "utf8"));
    assert.equal(live.schema, REPORTS_DOMAIN_SCHEMA);
    assert.ok(live.row_count >= 1);
  }
});

test("collectAgencyObservationCandidates includes densified reports corpus", () => {
  const reportsDomain = buildReportsDomainDocument(
    JSON.parse(readFileSync(FIXTURE, "utf8")).rows,
  );
  const cands = collectAgencyObservationCandidates({
    agencyId: "commission-on-human-rights",
    reportsDomain,
  });
  assert.ok(cands.some((row) => row.signal_kind === "report_or_study" && /annual report/i.test(row.label)));
  assert.ok(cands.every((row) => row.agency_id === "commission-on-human-rights"));
});
