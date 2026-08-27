import assert from "node:assert/strict";
import { test } from "node:test";

import {
  calendarOccurrenceForRow,
  calendarSubscriptionHrefForBrowseView,
  calendarSubscriptionHrefForScope,
  hasDefensibleDatedOccurrences,
  renderCalendarSubscriptionAffordance,
} from "../site/calendar_subscription.mjs";
import { buildBrowseView, renderBrowseView } from "../site/browse_view.mjs";
import { scopeFromRouteHash } from "../site/scope_v0.mjs";

test("subscription eligibility requires a feed identity and a defensible date", () => {
  assert.deepEqual(
    calendarOccurrenceForRow("meetings", {
      meeting_id: "meeting:city_record:123",
      event_date: "2026-09-15T11:00:00.000",
    }),
    { id: "meeting:city_record:123", date: "2026-09-15T11:00:00.000" },
  );
  assert.equal(calendarOccurrenceForRow("meetings", { event_date: "2026-09-15" }), null);
  assert.equal(calendarOccurrenceForRow("meetings", { meeting_id: "meeting:1" }), null);
  assert.equal(calendarOccurrenceForRow("money", { procurement_id: "CT1", due_date: "2026-09-15" }), null);
  assert.equal(calendarOccurrenceForRow("land", { request_id: "1", event_date: "2026-09-15" }), null);
  assert.equal(hasDefensibleDatedOccurrences("rules", [{ request_id: "1", due_date: "2026-09-15" }]), true);
  assert.equal(hasDefensibleDatedOccurrences("rules", [{ request_id: "1" }]), false);
});

test("subscription URL reuses the complete displayed scope serialization", () => {
  const scope = scopeFromRouteHash("#meetings?agency=City%20Planning&council=33&when=upcoming");
  const href = calendarSubscriptionHrefForScope(scope, {
    rows: [{ meeting_id: "meeting:city_record:123", event_date: "2026-09-15" }],
  });
  assert.ok(href);
  const url = new URL(href);
  assert.equal(url.searchParams.get("lens"), "meetings");
  assert.deepEqual(JSON.parse(url.searchParams.get("filter")), {
    agency: "City Planning",
    councilDistrict: "33",
    dateWindow: "upcoming",
    when: "upcoming",
  });
});

test("Browse renders a subscription sibling only for eligible dated rows", () => {
  const eligible = buildBrowseView("meetings", {
    rows: [{
      meeting_id: "meeting:city_record:123",
      title: "Public hearing",
      agency_name: "City Planning",
      event_date: "2026-09-15T11:00:00.000",
    }],
  }, new URLSearchParams("agency=City%20Planning"));
  const html = renderBrowseView(eligible);
  assert.match(html, /class="calendar-subscribe-btn"[^>]+aria-label="Subscribe to calendar for this scope"/);
  assert.match(html, />Subscribe to calendar<\/a>/);
  assert.doesNotMatch(html, /ui-object-card-action-rail|What can I do now/);

  const empty = buildBrowseView("meetings", {
    rows: [{ meeting_id: "meeting:city_record:456", title: "Undated notice" }],
  });
  assert.doesNotMatch(renderBrowseView(empty), /Subscribe to calendar/);
});

test("Browse subscription helper remains fail-closed for unsupported scope dimensions", () => {
  const scope = scopeFromRouteHash("#meetings?council=33");
  scope.place.viewport = { level: "council_district", id: "33", parent: null, basis: "performance", view_box: null };
  const view = {
    facet: "meetings",
    config: { tab: "meetings" },
    scope: { mode: "scoped" },
    scopeObject: scope,
    calendarRows: [{ meeting_id: "meeting:1", event_date: "2026-09-15" }],
  };
  assert.equal(calendarSubscriptionHrefForBrowseView(view), null);
  assert.equal(renderCalendarSubscriptionAffordance(view), "");
});
