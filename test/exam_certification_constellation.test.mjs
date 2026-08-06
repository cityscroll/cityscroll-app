import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildCertificationEdges,
  CERTIFIED_TO_AGENCY,
  CERTIFIED_TO_AGENCY_LABEL,
} from "../entity_resolution/exam_certifications/index.mjs";
import {
  validateExamCertificationMaterialization,
} from "../tools/build_exam_certification_constellation.mjs";
import { loadSourceContracts } from "../tools/source_contracts.mjs";
import { makeSubjectLink } from "../worker/src/lib/subject_registry.mjs";

const artifact = JSON.parse(readFileSync(
  new URL("../site/data/exam_certification_constellation.json", import.meta.url),
));

test("a9md source contract names the grouped certified_to_agency materialization", () => {
  const contract = loadSourceContracts().contracts.find((row) => row.id === "civil-service-list-certification");
  assert.equal(contract.status, "live");
  assert.equal(contract.delivery_tier, "edge-materialized");
  assert.deepEqual(contract.required_fields, [
    "exam_no",
    "list_agency_code",
    "list_agency_desc",
    "list_title_desc",
    "cert_date",
    "no_certified",
    "no_requested",
    "no_vacancies",
  ]);
  assert.match(contract.used_for, /certified_to_agency/);
  assert.match(contract.used_for, /appointing_agency/);
});
test("certification edges are exact publisher relations with canonical agency refs and counts", () => {
  const result = buildCertificationEdges([
    {
      exam_no: "07016",
      list_agency_code: "806",
      list_agency_desc: "HOUSING PRESERVATION & DVLPMNT",
      certification_record_count: "2",
      certified_count: "9",
      requested_count: "12",
      vacancy_count: "3",
      first_cert_date: "2025-01-01",
      last_cert_date: "2025-02-01",
    },
    {
      exam_no: "7016",
      list_agency_code: "806",
      list_agency_desc: "Department of Housing Preservation and Development",
      certification_record_count: "1",
      certified_count: "4",
      requested_count: "5",
      vacancy_count: "1",
      cert_date: "2025-03-01",
    },
    {
      exam_no: "07016",
      list_agency_code: "",
      list_agency_desc: "",
      certification_record_count: "7",
      certified_count: "99",
    },
  ], { observedOn: "2026-08-06", sourceRowCount: 10 });

  assert.equal(result.edges.length, 1);
  const edge = result.edges[0];
  assert.equal(edge.type, CERTIFIED_TO_AGENCY);
  assert.equal(edge.label, CERTIFIED_TO_AGENCY_LABEL);
  assert.equal(edge.from, "exam:7016");
  assert.equal(edge.to, "agency:id:housing-preservation-and-development");
  assert.equal(edge.confidence, "publisher_record");
  assert.deepEqual(edge.counts, { source_records: 3, certified: 13, requested: 17, vacancies: 4 });
  assert.equal(result.by_exam[0].edge_count, 1);
  assert.deepEqual(result.by_exam[0].edge_refs, [edge.id]);
  assert.equal(result.by_exam[0].counts.certified, 13);
  assert.equal(result.by_agency[0].agency_name, "Housing Preservation and Development");
  assert.equal(result.by_agency[0].edge_count, 1);
  assert.deepEqual(result.by_agency[0].edge_refs, [edge.id]);
  assert.equal(result.coverage.blocked_rows.missing_agency_label, 7);
  assert.equal(result.coverage.blocked_total, 7);
  assert.equal(result.relation.candidates_rendered, false);
  assert.equal(makeSubjectLink({ type: "certified_to_agency", from: "exam:7016", to: edge.to })?.type, CERTIFIED_TO_AGENCY);
  assert.equal(makeSubjectLink({ type: "published_by_agency", from: "exam:7016", to: edge.to })?.type, "published_by_agency");
});

test("committed certification materialization is conformance-green and privacy-safe", () => {
  assert.deepEqual(validateExamCertificationMaterialization(artifact), []);
  assert.equal(artifact.source.dataset_id, "a9md-ynri");
  assert.equal(artifact.source.observed_on, "2026-08-06");
  assert.ok(artifact.coverage.published_edges >= 6000);
  assert.ok(artifact.coverage.exams_with_edges >= 1000);
  assert.ok(artifact.coverage.agencies_with_edges >= 50);
  const serialized = JSON.stringify(artifact).toLowerCase();
  for (const forbidden of ["first_name", "last_name", "ssn", "cert_seq_no"]) {
    assert.equal(serialized.includes(forbidden), false, `privacy field leaked: ${forbidden}`);
  }
  assert.equal(new Set(artifact.edges.map((edge) => edge.type)).size, 1);
  assert.equal(artifact.edges.every((edge) => edge.type === CERTIFIED_TO_AGENCY), true);
});
