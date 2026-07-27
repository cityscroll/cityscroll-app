import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { inflateRawSync } from "node:zlib";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const i18n = readFileSync(new URL("../i18n.js", import.meta.url), "utf8");
const {
  excelSafeCsv,
  buildListWorkbook,
  buildNoticeWorkbook,
} = require("../export_workflows.js");

function zipEntries(bytes) {
  const data = Buffer.from(bytes);
  const entries = new Map();
  let offset = 0;
  while (offset + 30 <= data.length && data.readUInt32LE(offset) === 0x04034b50) {
    const method = data.readUInt16LE(offset + 8);
    const packed = data.readUInt32LE(offset + 18);
    const nameLength = data.readUInt16LE(offset + 26);
    const extraLength = data.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const bodyStart = nameStart + nameLength + extraLength;
    const name = data.subarray(nameStart, nameStart + nameLength).toString("utf8");
    const body = data.subarray(bodyStart, bodyStart + packed);
    assert.ok(method === 0 || method === 8, `unsupported ZIP method ${method}`);
    entries.set(name, method === 8 ? inflateRawSync(body) : body);
    offset = bodyStart + packed;
  }
  return entries;
}

test("the shared CSV serializer preserves Excel-safe bytes and fixture values", () => {
  const csv = excelSafeCsv(
    [
      { label: "ID", value: row => row.id },
      { label: "Title", value: row => row.title },
      { label: "Amount", value: row => row.amount },
      { label: "Date", value: row => row.date },
    ],
    [
      { id: "001234", title: "社区中心", amount: 1250.5, date: "2026-07-27" },
      { id: "AR-7", title: "اجتماع عام", amount: 0, date: "2026-08-03" },
    ],
  );

  assert.ok(csv.startsWith("\uFEFF"), "UTF-8 BOM must be first");
  assert.ok(csv.includes("\r\n"), "rows must use CRLF");
  assert.ok(!/(?<!\r)\n/.test(csv), "no bare LF line endings");
  assert.match(csv, /"001234"/);
  assert.match(csv, /"社区中心"/);
  assert.match(csv, /"اجتماع عام"/);
  assert.match(csv, /"1250\.5"/);
});

test("the notice workbook carries typed dates and amounts on separate sheets", () => {
  const workbook = buildNoticeWorkbook(
    {
      request_id: "001234",
      type_of_notice_description: "Award",
      agency_name: "Department of Community Affairs",
      short_title: "社区中心",
      start_date: "2026-07-27T00:00:00.000",
      due_date: "2026-08-03T00:00:00.000",
      contract_amount: "1250.50",
      pin: "000077",
      vendor_name: "Acme LLC",
    },
    [{
      request_id: "AR-7",
      type_of_notice_description: "Intent to Award",
      start_date: "2026-07-20T00:00:00.000",
      contract_amount: "900.25",
      vendor_name: "مؤسسة أكمي",
      pin: "000077",
    }],
    row => `https://example.test/#notice/${row.request_id}`,
  );
  const entries = zipEntries(workbook);

  for (const name of [
    "[Content_Types].xml",
    "_rels/.rels",
    "xl/workbook.xml",
    "xl/styles.xml",
    "xl/worksheets/sheet1.xml",
    "xl/worksheets/sheet2.xml",
  ]) {
    assert.ok(entries.has(name), `workbook must contain ${name}`);
  }

  const book = entries.get("xl/workbook.xml").toString("utf8");
  const styles = entries.get("xl/styles.xml").toString("utf8");
  const notice = entries.get("xl/worksheets/sheet1.xml").toString("utf8");
  const trail = entries.get("xl/worksheets/sheet2.xml").toString("utf8");
  assert.match(book, /name="Notice"/);
  assert.match(book, /name="Contract trail"/);
  assert.match(styles, /numFmtId="14"/);
  assert.match(notice, /<c r="E2" s="1"><v>\d+(?:\.\d+)?<\/v><\/c>/);
  assert.match(notice, /<c r="F2" s="1"><v>\d+(?:\.\d+)?<\/v><\/c>/);
  assert.match(notice, /<c r="G2"><v>1250\.5<\/v><\/c>/);
  assert.match(trail, /<c r="C2" s="1"><v>\d+(?:\.\d+)?<\/v><\/c>/);
  assert.match(trail, /<c r="D2"><v>900\.25<\/v><\/c>/);
  assert.match(notice, /<t(?: [^>]*)?>001234<\/t>/);
  assert.match(trail, /<t(?: [^>]*)?>مؤسسة أكمي<\/t>/);
});

test("a list workbook carries typed dates, amounts, and non-ASCII text on one sheet", () => {
  const workbook = buildListWorkbook(
    "Money",
    [
      { label: "Title", value: row => row.title, width: 40 },
      { label: "Posted", value: row => row.posted, type: "date", width: 13 },
      { label: "Amount", value: row => row.amount, type: "number", width: 16 },
    ],
    [{ title: "社区中心翻新服务", posted: "2026-07-27T00:00:00.000", amount: "1250.50" }],
  );
  const entries = zipEntries(workbook);
  const book = entries.get("xl/workbook.xml").toString("utf8");
  const sheet = entries.get("xl/worksheets/sheet1.xml").toString("utf8");

  assert.equal([...entries.keys()].filter(name => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).length, 1);
  assert.match(book, /name="Money"/);
  assert.match(sheet, /<t(?: [^>]*)?>社区中心翻新服务<\/t>/);
  assert.match(sheet, /<c r="B2" s="1"><v>\d+(?:\.\d+)?<\/v><\/c>/);
  assert.match(sheet, /<c r="C2"><v>1250\.5<\/v><\/c>/);
});

test("every export-worthy lens exposes CSV, Excel, and print controls at the target size", () => {
  for (const lens of ["money", "people", "land", "property", "rules", "meetings"]) {
    assert.match(source, new RegExp(`data-export-csv="${lens}"`));
    assert.match(source, new RegExp(`data-export-xlsx="${lens}"`));
    assert.match(source, new RegExp(`data-print-view="${lens}"`));
  }
  assert.match(source, /\.export-control[^}]*min-height:\s*44px/s);
  assert.match(source, /\.export-control[^}]*min-width:\s*44px/s);
  assert.match(source, /window\.print\(\)/);
});

test("print media keeps provenance and removes site chrome", () => {
  assert.match(source, /@media print/);
  assert.match(source, /body::before[\s\S]*attr\(data-print-meta\)/);
  assert.match(source, /header\.masthead[\s\S]*display:\s*none/);
  assert.match(source, /\.tabpane:not\(\.active\)[\s\S]*display:\s*none/);
  assert.match(source, /data-print-meta/);
});

test("new export strings are present in English and every shipping language", () => {
  for (const key of ["export_csv", "export_xlsx", "print_save_pdf"]) {
    assert.match(i18n, new RegExp(`\\b${key}:`), `English must define ${key}`);
    for (const lang of ["es", "zh-Hans", "ru", "bn", "ht", "ko", "fr", "pl", "ar", "ur"]) {
      const translated = readFileSync(new URL(`../i18n/lang/${lang}.js`, import.meta.url), "utf8");
      assert.match(translated, new RegExp(`\\b${key}:`), `${lang} must define ${key}`);
    }
  }
});
