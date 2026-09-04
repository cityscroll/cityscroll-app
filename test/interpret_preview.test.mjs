import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import {
  boundedPreviewRows,
  INTERPRET_PREVIEW_LIMIT,
  renderInterpretPreview,
} from "../site/interpret_preview.mjs";
import { filterMoneySnapshot, moneySnapshotRows } from "../site/resident_snapshot_queries.mjs";

const require = createRequire(import.meta.url);
const { parseNL } = require("../site/nl_parse.js");
const moneySnapshot = JSON.parse(readFileSync(new URL("../site/data/money_resident_snapshot.json", import.meta.url), "utf8"));

test("interpret preview renders only the first three interpreted result records", () => {
  const rows = [1, 2, 3, 4].map((id) => ({ id, title: `Record ${id}` }));
  const html = renderInterpretPreview({
    query: "education contracts",
    rows,
    renderRow: (row, index) => `<article data-index="${index}">${row.title}</article>`,
  });

  assert.equal(boundedPreviewRows(rows).length, INTERPRET_PREVIEW_LIMIT);
  assert.match(html, /data-preview-state="results"/);
  assert.match(html, /Record 1/);
  assert.match(html, /Record 2/);
  assert.match(html, /Record 3/);
  assert.doesNotMatch(html, /Record 4/);
  assert.match(html, /Preview for/);
});

test("a known topic interprets into the real first three static result records", () => {
  const interpretation = parseNL("education contracts");
  const rows = filterMoneySnapshot(moneySnapshotRows(moneySnapshot), {
    mode: "open",
    // The model-backed interpretation may retain the topic without narrowing to one agency;
    // keyword matching is the broad, production-safe preview expectation for this topic.
    agency: "",
    keyword: interpretation.keywords.join(" "),
    sort: "deadline",
    today: "2026-08-26",
    limit: 40,
  });
  const html = renderInterpretPreview({
    query: "education contracts",
    rows,
    renderRow: (row) => `<article data-request-id="${row.request_id}">${row.short_title}</article>`,
  });

  assert.equal(interpretation.agency, "Education");
  assert.deepEqual(rows.slice(0, 3).map((row) => row.request_id), [
    "20260225006",
    "20260130016",
    "20260206017",
  ]);
  assert.match(html, /Bid Extension: Requirement Contract for Water Treatment of Cooling Towers/);
  assert.match(html, /Bid Extension: Requirements Contract for Central Station Monitoring of Fire Alarm Systems/);
  assert.match(html, /REQUIREMENTS CONTRACT FOR REMOVAL AND TRANSFER OF CAFETERIA AND KITCHEN EQUIPMENT/);
});

test("interpret preview has an honest empty state", () => {
  const html = renderInterpretPreview({ rows: [], empty: "No matching records." });
  assert.match(html, /data-preview-state="empty"/);
  assert.match(html, /No matching records\./);
});

test("interpret preview has an honest unavailable state", () => {
  const html = renderInterpretPreview({ state: "error", error: "Source unavailable." });
  assert.match(html, /data-preview-state="error"/);
  assert.match(html, /Source unavailable\./);
});

test("the form-factor header slot rides along without changing the three-card bound", () => {
  const rows = [1, 2, 3, 4].map((id) => ({ id, title: `Record ${id}` }));
  const header = '<div class="interpret-preview-scopebar" data-preview-scope="all"><p class="interpret-preview-scope"><strong>All sources</strong></p></div>';
  const html = renderInterpretPreview({
    query: "parks",
    rows,
    header,
    renderRow: (row) => `<article>${row.title}</article>`,
  });
  assert.match(html, /data-preview-state="results"/);
  assert.match(html, /data-preview-scope="all"/);
  assert.match(html, /All sources/);
  assert.doesNotMatch(html, /Record 4/);

  const empty = renderInterpretPreview({ rows: [], header, empty: "No matching records." });
  assert.match(empty, /data-preview-state="empty"/);
  assert.match(empty, /data-preview-scope="all"/);

  const error = renderInterpretPreview({ state: "error", header, error: "Source unavailable." });
  assert.match(error, /data-preview-state="error"/);
  assert.match(error, /data-preview-scope="all"/);
  assert.match(error, /Source unavailable\./);
});
