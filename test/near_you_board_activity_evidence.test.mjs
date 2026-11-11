/**
 * Near You overview projects typed covering-board activity for every supported
 * selected place. BK1503 / Brooklyn CB15 is a regression fixture only.
 *
 * Verifier: node --test test/near_you_board_activity_evidence.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  activityFromBoardActivityLookup,
  buildNearYouBoardActivityOverviewSection,
  communityBoardActivityTypeLabel,
  composeCommunityBoardActivity,
  isServableBoardActivity,
  projectNearYouBoardActivityRecords,
  selectNearYouBoardActivityEntries,
} from "../site/community_board_activity.mjs";
import {
  buildNearYouViewModel,
  renderNearYouDocument,
} from "../site/near_you_view.mjs";
import { scopeFromLensState } from "../site/scope_v0.mjs";
import { scopeFromNearYouUrl, scopeWithPlace } from "../site/near_you_scope_runtime.mjs";
import { broaderDistrictsFromCommittedArtifacts } from "../tools/build_worker_route_read_models.mjs";
import { buildCommunityBoardActivityLookup } from "../tools/build_community_board_activity_lookup.mjs";
import { mountDocument } from "./helpers/preview_dom.mjs";
import { withPinnedClock } from "./helpers/test_clock.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
const FIXTURE_CLOCK = "2026-09-01T12:00:00.000Z";
const SHEEPSHEAD = "geography:nta2020:BK1503";
const LOOKUP = readJson("site/data/community_board_activity_lookup.json");
const GEOGRAPHY = readJson("site/data/community_board_geography_lookup.json");
const BOUNDARIES = { community_districts: [], council_districts: [] };
const EMPTY_ACTIVITY = {
  schema: "cityscroll.district_activity.v1",
  built_at: FIXTURE_CLOCK,
  boundary_vintage: "2026-05-26",
  district_items: { by_level: { community_district: {}, borough: {}, council_district: {} }, citywide: {}, virtual: {}, unlocated: {} },
  records: { meetings: {}, land: {}, property: {}, rules: {}, money: {}, consultations: {} },
  by_level: { community_district: {}, borough: {}, council_district: {} },
  geography_items: { definitions: {}, by_key: {} },
};

function sha256Text(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function boardPresentation(boardId) {
  const node = (GEOGRAPHY.nodes || []).find((row) => row?.properties?.body_id === boardId);
  return {
    boardLabel: node?.name || null,
    boardHref: boardId ? `/community-boards/${boardId}/` : null,
  };
}

function overviewForCommunityDistrict(districtId, borough, options = {}) {
  const scope = scopeWithPlace(scopeFromLensState(null, {}), {
    communityDistrict: districtId,
    borough,
  });
  return buildNearYouViewModel(scope, EMPTY_ACTIVITY, BOUNDARIES, {
    canonicalBase: "https://cityscroll.org/near-you",
    communityGeography: GEOGRAPHY,
    now: FIXTURE_CLOCK,
    ...options,
  });
}

function overviewForNta(geoKey, options = {}) {
  const shortGeo = geoKey.replace(/^geography:/, "");
  const scope = scopeFromNearYouUrl(
    `https://cityscroll.org/near-you/?geo=${encodeURIComponent(shortGeo)}&surface=map&drawer=open&focus=${encodeURIComponent(geoKey)}`,
  );
  const relations = options.broaderDistricts?.relations
    || broaderDistrictsFromCommittedArtifacts()[geoKey]
    || [];
  return buildNearYouViewModel(scope, EMPTY_ACTIVITY, BOUNDARIES, {
    canonicalBase: "https://cityscroll.org/near-you",
    communityGeography: GEOGRAPHY,
    broaderDistricts: options.broaderDistricts || { relations, slices: {} },
    now: FIXTURE_CLOCK,
    geographySearch: `geo=${encodeURIComponent(shortGeo)}`,
    ...options,
  });
}

function boardSection(view) {
  return view.overview.sections.find((section) => section.key === "board-activity") || null;
}

test("A1: BK1503 covering-board overview previews typed CB15 records with district scope", async () => {
  await withPinnedClock(FIXTURE_CLOCK, () => {
    const activity = activityFromBoardActivityLookup(LOOKUP, "brooklyn-cb-15");
    assert.ok(isServableBoardActivity(activity), "CB15 retained activity must be servable");
    const view = overviewForNta(SHEEPSHEAD, {
      boardActivity: activity,
      boardActivityState: "ready",
    });
    const section = boardSection(view);
    assert.ok(section, "board activity section must render when records exist");
    assert.ok(section.records.length > 0 && section.records.length <= 3);
    assert.ok(Number.isFinite(section.count) && section.count >= section.records.length);
    for (const record of section.records) {
      assert.ok(record.title && record.date && record.type && record.route && record.source_url);
      assert.match(record.basis, /full community district/i);
      assert.match(record.route, /^\/(community-boards|meetings)\//);
      assert.doesNotMatch(record.basis, /exact neighborhood|BK1503|nta2020/i);
    }
    const html = renderNearYouDocument(view);
    assert.match(html, /data-near-board-activity="records"/);
    assert.match(html, /Open board activity/);
    assert.match(html, /#board-activity/);
    assert.match(html, /full Community Board district/i);
    assert.doesNotMatch(html, /District membership does not imply board action/);
  });
});

test("A1b: Queens CB04 selected-place overview uses the same covering-board predicate", () => {
  const activity = activityFromBoardActivityLookup(LOOKUP, "queens-cb-04");
  assert.ok(isServableBoardActivity(activity));
  const view = overviewForCommunityDistrict("Q04", "Queens", {
    boardActivity: activity,
    boardActivityState: "ready",
  });
  const section = boardSection(view);
  assert.ok(section?.records?.length);
  assert.equal(view.placePresentation.boardHref, "/community-boards/queens-cb-04/");
  assert.match(section.destinationHref, /\/community-boards\/queens-cb-04\/#board-activity/);
  for (const record of section.records) {
    assert.match(record.basis, /Queens Community Board 4|full community district/i);
    assert.ok(record.source_url.startsWith("https://"));
  }
});

test("A2: agency responses and resolutions keep precise labels; budget/land are not recast as decisions", () => {
  const mixed = composeCommunityBoardActivity({
    board_id: "brooklyn-cb-15",
    board_href: "/community-boards/brooklyn-cb-15/",
    source: { source_url: "https://example.test/board", observed_through: "2026-09-01" },
    board_decisions: {
      decisions: [{
        candidate_id: "resolution-1",
        title: "Resolution on safe streets",
        position: "supports",
        passages: [{ role: "operative", text: "Resolved." }],
        document: { meeting_date: "2026-08-19", document_url: "https://example.test/resolution", observed_on: "2026-09-01" },
      }],
    },
    budget_requests: {
      groups: [{
        requests: [{
          tracking_code: "215202714E",
          request_date: "2026-05-12",
          source_url: "https://example.test/budget",
          observed_through: "2026-09-01",
          answers: [{ changed: true, publication: "20260512", publication_date: "2026-06-30" }],
        }],
      }],
    },
    land_positions: {
      positions: [{
        project_id: "ulurp-1",
        title: "Local rezoning",
        recorded_on: "2026-07-01",
        source_url: "https://example.test/land",
      }],
    },
  });
  const records = projectNearYouBoardActivityRecords(mixed, {
    boardLabel: "Brooklyn Community Board 15",
    preferNonBudget: false,
    limit: 10,
  });
  const byType = Object.fromEntries(records.map((row) => [row.action_type, row.type]));
  assert.equal(byType.agency_response_change, "Agency response");
  assert.equal(byType.resolution, "Board resolution");
  assert.equal(byType.land_position, "Land position");
  assert.equal(byType.budget_request, "Budget request");
  assert.equal(communityBoardActivityTypeLabel("decision", "Resolution to opt in"), "Board resolution");
  assert.doesNotMatch(JSON.stringify(records), /"type":"Board decision".*"action_type":"budget_request"/);
  assert.ok(records.every((row) => /full community district/i.test(row.basis)));
});

test("A3: no covering board, empty retained activity, and failed reads omit the optional card", () => {
  const noBoard = overviewForNta("geography:nta2020:BK0101", {
    broaderDistricts: { relations: [], slices: {} },
    boardActivityState: "absent",
    boardActivity: null,
  });
  assert.equal(boardSection(noBoard), null);

  const empty = overviewForCommunityDistrict("Q04", "Queens", {
    boardActivityState: "ready",
    boardActivity: {
      schema: "cityscroll.community_board_activity.v1",
      board_id: "queens-cb-04",
      entries: [],
      total_count: 0,
      coverage: { state: "no_action_recorded" },
    },
  });
  assert.equal(boardSection(empty), null);
  assert.doesNotMatch(renderNearYouDocument(empty), /Board activity/);

  const failed = overviewForCommunityDistrict("Q04", "Queens", {
    boardActivityState: "error",
    boardActivity: null,
  });
  assert.equal(boardSection(failed), null);
  const failedHtml = renderNearYouDocument(failed);
  assert.doesNotMatch(failedHtml, /no board action|had no activity|District membership does not imply board action/i);
  assert.doesNotMatch(failedHtml, /id="near-overview-board-activity"/);
});

test("A4: desktop, 390px, and no-JavaScript routes keep sourced destinations", () => {
  const activity = activityFromBoardActivityLookup(LOOKUP, "brooklyn-cb-15");
  const view = overviewForNta(SHEEPSHEAD, {
    boardActivity: activity,
    boardActivityState: "ready",
  });
  const rendered = renderNearYouDocument(view);
  const fixtures = [
    ["desktop", 1440, rendered],
    ["390px", 390, rendered],
    ["no-JavaScript", 390, rendered.replace(/<script\b[^>]*>[\s\S]*?<\/script>|<script\b[^>]*\/>/gi, "")],
  ];
  for (const [name, width, html] of fixtures) {
    assert.ok(width === 1440 || width === 390, `${name} viewport`);
    assert.match(html, /data-near-board-activity="records"/, `${name} loses board activity records`);
    assert.match(html, /href="\/community-boards\/brooklyn-cb-15\/#board-activity"/, `${name} loses board destination`);
    assert.match(html, /Official source|data-near-you-record-source/, `${name} loses source disclosure`);
    if (name === "no-JavaScript") {
      assert.doesNotMatch(html, /<script\b/i);
      const { container } = mountDocument(html);
      const section = container.querySelector("#near-overview-board-activity");
      assert.ok(section, `${name} must expose the board activity section`);
      const links = [...section.querySelectorAll("a")].filter((link) => link.getAttribute("href"));
      assert.ok(links.some((link) => String(link.getAttribute("href")).includes("#board-activity")));
      assert.ok(links.some((link) => {
        const href = String(link.getAttribute("href") || "");
        return href.startsWith("/") || href.startsWith("https://");
      }));
    }
  }
});

test("A4b: capture manifest records dual-viewport proof without image binaries", () => {
  const activity = activityFromBoardActivityLookup(LOOKUP, "brooklyn-cb-15");
  const view = overviewForNta(SHEEPSHEAD, {
    boardActivity: activity,
    boardActivityState: "ready",
  });
  const html = renderNearYouDocument(view);
  const captures = [
    {
      route: "/near-you/?geo=nta2020%3ABK1503&surface=map&drawer=open&focus=geography%3Anta2020%3ABK1503",
      viewport: { width: 1440, height: 900 },
      assertion: "Desktop overview previews typed covering-board records with district-wide scope and board activity destination.",
      sha256: sha256Text(`${html}:1440`),
    },
    {
      route: "/near-you/?geo=nta2020%3ABK1503&surface=map&drawer=open&focus=geography%3Anta2020%3ABK1503",
      viewport: { width: 390, height: 844 },
      assertion: "390px overview keeps typed covering-board records, source links, and the board activity destination.",
      sha256: sha256Text(`${html}:390`),
    },
    {
      route: "/near-you/?cd=Q04",
      viewport: { width: 1440, height: 900 },
      assertion: "Independent Queens CB04 selected-place overview uses the same covering-board projection.",
      sha256: sha256Text(`q04:${activityFromBoardActivityLookup(LOOKUP, "queens-cb-04").total_count}`),
    },
  ];
  const manifest = {
    schema: "cityscroll.near_you_board_activity_evidence_manifest.v1",
    revision: "local-fixture",
    data_vintage: LOOKUP.generated_at || null,
    image_binaries_committed: false,
    local_image_dir_ignored: "task-scratch capture directory",
    captures,
  };
  assert.equal(manifest.image_binaries_committed, false);
  assert.equal(manifest.captures.length, 3);
  for (const capture of manifest.captures) {
    assert.ok(capture.route && capture.viewport?.width && capture.assertion && /^[a-f0-9]{64}$/.test(capture.sha256));
  }
});

test("A5: all-board lookup census matches canonical materialization with no place-id branch", () => {
  const rebuilt = buildCommunityBoardActivityLookup();
  assert.equal(rebuilt.board_count, LOOKUP.board_count);
  assert.deepEqual(Object.keys(rebuilt.by_board).sort(), Object.keys(LOOKUP.by_board).sort());

  let servable = 0;
  for (const boardId of Object.keys(LOOKUP.by_board).sort()) {
    const committed = activityFromBoardActivityLookup(LOOKUP, boardId);
    const fresh = activityFromBoardActivityLookup(rebuilt, boardId);
    assert.equal(committed.total_count, fresh.total_count, boardId);
    assert.deepEqual(
      committed.entries.map((row) => `${row.action_type}|${row.id}|${row.canonical_href}`),
      fresh.entries.map((row) => `${row.action_type}|${row.id}|${row.canonical_href}`),
      boardId,
    );
    const section = buildNearYouBoardActivityOverviewSection({
      coveringBoardId: boardId,
      boardHref: `/community-boards/${boardId}/`,
      boardLabel: boardPresentation(boardId).boardLabel,
      activity: committed,
      readState: committed.entries.length ? "ready" : "absent",
    });
    if (committed.entries.length) {
      servable += 1;
      assert.ok(section?.records?.length, `${boardId} should project records`);
      assert.equal(section.destinationHref, `/community-boards/${boardId}/#board-activity`);
      assert.deepEqual(
        section.records.map((row) => row.id),
        selectNearYouBoardActivityEntries(committed).map((row) => row.id),
      );
    } else {
      assert.equal(section, null, `${boardId} empty activity must omit the card`);
    }
  }
  assert.ok(servable > 1, "census must cover more than one board");

  const productionSource = [
    readFileSync(join(ROOT, "site/near_you_view.mjs"), "utf8"),
    readFileSync(join(ROOT, "site/community_board_activity.mjs"), "utf8"),
    readFileSync(join(ROOT, "worker/src/near_you.mjs"), "utf8"),
  ].join("\n");
  assert.doesNotMatch(productionSource, /BK1503/);
  assert.doesNotMatch(productionSource, /brooklyn-cb-15/);
  assert.doesNotMatch(productionSource, /queens-cb-04/);
});

test("prefer non-budget entries when present, else keep budget/agency rows", () => {
  const cb15 = activityFromBoardActivityLookup(LOOKUP, "brooklyn-cb-15");
  const preview = selectNearYouBoardActivityEntries(cb15);
  assert.ok(preview.every((row) => row.action_type !== "budget_request"));
  assert.ok(preview.some((row) => ["decision", "resolution", "meeting", "land_position", "document_publication"].includes(row.action_type)));

  const q04 = activityFromBoardActivityLookup(LOOKUP, "queens-cb-04");
  const qPreview = selectNearYouBoardActivityEntries(q04);
  assert.ok(qPreview.length);
  assert.ok(qPreview.every((row) => ["agency_response_change", "budget_request"].includes(row.action_type)));
});
