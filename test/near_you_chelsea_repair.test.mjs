/**
 * Neighborhood category coverage from each lens's own evidence (cd64c975cc55e).
 *
 * Chelsea-Hudson Yards (MN0401) previously looked "unsupported" for meetings
 * because Land-only NTA bags omitted every empty non-Land key, while a sibling
 * NTA that had any non-Land hit received fabricated empty arrays. Coverage must
 * stay independent per lens: measured membership, measured empty, and absent
 * coverage remain distinct, and an unrelated lens must not change another.
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
} from "../site/near_you_view.mjs";
import {
  buildNearYou,
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

function nearYouScope(query) {
  return scopeFromNearYouUrl(`https://cityscroll.org/near-you/?${query}`);
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
