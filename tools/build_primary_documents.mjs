#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { BROWSE_FACETS } from "../site/browse_view.mjs";
import { BROWSE_CONCEPTS } from "../site/browse_concept_view.mjs";
import {
  buildBrowseDocument,
  buildBrowseLandingDocument,
  buildBrowseExamsDocument,
  buildBrowseConceptDocument,
  buildNowDocument,
} from "../site/primary_document_view.mjs";
import { buildSharedMeetingReadModel } from "../site/shared_meeting_read_model.mjs";
import { eligibleCityRecordMeetings } from "../site/city_record_meeting.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = join(ROOT, "site");

function json(path) {
  return JSON.parse(readFileSync(join(SITE, path.replace(/^\//, "")), "utf8"));
}

function output(path, content) {
  return [join(SITE, path, "index.html"), content];
}

function cityRecordMeetingRows() {
  const materialization = json("/data/meeting_notice_materialization.json");
  const rows = eligibleCityRecordMeetings(materialization.rows);
  if (!rows.length || rows.length !== materialization.row_count) {
    throw new Error("City Record meeting notice materialization is empty or predicate coverage drifted");
  }
  return { materialization, rows };
}

function assertMeetingCoverage(readModel, cityRows) {
  const expectedIds = new Set(cityRows.map((row) => `meeting:city_record:${row.request_id}`).filter((id) => !id.endsWith(":undefined")));
  if (readModel.counts.city_record !== expectedIds.size) {
    throw new Error(`shared meeting model materialized ${readModel.counts.city_record}/${expectedIds.size} eligible City Record meetings`);
  }
  for (const requestId of ["20260810053", "20260713006"]) {
    const row = readModel.rows.find((candidate) => candidate.meeting_id === `meeting:city_record:${requestId}`);
    if (!row) throw new Error(`required City Record meeting ${requestId} is missing from the shared read model`);
    const hasNoticeBody = [row.additional_description_1, row.additional_description_2, row.other_info_1, row.other_info_2, row.other_info_3]
      .some((value) => String(value || "").trim());
    const hasRichSignal = [row.street_address_1, row.building_name, row.contact_name, row.contact_phone, row.email, row.document_links, row.source_links]
      .some((value) => Array.isArray(value) ? value.length > 0 : String(value || "").trim());
    if (!hasNoticeBody || !hasRichSignal) {
      throw new Error(`required City Record meeting ${requestId} lacks materialized notice richness`);
    }
  }
}

export function primaryDocumentOutputs() {
  const shell = readFileSync(join(SITE, "index.html"), "utf8");
  const payloads = Object.fromEntries(Object.entries(BROWSE_FACETS).map(([facet, config]) => [facet, json(config.dataPath)]));
  const { materialization, rows: cityRecordMeetings } = cityRecordMeetingRows();
  // Keep previously published meeting identities while the current, rich
  // notice materialization supplies the complete eligible window. The rich
  // rows come first so an exact id is upgraded rather than duplicated.
  const cityRecordRows = [...cityRecordMeetings, ...(payloads.meetings.rows || [])];
  const communityBoardMeetings = json("/data/community_board_meeting_index.json");
  const sharedMeetings = buildSharedMeetingReadModel({
    cityRecordRows,
    communityBoardIndex: communityBoardMeetings,
    generatedAt: materialization.generated_at,
    now: communityBoardMeetings.generated_at || materialization.generated_at,
  });
  assertMeetingCoverage(sharedMeetings, cityRecordRows);
  payloads.meetings = {
    ...payloads.meetings,
    ...sharedMeetings,
    rows: sharedMeetings.rows,
    row_count: sharedMeetings.rows.length,
    retrieved_at: sharedMeetings.generated_at || materialization.generated_at,
  };
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
  const meetings = payloads.meetings;
  const outcomes = json("/data/meeting_outcomes_snapshot.json");
  const people = json("/data/person_hub_lookup.json");
  const committees = json("/data/committee_graph_lookup.json");
  const agencies = json("/data/agency_constellation_lookup.json");
  const places = json("/data/community_board_geography_lookup.json");
  const hires = json("/data/staffing_default_hires.json");
  outputs.push(output("browse", buildBrowseLandingDocument(shell, payloads, {
    staffingExamCount: Array.isArray(staffingExams.exams) ? staffingExams.exams.length : 0,
    staffingExamAsOf: staffingExams.data_current_as_of,
    groupMetrics: {
      money: { facts: [
        { value: awards.row_count, label: "awards" },
        { value: payloads.contracts?.notices?.length ?? null, label: "open opportunities" },
      ] },
      exams: {
        count: staffingExams.exams?.length ?? null,
        countLabel: "civil-service exams",
        facts: [{ value: staffingExams.exams?.length ?? null, label: "civil-service exams" }],
      },
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
  outputs.push(output("browse/exams", buildBrowseExamsDocument(shell, staffingExams)));
  const conceptSources = {
    people,
    committees,
    agencies,
    awards,
    places,
    hires,
  };
  for (const kind of Object.keys(BROWSE_CONCEPTS)) {
    outputs.push(output(`browse/${kind}`, buildBrowseConceptDocument(shell, kind, conceptSources)));
  }
  for (const [facet, payload] of Object.entries(payloads)) {
    outputs.push(output(`browse/${facet}`, buildBrowseDocument(shell, facet, payload, new URLSearchParams(), { route: `/browse/${facet}/` })));
  }
  return outputs;
}

function buildSharedMeetingArtifacts() {
  const payloads = Object.fromEntries(Object.entries(BROWSE_FACETS).map(([facet, config]) => [facet, json(config.dataPath)]));
  const { materialization, rows: cityRecordMeetings } = cityRecordMeetingRows();
  const cityRecordRows = [...cityRecordMeetings, ...(payloads.meetings.rows || [])];
  const communityBoardMeetings = json("/data/community_board_meeting_index.json");
  const sharedMeetings = buildSharedMeetingReadModel({
    cityRecordRows,
    communityBoardIndex: communityBoardMeetings,
    generatedAt: materialization.generated_at,
    now: communityBoardMeetings.generated_at || materialization.generated_at,
  });
  assertMeetingCoverage(sharedMeetings, cityRecordRows);
  return { sharedMeetings };
}

export function sharedMeetingOutputs() {
  const { sharedMeetings } = buildSharedMeetingArtifacts();
  return [[
    join(SITE, "data/shared_meeting_read_model.json"),
    `${JSON.stringify(sharedMeetings, null, 2)}\n`,
  ]];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const check = process.argv.includes("--check");
  let stale = 0;
  for (const [path, content] of [...primaryDocumentOutputs(), ...sharedMeetingOutputs()]) {
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
