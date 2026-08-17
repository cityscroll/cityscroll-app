#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { buildAgencySearchDocuments } from "../site/agency_search_producer.mjs";
import { buildExamSearchDocuments } from "../site/exam_search_producer.mjs";
import { buildLandSearchDocuments } from "../site/land_search_producer.mjs";
import { buildMeetingSearchDocuments } from "../site/meeting_search_producer.mjs";
import { buildPeopleSearchDocuments } from "../site/people_search_producer.mjs";

const ROOT = new URL("../", import.meta.url);
const OUTPUT = new URL("../worker/src/data/keyword_search_index.json", import.meta.url);

function json(relative) {
  return JSON.parse(readFileSync(new URL(relative, ROOT), "utf8"));
}

function latestClock(...values) {
  return values
    .flatMap((value) => String(value || "").split("|"))
    .map((value) => value.trim())
    .filter(Boolean)
    .sort()
    .at(-1) || null;
}

function compactDocument(document) {
  const provenance = document?.provenance || {};
  return {
    schema: document.schema,
    object_ref: document.object_ref,
    object_type: document.object_type,
    domain: document.domain,
    canonical_href: document.canonical_href,
    title: document.title,
    summary: document.summary,
    search_text: document.search_text,
    source_family: document.source_family,
    source_observation_refs: document.source_observation_refs,
    process_role: document.process_role,
    classification: document.classification,
    provenance: {
      producer: provenance.producer,
      source_system: provenance.source_system || provenance.source_contract || null,
      source_freshness: provenance.source_freshness || {
        generated_at: provenance.read_model_generated_at
          || provenance.materialized_at
          || provenance.source_retrieved_at
          || null,
      },
    },
    outcome: document.outcome || "indexed",
    coverage_state: document.coverage_state || "matched",
  };
}

function family(source, asOf, corpora) {
  const documents = corpora.flatMap((corpus) => corpus.documents || []).map(compactDocument);
  return {
    source,
    as_of: asOf || null,
    source_row_count: corpora.reduce((sum, corpus) => (
      sum + Number(corpus.coverage?.source_count ?? corpus.coverage?.total_count ?? corpus.counts?.total ?? 0)
    ), 0),
    indexed_count: documents.length,
    coverage: corpora.map((corpus) => corpus.coverage || corpus.counts || null),
    documents,
  };
}

const people = json("site/data/person_hub_lookup.json");
const agencies = json("site/data/agency_constellation_lookup.json");
const land = json("site/data/zap_projects_warehouse_lookup.json");
const meetings = json("site/data/shared_meeting_read_model.json");
const exams = json("site/data/staffing_exams.json");

const output = {
  schema: "cityscroll.keyword_search_index.v1",
  generated_at: latestClock(
    people.retrieved_at,
    agencies.generated_at,
    land.materialized_at,
    meetings.generated_at,
    exams.generated_at,
  ),
  match_mode: "keyword",
  families: {
    "people-organizations": family(
      "NYC Council people and CityScroll agency profiles",
      latestClock(people.retrieved_at, agencies.generated_at),
      [buildPeopleSearchDocuments(people), buildAgencySearchDocuments(agencies)],
    ),
    land: family(
      "NYC Open Data Zoning Application Portal projects",
      land.materialized_at,
      [buildLandSearchDocuments(land)],
    ),
    meetings: family(
      "City Record and official community-board meeting snapshots",
      meetings.generated_at,
      [buildMeetingSearchDocuments(meetings)],
    ),
    exams: family(
      "Department of Citywide Administrative Services exam schedule",
      exams.data_current_as_of || exams.generated_at,
      [buildExamSearchDocuments(exams)],
    ),
  },
  build_receipt: {
    source_artifacts: {
      people: "site/data/person_hub_lookup.json",
      agencies: "site/data/agency_constellation_lookup.json",
      land: "site/data/zap_projects_warehouse_lookup.json",
      meetings: "site/data/shared_meeting_read_model.json",
      exams: "site/data/staffing_exams.json",
    },
    excluded_artifacts: ["worker/src/data/ocp_awards_warehouse_lookup.json"],
  },
};

const serialized = `${JSON.stringify(output, null, 2)}\n`;
if (process.argv.includes("--check")) {
  if (readFileSync(OUTPUT, "utf8") !== serialized) {
    console.error(`stale keyword search index: ${fileURLToPath(OUTPUT)}`);
    process.exit(1);
  }
  console.log(`keyword search index current (${serialized.length} bytes)`);
} else {
  writeFileSync(OUTPUT, serialized);
  console.log(`wrote ${fileURLToPath(OUTPUT)} (${serialized.length} bytes)`);
}
