/**
 * Public industry-code catalog helpers.
 *
 * NAICS is published with labels and hierarchy. NYC commodity status is a
 * numeric code/status projection only; full labels stay in ignored private
 * scratch and are never served from this module.
 */

export const NAICS_CATALOG_SCHEMA = "cityscroll.naics_catalog.v1";
export const NYC_COMMODITY_STATUS_SCHEMA = "cityscroll.nyc_commodity_status.v1";
export const CODE_CATALOG_MANIFEST_SCHEMA = "cityscroll.procurement_code_catalog_manifest.v1";
export const CODE_CATALOG_SOURCE_RECEIPT_SCHEMA = "cityscroll.code_catalog_source_receipt.v1";

export const PUBLIC_NYC_RECORD_FIELDS = Object.freeze(["code", "status"]);
export const FORBIDDEN_PUBLIC_NYC_FIELDS = Object.freeze([
  "label",
  "description",
  "parent",
  "parents",
  "industry",
  "commodity_type",
  "source_row",
  "rawbytes",
  "raw_bytes",
]);

export const RETAINED_SOURCE_DIGESTS = Object.freeze({
  "procurement-codes-naics-2022": "217c9e0d4d74e7517bc288f5f308b73aa0de5ee787976a6dd222412be28ada22",
  "procurement-codes-nyc-commodity-directory": "6325fbf06b2620ea7992c6f16da4f1f209cd1339d736f86a23b17fdec579a6b7",
});

export const EXPECTED_COUNTS = Object.freeze({
  naicsNodes: 2125,
  naicsIndustries: 1012,
  nycNumericRows: 9038,
  nycListed: 8888,
  nycInactive: 150,
  nycOmittedInternal: 3,
  nycSourceRows: 9041,
});

export const DEFAULT_ENDPOINTS = Object.freeze({
  procurementCodeCatalogs: Object.freeze({
    origin: "https://cityscroll.org",
    manifestPath: "/data/procurement_code_catalog_manifest.json",
    shardRoot: "/data/procurement_codes/",
    allowedArtifactPaths: Object.freeze([
      "/data/procurement_codes/naics-2022.json",
      "/data/procurement_codes/nyc-commodity-status.json",
    ]),
    limits: Object.freeze({
      manifestBytes: 64 * 1024,
      naicsBytes: 2 * 1024 * 1024,
      nycBytes: 512 * 1024,
      fetchTimeoutMs: 10_000,
    }),
  }),
});

const NUMERIC_NYC = /^\d{5}$/;

export function isNumericNycCode(value) {
  return typeof value === "string" && NUMERIC_NYC.test(value);
}

export function publicNaicsRecords(catalogRecords = []) {
  return catalogRecords
    .filter((row) => row?.scheme === "NAICS")
    .map((row) => ({
      scheme: row.scheme,
      version: row.version,
      code: row.code,
      label: row.label,
      level: row.level,
      status: row.status,
      parents: Array.isArray(row.parents) ? [...row.parents] : [],
      edition: row.version,
    }));
}

export function publicNycStatusRecords(catalogRecords = []) {
  return catalogRecords
    .filter((row) => row?.scheme === "NYC_COMMODITY" && row.level === 5 && isNumericNycCode(row.code))
    .map((row) => ({ code: row.code, status: row.status }));
}

export function publicProjection(catalog) {
  const naicsMeta = (catalog.catalogs || []).find((entry) => entry.scheme === "NAICS");
  const nycMeta = (catalog.catalogs || []).find((entry) => entry.scheme === "NYC_COMMODITY");
  const naicsRecords = publicNaicsRecords(catalog.records || []);
  const nycRecords = publicNycStatusRecords(catalog.records || []);
  return {
    naics: {
      schema: NAICS_CATALOG_SCHEMA,
      version: naicsMeta?.version || "2022",
      edition: naicsMeta?.version || "2022",
      source_url: naicsMeta?.url || null,
      source_sha256: naicsMeta?.sha256 || null,
      checked_at: catalog.observed_at || null,
      records: naicsRecords,
    },
    nyc: {
      schema: NYC_COMMODITY_STATUS_SCHEMA,
      version: nycMeta?.version || null,
      source_url: nycMeta?.url || null,
      source_sha256: nycMeta?.sha256 || null,
      checked_at: catalog.observed_at || null,
      source_rows: nycMeta?.data_rows ?? null,
      omitted_internal_rows: EXPECTED_COUNTS.nycOmittedInternal,
      records: nycRecords,
    },
  };
}

export function assertPublicNycPayload(value) {
  const payload = typeof value === "string" ? value : JSON.stringify(value);
  for (const field of FORBIDDEN_PUBLIC_NYC_FIELDS) {
    const pattern = new RegExp(`"${field}"\\s*:`);
    if (pattern.test(payload)) {
      throw new Error(`public NYC status payload contains forbidden field ${field}`);
    }
  }
  return true;
}

export function lookupNyc(statusArtifact, input, requestedVersion = statusArtifact?.version) {
  if (!isNumericNycCode(input)) return { status: "invalid_code" };
  if (!statusArtifact || requestedVersion !== statusArtifact.version) {
    return { status: "unknown_version" };
  }
  const row = (statusArtifact.records || []).find((entry) => entry.code === input);
  return {
    code: input,
    status: row?.status ?? "unknown",
    version: statusArtifact.version,
    source_url: statusArtifact.source_url || null,
  };
}

export function validateCatalogActivation({ manifest, artifact, scheme }) {
  if (!manifest || !Array.isArray(manifest.catalogs)) {
    throw new Error("manifest catalogs are required");
  }
  const entry = manifest.catalogs.find((row) => row.scheme === scheme);
  if (!entry) throw new Error(`manifest missing scheme ${scheme}`);
  if (!artifact || artifact.schema == null) throw new Error("artifact schema is required");
  if (Number(entry.records) !== Number((artifact.records || []).length)) {
    throw new Error(`artifact record count ${artifact.records?.length} does not match manifest ${entry.records}`);
  }
  const codes = new Set();
  for (const row of artifact.records || []) {
    if (!row?.code || codes.has(row.code)) {
      throw new Error(`artifact codes must be unique (${row?.code || "missing"})`);
    }
    codes.add(row.code);
  }
  return entry;
}
