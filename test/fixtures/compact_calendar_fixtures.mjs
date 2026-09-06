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
  // The observed friction this bundle exists for: real procurement and land
  // notices are published with titles that are a sentence long, and three of
  // them in one cell decide how tall a week is. Every title below is the
  // length and shape a publisher actually emits.
  longTitles: () => [
    occurrence({
      uid: "long-procurement",
      date: "2026-03-11",
      kind: "deadline",
      title: "Request for proposals for design, construction administration and resident engagement "
        + "services for the reconstruction of pedestrian ramps, curb extensions and drainage at "
        + "twenty-two intersections in the borough of Brooklyn, Community District 7",
    }),
    occurrence({
      uid: "long-land",
      starts_at: "2026-03-11T18:30:00-04:00",
      timezone: "America/New_York",
      kind: "event",
      title: "Public hearing on the proposed zoning map amendment and related special permit "
        + "application affecting Block 1042, Lots 7, 9 and 12, together with the accompanying "
        + "restrictive declaration",
    }),
    occurrence({
      uid: "long-window",
      date: "2026-03-11",
      kind: "window_open",
      title: "Applications open for the neighborhood commercial corridor storefront improvement "
        + "grant program, including technical assistance for first-time applicants",
    }),
    occurrence({
      uid: "long-milestone",
      date: "2026-03-11",
      kind: "milestone",
      title: "Determination of environmental significance issued for the proposed development, "
        + "with the full environmental assessment statement placed on file",
    }),
    occurrence({
      uid: "long-unbroken",
      date: "2026-03-18",
      kind: "deadline",
      title: "Questions due on solicitation 20260318-CITYWIDE-PROFESSIONAL-SERVICES-REBID-000412",
    }),
    occurrence({ uid: "long-short", date: "2026-03-25", kind: "event", title: "Board vote" }),
  ],
  // Nine occurrences on one day: enough that the panel itself has to stay
  // readable and scrollable rather than merely existing.
  highDensity: () => [
    ...Array.from({ length: 9 }, (_, index) => occurrence({
      uid: `density-${String(index).padStart(2, "0")}`,
      ...(index % 3 === 0
        ? { starts_at: `2026-03-19T${String(9 + index).padStart(2, "0")}:00:00-04:00` }
        : { date: "2026-03-19" }),
      timezone: index % 3 === 0 ? "America/New_York" : undefined,
      kind: ["event", "deadline", "window_open", "window_close", "milestone"][index % 5],
      lifecycle: index === 4 ? "cancelled" : index === 6 ? "rescheduled" : undefined,
      status: index === 4 ? "cancelled" : undefined,
      title: `Scheduled civic item ${index + 1} of 9 on this day`,
    })),
    occurrence({ uid: "density-spread-a", date: "2026-03-06", title: "Earlier hearing" }),
    occurrence({ uid: "density-spread-b", date: "2026-03-30", title: "Later hearing" }),
  ],
  // The same shapes with titles as a publisher in New York City actually
  // publishes them: the city's civic notices are issued in several languages,
  // and two of these scripts do not break on spaces at all.
  localized: () => [
    occurrence({
      uid: "localized-es",
      date: "2026-03-12",
      kind: "deadline",
      title: "Fecha límite para presentar comentarios públicos sobre la propuesta de modificación "
        + "del mapa de zonificación del distrito comunitario",
    }),
    occurrence({
      uid: "localized-zh",
      starts_at: "2026-03-12T18:30:00-04:00",
      timezone: "America/New_York",
      kind: "event",
      title: "關於社區委員會轄區土地使用申請及相關特別許可的公開聽證會，歡迎居民出席並提供意見",
    }),
    occurrence({
      uid: "localized-bn",
      date: "2026-03-12",
      kind: "window_open",
      title: "কমিউনিটি বোর্ড এলাকার দোকানপাট উন্নয়ন অনুদান কর্মসূচির জন্য আবেদন গ্রহণ শুরু হয়েছে",
    }),
    occurrence({
      uid: "localized-ru",
      date: "2026-03-12",
      kind: "milestone",
      title: "Опубликовано решение об экологической значимости предлагаемого проекта застройки",
    }),
    occurrence({ uid: "localized-ht", date: "2026-03-20", kind: "event", title: "Reyinyon konsèy kominotè a" }),
    occurrence({ uid: "localized-en", date: "2026-03-26", kind: "deadline", title: "Comments due" }),
  ],
};

export function fixtureOccurrences(name) {
  const builder = FIXTURES[name];
  if (!builder) throw new Error(`unknown compact-month fixture: ${name}`);
  return builder();
}
