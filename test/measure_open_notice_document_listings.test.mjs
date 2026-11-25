import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  LISTING_COVERAGE_SCHEMA,
  LISTING_SCHEMA,
  assertListingWithinBound,
} from "../tools/lib/open_notice_document_listing.mjs";
import { withTempDir } from "../tools/lib/with_temp_dir.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOOL = path.join(ROOT, "tools", "measure_open_notice_document_listings.mjs");
const NAVIGATOR_FIXTURE = path.join(ROOT, "test", "fixtures", "open_notice_document_listing", "navigator-typed.html");

// One strictly bound open notice: the PIN equals the round's EPIN, the title,
// release day and due wall-clock time match, and the retained Navigator page
// shows the round with a displayed id equal to the round's bpm id.
const NOTICES_DOC = {
  generated_at: "2026-11-16T06:30:00.000Z",
  open_as_of: "2026-11-16",
  count: 1,
  notices: [
    {
      request_id: "20261015010",
      pin: "84627B0012",
      short_title: "Maintenance and Repair of Automated Logic WebCTRL and Carrier",
      start_date: "2026-10-21T00:00:00.000",
      due_date: "2026-11-09T14:00:00.000",
    },
  ],
};

const RFX_ROWS = [
  {
    rfp_id: "37728",
    bpm_id: "37402",
    epin: "84627B0012",
    procurement_name: "Maintenance and Repair of Automated Logic WebCTRL and Carrier",
    release_date: "10/21/2026",
    due_date: "11/9/2026 2:00:00 PM",
  },
];

function writeFixtures(root) {
  const notices = path.join(root, "notices.json");
  const rfx = path.join(root, "rfx.json");
  const navigatorDir = path.join(root, "navigator");
  mkdirSync(navigatorDir, { recursive: true });
  writeFileSync(notices, JSON.stringify(NOTICES_DOC));
  writeFileSync(rfx, JSON.stringify(RFX_ROWS));
  copyFileSync(NAVIGATOR_FIXTURE, path.join(navigatorDir, "37728.html"));
  return { notices, rfx, navigatorDir };
}

function runTool(args) {
  const result = spawnSync(process.execPath, [TOOL, ...args], { cwd: ROOT, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result;
}

test("offline fixture run publishes an artifact that validates against its schema", async () => {
  await withTempDir("open-notice-document-listing-offline", async (root) => {
    const { notices, rfx, navigatorDir } = writeFixtures(root);
    const out = path.join(root, "open_notice_document_listings.json");
    const summaryOut = path.join(root, "scratch", "summary.json");
    const result = runTool([
      "--notices", notices,
      "--rfx", rfx,
      "--navigator-dir", navigatorDir,
      "--out", out,
      "--summary-out", summaryOut,
    ]);
    assert.match(result.stdout, /^measured available 1 of 1/);

    const artifact = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(artifact.schema, LISTING_SCHEMA);
    assert.equal(artifact.schema, "cityscroll.open_notice_document_listings.v1");
    assert.equal(artifact.state, "measured");
    assert.equal(artifact.as_of, "2026-11-16");
    assert.equal(typeof artifact.observed_at, "string");
    assert.ok(Number.isFinite(Date.parse(artifact.observed_at)), "observed_at is the freshness vintage");
    assert.equal(artifact.open_notices, 1);
    assert.equal(artifact.available, 1);
    assert.equal(artifact.missing, 0);
    assert.equal(artifact.documents_listed_coverage.schema, LISTING_COVERAGE_SCHEMA);
    const record = artifact.notices[0].coverage.documents_listed;
    assert.equal(record.state, "available");
    assert.equal(record.data.file_count, 3);
    assert.equal(record.data.files.length, 3);
    // The offline run observes no file bodies: sizes and page counts stay unmeasured.
    for (const file of record.data.files) {
      assert.equal(file.size_state, "not_measured");
      assert.equal(file.page_state, "not_measured");
    }
    // The lib's own publication bound accepts the artifact the tool wrote.
    assert.ok(assertListingWithinBound(artifact) > 0);

    // The summary (counts, samples, fetch log) lands where --summary-out put it,
    // not beside the served artifact.
    assert.equal(existsSync(`${out}.summary.json`), false);
    const summary = JSON.parse(readFileSync(summaryOut, "utf8"));
    assert.equal(summary.schema, LISTING_SCHEMA);
    assert.equal(summary.state, "measured");
    assert.deepEqual(summary.fetch_log, []);
    assert.equal(summary.coverage.available, 1);
  });
});

test("without --summary-out the summary still lands beside the artifact", async () => {
  await withTempDir("open-notice-document-listing-default-summary", async (root) => {
    const { notices, rfx, navigatorDir } = writeFixtures(root);
    const out = path.join(root, "open_notice_document_listings.json");
    runTool(["--notices", notices, "--rfx", rfx, "--navigator-dir", navigatorDir, "--out", out]);
    const summary = JSON.parse(readFileSync(`${out}.summary.json`, "utf8"));
    assert.equal(summary.schema, LISTING_SCHEMA);
  });
});
