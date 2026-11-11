import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { acquireFirstClassCalendar } from "../tools/acquire_first_class_calendar.mjs";
import {
  CODE_CATALOG_SOURCE_RECEIPT_SCHEMA,
  EXPECTED_COUNTS,
} from "../site/procurement_code_catalog.mjs";
import {
  GOVERNMENT_REFRESH_BOUNDS,
  GOVERNMENT_SOURCE_DEFINITIONS,
  captureGovernmentSourceBytes,
} from "../site/government_observation_refresh.mjs";
import {
  ALLOWED_KIND,
  contractIdentifier,
  validateSourceContractFixtures,
  validateSourceContracts,
} from "../tools/source_contracts.mjs";

const asOf = "2026-11-11T12:00:00.000Z";
const PK_XLSX = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00]);

const response = (status, bodyBytes, headers = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: {
    get: (name) => headers[name.toLowerCase()] || null,
  },
  async arrayBuffer() {
    return bodyBytes.buffer.slice(
      bodyBytes.byteOffset,
      bodyBytes.byteOffset + bodyBytes.byteLength,
    );
  },
});

function codeCatalogSources() {
  return GOVERNMENT_SOURCE_DEFINITIONS.filter((source) =>
    source.id.startsWith("procurement-codes-"),
  );
}

test("registers the two industry-code workbook sources with weekly cadence and xlsx accept", () => {
  const sources = codeCatalogSources();
  assert.deepEqual(
    sources.map((source) => source.id),
    ["procurement-codes-naics-2022", "procurement-codes-nyc-commodity-directory"],
  );
  assert.ok(sources.every((source) => source.cadenceHours === 168));
  assert.ok(sources.every((source) => source.accept.includes("spreadsheetml")));
  assert.ok(sources.every((source) => source.receiptSchema === CODE_CATALOG_SOURCE_RECEIPT_SCHEMA));
  assert.equal(GOVERNMENT_REFRESH_BOUNDS.maxResponseBytes, 5 * 1024 * 1024);
});

test("xlsx capture uses twenty-second timeout, five-MiB stream bound, and two retries", async () => {
  const source = codeCatalogSources()[0];
  let attempts = 0;
  const capture = await captureGovernmentSourceBytes(source.id, {
    asOf,
    fetchImpl: async (url, init) => {
      attempts += 1;
      assert.equal(url, source.url);
      assert.equal(init.headers.Accept, source.accept);
      assert.ok(init.signal);
      if (attempts < 2) throw new Error("transient");
      return response(200, PK_XLSX, { etag: "xlsx-etag" });
    },
  });
  assert.equal(attempts, 2);
  assert.equal(capture.receipt.schema, CODE_CATALOG_SOURCE_RECEIPT_SCHEMA);
  assert.equal(capture.receipt.bytes, PK_XLSX.byteLength);
  assert.equal(capture.receipt.fetch_status, "snapshot");
  assert.match(capture.receipt.source_revision, /^[0-9a-f]{64}$/);
  assert.equal(capture.receipt.acquired_at, asOf);
  assert.equal(capture.receipt.checked_at, asOf);
});

test("304 with matching retained bytes preserves acquired_at and updates checked_at", async () => {
  const source = codeCatalogSources()[0];
  const priorBytes = PK_XLSX;
  const priorDigest = (
    await captureGovernmentSourceBytes(source.id, {
      asOf: "2026-11-01T00:00:00.000Z",
      fetchImpl: async () => response(200, priorBytes, { etag: "etag-1" }),
    })
  ).receipt.source_revision;

  const capture = await captureGovernmentSourceBytes(source.id, {
    asOf,
    previous: {
      bytes: priorBytes,
      receipt: {
        etag: "etag-1",
        source_revision: priorDigest,
        acquired_at: "2026-11-01T00:00:00.000Z",
        observed_at: "2026-11-01T00:00:00.000Z",
        checked_at: "2026-11-01T00:00:00.000Z",
      },
    },
    fetchImpl: async (_url, init) => {
      assert.equal(init.headers["If-None-Match"], "etag-1");
      return response(304, new Uint8Array(), {});
    },
  });
  assert.equal(capture.receipt.fetch_status, "not_modified");
  assert.equal(capture.receipt.source_revision, priorDigest);
  assert.equal(capture.receipt.acquired_at, "2026-11-01T00:00:00.000Z");
  assert.equal(capture.receipt.checked_at, asOf);
  assert.deepEqual(capture.bytes, priorBytes);
});

