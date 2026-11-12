/**
 * Public industry-code catalog helpers.
 *
 * NAICS is published with labels and hierarchy. NYC commodity status is a
 * numeric code/status projection only; full labels stay in ignored private
 * scratch and are never served from this module. NYC commodity categories
 * publish the City's own L1-L3 category labels; each L5 code carries only its
 * code, status and L1-L3 parent codes, never its (NIGP) description.
 */

export const NAICS_CATALOG_SCHEMA = "cityscroll.naics_catalog.v1";
export const NYC_COMMODITY_STATUS_SCHEMA = "cityscroll.nyc_commodity_status.v1";
export const NYC_COMMODITY_CATEGORIES_SCHEMA = "cityscroll.nyc_commodity_categories.v1";
export const NYC_COMMODITY_L3_INDEX_SCHEMA = "cityscroll.nyc_commodity_l3_index.v1";
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

export const PUBLIC_NYC_CATEGORY_CODE_FIELDS = Object.freeze(["code", "status", "l1", "l2", "l3"]);
export const PUBLIC_NYC_CATEGORY_FIELDS = Object.freeze(["code", "label", "level", "parents"]);

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
  nycCategoryL1: 6,
  nycCategoryL2: 53,
  nycCategoryL3: 404,
});

export const DEFAULT_ENDPOINTS = Object.freeze({
  procurementCodeCatalogs: Object.freeze({
    origin: "https://cityscroll.org",
    manifestPath: "/data/procurement_code_catalog_manifest.json",
    shardRoot: "/data/procurement_codes/",
    allowedArtifactPaths: Object.freeze([
      "/data/procurement_codes/naics-2022.json",
      "/data/procurement_codes/nyc-commodity-status.json",
      "/data/procurement_codes/nyc-commodity-categories.json",
    ]),
    limits: Object.freeze({
      manifestBytes: 64 * 1024,
      naicsBytes: 2 * 1024 * 1024,
      nycBytes: 512 * 1024,
      nycCategoriesBytes: 1024 * 1024,
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

const sameFields = (row, fields) => {
  const keys = Object.keys(row || {}).sort();
  const want = [...fields].sort();
  return keys.length === want.length && keys.every((key, index) => key === want[index]);
};

/**
 * Refuse a categories payload that could carry L5 description text: every code row has
 * exactly code/status/l1/l2/l3, no forbidden status-artifact field appears on a code row,
 * and every category is an L1-L3 row. With `l5Descriptions` (private builder input or a
 * test), no string value anywhere may equal an L5 description unless that same text is a
 * City L1-L3 label (`categoryLabels`, from the workbook's L1-L3 columns; defaults to the
 * artifact's own category labels).
 */
export function assertPublicNycCategoriesPayload(value, { l5Descriptions = null, categoryLabels = null } = {}) {
  const artifact = typeof value === "string" ? JSON.parse(value) : value;
  if (artifact?.schema !== NYC_COMMODITY_CATEGORIES_SCHEMA) {
    throw new Error(`unexpected NYC categories schema ${artifact?.schema}`);
  }
  for (const row of artifact.codes || []) {
    for (const field of FORBIDDEN_PUBLIC_NYC_FIELDS) {
      if (Object.hasOwn(row || {}, field)) {
        throw new Error(`public NYC categories code ${row?.code} contains forbidden field ${field}`);
      }
    }
    if (!sameFields(row, PUBLIC_NYC_CATEGORY_CODE_FIELDS) || !isNumericNycCode(row.code)) {
      throw new Error(`public NYC categories code row ${row?.code} is not code/status/l1/l2/l3`);
    }
  }
  const labels = new Set();
  for (const row of artifact.categories || []) {
    if (!sameFields(row, PUBLIC_NYC_CATEGORY_FIELDS) || ![1, 2, 3].includes(row.level)) {
      throw new Error(`public NYC category ${row?.code} is not an L1-L3 category row`);
    }
    labels.add(row.label);
  }
  if (l5Descriptions) {
    const allowed = categoryLabels ? new Set(categoryLabels) : labels;
    const priv = new Set([...l5Descriptions].filter((text) => text && !allowed.has(text)));
    const stack = [artifact];
    while (stack.length) {
      const item = stack.pop();
      if (typeof item === "string") {
        if (priv.has(item)) throw new Error(`public NYC categories payload contains an L5 description: ${item}`);
      } else if (item && typeof item === "object") {
        stack.push(...Object.values(item));
      }
    }
  }
  return true;
}

/** Exact-match key for category labels: NFKC, whitespace collapsed, trimmed, lower-cased. */
export function normalizeCommodityLabel(value) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Index the published L3 categories by normalized label. A label that normalizes to the
 * same key as another L3 label makes label resolution ambiguous, so the index refuses it.
 */
export function buildCommodityCategoryIndex(artifact) {
  let rows;
  if (artifact?.schema === NYC_COMMODITY_L3_INDEX_SCHEMA) {
    rows = (artifact.categories || []).map((row) => ({ ...row, level: 3 }));
    if (rows.some((row) => !row.code || !Array.isArray(row.parents) || row.parents.length !== 2)) {
      throw new Error("NYC L3 index rows need code, label and two parents");
    }
  } else {
    assertPublicNycCategoriesPayload(artifact);
    rows = artifact.categories;
  }
  const byLabel = new Map();
  for (const row of rows) {
    if (row.level !== 3) continue;
    const key = normalizeCommodityLabel(row.label);
    if (!key) throw new Error(`NYC L3 category ${row.code} has an empty label`);
    if (byLabel.has(key)) {
      throw new Error(`duplicate NYC L3 category label "${row.label}" (${byLabel.get(key).code} and ${row.code})`);
    }
    byLabel.set(key, row);
  }
  if (byLabel.size !== EXPECTED_COUNTS.nycCategoryL3) {
    throw new Error(`NYC L3 category count ${byLabel.size} != ${EXPECTED_COUNTS.nycCategoryL3}`);
  }
  return Object.freeze({ version: artifact.version, byLabel });
}

/**
 * The L3 rows of the public categories artifact, for bundling where the whole artifact
 * (with its 9,038 code rows) would be too large: the Worker resolves labels from this.
 */
export function projectL3CategoryIndex(artifact, artifactSha256) {
  assertPublicNycCategoriesPayload(artifact);
  return {
    schema: NYC_COMMODITY_L3_INDEX_SCHEMA,
    version: artifact.version,
    source_sha256: artifact.source_sha256,
    categories_path: "/data/procurement_codes/nyc-commodity-categories.json",
    categories_sha256: artifactSha256,
    match_rule: artifact.match_rule,
    categories: artifact.categories
      .filter((row) => row.level === 3)
      .map((row) => ({ code: row.code, label: row.label, parents: [...row.parents] })),
  };
}

/**
 * Resolve a publisher category label (PASSPort RFx main_commodity) to its NYC L3 category.
 * Exact normalized label only: no fuzzy match, no guess. An unmatched label keeps the raw
 * text; an absent label says so.
 */
export function resolveCommodityCategory(rawLabel, index) {
  const raw = rawLabel == null ? "" : String(rawLabel);
  if (!normalizeCommodityLabel(raw)) return { status: "no_label" };
  const row = index?.byLabel?.get(normalizeCommodityLabel(raw));
  if (!row) return { status: "unmatched", raw_label: raw };
  return {
    status: "matched",
    code: row.code,
    label: row.label,
    level: 3,
    parents: [...row.parents],
    catalog_version: index.version,
  };
}

/** Coverage of category resolution over a parsed RFx population, overall and by RFx status. */
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function summarizeCommodityCategoryCoverage(rows, index, {
  labelField = "main_commodity",
  statusField = "rfx_status",
} = {}) {
  const blank = () => ({ total: 0, matched: 0, unmatched: 0, no_label: 0 });
  const overall = blank();
  const byStatus = {};
  const unmatched = new Map();
  for (const row of rows || []) {
    const result = resolveCommodityCategory(row?.[labelField], index);
    const status = String(row?.[statusField] ?? "").trim() || "(blank)";
    byStatus[status] ||= blank();
    for (const bucket of [overall, byStatus[status]]) {
      bucket.total += 1;
      bucket[result.status] += 1;
    }
    if (result.status === "unmatched") unmatched.set(result.raw_label, (unmatched.get(result.raw_label) || 0) + 1);
  }
  const fieldPresent = overall.total > 0 && overall.no_label < overall.total;
  return {
    catalog_version: index?.version || null,
    state: overall.total === 0 ? "no_rows" : fieldPresent ? "measured" : "field_absent",
    ...overall,
    by_status: Object.fromEntries(Object.entries(byStatus).sort(([a], [b]) => byCodeUnit(a, b))),
    unmatched_labels: [...unmatched.entries()]
      .map(([label, count]) => ({ label, rows: count }))
      .sort((a, b) => b.rows - a.rows || byCodeUnit(a.label, b.label)),
  };
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
  if (artifact.schema === NYC_COMMODITY_CATEGORIES_SCHEMA) {
    assertPublicNycCategoriesPayload(artifact);
    if (Number(entry.records) !== artifact.categories.length || Number(entry.codes) !== artifact.codes.length) {
      throw new Error("categories artifact counts do not match manifest");
    }
    const keys = new Set();
    for (const row of artifact.categories) {
      const key = `${row.level}:${row.code}`;
      if (keys.has(key)) throw new Error(`category codes must be unique per level (${key})`);
      keys.add(key);
    }
    const l3 = new Set(artifact.categories.filter((row) => row.level === 3).map((row) => row.code));
    const codes = new Set();
    for (const row of artifact.codes) {
      if (codes.has(row.code)) throw new Error(`artifact codes must be unique (${row.code})`);
      if (!l3.has(row.l3)) throw new Error(`code ${row.code} names unknown L3 category ${row.l3}`);
      codes.add(row.code);
    }
    return entry;
  }
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
