import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  publishProcurementDocuments,
  readProcurementDocumentPublication,
} from "../tools/publish_procurement_documents.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DATA = path.join(ROOT, "site/data");
const MANIFEST_PATH = path.join(PUBLIC_DATA, "procurement_documents.json");
const SHARD_PATH = path.join(PUBLIC_DATA, "procurement_documents/rfx-37728.json");
const SECTION_DIR_PATH = path.join(PUBLIC_DATA, "procurement_documents/rfx-37728");

function copyCommittedPublication(destination) {
  mkdirSync(path.join(destination, "procurement_documents"), { recursive: true });
  cpSync(MANIFEST_PATH, path.join(destination, "procurement_documents.json"));
  cpSync(SHARD_PATH, path.join(destination, "procurement_documents/rfx-37728.json"));
  cpSync(SECTION_DIR_PATH, path.join(destination, "procurement_documents/rfx-37728"), { recursive: true });
}

test("A1: the served manifest and shard declare matching contract bytes and rows", () => {
  const publication = readProcurementDocumentPublication(PUBLIC_DATA);
  assert.equal(publication.manifest.schema, "cityscroll.procurement_document_read_model.v1");
  assert.equal(publication.manifest.representation, "sharded");
  assert.equal(publication.shards.length, 1);
  const [{ entry, bytes, shard }] = publication.shards;
  assert.equal(entry.rfp_id, "37728");
  assert.equal(entry.bytes, bytes.length);
  assert.equal(entry.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(entry.row_count, shard.rows.length);
  assert.equal(shard.subject.rfp_id, "37728");
  assert.equal(shard.subject.bpm_id, "37402");
  assert.equal(shard.subject.round_label, "1");

  const events = shard.rows.flatMap((row) => row.events || []);
  assert.deepEqual(events.map((event) => event.local), [
    "2026-11-09T14:00:00",
    "2026-11-09T15:00:00",
  ]);
  const facts = new Map(shard.rows.flatMap((row) => row.facts || []).map((fact) => [fact.id, fact]));
  for (const id of ["bid-bond", "bid-security", "performance-bond", "payment-bond"]) {
    assert.equal(facts.get(id)?.applicability, "not_applicable", id);
  }
});

test("A2: publication copies validated bytes and leaves the shared read model untouched", () => {
  const root = mkdtempSync(path.join(tmpdir(), "procurement-document-publication-"));
  const generatedDir = path.join(root, "generated");
  const siteDataDir = path.join(root, "site/data");
  copyCommittedPublication(generatedDir);
  mkdirSync(siteDataDir, { recursive: true });
  const sharedPath = path.join(siteDataDir, "shared_procurement_read_model.json");
  const sharedBytes = Buffer.from('{"sentinel":"unchanged"}\n');
  writeFileSync(sharedPath, sharedBytes);

  try {
    const result = publishProcurementDocuments({ generatedDir, siteDataDir });
    assert.equal(result.row_count, 2);
    assert.ok(readFileSync(path.join(siteDataDir, "procurement_documents.json")).equals(readFileSync(MANIFEST_PATH)));
    assert.ok(readFileSync(path.join(siteDataDir, "procurement_documents/rfx-37728.json")).equals(readFileSync(SHARD_PATH)));
    assert.ok(readFileSync(sharedPath).equals(sharedBytes));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("A2: a missing generated shard fails before changing served output", () => {
  const root = mkdtempSync(path.join(tmpdir(), "procurement-document-publication-missing-"));
  const generatedDir = path.join(root, "generated");
  const siteDataDir = path.join(root, "site/data");
  copyCommittedPublication(generatedDir);
  mkdirSync(siteDataDir, { recursive: true });
  const destinationManifest = path.join(siteDataDir, "procurement_documents.json");
  const original = Buffer.from('{"served":"previous"}\n');
  writeFileSync(destinationManifest, original);
  rmSync(path.join(generatedDir, "procurement_documents"), { recursive: true, force: true });

  try {
    assert.throws(
      () => publishProcurementDocuments({ generatedDir, siteDataDir }),
      /missing generated output/,
    );
    assert.ok(readFileSync(destinationManifest).equals(original));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("A3: the public readback exposes its generation time and shard hash inputs", () => {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  const shardBytes = readFileSync(SHARD_PATH);
  const shard = JSON.parse(shardBytes.toString("utf8"));
  assert.match(manifest.generated_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(manifest.shards[0].path, "procurement_documents/rfx-37728.json");
  assert.equal(manifest.shards[0].sha256, createHash("sha256").update(shardBytes).digest("hex"));
  assert.ok(shard.rows.every((row) => /^[a-f0-9]{64}$/.test(row.sha256)));
});

test("A4: companion section-text index and all 13 section shards validate and cover all 237 pages", () => {
  const publication = readProcurementDocumentPublication(PUBLIC_DATA);
  const [{ sectionText }] = publication.shards;
  assert.ok(sectionText, "rfx-37728 must publish companion section-text shards");
  assert.equal(sectionText.index.schema, "cityscroll.procurement_document_section_text_index.v1");
  assert.equal(sectionText.sections.length, 13);
  const totalPages = sectionText.sections.reduce((sum, item) => sum + item.payload.pages.length, 0);
  assert.equal(totalPages, 237);

  const mwbe = sectionText.sections.find((item) => item.entry.id === "mwbe-notice");
  assert.ok(mwbe);
  assert.deepEqual(mwbe.payload.section.pdf_pages, [15, 24]);
  assert.equal(mwbe.payload.pages.length, 10);
  assert.match(mwbe.payload.pages[0].text, /PARTICIPATION BY MINORITY-OWNED/i);

  const wage = sectionText.sections.find((item) => item.entry.id === "prevailing-wage-schedule");
  assert.ok(wage);
  const highlighted = wage.payload.jumps.filter((j) => j.highlight);
  assert.ok(highlighted.some((j) => /electrician/i.test(j.label) && j.pdf_page === 164));
  assert.ok(highlighted.some((j) => /plumber/i.test(j.label) && j.pdf_page === 216));
});

test("A5: publishProcurementDocuments copies all 13 section shards and rejects a tampered section shard", () => {
  const root = mkdtempSync(path.join(tmpdir(), "procurement-section-text-pub-"));
  const generatedDir = path.join(root, "generated");
  const siteDataDir = path.join(root, "site/data");
  copyCommittedPublication(generatedDir);

  try {
    const result = publishProcurementDocuments({ generatedDir, siteDataDir });
    assert.equal(result.shards[0].section_text_count, 13);
    assert.ok(
      readFileSync(path.join(siteDataDir, "procurement_documents/rfx-37728/sections/mwbe-notice.json"))
        .equals(readFileSync(path.join(SECTION_DIR_PATH, "sections/mwbe-notice.json"))),
    );

    // Tamper with one section shard and ensure validation fails before touching destination
    const badPath = path.join(generatedDir, "procurement_documents/rfx-37728/sections/cover.json");
    writeFileSync(badPath, `${readFileSync(badPath, "utf8")} `);
    assert.throws(
      () => publishProcurementDocuments({ generatedDir, siteDataDir }),
      /bytes=.*does not match/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("A6: every published section-text page is free of PUA mojibake, replacement chars, and dot-leader/bullet noise", () => {
  const publication = readProcurementDocumentPublication(PUBLIC_DATA);
  const [{ sectionText }] = publication.shards;
  for (const item of sectionText.sections) {
    for (const pg of item.payload.pages) {
      assert.doesNotMatch(pg.text, /[\uE000-\uF8FF\uFFFD]/, `${item.entry.id} p.${pg.pdf_page} has PUA/replacement char`);
      assert.doesNotMatch(pg.text, /â€|Ã[\x80-\xbf]|Â[\xa0-\xbf]/, `${item.entry.id} p.${pg.pdf_page} has UTF-8/Latin-1 mojibake`);
      assert.doesNotMatch(pg.text, /\.{6,}/, `${item.entry.id} p.${pg.pdf_page} has raw dot-leader run`);
      assert.doesNotMatch(pg.text, /^•\n\n/m, `${item.entry.id} p.${pg.pdf_page} has orphan bullet`);
    }
  }
  const doi = sectionText.sections.find((item) => item.entry.id === "notices-whistleblower-doi");
  assert.ok(doi);
  assert.match(doi.payload.pages.at(-1).text, /• Any employee of a contractor/);
});

test("A7: parser hardening flags scanned attachments, preserves statute/compound hyphens, strips running headers, and builds clean jumps", () => {
  const publication = readProcurementDocumentPublication(PUBLIC_DATA);
  const [{ sectionText }] = publication.shards;
  const byId = new Map(sectionText.sections.map((item) => [item.entry.id, item.payload]));

  // #1: Scanned image pages 65-66 (Attachment A & B) are explicitly flagged ocr_required
  const gs = byId.get("general-specifications");
  const ocrPages = gs.pages.filter((pg) => pg.ocr_required).map((pg) => pg.pdf_page);
  assert.deepEqual(ocrPages, [65, 66]);

  // #2: Real hyphens in legal statutes and compound words are preserved (never swallowed)
  const allText = sectionText.sections.flatMap((s) => s.payload.pages.map((pg) => pg.text)).join("\n");
  assert.match(allText, /Section 6-129/);
  assert.doesNotMatch(allText, /Section 6129|minorityowned|NONRESPONSIVE|30day|antiretaliation/);

  // #3: Clean jump chips (no bogus .pdf root bookmark on cover; real titles on agreement/gen specs/mwbe)
  assert.equal(byId.get("cover").jumps.length, 0);
  assert.ok(byId.get("agreement").jumps.some((j) => j.label === "ARTICLE 1 — THE CONTRACT"));
  assert.ok(byId.get("general-specifications").jumps.some((j) => /Article 2 — CONTRACTOR/i.test(j.label)));
  assert.ok(byId.get("mwbe-notice").jumps.every((j) => !/^Section 6 — 129/.test(j.label)));

  // #4: Tabular sections preserve column layout
  assert.equal(byId.get("schedule-a-reference").layout_mode, "tabular");
  assert.equal(byId.get("schedule-a-insurance").layout_mode, "tabular");

  // #6: Repeated running headers are hoisted and stripped from body pages
  assert.ok(byId.get("mwbe-notice").running_headers.includes("PIN # 84627B0012"));
  assert.ok(byId.get("prevailing-wage-schedule").running_headers.includes("OFFICE OF THE COMPTROLLER, CITY OF NEW YORK"));
  assert.doesNotMatch(byId.get("mwbe-notice").pages[0].text, /^PIN # 84627B0012/m);
});
