/**
 * Follow / calendar / feed discovery projection and surface wiring.
 *
 *   node --test test/follow_discovery.test.mjs
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  FOLLOW_DISCOVERY_ACTION_KINDS,
  FOLLOW_DISCOVERY_SURFACE_MATRIX,
  followDiscoveryAlreadyPresent,
  projectFollowDiscovery,
  renderFeedReaderDisclosureForScope,
  renderFollowDiscoveryForBrowseView,
  renderFollowDiscoveryForNearYou,
  renderFollowDiscoveryForNow,
  renderFollowDiscoveryGroup,
} from "../site/follow_discovery.mjs";
import { buildBrowseView, renderBrowseView } from "../site/browse_view.mjs";
import { scopeFromRouteHash } from "../site/scope_v0.mjs";
import { renderNowBuildView } from "../site/primary_document_view.mjs";
import { GUIDE_HELP } from "../site/guide_contextual_links.mjs";

const PINNED = "2026-09-15";

function digest(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function meetingsScope(hash = "#meetings?agency=City%20Planning") {
  return scopeFromRouteHash(hash);
}

function datedMeetingRows() {
  return [{
    meeting_id: "meeting:city_record:123",
    title: "Public hearing",
    agency_name: "City Planning",
    event_date: "2026-09-15T11:00:00.000",
  }];
}

test("the surface matrix names the follow/calendar product families and dispositions", () => {
  const surfaces = FOLLOW_DISCOVERY_SURFACE_MATRIX.map((row) => row.surface);
  for (const name of [
    "search", "browse", "now", "near_you", "following",
    "board", "district", "institution", "project", "matter",
  ]) {
    assert.ok(surfaces.includes(name), name);
  }
  assert.equal(
    FOLLOW_DISCOVERY_SURFACE_MATRIX.find((row) => row.surface === "browse")?.disposition,
    "repair",
  );
  assert.equal(
    FOLLOW_DISCOVERY_SURFACE_MATRIX.find((row) => row.surface === "search")?.disposition,
    "positive_control",
  );
});

test("positive scoped projection exposes email follow, calendar subscription, and feed reader links", () => {
  const projection = projectFollowDiscovery({
    surface: "browse",
    scope: meetingsScope(),
    lens: "meetings",
    rows: datedMeetingRows(),
  });
  assert.equal(projection.creates_subscription_on_open, false);
  const kinds = projection.actions.map((action) => action.kind);
  assert.deepEqual(kinds, [
    FOLLOW_DISCOVERY_ACTION_KINDS.email_follow,
    FOLLOW_DISCOVERY_ACTION_KINDS.calendar_subscription,
    FOLLOW_DISCOVERY_ACTION_KINDS.feed_reader,
  ]);
  const follow = projection.actions[0];
  assert.match(follow.href, /\/following\?/);
  assert.match(follow.href, /lens=meetings/);
  assert.match(follow.href, /City\+Planning|City%20Planning|City Planning/);
  const calendar = projection.actions[1];
  assert.match(calendar.feedUrl, /lens=meetings/);
  assert.match(calendar.feedUrl, /City\+Planning|City%20Planning/);
  assert.match(calendar.webcalUrl, /^webcal:/);
  assert.equal(calendar.creates_subscription, false);
  const feeds = projection.actions[2].feeds;
  assert.match(feeds.atom, /feed\.xml\?/);
  assert.match(feeds.json, /feed\.json\?/);
  assert.equal(feeds.atom.includes("agency"), true);
  assert.equal(JSON.parse(new URL(feeds.atom).searchParams.get("filter")).agency, "City Planning");
});

test("undated rows omit calendar subscription and never invent dates", () => {
  const projection = projectFollowDiscovery({
    surface: "browse",
    scope: meetingsScope(),
    lens: "meetings",
    rows: [{ meeting_id: "meeting:city_record:456", title: "Undated notice" }],
  });
  assert.equal(
    projection.actions.some((action) => action.kind === FOLLOW_DISCOVERY_ACTION_KINDS.calendar_subscription),
    false,
  );
  assert.ok(projection.notes.some((note) => note.kind === "calendar_unavailable"));
  const html = renderFollowDiscoveryGroup(projection);
  assert.doesNotMatch(html, /Subscribe to calendar/);
  assert.match(html, /Get email updates/);
  assert.match(html, /Feed reader links/);
});

test("unsupported calendar dimensions stay fail-closed instead of broadening the feed", () => {
  const scope = meetingsScope("#meetings?council=33");
  scope.place.viewport = {
    level: "council_district",
    id: "33",
    parent: null,
    basis: "performance",
    view_box: null,
  };
  const projection = projectFollowDiscovery({
    surface: "browse",
    scope,
    lens: "meetings",
    rows: datedMeetingRows(),
  });
  assert.equal(
    projection.actions.some((action) => action.kind === FOLLOW_DISCOVERY_ACTION_KINDS.calendar_subscription),
    false,
  );
  const feed = projection.actions.find((action) => action.kind === FOLLOW_DISCOVERY_ACTION_KINDS.feed_reader);
  assert.ok(feed);
  // Atom/JSON (and ICS via the watch wire) keep the council filter; they never
  // drop it to invent a citywide substitute.
  const atomFilter = JSON.parse(new URL(feed.feeds.atom).searchParams.get("filter"));
  assert.equal(atomFilter.councilDistrict, "33");
  if (feed.feeds.ics) {
    const icsFilter = JSON.parse(new URL(feed.feeds.ics).searchParams.get("filter"));
    assert.equal(icsFilter.councilDistrict, "33");
  }
  assert.match(renderFollowDiscoveryGroup(projection), /Feed reader links/);
  assert.doesNotMatch(renderFollowDiscoveryGroup(projection), /Subscribe to calendar/);
});

test("labels distinguish email updates, calendar subscription, single-event download, and saved search", () => {
  const projection = projectFollowDiscovery({
    surface: "search",
    scope: meetingsScope(),
    lens: "meetings",
    rows: datedMeetingRows(),
    eventDownloadHref: "/meeting.ics?id=meeting%3Acity_record%3A123",
    includeSavedSearch: true,
  });
  const html = renderFollowDiscoveryGroup(projection);
  assert.match(html, /Get email updates/);
  assert.match(html, /Subscribe to calendar/);
  assert.match(html, /Download this event/);
  assert.match(html, /Save search on this device/);
  assert.match(html, /data-semantics="email_updates"/);
  assert.match(html, /data-semantics="updating_calendar_subscription"/);
  assert.match(html, /data-semantics="single_event_download"/);
  assert.match(html, /data-semantics="local_saved_search"/);
  assert.match(html, new RegExp(GUIDE_HELP.following.href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(html, new RegExp(GUIDE_HELP.calendar.href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(html, /creates a subscription by opening|enroll anyone by opening/i);
});

test("empty projection renders nothing rather than an empty panel", () => {
  assert.equal(renderFollowDiscoveryGroup(null), "");
  assert.equal(renderFollowDiscoveryGroup({ actions: [], notes: [] }), "");
});

test("duplicate prevention keeps a single discovery region", () => {
  const projection = projectFollowDiscovery({
    surface: "browse",
    scope: meetingsScope(),
    lens: "meetings",
    rows: datedMeetingRows(),
  });
  const first = renderFollowDiscoveryGroup(projection, { regionId: "browse-follow-discovery" });
  assert.match(first, /data-follow-discovery="1"/);
  assert.equal(followDiscoveryAlreadyPresent(first, "browse-follow-discovery"), true);
  assert.equal(
    renderFollowDiscoveryForBrowseView(
      buildBrowseView("meetings", { rows: datedMeetingRows() }, new URLSearchParams("agency=City%20Planning")),
      { existingHtml: first, regionId: "browse-follow-discovery" },
    ),
    "",
  );
});

test("Browse render path exposes follow and feeds beside the existing calendar control", () => {
  const view = buildBrowseView("meetings", {
    rows: datedMeetingRows(),
  }, new URLSearchParams("agency=City%20Planning"));
  const html = renderBrowseView(view);
  assert.match(html, /data-build-rendered="browse"/);
  assert.match(html, /Subscribe to calendar/);
  assert.equal((html.match(/class="calendar-subscribe-btn"/g) || []).length, 1);
  assert.match(html, /data-follow-discovery="1"/);
  assert.match(html, /Get email updates/);
  assert.match(html, /Feed reader links/);
  assert.match(html, /feed\.xml\?/);
  assert.match(html, /City\+Planning|City%20Planning|City Planning/);

  const empty = renderBrowseView(buildBrowseView("meetings", {
    rows: [{ meeting_id: "meeting:city_record:456", title: "Undated notice" }],
  }));
  assert.doesNotMatch(empty, /Subscribe to calendar/);
  assert.match(empty, /data-follow-discovery="1"/);
  assert.match(empty, /Get email updates/);
});

test("Near You keeps Watch these filters as the positive control and adds calendar or feeds", () => {
  const scope = scopeFromRouteHash("#map?level=community_district&id=M03&parent=Manhattan&lens=meetings");
  const html = renderFollowDiscoveryForNearYou({
    scope,
    lens: "meetings",
    isOverview: false,
    watchHref: "/following/?lens=meetings&filter=%7B%22communityDistrict%22%3A%22M03%22%7D",
    results: {
      records: [{
        id: "meeting:city_record:123",
        date: "2026-09-15T11:00:00.000",
        title: "Board hearing",
      }],
    },
  });
  assert.doesNotMatch(html, /Get email updates|Watch these filters|Feed reader links/);
  assert.doesNotMatch(html, /href="https:\/\/api\.cityscroll\.org/);
  assert.match(html, /Subscribe to calendar/);
  assert.equal(renderFollowDiscoveryForNearYou({ scope, lens: "meetings", isOverview: true }), "");
});

test("Now build-rendered and enhanced paths both mount the discovery group", () => {
  const surface = {
    generated_for: PINNED,
    coverage: { unavailable_sources: [] },
    act_by: {
      dated: [{
        id: "notice:1",
        request_id: "notice:1",
        act_by: "2026-09-20",
        due_date: "2026-09-20",
      }],
      open_without_date: [],
    },
    happening_soon: {
      items: [{
        meeting_id: "meeting:city_record:123",
        event_date: "2026-09-16T10:00:00.000",
        title: "Hearing",
      }],
    },
    counts: { total: 2 },
  };

  const buildHtml = renderNowBuildView({
    money: { open_as_of: PINNED, notices: [] },
    land: { generated_at: PINNED, projects: [] },
    property: { generated_at: PINNED, property_rows: [] },
    rules: { generated_at: PINNED, rows: [] },
    meetings: { generated_at: PINNED, rows: datedMeetingRows() },
    people: { generated_at: PINNED, rows: [] },
  }, PINNED);
  // renderNowBuildView builds its own surface; assert the helper and both mount points.
  assert.match(renderFollowDiscoveryForNow(surface), /data-follow-discovery-surface="now"/);
  assert.match(renderFollowDiscoveryForNow(surface), /Get email updates/);

  // Enhanced path uses the same helper as the build-rendered document.
  const enhanced = renderFollowDiscoveryForNow(surface, { regionId: "now-follow-discovery-enhanced" });
  assert.match(enhanced, /data-follow-discovery-region="now-follow-discovery-enhanced"/);
  assert.match(enhanced, /Get email updates/);
  assert.match(enhanced, /Feed reader links|Subscribe to calendar/);
  assert.equal(renderFollowDiscoveryForNow(surface, { existingHtml: enhanced, regionId: "now-follow-discovery-enhanced" }), "");

  assert.match(buildHtml, /data-build-rendered="now"/);
  assert.match(buildHtml, /data-follow-discovery-surface="now"/);
});

test("feed-reader disclosure for search preserves exact filters", () => {
  const scope = meetingsScope("#meetings?agency=Buildings&q=scaffold");
  const html = renderFeedReaderDisclosureForScope(scope, { lens: "meetings" });
  assert.match(html, /data-follow-discovery-feeds/);
  assert.match(html, /feed\.xml\?/);
  assert.match(html, /feed\.json\?/);
  const atom = html.match(/href="(https:\/\/api\.cityscroll\.org\/feed\.xml[^"]+)"/)?.[1];
  assert.ok(atom);
  const filter = JSON.parse(new URL(atom.replaceAll("&amp;", "&")).searchParams.get("filter"));
  assert.equal(filter.agency, "Buildings");
  assert.deepEqual(filter.keywords, ["scaffold"]);
});

test("follow-calendar browser case fixture records routes and content hashes", () => {
  const manifestPath = new URL("../docs/evidence/follow-calendar-discovery/capture-manifest.json", import.meta.url);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.schema, "cityscroll.follow_calendar_discovery_capture_manifest.v1");
  assert.match(manifest.revision, /^grounded at [0-9a-f]{40}$/);
  assert.ok(Array.isArray(manifest.captures));
  assert.ok(manifest.captures.length >= 4);
  const viewports = new Set(manifest.captures.map((capture) => capture.viewport));
  assert.ok(viewports.has("1440x1000"));
  assert.ok(viewports.has("390x844"));
  for (const capture of manifest.captures) {
    assert.match(capture.sha256, /^[a-f0-9]{64}$/, capture.route);
    assert.notEqual(capture.sha256, "local-headless-capture", capture.route);
    assert.ok(capture.assertion.length > 20, capture.route);
  }

  const browse = renderBrowseView(buildBrowseView("meetings", {
    rows: datedMeetingRows(),
  }, new URLSearchParams("agency=City%20Planning")));
  const browseCapture = manifest.captures.find((capture) => capture.route.startsWith("/browse/meetings/"));
  assert.ok(browseCapture);
  assert.equal(browseCapture.sha256, digest(browse));
});
