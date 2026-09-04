import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { fetchAndStoreDocument, documentRawObjectPath } from "../warehouse/lib/seqra_document_fetcher.mjs";
import { sha256Hex } from "../warehouse/lib/seqra_fetch_receipt.mjs";

function fakeHeaders(map) {
  return { get: (key) => map[key.toLowerCase()] ?? null };
}

describe("seqra_document_fetcher", () => {
  it("computes the same content-addressed path for byte-identical content", () => {
    const bytes = Buffer.from("%PDF-1.4 fake pdf bytes");
    const a = documentRawObjectPath({ bytes, extension: "pdf" });
    const b = documentRawObjectPath({ bytes, extension: "pdf" });
    assert.equal(a.relPath, b.relPath);
    assert.equal(a.hex, sha256Hex(bytes));
  });

  it("stores fetched bytes content-addressed and returns a fetch receipt whose content_hash matches the stored file", async () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), "seqra04-fetcher-"));
    try {
      const bytes = Buffer.from("%PDF-1.4 a small fixture pdf body");
      const httpGet = async () => ({ status: 200, headers: fakeHeaders({ "content-type": "application/pdf" }), bytes });
      const result = await fetchAndStoreDocument({
        url: "https://a002-ceqraccess.nyc.gov/ceqr/document/1",
        httpGet,
        projectRoot,
        fetchId: "seqra04-doc-fetch-0001",
      });
      assert.equal(result.ok, true);
      assert.equal(result.contentHash, `sha256:${sha256Hex(bytes)}`);
      const storedAbsPath = path.join(projectRoot, result.rawObjectPath);
      assert.ok(existsSync(storedAbsPath));
      assert.deepEqual(readFileSync(storedAbsPath), bytes);
      assert.equal(result.fetchReceipt.content_hash, result.contentHash);
      assert.equal(result.fetchReceipt.raw_object_path, result.rawObjectPath);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("records a receipt (never throws) when the request fails, with no raw_object_path", async () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), "seqra04-fetcher-"));
    try {
      const httpGet = async () => { throw new Error("ECONNRESET"); };
      const result = await fetchAndStoreDocument({ url: "https://a002-ceqraccess.nyc.gov/ceqr/document/broken", httpGet, projectRoot, fetchId: "seqra04-doc-fetch-0002" });
      assert.equal(result.ok, false);
      assert.equal(result.bytes, null);
      assert.equal(result.fetchReceipt.raw_object_path, null);
      assert.ok(result.fetchReceipt.warnings.some((w) => w.includes("ECONNRESET")));
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("re-fetching byte-identical content writes to the same content-addressed path (deduped, not duplicated)", async () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), "seqra04-fetcher-"));
    try {
      const bytes = Buffer.from("%PDF-1.4 identical bytes twice");
      const httpGet = async () => ({ status: 200, headers: fakeHeaders({ "content-type": "application/pdf" }), bytes });
      const first = await fetchAndStoreDocument({ url: "https://example.com/a", httpGet, projectRoot, fetchId: "fetch-a" });
      const second = await fetchAndStoreDocument({ url: "https://example.com/b-mirrors-a", httpGet, projectRoot, fetchId: "fetch-b" });
      assert.equal(first.rawObjectPath, second.rawObjectPath);
      assert.equal(first.contentHash, second.contentHash);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
