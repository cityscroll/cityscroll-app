/**
 * Host-side person-hub constellation retention + kill-sample gates.
 *
 *   node --test test/person_hub_source_records.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  normalizeCouncilMemberRow,
  normalizeElobbyistRow,
  normalizeCfbContributionRow,
  retainPersonHubConstellation,
  measureCouncilMemberHubJoin,
  USEFULNESS_FLOOR,
  PRECISION_FLOOR,
} from "../warehouse/lib/person_hub_source_records.mjs";
import { buildPersonHubLookup } from "../site/person_hub.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const FIXTURE_DIR = join(ROOT, "test/fixtures/person_hub");
const RECEIPT = join(
  ROOT,
  "site/data/person_hub_sources/verification_receipts/person_hub_source_records_2026-08-11.json",
);

function loadFixture(name) {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8"));
}

describe("person-hub source_records retention", () => {
  it("normalizes publisher rows with stable source_system_id and keeps nulls", () => {
    const council = normalizeCouncilMemberRow({
      name: "Christopher Marte",
      council_member_id: "7801",
      term_start: "2026-01-01T00:00:00.000",
      term_end: "2029-12-31T00:00:00.000",
      district: "1",
      office_id: "5827",
    });
    assert.equal(council.council_member_id, "7801");
    assert.equal(council.source_system_id, "council-member:7801:2026-01-01");
    assert.equal(council.district, "1");

    assert.equal(normalizeCouncilMemberRow({ name: "x" }), null);

    const lobby = normalizeElobbyistRow(loadFixture("elobbyist_sample.json")[0]);
    assert.ok(lobby.source_system_id.startsWith("lobby-reg:"));
    assert.ok(lobby.lobbyist_targets);

    const cfb = normalizeCfbContributionRow(loadFixture("cfb_sample.json")[0]);
    assert.ok(cfb.source_system_id.startsWith("cfb-contrib:"));
    assert.equal(typeof cfb.amnt, "number");
  });

  it("retains fixture rows and clears usefulness + precision gates", () => {
    const councilRows = loadFixture("council_members.json");
    const lobbyRows = loadFixture("elobbyist_sample.json");
    const cfbRows = loadFixture("cfb_sample.json");
    // Use the committed person hub (215 people) so CFB/lobby joins match the
    // host collector path — fixture council alone under-covers CFB recipients.
    const hubPath = join(ROOT, "site/data/person_hub_lookup.json");
    const hub = existsSync(hubPath)
      ? JSON.parse(readFileSync(hubPath, "utf8"))
      : buildPersonHubLookup(councilRows);
    const result = retainPersonHubConstellation({
      councilRows,
      lobbyRows,
      cfbRows,
      personHubLookup: hub,
      ingestedAt: "2026-08-11T20:00:00.000Z",
    });

    assert.ok(result.counts.council_retained >= 20);
    assert.ok(result.counts.lobby_retained >= 20);
    assert.ok(result.counts.cfb_retained >= 20);
    assert.equal(
      result.source_records.length,
      result.counts.council_retained
        + result.counts.lobby_retained
        + result.counts.cfb_retained,
    );

    for (const stream of ["council", "lobby", "cfb"]) {
      const m = result.measurements[stream];
      assert.ok(
        m.usefulness.rate >= USEFULNESS_FLOOR,
        `${stream} usefulness ${m.usefulness.rate}`,
      );
      assert.ok(
        m.precision.rate >= PRECISION_FLOOR,
        `${stream} precision ${m.precision.rate}`,
      );
      assert.equal(m.gates.materialize, true, stream);
    }
    assert.equal(result.gates.materialize, true);

    // Council PersonId join is exact on the fixture hub.
    const councilMeasure = measureCouncilMemberHubJoin(result.council.rows, hub);
    assert.equal(councilMeasure.usefulness.rate, 1);
    assert.equal(councilMeasure.precision.rate, 1);
  });

  it("fixture collector --from-fixture --publish writes a materialize receipt", () => {
    const run = spawnSync(
      process.execPath,
      [
        "tools/retain_person_hub_source_records.mjs",
        "--from-fixture",
        "--publish",
      ],
      { cwd: ROOT, encoding: "utf8" },
    );
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.match(run.stdout, /materialize=true/);
    assert.ok(existsSync(RECEIPT), "verification receipt missing");
    const receipt = JSON.parse(readFileSync(RECEIPT, "utf8"));
    assert.equal(receipt.materialize, true);
    assert.ok(receipt.streams.council.usefulness.rate >= USEFULNESS_FLOOR);
    assert.ok(receipt.streams.lobby.usefulness.rate >= USEFULNESS_FLOOR);
    assert.ok(receipt.streams.cfb.usefulness.rate >= USEFULNESS_FLOOR);
    assert.ok(receipt.streams.council.precision.rate >= PRECISION_FLOOR);
    assert.ok(receipt.streams.lobby.precision.rate >= PRECISION_FLOOR);
    assert.ok(receipt.streams.cfb.precision.rate >= PRECISION_FLOOR);

    const check = spawnSync(
      process.execPath,
      ["tools/retain_person_hub_source_records.mjs", "--check"],
      { cwd: ROOT, encoding: "utf8" },
    );
    assert.equal(check.status, 0, check.stderr || check.stdout);
  });
});
