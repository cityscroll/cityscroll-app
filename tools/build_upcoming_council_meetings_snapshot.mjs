#!/usr/bin/env node
/**
 * First-class upcoming Council calendar snapshot for the static site.
 *
 * Default acquisition is live Legistar Events (+ bounded EventItems). A pinned
 * fixture remains available for offline unit tests via --fixture; it must not
 * be the production refresh path, because its generated_at cannot advance.
 *
 * Without LEGISTAR_API_TOKEN (or LEGISTAR_API_TOKEN_FILE), or when the live
 * acquisition is not publishable, the last-known-good artifact is retained and
 * the process exits non-zero so first-class refresh records a failed
 * acquisition instead of rewriting a stale vintage as success.
 */
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
} from "../worker/src/lib/legistar_client.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(ROOT, "test/fixtures/legistar/upcoming_contracts_22691.json");
const OUT = join(ROOT, "site/data/upcoming_council_meetings.json");
const PINNED_NOW = "2026-09-09T12:00:00.000Z";

function clean(value) {
  const text = String(value || "").trim();
  return text || null;
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
  return { ok: true, reason: null, view: acquired.view };
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
    console.log("upcoming council meetings snapshot is current");
    return;
  }

  if (useFixture) {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, buildUpcomingCouncilMeetingsSnapshot());
    console.log("wrote site/data/upcoming_council_meetings.json from pinned fixture");
    return;
  }

  const token = readLegistarToken();
  const acquired = await acquireLiveUpcomingCouncilMeetingsSnapshot({ token, now: new Date() });
  if (!acquired.ok || !acquired.view) {
    const retained = existsSync(OUT);
    console.error(
      retained
        ? `upcoming council meetings live acquisition failed (${acquired.reason || "unknown"}); retaining last-known-good artifact`
        : `upcoming council meetings live acquisition failed (${acquired.reason || "unknown"}); no last-known-good artifact to retain`,
    );
    process.exitCode = 1;
    return;
  }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(acquired.view, null, 2)}\n`);
  console.log(JSON.stringify({
    wrote: "site/data/upcoming_council_meetings.json",
    generated_at: acquired.view.generated_at,
    meetings: acquired.view.counts?.meetings ?? acquired.view.meetings?.length ?? 0,
    window_start: acquired.view.discovery?.window_start || null,
    window_end: acquired.view.discovery?.window_end || null,
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
