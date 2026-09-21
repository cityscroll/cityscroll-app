#!/usr/bin/env node
/**
 * First-class upcoming Council calendar snapshot for the static site.
 *
 * The production refresh path consumes the retained output of
 * tools/acquire_upcoming_council_meetings.mjs. A pinned fixture remains
 * available for offline unit tests via --fixture; it must not be the
 * production refresh path, because its generated_at cannot advance.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  assertPublicUpcomingProjection,
  buildUpcomingCouncilMeetingsView,
  isEligibleUpcomingEvent,
  selectUpcomingItemTargets,
  upcomingWindow,
  UPCOMING_COUNCIL_MEETINGS_ITEM_CONCURRENCY,
  UPCOMING_COUNCIL_MEETINGS_SCHEMA,
} from "../worker/src/lib/upcoming_council_meetings.mjs";
import {
  boundedMap,
  fetchLegistarEventItems,
  fetchLegistarEventsWindow,
  LEGISTAR_API_BASE,
} from "../worker/src/lib/legistar_client.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(ROOT, "test/fixtures/legistar/upcoming_contracts_22691.json");
const OUT = join(ROOT, "site/data/upcoming_council_meetings.json");
export const ACQUISITION_RECEIPT_PATH = join(
  ROOT,
  "site/data/legistar_sources/verification_receipts/upcoming_council_meetings_latest.json",
);
export const ACQUISITION_STAGE_PATH = join(ROOT, ".artifacts/upcoming_council_meetings_acquisition.json");
export const UPCOMING_ACQUISITION_RECEIPT_SCHEMA = "cityscroll.upcoming_council_meetings_acquisition_receipt.v1";
export const LEGISTAR_EVENTS_SOURCE_URL = `${LEGISTAR_API_BASE}/Events`;
const PINNED_NOW = "2026-09-09T12:00:00.000Z";

function clean(value) {
  const text = String(value || "").trim();
  return text || null;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function acquisitionContent(eventRows, itemsByEventId) {
  return JSON.stringify({
    events: eventRows,
    event_items: [...itemsByEventId.entries()]
      .sort(([left], [right]) => String(left).localeCompare(String(right)))
      .map(([eventId, batch]) => ({
        event_id: String(eventId),
        rows: batch?.rows || [],
        fetch_error: batch?.fetchError || null,
      })),
  });
}

export function buildUpcomingAcquisitionReceipt({
  fetchedAt,
  eventRows = [],
  itemsByEventId = new Map(),
  sourceUrl = LEGISTAR_EVENTS_SOURCE_URL,
} = {}) {
  const fetched = new Date(fetchedAt);
  if (!Number.isFinite(fetched.getTime())) throw new Error("upcoming acquisition receipt requires fetched_at");
  const content = acquisitionContent(eventRows, itemsByEventId);
  return {
    schema: UPCOMING_ACQUISITION_RECEIPT_SCHEMA,
    source_url: sourceUrl,
    fetched_at: fetched.toISOString(),
    content_hash: sha256(content),
    row_count: eventRows.length,
    event_item_row_count: [...itemsByEventId.values()].reduce(
      (total, batch) => total + (Array.isArray(batch?.rows) ? batch.rows.length : 0),
      0,
    ),
  };
}

export function validateUpcomingAcquisitionReceipt(raw) {
  const receipt = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (receipt?.schema !== UPCOMING_ACQUISITION_RECEIPT_SCHEMA) {
    throw new Error("upcoming Council acquisition receipt schema mismatch");
  }
  if (!/^https:\/\//.test(String(receipt.source_url || ""))) {
    throw new Error("upcoming Council acquisition receipt source_url missing");
  }
  if (!receipt.fetched_at || !Number.isFinite(Date.parse(receipt.fetched_at))) {
    throw new Error("upcoming Council acquisition receipt fetched_at missing");
  }
  if (!/^[a-f0-9]{64}$/.test(String(receipt.content_hash || ""))) {
    throw new Error("upcoming Council acquisition receipt content_hash missing");
  }
  if (!Number.isInteger(receipt.row_count) || receipt.row_count < 1) {
    throw new Error("upcoming Council acquisition receipt row_count missing");
  }
  return receipt;
}

export function snapshotStampedFromAcquisition(view, receipt) {
  const checkedReceipt = validateUpcomingAcquisitionReceipt(receipt);
  const stamped = JSON.parse(JSON.stringify(view));
  stamped.generated_at = checkedReceipt.fetched_at;
  if (stamped.source_health) {
    stamped.source_health.observed_at = checkedReceipt.fetched_at;
    stamped.source_health.last_successful_observation = checkedReceipt.fetched_at;
  }
  for (const meeting of stamped.meetings || []) {
    if (meeting.source_receipt) meeting.source_receipt.observed_at = checkedReceipt.fetched_at;
  }
  return stamped;
}

export function buildUpcomingCouncilMeetingsSnapshotFromAcquisition({ view, receipt } = {}) {
  const stamped = snapshotStampedFromAcquisition(view, receipt);
  assertPublicUpcomingProjection(stamped);
  return `${JSON.stringify(stamped, null, 2)}\n`;
}

export function readLegistarToken(env = process.env) {
  const file = clean(env.LEGISTAR_API_TOKEN_FILE);
  if (file && existsSync(file)) {
    const value = clean(readFileSync(file, "utf8"));
    if (value) return value;
  }
  return clean(env.LEGISTAR_API_TOKEN);
}

/** Deterministic offline projection used by unit tests only (--fixture). */
export function buildUpcomingCouncilMeetingsSnapshot(
  fixture = JSON.parse(readFileSync(FIXTURE, "utf8")),
) {
  const eventId = String(fixture.event.EventId);
  const { publishable, view } = buildUpcomingCouncilMeetingsView({
    eventRows: [fixture.event],
    itemsByEventId: new Map([[eventId, { rows: fixture.event_items, fetchError: null }]]),
    now: new Date(PINNED_NOW),
  });
  if (!publishable || !view) {
    throw new Error("upcoming council meetings snapshot is not publishable from the pinned fixture");
  }
  view.meetings[0].insite_calendar = fixture.insite_calendar || null;
  assertPublicUpcomingProjection(view);
  return `${JSON.stringify(view, null, 2)}\n`;
}

