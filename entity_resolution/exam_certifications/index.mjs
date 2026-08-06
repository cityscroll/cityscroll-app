// Publisher-backed civil-service certification edges.
//
// This module intentionally consumes grouped source rows. It never accepts or
// emits candidate names, ranks, or matcher candidates. Agency identity is a
// canonical route derived from the publisher's list_agency_desc label; an
// empty label is a coverage block, not an inference opportunity.

import { canonicalAgency } from "../normalizers/agency.mjs";
import { formatSubjectRef, makeSubjectLink } from "../../worker/src/lib/subject_registry.mjs";

export const CERTIFIED_TO_AGENCY = "certified_to_agency";
export const CERTIFIED_TO_AGENCY_LABEL = "Certified to agency";
export const CERTIFICATION_SOURCE_DATASET = "a9md-ynri";
export const CERTIFICATION_SOURCE_SYSTEM = "socrata";
export const CERTIFICATION_METHOD = "publisher_certification_record_v1";
export const CERTIFICATION_METHOD_VERSION = "1";

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

export function normalizeExamNumber(value) {
  const raw = clean(value);
  if (!raw) return "";
  if (/^\d+$/.test(raw)) return String(Number(raw));
  return raw;
}

export function examSubjectRef(value) {
  const id = normalizeExamNumber(value);
  return id ? formatSubjectRef("exam", id) : null;
}

