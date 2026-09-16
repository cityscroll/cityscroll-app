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
  FOLLOW_DISCOVERY_LABELS,
  FOLLOW_DISCOVERY_SURFACE_MATRIX,
  followDiscoveryAlreadyPresent,
  hasDefensibleDatedOccurrences,
  observeFollowDiscoveryInspection,
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
import {
  buildFollowingViewModel,
  followingUrlFromWatch,
  renderFollowingDocument,
} from "../site/following_view.mjs";
import {
  communityBoardParticipationPaths,
  renderCommunityBoardParticipationSection,
} from "../site/community_board_participation.mjs";
import {
  exactInstitutionFollow,
  exactInstitutionFollowHref,
} from "../site/institution_follow_scope.mjs";
import { projectCalendarActionsHTML } from "../site/project_calendar.mjs";
import {
  councilMatterFollowMarkup,
  defaultRetainedMatterRoster,
} from "../site/council_matter_watch.mjs";
import { withPinnedClock } from "./helpers/test_clock.mjs";

const PINNED = "2026-09-15T12:00:00.000Z";
const GROUNDED_REVISION = "grounded at 008423660a08901f7914cf15759ad20c4fc0a281";

const EXPECTED_SURFACES = Object.freeze([
  "search",
  "browse",
  "now",
  "near_you",
  "following",
  "board",
  "district",
  "institution",
  "project",
  "matter",
]);

const EXPECTED_DISPOSITIONS = Object.freeze({
  search: "positive_control",
  browse: "repair",
  now: "repair",
  near_you: "repair",
  following: "positive_control",
  board: "positive_control",
  district: "repair",
  institution: "positive_control",
  project: "positive_control",
  matter: "positive_control",
});

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

test("A1 matrix is the exact ten-surface set with every disposition named", () => {
  assert.deepEqual(
    FOLLOW_DISCOVERY_SURFACE_MATRIX.map((row) => row.surface),
    [...EXPECTED_SURFACES],
  );
  assert.equal(FOLLOW_DISCOVERY_SURFACE_MATRIX.length, 10);
  const dispositions = Object.fromEntries(
    FOLLOW_DISCOVERY_SURFACE_MATRIX.map((row) => [row.surface, row.disposition]),
  );
  assert.deepEqual(dispositions, { ...EXPECTED_DISPOSITIONS });
  for (const row of FOLLOW_DISCOVERY_SURFACE_MATRIX) {
    assert.match(row.render_owner, /^site\/.+\.mjs/);
  }
});