export async function acquireLiveUpcomingCouncilMeetingsSnapshot({
  token,
  fetchImpl = fetch,
  now = new Date(),
} = {}) {
  if (!token) {
    return { ok: false, reason: "token-absent", view: null };
  }
  const eventsFetch = await fetchLegistarEventsWindow({ token, fetchImpl, now });
  if (!eventsFetch.ok) {
    return { ok: false, reason: eventsFetch.kind || "events-fetch-failed", view: null };
  }
  const eventRows = eventsFetch.rows || [];
  const window = upcomingWindow(now);
  const eligible = eventRows.filter((raw) => isEligibleUpcomingEvent(raw, window));
  const targets = selectUpcomingItemTargets(eligible, new Set()).targets;
  const itemBatches = await boundedMap(
    targets,
    async (event) => {
      const eventId = String(event.EventId);
      try {
        const rows = await fetchLegistarEventItems({ eventId, token, fetchImpl });
        return { event_id: eventId, rows, fetchError: null };
      } catch (error) {
        return {
          event_id: eventId,
          rows: [],
          fetchError: String(error?.message || error),
        };
      }
    },
    UPCOMING_COUNCIL_MEETINGS_ITEM_CONCURRENCY,
  );
  const itemsByEventId = new Map(itemBatches.map((batch) => [batch.event_id, batch]));
  const acquired = buildUpcomingCouncilMeetingsView({
    eventRows,
    itemsByEventId,
    now,
    eventsFetch,
  });
  if (!acquired.publishable || !acquired.view) {
    return { ok: false, reason: acquired.reason || "not-publishable", view: null };
  }
  assertPublicUpcomingProjection(acquired.view);
  return {
    ok: true,
    reason: null,
    view: acquired.view,
    receipt: buildUpcomingAcquisitionReceipt({
      fetchedAt: new Date(now).toISOString(),
      eventRows,
      itemsByEventId,
    }),
  };
}

function validateCommittedSnapshot(raw) {
  const doc = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (doc?.schema !== UPCOMING_COUNCIL_MEETINGS_SCHEMA) {
    throw new Error("upcoming council meetings schema mismatch");
  }
  if (!Array.isArray(doc.meetings)) throw new Error("upcoming council meetings list missing");
  if (!doc.generated_at || !Number.isFinite(Date.parse(doc.generated_at))) {
    throw new Error("upcoming council meetings generated_at missing");
  }
  assertPublicUpcomingProjection(doc);
  return doc;
}

async function main(argv = process.argv.slice(2)) {
  const check = argv.includes("--check");
  const useFixture = argv.includes("--fixture");

  if (check) {
    if (!existsSync(OUT)) {
      console.error("site/data/upcoming_council_meetings.json is missing");
      process.exitCode = 1;
      return;
    }
    validateCommittedSnapshot(readFileSync(OUT, "utf8"));
    if (!existsSync(ACQUISITION_RECEIPT_PATH)) throw new Error("upcoming Council acquisition receipt is missing");
    validateUpcomingAcquisitionReceipt(readFileSync(ACQUISITION_RECEIPT_PATH, "utf8"));
    console.log("upcoming council meetings snapshot is current");
    return;
  }

  if (useFixture) {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, buildUpcomingCouncilMeetingsSnapshot());
    console.log("wrote site/data/upcoming_council_meetings.json from pinned fixture");
    return;
  }

  if (!existsSync(ACQUISITION_STAGE_PATH) || !existsSync(ACQUISITION_RECEIPT_PATH)) {
    throw new Error("upcoming Council acquisition output is missing; run tools/acquire_upcoming_council_meetings.mjs first");
  }
  const staged = JSON.parse(readFileSync(ACQUISITION_STAGE_PATH, "utf8"));
  const receipt = validateUpcomingAcquisitionReceipt(readFileSync(ACQUISITION_RECEIPT_PATH, "utf8"));
  if (staged?.receipt?.content_hash !== receipt.content_hash
    || staged?.receipt?.fetched_at !== receipt.fetched_at) {
    throw new Error("upcoming Council acquisition stage and receipt do not match");
  }
  const content = buildUpcomingCouncilMeetingsSnapshotFromAcquisition({ view: staged.view, receipt });
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, content);
  const snapshot = JSON.parse(content);
  console.log(JSON.stringify({
    wrote: "site/data/upcoming_council_meetings.json",
    generated_at: snapshot.generated_at,
    meetings: snapshot.counts?.meetings ?? snapshot.meetings?.length ?? 0,
    window_start: snapshot.discovery?.window_start || null,
    window_end: snapshot.discovery?.window_end || null,
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
