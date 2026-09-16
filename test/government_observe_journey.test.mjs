import test from "node:test";
import assert from "node:assert/strict";
import { normalizePdcCalendarMeeting, normalizeBsaCalendarMeeting, normalizeOathTrialCalendarMeeting } from "../site/meeting_object_contract.mjs";
import {
  buildObserveSurface,
  normalizeObserveScope,
  observeScopeUrl,
  OBSERVE_SPEAK_BOUNDARY,
  renderObserveDocument,
} from "../site/government_observe.mjs";
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

test("A4: an open proceeding is not advertised as permission to speak", async () => {
  await withPinnedClock("2026-09-15T12:00:00.000Z", () => {
    const day0 = todayISO();
    const day1 = addDays(day0, 1);
    const rows = [
      normalizePdcCalendarMeeting({
        pdc_event_id: "pdc-open",
        title: "PDC open public review",
        event_date: day0,
        venue: { name: "City Hall" },
        source_url: "https://example.test/pdc-open",
        description: "Review a public design proposal.",
        // Open + known speaking path still must not become a speak invitation on this list.
        speaking_rights: "allowed",
        access_steps: [{ kind: "observer_instructions", destination: "https://example.test/pdc-open" }],
      }),
      normalizeBsaCalendarMeeting({
        bsa_session_id: "bsa-open",
        title: "BSA open executive review",
        event_date: day1,
        venue: { name: "Municipal Building" },
        source_url: "https://example.test/bsa-open",
        speaking_rights: "requires_registration",
        observer_access: { watch_url: "https://example.test/watch-open" },
      }),
      normalizeOathTrialCalendarMeeting({
        oath_trial_session_id: "oath-open",
        title: "OATH open scheduled trial",
        event_date: day1,
        source_url: "https://example.test/oath-open",
        access_steps: [{ kind: "observer_instructions", destination: "https://example.test/oath-open" }],
      }),
    ];

    const surface = buildObserveSurface({ rows });
    // Denominator: the collection has open proceedings to advertise wrongly if it chose to.
    assert.equal(surface.observations.length, 3);
    assert.deepEqual(
      surface.observations.map((row) => row.source_system),
      ["pdc_calendar", "bsa_calendar", "oath_trial_calendar"],
    );

    const bySource = Object.fromEntries(surface.observations.map((row) => [row.source_system, row]));
    // Intermediate state: speaking rights are carried from source, not invented from openness.
    assert.equal(bySource.pdc_calendar.speaking_rights, "allowed");
    assert.equal(bySource.bsa_calendar.speaking_rights, "requires_registration");
    assert.equal(bySource.oath_trial_calendar.speaking_rights, "unknown");

    const html = renderObserveDocument(surface);
    assert.match(html, /class="observe-speak-boundary"/);
    assert.match(html, new RegExp(OBSERVE_SPEAK_BOUNDARY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    // Two independent negatives: no speak-invitation copy, and no speak/testify affordance.
    assert.doesNotMatch(
      html,
      /register to (?:testify|speak)|sign up to testify|you (?:may|can) speak|Request to speak|Submit testimony/i,
    );
    assert.doesNotMatch(html, /data-action-kind="(?:testify|speak)"|href="[^"]*testify/i);
    // The three open titles remain present as observations, so the boundary is about framing, not hiding.
    assert.match(html, /PDC open public review/);
    assert.match(html, /BSA open executive review/);
    assert.match(html, /OATH open scheduled trial/);
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
