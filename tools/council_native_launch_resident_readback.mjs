#!/usr/bin/env node

/** Headless production read-back for the six public resident surfaces. */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SCHEMA = "cityscroll.resident_surface_presence_readback.v1";
export const OUTPUT = "docs/evidence/council-native-launch/event-22691-resident-surface-readback.json";
export const PUBLISHER_EVENT_ID = "22691";
export const MEETING_ID = `meeting:nyc_legistar_events:${PUBLISHER_EVENT_ID}`;
export const EVENT_DAY = "2026-09-23";
const SITE = "https://cityscroll.org";
const API = "https://api.cityscroll.org";
const MAX_EXCERPT = 600;

export function surfaces({ site = SITE, api = API } = {}) {
  const filter = encodeURIComponent(JSON.stringify({ keywords: ["M/WBE"] }));
  return [
    { id: "meetings", url: `${site}/data/shared_meeting_read_model.json`, route: `${site}/browse/meetings/`, needles: [MEETING_ID, PUBLISHER_EVENT_ID, "Committee on Contracts"] },
    { id: "search", url: `${api}/search?q=${encodeURIComponent("M/WBE utilization")}`, route: `${site}/search/?q=${encodeURIComponent("M/WBE utilization")}`, needles: [PUBLISHER_EVENT_ID, "Committee on Contracts"] },
    { id: "now", url: `${site}/now/`, route: `${site}/now/`, needles: [PUBLISHER_EVENT_ID, EVENT_DAY, "Committee on Contracts", `/meetings/${encodeURIComponent(MEETING_ID)}`] },
    { id: "canonical-detail", url: `${site}/meetings/${encodeURIComponent(MEETING_ID)}`, route: `${site}/meetings/${encodeURIComponent(MEETING_ID)}`, needles: [MEETING_ID, PUBLISHER_EVENT_ID, EVENT_DAY] },
    { id: "ics", url: `${api}/meeting.ics?id=${encodeURIComponent(MEETING_ID)}`, route: null, needles: ["20260923", "Committee on Contracts", PUBLISHER_EVENT_ID] },
    { id: "watch-preview", url: `${site}/following?lens=meetings&filter=${filter}`, route: `${site}/following?lens=meetings&filter=${filter}`, needles: [MEETING_ID, "Committee on Contracts"] },
  ];
}

function revision(file) {
  return createHash("sha256").update(readFileSync(join(ROOT, file))).digest("hex");
}

function gitRevision() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function excerpt(body, needles) {
  const text = String(body || "").replace(/\s+/g, " ").trim();
  const needle = needles.find((value) => text.includes(value));
  if (!needle) return text.slice(0, MAX_EXCERPT);
  const index = text.indexOf(needle);
  const start = Math.max(0, index - 180);
  return text.slice(start, start + MAX_EXCERPT);
}

function seen(body, needles, contentType) {
  let structured = null;
  if (contentType?.includes("json")) {
    try {
      const parsed = JSON.parse(body);
      structured = {
        top_level_keys: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? Object.keys(parsed).slice(0, 30) : [],
        matched_needles: needles.filter((needle) => String(body).includes(needle)),
      };
    } catch { /* bounded excerpt below remains the observation */ }
  }
  return { excerpt: excerpt(body, needles), ...(structured ? { structured } : {}) };
}

export async function collectReadback({ fetchImpl = fetch, now = new Date(), sourceRevision = gitRevision(), dataRevision = revision("site/data/shared_meeting_read_model.json"), site = SITE, api = API } = {}) {
  const revisions = { code: sourceRevision, data: dataRevision };
  const entries = [];
  for (const surface of surfaces({ site, api })) {
    const readAt = new Date(now).toISOString();
    try {
      const response = await fetchImpl(surface.url, { method: "GET", headers: { Accept: "text/html, text/calendar, application/json;q=0.9, */*;q=0.8" }, redirect: "follow" });
      const body = await response.text();
      const missing = surface.needles.filter((needle) => !body.includes(needle));
      entries.push({
        id: surface.id,
        route: surface.route,
        url: surface.url,
        read_at: readAt,
        found: response.status >= 200 && response.status < 400 && missing.length === 0,
        measurement_state: "measured",
        status: response.status,
        seen: seen(body, surface.needles, response.headers.get("content-type") || ""),
        missing_needles: missing,
        revisions,
      });
    } catch (error) {
      entries.push({ id: surface.id, route: surface.route, url: surface.url, read_at: readAt, found: false, measurement_state: "not_measured", not_measured_reason: String(error?.message || error), seen: null, revisions });
    }
  }
  return {
    schema: SCHEMA,
    title: "Council hearing resident-surface production read-back",
    proceeding: { event_day: EVENT_DAY, event_id: PUBLISHER_EVENT_ID, meeting_id: MEETING_ID },
    revisions,
    surfaces: entries,
  };
}

function assertEnvelope(value) {
  if (!value || value.schema !== SCHEMA || !Array.isArray(value.surfaces) || value.surfaces.length !== 6) throw new Error("resident surface read-back envelope shape mismatch");
  const expected = new Set(["meetings", "search", "now", "canonical-detail", "ics", "watch-preview"]);
  for (const entry of value.surfaces) {
    if (!expected.delete(entry.id) || typeof entry.found !== "boolean" || !entry.read_at || !entry.url || !entry.revisions?.code || !entry.revisions?.data) throw new Error(`invalid surface entry: ${entry?.id}`);
    if (entry.measurement_state === "not_measured" && !entry.not_measured_reason) throw new Error(`not_measured surface lacks reason: ${entry.id}`);
    if (entry.measurement_state === "measured" && !entry.seen?.excerpt) throw new Error(`measured surface lacks bounded observation: ${entry.id}`);
  }
  if (expected.size) throw new Error(`missing surfaces: ${[...expected].join(", ")}`);
}

async function main(argv = process.argv.slice(2)) {
  const output = join(ROOT, OUTPUT);
  if (argv.includes("--check")) { assertEnvelope(JSON.parse(readFileSync(output, "utf8"))); console.log(`ok ${OUTPUT}`); return; }
  const envelope = await collectReadback();
  assertEnvelope(envelope);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(envelope, null, 2)}\n`);
  console.log(`wrote ${OUTPUT} found=${envelope.surfaces.filter((entry) => entry.found).length}/6`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(error); process.exit(1); });