function numeric(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function dateOnly(value) {
  const text = clean(value);
  return text ? text.slice(0, 10) : null;
}

function sourceCount(row) {
  return Math.max(1, numeric(row.certification_record_count || row.source_record_count));
}

function edgeKey(examRef, agencyRef) {
  return `${examRef}|${agencyRef}`;
}

function agencyForRow(row) {
  const raw = clean(row.list_agency_desc);
  if (!raw) return null;
  const identity = canonicalAgency(raw);
  if (!identity.canonical_id) return null;
  return {
    raw_name: raw,
    canonical_id: identity.canonical_id,
    canonical_name: identity.canonical_name || raw,
    ref: formatSubjectRef("agency", `id:${identity.canonical_id}`),
  };
}

function mergeEdge(previous, row, agency) {
  const recordCount = sourceCount(row);
  const first = dateOnly(row.first_cert_date || row.cert_date);
  const last = dateOnly(row.last_cert_date || row.cert_date);
  previous.counts.source_records += recordCount;
  previous.counts.certified += numeric(row.certified_count || row.no_certified);
  previous.counts.requested += numeric(row.requested_count || row.no_requested);
  previous.counts.vacancies += numeric(row.vacancy_count || row.no_vacancies);
  if (first && (!previous.observed.from || first < previous.observed.from)) previous.observed.from = first;
  if (last && (!previous.observed.through || last > previous.observed.through)) previous.observed.through = last;
  if (row.list_agency_code) previous.source_agency_codes.add(clean(row.list_agency_code));
  previous.source_agency_labels.add(agency.raw_name);
}

/**
 * Build exact publisher-issued exam → agency edges from grouped rows.
 *
 * A grouped row may contain certification_record_count/source_record_count
 * and sums from a Socrata aggregation query, or one raw source row. The
 * returned graph is safe for public materialization: only aggregate counts,
 * canonical identities, and source provenance are retained.
 */
export function buildCertificationEdges(rows = [], options = {}) {
  const observedOn = dateOnly(options.observedOn) || null;
  const datasetId = clean(options.datasetId) || CERTIFICATION_SOURCE_DATASET;
  const sourceSystem = clean(options.sourceSystem) || CERTIFICATION_SOURCE_SYSTEM;
  const edgeMap = new Map();
  const blocked = {
    missing_exam: 0,
    missing_agency_label: 0,
    invalid_agency_identity: 0,
  };
  let groupedRows = 0;
  let sourceRows = 0;

  for (const row of Array.isArray(rows) ? rows : []) {
    groupedRows += 1;
    const rowCount = sourceCount(row);
    sourceRows += rowCount;
    const exam = examSubjectRef(row.exam_no || row.exam_number);
    if (!exam) {
      blocked.missing_exam += rowCount;
      continue;
    }
    const agency = agencyForRow(row);
    if (!agency) {
      if (!clean(row.list_agency_desc)) blocked.missing_agency_label += rowCount;
      else blocked.invalid_agency_identity += rowCount;
      continue;
    }
    const key = edgeKey(exam, agency.ref);
    let edge = edgeMap.get(key);
    if (!edge) {
      const sourceRecordId = `${datasetId}:exam:${normalizeExamNumber(row.exam_no || row.exam_number)}:agency:${clean(row.list_agency_code) || agency.canonical_id}`;
      const base = makeSubjectLink({
        type: CERTIFIED_TO_AGENCY,
        from: exam,
        to: agency.ref,
        method: CERTIFICATION_METHOD,
        method_version: CERTIFICATION_METHOD_VERSION,
        confidence: "publisher_record",
        evidence: {
          source_system: sourceSystem,
          source_record_id: sourceRecordId,
          source_fields: [
            "exam_no",
            "list_agency_code",
            "list_agency_desc",
            "cert_date",
            "no_certified",
            "no_requested",
            "no_vacancies",
          ],
          basis: "publisher_certification_record",
          observed_at: observedOn,
          input_value: agency.raw_name,
        },
      });
      if (!base) {
        blocked.invalid_agency_identity += rowCount;
        continue;
      }
      edge = {
        ...base,
        id: edgeKey(exam, agency.ref),
        agency_name: agency.canonical_name,
        label: CERTIFIED_TO_AGENCY_LABEL,
        counts: { source_records: 0, certified: 0, requested: 0, vacancies: 0 },
        observed: { from: null, through: null },
        source_exam_numbers: new Set(),
        source_agency_codes: new Set(),
        source_agency_labels: new Set(),
      };
      edgeMap.set(key, edge);
    }
    edge.source_exam_numbers.add(clean(row.exam_no || row.exam_number));
    mergeEdge(edge, row, agency);
  }

  const edges = [...edgeMap.values()].map((edge) => ({
    ...edge,
    source_exam_numbers: [...edge.source_exam_numbers].filter(Boolean).sort(),
    source_agency_codes: [...edge.source_agency_codes].filter(Boolean).sort(),
    source_agency_labels: [...edge.source_agency_labels].filter(Boolean).sort(),
  })).sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  const byExam = new Map();
  const byAgency = new Map();
  for (const edge of edges) {
    if (!byExam.has(edge.from)) byExam.set(edge.from, []);
    byExam.get(edge.from).push(edge);
    if (!byAgency.has(edge.to)) byAgency.set(edge.to, []);
    byAgency.get(edge.to).push(edge);
  }

  const examConstellation = [...byExam.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([ref, examEdges]) => ({
    ref,
    exam_no: ref.slice("exam:".length),
    relation: CERTIFIED_TO_AGENCY,
    edge_count: examEdges.length,
    counts: {
      source_records: examEdges.reduce((n, edge) => n + edge.counts.source_records, 0),
      certified: examEdges.reduce((n, edge) => n + edge.counts.certified, 0),
      requested: examEdges.reduce((n, edge) => n + edge.counts.requested, 0),
      vacancies: examEdges.reduce((n, edge) => n + edge.counts.vacancies, 0),
    },
    edge_refs: examEdges.map((edge) => edge.id),
  }));
  const agencyConstellation = [...byAgency.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([ref, agencyEdges]) => ({
    ref,
    agency_id: ref.replace(/^agency:id:/, ""),
    agency_name: agencyEdges[0].agency_name,
    relation: CERTIFIED_TO_AGENCY,
    edge_count: agencyEdges.length,
    counts: {
      source_records: agencyEdges.reduce((n, edge) => n + edge.counts.source_records, 0),
      certified: agencyEdges.reduce((n, edge) => n + edge.counts.certified, 0),
      requested: agencyEdges.reduce((n, edge) => n + edge.counts.requested, 0),
      vacancies: agencyEdges.reduce((n, edge) => n + edge.counts.vacancies, 0),
    },
    edge_refs: agencyEdges.map((edge) => edge.id),
  }));

  return {
    relation: {
      type: CERTIFIED_TO_AGENCY,
      label: CERTIFIED_TO_AGENCY_LABEL,
      evidence: "Publisher-issued certification records state that a list was certified at the request of an agency.",
      distinction: "This is separate from appointing_agency, which describes the agency on a hire or appointment record.",
      confidence: "publisher_record",
      candidates_rendered: false,
    },
    source: {
      system: sourceSystem,
      dataset_id: datasetId,
      observed_on: observedOn,
      privacy: "Grouped counts only; candidate names, ranks, and per-person rows are not retained.",
    },
    coverage: {
      grouped_rows: groupedRows,
      source_rows: Number.isFinite(Number(options.sourceRowCount))
        ? Number(options.sourceRowCount)
        : sourceRows,
      published_edges: edges.length,
      exams_with_edges: examConstellation.length,
      agencies_with_edges: agencyConstellation.length,
      blocked_rows: blocked,
      blocked_total: Object.values(blocked).reduce((n, count) => n + count, 0),
      status: edges.length ? "qualified_publisher_edges" : "not_yet_ingested",
    },
    edges,
    by_exam: examConstellation,
    by_agency: agencyConstellation,
  };
}
