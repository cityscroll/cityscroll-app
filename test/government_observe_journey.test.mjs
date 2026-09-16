import test from "node:test";
import assert from "node:assert/strict";
import { normalizePdcCalendarMeeting, normalizeBsaCalendarMeeting, normalizeOathTrialCalendarMeeting } from "../site/meeting_object_contract.mjs";
import { buildObserveSurface, normalizeObserveScope, observeScopeUrl, renderObserveDocument } from "../site/government_observe.mjs";

const rows = [
  normalizePdcCalendarMeeting({ pdc_event_id: "pdc-1", title: "PDC public review", event_date: "2026-09-22", venue: { name: "City Hall" }, source_url: "https://example.test/pdc", description: "Review a public design proposal." }),
  normalizeBsaCalendarMeeting({ bsa_session_id: "bsa-1", title: "BSA executive review", event_date: "2026-09-23", venue: { name: "Municipal Building" }, source_url: "https://example.test/bsa", observer_access: { watch_url: "https://example.test/watch" } }),
  normalizeOathTrialCalendarMeeting({ oath_trial_session_id: "oath-1", title: "OATH scheduled trial", event_date: "2026-09-24", source_url: "https://example.test/oath", access_steps: [{ kind: "observer_instructions", destination: "https://example.test/oath" }] }),
  { source_system: "pdc_calendar", title: "Undated guide-like note" },
];

test("Observe combines dated PDC, BSA, and OATH records with separate guides", () => {
  const surface = buildObserveSurface({ rows });
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

test("Observe scope is serializable, replayable, and fails unsupported filters closed", () => {
  const scope = normalizeObserveScope("?body=bsa_calendar&access=remote&placeRole=venue");
  assert.equal(scope.activity, "observe");
  assert.equal(observeScopeUrl(scope), "/observe/?activity=observe&body=bsa_calendar&access=remote&placeRole=venue");
  assert.deepEqual(normalizeObserveScope("?body=all").errors, ["body"]);
  assert.equal(observeScopeUrl(normalizeObserveScope("?body=all")), null);
});

test("Observe keeps native detail links and has a no-JavaScript reading path", () => {
  const html = renderObserveDocument(buildObserveSurface({ rows }));
  assert.match(html, /<details>[\s\S]*Inspect observation/);
  assert.match(html, /href="\/meetings\//);
  assert.match(html, /<form method="get" action="\/observe\/">/);
  const noJs = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  assert.doesNotMatch(noJs, /<script\b/i);
  assert.match(noJs, /href="https:\/\/example\.test\/(?:pdc|bsa|oath)"/);
});
