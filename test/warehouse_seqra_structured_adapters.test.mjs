import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { withTempDirSync } from "../tools/lib/with_temp_dir.mjs";

import {
  SeqraPaginationIncompleteError,
  SeqraSchemaDriftError,
  SeqraVintageImmutableError,
  assertNoSchemaDrift,
  buildFetchReceipt,
  contentHashOf,
  paginateToCompletion,
  retainRawSnapshot,
  stableJson,
} from "../warehouse/lib/seqra_structured_adapter.mjs";
import {
  SEQRA_STRUCTURED_ADAPTER_SOURCE_IDS,
  SEQRA_STRUCTURED_ADAPTER_SOURCES,
  getStructuredAdapterSource,
} from "../warehouse/lib/seqra_structured_adapter_sources.mjs";
import { parseEnbListingPage } from "../warehouse/lib/seqra_dec_enb_notice_parser.mjs";

const ROOT = path.join(import.meta.dirname, "..");
const SCRIPT = path.join(ROOT, "tools", "build_seqra_structured_adapters.mjs");
const RECEIPT = path.join(ROOT, "warehouse", "receipts", "proof", "seqra_structured_adapters_latest.json");
const ENB_FIXTURE = path.join(
  ROOT, "warehouse", "fixtures", "seqra-adapters", "nys_dec_enb_notice_metadata", "2026-09-04-sample", "raw", "page-0000.html",
);

function run(...args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: "utf8" });
}

describe("SEQRA-03 source registry", () => {
  it("declares exactly the card's six sources with the commissioned dataset ids", () => {
    assert.equal(SEQRA_STRUCTURED_ADAPTER_SOURCE_IDS.length, 6);
    assert.equal(getStructuredAdapterSource("ceqr_projects").dataset_id, "gezn-7mgk");
    assert.equal(getStructuredAdapterSource("ceqr_project_milestones").dataset_id, "8fj8-3sgg");
    assert.equal(getStructuredAdapterSource("zap_projects").dataset_id, "hgx4-8ukb");
    assert.equal(getStructuredAdapterSource("zap_bbl").dataset_id, "2iga-a6mk");
    assert.equal(getStructuredAdapterSource("nys_dec_dart").dataset_id, "mbk7-f2r2");
    assert.equal(getStructuredAdapterSource("nys_dec_enb_notice_metadata").kind, "html_discovery");
  });

  it("throws on an unknown source id rather than returning undefined", () => {
    assert.throws(() => getStructuredAdapterSource("not_a_real_source"), /unknown SEQRA-03 adapter source/);
  });

  it("every SODA source's required fields are non-empty and unique", () => {
    for (const sourceId of SEQRA_STRUCTURED_ADAPTER_SOURCE_IDS) {
      const source = SEQRA_STRUCTURED_ADAPTER_SOURCES[sourceId];
      assert.ok(source.required_fields.length > 0, `${sourceId}: required_fields`);
      assert.equal(new Set(source.required_fields).size, source.required_fields.length, `${sourceId}: duplicate required field`);
    }
  });
});

describe("assertNoSchemaDrift", () => {
  it("passes when every required field is observed", () => {
    assert.doesNotThrow(() =>
      assertNoSchemaDrift({ sourceId: "x", requiredFields: ["a", "b"], observedFields: ["a", "b", "c"] }));
  });

  it("throws SeqraSchemaDriftError naming the missing field when a publisher drops a column (A3)", () => {
    assert.throws(
      () => assertNoSchemaDrift({ sourceId: "ceqr_projects", requiredFields: ["ceqr", "lead_agency"], observedFields: ["ceqr"] }),
      (error) => {
        assert.ok(error instanceof SeqraSchemaDriftError);
        assert.deepEqual(error.missingFields, ["lead_agency"]);
        return true;
      },
    );
  });
});

