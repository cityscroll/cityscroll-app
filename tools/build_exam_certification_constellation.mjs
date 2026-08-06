#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildCertificationEdges,
  CERTIFICATION_SOURCE_DATASET,
  CERTIFICATION_SOURCE_SYSTEM,
  CERTIFIED_TO_AGENCY,
  CERTIFIED_TO_AGENCY_LABEL,
  normalizeExamNumber,
} from "../entity_resolution/exam_certifications/index.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = join(ROOT, "site/data/exam_certification_constellation.json");
const DATASET_URL = `https://data.cityofnewyork.us/resource/${CERTIFICATION_SOURCE_DATASET}.json`;
const LANDING_PAGE = `https://data.cityofnewyork.us/d/${CERTIFICATION_SOURCE_DATASET}`;
const GROUP_SELECT = [
  "exam_no",
  "list_agency_code",
  "list_agency_desc",
  "count(*) as certification_record_count",
  "sum(no_certified) as certified_count",
  "sum(no_requested) as requested_count",
  "sum(no_vacancies) as vacancy_count",
  "min(cert_date) as first_cert_date",
  "max(cert_date) as last_cert_date",
].join(",");

function stableJson(value) {
  return JSON.stringify(value, null, 2) + "\n";
}

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`a9md-ynri request failed (${response.status})`);
  return response.json();
}

async function fetchRows() {
  const countUrl = new URL(DATASET_URL);
  countUrl.searchParams.set("$select", "count(*) as n");
  const groupedUrl = new URL(DATASET_URL);
  groupedUrl.searchParams.set("$select", GROUP_SELECT);
  groupedUrl.searchParams.set("$group", "exam_no,list_agency_code,list_agency_desc");
  groupedUrl.searchParams.set("$limit", "50000");
  const [count, grouped] = await Promise.all([getJson(countUrl), getJson(groupedUrl)]);
  const sourceRowCount = Number(count?.[0]?.n || 0);
  if (!sourceRowCount || !Array.isArray(grouped) || !grouped.length) {
    throw new Error("a9md-ynri returned no usable certification rows");
  }
  return { sourceRowCount, groupedRows: grouped };
}

function staffingTitles() {
  const path = join(ROOT, "site/data/staffing_exams.json");
  if (!existsSync(path)) return new Map();
  const artifact = JSON.parse(readFileSync(path, "utf8"));
  return new Map((artifact.exams || []).map((row) => [normalizeExamNumber(row.exam_number), row.title || null]));
}

function addExamTitles(materialization) {
  const titles = staffingTitles();
  return {
    ...materialization,
    by_exam: materialization.by_exam.map((exam) => ({
      ...exam,
      title: titles.get(normalizeExamNumber(exam.exam_no)) || null,
    })),
  };
}

export function buildExamCertificationMaterialization({ groupedRows, sourceRowCount, observedOn }) {
  const materialization = buildCertificationEdges(groupedRows, {
    observedOn,
    datasetId: CERTIFICATION_SOURCE_DATASET,
    sourceSystem: CERTIFICATION_SOURCE_SYSTEM,
    sourceRowCount,
  });
  const titled = addExamTitles(materialization);
  return {
    schema_version: 1,
    generated_at: `${observedOn}T00:00:00Z`,
    relation: materialization.relation,
    source: {
      ...materialization.source,
      landing_page: LANDING_PAGE,
      endpoint: DATASET_URL,
      query: {
        shape: "Socrata grouped aggregate",
        group_by: ["exam_no", "list_agency_code", "list_agency_desc"],
        fields: GROUP_SELECT.split(","),
      },
    },
    coverage: {
      ...materialization.coverage,
      note: "Published edges require a non-empty publisher agency label and exact exam_no; blocked rows remain outside both constellations.",
    },
    edges: materialization.edges,
    by_exam: titled.by_exam,
    by_agency: materialization.by_agency,
  };
}

