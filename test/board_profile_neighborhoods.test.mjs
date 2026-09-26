/**
 * Board profile reverse neighborhood links.
 *
 *   node --test test/board_profile_neighborhoods.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  BOARD_PROFILE_NEIGHBORHOODS_SCHEMA,
  BOARD_PROFILE_NEIGHBORHOODS_VISIBLE_LIMIT,
  BOARD_PROFILE_PCT_TO_DENOMINATOR,
  buildBoardProfileNeighborhoodsView,
  ntaLabelIndexFromLayer,
  ntaNearYouHref,
  ntaSubtypeKindLabel,
  renderBoardProfileNeighborhoodsSection,
} from "../site/board_profile_neighborhoods.mjs";
import {
  buildCommunityBoardConstellationView,
  renderCommunityBoardConstellationDocument,
} from "../site/community_board_constellation.mjs";
import { ntasForBoard } from "../site/board_neighborhood_index.mjs";
import { loadActiveBoardNeighborhoodGeneration } from "../site/board_neighborhood_refresh.mjs";
import { parseGeographyNavigationState } from "../site/geography_navigation_state.mjs";
import { normalizeGeographyKey } from "../site/scope_v0.mjs";

const ROOT = process.cwd();

function readJson(relative) {
  return JSON.parse(readFileSync(join(ROOT, relative), "utf8"));
}

function loadLabelIndex() {
  return ntaLabelIndexFromLayer(readJson("site/data/geography/layers/nta2020/26B.json"));
}

function loadProfileAndIndex() {
  const active = loadActiveBoardNeighborhoodGeneration(
    join(ROOT, "site/data/board-neighborhood-generations"),
  );
  assert.ok(active?.profile?.by_board, "active profile consumer required");
  assert.ok(active?.index?.by_board, "active index required");
  return {
    profile: active.profile,
    index: active.index || readJson("site/data/board_neighborhood_index.json"),
    labelIndex: loadLabelIndex(),
  };
}

function constellationSources(extras = {}) {
  const sourceRegistry = readJson("site/data/non_council_outcome_sources/source_registry.json");
  const sourceInventory = readJson("site/data/non_council_outcome_sources/board_source_inventory.json");
  const scorecard = readJson("site/data/community_board_minutes_scorecard.json");
  const geography = readJson("site/data/community_board_geography_lookup.json");
  return {
    sourceRegistry,
    sourceInventory,
    scorecard,
    geography,
    generated_at: scorecard.as_of,
    ...extras,
  };
}

function assertRestoresNtaKey(href, ntaId) {
  assert.ok(href, `missing href for ${ntaId}`);
  const state = parseGeographyNavigationState(href);
  assert.equal(state.ok, true, `geo state not ok for ${href}`);
  assert.equal(state.type, "nta2020");
  assert.equal(state.id, ntaId);
  assert.equal(state.key, `geography:nta2020:${ntaId}`);
  assert.equal(normalizeGeographyKey(state.key), `geography:nta2020:${ntaId}`);
}

test("A1: Brooklyn 12 and 14 include Kensington; Staten Island 2 retains SI0105; links restore NTA keys", () => {
  const { profile, labelIndex } = loadProfileAndIndex();
  assert.equal(labelIndex.BK1203, "Kensington");
  assert.match(labelIndex.SI0105, /Westerleigh/);

  for (const boardId of ["brooklyn-cb-12", "brooklyn-cb-14"]) {
    const view = buildBoardProfileNeighborhoodsView({
      boardId,
      profile,
      labelIndex,
    });
    assert.equal(view.schema, BOARD_PROFILE_NEIGHBORHOODS_SCHEMA);
    const kensington = view.items.find((item) => item.nta_id === "BK1203");
    assert.ok(kensington, `${boardId} must include Kensington`);
    assert.equal(kensington.label, "Kensington");
    assert.equal(kensington.subtype, "residential");
    assert.equal(kensington.kind_label, "Neighborhood");
    assertRestoresNtaKey(kensington.href, "BK1203");
  }

  const si2 = buildBoardProfileNeighborhoodsView({
    boardId: "staten-island-cb-02",
    profile,
    labelIndex,
  });
  const si0105 = si2.items.find((item) => item.nta_id === "SI0105");
  assert.ok(si0105, "Staten Island 2 must retain SI0105 despite small pct_to");
  assert.equal(si0105.pct_to, 0.051029);
  assert.equal(si0105.pct_to_denominator, BOARD_PROFILE_PCT_TO_DENOMINATOR);
  assertRestoresNtaKey(si0105.href, "SI0105");

  const html12 = renderBoardProfileNeighborhoodsSection(
    buildBoardProfileNeighborhoodsView({
      boardId: "brooklyn-cb-12",
      profile,
      labelIndex,
    }),
  );
  assert.match(html12, /Kensington/);
  assert.match(html12, /geography:nta2020:BK1203/);
});

test("A2: no reverse-only threshold drops small overlaps; percentages keep district-area denominator; special districts stay non-boards", () => {
  const { profile, index, labelIndex } = loadProfileAndIndex();

  const si2Edges = ntasForBoard(index, "staten-island-cb-02");
  const si0105Edge = si2Edges.find((edge) => edge.nta_id === "SI0105");
  assert.ok(si0105Edge);
  assert.ok(si0105Edge.pct_to < 1, "fixture remains a small district-area share");

  const view = buildBoardProfileNeighborhoodsView({
    boardId: "staten-island-cb-02",
    profile,
    labelIndex,
  });
  assert.equal(view.items.length, si2Edges.length, "every reverse edge is retained");
  assert.ok(view.items.every((item) => item.pct_to_denominator === BOARD_PROFILE_PCT_TO_DENOMINATOR));
  assert.ok(view.items.every((item) => item.exact_pct_to == null || item.exact_pct_to.endsWith("%")));

  // Ordering: pct_to desc, then nta_id
  for (let i = 1; i < view.items.length; i += 1) {
    const prev = view.items[i - 1];
    const cur = view.items[i];
    const pctCmp = (cur.pct_to || 0) - (prev.pct_to || 0);
    assert.ok(pctCmp < 0 || (pctCmp === 0 && prev.nta_id <= cur.nta_id));
  }

  // Special district K56 has material overlaps but no board profile identity.
  const nonBoard = (index.non_board_overlaps || []).filter((row) => row.district_id === "K56");
  assert.ok(nonBoard.length > 0, "K56 remains in non_board_overlaps");
  assert.equal(profile.by_board["brooklyn-cb-56"], undefined);
  assert.equal(index.by_board["brooklyn-cb-56"], undefined);
  const sources = constellationSources();
  assert.equal(
    buildCommunityBoardConstellationView("brooklyn-cb-56", sources),
    null,
    "special districts do not appear as board profiles",
  );

  // Subtype labels distinguish residential neighborhoods from special areas.
  assert.equal(ntaSubtypeKindLabel("residential"), "Neighborhood");
  assert.equal(ntaSubtypeKindLabel("park"), "Park");
  const park = view.items.find((item) => item.subtype === "park");
  if (park) {
    assert.equal(park.kind_label, "Park");
    assert.equal(park.is_special_use, true);
    assert.equal(park.may_label_as_neighborhood, false);
  }
});

test("A3: missing neighborhood enrichment leaves header, meeting action, official links, and district navigation intact", () => {
  const sources = constellationSources();
  const view = buildCommunityBoardConstellationView("brooklyn-cb-12", sources);
  assert.ok(view);
  assert.equal(view.neighborhoods, undefined);

  const html = renderCommunityBoardConstellationDocument(view);
  assert.doesNotMatch(html, /data-board-profile-neighborhoods/);
  assert.doesNotMatch(html, /#board-neighborhoods/);
  assert.match(html, /data-community-board-overview="1"/);
  assert.match(html, /<h1>Brooklyn Community Board 12<\/h1>/);
  assert.match(html, /Explore this district/);
  assert.ok(
    html.includes("Open this board") && html.includes("place view"),
    "board place-view pivot remains present",
  );
  assert.match(html, /cd=K12|community_district/);
  assert.match(html, /Official website|Board homepage|City directory|Contact the board|Next full-board meeting|#sources/);

  // Explicit null enrichment also omits the section.
  assert.equal(
    buildBoardProfileNeighborhoodsView({ boardId: "brooklyn-cb-12" }),
    null,
  );
  assert.equal(renderBoardProfileNeighborhoodsSection(null), "");
  assert.equal(renderBoardProfileNeighborhoodsSection(undefined), "");
});

test("A4: ordering, six-name disclosure, server-rendered links, subtype labels, and header regressions", () => {
  const { profile, labelIndex } = loadProfileAndIndex();
  const boardId = "brooklyn-cb-14";
  const view = buildBoardProfileNeighborhoodsView({ boardId, profile, labelIndex });
  assert.ok(view.total_count > BOARD_PROFILE_NEIGHBORHOODS_VISIBLE_LIMIT);
  assert.equal(view.visible.length, BOARD_PROFILE_NEIGHBORHOODS_VISIBLE_LIMIT);
  assert.equal(view.remaining_count, view.total_count - BOARD_PROFILE_NEIGHBORHOODS_VISIBLE_LIMIT);
  assert.equal(view.overflow.length, view.remaining_count);

  const section = renderBoardProfileNeighborhoodsSection(view);
  assert.match(section, /data-board-profile-neighborhoods="1"/);
  assert.match(section, new RegExp(`data-neighborhood-remaining="${view.remaining_count}"`));
  assert.match(section, new RegExp(`${view.remaining_count} more overlapping areas`));
  assert.match(section, /<details class="board-profile-neighborhood-more"/);
  // Every associated NTA has a server-rendered anchor (visible + overflow).
  // Attribute escaping turns raw `&` into `&amp;` inside href values.
  for (const item of view.items) {
    const escapedHref = item.href.replaceAll("&", "&amp;");
    assert.ok(section.includes(`href="${escapedHref}"`), `missing href for ${item.nta_id}`);
    assert.ok(section.includes(`data-geography-key="${item.key}"`), `missing key for ${item.nta_id}`);
    assert.ok(section.includes(`data-nta-id="${item.nta_id}"`), `missing nta id ${item.nta_id}`);
  }
  assert.ok(section.includes("Neighborhood") || section.includes("Park"));
  assert.ok(
    section.includes(BOARD_PROFILE_PCT_TO_DENOMINATOR.replaceAll("'", "&#39;"))
      || section.includes(BOARD_PROFILE_PCT_TO_DENOMINATOR),
    "district-area denominator must appear in rendered share copy",
  );

  // Integrated constellation document keeps identity ahead of neighborhood nav.
  const sources = constellationSources({
    boardNeighborhoodProfile: profile,
    ntaLabelIndex: labelIndex,
  });
  const boardView = buildCommunityBoardConstellationView(boardId, sources);
  assert.ok(boardView.neighborhoods);
  assert.equal(boardView.neighborhoods.total_count, view.total_count);
  const html = renderCommunityBoardConstellationDocument(boardView);
  const overviewAt = html.indexOf('data-community-board-overview="1"');
  const neighborhoodsAt = html.indexOf('data-board-profile-neighborhoods="1"');
  assert.ok(overviewAt >= 0 && neighborhoodsAt > overviewAt, "overview stays ahead of neighborhoods");
  assert.match(html, /href="#board-neighborhoods"/);
  assert.match(html, /Explore this district/);
  assert.match(html, /Kensington/);
  assertRestoresNtaKey(ntaNearYouHref("BK1203"), "BK1203");
});
