/**
 * Neighborhood category coverage (cd64c975cc55e) and no-lens overview
 * (c90e4a1c5038a) for Chelsea-Hudson Yards.
 *
 * Coverage: Chelsea previously looked "unsupported" for meetings because
 * Land-only NTA bags omitted every empty non-Land key, while a sibling NTA that
 * had any non-Land hit received fabricated empty arrays. Coverage must stay
 * independent per lens.
 *
 * Overview: a no-lens NTA selection must open a useful place summary with local
 * Zoning, labeled broader district meetings or the board calendar, current-clock
 * upcoming prioritization, and map/records links that keep overview intent.
 *
 * Verifier: node --test test/near_you_chelsea_repair.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { geographyRecordProjection } from "../site/geography_navigation_records.mjs";
import { scopeFromNearYouUrl } from "../site/near_you_scope_runtime.mjs";
import {
  buildNearYouViewModel,
  renderNearYouDeferredParts,
  renderNearYouDocument,
} from "../site/near_you_view.mjs";
import {
  buildNearYou,
  broaderDistrictsFromCommittedArtifacts,
  placeCoverageState,
  residentialPlacesFromNtaLayer,
} from "../tools/build_worker_route_read_models.mjs";
import { buildDistrictActivity } from "../tools/lib/district_activity.mjs";
import { loadDistrictActivityInputs } from "../tools/build_district_activity.mjs";
import {
  loadNearYouActivity,
  mergeCoverage,
  nearYouLensesForRequest,
  NEAR_YOU_ACTIVITY_LENSES,
} from "../worker/src/lib/route_read_model_kv.mjs";
import { MILLISECONDS_PER_DAY, withPinnedClock } from "./helpers/test_clock.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));

const CHELSEA = "geography:nta2020:MN0401";
const HELLS_KITCHEN = "geography:nta2020:MN0402";
const M04 = "geography:community_district:M04";
const LOCAL_UNSUPPORTED_COPY = "We can’t filter these meetings to this neighborhood yet.";
const LOCAL_ZERO_COPY = "No mapped meetings match these filters.";

function committedActivity() {
  return readJson("site/data/district_activity.json");
}

function residentialPlaces() {
  return residentialPlacesFromNtaLayer(readJson("site/data/geography/layers/nta2020/26B.json"));
}

function boundaries() {
  return readJson("site/data/district_boundaries.json");
}

function communityGeography() {
  return readJson("site/data/community_board_geography_lookup.json");
}

function nearYouScope(query) {
  return scopeFromNearYouUrl(`https://cityscroll.org/near-you/?${query}`);
}

function chelseaBroaderDistricts(activity = committedActivity()) {
  const relations = broaderDistrictsFromCommittedArtifacts()[CHELSEA] || [];
  const slices = {};
  for (const relation of relations) {
    const memberIds = activity.district_items?.by_level?.community_district?.[relation.id]?.meetings || [];
    slices[relation.key] = {
      records: {
        meetings: Object.fromEntries(
          memberIds.map((id) => [id, activity.records.meetings[id]]).filter(([, row]) => row),
        ),
      },
      district_items: {
        by_level: {
          community_district: {
            [relation.id]: { meetings: memberIds },
          },
        },
      },
    };
  }
  return { relations, slices };
}

function chelseaOverviewView(query, options = {}) {
  const activity = options.activity || committedActivity();
  return buildNearYouViewModel(nearYouScope(query), activity, boundaries(), {
    canonicalBase: "https://cityscroll.org/near-you",
    communityGeography: communityGeography(),
    broaderDistricts: options.broaderDistricts === undefined
      ? chelseaBroaderDistricts(activity)
      : options.broaderDistricts,
    now: options.now,
    dataState: options.dataState,
  });
}

function lensBag(activity, key) {
  const bag = activity?.geography_items?.by_key?.[key];
  if (!bag || typeof bag !== "object") return null;
  return Object.fromEntries(
    Object.entries(bag).map(([lens, ids]) => [lens, Array.isArray(ids) ? ids.length : ids]),
  );
}

test("A1: Chelsea and Hell's Kitchen meetings states come from meetings evidence alone", () => {
  const activity = committedActivity();
  const chelseaBag = lensBag(activity, CHELSEA);
  const hkBag = lensBag(activity, HELLS_KITCHEN);

  assert.ok(chelseaBag, "Chelsea NTA is published");
  assert.ok((chelseaBag.land || 0) > 0, "Chelsea keeps positive Land membership");
  assert.equal(
    Object.prototype.hasOwnProperty.call(activity.geography_items.by_key[CHELSEA], "meetings"),
    false,
    "Chelsea must not carry a fabricated empty meetings array",
  );

  const chelseaMeetings = geographyRecordProjection(activity, { key: CHELSEA, lens: "meetings" });
  const chelseaLand = geographyRecordProjection(activity, { key: CHELSEA, lens: "land" });
  assert.equal(chelseaLand.state, "ready");
  assert.ok(chelseaLand.count > 0);
  assert.equal(chelseaMeetings.state, "unfilterable");
  assert.equal(chelseaMeetings.exact, false);
  assert.equal(chelseaMeetings.count, null);
  assert.equal(placeCoverageState(activity, CHELSEA, "meetings"), "source_unavailable");
  assert.equal(placeCoverageState(activity, CHELSEA, "land"), "ready");

  assert.ok(hkBag, "Hell's Kitchen NTA is published");
  assert.ok((hkBag.meetings || 0) > 0, "Hell's Kitchen keeps venue meeting membership");
  const hkMeetings = geographyRecordProjection(activity, { key: HELLS_KITCHEN, lens: "meetings" });
  assert.equal(hkMeetings.state, "ready");
  assert.equal(hkMeetings.count, hkBag.meetings);
  assert.equal(placeCoverageState(activity, HELLS_KITCHEN, "meetings"), "ready");

  // Positive control: an explicit empty meetings list remains measured zero.
  const measured = structuredClone(activity);
  measured.geography_items.by_key[CHELSEA] = {
    ...measured.geography_items.by_key[CHELSEA],
    meetings: [],
  };
  const measuredZero = geographyRecordProjection(measured, { key: CHELSEA, lens: "meetings" });
  assert.equal(measuredZero.state, "zero");
  assert.equal(measuredZero.exact, true);
  assert.equal(measuredZero.count, 0);
});

test("A1 independence: adding an unrelated lens record cannot change Chelsea meetings coverage", () => {
  const activity = committedActivity();
  const before = geographyRecordProjection(activity, { key: CHELSEA, lens: "meetings" });
  assert.equal(before.state, "unfilterable");

  const withProperty = structuredClone(activity);
  const bag = withProperty.geography_items.by_key[CHELSEA];
  bag.property = ["property:independence-control"];
  // Sibling empty arrays must stay absent; only the admitting lens is added.
  assert.equal(Object.prototype.hasOwnProperty.call(bag, "meetings"), false);

  const after = geographyRecordProjection(withProperty, { key: CHELSEA, lens: "meetings" });
  assert.equal(after.state, before.state);
  assert.equal(after.count, before.count);
  assert.equal(after.exact, before.exact);
  assert.equal(placeCoverageState(withProperty, CHELSEA, "meetings"), "source_unavailable");
  assert.equal(
    geographyRecordProjection(withProperty, { key: CHELSEA, lens: "property" }).state,
    "ready",
  );
});

test("A2: Hell's Kitchen venue meetings and M04 board jurisdiction stay out of exact Chelsea membership", () => {
  const activity = committedActivity();
  const chelseaMeetings = geographyRecordProjection(activity, { key: CHELSEA, lens: "meetings" });
  const hkMeetings = geographyRecordProjection(activity, { key: HELLS_KITCHEN, lens: "meetings" });
  const m04Meetings = geographyRecordProjection(activity, { key: M04, lens: "meetings" });

  assert.equal(chelseaMeetings.ids.length, 0);
  assert.ok(hkMeetings.ids.length > 0);
  assert.ok(m04Meetings.ids.length > 0);

  for (const id of hkMeetings.ids) {
    assert.equal(chelseaMeetings.ids.includes(id), false, `HK venue ${id} must not be exact Chelsea`);
  }
  for (const id of m04Meetings.ids) {
    assert.equal(chelseaMeetings.ids.includes(id), false, `M04 board ${id} must not be exact Chelsea`);
  }

  // Citywide bag stays a separate scope, not neighborhood membership.
  const citywide = activity.district_items?.citywide?.meetings || [];
  assert.ok(Array.isArray(citywide));
  for (const id of citywide) {
    assert.equal(chelseaMeetings.ids.includes(String(id)), false);
  }
});

test("A2 builder: rebuilt activity omits sibling empty arrays and keeps per-lens coverage metadata", () => {
  const inputs = loadDistrictActivityInputs();
  const activity = buildDistrictActivity({
    ...inputs,
    builtAt: "2026-10-08T00:00:00.000Z",
  });

  const chelseaBag = activity.geography_items.by_key[CHELSEA];
  assert.ok(chelseaBag, "rebuild publishes Chelsea");
  assert.ok(Array.isArray(chelseaBag.land) && chelseaBag.land.length > 0);
  assert.equal(Object.prototype.hasOwnProperty.call(chelseaBag, "meetings"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(chelseaBag, "property"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(chelseaBag, "rules"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(chelseaBag, "money"), false);

  const hkBag = activity.geography_items.by_key[HELLS_KITCHEN];
  assert.ok(Array.isArray(hkBag.meetings) && hkBag.meetings.length > 0);
  // Hell's Kitchen may still omit empty sibling lenses; that is observed-only.
  for (const lens of ["property", "rules", "money"]) {
    if (Object.prototype.hasOwnProperty.call(hkBag, lens)) {
      assert.ok(Array.isArray(hkBag[lens]));
      assert.ok(hkBag[lens].length > 0, `${lens} empty arrays must not be sibling-filled`);
    }
  }

  const meetingsCoverage = activity.geography_items.coverage.by_lens.meetings;
  assert.equal(meetingsCoverage.status, "ready");
  assert.equal(meetingsCoverage.match_bound, "observed_nta_membership_only");
  assert.equal(meetingsCoverage.types.nta2020.status, "observed_only");
  assert.equal(
    geographyRecordProjection(activity, { key: CHELSEA, lens: "meetings" }).state,
    "unfilterable",
  );
  assert.equal(
    geographyRecordProjection(activity, { key: HELLS_KITCHEN, lens: "meetings" }).state,
    "ready",
  );

  // Negative control: reintroducing sibling fill-in would invent Chelsea meetings zero.
  const coupled = structuredClone(activity);
  coupled.geography_items.by_key[CHELSEA].property = ["property:coupled"];
  coupled.geography_items.by_key[CHELSEA].meetings = [];
  assert.equal(
    geographyRecordProjection(coupled, { key: CHELSEA, lens: "meetings" }).state,
    "zero",
    "control: an invented empty meetings array would become measured zero",
  );
});

test("A3 builder-to-slice-to-view: Chelsea meetings stay unsupported while Land stays ready", () => {
  const activity = committedActivity();
  const places = residentialPlaces().filter((place) => (
    place.key === CHELSEA || place.key === HELLS_KITCHEN
  ));
  const built = buildNearYou(activity, {}, "chelsea-repair", { residentialPlaces: places });

  const chelseaMeetingsSlice = JSON.parse(
    built.entries.find((row) => row.key === built.manifest.slices[`${CHELSEA}:meetings`]).value,
  );
  const chelseaLandSlice = JSON.parse(
    built.entries.find((row) => row.key === built.manifest.slices[`${CHELSEA}:land`]).value,
  );
  const hkMeetingsSlice = JSON.parse(
    built.entries.find((row) => row.key === built.manifest.slices[`${HELLS_KITCHEN}:meetings`]).value,
  );

  assert.equal(chelseaMeetingsSlice.coverage.state, "source_unavailable");
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      chelseaMeetingsSlice.activity.geography_items.by_key[CHELSEA] || {},
      "meetings",
    ),
    false,
  );
  assert.equal(chelseaLandSlice.coverage.state, "ready");
  assert.ok(chelseaLandSlice.activity.geography_items.by_key[CHELSEA].land.length > 0);
  assert.equal(hkMeetingsSlice.coverage.state, "ready");
  assert.ok(hkMeetingsSlice.activity.geography_items.by_key[HELLS_KITCHEN].meetings.length > 0);

  const chelseaView = buildNearYouViewModel(
    nearYouScope("geo=nta2020:MN0401&lens=meetings&surface=records"),
    activity,
    boundaries(),
    { canonicalBase: "https://cityscroll.org/near-you" },
  );
  assert.equal(chelseaView.localRecovery?.state, "unsupported");
  assert.equal(chelseaView.localRecovery?.message, LOCAL_UNSUPPORTED_COPY);
  assert.equal(chelseaView.results.count, null);
  const chelseaHtml = renderNearYouDeferredParts(chelseaView).resultsHtml;
  assert.match(chelseaHtml, /data-near-local-recovery="unsupported"/);
  assert.doesNotMatch(chelseaHtml, new RegExp(LOCAL_ZERO_COPY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const hkView = buildNearYouViewModel(
    nearYouScope("geo=nta2020:MN0402&lens=meetings&surface=records"),
    activity,
    boundaries(),
    { canonicalBase: "https://cityscroll.org/near-you" },
  );
  assert.equal(hkView.localRecovery, null);
  assert.ok((hkView.results.count || 0) > 0);
  assert.doesNotMatch(renderNearYouDeferredParts(hkView).resultsHtml, /data-near-local-recovery="unsupported"/);

  const landView = buildNearYouViewModel(
    nearYouScope("geo=nta2020:MN0401&lens=land&surface=records"),
    activity,
    boundaries(),
    { canonicalBase: "https://cityscroll.org/near-you" },
  );
  assert.equal(landView.localRecovery, null);
  assert.ok((landView.results.count || 0) > 0);
});

test("A3 failure-3: no-lens Chelsea loads every lens and keeps Land ready while Meetings stays unfilterable", async () => {
  const activity = committedActivity();
  const places = residentialPlaces().filter((place) => place.key === CHELSEA || place.key === HELLS_KITCHEN);
  const built = buildNearYou(activity, {}, "chelsea-multilens", { residentialPlaces: places });
  const values = new Map(built.entries.map(({ key, value }) => [key, value]));
  values.set("route-read-model:near-you:manifest:v1", JSON.stringify(built.manifest));

  const noLensScope = nearYouScope("geo=nta2020:MN0401&surface=records");
  assert.deepEqual(noLensScope.facets.domains, []);
  assert.deepEqual(nearYouLensesForRequest(noLensScope), NEAR_YOU_ACTIVITY_LENSES.slice());
  assert.deepEqual(nearYouLensesForRequest(nearYouScope("surface=records")), ["meetings"]);

  const loaded = await loadNearYouActivity(
    { ALERT_STATE: { async get(key) { return values.get(key) || null; } } },
    noLensScope,
  );
  assert.deepEqual(loaded.lenses, NEAR_YOU_ACTIVITY_LENSES.slice());
  assert.equal(loaded.sections.primary.state, "ready");
  assert.equal(
    geographyRecordProjection(loaded.activity, { key: CHELSEA, lens: "land" }).state,
    "ready",
  );
  assert.ok(geographyRecordProjection(loaded.activity, { key: CHELSEA, lens: "land" }).count > 0);
  assert.equal(
    geographyRecordProjection(loaded.activity, { key: CHELSEA, lens: "meetings" }).state,
    "unfilterable",
  );
  assert.equal(loaded.activity.geography_items.coverage.by_lens.land.status, "ready");
  assert.equal(
    loaded.activity.geography_items.coverage.by_lens.meetings.types.nta2020.status,
    "observed_only",
  );

  // Explicit meetings-only requests still load a single lens.
  assert.deepEqual(
    nearYouLensesForRequest(nearYouScope("geo=nta2020:MN0401&lens=meetings&surface=records")),
    ["meetings"],
  );
});

test("A3 failure-3: Meetings read failure leaves Chelsea Land membership available", async () => {
  const activity = committedActivity();
  const places = residentialPlaces().filter((place) => place.key === CHELSEA);
  const built = buildNearYou(activity, {}, "chelsea-land-survives", { residentialPlaces: places });
  const values = new Map(built.entries.map(({ key, value }) => [key, value]));
  values.set("route-read-model:near-you:manifest:v1", JSON.stringify(built.manifest));
  const meetingsKey = built.manifest.slices[`${CHELSEA}:meetings`];
  assert.ok(meetingsKey);

  const store = {
    async get(key) {
      if (key === meetingsKey) throw new Error("meetings slice transport failure");
      return values.get(key) || null;
    },
  };
  const loaded = await loadNearYouActivity({ ALERT_STATE: store }, nearYouScope("geo=nta2020:MN0401&surface=records"));
  assert.equal(loaded.sections.primary.state, "ready");
  assert.equal(
    geographyRecordProjection(loaded.activity, { key: CHELSEA, lens: "land" }).state,
    "ready",
  );
  assert.ok(geographyRecordProjection(loaded.activity, { key: CHELSEA, lens: "land" }).count > 0);
  assert.equal(
    Object.prototype.hasOwnProperty.call(loaded.activity.geography_items.by_key[CHELSEA] || {}, "meetings"),
    false,
  );
});

test("A3 failure-3: multi-lens coverage merge keeps Zoning when Meetings metadata differs", () => {
  const land = {
    geography_items: {
      coverage: {
        status: "ready",
        by_lens: {
          land: {
            status: "ready",
            types: { nta2020: { status: "ready" } },
          },
        },
      },
    },
  };
  const meetings = {
    geography_items: {
      coverage: {
        status: "ready",
        by_lens: {
          meetings: {
            status: "ready",
            match_bound: "observed_nta_membership_only",
            types: { nta2020: { status: "observed_only" } },
          },
        },
      },
    },
  };
  const merged = mergeCoverage([land, meetings]);
  assert.equal(merged.status, "ready");
  assert.deepEqual(merged.by_lens.land, land.geography_items.coverage.by_lens.land);
  assert.deepEqual(merged.by_lens.meetings, meetings.geography_items.coverage.by_lens.meetings);

  const conflictedLand = {
    geography_items: {
      coverage: {
        status: "ready",
        by_lens: {
          land: {
            status: "ready",
            generation_id: "other-generation",
            types: { nta2020: { status: "ready", generation_id: "other-generation" } },
          },
        },
      },
    },
  };
  const poisoned = mergeCoverage([land, conflictedLand, meetings]);
  assert.equal(poisoned.by_lens.land.status, "unavailable");
  assert.equal(poisoned.by_lens.land.reason, "slice_coverage_conflict");
  assert.deepEqual(poisoned.by_lens.meetings, meetings.geography_items.coverage.by_lens.meetings);
});

test("overview A1: no-lens Chelsea exposes Zoning, broader M04, and the board calendar", () => {
  const view = chelseaOverviewView("geo=nta2020:MN0401&surface=records", {
    now: "2026-09-01T12:00:00.000Z",
  });
  assert.equal(view.isOverview, true);
  assert.equal(view.overview.state, "ready");
  assert.equal(view.localRecovery, null);
  assert.equal(view.scope.place.geographies[0], CHELSEA);
  assert.deepEqual(view.scope.place.community_districts, [], "selected place must stay exact NTA");

  const projects = view.overview.sections.find((section) => section.key === "projects");
  assert.ok(projects.count > 0, "local Zoning / projects must be discoverable");
  assert.ok(projects.records.length > 0);

  const board = view.overview.sections.find((section) => section.key === "board-activity");
  assert.match(board.coverage, /overlapping community district|named Community Board/i);
  assert.ok(view.placePresentation.boardHref, "covering board calendar link");
  assert.match(view.placePresentation.boardHref, /manhattan-cb-04/);

  assert.ok(view.broader_districts?.districts?.some((row) => row.id === "M04"));
  assert.ok((view.broader_districts.districts.find((row) => row.id === "M04").records || []).length > 0);

  const html = renderNearYouDocument(view);
  assert.match(html, /data-near-overview="true"/);
  assert.doesNotMatch(html, /<details class="near-selected-context">[\s\S]*data-near-overview="true"/);
  assert.match(html, /Chelsea-Hudson Yards/);
  assert.match(html, /Open Zoning|Projects/i);
  // Meetings stay unknown in the overview section; that is not a local-recovery banner.
  assert.match(html, /id="near-overview-upcoming"[\s\S]*We can’t filter these meetings to this neighborhood yet/);
  assert.doesNotMatch(html, /data-near-local-recovery=/);
  assert.doesNotMatch(html, /All NYC meetings/);

  const continuation = view.overlapModel?.continuation?.href || "";
  assert.match(continuation, /surface=records/);
  assert.doesNotMatch(continuation, /lens=meetings/);
  assert.doesNotMatch(view.shareHref, /lens=/);
});

test("overview review-1: absent Meetings stay unknown while ready Land stays positive; measured empty is zero", () => {
  const view = chelseaOverviewView("geo=nta2020:MN0401&surface=records", {
    now: "2026-09-01T12:00:00.000Z",
  });
  const upcoming = view.overview.sections.find((section) => section.key === "upcoming");
  const projects = view.overview.sections.find((section) => section.key === "projects");
  const consultations = view.overview.sections.find((section) => section.key === "consultations");

  assert.equal(
    geographyRecordProjection(committedActivity(), { key: CHELSEA, lens: "meetings" }).state,
    "unfilterable",
  );
  assert.equal(upcoming.count, null, "unfilterable Meetings must not become overview zero");
  assert.equal(upcoming.records.length, 0);
  assert.match(upcoming.coverage || "", /can’t filter these meetings/i);
  assert.doesNotMatch(upcoming.coverage || "", /No upcoming activity/);

  assert.ok(projects.count > 0, "ready Land / projects must stay positive");
  assert.ok(projects.records.length > 0);

  assert.equal(consultations.count, null, "absent consultations stay unknown");
  assert.match(consultations.coverage || "", /can’t filter these consultations/i);
  assert.doesNotMatch(consultations.coverage || "", /No consultations are recorded/);

  // Measured-empty control: an explicit empty meetings array remains zero.
  const measured = structuredClone(committedActivity());
  measured.geography_items.by_key[CHELSEA] = {
    ...measured.geography_items.by_key[CHELSEA],
    meetings: [],
  };
  const zeroView = chelseaOverviewView("geo=nta2020:MN0401&surface=records", {
    activity: measured,
    now: "2026-09-01T12:00:00.000Z",
    broaderDistricts: chelseaBroaderDistricts(measured),
  });
  const zeroUpcoming = zeroView.overview.sections.find((section) => section.key === "upcoming");
  assert.equal(
    geographyRecordProjection(measured, { key: CHELSEA, lens: "meetings" }).state,
    "zero",
  );
  assert.equal(zeroUpcoming.count, 0);
  assert.match(zeroUpcoming.coverage || "", /No upcoming activity/);
  assert.doesNotMatch(zeroUpcoming.coverage || "", /can’t filter these meetings/i);
});

test("overview A2: explicit meetings stays meetings; another NTA and zero stay scoped", () => {
  const meetings = chelseaOverviewView("geo=nta2020:MN0401&lens=meetings&surface=records");
  assert.equal(meetings.isOverview, false);
  assert.equal(meetings.lens, "meetings");
  assert.equal(meetings.overview.state, "not_requested");
  assert.equal(meetings.localRecovery?.state, "unsupported");

  const hk = chelseaOverviewView("geo=nta2020:MN0402&surface=records", {
    broaderDistricts: {
      relations: broaderDistrictsFromCommittedArtifacts()[HELLS_KITCHEN] || [],
      slices: {},
    },
  });
  assert.equal(hk.isOverview, true);
  assert.equal(hk.scope.place.geographies[0], HELLS_KITCHEN);
  assert.deepEqual(hk.scope.place.community_districts, []);
  assert.doesNotMatch(hk.placePresentation.label || "", /Chelsea/);
  // Hell's Kitchen exact meetings stay available; Chelsea unfilterable copy does not appear.
  assert.equal(hk.localRecovery, null);
  const hkHtml = renderNearYouDocument(hk);
  assert.doesNotMatch(hkHtml, /We can’t filter these meetings to this neighborhood yet/);

  const zeroActivity = structuredClone(committedActivity());
  zeroActivity.geography_items.by_key[CHELSEA] = {
    ...zeroActivity.geography_items.by_key[CHELSEA],
    land: [],
  };
  const zeroView = chelseaOverviewView("geo=nta2020:MN0401&lens=land&surface=records", {
    activity: zeroActivity,
  });
  assert.equal(zeroView.isOverview, false);
  assert.equal(zeroView.results.count, 0);
  assert.equal(zeroView.localRecovery?.state, "zero");
});

test("overview A3: upcoming uses the resident clock, not artifact built_at", async () => {
  const activity = committedActivity();
  const builtAt = Date.parse(activity.built_at);
  assert.ok(Number.isFinite(builtAt));

  // Clock after built_at; seed a meeting strictly between them so built_at would
  // still call it upcoming while the resident clock marks it past. Add two
  // later meetings to prove ascending order and the three-record preview cap.
  const betweenId = "meeting:chelsea-overview-between-control";
  const futureA = "meeting:chelsea-overview-future-a";
  const futureB = "meeting:chelsea-overview-future-b";
  const futureC = "meeting:chelsea-overview-future-c";
  const futureD = "meeting:chelsea-overview-future-d";
  const clockMs = builtAt + (12 * MILLISECONDS_PER_DAY);
  const clock = new Date(clockMs).toISOString();
  const betweenDate = new Date(builtAt + (5 * MILLISECONDS_PER_DAY)).toISOString();
  const futureDates = [1, 2, 3, 4].map((n) => new Date(clockMs + n * MILLISECONDS_PER_DAY).toISOString());
  activity.geography_items.by_key[CHELSEA] = {
    ...activity.geography_items.by_key[CHELSEA],
    meetings: [betweenId, futureA, futureB, futureC, futureD],
  };
  const meeting = (id, title, date) => ({
    id,
    title,
    date,
    agency: "Manhattan Community Board 4",
    type: "Meeting",
    route: `/meetings/${id.replace(/^meeting:/, "")}/`,
  });
  activity.records.meetings[betweenId] = meeting(betweenId, "Between built_at and clock", betweenDate);
  activity.records.meetings[futureA] = meeting(futureA, "Future Chelsea A", futureDates[0]);
  activity.records.meetings[futureB] = meeting(futureB, "Future Chelsea B", futureDates[1]);
  activity.records.meetings[futureC] = meeting(futureC, "Future Chelsea C", futureDates[2]);
  activity.records.meetings[futureD] = meeting(futureD, "Future Chelsea D", futureDates[3]);

  assert.ok(Date.parse(betweenDate) > builtAt, "control date must be after built_at");
  assert.ok(Date.parse(betweenDate) < clockMs, "control date must be before resident clock");

  await withPinnedClock(clock, () => {
    const view = chelseaOverviewView("geo=nta2020:MN0401&surface=records", {
      activity,
      now: clock,
      broaderDistricts: chelseaBroaderDistricts(activity),
    });
    const upcoming = view.overview.sections.find((section) => section.key === "upcoming");
    assert.equal(upcoming.records.some((row) => row.id === betweenId), false,
      "resident clock must drop the between-built_at meeting");
    assert.equal(upcoming.count, 4);
    assert.equal(upcoming.records.length, 3, "overview upcoming preview stays capped at 3");
    assert.deepEqual(
      upcoming.records.map((row) => row.id),
      [futureA, futureB, futureC],
      "upcoming preview keeps ascending date order and drops the 4th future",
    );
  });

  // Positive control: the same fixture under artifact built_at keeps the between
  // meeting as upcoming — proving the old clock would have failed this case.
  await withPinnedClock(activity.built_at, () => {
    const builtAtView = chelseaOverviewView("geo=nta2020:MN0401&surface=records", {
      activity,
      now: activity.built_at,
      broaderDistricts: chelseaBroaderDistricts(activity),
    });
    const builtAtUpcoming = builtAtView.overview.sections.find((section) => section.key === "upcoming");
    assert.equal(
      builtAtUpcoming.records.some((row) => row.id === betweenId),
      true,
      "built_at clock must still treat the between meeting as upcoming",
    );
    assert.equal(
      builtAtUpcoming.records.some((row) => row.id === futureA),
      true,
    );
  });

  // Broader M04 previews also prioritize current-clock upcoming first.
  const broaderView = chelseaOverviewView("geo=nta2020:MN0401&surface=records", {
    now: "2026-09-01T12:00:00.000Z",
  });
  const m04 = broaderView.broader_districts?.districts?.find((row) => row.id === "M04");
  assert.ok(m04?.records?.length);
  const dates = m04.records.map((row) => Date.parse(row.date || ""));
  assert.ok(dates.every(Number.isFinite));
});

test("overview A3: deferred parts carry overview HTML and scoped category links", () => {
  const view = chelseaOverviewView("geo=nta2020:MN0401&surface=records", {
    now: "2026-09-01T12:00:00.000Z",
  });
  const parts = renderNearYouDeferredParts(view);
  assert.match(parts.overviewHtml, /data-near-overview="true"/);
  assert.match(parts.overviewHtml, /lens=land/);
  assert.match(parts.resultsHtml, /data-broader-district="M04"|Wider district activity/);
  assert.doesNotMatch(parts.resultsHtml, /We can’t filter these meetings/);
  // Explicit section drill-downs may add a lens; the no-lens continuation must not.
  assert.doesNotMatch(view.overlapModel.continuation.href, /lens=/);
});