export function validateExamCertificationMaterialization(artifact) {
  const errors = [];
  if (artifact?.schema_version !== 1) errors.push("schema_version must be 1");
  if (artifact?.relation?.type !== CERTIFIED_TO_AGENCY) errors.push("relation type must be certified_to_agency");
  if (artifact?.relation?.label !== CERTIFIED_TO_AGENCY_LABEL) errors.push("relation label drifted");
  if (artifact?.relation?.confidence !== "publisher_record") errors.push("relation confidence must be publisher_record");
  if (artifact?.relation?.candidates_rendered !== false) errors.push("candidate edges must never render");
  if (artifact?.source?.dataset_id !== CERTIFICATION_SOURCE_DATASET) errors.push("source dataset drifted");
  for (const edge of artifact?.edges || []) {
    if (!edge.id) errors.push(`missing edge id: ${edge.from} → ${edge.to}`);
    if (edge.type !== CERTIFIED_TO_AGENCY) errors.push(`unsupported edge type: ${edge.type}`);
    if (edge.label !== CERTIFIED_TO_AGENCY_LABEL) errors.push(`edge label drifted: ${edge.id || edge.from}`);
    if (!/^exam:[^:]+$/.test(edge.from) || !/^agency:id:[^:]+$/.test(edge.to)) errors.push(`invalid edge endpoints: ${edge.from} → ${edge.to}`);
    if (edge.confidence !== "publisher_record") errors.push(`non-publisher edge: ${edge.from} → ${edge.to}`);
    if (!edge.evidence?.source_record_id || edge.evidence?.basis !== "publisher_certification_record") errors.push(`missing source evidence: ${edge.from} → ${edge.to}`);
    for (const key of ["source_records", "certified", "requested", "vacancies"]) {
      if (!Number.isFinite(Number(edge.counts?.[key])) || Number(edge.counts[key]) < 0) errors.push(`invalid ${key} count: ${edge.from} → ${edge.to}`);
    }
  }
  const edgeIds = new Set((artifact?.edges || []).map((edge) => edge.id));
  for (const constellation of [...(artifact?.by_exam || []), ...(artifact?.by_agency || [])]) {
    if (!Array.isArray(constellation.edge_refs)) errors.push(`missing edge refs: ${constellation.ref}`);
    for (const edgeRef of constellation.edge_refs || []) {
      if (!edgeIds.has(edgeRef)) errors.push(`unknown edge ref: ${edgeRef}`);
    }
  }
  if (Number(artifact?.coverage?.published_edges || 0) !== (artifact?.edges || []).length) errors.push("published edge count does not match edges");
  if (Number(artifact?.coverage?.blocked_total || 0) !== Object.values(artifact?.coverage?.blocked_rows || {}).reduce((n, value) => n + Number(value || 0), 0)) errors.push("blocked coverage total does not match blocked rows");
  return errors;
}

async function main() {
  const check = process.argv.includes("--check");
  const observedOn = process.argv.find((arg) => arg.startsWith("--observed-on="))?.split("=")[1]
    || new Date().toISOString().slice(0, 10);
  if (check) {
    const artifact = JSON.parse(readFileSync(OUTPUT, "utf8"));
    const errors = validateExamCertificationMaterialization(artifact);
    if (errors.length) throw new Error(errors.join("\n"));
    console.log(`exam certification constellation current: ${artifact.coverage.published_edges} edges observed ${artifact.source.observed_on}`);
    return;
  }
  const { sourceRowCount, groupedRows } = await fetchRows();
  const artifact = buildExamCertificationMaterialization({ groupedRows, sourceRowCount, observedOn });
  writeFileSync(OUTPUT, stableJson(artifact));
  console.log(`wrote ${OUTPUT}: ${artifact.coverage.published_edges} edges from ${sourceRowCount} source rows; blocked ${artifact.coverage.blocked_total}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
