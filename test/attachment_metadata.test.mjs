import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  mergeAttachmentSources,
  parseDatasetAttachments,
  parsePortalAttachments,
  shouldScrapePortal,
} from "../warehouse/lib/attachment_metadata.mjs";
import { SITE_SOURCE } from "./helpers/site_source.mjs";

const NOTICE_SOURCE = readFileSync(new URL("../site/app/notice-context.mjs", import.meta.url), "utf8");
const fixture = JSON.parse(readFileSync(new URL("../warehouse/fixtures/attachment_metadata.json", import.meta.url)));
const demo = JSON.parse(readFileSync(new URL("../site/demo/demo-links.json", import.meta.url)));
const sources = JSON.parse(readFileSync(new URL("../site/data/source_contracts.json", import.meta.url)));
const gaps = JSON.parse(readFileSync(new URL("../site/data/gap_taxonomy.json", import.meta.url)));
const runner = readFileSync(new URL("../warehouse/scripts/attachment_metadata_run.py", import.meta.url), "utf8");
const staticLookup = JSON.parse(readFileSync(new URL("../site/data/attachment_metadata_lookup.json", import.meta.url)));

test("T0 merges the archive URL with the richer Cannonsville portal title", () => {
  const row = fixture.rows[0];
  const dataset = parseDatasetAttachments(row);
  const portal = parsePortalAttachments(fixture.portal_html[row.request_id], row.request_id);
  const merged = mergeAttachmentSources(dataset, portal);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].document_id, "37470");
  assert.match(merged[0].title, /Description, maps, and volume report/);
  assert.equal(merged[0].source, "portal");
  assert.equal(merged[0].content_type, null);
  assert.equal(merged[0].bytes, null);
});

test("T0 source policy crosses the 2025 export cliff and excludes personnel", () => {
  assert.equal(shouldScrapePortal(fixture.rows[0]), false, "pre-2025 archive uses document_links by default");
  assert.equal(shouldScrapePortal(fixture.rows[1]), true, "modern notices use RequestDetail even when document_links is empty");
  assert.equal(shouldScrapePortal(fixture.rows[2]), false, "Changes in Personnel is excluded");
});

test("warehouse runner preserves CPU, checkpoint, and politeness controls", () => {
  assert.match(runner, /IngestLock/);
  assert.match(runner, /check_headroom/);
  assert.match(runner, /attachment_metadata_by_notice/);
});

test("notice chrome and demo contract expose the Cannonsville official attachment source", () => {
  assert.match(SITE_SOURCE, /function attachmentChipHTML/);
  assert.match(NOTICE_SOURCE, /officialSourceLink\(\{ href: first\.url/);
  assert.match(SITE_SOURCE, /\/attachment-metadata\?id=/);
  assert.equal(staticLookup.notices["20240515016"][0].document_id, "37470");
  assert.match(NOTICE_SOURCE, /className: "attachment-source-link"/);
  const entry = demo.entries.find((item) => item.id === "notice-cannonsville-attachment");
  assert.equal(entry.url, "#notice/20240515016");
  assert.equal(entry.postDeployOnly, true);
  assert.match(entry.expectations.visible[0].text, /maps, and volume report/);
  const extractExpectation = entry.expectations.visible.find((item) => item.selector?.includes("attachment-extract"));
  assert.ok(extractExpectation, "demo expects progressive attachment extract");
  assert.match(extractExpectation.text, /187 MBF/);
  const demoHarness = readFileSync(new URL("./functional/20_demo_links.py", import.meta.url), "utf8");
  assert.match(demoHarness, /CANNONSVILLE_NOTICE/);
  assert.match(demoHarness, /CANNONSVILLE_ATTACHMENTS/);
  assert.match(demoHarness, /CANNONSVILLE_EXTRACT/);
  assert.match(demoHarness, /CROL_DEMO_LINK_IDS/);
});

test("historical attachment-only notices carry extracted text in the committed lookup", () => {
  for (const [requestId, documentId, text] of [
    ["20180705102", "3423", /FY19 REGULATORY AGENDA/],
    ["20241001008", "38632", /REQUEST FOR COMMENT/],
  ]) {
    const attachment = staticLookup.notices[requestId]?.find((item) => item.document_id === documentId);
    assert.ok(attachment, `${requestId} attachment is materialized`);
    assert.equal(attachment.text_status, "ok");
    assert.match(attachment.extracted_text, text);
  }
  assert.match(SITE_SOURCE, /function noticeAttachmentFallbacks/);
  assert.match(SITE_SOURCE, /document_links/);
});

test("source registry records the measured modern export break", () => {
  const cityRecord = sources.contracts.find((source) => source.id === "city-record");
  assert.equal(cityRecord.attachment_metadata.portal_min_delay_seconds, 1.2);
  assert.match(cityRecord.attachment_metadata.export_cliff.document_links_2025_plus, /empty/);
  const gap = gaps.gaps.find((item) => item.id === "city-record-attachment-export-cliff");
  assert.equal(gap.class, "not_yet_ingested");
  assert.match(gap.evidence, /20%-93%/);
});
