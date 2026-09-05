#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { BROWSE_FACETS } from "../site/browse_view.mjs";
import { nyNaiveTimestampToInstantMs } from "../site/resident_snapshot_queries.mjs";
import { BROWSE_CONCEPTS } from "../site/browse_concept_view.mjs";
import {
  buildBrowseDocument,
  buildBrowseLandingDocument,
  buildBrowseConceptDocument,
  buildNowDocument,
  buildSearchDocument,
} from "../site/primary_document_view.mjs";
import { buildExamsDocument } from "../site/exams_surface.mjs";
import { buildStaffingDocument } from "../site/staffing_surface.mjs";
import { buildSharedMeetingReadModel } from "../site/shared_meeting_read_model.mjs";
import { readCommunityBoardMeetingIndex } from "./lib/community_board_meeting_index_io.mjs";
import { eligibleCityRecordMeetings } from "../site/city_record_meeting.mjs";
import { normalizeHearing } from "../worker/src/lib/hearings.mjs";
import { EXAMS_SURFACE, PEOPLE_ORGANIZATIONS_SURFACE, STAFFING_SURFACE } from "../site/browse_surface_contracts.mjs";
import { buildPeopleOrganizationsReadModel } from "../site/people_organizations_read_model.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = join(ROOT, "site");

// A caller that wants one instant shared across several invocations of this
// build within the same run (the pre-push preflight checks these outputs,
// runs a multi-minute test suite, then a local site build regenerates them
// again) sets CROL_BUILD_DAY once for that run instead of letting each call
// default to its own new Date(). Unset (the ordinary production build and
// every existing caller that never passed one) resolves to null exactly as
// before, so this changes nothing outside a caller that opts in.
export function resolvePinnedBuildClock(env = process.env) {
  const pinned = env.CROL_BUILD_DAY;
  if (!pinned) return null;
  const instantMs = /^\d{4}-\d{2}-\d{2}$/.test(pinned)
    ? nyNaiveTimestampToInstantMs(`${pinned}T00:00:00`)
    : Date.parse(pinned);
  if (!Number.isFinite(instantMs)) throw new Error(`Invalid CROL_BUILD_DAY value: ${pinned}`);
  return new Date(instantMs);
}

