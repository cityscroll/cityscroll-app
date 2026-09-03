/**
 * Shared compact-month fixture bundles for the node test suite and the
 * headless evidence harness. Plain ESM, importable from either environment.
 */

import { createCalendarOccurrence } from "../../site/calendar_occurrence.mjs";

function occurrence(overrides = {}) {
  const { date, starts_at: startsAt } = overrides;
  return createCalendarOccurrence({
    uid: overrides.uid,
    object_ref: overrides.object_ref || `object:${overrides.uid}`,
    kind: overrides.kind || "event",
    title: overrides.title || "Civic occurrence",
    ...(startsAt ? { starts_at: startsAt } : { date }),
    timezone: overrides.timezone,
    status: overrides.status,
    lifecycle: overrides.lifecycle,
    canonical_url: overrides.canonical_url || `https://cityscroll.org/x/${overrides.uid}`,
    source: overrides.source || { system: "city_record", record_id: overrides.uid },
    provenance: overrides.provenance || { basis: "publisher_record" },
  });
}

// Today is pinned at 2026-03-15 for every fixture below.
export const FIXTURE_TODAY = "2026-03-15";

export const FIXTURES = {
  dense: () => [
    occurrence({ uid: "dense-past", date: "2026-03-04", kind: "event", title: "Kickoff hearing" }),
    occurrence({ uid: "dense-current", date: "2026-03-15", kind: "deadline", title: "Comments due today" }),
    occurrence({
      uid: "dense-timed",
      starts_at: "2026-03-18T18:30:00-04:00",
      timezone: "America/New_York",
      kind: "event",
      title: "Public hearing",
    }),
    occurrence({ uid: "dense-window-open", date: "2026-03-21", kind: "window_open", title: "Applications open" }),
    occurrence({ uid: "dense-window-close", date: "2026-03-25", kind: "window_close", title: "Applications close" }),
    occurrence({ uid: "dense-milestone", date: "2026-03-28", kind: "milestone", title: "Board vote" }),
  ],
  crowded: () => [
    ...Array.from({ length: 5 }, (_, index) => occurrence({
      uid: `crowded-${index}`,
      date: "2026-03-20",
      kind: index % 2 === 0 ? "event" : "deadline",
      title: `Item ${index + 1} of 5 on this day`,
    })),
    occurrence({ uid: "crowded-spread-a", date: "2026-03-05", title: "Earlier hearing" }),
    occurrence({ uid: "crowded-spread-b", date: "2026-03-27", title: "Later hearing" }),
  ],
  lifecycle: () => [
    occurrence({
      uid: "lifecycle-cancelled",
      date: "2026-03-06",
      status: "cancelled",
      lifecycle: "cancelled",
      title: "Cancelled committee meeting",
    }),
    occurrence({
      uid: "lifecycle-rescheduled",
      date: "2026-03-13",
      lifecycle: "rescheduled",
      title: "Rescheduled full-board meeting",
    }),
    occurrence({ uid: "lifecycle-past", date: "2026-03-08", title: "Already-held session" }),
    occurrence({ uid: "lifecycle-future", date: "2026-03-24", kind: "deadline", title: "Upcoming deadline" }),
  ],
  sparse: () => [
    occurrence({ uid: "sparse-only", date: "2026-03-10", title: "The only date on this record" }),
  ],
};

export function fixtureOccurrences(name) {
  const builder = FIXTURES[name];
  if (!builder) throw new Error(`unknown compact-month fixture: ${name}`);
  return builder();
}
