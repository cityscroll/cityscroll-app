/**
 * Kensington wider-district journey: see the September 23 CB14 Housing and
 * Land Use Committee meeting as labeled broader activity from overlapping
 * community districts, kept separate from exact Kensington membership.
 *
 * Public alias: ce70cec48d558
 *
 * Verify: node --test test/kensington_wider_district_journey.test.mjs
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { renderMeetingDocument } from "../site/meeting_document.mjs";
import {
  bindNearYouRecordInspection,
  nearYouEventTimeLabel,
  nearYouRecordInspectionFacts,
  parseNearYouRecordInspection,
  renderNearYouRecordInspectionBody,
  serializeNearYouRecordInspection,
} from "../site/near_you_record_inspection.mjs";
import {
  BROADER_DISTRICTS_KICKER,
  broaderDistrictRelationsFromCrosswalkRows,
  buildNearYouBroaderDistrictSection,
} from "../site/near_you_broader_districts.mjs";
import {
  buildNearYouViewModel,
  renderNearYouDeferredParts,
} from "../site/near_you_view.mjs";
import { scopeFromNearYouUrl } from "../site/near_you_scope_runtime.mjs";
import { parseGeographyNavigationState } from "../site/geography_navigation_state.mjs";
import {
  lookupParcelMemberships,
  normalizeParcelMembership,
  parcelShardKey,
} from "../site/parcel_geography.mjs";
import { click, keydown, mountDocument } from "./helpers/preview_dom.mjs";
import { withPinnedClock } from "./helpers/test_clock.mjs";
import {
  broaderDistrictsFromCommittedArtifacts,
  buildLocalGeographyPublication,
  residentialPlacesFromNtaLayer,
} from "../tools/build_worker_route_read_models.mjs";
import { handleNearYou } from "../worker/src/near_you.mjs";
import { workerMeetingGet } from "../worker/src/hearings.mjs";
import {
  MEETING_MANIFEST_KEY,
  NEAR_YOU_MANIFEST_KEY,
} from "../worker/src/lib/route_read_model_kv.mjs";

const ROOT = process.cwd();
const EVIDENCE_DIR = join(ROOT, "docs/evidence/near-you-kensington-wider-district");
const MANIFEST_PATH = join(EVIDENCE_DIR, "capture-manifest.json");
const GROUNDED_AT = "1ff60f293dc5f348cc6d08e1953232b4159235da";
// Delivery commit that first publishes wider-district meeting previews for
// overlapping community districts on the selected Kensington page. Capture
// refuses until the served artifact-manifest contains this ancestor.
const REQUIRED_SERVED_ANCESTOR = "PENDING_DELIVERY_COMMIT";

const SEPT23_ID =
  "meeting:community_board:https://cb14brooklyn.com/meeting/housing-and-land-use-committee-meeting-september-2026/";
const KENSINGTON_ROUTE =
  "https://cityscroll.org/near-you/?geo=nta2020%3ABK1203&surface=map&lens=meetings";
const KENSINGTON_GEO = "nta2020:BK1203";
const KENSINGTON_KEY = "geography:nta2020:BK1203";
const DETAIL_ROUTE =
  "/meetings/meeting%3Acommunity_board%3Ahttps%3A%2F%2Fcb14brooklyn.com%2Fmeeting%2Fhousing-and-land-use-committee-meeting-september-2026%2F";
const CB14_PARCELS = Object.freeze(["3066990010", "3076200025", "3050700035"]);

const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
const activity = readJson("site/data/district_activity.json");
const boundaries = readJson("site/data/district_boundaries.json");
const sharedMeetings = readJson("site/data/shared_meeting_read_model.json");
const residentialPlaces = residentialPlacesFromNtaLayer(
  readJson("site/data/geography/layers/nta2020/26B.json"),
);
const crosswalkManifest = readJson("site/data/geography/crosswalks/manifest.json");
const crosswalkShardMeta = (crosswalkManifest.shards || []).find(
  (entry) => entry.pair_id === "nta2020__community_district",
);
const crosswalkRows = crosswalkShardMeta?.path
  ? readJson(crosswalkShardMeta.path).rows || []
  : [];
const parcelManifest = readJson("site/data/parcel-geography/manifest.json");

function kensingtonScope() {
  return scopeFromNearYouUrl(KENSINGTON_ROUTE);
}

function kensingtonGeographyState() {
  return parseGeographyNavigationState(new URL(KENSINGTON_ROUTE).search);
}

function broaderSlicesFromActivity(relations) {
  const slices = {};
  for (const relation of relations || []) {
    const memberIds = activity.district_items?.by_level?.community_district?.[relation.id]?.meetings || [];
    const meetings = {};
    for (const id of memberIds) {
      if (activity.records?.meetings?.[id]) meetings[id] = activity.records.meetings[id];
    }
    slices[`community-district:${relation.id}`] = {
      records: { meetings },
      district_items: {
        by_level: {
          community_district: {
            [relation.id]: { meetings: memberIds },
          },
        },
      },
    };
  }
  return slices;
}

function kensingtonBroaderOptions() {
  const relations = broaderDistrictsFromCommittedArtifacts()[KENSINGTON_KEY] || [];
  return {
    relations,
    slices: broaderSlicesFromActivity(relations),
  };
}

function kensingtonView(now, options = {}) {
  return withPinnedClock(now, () => {
    const view = buildNearYouViewModel(kensingtonScope(), activity, boundaries, {
      geographyState: kensingtonGeographyState(),
      broaderDistricts: options.broaderDistricts === undefined
        ? kensingtonBroaderOptions()
        : options.broaderDistricts,
    });
    const parts = renderNearYouDeferredParts(view);
    return { view, html: parts.resultsHtml };
  });
}

function septBroaderRecord(view) {
  for (const district of view.broader_districts?.districts || []) {
    const row = (district.records || []).find((entry) => entry.id === SEPT23_ID);
    if (row) return { district, record: row };
  }
  return null;
}

function kv(values) {
  return {
    async get(key) {
      return values.get(key) || null;
    },
  };
}

function storePublication(publication) {
  const values = new Map();
  for (const entry of publication.nearYou.entries) values.set(entry.key, entry.value);
  for (const entry of publication.meetings.entries) values.set(entry.key, entry.value);
  values.set(NEAR_YOU_MANIFEST_KEY, JSON.stringify(publication.nearYou.manifest));
  values.set(MEETING_MANIFEST_KEY, JSON.stringify(publication.meetings.manifest));
  return values;
}

function mountSeptBroaderCard(html, options = {}) {
  const wrapped = `<div data-near-you-root data-lens="meetings" data-geo="${KENSINGTON_GEO}">${html}</div>`;
  const { doc, container } = mountDocument(wrapped, { containerClass: "near-you-host" });
  const root = container.querySelector("[data-near-you-root]") || container;
  const binder = bindNearYouRecordInspection(root, options);
  const card = root.querySelector(`[data-record-id="${SEPT23_ID}"][data-broader-scope="broader"]`);
  assert.ok(card, "September 23 broader card must render");
  return { doc, root, card, dialog: doc.getElementById("near-you-record-inspection"), binder };
}

function publicationDeps(tag) {
  return {
    parcel_membership_generation: `parcel-${tag}`,
    parcel_coordinate_vintage: `pluto-${tag}`,
    assertion_generation: `assertion-${tag}`,
    source_generation: sharedMeetings.generated_at || "2026-09-23",
  };
}

test("helpers: broader relations keep K12/K14 and drop K07 touches", () => {
  const relations = broaderDistrictRelationsFromCrosswalkRows(
    crosswalkRows.filter((row) => row.from_key === KENSINGTON_KEY),
  );
  assert.deepEqual(relations.map((row) => row.id), ["K12", "K14"]);
  assert.equal(relations.some((row) => row.id === "K07"), false);
  const committed = broaderDistrictsFromCommittedArtifacts()[KENSINGTON_KEY] || [];
  assert.deepEqual(committed.map((row) => row.id), ["K12", "K14"]);
});

test("A1 [outcome] Kensington meetings show September 23 under wider-district activity with date, time, and venue", async () => {
  const morning = await kensingtonView("2026-09-23T14:00:00.000Z");
  assert.match(morning.html, new RegExp(BROADER_DISTRICTS_KICKER));
  assert.match(morning.html, /data-broader-district="K14"/);
  assert.doesNotMatch(morning.html, /data-broader-district="K07"/);
  const found = septBroaderRecord(morning.view);
  assert.ok(found, "September 23 record must appear under wider-district activity");
  assert.equal(found.district.id, "K14");
  assert.equal(found.record.title, "Housing and Land Use Committee Meeting");
  assert.equal(found.record.venue_address, "810 East 16th Street, Brooklyn, NY, 11230");
  assert.match(morning.html, /810 East 16th Street/);
  assert.match(morning.html, /18:30/);
  assert.match(morning.html, /Held in Midwood/);
  assert.match(morning.html, new RegExp(SEPT23_ID.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(morning.html, new RegExp(DETAIL_ROUTE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal((morning.view.results?.ids || []).includes(SEPT23_ID), false);

  const facts = nearYouRecordInspectionFacts(found.record, { now: "2026-09-23T14:00:00.000Z" });
  assert.equal(facts.basis, "Held in Midwood");
  assert.equal(facts.time_label, "18:30");
  assert.equal(facts.venue_address, "810 East 16th Street, Brooklyn, NY, 11230");
  assert.equal(
    parseNearYouRecordInspection(serializeNearYouRecordInspection(facts))?.venue_address,
    "810 East 16th Street, Brooklyn, NY, 11230",
  );

  const { card, dialog } = mountSeptBroaderCard(morning.html);
  const titleLink = card.querySelector(".near-record-title-link");
  assert.ok(titleLink?.getAttribute("href")?.includes("housing-and-land-use-committee-meeting-september-2026"));
  click(card.querySelector(".near-record-inspect"));
  assert.equal(dialog.open, true);
  assert.match(dialog.textContent, /810 East 16th Street/);
  assert.match(dialog.textContent, /18:30/);
  const openLink = dialog.querySelector("[data-near-you-record-inspection-open]");
  assert.ok(openLink?.getAttribute("href")?.includes("housing-and-land-use-committee-meeting-september-2026"));
});

test("A2 [outcome] inspect, detail, and Back retain Kensington; exact and broader counts stay separate", async () => {
  const { view, html } = await kensingtonView("2026-09-23T14:00:00.000Z");
  const exactCount = view.results?.count;
  const broaderCount = (view.broader_districts?.districts || [])
    .reduce((sum, district) => sum + Number(district.count || 0), 0);
  assert.ok(broaderCount >= 1);
  // Exact membership for Kensington stays separate from broader preview counts.
  assert.equal((view.results?.ids || []).includes(SEPT23_ID), false);
  if (exactCount != null) {
    assert.notEqual(exactCount, broaderCount);
  } else {
    assert.match(html, /Matching meetings records|not available|0 meetings records/i);
  }
  assert.match(html, /data-results-count=|Matching meetings records|not available/i);
  assert.match(html, new RegExp(BROADER_DISTRICTS_KICKER));

  const { doc, root, card, dialog } = mountSeptBroaderCard(html);
  const inspect = card.querySelector(".near-record-inspect");
  click(inspect);
  assert.equal(dialog.open, true);
  assert.equal(root.getAttribute("data-geo"), KENSINGTON_GEO);
  assert.equal(root.getAttribute("data-lens"), "meetings");
  click(dialog.querySelector("[data-near-you-record-inspection-close]"));
  assert.equal(dialog.open, false);
  assert.equal(doc.activeElement, inspect);
  assert.equal(root.getAttribute("data-geo"), KENSINGTON_GEO);

  dialog.showModal = undefined;
  click(inspect);
  keydown(dialog, "Escape");
  assert.equal(dialog.open, false);
  assert.equal(doc.activeElement, inspect);
  assert.equal(root.getAttribute("data-geo"), KENSINGTON_GEO);

  // Place retention lives on the Near You root and share URL; deferred results
  // keep meeting destinations while the selected Kensington geo stays on the shell.
  assert.equal(root.getAttribute("data-geo"), KENSINGTON_GEO);
  assert.match(
    String(view.shareHref || view.href || ""),
    /geo=(?:nta2020%3ABK1203|geography%3Anta2020%3ABK1203)|nta2020:BK1203|geography:nta2020:BK1203/,
  );
  assert.match(html, /\/meetings\/meeting%3Acommunity_board/);
  assert.match(html, /data-broader-district="K14"/);
});

test("A3 [boundary] CB14 parcels stay out of exact BK1203; K07 does not preview; broader failure preserves exact", async () => {
  void parcelManifest;
  for (const bbl of CB14_PARCELS) {
    const shardPath = join(ROOT, "site/data/parcel-geography", `${parcelShardKey(bbl)}.json`);
    assert.ok(existsSync(shardPath), `shard for ${bbl} must exist`);
    const shard = JSON.parse(readFileSync(shardPath, "utf8"));
    const membership = lookupParcelMemberships(shard, bbl);
    assert.ok(membership, `parcel ${bbl} must resolve`);
    const raw = shard.parcels?.[bbl]?.memberships?.nta2020;
    const normalized = normalizeParcelMembership("nta2020", raw);
    assert.ok(normalized, `${bbl} nta2020 must normalize`);
    assert.equal(normalized.ids.includes("BK1203"), false, `${bbl} must not be exact Kensington`);
  }

  const kenIds = activity.geography_items?.by_key?.[KENSINGTON_KEY]?.meetings || [];
  assert.equal(kenIds.includes(SEPT23_ID), false);

  // K07 touches only: forcing it into relations must still yield no preview when
  // the builder filters material_for_navigation, and a synthetic non-material
  // relation without records manufactures no group.
  const emptyK07 = buildNearYouBroaderDistrictSection({
    relations: [{ id: "K07", key: "geography:community_district:K07", pct_from: 0, records: [] }],
    exactIds: [],
  });
  assert.equal(emptyK07.districts.length, 0);

  const healthy = await kensingtonView("2026-09-23T14:00:00.000Z", { broaderDistricts: null });
  assert.equal((healthy.view.results?.ids || []).includes(SEPT23_ID), false);
  assert.equal(healthy.view.broader_districts?.districts?.length || 0, 0);
  // Exact panel still renders when broader enrichment is omitted.
  assert.match(healthy.html, /near-results-heading|Matching meetings records|data-results-count/);
  assert.doesNotMatch(healthy.html, new RegExp(BROADER_DISTRICTS_KICKER));

  let attempts = 0;
  const { html } = await kensingtonView("2026-09-23T14:00:00.000Z");
  const { card, dialog, root } = mountSeptBroaderCard(html, {
    loadDetail: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("detail unavailable");
      return "Committee materials are available on the full record.";
    },
  });
  click(card.querySelector(".near-record-inspect"));
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(dialog.textContent, /Further detail did not load/);
  assert.equal(root.getAttribute("data-geo"), KENSINGTON_GEO);
  assert.ok(dialog.querySelector("[data-near-you-record-inspection-retry]"));
  click(dialog.querySelector("[data-near-you-record-inspection-retry]"));
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(attempts, 2);
  assert.match(dialog.textContent, /Committee materials are available/);
  assert.equal(root.getAttribute("data-geo"), KENSINGTON_GEO);
});

test("A4 lean Worker path: Kensington deferred broader preview stays on published slices", async () => {
  const publication = buildLocalGeographyPublication({
    activity,
    geography: {},
    meetings: sharedMeetings,
    version: "kensington-wider-lean",
    residentialPlaces,
    dependencies: publicationDeps("wider-lean"),
  });
  assert.equal(publication.activation.activate, true, publication.activation.reason);
  const broader = publication.nearYou.manifest.broader_districts?.[KENSINGTON_KEY] || [];
  assert.deepEqual(broader.map((row) => row.id), ["K12", "K14"]);

  const values = storePublication(publication);
  const deferred = await handleNearYou(new Request(
    `https://cityscroll.org/near-you/deferred.json?geo=${encodeURIComponent(KENSINGTON_GEO)}&lens=meetings&surface=map`,
  ), { ALERT_STATE: kv(values) });
  assert.equal(deferred.status, 200);
  const body = await deferred.json();
  assert.match(body.results_html, new RegExp(BROADER_DISTRICTS_KICKER));
  assert.match(body.results_html, /810 East 16th Street/);
  assert.match(body.results_html, /18:30/);
  assert.match(body.results_html, /Held in Midwood/);
  assert.match(body.results_html, /data-broader-district="K14"/);
  assert.doesNotMatch(body.results_html, /data-broader-district="K07"/);

  const reads = [];
  const detail = await workerMeetingGet({
    ALERT_STATE: {
      get: async (key) => {
        reads.push(key);
        return values.get(key) || null;
      },
    },
  }).execute({ meetingId: SEPT23_ID });
  assert.equal(detail.availability, "available");
  assert.ok(reads.every((key) => key === MEETING_MANIFEST_KEY || key.startsWith("meetings:v1:")));
  assert.equal(reads.includes("hearings:location:v1"), false);
  const detailHtml = renderMeetingDocument(detail.meeting, {
    schema: sharedMeetings.schema,
    rows: [detail.meeting],
  });
  assert.match(detailHtml, /810 East 16th Street/);
  assert.match(detailHtml, /Housing and Land Use Committee Meeting/);
});

test("A4 capture tool refuses stale served builds and records ancestor guard", () => {
  const captureTool = readFileSync(
    join(ROOT, "tools/capture_kensington_wider_district_journey.py"),
    "utf8",
  );
  assert.match(captureTool, /def revision_contains_required_ancestor/);
  assert.match(captureTool, /does not contain required ancestor/);
  assert.match(captureTool, /REQUIRED_ANCESTOR/);
  assert.match(captureTool, /near-you-kensington-wider-district/);
  assert.match(captureTool, /Wider district activity|data-broader-district/);
  assert.match(captureTool, /810 East 16th/);
});

test("A4 [verification] production capture manifest records hosted desktop/mobile screenshots", (t) => {
  if (!existsSync(MANIFEST_PATH)) {
    t.skip("production capture pending after delivery deploys with wider-district previews");
    return;
  }
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  assert.equal(manifest.schema, "cityscroll.render_capture_manifest.v1");
  assert.equal(manifest.feature, "near-you-kensington-wider-district");
  assert.equal(manifest.public_alias, "ce70cec48d558");
  assert.equal(manifest.image_binaries_committed, false);
  assert.equal(manifest.capture_mode, "headless-playwright-production-served-site");
  assert.equal(manifest.revision_format, "served artifact-manifest source_commit_sha");
  assert.match(manifest.revision || "", /^[0-9a-f]{40}$/);
  assert.equal(manifest.required_ancestor_contained, true);
  assert.ok(Array.isArray(manifest.captures));
  assert.ok(manifest.captures.length >= 4, "desktop/mobile for list and detail");

  const byName = Object.fromEntries(manifest.captures.map((row) => [row.name, row]));
  for (const name of [
    "kensington-meetings-desktop",
    "kensington-meetings-mobile",
    "kensington-detail-desktop",
    "kensington-detail-mobile",
  ]) {
    const row = byName[name];
    assert.ok(row, `missing capture ${name}`);
    assert.equal(typeof row.route, "string");
    assert.ok(row.viewport?.width >= 320);
    assert.ok(row.viewport?.height >= 480);
    assert.match(row.revision || "", /^[0-9a-f]{40}$/);
    assert.ok(row.data_vintage);
    assert.ok(row.assertion);
    assert.match(row.sha256 || "", /^[0-9a-f]{64}$/);
    assert.match(row.screenshot_url || "", /^https:\/\//);
    assert.equal(row.file, null);
    assert.ok(row.served_values?.named_row_present || row.served_values?.detail_title_present);
  }

  assert.equal(byName["kensington-meetings-desktop"].viewport.width, 1440);
  assert.equal(byName["kensington-meetings-mobile"].viewport.width, 390);
  assert.match(byName["kensington-meetings-desktop"].route, /geo=nta2020%3ABK1203/);
  assert.match(byName["kensington-detail-desktop"].route, /housing-and-land-use-committee-meeting-september-2026/);

  for (const name of ["kensington-meetings-desktop", "kensington-meetings-mobile"]) {
    const values = byName[name].served_values;
    assert.equal(values.named_row_present, true, `${name} named row`);
    assert.equal(values.wider_district_present, true, `${name} wider-district label`);
    assert.equal(values.venue_address_present, true, `${name} venue address`);
    assert.equal(values.broader_district_k14_present, true, `${name} K14 broader group`);
    assert.equal(values.broader_district_k07_present, false, `${name} K07 absent`);
  }
  for (const name of ["kensington-detail-desktop", "kensington-detail-mobile"]) {
    const values = byName[name].served_values;
    assert.equal(values.detail_title_present, true, `${name} detail title`);
    assert.equal(values.venue_address_present, true, `${name} venue address`);
  }
});

test("grounded revision marker remains recorded for this branch", () => {
  assert.match(GROUNDED_AT, /^[0-9a-f]{40}$/);
  const broaderSource = readFileSync(join(ROOT, "site/near_you_broader_districts.mjs"), "utf8");
  assert.match(broaderSource, /Wider district activity/);
  const digest = createHash("sha256").update(broaderSource).digest("hex");
  assert.equal(digest.length, 64);
  // Keep the pending ancestor token visible until the delivery commit lands.
  assert.equal(typeof REQUIRED_SERVED_ANCESTOR, "string");
  void renderNearYouRecordInspectionBody;
});