test("positive scoped projection exposes email follow, calendar subscription, and feed reader links", async () => {
  await withPinnedClock(PINNED, () => {
    const projection = projectFollowDiscovery({
      surface: "browse",
      scope: meetingsScope(),
      lens: "meetings",
      rows: datedMeetingRows(),
    });
    assert.equal(projection.creates_subscription_on_open, false);
    assert.equal(hasDefensibleDatedOccurrences("meetings", datedMeetingRows()), true);
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
});

test("undated rows omit calendar subscription and never invent dates", async () => {
  await withPinnedClock(PINNED, () => {
    const rows = [{ meeting_id: "meeting:city_record:456", title: "Undated notice" }];
    assert.equal(hasDefensibleDatedOccurrences("meetings", rows), false);
    const projection = projectFollowDiscovery({
      surface: "browse",
      scope: meetingsScope(),
      lens: "meetings",
      rows,
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
});

test("unsupported calendar dimensions stay fail-closed instead of broadening the feed", async () => {
  await withPinnedClock(PINNED, () => {
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
    // Atom/JSON keep the council filter; they never drop it to invent a citywide substitute.
    const atomFilter = JSON.parse(new URL(feed.feeds.atom).searchParams.get("filter"));
    assert.equal(atomFilter.councilDistrict, "33");
    // ICS is asserted unconditionally: the standing watch wire still carries council.
    assert.ok(feed.feeds.ics, "ICS address must remain present with the council filter");
    const icsFilter = JSON.parse(new URL(feed.feeds.ics).searchParams.get("filter"));
    assert.equal(icsFilter.councilDistrict, "33");
    assert.match(renderFollowDiscoveryGroup(projection), /Feed reader links/);
    assert.doesNotMatch(renderFollowDiscoveryGroup(projection), /Subscribe to calendar/);
  });
});

test("ICS feed retains the council filter when the standing calendar address exists", async () => {
  await withPinnedClock(PINNED, () => {
    const projection = projectFollowDiscovery({
      surface: "browse",
      scope: meetingsScope("#meetings?council=33"),
      lens: "meetings",
      rows: datedMeetingRows(),
    });
    const feed = projection.actions.find((action) => action.kind === FOLLOW_DISCOVERY_ACTION_KINDS.feed_reader);
    assert.ok(feed?.feeds?.ics, "council-only meetings scopes must expose an ICS address");
    const icsFilter = JSON.parse(new URL(feed.feeds.ics).searchParams.get("filter"));
    assert.equal(icsFilter.councilDistrict, "33");
    const calendar = projection.actions.find(
      (action) => action.kind === FOLLOW_DISCOVERY_ACTION_KINDS.calendar_subscription,
    );
    assert.ok(calendar?.feedUrl);
    assert.equal(
      JSON.parse(new URL(calendar.feedUrl).searchParams.get("filter")).councilDistrict,
      "33",
    );
  });
});

test("unsupported feed combinations explain the refusal instead of offering a broader feed", async () => {
  await withPinnedClock(PINNED, () => {
    const html = renderFollowDiscoveryGroup({
      surface: "browse",
      actions: [{
        kind: FOLLOW_DISCOVERY_ACTION_KINDS.email_follow,
        label: FOLLOW_DISCOVERY_LABELS.email_follow,
        href: "/following/?lens=meetings",
      }],
      notes: [{
        kind: "feed_unavailable",
        message: FOLLOW_DISCOVERY_LABELS.unsupported_feed,
      }],
    });
    assert.match(html, /data-follow-discovery-unsupported="feed"/);
    assert.match(html, /Get email updates/);
    assert.match(html, /cannot be turned into a standing feed without dropping constraints/);
    assert.doesNotMatch(html, /feed\.xml\?|feed\.json\?/);
  });
});

test("labels distinguish email updates, calendar subscription, single-event download, and saved search", async () => {
  await withPinnedClock(PINNED, () => {
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
});

test("A3 opening inspecting or copying discovery tools creates no subscription", async () => {
  await withPinnedClock(PINNED, () => {
    const projection = projectFollowDiscovery({
      surface: "browse",
      scope: meetingsScope(),
      lens: "meetings",
      rows: datedMeetingRows(),
    });
    const enrollmentLog = [];
    for (const action of ["open", "inspect", "copy"]) {
      const observed = observeFollowDiscoveryInspection(projection, {
        enrollmentLog,
        action,
      });
      assert.equal(observed.before, 0, action);
      assert.equal(observed.after, 0, action);
      assert.equal(observed.created, 0, action);
      assert.equal(observed.enrolls_via_form, false, action);
      assert.equal(observed.opened, true, action);
    }
    assert.equal(enrollmentLog.length, 0);
    assert.equal(
      projection.actions.filter((action) => action.creates_subscription === true).length,
      0,
    );
  });
});

test("A5 failed handoff keeps the original controls and offers copy recovery", async () => {
  await withPinnedClock(PINNED, () => {
    const projection = projectFollowDiscovery({
      surface: "browse",
      scope: meetingsScope(),
      lens: "meetings",
      rows: datedMeetingRows(),
    });
    const html = renderFollowDiscoveryGroup(projection, { handoffStatus: "failed" });
    assert.match(html, /data-follow-discovery-failed="1"/);
    assert.match(html, /Get email updates/);
    assert.match(html, /Subscribe to calendar/);
    assert.match(html, /Feed reader links/);
    assert.match(html, /data-follow-discovery-recovery="copy"/);
    assert.match(html, /data-follow-discovery-recovery="navigate"/);
    assert.match(html, /Your original selection is unchanged/);
    const enrollmentLog = [];
    const afterFailure = observeFollowDiscoveryInspection(projection, {
      enrollmentLog,
      action: "copy",
    });
    assert.equal(afterFailure.created, 0);
    assert.equal(enrollmentLog.length, 0);
  });
});

test("empty projection renders nothing rather than an empty panel", () => {
  assert.equal(renderFollowDiscoveryGroup(null), "");
  assert.equal(renderFollowDiscoveryGroup({ actions: [], notes: [] }), "");
});

test("duplicate prevention keeps a single discovery region", async () => {
  await withPinnedClock(PINNED, () => {
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
});

test("Browse render path exposes follow and feeds beside the existing calendar control", async () => {
  await withPinnedClock(PINNED, () => {
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
});

test("Near You keeps Watch these filters as the positive control and adds calendar or feeds", async () => {
  await withPinnedClock(PINNED, () => {
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
});

test("Now build-rendered and enhanced paths both mount the discovery group", async () => {
  await withPinnedClock(PINNED, () => {
    const surface = {
      generated_for: "2026-09-15",
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
      money: { open_as_of: "2026-09-15", notices: [] },
      land: { generated_at: "2026-09-15", projects: [] },
      property: { generated_at: "2026-09-15", property_rows: [] },
      rules: { generated_at: "2026-09-15", rows: [] },
      meetings: { generated_at: "2026-09-15", rows: datedMeetingRows() },
      people: { generated_at: "2026-09-15", rows: [] },
    }, "2026-09-15");
    assert.match(renderFollowDiscoveryForNow(surface), /data-follow-discovery-surface="now"/);
    assert.match(renderFollowDiscoveryForNow(surface), /Get email updates/);

    const enhanced = renderFollowDiscoveryForNow(surface, { regionId: "now-follow-discovery-enhanced" });
    assert.match(enhanced, /data-follow-discovery-region="now-follow-discovery-enhanced"/);
    assert.match(enhanced, /Get email updates/);
    assert.match(enhanced, /Feed reader links|Subscribe to calendar/);
    assert.equal(renderFollowDiscoveryForNow(surface, { existingHtml: enhanced, regionId: "now-follow-discovery-enhanced" }), "");

    assert.match(buildHtml, /data-build-rendered="now"/);
    assert.match(buildHtml, /data-follow-discovery-surface="now"/);
  });
});

test("feed-reader disclosure for search preserves exact filters", async () => {
  await withPinnedClock(PINNED, () => {
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
});

test("A1 Following positive control keeps a single create-watch submit", async () => {
  await withPinnedClock(PINNED, () => {
    const html = renderFollowingDocument(buildFollowingViewModel({
      lens: "meetings",
      filter: { agency: "City Planning" },
      requested: true,
      frequency: "weekly",
      matchCount: 1,
    }, {}));
    assert.equal((html.match(/data-following-subscribe-form/g) || []).length, 1);
    assert.equal((html.match(/>Create watch</g) || []).length, 1);
    assert.match(html, /City Planning/);
  });
});

test("A1 board positive control keeps one calendar subscribe and one board follow", async () => {
  await withPinnedClock(PINNED, () => {
    const meeting = {
      relation: "hosts_meeting",
      status: "promoted",
      promoted: true,
      from: "community-board:manhattan-cb-02",
      to: "meeting:community_board:cb2-full-board",
      target_id: "meeting:community_board:cb2-full-board",
      target_name: "Manhattan CB2 Full Board",
      href: "/meetings/meeting%3Acommunity_board%3Acb2-full-board",
      date: "2026-09-10",
      provenance: { source_url: "https://example.test/cb2/calendar/" },
      source_receipt: { status: "ok", observed_at: "2026-08-27T00:00:00Z" },
    };
    const paths = communityBoardParticipationPaths({
      board_id: "manhattan-cb-02",
      board: {
        body_id: "manhattan-cb-02",
        homepage_url: "https://example.test/cb2/",
      },
      participation: null,
      meetings: [meeting],
      as_of: "2026-08-27T00:00:00.000Z",
    });
    const html = renderCommunityBoardParticipationSection(paths);
    assert.equal((html.match(/Subscribe to calendar/g) || []).length, 1);
    assert.equal((html.match(/Follow Manhattan Community Board 2/g) || []).length, 1);
    assert.doesNotMatch(html, /data-follow-discovery="1"/);
  });
});

test("A1 district repair mounts discovery for a council district scope", async () => {
  await withPinnedClock(PINNED, () => {
    const scope = scopeFromRouteHash("#map?level=council_district&id=33&lens=meetings");
    const html = renderFollowDiscoveryForNearYou({
      scope,
      lens: "meetings",
      isOverview: false,
      results: {
        records: [{
          id: "meeting:city_record:123",
          date: "2026-09-15T11:00:00.000",
          title: "District hearing",
        }],
      },
    }, { surface: "district" });
    assert.match(html, /data-follow-discovery-surface="district"/);
    assert.equal((html.match(/class="calendar-subscribe-btn/g) || []).length, 1);
    assert.match(html, /councilDistrict%22%3A%2233%22|councilDistrict":"33"/);
  });
});

test("A1 institution positive control keeps one exact follow address", async () => {
  await withPinnedClock(PINNED, () => {
    const follow = exactInstitutionFollow("city-planning");
    assert.equal(follow.status, "ok");
    assert.equal(follow.follow_label, "Follow City Planning");
    const href = exactInstitutionFollowHref("city-planning", { followingUrlFromWatch });
    assert.match(href, /lens=entity/);
    assert.match(href, /agency%3Aid%3Acity-planning|agency:id:city-planning/);
    assert.equal(href.split("/following").length - 1, 1);
  });
});

test("A1 project positive control keeps one follow and one calendar subscribe", async () => {
  await withPinnedClock(PINNED, () => {
    const html = projectCalendarActionsHTML({
      projectId: "2026M0001",
      projectName: "Riverfront rezoning",
    });
    assert.equal((html.match(/data-project-follow="project"/g) || []).length, 1);
    assert.equal((html.match(/class="[^"]*calendar-subscribe-btn/g) || []).length, 1);
    assert.match(html, />Follow project</);
    assert.match(html, />Subscribe to project calendar</);
  });
});

test("A1 matter positive control keeps one exact Council-matter follow link", async () => {
  await withPinnedClock(PINNED, () => {
    const matterId = [...defaultRetainedMatterRoster()][0];
    assert.ok(matterId);
    const html = councilMatterFollowMarkup({ lens: "meetings", matter_id: matterId });
    assert.match(html, /data-matter-id=/);
    assert.equal((html.match(/<a /g) || []).length, 1);
    assert.match(html, new RegExp(`Follow Council matter ${matterId}`));
    assert.match(html, /lens=meetings/);
  });
});

test("follow-calendar browser case fixture records routes and content hashes", async () => {
  await withPinnedClock(PINNED, () => {
    const manifestPath = new URL("../docs/evidence/follow-calendar-discovery/capture-manifest.json", import.meta.url);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.schema, "cityscroll.follow_calendar_discovery_capture_manifest.v1");
    assert.equal(manifest.revision, GROUNDED_REVISION);
    assert.ok(Array.isArray(manifest.captures));
    assert.ok(manifest.captures.length >= 4);
    const viewports = new Set(manifest.captures.map((capture) => capture.viewport));
    assert.ok(viewports.has("1440x1000"));
    assert.ok(viewports.has("390x844"));

    const requiredPhrases = {
      "/browse/meetings/": ["Subscribe to calendar", "Get email updates"],
      "/now/": ["Keep following this selection", "subscription"],
      "/#meetings": ["agency", "keyword"],
      "follow-discovery-group": ["email updates", "calendar subscription"],
    };

    for (const capture of manifest.captures) {
      assert.match(capture.sha256, /^[a-f0-9]{64}$/, capture.route);
      assert.notEqual(capture.sha256, "local-headless-capture", capture.route);
      assert.ok(capture.assertion.length > 20, capture.route);
      const key = Object.keys(requiredPhrases).find((prefix) => capture.route.startsWith(prefix));
      if (key) {
        for (const phrase of requiredPhrases[key]) {
          assert.match(
            capture.assertion,
            new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
            `${capture.route} assertion must name ${phrase}`,
          );
        }
      }
    }

    const browse = renderBrowseView(buildBrowseView("meetings", {
      rows: datedMeetingRows(),
    }, new URLSearchParams("agency=City%20Planning")));
    const browseCapture = manifest.captures.find((capture) => capture.route.startsWith("/browse/meetings/"));
    assert.ok(browseCapture);
    assert.equal(browseCapture.sha256, digest(browse));

    const nowHtml = renderNowBuildView({
      money: { open_as_of: "2026-09-15", notices: [] },
      land: { generated_at: "2026-09-15", projects: [] },
      property: { generated_at: "2026-09-15", property_rows: [] },
      rules: { generated_at: "2026-09-15", rows: [] },
      meetings: { generated_at: "2026-09-15", rows: datedMeetingRows() },
      people: { generated_at: "2026-09-15", rows: [] },
    }, "2026-09-15");
    for (const capture of manifest.captures.filter((row) => row.route === "/now/")) {
      assert.equal(capture.sha256, digest(nowHtml), capture.viewport);
    }

    const searchHtml = renderFeedReaderDisclosureForScope(
      meetingsScope("#meetings?agency=Buildings&q=scaffold"),
      { lens: "meetings" },
    );
    const searchCapture = manifest.captures.find((capture) => capture.route.startsWith("/#meetings"));
    assert.ok(searchCapture);
    assert.equal(searchCapture.sha256, digest(searchHtml));

    const groupHtml = renderFollowDiscoveryGroup(projectFollowDiscovery({
      surface: "search",
      scope: meetingsScope(),
      lens: "meetings",
      rows: datedMeetingRows(),
      eventDownloadHref: "/meeting.ics?id=meeting%3Acity_record%3A123",
      includeSavedSearch: true,
    }));
    const groupCapture = manifest.captures.find((capture) => capture.route === "follow-discovery-group");
    assert.ok(groupCapture);
    assert.equal(groupCapture.sha256, digest(groupHtml));
  });
});
