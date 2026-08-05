import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const t0 = read("../warehouse/receipts/proof/att01_attachment_metadata_latest.json");
const t1 = read("../warehouse/receipts/proof/att_t1_attachment_text_latest.json");
const t2 = read("../warehouse/receipts/proof/att_t2_attachment_tables_latest.json");
const site = read("../site/data/attachment_metadata_lookup.json");
const worker = read("../worker/src/data/attachment_metadata_lookup.json");

test("FW-04 receipts preserve a bounded live pass and complete outcome counts", () => {
  for (const receipt of [t0, t1, t2]) {
    assert.equal(receipt.mode, "live");
    for (const field of ["attempted", "extracted", "skipped", "failed"]) {
      assert.equal(Number.isInteger(receipt[field]), true, `${receipt.tier || "t0"}.${field}`);
    }
  }
  assert.equal(t0.window_start, "2026-08-05");
  assert.equal(t0.window_end, "2026-08-05");
  assert.equal(t0.polite_delay_s >= 1.2, true);
  assert.equal(t1.max_docs_per_run <= 25, true);
  assert.equal(t2.max_docs_per_run <= 25, true);
  assert.equal(t1.max_extract_bytes <= 5_000_000, true);
  assert.equal(t2.max_extract_bytes <= 5_000_000, true);
  assert.equal(t1.binaries_stored, false);
  assert.equal(t2.images_ocr, false);
});

test("FW-04 publishes new source-backed metadata through identical lookup twins", () => {
  assert.deepEqual(site, worker);
  assert.ok(site.notices["20260729027"], "live pass notice reaches the reader lookup");
  const liveRows = Object.values(site.notices).flat()
    .filter((row) => row.request_id !== "20240515016");
  assert.equal(liveRows.length, 6);
  assert.ok(liveRows.every((row) => row.source === "portal" && row.url));
  assert.ok(liveRows.every((row) => !row.extracted_text && !row.extracted_tables));
});
