import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildBoardSourceInventory, buildScorecard, renderScorecardPage } from "../site/community-board-scorecard.mjs";

const registry = JSON.parse(readFileSync(new URL("../site/data/non_council_outcome_sources/source_registry.json", import.meta.url), "utf8"));
const inventory = JSON.parse(readFileSync(new URL("../site/data/non_council_outcome_sources/board_source_inventory.json", import.meta.url), "utf8"));
const receipt = JSON.parse(readFileSync(new URL("../site/data/non_council_outcome_sources/verification_receipts/community_board_sources_2026-08-13.json", import.meta.url), "utf8"));
const roles = ["upcoming_meetings", "minutes"];

test("the source registry enumerates the official 59-board roster", () => {
  const boards = registry.sources.filter((row) => row.body_type === "community_board");
  assert.equal(boards.length, 59);
  assert.equal(new Set(boards.map((row) => row.body_id)).size, 59);
  assert.deepEqual(
    Object.entries(boards.reduce((counts, row) => {
      counts[row.borough] = (counts[row.borough] || 0) + 1;
      return counts;
    }, {})),
    [["Bronx", 12], ["Brooklyn", 18], ["Manhattan", 12], ["Queens", 14], ["Staten Island", 3]],
  );
  assert.equal(inventory.boards.length, 59);
  assert.deepEqual(new Set(inventory.boards.map((row) => row.id)), new Set(boards.map((row) => row.body_id)));
  assert.equal(inventory.policy.source_registry_is_url_authority, true);
});

test("calendar and minutes are separate receipt-backed source roles", () => {
  const registryById = new Map(registry.sources.map((row) => [row.body_id, row]));
  const receiptByKey = new Map(receipt.sources.map((row) => [`${row.board_id}:${row.role}`, row]));
  assert.equal(receipt.sources.length, 118);

  for (const board of inventory.boards) {
    const registryRow = registryById.get(board.id);
    assert.ok(registryRow, board.id);
    for (const [role, value] of [["upcoming_meetings", board.upcoming], ["minutes", board.minutes]]) {
      assert.equal(value.source_type, role);
      assert.ok(Object.hasOwn(value, "publisher"));
      assert.ok(Object.hasOwn(value, "url"));
      assert.ok(Object.hasOwn(value, "format"));
      assert.ok(Object.hasOwn(value, "fetch_mode"));
      assert.ok(Object.hasOwn(value, "access_constraint"));
      assert.match(value.seen_on, /^2026-08-13$/);
      assert.deepEqual(Object.keys(value.archive_depth).sort(), ["earliest_year", "latest_year", "status"]);
      assert.ok(Object.hasOwn(value, "stable_key"));
      assert.ok(value.verification?.receipt_ref);
      assert.equal(registryRow.source_roles[role].url, value.url, `${board.id} ${role} URL authority`);
      const receiptRow = receiptByKey.get(`${board.id}:${role}`);
      assert.equal(receiptRow.url, value.url);
      assert.equal(receiptRow.seen_on, value.seen_on);
      assert.equal(receiptRow.fetchability, value.verification.fetchability);
      if (value.url) {
        assert.match(value.url, /^https:\/\//);
        assert.ok(value.publisher);
        assert.ok(value.format);
        assert.ok(value.fetch_mode);
        assert.ok(value.stable_key);
        assert.equal(value.verification.status, "observed");
      } else {
        assert.equal(value.status, "absent_in_pass");
        assert.equal(value.verification.status, "not_observed");
        assert.equal(value.verification.reason, "not_observed_in_pass");
        assert.equal(value.stable_key, null);
      }
    }
  }

  const cb6 = inventory.boards.find((board) => board.id === "manhattan-cb-06");
  assert.equal(cb6.minutes.url, "https://airtable.com/appgK5bKw7rWMRJEh/shrBzfHDWat4YMTHL/tblpioBcj0BVp5hBw");
  assert.equal(cb6.minutes.adapter, "airtable_v1");
  assert.equal(cb6.minutes.publisher_kind, "third_party_storage");
  assert.equal(cb6.minutes.verification.fetchability, "browser_required");

  const roleKinds = new Set(inventory.boards.flatMap((board) => roles.map((role) => board[role === "upcoming_meetings" ? "upcoming" : "minutes"].publisher_kind)).filter(Boolean));
  assert.ok(roleKinds.has("nyc_official"));
  assert.ok(roleKinds.has("board_owned_official"));
  assert.ok(roleKinds.has("third_party_storage"));
  assert.deepEqual(inventory.policy.publisher_kinds, ["nyc_official", "board_owned_official", "city_record", "third_party_storage"]);
});

test("the scorecard keeps source provenance resident-readable", () => {
  const scorecard = buildScorecard({ registry, sourceInventory: inventory });
  assert.equal(scorecard.rows.length, 59);
  const html = renderScorecardPage(scorecard);
  const readerCopy = html.replace(/<[^>]+>/g, " ");
  assert.doesNotMatch(readerCopy, /upcoming_meetings|not_yet_ingested|absent_in_pass|matter_title_place|venue_line|boro_cd/);
  assert.doesNotMatch(readerCopy, /Source:\s*Unavailable|Join method:\s*Unavailable/i);
  assert.match(readerCopy, /NYC-hosted official source/);
  assert.match(readerCopy, /Board-owned official source/);
  assert.match(readerCopy, /Board-linked third-party storage/);
});

test("City Record remains a distinct source origin", () => {
  const board = registry.sources.find((row) => row.body_id === "bronx-cb-01");
  const cityRecord = "https://a856-cityrecord.nyc.gov/RequestDetail/20260813001";
  const syntheticRegistry = {
    sources: [{
      ...board,
      source_url: cityRecord,
      source_roles: {
        upcoming_meetings: { ...board.source_roles.upcoming_meetings },
        minutes: { ...board.source_roles.minutes, url: cityRecord, publisher_kind: "city_record", publisher: "City Record" },
      },
    }],
  };
  const syntheticInventory = { schema: inventory.schema, observed_on: inventory.observed_on, boards: [{
    ...inventory.boards[0],
    minutes: { ...inventory.boards[0].minutes, url: cityRecord, publisher_kind: "city_record", publisher: "City Record" },
  }] };
  const row = buildBoardSourceInventory({ registry: syntheticRegistry, inventory: syntheticInventory })[0];
  assert.equal(row.sources.minutes.origin, "city_record");
  assert.equal(row.sources.minutes.origin_label, "City Record notice source");
});