describe("paginateToCompletion", () => {
  it("walks to a natural short final page and reports pagination_complete: true", async () => {
    const pages = [[1, 2], [3, 4], [5]];
    let i = 0;
    const result = await paginateToCompletion({
      sourceId: "x", pageSize: 2, maxPages: 10,
      fetchPage: async () => ({ rows: pages[i++] }),
    });
    assert.equal(result.paginationComplete, true);
    assert.deepEqual(result.rows, [1, 2, 3, 4, 5]);
  });

  it("returns an empty, complete walk for an empty first page", async () => {
    const result = await paginateToCompletion({ sourceId: "x", pageSize: 5, maxPages: 10, fetchPage: async () => ({ rows: [] }) });
    assert.equal(result.paginationComplete, true);
    assert.deepEqual(result.rows, []);
  });

  it("throws SeqraPaginationIncompleteError rather than returning a truncated population when the cap is hit on a full page (G2)", async () => {
    await assert.rejects(
      paginateToCompletion({
        sourceId: "ceqr_projects", pageSize: 2, maxPages: 2,
        fetchPage: async () => ({ rows: [1, 2] }),
      }),
      (error) => {
        assert.ok(error instanceof SeqraPaginationIncompleteError);
        assert.equal(error.sourceId, "ceqr_projects");
        assert.equal(error.maxPages, 2);
        return true;
      },
    );
  });
});

describe("named-vintage raw snapshot immutability", () => {
  it("retaining the same bytes twice under one vintage label is a no-op that reports the same hash", () => {
    withTempDirSync("seqra03-vintage", (rootAbs) => {
      const first = retainRawSnapshot({ rootAbs, rootRel: "scratch", sourceId: "s", vintage: "v1", slug: "page-0000", text: "hello" });
      const second = retainRawSnapshot({ rootAbs, rootRel: "scratch", sourceId: "s", vintage: "v1", slug: "page-0000", text: "hello" });
      assert.equal(first.contentHash, contentHashOf("hello"));
      assert.equal(first.contentHash, second.contentHash);
      assert.equal(first.rawObjectPath, path.posix.join("scratch", "s", "v1", "page-0000.json"));
    });
  });

  it("retaining different bytes under an already-captured vintage label throws instead of overwriting (A1)", () => {
    withTempDirSync("seqra03-vintage", (rootAbs) => {
      retainRawSnapshot({ rootAbs, rootRel: "scratch", sourceId: "s", vintage: "v1", slug: "page-0000", text: "hello" });
      assert.throws(
        () => retainRawSnapshot({ rootAbs, rootRel: "scratch", sourceId: "s", vintage: "v1", slug: "page-0000", text: "goodbye" }),
        (error) => {
          assert.ok(error instanceof SeqraVintageImmutableError);
          assert.equal(error.vintage, "v1");
          return true;
        },
      );
      // The file on disk must still hold the original bytes, not the rejected write.
      const onDisk = readFileSync(path.join(rootAbs, "s", "v1", "page-0000.json"), "utf8");
      assert.equal(onDisk, "hello");
    });
  });

  it("a new vintage label for the same source never collides with an earlier one", () => {
    withTempDirSync("seqra03-vintage", (rootAbs) => {
      retainRawSnapshot({ rootAbs, rootRel: "scratch", sourceId: "s", vintage: "v1", slug: "page-0000", text: "hello" });
      assert.doesNotThrow(() =>
        retainRawSnapshot({ rootAbs, rootRel: "scratch", sourceId: "s", vintage: "v2", slug: "page-0000", text: "goodbye" }));
    });
  });
});

describe("buildFetchReceipt", () => {
  it("carries every field the commission's fetch-receipt contract requires (A2)", () => {
    const receipt = buildFetchReceipt({
      fetchId: "f1", sourceId: "s", requestedAt: "2026-01-01T00:00:00.000Z",
      requestUrlOrQuery: "https://example/x", httpStatus: 200, retrievedAt: "2026-01-01T00:00:01.000Z",
      sourceVintage: "v1", contentType: "application/json", byteCount: 3, contentHash: "sha256:x",
      rawObjectPath: "warehouse/raw/x", rowOrDocumentCount: 1, paginationComplete: true,
    });
    for (const key of [
      "fetch_id", "source_id", "requested_at", "request_url_or_query", "http_status", "retrieved_at",
      "source_vintage", "content_type", "byte_count", "content_hash", "raw_object_path",
      "row_or_document_count", "pagination_complete", "parser_version", "warnings",
    ]) {
      assert.ok(Object.hasOwn(receipt, key), `missing ${key}`);
    }
  });
});

