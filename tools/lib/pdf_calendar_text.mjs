import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractPdfTextFromBytes } from "../../site/community_board_source_adapters.mjs";

function toUint8(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  return new Uint8Array(bytes || []);
}

export function extractPdfCalendarText(bytes) {
  const raw = toUint8(bytes);
  if (raw.length < 5 || new TextDecoder("latin1").decode(raw.slice(0, 5)) !== "%PDF-") return "";
  const dir = mkdtempSync(join(tmpdir(), "cb-pdf-calendar-"));
  try {
    const pdfPath = join(dir, "source.pdf");
    const txtPath = join(dir, "source.txt");
    writeFileSync(pdfPath, raw);
    const result = spawnSync("pdftotext", ["-layout", pdfPath, txtPath], {
      timeout: 20_000,
      encoding: "utf8",
    });
    if (result.status === 0) {
      const text = readFileSync(txtPath, "utf8");
      if (text.trim()) return text;
    }
  } catch {
    // Fall through to the byte-level extractor.
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  return extractPdfTextFromBytes(raw);
}
