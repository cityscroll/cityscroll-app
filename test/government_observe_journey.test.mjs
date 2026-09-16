import test from "node:test";
import assert from "node:assert/strict";
import { normalizePdcCalendarMeeting, normalizeBsaCalendarMeeting, normalizeOathTrialCalendarMeeting } from "../site/meeting_object_contract.mjs";
import { buildObserveSurface, normalizeObserveScope, observeScopeUrl, renderObserveDocument } from "../site/government_observe.mjs";
import { todayISO, withPinnedClock } from "./helpers/test_clock.mjs";

function addDays(day, days) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function fixtureRows(day0, day1) {
  return [
    normalizePdcCalendarMeeting({ pdc_event_id: "pdc-1", title: "PDC public review", event_date: day0, venue: { name: "City Hall" }, source_url: "https://example.test/pdc", description: "Review a public design proposal." }),
    normalizeBsaCalendarMeeting({ bsa_session_id: "bsa-1", title: "BSA executive review", event_date: day1, venue: { name: "Municipal Building" }, source_url: "https://example.test/bsa", observer_access: { watch_url: "https://example.test/watch" } }),
    normalizeOathTrialCalendarMeeting({ oath_trial_session_id: "oath-1", title: "OATH scheduled trial", event_date: day1, source_url: "https://example.test/oath", access_steps: [{ kind: "observer_instructions", destination: "https://example.test/oath" }] }),
    { source_system: "pdc_calendar", title: "Undated guide-like note" },
  ];
}

test("Observe combines dated PDC, BSA, and OATH records with separate guides", async () => {
  await withPinnedClock("2026-09-15T12:00:00.000Z", () => {
    const day0 = todayISO();
    const day1 = addDays(day0, 1);
    const surface = buildObserveSurface({ rows: fixtureRows(day0, day1) });
    assert.deepEqual(surface.observations.map((row) => row.source_system), ["pdc_calendar", "bsa_calendar", "oath_trial_calendar"]);
    assert.equal(surface.guides.length, 3);
    for (const row of surface.observations) {
      assert.ok(row.purpose && row.date && row.venue && row.access_label && row.href);
    }
    const html = renderObserveDocument(surface);
    assert.match(html, /Scheduled observations/);
    assert.match(html, /Program guides/);
    assert.match(html, /not an upcoming dated session/);
  });
});

test("Observe scope is serializable, replayable, and fails unsupported filters closed", async () => {
  await withPinnedClock("2026-09-15T12:00:00.000Z", () => {
    const scope = normalizeObserveScope("?body=bsa_calendar&access=remote&placeRole=venue");
    assert.equal(scope.activity, "observe");
    assert.equal(observeScopeUrl(scope), "/observe/?activity=observe&body=bsa_calendar&access=remote&placeRole=venue");
    assert.deepEqual(normalizeObserveScope("?body=all").errors, ["body"]);
    assert.equal(observeScopeUrl(normalizeObserveScope("?body=all")), null);
  });
});

test("A4: unsupported scope fails explicitly without showing the broader observation collection", async () => {
  await withPinnedClock("2026-09-15T12:00:00.000Z", () => {
    const day0 = todayISO();
    const day1 = addDays(day0, 1);
    const rows = fixtureRows(day0, day1);
    const openSurface = buildObserveSurface({ rows });
    assert.equal(openSurface.observations.length, 3);

    const surface = buildObserveSurface({ rows }, "?body=all");
    assert.deepEqual(surface.scope.errors, ["body"]);
    assert.equal(surface.scope.body, null);
    assert.deepEqual(surface.observations, []);
    assert.equal(surface.observations.length, 0);

    const html = renderObserveDocument(surface);
    assert.match(html, /class="observe-error"/);
    assert.match(html, /Unsupported observation filter:\s*body/);
    assert.doesNotMatch(html, /data-source-system=/);
    assert.doesNotMatch(html, /PDC public review|BSA executive review|OATH scheduled trial/);
    assert.match(html, /No scheduled observations match these supported filters/);
  });
});

test("Observe keeps native detail links and has a no-JavaScript reading path", async () => {
  await withPinnedClock("2026-09-15T12:00:00.000Z", () => {
    const day0 = todayISO();
    const day1 = addDays(day0, 1);
    const html = renderObserveDocument(buildObserveSurface({ rows: fixtureRows(day0, day1) }));
    assert.match(html, /<details>[\s\S]*Inspect observation/);
    assert.match(html, /href="\/meetings\//);
    assert.match(html, /<form method="get" action="\/observe\/">/);
    const noJs = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
    assert.doesNotMatch(noJs, /<script\b/i);
    assert.match(noJs, /href="https:\/\/example\.test\/(?:pdc|bsa|oath)"/);
  });
});
