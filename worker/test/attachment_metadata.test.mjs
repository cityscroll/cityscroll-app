import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bundledAttachments,
  handleAttachmentMetadata,
  mergeAttachments,
  normalizeAttachment,
} from "../src/attachment_metadata.mjs";
import { toRecord } from "../src/lib/notices.mjs";

const CANNONSVILLE_URL = "https://a856-cityrecord.nyc.gov/Search/GetFile?sectionId=3&requestId=20240515016&requestStatus=Archived&documentId=37470";

test("bundled Cannonsville metadata remains a visible acceptance exemplar", () => {
  const items = bundledAttachments("20240515016");
  assert.equal(items.length, 1);
  assert.match(items[0].title, /Description, maps, and volume report/);
  const record = toRecord({
    request_id: "20240515016",
    document_urls: JSON.stringify([CANNONSVILLE_URL]),
    n_documents: 1,
  });
  assert.equal(record.n_documents, 1);
  assert.deepEqual(record.documents, [CANNONSVILLE_URL]);
  assert.match(record.attachments[0].title, /Cannonsville watershed basin/);
});

test("portal metadata wins over a title-free dataset URL", () => {
  const merged = mergeAttachments("20250102001", [CANNONSVILLE_URL], [{
    request_id: "20250102001",
    document_id: "37470",
    title: "Map and volume report",
    url: CANNONSVILLE_URL,
    source: "portal",
  }]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].title, "Map and volume report");
  assert.equal(merged[0].source, "portal");
});

test("metadata normalization rejects non-City Record file URLs", () => {
  assert.equal(normalizeAttachment({ request_id: "1", url: "https://example.com/file.pdf" }), null);
  assert.equal(normalizeAttachment({ request_id: "1", url: "https://a856-cityrecord.nyc.gov/RequestDetail/1" }), null);
});

test("public metadata endpoint serves precomputed rows without a portal fetch", async () => {
  const response = await handleAttachmentMetadata(
    new Request("https://api.cityscroll.org/attachment-metadata?id=20240515016"),
    { DB: null },
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.n_attachments, 1);
  assert.equal(body.attachments[0].document_id, "37470");
  assert.match(response.headers.get("cache-control"), /stale-while-revalidate/);
});

test("scheduled production detector can require the latest batch receipt", async () => {
  const receipt = { run_id: "att-01-fixture", finished_at: "2026-08-03T12:00:00Z" };
  const DB = { prepare: () => ({ first: async () => receipt }) };
  const response = await handleAttachmentMetadata(
    new Request("https://api.cityscroll.org/attachment-metadata/receipt"),
    { DB },
  );
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).receipt, receipt);
});

test("receipt gate fails closed before the batch has materialized", async () => {
  const DB = { prepare: () => ({ first: async () => null }) };
  const response = await handleAttachmentMetadata(
    new Request("https://api.cityscroll.org/attachment-metadata/receipt"),
    { DB },
  );
  assert.equal(response.status, 503);
});
