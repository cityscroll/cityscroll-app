import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const READBACK = join(
  ROOT,
  "docs/evidence/community-board-meeting-retention/read-back.json",
);
const PRODUCTION = join(
  ROOT,
  "docs/evidence/community-board-meeting-retention/production-read.json",
);
const MANIFEST = join(
  ROOT,
  "docs/evidence/community-board-meeting-retention/capture-manifest.json",
);
const PACKET = join(
  ROOT,
  "docs/evidence/community-board-meeting-retention/manifest.json",
);
const PROFILE_ROUTE = "/community-boards/brooklyn-cb-14/";
const DETAIL_ROUTE = (
  "/meetings/meeting%3Acommunity_board%3A"
  + "https%3A%2F%2Fcb14brooklyn.com%2Fmeeting%2Fseptember-2026-board-meeting%2F"
);
const MEETING_DATE = "2026-09-14";
const OFFICIAL_SOURCE = "https://cb14brooklyn.com/meeting/september-2026-board-meeting/";

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function assertCanonicalSortedJson(path) {
  const raw = readFileSync(path, "utf8");
  const sorted = `${JSON.stringify(sortKeysDeep(JSON.parse(raw)), null, 2)}\n`;
  assert.equal(raw, sorted, `${path} must be committed as sorted-key JSON`);
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeysDeep(value[key])]),
    );
  }
  return value;
}

test("meeting-retention read-back records A4 observed venue, date, source, and upcoming omission", () => {
  assertCanonicalSortedJson(READBACK);
  assertCanonicalSortedJson(PRODUCTION);
  assertCanonicalSortedJson(MANIFEST);
  const receipt = loadJson(READBACK);
  assert.equal(
    receipt.schema,
    "cityscroll.community_board_meeting_retention_production_read.v1",
  );
  assert.equal(receipt.public_alias, "c10f6cab88867");
  assert.equal(receipt.evidence_class, "deployed-production-read-back");
  assert.match(receipt.deployment.revision, /^[0-9a-f]{40}$/);
  assert.equal(
    receipt.producer.path,
    "docs/evidence/community-board-meeting-retention/read-back.json",
  );
  assert.deepEqual(receipt.producer.letters, ["A4"]);

  const a4 = receipt.letters.A4;
  assert.equal(a4.clause, "deployed_profile_to_detail_after_calendar_moves_on");
  assert.ok(Array.isArray(a4.reads) && a4.reads.length >= 4);

  const profileReads = a4.reads.filter((row) => row.route === PROFILE_ROUTE);
  const detailReads = a4.reads.filter((row) => row.route === DETAIL_ROUTE);
  assert.ok(profileReads.length >= 2);
  assert.ok(detailReads.length >= 2);

  for (const row of profileReads) {
    const values = row.served_values;
    assert.ok(values && typeof values === "object", `${row.name} must carry served_values`);
    assert.equal(values.upcoming_collection_omitted_from_upcoming, true);
    assert.equal(values.upcoming_collection_cancellation_inferred, false);
    assert.equal(typeof values.constellation_recent_includes_retained_meeting, "boolean");
    if (values.constellation_recent_includes_retained_meeting === true) {
      assert.equal(values.constellation_recent_retained_meeting_date, MEETING_DATE);
    }
    assert.equal("result" in values, false);
    assert.equal("pass" in values, false);
  }

  for (const row of detailReads) {
    const values = row.served_values;
    assert.ok(values && typeof values === "object", `${row.name} must carry served_values`);
    assert.equal(values.venue_address, "1625 Ocean Avenue");
    assert.equal(values.venue_shown, true);
    assert.equal(values.footer_address_used_as_venue, false);
    assert.equal(values.scheduled_date, MEETING_DATE);
    assert.equal(values.scheduled_date_shown, true);
    assert.equal(values.start_shown, true);
    assert.equal(values.official_source_url, OFFICIAL_SOURCE);
    assert.equal(values.official_source_shown, true);
    assert.equal(values.cancelled_marker, false);
    assert.equal("result" in values, false);
    assert.equal("pass" in values, false);
  }
});

test("meeting-retention production-read stays aligned with the A4 read-back", () => {
  const receipt = loadJson(READBACK);
  const production = loadJson(PRODUCTION);
  assert.equal(production.schema, receipt.schema);
  assert.equal(production.public_alias, "c10f6cab88867");
  assert.deepEqual(production.producer.letters, ["A4"]);
  assert.equal(production.letters.A4.reads.length, receipt.letters.A4.reads.length);
  assert.equal(production.deployment.revision, receipt.deployment.revision);
});

test("capture-manifest includes A4 profile and detail captures at both widths", () => {
  const receipt = loadJson(READBACK);
  const manifest = loadJson(MANIFEST);
  assert.equal(manifest.schema, "cityscroll.render_capture_manifest.v1");
  assert.equal(manifest.public_alias, "c10f6cab88867");
  assert.equal(manifest.image_binaries_committed, false);
  assert.deepEqual(manifest.producer.letters, ["A4"]);
  assert.equal(manifest.revision, receipt.deployment.revision);
  const names = new Set((manifest.captures || []).map((row) => row.name));
  for (const row of receipt.letters.A4.reads) {
    assert.ok(names.has(row.name), `missing A4 capture ${row.name}`);
  }
});

test("packet manifest acceptance names the deployed A4 read-back", () => {
  const packet = loadJson(PACKET);
  assert.equal(
    packet.acceptance?.A4,
    "proved_by_source_fixture_and_deployed_read_back",
  );
});

test("generator --check agrees with the retained meeting-retention A4 read-back", () => {
  const result = spawnSync(
    "python3",
    ["tools/capture_community_board_meeting_retention_production_read.py", "--check"],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /check passed/);
});
