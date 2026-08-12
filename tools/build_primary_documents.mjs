#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { BROWSE_FACETS } from "../site/browse_view.mjs";
import { BROWSE_CONCEPTS } from "../site/browse_concept_view.mjs";
import {
  buildBrowseDocument,
  buildBrowseLandingDocument,
  buildBrowseConceptDocument,
  buildNowDocument,
} from "../site/primary_document_view.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = join(ROOT, "site");

function json(path) {
  return JSON.parse(readFileSync(join(SITE, path.replace(/^\//, "")), "utf8"));
}

function output(path, content) {
  return [join(SITE, path, "index.html"), content];
}

export function primaryDocumentOutputs() {
  const shell = readFileSync(join(SITE, "index.html"), "utf8");
  const payloads = Object.fromEntries(Object.entries(BROWSE_FACETS).map(([facet, config]) => [facet, json(config.dataPath)]));
  const nowSources = {
    money: { ...payloads.contracts, status: "available" },
    staffing: { ...json("/data/staffing_exams.json"), status: "available" },
    land: { ...json("/data/land_upcoming_hearings.json"), status: "available" },
    rules: { status: "unavailable", reason: "edge_refresh", rules: [] },
    property: { status: "unavailable", reason: "edge_refresh", properties: [] },
    meetings: { status: "unavailable", reason: "edge_refresh", hearings: [] },
  };
  const outputs = [output("now", buildNowDocument(shell, nowSources))];
  const staffingExams = json("/data/staffing_exams.json");
  const awards = json("/data/ocp_awards_warehouse_lookup.json");
  const landProjects = json("/data/zap_projects_warehouse_lookup.json");
  const property = json("/data/property_domain_observations.json");
  const obligations = json("/data/agency_obligations_lookup.json");
  const meetings = json("/data/meetings_domain_observations.json");
  const outcomes = json("/data/meeting_outcomes_snapshot.json");
  const people = json("/data/person_hub_lookup.json");
  const committees = json("/data/committee_graph_lookup.json");
  const agencies = json("/data/agency_constellation_lookup.json");
  const places = json("/data/community_board_geography_lookup.json");
  outputs.push(output("browse", buildBrowseLandingDocument(shell, payloads, {
    staffingExamCount: Array.isArray(staffingExams.exams) ? staffingExams.exams.length : 0,
    staffingExamAsOf: staffingExams.data_current_as_of,
    groupMetrics: {
      money: { facts: [
        { value: awards.row_count, label: "awards" },
        { value: payloads.contracts?.notices?.length ?? null, label: "open opportunities" },
      ] },
      "land-property": { facts: [
        { value: landProjects.row_count, label: "land projects" },
        { value: property.property_count, label: "property records" },
      ] },
      "rules-mandates": { facts: [
        { value: obligations.summary?.obligation_count ?? null, label: "obligations" },
        { value: obligations.summary?.with_deadline_signal_count ?? null, label: "deadline signals" },
      ] },
      "meetings-decisions": { facts: [
        { value: meetings.row_count, label: "meeting rows" },
        { value: outcomes.present_count, label: "outcome snapshots" },
      ] },
      "people-organizations": { facts: [
        { value: people.person_count, label: "people" },
        { value: committees.observations?.length ?? null, label: "committee edges" },
        { value: agencies.agency_count, label: "agencies" },
      ] },
      places: { facts: [
        { value: places.inventory?.boards_inventoried ?? null, label: "boards" },
        { value: places.receipt?.pair_count ?? null, label: "district intersections" },
      ] },
    },
  })));
  const conceptSources = {
    people,
    committees,
    awards,
    places,
  };
  for (const kind of Object.keys(BROWSE_CONCEPTS)) {
    outputs.push(output(`browse/${kind}`, buildBrowseConceptDocument(shell, kind, conceptSources)));
  }
  for (const [facet, payload] of Object.entries(payloads)) {
    outputs.push(output(`browse/${facet}`, buildBrowseDocument(shell, facet, payload, new URLSearchParams(), { route: `/browse/${facet}/` })));
  }
  return outputs;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const check = process.argv.includes("--check");
  let stale = 0;
  for (const [path, content] of primaryDocumentOutputs()) {
    if (!existsSync(path)) {
      if (!check) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content);
        console.log("wrote", path);
      }
      continue;
    }
    if (existsSync(path) && readFileSync(path, "utf8") === content) continue;
    stale += 1;
    if (!check) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
      console.log("wrote", path);
    }
  }
  if (check && stale) {
    console.error(`${stale} primary document artifact(s) are stale`);
    process.exit(1);
  }
  console.log(check ? "Primary documents are current" : "Primary documents built");
}
