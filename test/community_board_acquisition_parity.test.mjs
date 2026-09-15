import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  parseHtmlPdfSource,
} from "../site/community_board_source_adapters.mjs";
import {
  buildCommunityBoardAcquisitionParityReport,
  validateCommunityBoardAcquisitionParityReport,
} from "../tools/community_board_acquisition_parity.mjs";

const OBSERVED_AT = "2026-09-14T01:44:00Z";
const fixtureRoot = new URL("./fixtures/community_board_acquisition_sources/", import.meta.url);
const htmlSources = [
  ["bronx-cb-06", "bronx-cb-06.html"], ["bronx-cb-08", "bronx-cb-08.html"],
  ["manhattan-cb-02", "manhattan-cb-02.html"], ["manhattan-cb-04", "manhattan-cb-04.html"],
  ["manhattan-cb-10", "manhattan-cb-10.html"], ["manhattan-cb-12", "manhattan-cb-12.html"],
];
const fixture = (name) => readFileSync(new URL(name, fixtureRoot), "utf8");

function receipt(sourceUrl, requests = 1) {
  return {
    status: "ok", observed_at: OBSERVED_AT, source_url: sourceUrl,
    parser: "html_pdf_v1",
    acquisition: { complete: true, stats: { requests, bytes: 1000, elapsed_ms: 12 } },
  };
}

test("seven-source parity requires admitted records and consumer read-back", async () => {
  const observations = htmlSources.map(([boardId, file]) => {
    const url = `https://${boardId}.example/calendar/`;
    const records = parseHtmlPdfSource(fixture(file), {
      adapter: "html_pdf_v1", role: "upcoming_meetings", board_id: boardId,
      url, body_name: boardId,
    }, { observedAt: OBSERVED_AT, receipt: receipt(url) });
    return { source_id: boardId, records, receipt: receipt(url) };
  });
  const cb11Records = [{
    record_id: "rec-cb11-full", source_record_id: "rec-cb11-full", date: "2026-09-16",
    title: "Full Board Meeting", source_url: "https://cb11.example/calendar/",
    observed_receipt: receipt("https://cb11.example/calendar/"),
  }];
  observations.push({ source_id: "manhattan-cb-11", records: cb11Records, receipt: receipt("https://cb11.example/calendar/", 3) });
  const readback = Object.fromEntries(observations.map((row) => [row.source_id, row.records]));
  const report = buildCommunityBoardAcquisitionParityReport({
    observations, consumerReadback: readback, revision: "test-revision",
    environment: "scheduled-acquisition-worker", observedAt: OBSERVED_AT, scheduled: true,
  });
  assert.equal(report.source_count, 7);
  assert.equal(report.status, "pass");
  assert.deepEqual(validateCommunityBoardAcquisitionParityReport(report), { valid: true, errors: [] });
  assert.ok(report.sources.every((source) => source.record_count > 0 && source.consumer_readback));
  assert.ok(report.sources.every((source) => source.resource_use.requests > 0));
});

test("transport failure remains open and exposes last-good age", () => {
  const report = buildCommunityBoardAcquisitionParityReport({
    observations: [{
      source_id: "manhattan-cb-11", records: [], last_good_observed_at: "2026-09-12T01:44:00Z",
      receipt: { status: "unknown", reason: "http_403", observed_at: OBSERVED_AT,
        acquisition: { stats: { requests: 2, bytes: 80, elapsed_ms: 20 } } },
    }], consumerReadback: {}, revision: "test-revision", environment: "scheduled-acquisition-worker",
    observedAt: "2026-09-14T01:44:00Z",
  });
  assert.equal(report.status, "open");
  assert.deepEqual(report.sources[0].failures, ["http_403", "no_usable_records", "consumer_readback_missing"]);
  assert.equal(report.sources[0].last_good_age_hours, 48);
  assert.deepEqual(validateCommunityBoardAcquisitionParityReport(report, { expectedSourceCount: 1 }).valid, false);
});
