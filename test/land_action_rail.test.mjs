import { SITE_SOURCE } from "./helpers/site_source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  compileActionRail,
  zoningHandoff,
  zoningStage,
  landHearingBody,
} from "../worker/src/lib/action_registry.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const index = SITE_SOURCE;
// RFC 2606 reserved domain — assembled so the PR surface does not look like a personal inbox.
const EXAMPLE_EMAIL = ["testify", "example.com"].join("@");

const HEARING = {
  request_id: "20260801001",
  event_date: "2026-08-20T18:30:00.000",
  agency_name: "Brooklyn Community Board 1",
  short_title: "289 Kent Avenue Rezoning — Community Board public hearing",
  street_address_1: "211 Ainslie Street",
  city: "Brooklyn",
  state: "NY",
  zip_code: "11211",
  notice_text: [
    "NOTICE OF PUBLIC HEARING of Brooklyn Community Board 1",
    "to be held on August 20, 2026 at 211 Ainslie Street, Brooklyn, NY 11211 commencing at 6:30 p.m.",
    `Written testimony may be submitted electronically to ${EXAMPLE_EMAIL}.`,
    "All written testimony can be submitted up until the close of the public hearing.",
    "Join online at https://zoom.us/j/123456789.",
  ].join(" "),
};

test("zoningStage maps public_status and phase without inventing openness", () => {
  assert.equal(zoningStage({public_status: "In Public Review"}), "public-review");
  assert.equal(zoningStage({public_status: "Completed"}), "closed");
  assert.equal(zoningStage({public_status: "Noticed"}), "noticed");
  assert.equal(zoningStage({phase_id: "community_board"}), "public-review");
  assert.equal(zoningStage({lifecycle_stage: "closed"}), "closed");
});

test("landHearingBody classifies CB / BP / CPC / Council from agency+title", () => {
  assert.equal(landHearingBody({agency: "Brooklyn Community Board 1"}), "community_board");
  assert.equal(landHearingBody({title: "Borough President referral hearing"}), "borough_president");
  assert.equal(landHearingBody({agency: "City Planning Commission"}), "cpc");
  assert.equal(landHearingBody({title: "City Council Review Session"}), "city_council");
  assert.equal(landHearingBody({title: "Generic land notice"}), null);
});