describe("parseEnbListingPage (DEC ENB notice metadata)", () => {
  const html = readFileSync(ENB_FIXTURE, "utf8");

  it("extracts real notice metadata from the committed discovery fixture", () => {
    const result = parseEnbListingPage(html);
    assert.equal(result.total_results, 15539);
    assert.equal(result.row_block_count, 3);
    assert.equal(result.notices.length, 3);
    assert.equal(result.malformed.length, 0);
    assert.deepEqual(Object.keys(result.notices[0]).sort(), [
      "notice_type", "publish_date", "publish_date_raw", "region_or_county", "title", "url",
    ].sort());
    assert.equal(result.notices[0].notice_type, "seqr");
    assert.equal(result.notices[0].publish_date, "2026-09-02");
  });

  it("throws SeqraSchemaDriftError when the results-summary header is missing entirely (A3)", () => {
    const drifted = html.replace(/summary-results/g, "results-summary-renamed");
    assert.throws(() => parseEnbListingPage(drifted), (error) => error instanceof SeqraSchemaDriftError);
  });

  it("throws SeqraSchemaDriftError when the row marker is renamed, rather than silently returning zero notices (A3)", () => {
    const drifted = html.replace(/c-view__row/g, "c-view__renamed-row");
    assert.throws(() => parseEnbListingPage(drifted), (error) => {
      assert.ok(error instanceof SeqraSchemaDriftError);
      return true;
    });
  });

  it("throws SeqraSchemaDriftError when the declared row count no longer matches the parsed row count (A3)", () => {
    const drifted = html.replace("1 - 3 of 15539 results", "1 - 4 of 15539 results");
    assert.throws(() => parseEnbListingPage(drifted), (error) => error instanceof SeqraSchemaDriftError);
  });
});

describe("SEQRA structured-adapters CLI", () => {
  it("default mode passes the gate over the committed fixtures for all six sources", () => {
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /SEQRA structured-adapters gate OK \(\d+ checks, 6 sources\)/);
  });

  it("--check passes against the committed receipt (no drift since the last build)", () => {
    const result = run("--check");
    assert.equal(result.status, 0, result.stderr);
  });

  it("running the builder twice produces a byte-identical receipt (A1, whole-tool level)", () => {
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const firstBytes = readFileSync(RECEIPT, "utf8");

    const second = run();
    assert.equal(second.status, 0, second.stderr);
    const secondBytes = readFileSync(RECEIPT, "utf8");

    assert.equal(firstBytes, secondBytes);
  });

  it("the committed receipt asserts resident ingestion is not committed for every source (A5)", () => {
    const receipt = JSON.parse(readFileSync(RECEIPT, "utf8"));
    assert.equal(receipt.gate.resident_ingestion_committed, false);
    for (const sourceId of SEQRA_STRUCTURED_ADAPTER_SOURCE_IDS) {
      assert.equal(receipt.sources[sourceId].resident_ingestion.committed, false, sourceId);
    }
  });

  it("the committed receipt's checks include the A4 non-regression check and it passed", () => {
    const receipt = JSON.parse(readFileSync(RECEIPT, "utf8"));
    const a4 = receipt.checks.find((c) => c.name.includes("A4"));
    assert.ok(a4, "A4 check must be present");
    assert.equal(a4.result, "pass", a4.message);
  });

  it("rejects an unrecognized flag rather than silently ignoring it", () => {
    const result = run("--bogus");
    assert.notEqual(result.status, 0);
  });
});

describe("stableJson", () => {
  it("sorts object keys so two equivalent objects built in different key order hash identically", () => {
    assert.equal(stableJson({ b: 1, a: 2 }), stableJson({ a: 2, b: 1 }));
  });
});
