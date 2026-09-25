/**
 * Midwood venue journey: see and open the September 23 CB14 Housing and Land
 * Use Committee meeting from the Midwood neighborhood result.
 *
 * Public alias: ca937c81ff665
 *
 * Verify: node --test test/near_you_midwood_venue_journey.test.mjs
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
  nearYouHeldInLabel,
  nearYouRecordInspectionFacts,
  parseNearYouRecordInspection,
  renderNearYouRecordInspectionBody,
  serializeNearYouRecordInspection,
} from "../site/near_you_record_inspection.mjs";
import {
  buildNearYouViewModel,
  renderNearYouDeferredParts,
} from "../site/near_you_view.mjs";
import { scopeFromNearYouUrl } from "../site/near_you_scope_runtime.mjs";
import { parseGeographyNavigationState } from "../site/geography_navigation_state.mjs";
import { click, keydown, mountDocument } from "./helpers/preview_dom.mjs";
import { withPinnedClock } from "./helpers/test_clock.mjs";
import {
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
const EVIDENCE_DIR = join(ROOT, "docs/evidence/near-you-midwood-venue-journey");
const MANIFEST_PATH = join(EVIDENCE_DIR, "capture-manifest.json");
const GROUNDED_AT = "1c5350346862ebe66a5bab71002d7af9b72e2b14";

const SEPT23_ID =
  "meeting:community_board:https://cb14brooklyn.com/meeting/housing-and-land-use-committee-meeting-september-2026/";
const MIDWOOD_ROUTE =
  "https://cityscroll.org/near-you/?geo=nta2020%3ABK1403&surface=map&lens=meetings";
const MIDWOOD_GEO = "nta2020:BK1403";
const KENSINGTON_GEO = "nta2020:BK1203";
const DETAIL_ROUTE =
  "/meetings/meeting%3Acommunity_board%3Ahttps%3A%2F%2Fcb14brooklyn.com%2Fmeeting%2Fhousing-and-land-use-committee-meeting-september-2026%2F";

const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
const activity = readJson("site/data/district_activity.json");
const boundaries = readJson("site/data/district_boundaries.json");
const sharedMeetings = readJson("site/data/shared_meeting_read_model.json");
const residentialPlaces = residentialPlacesFromNtaLayer(
  readJson("site/data/geography/layers/nta2020/26B.json"),
);

function midwoodScope() {
  return scopeFromNearYouUrl(MIDWOOD_ROUTE);
}

function midwoodGeographyState() {
  return parseGeographyNavigationState(new URL(MIDWOOD_ROUTE).search);
}

function midwoodView(now) {
  return withPinnedClock(now, () => {
    const view = buildNearYouViewModel(midwoodScope(), activity, boundaries, {
      geographyState: midwoodGeographyState(),
    });
    const parts = renderNearYouDeferredParts(view);
    return { view, html: parts.resultsHtml };
  });
}

function septRecord(view) {
  return (view.results?.records || []).find((row) => row.id === SEPT23_ID) || null;
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

function mountSeptCard(html, options = {}) {
  const wrapped = `<div data-near-you-root data-lens="meetings" data-geo="${MIDWOOD_GEO}">${html}</div>`;
  const { doc, container } = mountDocument(wrapped, { containerClass: "near-you-host" });
  const root = container.querySelector("[data-near-you-root]") || container;
  const binder = bindNearYouRecordInspection(root, options);
  const card = root.querySelector(`[data-record-id="${SEPT23_ID}"]`);
  assert.ok(card, "September 23 card must render");
  return { doc, root, card, dialog: doc.getElementById("near-you-record-inspection"), binder };
}

test("helpers: Held in Midwood and 18:30 clock labels", () => {
  assert.equal(nearYouHeldInLabel("Midwood"), "Held in Midwood");
  assert.equal(nearYouEventTimeLabel("2026-09-23T18:30:00-04:00"), "18:30");
  assert.equal(nearYouEventTimeLabel("2026-09-23"), null);
});

test("A1 [outcome] Midwood meetings list shows September 23 with time, venue, Held in Midwood; inspect and open work; past stays reachable", async () => {
  const morning = await midwoodView("2026-09-23T14:00:00.000Z");
  assert.ok(morning.view.results?.count >= 1);
  const record = septRecord(morning.view);
  assert.ok(record, "September 23 record must be in Midwood meetings");
  assert.equal(record.title, "Housing and Land Use Committee Meeting");
  assert.equal(record.venue_address, "810 East 16th Street, Brooklyn, NY, 11230");
  assert.equal(record.geography_evidence?.location_role, "venue");
  assert.equal(record.geography_evidence?.label, "Midwood");
  assert.match(morning.html, /Held in Midwood/);
  assert.match(morning.html, /810 East 16th Street/);
  assert.match(morning.html, /18:30/);
  assert.match(morning.html, new RegExp(SEPT23_ID.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(morning.html, new RegExp(DETAIL_ROUTE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(morning.html, /data-record-timing="upcoming"/);

  const facts = nearYouRecordInspectionFacts(record, { now: "2026-09-23T14:00:00.000Z" });
  assert.equal(facts.basis, "Held in Midwood");
  assert.equal(facts.time_label, "18:30");
  assert.equal(facts.venue_address, "810 East 16th Street, Brooklyn, NY, 11230");
  assert.equal(facts.geography?.resident_label, "Held in Midwood");
  assert.equal(facts.geography?.method, "parcel membership");
  assert.equal(facts.geography?.boundary_vintage, "26B");
  assert.equal(
    parseNearYouRecordInspection(serializeNearYouRecordInspection(facts))?.geography?.resident_label,
    "Held in Midwood",
  );

  const { card, dialog } = mountSeptCard(morning.html);
  const inspect = card.querySelector(".near-record-inspect");
  assert.ok(inspect);
  click(inspect);
  assert.equal(dialog.open, true);
  assert.match(dialog.textContent, /Held in Midwood/);
  assert.match(dialog.textContent, /810 East 16th Street/);
  assert.match(dialog.textContent, /18:30/);
  assert.match(dialog.textContent, /Point method parcel membership/);
  assert.match(dialog.textContent, /Publisher boundary 26B/);
  const openLink = dialog.querySelector("[data-near-you-record-inspection-open]");
  assert.ok(openLink?.getAttribute("href")?.includes("housing-and-land-use-committee-meeting-september-2026"));

  const after = await midwoodView("2026-09-24T14:00:00.000Z");
  assert.match(after.html, new RegExp(SEPT23_ID.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(after.html, /Held in Midwood/);
  assert.match(after.html, /data-record-timing="past"/);
  assert.match(after.html, /Past event/);
});

test("A2 [outcome] inspect, dismiss, full-detail link, and Back restore Midwood place, lens, and focus", async () => {
  const { html } = await midwoodView("2026-09-23T14:00:00.000Z");
  const { doc, root, card, dialog } = mountSeptCard(html);
  const inspect = card.querySelector(".near-record-inspect");
  const titleLink = card.querySelector(".near-record-title-link");
  const fullRecord = card.querySelector(".near-record-full-record");
  assert.ok(titleLink?.getAttribute("href")?.includes(DETAIL_ROUTE.slice(1)) || titleLink?.getAttribute("href")?.includes("housing-and-land-use"));
  assert.ok(fullRecord?.getAttribute("href"));
  assert.match(fullRecord.getAttribute("href"), /housing-and-land-use-committee-meeting-september-2026/);

  // Local result and meeting-detail destinations stay in delivery markup.
  assert.match(html, /\/near-you\/\?geo=nta2020%3ABK1403|data-geo="nta2020:BK1403"|geography:nta2020:BK1403/);
  assert.match(html, /\/meetings\/meeting%3Acommunity_board/);

  click(inspect);
  assert.equal(dialog.open, true);
  assert.equal(root.getAttribute("data-geo"), MIDWOOD_GEO);
  assert.equal(root.getAttribute("data-lens"), "meetings");
  const close = dialog.querySelector("[data-near-you-record-inspection-close]");
  click(close);
  assert.equal(dialog.open, false);
  assert.equal(doc.activeElement, inspect);
  assert.equal(root.getAttribute("data-geo"), MIDWOOD_GEO);
  assert.equal(root.getAttribute("data-lens"), "meetings");

  // No-JS destination remains the static title link.
  assert.ok(titleLink?.className?.includes("near-record-title-link"));
  assert.ok(titleLink?.className?.includes("near-record-title"));

  // Keyboard: reopen and Escape-close restores focus.
  dialog.showModal = undefined;
  click(inspect);
  assert.equal(dialog.getAttribute("aria-modal"), "true");
  keydown(dialog, "Escape");
  assert.equal(dialog.open, false);
  assert.equal(doc.activeElement, inspect);
});

test("A3 [boundary] failed detail offers retry and source link while preserving Midwood; Kensington has no exact membership", async () => {
  let attempts = 0;
  const { html } = await midwoodView("2026-09-23T14:00:00.000Z");
  const { card, dialog } = mountSeptCard(html, {
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
  assert.match(dialog.textContent, /Held in Midwood/);
  assert.ok(dialog.querySelector("[data-near-you-record-source], a[href*='cb14brooklyn.com']"));
  assert.ok(dialog.querySelector("[data-near-you-record-inspection-open]"));
  const retry = dialog.querySelector("[data-near-you-record-inspection-retry]");
  assert.ok(retry, "failed detail must offer retry");
  click(retry);
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(attempts, 2);
  assert.match(dialog.textContent, /Committee materials are available/);
  assert.doesNotMatch(dialog.textContent, /Further detail did not load/);

  // Exact Kensington membership must not include the Midwood venue.
  const kenIds = activity.geography_items?.by_key?.[`geography:${KENSINGTON_GEO}`]?.meetings || [];
  assert.equal(kenIds.includes(SEPT23_ID), false);
  const kenScope = scopeFromNearYouUrl(
    `https://cityscroll.org/near-you/?geo=${encodeURIComponent(KENSINGTON_GEO)}&surface=map&lens=meetings`,
  );
  const kenView = buildNearYouViewModel(
    kenScope,
    activity,
    boundaries,
    { geographyState: parseGeographyNavigationState(`?geo=${KENSINGTON_GEO}&surface=map&lens=meetings`) },
  );
  const kenRecord = (kenView.results?.records || []).find((row) => row.id === SEPT23_ID);
  assert.equal(kenRecord, undefined);
});

test("A4 [verification] production capture manifest records hosted desktop/mobile screenshots for the named row and detail", () => {
  assert.ok(existsSync(MANIFEST_PATH), "capture manifest must exist");
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  assert.equal(manifest.schema, "cityscroll.render_capture_manifest.v1");
  assert.equal(manifest.feature, "near-you-midwood-venue-journey");
  assert.equal(manifest.public_alias, "ca937c81ff665");
  assert.equal(manifest.image_binaries_committed, false);
  assert.equal(manifest.capture_mode, "headless-playwright-production-served-site");
  assert.equal(manifest.revision_format, "served artifact-manifest source_commit_sha");
  assert.match(manifest.revision || "", /^[0-9a-f]{40}$/);
  assert.ok(Array.isArray(manifest.captures));
  assert.ok(manifest.captures.length >= 4, "desktop/mobile for list and detail");

  const byName = Object.fromEntries(manifest.captures.map((row) => [row.name, row]));
  for (const name of [
    "midwood-meetings-desktop",
    "midwood-meetings-mobile",
    "midwood-detail-desktop",
    "midwood-detail-mobile",
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

  assert.equal(byName["midwood-meetings-desktop"].viewport.width, 1440);
  assert.equal(byName["midwood-meetings-desktop"].viewport.height, 900);
  assert.equal(byName["midwood-meetings-mobile"].viewport.width, 390);
  assert.equal(byName["midwood-meetings-mobile"].viewport.height, 844);
  assert.match(byName["midwood-meetings-desktop"].route, /geo=nta2020%3ABK1403/);
  assert.match(byName["midwood-detail-desktop"].route, /housing-and-land-use-committee-meeting-september-2026/);
  assert.equal(byName["midwood-meetings-desktop"].served_values.keyboard_focusable_count > 0, true);
  assert.equal(byName["midwood-meetings-desktop"].served_values.no_javascript_title_link, true);
  assert.equal(byName["midwood-detail-desktop"].served_values.venue_address_present, true);

  // Lean-read guard: publication still activates with precomputed Midwood venue evidence.
  const publication = buildLocalGeographyPublication({
    activity,
    geography: {},
    meetings: sharedMeetings,
    version: "midwood-venue-journey",
    residentialPlaces,
    dependencies: {
      parcel_membership_generation: "parcel-midwood-journey",
      parcel_coordinate_vintage: "pluto_midwood",
      assertion_generation: "assertion-midwood",
      source_generation: sharedMeetings.generated_at || "2026-09-23",
    },
  });
  assert.equal(publication.activation.activate, true, publication.activation.reason);
});

test("A4 lean Worker path: Midwood deferred and meeting detail stay on published slices", async () => {
  const publication = buildLocalGeographyPublication({
    activity,
    geography: {},
    meetings: sharedMeetings,
    version: "midwood-lean-read",
    residentialPlaces,
    dependencies: {
      parcel_membership_generation: "parcel-lean",
      parcel_coordinate_vintage: "pluto_lean",
      assertion_generation: "assertion-lean",
      source_generation: sharedMeetings.generated_at || "2026-09-23",
    },
  });
  const values = storePublication(publication);
  const deferred = await handleNearYou(new Request(
    `https://cityscroll.org/near-you/deferred.json?geo=${encodeURIComponent(MIDWOOD_GEO)}&lens=meetings&surface=map`,
  ), { ALERT_STATE: kv(values) });
  assert.equal(deferred.status, 200);
  const body = await deferred.json();
  assert.match(body.results_html, /Held in Midwood/);
  assert.match(body.results_html, /810 East 16th Street/);

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

test("grounded revision marker remains recorded for this branch", () => {
  assert.match(GROUNDED_AT, /^[0-9a-f]{40}$/);
  const inspectionSource = readFileSync(join(ROOT, "site/near_you_record_inspection.mjs"), "utf8");
  assert.match(inspectionSource, /Held in \$\{label\}/);
  const digest = createHash("sha256").update(inspectionSource).digest("hex");
  assert.equal(digest.length, 64);
});