test("304 without retained bytes falls back to unconditional fetch", async () => {
  const source = codeCatalogSources()[1];
  let urls = [];
  const capture = await captureGovernmentSourceBytes(source.id, {
    asOf,
    previous: {
      receipt: { etag: "stale", source_revision: "deadbeef" },
    },
    fetchImpl: async (url, init) => {
      urls.push({ url, hasConditional: Boolean(init.headers["If-None-Match"]) });
      if (init.headers["If-None-Match"]) return response(304, new Uint8Array(), {});
      return response(200, PK_XLSX, { etag: "fresh" });
    },
  });
  assert.equal(urls.length, 2);
  assert.equal(urls[0].hasConditional, true);
  assert.equal(urls[1].hasConditional, false);
  assert.equal(capture.receipt.fetch_status, "snapshot");
  assert.equal(capture.bytes.byteLength, PK_XLSX.byteLength);
});

test("acquire writer keeps last-good bytes when a later download fails", async () => {
  const directory = mkdtempSync(join(tmpdir(), "code-catalog-acquire-"));
  const capturePath = join(directory, "naics-2022.xlsx");
  const receiptPath = join(directory, "naics-2022.receipt.json");
  const source = codeCatalogSources()[0];
  try {
    await acquireFirstClassCalendar({
      sourceId: source.id,
      capturePath,
      receiptPath,
      asOf: "2026-11-01T00:00:00.000Z",
      fetchImpl: async () => response(200, PK_XLSX, { etag: "one" }),
    });
    const before = readFileSync(capturePath);
    await assert.rejects(
      () =>
        acquireFirstClassCalendar({
          sourceId: source.id,
          capturePath,
          receiptPath,
          asOf,
          fetchImpl: async () => {
            throw new Error("publisher offline");
          },
        }),
      /publisher offline|request failed|acquisition/,
    );
    assert.deepEqual(readFileSync(capturePath), before);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    assert.equal(receipt.source_revision.length, 64);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("xlsx is an allowed source-contract kind with identifier and fixture shape support", () => {
  assert.equal(ALLOWED_KIND.has("xlsx"), true);
  const contracts = [
    {
      id: "procurement-codes-naics-2022",
      name: "NAICS 2022 structure",
      owner: "US Census Bureau",
      status: "live",
      scope: "warehouse",
      kind: "xlsx",
      landing_page: "https://www.census.gov/naics/",
      endpoint:
        "https://www.census.gov/naics/2022NAICS/2022_NAICS_Structure.xlsx",
      required_fields: ["code", "label", "level"],
      publisher_cadence: "Edition replacement",
      product_freshness: "Weekly check against the official workbook digest.",
      used_for: "Industry code lookup and validation.",
      delivery_tier: "inline-at-build",
      code_references: [{ path: "tools/build_procurement_code_catalog.py", contains: "build_naics" }],
      freshness_contract: {
        mode: "periodic",
        max_stale_days: 30,
        clock_basis: "checked_acquired",
        serving_max_age_days: 90,
        serve_contract_id: null,
        acquisition_cadence_days: 7,
      },
      health_policy: {
        public_visibility: "public",
        backstage_detail: "receipts-and-errors",
        relationship_coverage: "separate",
      },
    },
  ];
  const errors = validateSourceContracts({ schema_version: 1, contracts });
  assert.deepEqual(errors, []);
  assert.equal(
    contractIdentifier(contracts[0]),
    "naics/2022NAICS/2022_NAICS_Structure.xlsx",
  );
  const fixtureErrors = validateSourceContractFixtures(
    { schema_version: 1, contracts },
    {
      schema_version: 1,
      observed_on: "2026-11-11",
      sources: [
        {
          id: "procurement-codes-naics-2022",
          kind: "xlsx",
          identifier: "naics/2022NAICS/2022_NAICS_Structure.xlsx",
          response_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          fields: ["code", "label", "level"],
          headers: ["Code", "Title"],
        },
      ],
    },
  );
  assert.deepEqual(fixtureErrors, []);
});

test("expected public counts remain available to refresh consumers", () => {
  assert.equal(EXPECTED_COUNTS.naicsNodes, 2125);
  assert.equal(EXPECTED_COUNTS.nycNumericRows, 9038);
  assert.equal(
    EXPECTED_COUNTS.nycListed + EXPECTED_COUNTS.nycInactive + EXPECTED_COUNTS.nycOmittedInternal,
    EXPECTED_COUNTS.nycSourceRows,
  );
});
