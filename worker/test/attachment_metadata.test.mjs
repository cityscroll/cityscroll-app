import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bundledAttachments,
  handleAttachmentMetadata,
  mergeAttachments,
  normalizeAttachment,
  refreshNoticeAttachmentHaystack,
} from "../src/attachment_metadata.mjs";
import { annotateSearchMatchProvenance, toRecord } from "../src/lib/notices.mjs";
import { TEXT_PROVENANCE } from "../src/lib/attachment_text.mjs";

const CANNONSVILLE_URL = "https://a856-cityrecord.nyc.gov/Search/GetFile?sectionId=3&requestId=20240515016&requestStatus=Archived&documentId=37470";

test("bundled Cannonsville metadata remains a visible acceptance exemplar", () => {
  const items = bundledAttachments("20240515016");
  assert.equal(items.length, 1);
  assert.match(items[0].title, /Description, maps, and volume report/);
  assert.equal(items[0].text_status, "ok");
  assert.match(items[0].extracted_text, /187 MBF/);
  const record = toRecord({
    request_id: "20240515016",
    document_urls: JSON.stringify([CANNONSVILLE_URL]),
    n_documents: 1,
  });
  assert.equal(record.n_documents, 1);
  assert.deepEqual(record.documents, [CANNONSVILLE_URL]);
  assert.match(record.attachments[0].title, /Cannonsville watershed basin/);
  assert.match(record.attachment_text, /187 MBF/);
});

test("search results label attachment-text provenance when the hit is only in the extract", () => {
  const record = {
    title: "Property disposition notice",
    snippet: "Sale of standing timber",
    attachment_text: "187 MBF of hardwood sawtimber in the Cannonsville watershed",
  };
  const annotated = annotateSearchMatchProvenance(record, ["187 mbf"]);
  assert.equal(annotated.match_provenance, TEXT_PROVENANCE);
  assert.equal(annotated.match_evidence.field, "attachment-text");
});

test("haystack refresh merges attachment text into the notices search index", async () => {
  let updated = null;
  const DB = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (/SELECT haystack/.test(sql)) {
                return { haystack: "cannonsville timber sale" };
              }
              return null;
            },
            async run() {
              if (/UPDATE notices SET haystack/.test(sql)) {
                updated = args[0];
              }
              return { success: true };
            },
          };
        },
      };
    },
  };
  await refreshNoticeAttachmentHaystack(DB, "20240515016", [{
    extracted_text: "187 MBF hardwood sawtimber",
  }]);
  assert.match(updated, /cannonsville timber sale/);
  assert.match(updated, /\[attachment-text\]/);
  assert.match(updated, /187 mbf/);
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
  // T3: precomputed related edges ride along (no request-time embedding).
  assert.ok(body.related_by_attachment);
  assert.equal(body.related_by_attachment.request_id, "20240515016");
  assert.ok(body.related_by_attachment.related.length >= 1);
  assert.match(body.related_by_attachment.related[0].title || "", /Ashokan|timber|forest|reservoir/i);
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