function json(path) {
  if (path === "/data/community_board_meeting_index.json") {
    return readCommunityBoardMeetingIndex(new URL("../site/data/community_board_meeting_index.json", import.meta.url));
  }
  return JSON.parse(readFileSync(join(SITE, path.replace(/^\//, "")), "utf8"));
}

function output(path, content) {
  return [join(SITE, path, "index.html"), content];
}

function surfaceOutputPath(surface) {
  return surface.canonicalRoute.replace(/^\/+|\/+$/g, "");
}

function cityRecordMeetingRows() {
  const materialization = json("/data/meeting_notice_materialization.json");
  const sourceRows = eligibleCityRecordMeetings(materialization.rows);
  if (!sourceRows.length || sourceRows.length !== materialization.row_count) {
    throw new Error("City Record meeting notice materialization is empty or predicate coverage drifted");
  }
  // Match the daily Worker producer: the shared read model receives the
  // hearing adapter's normalized venue, participation, origin, and affected
  // area alongside the retained City Record notice fields.
  const rows = sourceRows.map((row) => ({ ...row, ...normalizeHearing(row) }));
  return { materialization, rows };
}

// Regression floors for build-time City Record notice richness. The City Record
// acquisition serves a rolling forward window, so which individual meetings are
// materialized changes every day; only the population is stable enough to gate a
// deploy on. Both numbers sit well under the observed population -- on
// 2026-09-05 the live window materialized 39 eligible notices of which 29
// carried both a notice body and a rich signal, and the 2026-08-14 snapshot
// carried 16 of 20 -- because they are a regression floor that catches a silent
// collapse of the notice enrichment seam, not a target to grow toward.
const MIN_RICH_CITY_RECORD_MEETINGS = 10;
const MIN_RICH_CITY_RECORD_SHARE = 0.5;
// The two notices the original richness check pinned by request id. Their event
// dates have passed, so the forward-looking acquisition no longer serves them.
// They stay here as an observable soft signal and never fail a deploy.
const LEGACY_RICH_MEETING_SENTINELS = ["20260810053", "20260713006"];

function hasNoticeBody(row) {
  return [row.additional_description_1, row.additional_description_2, row.other_info_1, row.other_info_2, row.other_info_3]
    .some((value) => String(value || "").trim());
}

function hasRichSignal(row) {
  return [row.street_address_1, row.building_name, row.contact_name, row.contact_phone, row.email, row.document_links, row.source_links]
    .some((value) => Array.isArray(value) ? value.length > 0 : String(value || "").trim());
}

function meetingId(row) {
  return `meeting:city_record:${row.request_id}`;
}

export function assertMeetingCoverage(readModel, cityRows, materializedRows, log = console) {
  const expectedIds = new Set(cityRows.map(meetingId).filter((id) => !id.endsWith(":undefined")));
  if (readModel.counts.city_record !== expectedIds.size) {
    throw new Error(`shared meeting model materialized ${readModel.counts.city_record}/${expectedIds.size} eligible City Record meetings`);
  }
  const materializedIds = new Set((materializedRows || []).map(meetingId).filter((id) => !id.endsWith(":undefined")));
  const materialized = readModel.rows.filter((row) => materializedIds.has(row.meeting_id));
  const rich = materialized.filter((row) => hasNoticeBody(row) && hasRichSignal(row));
  if (rich.length < MIN_RICH_CITY_RECORD_MEETINGS) {
    throw new Error(
      `shared meeting model carries notice richness for only ${rich.length} of ${materialized.length} materialized City Record meetings (floor ${MIN_RICH_CITY_RECORD_MEETINGS})`,
    );
  }
  if (rich.length / materialized.length < MIN_RICH_CITY_RECORD_SHARE) {
    throw new Error(
      `only ${rich.length} of ${materialized.length} materialized City Record meetings carry notice richness (floor ${Math.round(MIN_RICH_CITY_RECORD_SHARE * 100)}%)`,
    );
  }
  for (const requestId of LEGACY_RICH_MEETING_SENTINELS) {
    const row = readModel.rows.find((candidate) => candidate.meeting_id === `meeting:city_record:${requestId}`);
    if (!row) {
      log.warn(`City Record meeting ${requestId} is outside the current notice window`);
    } else if (!hasNoticeBody(row) || !hasRichSignal(row)) {
      log.warn(`City Record meeting ${requestId} is retained without materialized notice richness`);
    }
  }
  return { materialized: materialized.length, rich: rich.length };
}

export function primaryDocumentOutputs(options = {}) {
  const shell = readFileSync(join(SITE, "index.html"), "utf8");
  const payloads = Object.fromEntries(Object.entries(BROWSE_FACETS).map(([facet, config]) => [facet, json(config.dataPath)]));
  payloads.zoning = {
    ...payloads.zoning,
    hearings: json("/data/land_upcoming_hearings.json").hearings || [],
  };
  const rulesSemanticLane = json("/data/rules_semantic_lane.json");
  const { materialization, rows: cityRecordMeetings } = cityRecordMeetingRows();
  const outcomes = json("/data/meeting_outcomes_snapshot.json");
  // Keep previously published meeting identities while the current, rich
  // notice materialization supplies the complete eligible window. The rich
  // rows come first so an exact id is upgraded rather than duplicated.
  const cityRecordRows = [...cityRecordMeetings, ...(payloads.meetings.rows || [])];
  const communityBoardMeetings = json("/data/community_board_meeting_index.json");
  const sharedMeetings = buildSharedMeetingReadModel({
    cityRecordRows,
    communityBoardIndex: communityBoardMeetings,
    meetingOutcomes: outcomes,
    generatedAt: materialization.generated_at,
    now: communityBoardMeetings.generated_at || materialization.generated_at,
  });
  assertMeetingCoverage(sharedMeetings, cityRecordRows, cityRecordMeetings);
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
  outputs.push(output("search", buildSearchDocument(shell)));
  const staffingExams = json("/data/staffing_exams.json");
  const awards = json("/data/ocp_awards_warehouse_lookup.json");
  const landProjects = json("/data/zap_projects_warehouse_lookup.json");
  const property = json("/data/property_domain_observations.json");
  const obligations = json("/data/agency_obligations_lookup.json");
  const meetings = payloads.meetings;
  const people = json("/data/person_hub_lookup.json");
  const committees = json("/data/committee_graph_lookup.json");
  const communityBoardPeople = json("/data/community_board_people.json");
  const communityBoardCommittees = json("/data/non_council_outcome_sources/community_board_committees.json");
  const agencies = json("/data/agency_constellation_lookup.json");
  const places = json("/data/community_board_geography_lookup.json");
  const hires = json("/data/staffing_default_hires.json");
  outputs.push(output("browse", buildBrowseLandingDocument(shell, payloads, {
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
        { value: obligations.summary?.obligation_count ?? null, label: "mandates" },
        { value: obligations.summary?.with_deadline_signal_count ?? null, label: "deadline signals" },
      ] },
      "meetings-decisions": { facts: [
        { value: meetings.row_count, label: "meeting rows" },
        { value: outcomes.present_count, label: "outcome snapshots" },
      ] },
      "people-organizations": {
        count: people.person_count ?? null,
        countLabel: "people",
        facts: [
          { value: people.person_count, label: "people" },
          { value: committees.observations?.length ?? null, label: "committee edges" },
          { value: agencies.agency_count, label: "agencies" },
        ],
      },
      places: { facts: [
        { value: places.inventory?.boards_inventoried ?? null, label: "boards" },
        { value: places.receipt?.pair_count ?? null, label: "district intersections" },
      ] },
    },
  })));
  outputs.push(output(surfaceOutputPath(EXAMS_SURFACE), buildExamsDocument(shell, staffingExams)));
  const conceptSources = {
    people,
    committees,
    agencies,
    awards,
    places,
    hires,
    communityBoardPeople,
    communityBoardCommittees,
  };
  for (const kind of Object.keys(BROWSE_CONCEPTS)) {
    const document = kind === "people"
      ? buildBrowseConceptDocument(shell, kind, conceptSources, { surface: PEOPLE_ORGANIZATIONS_SURFACE })
      : buildBrowseConceptDocument(shell, kind, conceptSources);
    outputs.push(output(`browse/${kind}`, document));
  }
  for (const [facet, payload] of Object.entries(payloads)) {
    if (facet === "staffing") {
      outputs.push(output(surfaceOutputPath(STAFFING_SURFACE), buildStaffingDocument(shell, payload)));
      continue;
    }
    outputs.push(output(`browse/${facet}`, buildBrowseDocument(shell, facet, payload, new URLSearchParams(), {
      route: `/browse/${facet}/`,
      semanticArtifact: facet === "rules" ? rulesSemanticLane : null,
      clock: options.clock ?? resolvePinnedBuildClock(),
    })));
  }
  return outputs;
}

export function peopleOrganizationsOutputs() {
  const model = buildPeopleOrganizationsReadModel({
    people: json("/data/person_hub_lookup.json"),
    committees: json("/data/committee_graph_lookup.json"),
    agencies: json("/data/agency_constellation_lookup.json"),
    awards: json("/data/ocp_awards_warehouse_lookup.json"),
    places: json("/data/community_board_geography_lookup.json"),
    hires: json("/data/staffing_default_hires.json"),
    communityBoardPeople: json("/data/community_board_people.json"),
    communityBoardCommittees: json("/data/non_council_outcome_sources/community_board_committees.json"),
  });
  return [[
    join(SITE, "data/people_organizations_read_model.json"),
    `${JSON.stringify(model, null, 2)}\n`,
  ]];
}

function buildSharedMeetingArtifacts() {
  const payloads = Object.fromEntries(Object.entries(BROWSE_FACETS).map(([facet, config]) => [facet, json(config.dataPath)]));
  payloads.zoning = {
    ...payloads.zoning,
    hearings: json("/data/land_upcoming_hearings.json").hearings || [],
  };
  const { materialization, rows: cityRecordMeetings } = cityRecordMeetingRows();
  const outcomes = json("/data/meeting_outcomes_snapshot.json");
  const cityRecordRows = [...cityRecordMeetings, ...(payloads.meetings.rows || [])];
  const communityBoardMeetings = json("/data/community_board_meeting_index.json");
  const sharedMeetings = buildSharedMeetingReadModel({
    cityRecordRows,
    communityBoardIndex: communityBoardMeetings,
    meetingOutcomes: outcomes,
    generatedAt: materialization.generated_at,
    now: communityBoardMeetings.generated_at || materialization.generated_at,
  });
  assertMeetingCoverage(sharedMeetings, cityRecordRows, cityRecordMeetings);
  return { sharedMeetings };
}

export function sharedMeetingOutputs() {
  const { sharedMeetings } = buildSharedMeetingArtifacts();
  return [[
    join(SITE, "data/shared_meeting_read_model.json"),
    `${JSON.stringify(sharedMeetings, null, 2)}\n`,
  ]];
}

function buildDayClock(argv) {
  const flagIndex = argv.indexOf("--build-day");
  const value = flagIndex >= 0 ? argv[flagIndex + 1] : null;
  if (!value) {
    // This CLI entry point is the owning build command for the generated primary
    // documents; buildBrowseDocument/buildBrowseView stay pure functions of the
    // clock this passes in, and --build-day overrides it for deterministic runs.
    // A caller that pinned CROL_BUILD_DAY for the whole run (the pre-push
    // preflight) gets that same instant here instead of a fresh new Date();
    // otherwise this keeps its unpinned, real-clock default unchanged.
    return resolvePinnedBuildClock() ?? new Date();
  }
  const instantMs = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? nyNaiveTimestampToInstantMs(`${value}T00:00:00`)
    : Date.parse(value);
  if (!Number.isFinite(instantMs)) throw new Error(`Invalid --build-day value: ${value}`);
  return new Date(instantMs);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const check = process.argv.includes("--check");
  const clock = buildDayClock(process.argv.slice(2));
  let stale = 0;
  for (const [path, content] of [...primaryDocumentOutputs({ clock }), ...sharedMeetingOutputs(), ...peopleOrganizationsOutputs()]) {
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
