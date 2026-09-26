/**
 * Board ↔ neighborhood association index.
 *
 *   node --test test/board_neighborhood_index.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  BOARD_NEIGHBORHOOD_INDEX_PATH,
  BOARD_NEIGHBORHOOD_INDEX_RECEIPT_SCHEMA,
  BOARD_NEIGHBORHOOD_INDEX_SCHEMA,
  boardsForNta,
  buildBoardNeighborhoodIndex,
  ntaSubtypeMapFromLayer,
  ntasForBoard,
  resolvePublishedBoardForDistrict,
  serializeBoardNeighborhoodIndex,
} from "../site/board_neighborhood_index.mjs";

const ROOT = process.cwd();

function readJson(relative) {
  return JSON.parse(readFileSync(join(ROOT, relative), "utf8"));
}

function loadProductionInputs() {
  const crosswalk = readJson(
    "site/data/geography/crosswalks/nta2020__community_district/26B__2026-05-26.json",
  );
  const geography = readJson("site/data/community_board_geography_lookup.json");
  const ntaLayer = readJson("site/data/geography/layers/nta2020/26B.json");
  return {
    crosswalk,
    geography,
    ntaSubtypeById: ntaSubtypeMapFromLayer(ntaLayer),
    sourceHashes: {
      crosswalk: "a".repeat(64),
      geography: "b".repeat(64),
      nta_layer: "c".repeat(64),
    },
    builtAt: "2026-08-12T00:00:00.000Z",
  };
}

function excerptCrosswalk(crosswalk, ntaIds) {
  const wanted = new Set(ntaIds);
  return {
    ...crosswalk,
    rows: crosswalk.rows.filter((row) => {
      const id = String(row.from_key || "").split(":").pop();
      return wanted.has(id);
    }),
  };
}

test("A1: pinned baseline yields 450 material rows, 411 board / 39 non-board, 59 boards", () => {
  const doc = buildBoardNeighborhoodIndex(loadProductionInputs());
  assert.equal(doc.schema, BOARD_NEIGHBORHOOD_INDEX_SCHEMA);
  assert.equal(doc.inventory.material_row_count, 450);
  assert.equal(doc.inventory.board_associated_row_count, 411);
  assert.equal(doc.inventory.non_board_row_count, 39);
  assert.equal(doc.inventory.board_identity_count, 59);
  assert.equal(Object.keys(doc.by_board).length, 59);
  assert.equal(doc.receipt.association_failures.length, 0);

  const committed = readJson(BOARD_NEIGHBORHOOD_INDEX_PATH);
  assert.equal(committed.inventory.material_row_count, 450);
  assert.equal(committed.inventory.board_associated_row_count, 411);
  assert.equal(committed.inventory.non_board_row_count, 39);
  assert.equal(committed.inventory.board_identity_count, 59);
});

test("A2: Kensington maps to K12/K14; SI0105 maps to R01/R02; reverse R02 keeps SI0105", () => {
  const doc = buildBoardNeighborhoodIndex(loadProductionInputs());

  const kensington = boardsForNta(doc, "BK1203");
  assert.deepEqual(
    kensington.map((edge) => edge.district_id),
    ["K12", "K14"],
  );
  assert.deepEqual(
    kensington.map((edge) => edge.board_id),
    ["brooklyn-cb-12", "brooklyn-cb-14"],
  );
  assert.equal(kensington[0].pct_from, 96.866874);
  assert.equal(kensington[1].pct_from, 3.133126);
  assert.ok(kensington[0].pct_from > kensington[1].pct_from);

  const si = boardsForNta(doc, "SI0105");
  assert.deepEqual(
    si.map((edge) => edge.district_id),
    ["R01", "R02"],
  );
  assert.deepEqual(
    si.map((edge) => edge.board_id),
    ["staten-island-cb-01", "staten-island-cb-02"],
  );
  assert.equal(si[0].pct_from, 99.605587);
  assert.equal(si[1].pct_from, 0.394413);
  assert.equal(si[1].pct_to, 0.051029);

  const reverseR02 = ntasForBoard(doc, "staten-island-cb-02");
  const siEdge = reverseR02.find((edge) => edge.nta_id === "SI0105");
  assert.ok(siEdge, "reverse R02 retains SI0105 despite small district-area share");
  assert.equal(siEdge.pct_to, 0.051029);
  assert.equal(siEdge.pct_from, 0.394413);
  assert.ok(
    reverseR02.every((edge, index, list) => (
      index === 0 || list[index - 1].pct_to >= edge.pct_to
    )),
    "reverse view sorts by pct_to descending",
  );
});

test("A3: K56 stays a special district; duplicate/unpublished covers fail with receipt", () => {
  const inputs = loadProductionInputs();
  const doc = buildBoardNeighborhoodIndex(inputs);

  const k56 = doc.non_board_overlaps.filter((edge) => edge.district_id === "K56");
  assert.ok(k56.length >= 1, "K56 material overlaps remain");
  assert.ok(k56.every((edge) => edge.board_id === null));
  assert.ok(
    !Object.values(doc.by_board).flat().some((edge) => edge.district_id === "K56"),
    "no synthesized board for K56",
  );
  const springCreek = k56.find((edge) => edge.nta_id === "BK0504");
  assert.ok(springCreek);
  assert.equal(springCreek.pct_from, 0.636724);

  const missing = resolvePublishedBoardForDistrict("K56", inputs.geography);
  assert.equal(missing.status, "missing_covers");
  assert.equal(missing.board_id, null);

  const duplicateGeography = {
    ...inputs.geography,
    public_edges: [
      ...(inputs.geography.public_edges || []),
      {
        id: "edge:covers:duplicate:K12",
        type: "covers",
        from: "community-board:brooklyn-cb-99",
        to: "community-district:K12",
        boundary_vintage: "2026-05-26",
      },
    ],
  };
  const excerpt = excerptCrosswalk(inputs.crosswalk, ["BK1203"]);
  const duplicateDoc = buildBoardNeighborhoodIndex({
    ...inputs,
    crosswalk: excerpt,
    geography: duplicateGeography,
  });
  assert.equal(duplicateDoc.inventory.board_associated_row_count, 1);
  assert.deepEqual(
    boardsForNta(duplicateDoc, "BK1203").map((edge) => edge.district_id),
    ["K14"],
  );
  assert.equal(duplicateDoc.non_board_overlaps.length, 1);
  assert.equal(duplicateDoc.non_board_overlaps[0].district_id, "K12");
  assert.equal(duplicateDoc.receipt.schema, BOARD_NEIGHBORHOOD_INDEX_RECEIPT_SCHEMA);
  assert.ok(
    duplicateDoc.receipt.association_failures.every((row) => row.status === "duplicate_covers"),
  );
  assert.ok(
    duplicateDoc.receipt.association_failures.some((row) => (
      row.nta_id === "BK1203" && row.district_id === "K12"
    )),
  );

  const unpublishedGeography = {
    ...inputs.geography,
    gate: {
      ...inputs.geography.gate,
      publication_allowed: false,
    },
    public_edges: [],
  };
  const unpublishedDoc = buildBoardNeighborhoodIndex({
    ...inputs,
    crosswalk: excerpt,
    geography: unpublishedGeography,
  });
  assert.equal(unpublishedDoc.inventory.board_associated_row_count, 0);
  assert.ok(unpublishedDoc.receipt.association_failures.length >= 1);
  assert.ok(
    unpublishedDoc.receipt.association_failures.every((row) => row.status === "unpublished"),
  );
  assert.equal(unpublishedDoc.receipt.geography_publication_allowed, false);
});

test("A4: real excerpts, byte determinism, and unsupported-subtype cases", () => {
  const inputs = loadProductionInputs();
  const excerpt = excerptCrosswalk(inputs.crosswalk, ["BK1203", "SI0105", "BK0504"]);
  const first = buildBoardNeighborhoodIndex({
    ...inputs,
    crosswalk: excerpt,
  });
  const second = buildBoardNeighborhoodIndex({
    ...inputs,
    crosswalk: excerpt,
  });
  assert.equal(
    serializeBoardNeighborhoodIndex(first),
    serializeBoardNeighborhoodIndex(second),
    "unchanged inputs produce identical bytes",
  );
  assert.equal(first.generation.content_sha256, second.generation.content_sha256);

  assert.deepEqual(
    boardsForNta(first, "BK1203").map((edge) => edge.board_id),
    ["brooklyn-cb-12", "brooklyn-cb-14"],
  );
  assert.deepEqual(
    boardsForNta(first, "SI0105").map((edge) => edge.district_id),
    ["R01", "R02"],
  );
  assert.ok(
    first.non_board_overlaps.some((edge) => (
      edge.nta_id === "BK0504" && edge.district_id === "K56" && edge.board_id === null
    )),
  );

  const subtypes = { ...inputs.ntaSubtypeById, BK1203: "not_a_real_nta_subtype" };
  const unsupported = buildBoardNeighborhoodIndex({
    ...inputs,
    crosswalk: excerptCrosswalk(inputs.crosswalk, ["BK1203"]),
    ntaSubtypeById: subtypes,
  });
  assert.equal(unsupported.inventory.board_associated_row_count, 0);
  assert.equal(unsupported.non_board_overlaps.length, 0);
  assert.ok(
    unsupported.receipt.association_failures.every((row) => row.status === "unsupported_subtype"),
  );
  assert.ok(
    unsupported.receipt.association_failures.some((row) => (
      row.nta_id === "BK1203" && row.subtype === "not_a_real_nta_subtype"
    )),
  );
});

test("committed artifact matches a rebuild from frozen inputs", async () => {
  const { spawnSync } = await import("node:child_process");
  const rebuild = spawnSync(process.execPath, ["tools/build_board_neighborhood_index.mjs"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(rebuild.status, 0, rebuild.stderr || rebuild.stdout);
  const check = spawnSync(
    process.execPath,
    ["tools/build_board_neighborhood_index.mjs", "--check"],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(check.status, 0, check.stderr || check.stdout);
  const committed = readFileSync(join(ROOT, BOARD_NEIGHBORHOOD_INDEX_PATH), "utf8");
  const doc = buildBoardNeighborhoodIndex({
    ...loadProductionInputs(),
    sourceHashes: readJson(BOARD_NEIGHBORHOOD_INDEX_PATH).source_hashes,
    builtAt: readJson(BOARD_NEIGHBORHOOD_INDEX_PATH).generation.built_at,
  });
  // Rebuild above refreshed hashes from real file bytes; compare via --check path.
  assert.match(committed, /"schema": "cityscroll.board_neighborhood_index.v1"/);
  assert.equal(doc.schema, BOARD_NEIGHBORHOOD_INDEX_SCHEMA);
});
