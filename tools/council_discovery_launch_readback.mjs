#!/usr/bin/env node

/**
 * Read-only production read-back for Council discovery launch.
 * Public and admin GETs only. A path that is not live is not-yet-observed,
 * never passed. The Events-feed publisher key is EventId 22691; InSite
 * calendar 1439673 is a measured cross-reference for the same proceeding.
 *
 *   node tools/council_discovery_launch_readback.mjs
 *   node tools/council_discovery_launch_readback.mjs --check
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

import {
  productionPathObservation,
  productionProvenance,
} from "./lib/production_provenance.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SCHEMA = "cityscroll.council_discovery_launch_readback.v1";
export const EVIDENCE_DIR_RELATIVE = "docs/evidence/council-discovery-launch";
export const ENVELOPE_NAME = "production-readback.json";
export const PUBLISHER_EVENT_ID = "22691";
export const INSITE_CALENDAR_ID = "1439673";
export const MEETING_ID = `meeting:nyc_legistar_events:${PUBLISHER_EVENT_ID}`;
export const PINNED_CLOCK = "2026-09-09";
export const EVENT_DAY = "2026-09-23";

const DEFAULT_SITE = "https://cityscroll.org";
const DEFAULT_API = "https://api.cityscroll.org";

function gitRevision(root = ROOT) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function encodedMeetingPath() {
  return `/meetings/${encodeURIComponent(MEETING_ID)}`;
}

export function launchReadbackPaths({ site = DEFAULT_SITE, api = DEFAULT_API } = {}) {
  const filter = encodeURIComponent(JSON.stringify({ keywords: ["M/WBE"] }));
  return [
    {
      id: "meetings",
      url: `${site}/data/shared_meeting_read_model.json`,
      route: `${site}/browse/meetings/`,
      needles: [MEETING_ID, PUBLISHER_EVENT_ID, "Committee on Contracts"],
      forbidden: [`EventId ${INSITE_CALENDAR_ID}`, `LEGID=${INSITE_CALENDAR_ID}`],
    },
    {
      id: "search",
      url: `${api}/search?q=${encodeURIComponent("M/WBE utilization")}`,
      route: `${site}/search/?q=${encodeURIComponent("M/WBE utilization")}`,
      needles: [PUBLISHER_EVENT_ID, "Committee on Contracts"],
      forbidden: [`LEGID=${INSITE_CALENDAR_ID}`],
    },
    {
      id: "now",
      url: `${api}/hearings`,
      route: `${site}/now/`,
      needles: [PUBLISHER_EVENT_ID, "Committee on Contracts"],
      forbidden: [`LEGID=${INSITE_CALENDAR_ID}`],
    },
    {
      id: "canonical-detail",
      url: `${site}${encodedMeetingPath()}`,
      needles: [MEETING_ID, PUBLISHER_EVENT_ID, EVENT_DAY],
      forbidden: [`EventId ${INSITE_CALENDAR_ID}`],
    },
    {
      id: "ics",
      url: `${api}/meeting.ics?id=${encodeURIComponent(MEETING_ID)}`,
      needles: ["20260923", "Committee on Contracts", PUBLISHER_EVENT_ID],
      forbidden: [INSITE_CALENDAR_ID],
    },
    {
      id: "watch-preview",
      url: `${site}/following?lens=meetings&filter=${filter}`,
      needles: [MEETING_ID, "Committee on Contracts"],
      forbidden: [`LEGID=${INSITE_CALENDAR_ID}`],
    },
  ];
}

function bodyHas(body, needle) {
  return String(body || "").includes(String(needle));
}

export function classifyPathRead({ path, status, body }) {
  if (status == null || status >= 500) {
    return productionPathObservation({
      id: path.id,
      url: path.url,
      status,
      state: "failed",
      assertion: "transport or server error",
      note: "Recorded as failed, not as passed.",
    });
  }
  if (status >= 400) {
    return productionPathObservation({
      id: path.id,
      url: path.url,
      status,
      state: "not-yet-observed",
      assertion: `HTTP ${status}; the September 23 proceeding was not served on this path`,
      note: "A missing live path is not-yet-observed, never passed.",
    });
  }
  const missing = (path.needles || []).filter((needle) => !bodyHas(body, needle));
  const leaked = (path.forbidden || []).filter((needle) => bodyHas(body, needle));
  if (leaked.length) {
    return productionPathObservation({
      id: path.id,
      url: path.url,
      status,
      state: "failed",
      assertion: "InSite calendar number used as if it were the Events-feed EventId",
      evidence: { leaked },
    });
  }
  if (missing.length) {
    return productionPathObservation({
      id: path.id,
      url: path.url,
      status,
      state: "not-yet-observed",
      assertion: "Response did not include the Events-feed publisher key EventId 22691",
      evidence: { missing },
      note: "not-yet-observed, never passed.",
    });
  }
  return productionPathObservation({
    id: path.id,
    url: path.url,
    status,
    state: "passed",
    assertion: "Events-feed EventId 22691 present; InSite 1439673 is not treated as EventId",
    evidence: {
      publisher_event_id: PUBLISHER_EVENT_ID,
      insite_calendar_id: INSITE_CALENDAR_ID,
      identity_distinction: "publisher key is EventId; InSite calendar number is a cross-reference",
    },
  });
}

export async function collectLaunchReadback({
  fetchImpl = fetch,
  site = DEFAULT_SITE,
  api = DEFAULT_API,
  now = new Date(),
  sourceRevision = null,
} = {}) {
  const observedAt = new Date(now).toISOString();
  const paths = launchReadbackPaths({ site, api });
  const observations = [];
  for (const path of paths) {
    let status = null;
    let body = "";
    try {
      const response = await fetchImpl(path.url, {
        method: "GET",
        headers: { Accept: "text/html, text/calendar, application/json;q=0.9, */*;q=0.8" },
        redirect: "follow",
      });
      status = response.status;
      body = await response.text();
    } catch (error) {
      observations.push(productionPathObservation({
        id: path.id,
        url: path.url,
        status: null,
        state: "failed",
        assertion: "GET did not complete",
        note: String(error?.message || error),
      }));
      continue;
    }
    const observation = classifyPathRead({ path, status, body });
    observations.push(path.route ? { ...observation, route: path.route } : observation);
  }
  const passed = observations.filter((row) => row.state === "passed").length;
  const notYet = observations.filter((row) => row.state === "not-yet-observed").length;
  const failed = observations.filter((row) => row.state === "failed").length;
  return {
    schema: SCHEMA,
    title: "Council discovery launch production read-back",
    proceeding: {
      event_day: EVENT_DAY,
      publisher_key: { kind: "event_id", event_id: PUBLISHER_EVENT_ID, meeting_id: MEETING_ID },
      insite_calendar: {
        kind: "cross-reference",
        meeting_id: INSITE_CALENDAR_ID,
        note: "Measured public InSite calendar identity for the same proceeding. Never an EventId.",
      },
      pinned_fixture_clock: PINNED_CLOCK,
    },
    provenance: productionProvenance({
      observed_at: observedAt,
      tool: "tools/council_discovery_launch_readback.mjs",
      source_revision: sourceRevision,
      bases: [site, api],
      methods: ["GET"],
    }),
    paths: observations,
    counts: { passed, "not-yet-observed": notYet, failed, total: observations.length },
    rolling_release_gate:
      "Release gates assert eligible-population properties and freshness bounds. This dated read-back is evidence, not a permanent named-event gate.",
  };
}

function envelopePath(root = ROOT) {
  return join(root, EVIDENCE_DIR_RELATIVE, ENVELOPE_NAME);
}

async function main(argv = process.argv.slice(2)) {
  const check = argv.includes("--check");
  const out = envelopePath();
  if (check) {
    if (!existsSync(out)) {
      console.error(`${EVIDENCE_DIR_RELATIVE}/${ENVELOPE_NAME} is missing`);
      process.exit(1);
    }
    const envelope = JSON.parse(readFileSync(out, "utf8"));
    if (envelope.schema !== SCHEMA) {
      console.error("council discovery launch read-back schema mismatch");
      process.exit(1);
    }
    console.log(`ok ${EVIDENCE_DIR_RELATIVE}/${ENVELOPE_NAME} paths=${envelope.paths?.length || 0}`);
    return;
  }
  const envelope = await collectLaunchReadback({ sourceRevision: gitRevision() });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(envelope, null, 2)}\n`);
  console.log(`wrote ${EVIDENCE_DIR_RELATIVE}/${ENVELOPE_NAME} passed=${envelope.counts.passed} not-yet-observed=${envelope.counts["not-yet-observed"]} failed=${envelope.counts.failed}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
