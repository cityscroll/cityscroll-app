import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import {
  attachmentTextForHaystack,
  classifyAttachmentForText,
  cleanExtractedText,
  matchAttachmentTextEvidence,
  mergeHaystackWithAttachmentText,
  previewFromText,
  stampAttachmentText,
  TEXT_PROVENANCE,
} from "../warehouse/lib/attachment_text.mjs";
import { SITE_SOURCE } from "./helpers/site_source.mjs";

const fixtureDocx = new URL(
  "../warehouse/fixtures/attachment_binaries/37470-cannonsville.docx",
  import.meta.url,
);
const extractor = new URL("../warehouse/lib/attachment_text_extract.py", import.meta.url);
const runner = readFileSync(new URL("../warehouse/scripts/attachment_text_run.py", import.meta.url), "utf8");
const workflow = readFileSync(new URL("../.github/workflows/attachment-metadata.yml", import.meta.url), "utf8");
const lookup = JSON.parse(readFileSync(new URL("../site/data/attachment_metadata_lookup.json", import.meta.url), "utf8"));

test("T1 classifies high-value office attachments and skips personnel-style noise", () => {
  assert.equal(
    classifyAttachmentForText({
      content_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }).class,
    "docx",
  );
  assert.equal(classifyAttachmentForText({ title: "hearing agenda.pdf" }).class, "pdf");
  assert.equal(classifyAttachmentForText({ content_type: "application/msword" }).eligible, false);
  assert.equal(classifyAttachmentForText({ title: "photo.jpg" }).eligible, false);
});

test("T1 cleans text and builds a few-line progressive-disclosure preview", () => {
  const text = cleanExtractedText("Line one\n\n\nLine two\nLine three\nLine four\nLine five");
  const preview = previewFromText(text);
  assert.match(preview, /Line one/);
  assert.match(preview, /Line four/);
  assert.ok(!preview.includes("Line five") || preview.endsWith("…"));
});

test("T1 extracts readable text from the Cannonsville docx fixture", () => {
  assert.ok(existsSync(fixtureDocx));
  const result = spawnSync("python3", [extractor.pathname, fixtureDocx.pathname, "--kind", "docx"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, "ok");
  assert.match(payload.text, /187 MBF/);
  assert.match(payload.text, /Cannonsville watershed basin/);
  assert.match(payload.text, /CARPENTERS EDDY EAST/i);
});

test("T1 stamps attachment rows and feeds haystack with attachment-text provenance", () => {
  const stamped = stampAttachmentText(
    {
      request_id: "20240515016",
      document_id: "37470",
      url: "https://a856-cityrecord.nyc.gov/Search/GetFile?documentId=37470",
      content_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      source: "portal",
    },
    { status: "ok", text: "187 MBF sawtimber in the Cannonsville watershed", method: "docx_xml" },
  );
  assert.equal(stamped.text_status, "ok");
  assert.match(stamped.text_preview, /187 MBF/);
  const hay = attachmentTextForHaystack([stamped]);
  assert.match(hay, new RegExp(`\\[${TEXT_PROVENANCE}\\]`));
  assert.match(hay, /cannonsville/);
  const merged = mergeHaystackWithAttachmentText("timber sale ¦ parks", [stamped]);
  assert.match(merged, /timber sale/);
  assert.match(merged, /attachment-text/);
  // Idempotent re-merge does not stack markers.
  const again = mergeHaystackWithAttachmentText(merged, [stamped]);
  assert.equal((again.match(/\[attachment-text\]/g) || []).length, 1);
});

test("T1 match evidence labels attachment-text provenance", () => {
  const ev = matchAttachmentTextEvidence(
    "Sale of 187 MBF hardwood sawtimber near Dryden Road",
    ["187 mbf", "unrelated"],
  );
  assert.equal(ev.field, "attachment-text");
  assert.equal(ev.provenance, TEXT_PROVENANCE);
  assert.match(ev.hit, /187 mbf/i);
});

test("warehouse runner keeps lock, headroom, and batch caps", () => {
  assert.match(runner, /IngestLock/);
  assert.match(runner, /check_headroom/);
  assert.match(runner, /attachment_text_by_notice/);
  assert.match(runner, /--limit/);
});

test("scheduled attachment jobs run T1 after T0", () => {
  assert.match(workflow, /attachment_metadata_run\.py/);
  assert.match(workflow, /attachment_text_run\.py/);
  assert.match(workflow, /--limit 25/);
});

test("notice chrome exposes progressive attachment extract disclosure", () => {
  assert.match(SITE_SOURCE, /function attachmentExtractHTML/);
  assert.match(SITE_SOURCE, /class="[^"]*attachment-extract/);
  assert.match(SITE_SOURCE, /attachment-extract-preview/);
  assert.match(SITE_SOURCE, /notice_attachment_extract_summary/);
  assert.match(SITE_SOURCE, /digest_match_attachment_html/);
  assert.match(SITE_SOURCE, /attachment-text/);
  const cannonsville = lookup.notices["20240515016"][0];
  assert.equal(cannonsville.text_status, "ok");
  assert.match(cannonsville.extracted_text, /187 MBF/);
  assert.match(cannonsville.text_preview, /Environmental Protection/);
});
