/**
 * Subject-property local journey: find the September 14 CB14 hearing through
 * its 461 Coney Island Avenue neighborhood and address search, while the
 * detail keeps 1625 Ocean Avenue as the venue.
 *
 * Public alias: ce239e01504c8
 *
 * Verify: node --test test/near_you_subject_property_journey.test.mjs
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { renderMeetingDocument, meetingAgendaSubjectPlaces } from "../site/meeting_document.mjs";
import { materializeMeetingSearchDocument } from "../site/meeting_search_producer.mjs";
import {
  bindNearYouRecordInspection,
  nearYouAboutLabel,
  nearYouAppearanceReason,
  nearYouEventTimeLabel,
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
import { aboutSubjectPropertyLabel } from "../tools/lib/district_activity.mjs";
import { handleNearYou } from "../worker/src/near_you.mjs";
import { workerMeetingGet } from "../worker/src/hearings.mjs";
import {
  MEETING_MANIFEST_KEY,
  NEAR_YOU_MANIFEST_KEY,
} from "../worker/src/lib/route_read_model_kv.mjs";

const ROOT = process.cwd();
const EVIDENCE_DIR = join(ROOT, "docs/evidence/near-you-subject-property-journey");
const MANIFEST_PATH = join(EVIDENCE_DIR, "capture-manifest.json");
const CAPTURE_TOOL = join(ROOT, "tools/capture_near_you_subject_property_journey.py");
const GROUNDED_AT = "20df28b565f7c3da6a0203a5483319237ee81fe6";
// Updated to the delivery commit once production serves this card's tip.
const REQUIRED_SERVED_ANCESTOR = "20df28b565f7c3da6a0203a5483319237ee81fe6";

const SEPT14_ID =
  "meeting:community_board:https://cb14brooklyn.com/meeting/september-2026-board-meeting/";
const SEPT23_ID =
  "meeting:community_board:https://cb14brooklyn.com/meeting/housing-and-land-use-committee-meeting-september-2026/";
const SUBJECT_GEO = "nta2020:BK1402";
const VENUE_GEO = "nta2020:BK1403";
const KENSINGTON_GEO = "nta2020:BK1203";
const SUBJECT_ROUTE =
  "https://cityscroll.org/near-you/?geo=nta2020%3ABK1402&surface=map&lens=meetings";
const DETAIL_ROUTE =
  "/meetings/meeting%3Acommunity_board%3Ahttps%3A%2F%2Fcb14brooklyn.com%2Fmeeting%2Fseptember-2026-board-meeting%2F";
const SUBJECT_ANCHOR = "#agenda-subject";
const SUBJECT_ADDRESS = "461 Coney Island Avenue";
const VENUE_ADDRESS_NEEDLE = "1625 Ocean Avenue";
const ABOUT_LABEL = "About 461 Coney Island Avenue";

const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
const activity = readJson("site/data/district_activity.json");
const boundaries = readJson("site/data/district_boundaries.json");
const sharedMeetings = readJson("site/data/shared_meeting_read_model.json");
const residentialPlaces = residentialPlacesFromNtaLayer(
  readJson("site/data/geography/layers/nta2020/26B.json"),
);
const sept14Shared = sharedMeetings.rows.find((row) => row.meeting_id === SEPT14_ID);

function subjectScope() {
  return scopeFromNearYouUrl(SUBJECT_ROUTE);
}

function subjectGeographyState() {
  return parseGeographyNavigationState(new URL(SUBJECT_ROUTE).search);
}

function subjectView(now) {
  return withPinnedClock(now, () => {
    const view = buildNearYouViewModel(subjectScope(), activity, boundaries, {
      geographyState: subjectGeographyState(),
    });
    const parts = renderNearYouDeferredParts(view);
    return { view, html: parts.resultsHtml };
  });
}

function viewForGeo(geo, now) {
  return withPinnedClock(now, () => {
    const url = `https://cityscroll.org/near-you/?geo=${encodeURIComponent(geo)}&surface=map&lens=meetings`;
    const view = buildNearYouViewModel(
      scopeFromNearYouUrl(url),
      activity,
      boundaries,
      { geographyState: parseGeographyNavigationState(new URL(url).search) },
    );
    return view;
  });
}

function sept14Record(view) {
  return (view.results?.records || []).find((row) => row.id === SEPT14_ID) || null;
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

function mountSept14Card(html, options = {}) {
  const wrapped = `<div data-near-you-root data-lens="meetings" data-geo="${SUBJECT_GEO}">${html}</div>`;
  const { doc, container } = mountDocument(wrapped, { containerClass: "near-you-host" });
  const root = container.querySelector("[data-near-you-root]") || container;
  const binder = bindNearYouRecordInspection(root, options);
  const card = root.querySelector(`[data-record-id="${SEPT14_ID}"]`);
  assert.ok(card, "September 14 card must render");
  return { doc, root, card, dialog: doc.getElementById("near-you-record-inspection"), binder };
}

test("helpers: About subject label and clock formatting", () => {
  assert.equal(nearYouAboutLabel(SUBJECT_ADDRESS), ABOUT_LABEL);
  assert.equal(aboutSubjectPropertyLabel(SUBJECT_ADDRESS), ABOUT_LABEL);
  assert.equal(nearYouEventTimeLabel("2026-09-14T18:30:00-04:00"), "18:30");
});

test("A1 [outcome] BK1402 meetings list shows September 14 about 461 Coney Island Avenue; detail keeps 1625 Ocean Avenue", async () => {
  const morning = await subjectView("2026-09-14T14:00:00.000Z");
  assert.ok(morning.view.results?.count >= 1);
  const record = sept14Record(morning.view);
  assert.ok(record, "September 14 record must be in BK1402 meetings");
  assert.match(record.title, /September 2026 Board Meeting/);
  assert.equal(record.subject_address, SUBJECT_ADDRESS);
  assert.match(record.venue_address || "", /1625 Ocean Avenue/);
  assert.equal(record.geography_evidence?.location_role, "matter");
  assert.equal(record.geography_evidence?.basis, ABOUT_LABEL);
  assert.equal(record.basis, ABOUT_LABEL);
  assert.equal(nearYouAppearanceReason(record), ABOUT_LABEL);
  assert.match(morning.html, /About 461 Coney Island Avenue/);
  assert.match(morning.html, /1625 Ocean Avenue/);
  assert.doesNotMatch(morning.html, /Venue \/ logistics/);
  assert.match(morning.html, new RegExp(SEPT14_ID.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(morning.html, new RegExp(DETAIL_ROUTE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const facts = nearYouRecordInspectionFacts(record, { now: "2026-09-14T14:00:00.000Z" });
  assert.equal(facts.basis, ABOUT_LABEL);
  assert.equal(facts.subject_address, SUBJECT_ADDRESS);
  assert.match(facts.venue_address || "", /1625 Ocean Avenue/);
  assert.equal(facts.geography?.resident_label, ABOUT_LABEL);
  assert.equal(facts.geography?.place_role, "matter");
  assert.match(facts.href, /#agenda-subject$/);
  assert.equal(
    parseNearYouRecordInspection(serializeNearYouRecordInspection(facts))?.basis,
    ABOUT_LABEL,
  );

  const { card, dialog } = mountSept14Card(morning.html);
  const inspect = card.querySelector(".near-record-inspect");
  assert.ok(inspect);
  click(inspect);
  assert.equal(dialog.open, true);
  assert.match(dialog.textContent, /About 461 Coney Island Avenue/);
  assert.match(dialog.textContent, /1625 Ocean Avenue/);
  const openLink = dialog.querySelector("[data-near-you-record-inspection-open]");
  assert.ok(openLink?.getAttribute("href")?.includes("september-2026-board-meeting"));
  assert.match(openLink.getAttribute("href") || "", /#agenda-subject/);

  const detailHtml = await withPinnedClock("2026-09-15T14:00:00.000Z", () =>
    renderMeetingDocument(sept14Shared, {
      schema: sharedMeetings.schema,
      rows: [sept14Shared],
    }));
  assert.match(detailHtml, /id="agenda-subject"/);
  assert.match(detailHtml, /About 461 Coney Island Avenue/);
  assert.match(detailHtml, /1625 Ocean Avenue/);
  assert.match(detailHtml, /Historical meeting|was held on|data-meeting-historical="1"/);
  assert.equal(meetingAgendaSubjectPlaces(sept14Shared).length >= 1, true);

  const after = await subjectView("2026-09-15T14:00:00.000Z");
  assert.match(after.html, new RegExp(SEPT14_ID.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(after.html, /About 461 Coney Island Avenue/);
  assert.match(after.html, /data-record-timing="past"/);
});

test("A2 [outcome] subject search text and inspect/Back preserve BK1402 place with explicit full-detail link", async () => {
  const searchDoc = materializeMeetingSearchDocument(sept14Shared);
  assert.ok(searchDoc);
  assert.match(searchDoc.search_text, /461 Coney Island Avenue/);
  assert.equal(searchDoc.provenance?.subject_search_text, ABOUT_LABEL);
  assert.deepEqual(searchDoc.provenance?.search_aliases, [SUBJECT_ADDRESS]);
  assert.match(searchDoc.canonical_href, /#agenda-subject$/);

  const { html } = await subjectView("2026-09-14T14:00:00.000Z");
  const { doc, root, card, dialog } = mountSept14Card(html);
  const inspect = card.querySelector(".near-record-inspect");
  const titleLink = card.querySelector(".near-record-title-link");
  const fullRecord = card.querySelector(".near-record-full-record");
  assert.ok(titleLink?.getAttribute("href")?.includes("september-2026-board-meeting"));
  assert.ok(fullRecord?.getAttribute("href"));
  assert.match(fullRecord.getAttribute("href"), /september-2026-board-meeting/);
  assert.match(fullRecord.getAttribute("href"), /#agenda-subject/);

  assert.match(html, /data-geo="nta2020:BK1402"|geography:nta2020:BK1402|nta2020%3ABK1402/);
  assert.match(html, /\/meetings\/meeting%3Acommunity_board/);

  click(inspect);
  assert.equal(dialog.open, true);
  assert.equal(root.getAttribute("data-geo"), SUBJECT_GEO);
  assert.equal(root.getAttribute("data-lens"), "meetings");
  const close = dialog.querySelector("[data-near-you-record-inspection-close]");
  click(close);
  assert.equal(dialog.open, false);
  assert.equal(doc.activeElement, inspect);
  assert.equal(root.getAttribute("data-geo"), SUBJECT_GEO);
  assert.equal(root.getAttribute("data-lens"), "meetings");

  assert.ok(titleLink?.className?.includes("near-record-title-link"));
  dialog.showModal = undefined;
  click(inspect);
  assert.equal(dialog.getAttribute("aria-modal"), "true");
  keydown(dialog, "Escape");
  assert.equal(dialog.open, false);
  assert.equal(doc.activeElement, inspect);
});

test("A3 [boundary] subject stays BK1402, venue Midwood stays BK1403; Kensington has neither; no cross-meeting contamination", async () => {
  let attempts = 0;
  const { html } = await subjectView("2026-09-14T14:00:00.000Z");
  const { card, dialog, root } = mountSept14Card(html, {
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
  assert.match(dialog.textContent, /About 461 Coney Island Avenue/);
  assert.equal(root.getAttribute("data-geo"), SUBJECT_GEO);
  assert.ok(dialog.querySelector("[data-near-you-record-source], a[href*='cb14brooklyn.com']"));
  assert.ok(dialog.querySelector("[data-near-you-record-inspection-open]"));
  const retry = dialog.querySelector("[data-near-you-record-inspection-retry]");
  assert.ok(retry, "failed detail must offer retry");
  click(retry);
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(attempts, 2);
  assert.match(dialog.textContent, /Committee materials are available/);

  const bk1402Ids = activity.geography_items?.by_key?.[`geography:${SUBJECT_GEO}`]?.meetings || [];
  const bk1403Ids = activity.geography_items?.by_key?.[`geography:${VENUE_GEO}`]?.meetings || [];
  const kenIds = activity.geography_items?.by_key?.[`geography:${KENSINGTON_GEO}`]?.meetings || [];
  assert.equal(bk1402Ids.includes(SEPT14_ID), true);
  assert.equal(bk1402Ids.includes(SEPT23_ID), false);
  assert.equal(bk1403Ids.includes(SEPT23_ID), true);
  assert.equal(bk1403Ids.includes(SEPT14_ID), false);
  assert.equal(kenIds.includes(SEPT14_ID), false);
  assert.equal(kenIds.includes(SEPT23_ID), false);

  const midwood = await viewForGeo(VENUE_GEO, "2026-09-15T14:00:00.000Z");
  assert.equal(sept14Record(midwood), null);
  assert.ok((midwood.results?.records || []).some((row) => row.id === SEPT23_ID));
  const sept23 = (midwood.results?.records || []).find((row) => row.id === SEPT23_ID);
  assert.notEqual(sept23?.subject_address, SUBJECT_ADDRESS);
  assert.equal(
    (sept23?.place?.geographies || []).some((geo) =>
      geo?.location_role === "matter" && /461 Coney/i.test(geo?.basis || "")),
    false,
  );

  const kenView = await viewForGeo(KENSINGTON_GEO, "2026-09-15T14:00:00.000Z");
  assert.equal(
    (kenView.results?.records || []).some((row) => row.id === SEPT14_ID || row.id === SEPT23_ID),
    false,
  );

  // One card for the meeting in BK1402 even when multiple roles exist on the row.
  const subjectCards = (await subjectView("2026-09-15T14:00:00.000Z")).view.results?.records
    ?.filter((row) => row.id === SEPT14_ID) || [];
  assert.equal(subjectCards.length, 1);
});

test("A4 [verification] capture tool guards served revision; local detail shows both addresses; lean Worker path", async () => {
  assert.ok(existsSync(CAPTURE_TOOL), "capture tool must exist");
  const captureTool = readFileSync(CAPTURE_TOOL, "utf8");
  assert.match(captureTool, /def revision_contains_required_ancestor/);
  assert.match(captureTool, /does not contain required ancestor/);
  assert.match(captureTool, /ce239e01504c8/);
  assert.match(captureTool, /About 461 Coney Island Avenue|461 Coney Island/);
  assert.match(captureTool, /1625 Ocean/);

  const detailHtml = renderMeetingDocument(sept14Shared, {
    schema: sharedMeetings.schema,
    rows: [sept14Shared],
  });
  assert.match(detailHtml, /id="agenda-subject"/);
  assert.match(detailHtml, /About 461 Coney Island Avenue/);
  assert.match(detailHtml, /1625 Ocean Avenue/);

  const body = renderNearYouRecordInspectionBody(
    nearYouRecordInspectionFacts(activity.records.meetings[SEPT14_ID], {
      now: "2026-09-15T14:00:00.000Z",
    }),
  );
  assert.match(body, /About 461 Coney Island Avenue/);
  assert.match(body, /1625 Ocean Avenue/);

  const publication = buildLocalGeographyPublication({
    activity,
    geography: {},
    meetings: sharedMeetings,
    version: "subject-property-journey",
    residentialPlaces,
    dependencies: {
      parcel_membership_generation: "parcel-subject-journey",
      parcel_coordinate_vintage: "pluto_subject",
      assertion_generation: "assertion-subject",
      source_generation: sharedMeetings.generated_at || "2026-09-23",
    },
  });
  assert.equal(publication.activation.activate, true, publication.activation.reason);

  const values = storePublication(publication);
  const deferred = await handleNearYou(new Request(
    `https://cityscroll.org/near-you/deferred.json?geo=${encodeURIComponent(SUBJECT_GEO)}&lens=meetings&surface=map`,
  ), { ALERT_STATE: kv(values) });
  assert.equal(deferred.status, 200);
  const deferredBody = await deferred.json();
  assert.match(deferredBody.results_html, /About 461 Coney Island Avenue/);
  assert.match(deferredBody.results_html, /1625 Ocean Avenue/);

  const reads = [];
  const detail = await workerMeetingGet({
    ALERT_STATE: {
      get: async (key) => {
        reads.push(key);
        return values.get(key) || null;
      },
    },
  }).execute({ meetingId: SEPT14_ID });
  assert.equal(detail.availability, "available");
  assert.ok(reads.every((key) => key === MEETING_MANIFEST_KEY || key.startsWith("meetings:v1:")));
  assert.equal(reads.includes("hearings:location:v1"), false);
});

test("A4 [verification] production capture manifest records hosted desktop/mobile screenshots when present", () => {
  if (!existsSync(MANIFEST_PATH)) {
    // Capture runs after a served build contains the delivery commit.
    assert.ok(existsSync(CAPTURE_TOOL));
    return;
  }
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  assert.equal(manifest.schema, "cityscroll.render_capture_manifest.v1");
  assert.equal(manifest.feature, "near-you-subject-property-journey");
  assert.equal(manifest.public_alias, "ce239e01504c8");
  assert.equal(manifest.image_binaries_committed, false);
  assert.equal(manifest.capture_mode, "headless-playwright-production-served-site");
  assert.equal(manifest.revision_format, "served artifact-manifest source_commit_sha");
  assert.match(manifest.revision || "", /^[0-9a-f]{40}$/);
  assert.equal(manifest.required_ancestor_contained, true);
  assert.ok(Array.isArray(manifest.captures));
  assert.ok(manifest.captures.length >= 6, "neighborhood, address-search, detail × desktop/mobile");

  const byName = Object.fromEntries(manifest.captures.map((row) => [row.name, row]));
  for (const name of [
    "subject-meetings-desktop",
    "subject-meetings-mobile",
    "subject-address-search-desktop",
    "subject-address-search-mobile",
    "subject-detail-desktop",
    "subject-detail-mobile",
  ]) {
    const row = byName[name];
    assert.ok(row, `missing capture ${name}`);
    assert.equal(typeof row.route, "string");
    assert.ok(row.viewport?.width >= 320);
    assert.match(row.revision || "", /^[0-9a-f]{40}$/);
    assert.match(row.sha256 || "", /^[0-9a-f]{64}$/);
    assert.match(row.screenshot_url || "", /^https:\/\//);
    assert.equal(row.file, null);
  }

  for (const name of ["subject-meetings-desktop", "subject-meetings-mobile", "subject-address-search-desktop", "subject-address-search-mobile"]) {
    const values = byName[name].served_values;
    assert.equal(values.named_row_present, true, `${name} named row`);
    assert.equal(values.about_subject_present, true, `${name} About 461`);
    assert.equal(values.venue_address_present, true, `${name} venue address`);
  }
  for (const name of ["subject-detail-desktop", "subject-detail-mobile"]) {
    const values = byName[name].served_values;
    assert.equal(values.detail_title_present, true, `${name} detail title`);
    assert.equal(values.about_subject_present, true, `${name} subject anchor`);
    assert.equal(values.venue_address_present, true, `${name} venue address`);
    assert.equal(values.agenda_subject_anchor_present, true, `${name} agenda-subject`);
  }
  assert.ok(manifest.repeat_path?.length >= 3);
});

test("grounded revision marker remains recorded for this branch", () => {
  assert.match(GROUNDED_AT, /^[0-9a-f]{40}$/);
  assert.match(REQUIRED_SERVED_ANCESTOR, /^[0-9a-f]{40}$/);
  const inspectionSource = readFileSync(join(ROOT, "site/near_you_record_inspection.mjs"), "utf8");
  assert.match(inspectionSource, /About \$\{text\}/);
  const digest = createHash("sha256").update(inspectionSource).digest("hex");
  assert.equal(digest.length, 64);
});
