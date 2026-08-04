import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import {
  attachmentTablesForHaystack,
  classifyAttachmentForTables,
  mergeHaystackWithAttachmentTables,
  normalizeExtractedTables,
  previewFromTables,
  recommendTableStorage,
  stampAttachmentTables,
  TABLE_PROVENANCE,
  tablesToSearchText,
} from "../warehouse/lib/attachment_tables.mjs";
import { mergeHaystackWithAttachmentText, TEXT_PROVENANCE } from "../warehouse/lib/attachment_text.mjs";
import { SITE_SOURCE } from "./helpers/site_source.mjs";

const fixtureDocx = new URL(
  "../warehouse/fixtures/attachment_binaries/37470-cannonsville.docx",
  import.meta.url,
);
const extractor = new URL("../warehouse/lib/attachment_tables_extract.py", import.meta.url);
const runner = readFileSync(new URL("../warehouse/scripts/attachment_tables_run.py", import.meta.url), "utf8");
const workflow = readFileSync(new URL("../.github/workflows/attachment-metadata.yml", import.meta.url), "utf8");
const storageAdr = readFileSync(new URL("../docs/adr/attachment-tables-storage.md", import.meta.url), "utf8");
const lookup = JSON.parse(readFileSync(new URL("../site/data/attachment_metadata_lookup.json", import.meta.url), "utf8"));

test("T2 reuses T1 office-class eligibility", () => {
  assert.equal(
    classifyAttachmentForTables({
      content_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }).class,
    "docx",
  );
  assert.equal(classifyAttachmentForTables({ title: "volume report.pdf" }).class, "pdf");
  assert.equal(classifyAttachmentForTables({ content_type: "application/msword" }).eligible, false);
});