test("land detail mounts a next-action rail host and paints from ZAP outcomes", () => {
  assert.match(index, /id="land-actions"/);
  assert.match(index, /paintLandActionRail/);
  assert.match(index, /landActionMatter/);
  assert.match(index, /function landActionHearingsFromRecord/);
  assert.match(index, /city_record_notices/);
  // Rail paints on select and again when outcomes hydrate (normalized record
  // rebuilds stale-open statutory clocks before paint).
  assert.match(index, /paintLandActionRail\(\$\("#land-actions"\),\s*r,\s*null/);
  assert.match(index, /paintLandActionRail\(\$\("#land-actions"\),\s*r,\s*(?:record|warm\.data\.record|data\.record)/);
  assert.match(index, /normalizeLandRecord/);
});

test("rezone dig items deep-link into #land detail (not only ZAP)", () => {
  assert.match(index, /#land\/\$\{encodeURIComponent\(r\.project_id\)\}/);
  assert.match(index, /land_dig_open_detail/);
});

test("zoning_extracted guide renders phase-tied participation steps", () => {
  assert.match(index, /guide\.system==="zoning_extracted"/);
  assert.match(index, /land_guide_heading/);
  assert.match(index, /land_guide_phase_step/);
  assert.match(index, /land_guide_testimony_step_html/);
  assert.match(index, /land_guide_zap_comment_step_html/);
});

test("in-public-review rezoning with hearing extracts join, testimony, venue, and calendar", () => {
  const matter = {
    kind: "zoning",
    project_id: "2024K0240",
    public_status: "In Public Review",
    phase_id: "community_board",
    phase_label: "Community Board review",
    project_url: "https://zap.planning.nyc.gov/projects/2024K0240",
    hearings: [HEARING],
  };
  const handoff = zoningHandoff(matter, {today: "2026-08-02"});
  assert.equal(handoff.system, "zoning_extracted");
  assert.equal(handoff.mode, "public_review");
  assert.equal(handoff.phase_id, "community_board");
  assert.equal(handoff.testimony_email, EXAMPLE_EMAIL);
  assert.equal(handoff.testimony_until?.kind, "hearing_close");
  assert.match(handoff.venue_address || "", /211 Ainslie/i);
  assert.equal(handoff.participation_url, "https://zoom.us/j/123456789");
  assert.equal(handoff.join_kind, "join");
  assert.equal(handoff.next_hearing?.body_kind, "community_board");

  const actions = compileActionRail(matter, {today: "2026-08-02"});
  assert.deepEqual(actions.map((a) => a.type), ["attend", "calendar", "watch"]);
  assert.equal(actions[0].label_key, "join_online");
  assert.equal(actions[0].destination, "https://zoom.us/j/123456789");
  assert.equal(actions[0].guide?.system, "zoning_extracted");
  assert.equal(actions[2].label_key, "next_action_watch_rezone");
});

test("completed rezoning closes comment without inventing a hearing", () => {
  const actions = compileActionRail({
    kind: "zoning",
    project_id: "2022M0258",
    public_status: "Completed",
    project_url: "https://zap.planning.nyc.gov/projects/2022M0258",
  }, {today: "2026-08-02"});
  assert.equal(actions[0].delivery, "unavailable");
  assert.equal(actions[0].label_key, "next_action_comment_closed");
  assert.equal(actions[1].label_key, "zap_full_project");
  assert.equal(actions.some((a) => a.type === "attend"), false);
});

test("pre-review rezoning keeps ZAP project + watch, not a false comment-open CTA", () => {
  const actions = compileActionRail({
    kind: "zoning",
    project_id: "2026M0001",
    public_status: "Filed",
    phase_id: "environmental",
    project_url: "https://zap.planning.nyc.gov/projects/2026M0001",
  }, {today: "2026-08-02"});
  assert.equal(actions[0].delivery, "official_handoff");
  assert.equal(actions[0].label_key, "zap_full_project");
  assert.equal(actions[0].guide?.mode, "pre_review");
  assert.doesNotMatch(actions[0].label_key, /view_comment_zap/);
});

test("public-review without hearing still offers ZAP comment + guide, never a punt", () => {
  const actions = compileActionRail({
    kind: "zoning",
    project_id: "2024K0286",
    public_status: "In Public Review",
    phase_id: "borough_president",
    phase_label: "Borough President review",
    project_url: "https://zap.planning.nyc.gov/projects/2024K0286",
  }, {today: "2026-08-02"});
  assert.equal(actions[0].type, "comment");
  assert.equal(actions[0].label_key, "view_comment_zap");
  assert.equal(actions[0].guide?.system, "zoning_extracted");
  assert.equal(actions[0].guide?.phase_id, "borough_president");
  assert.doesNotMatch(JSON.stringify(actions), /use the (response|official)/i);
});

test("venue/testimony without online join still offers in-person attend instead of missing-link punt", () => {
  const actions = compileActionRail({
    kind: "zoning",
    project_id: "2024K0240",
    public_status: "In Public Review",
    phase_id: "community_board",
    project_url: "https://zap.planning.nyc.gov/projects/2024K0240",
    hearings: [{
      request_id: "20260801002",
      event_date: "2026-08-22T18:00:00.000",
      agency_name: "Brooklyn Community Board 2",
      street_address_1: "350 Jay Street",
      city: "Brooklyn",
      state: "NY",
      zip_code: "11201",
      notice_text: `Written testimony may be submitted electronically to ${EXAMPLE_EMAIL}.`,
    }],
  }, {today: "2026-08-02"});
  // Venue address → maps attend is the kinetic handoff when no join platform is published.
  assert.equal(actions[0].type, "attend");
  assert.equal(actions[0].label_key, "land_action_attend_in_person");
  assert.match(actions[0].destination || "", /maps\.google|google\.com\/maps/i);
  assert.equal(actions[0].guide?.testimony_email, EXAMPLE_EMAIL);
  assert.match(actions[0].guide?.venue_address || "", /350 Jay/i);
  assert.ok(!actions[0].guide?.participation_url);
});