test("T2 extracts Cannonsville volume + stand tables from the docx fixture", () => {
  assert.ok(existsSync(fixtureDocx));
  const result = spawnSync("python3", [extractor.pathname, fixtureDocx.pathname, "--kind", "docx"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, "ok");
  assert.equal(payload.tables.length, 2);
  assert.deepEqual(payload.tables[0].headers.slice(0, 2), ["Species", "Sawtimber (MBF)"]);
  assert.equal(payload.tables[0].rows[0][0], "Red Oak");
  assert.match(payload.tables[0].rows[0][1], /91\.6/);
  assert.equal(payload.tables[1].headers[0], "Stand");
  assert.match(JSON.stringify(payload.tables[1].rows), /Shelterwood/);
});

test("T2 normalizes tables and builds progressive-disclosure preview", () => {
  const tables = normalizeExtractedTables([
    {
      headers: ["Species", "MBF"],
      rows: [["Red Oak", "91.6"], ["Total", "187.0"]],
      method: "docx_tbl",
    },
  ]);
  assert.equal(tables.length, 1);
  assert.equal(tables[0].n_cols, 2);
  const preview = previewFromTables(tables);
  assert.match(preview, /Species/);
  assert.match(preview, /Red Oak/);
});

test("T2 stamps rows and feeds haystack with attachment-tables provenance", () => {
  const stamped = stampAttachmentTables(
    {
      request_id: "20240515016",
      document_id: "37470",
      url: "https://a856-cityrecord.nyc.gov/Search/GetFile?documentId=37470",
      content_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      source: "portal",
    },
    {
      status: "ok",
      method: "docx_tbl",
      tables: [{
        headers: ["Species", "Sawtimber (MBF)"],
        rows: [["Red Oak", "91.6"]],
        method: "docx_tbl",
      }],
    },
  );
  assert.equal(stamped.tables_status, "ok");
  assert.equal(stamped.tables_count, 1);
  assert.match(stamped.tables_preview, /Red Oak/);
  const hay = attachmentTablesForHaystack([stamped]);
  assert.match(hay, new RegExp(`\\[${TABLE_PROVENANCE}\\]`));
  assert.match(hay, /red oak/);
  assert.match(tablesToSearchText(stamped.extracted_tables), /91\.6/);
});

test("T2 haystack merge coexists with T1 attachment-text without stacking markers", () => {
  const withTables = [{
    extracted_tables: [{ headers: ["Stand", "Acres"], rows: [["1", "28"]], method: "docx_tbl" }],
  }];
  const withText = [{ extracted_text: "187 MBF sawtimber Cannonsville" }];
  let hay = mergeHaystackWithAttachmentText("timber sale", withText);
  hay = mergeHaystackWithAttachmentTables(hay, withTables);
  assert.match(hay, /\[attachment-text\]/);
  assert.match(hay, /\[attachment-tables\]/);
  assert.match(hay, /187 mbf/i);
  assert.match(hay, /stand/);
  const again = mergeHaystackWithAttachmentTables(hay, withTables);
  assert.equal((again.match(/\[attachment-tables\]/g) || []).length, 1);
});

test("storage judgment prefers JSON at current corpus scale and documents parquet threshold", () => {
  const now = recommendTableStorage({
    docsWithTables: 1,
    totalTables: 2,
    totalCells: 58,
    payloadBytes: 2_000,
  });
  assert.equal(now.format, "json");
  assert.ok(now.reasons.includes("corpus_small"));
  const later = recommendTableStorage({
    docsWithTables: 600,
    totalTables: 3_000,
    payloadBytes: 6_000_000,
    needsCrossDocSql: true,
  });
  assert.equal(later.format, "parquet+duckdb");
  assert.match(storageAdr, /JSON now/i);
  assert.match(storageAdr, /docs_with_tables ≥ 500/);
  assert.match(storageAdr, /parquet/i);
});

test("warehouse runner keeps lock, headroom, JSON materialization, and batch caps", () => {
  assert.match(runner, /IngestLock/);
  assert.match(runner, /check_headroom/);
  assert.match(runner, /attachment_tables_by_notice/);
  assert.match(runner, /format.*json|json_jsonl|JSON/);
  assert.match(runner, /--limit/);
  assert.doesNotMatch(runner, /write_parquet|to_parquet/);
});

test("scheduled attachment jobs run T2 after T1", () => {
  assert.match(workflow, /attachment_metadata_run\.py/);
  assert.match(workflow, /attachment_text_run\.py/);
  assert.match(workflow, /attachment_tables_run\.py/);
  assert.match(workflow, /--limit 25/);
});

test("notice chrome exposes progressive attachment table disclosure", () => {
  // Table HTML lives in a deferred module (off home cold path); alerts only hosts + dynamic-imports.
  const tablesUi = readFileSync(new URL("../site/attachment_tables_ui.mjs", import.meta.url), "utf8");
  assert.match(tablesUi, /export function attachmentTablesHTML/);
  assert.match(tablesUi, /class="[^"]*attachment-tables/);
  assert.match(tablesUi, /attachment-table/);
  assert.match(tablesUi, /notice_attachment_tables_summary/);
  assert.match(tablesUi, /export function bindAttachmentTableSort/);
  assert.match(SITE_SOURCE, /attachment-tables-host|attachmentTablesHTMLFor/);
  assert.match(SITE_SOURCE, /import\("\.\.\/attachment_tables_ui\.mjs"\)/);
  const cannonsville = lookup.notices["20240515016"][0];
  assert.equal(cannonsville.tables_status, "ok");
  assert.equal(cannonsville.tables_count, 2);
  assert.equal(cannonsville.extracted_tables[0].headers[0], "Species");
  assert.equal(cannonsville.extracted_tables[0].rows[0][0], "Red Oak");
  assert.match(cannonsville.extracted_tables[1].rows[0][4] || "", /Shelterwood/);
  // T1 text remains on the same golden notice.
  assert.equal(cannonsville.text_status, "ok");
  assert.match(cannonsville.extracted_text, /187 MBF/);
});

test("PDF table path is honest about text-layer limits (no OCR)", () => {
  const extractSrc = readFileSync(extractor, "utf8");
  assert.match(extractSrc, /No OCR/);
  assert.match(extractSrc, /pdf_text_layer_rows|pdf_table_structure_unrecoverable/);
  assert.doesNotMatch(extractSrc, /pytesseract|easyocr|ocrmypdf/i);
});
