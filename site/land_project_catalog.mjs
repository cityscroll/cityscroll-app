/**
 * Admitted Land project catalog.
 *
 * Exact-ID union of the warehouse lookup and the default ULURP snapshot with
 * defaults-over-warehouse field precedence — the same semantics as the former
 * mergeLandProjects helper. Historical BBL indexes never enlarge the catalog.
 */

export const LAND_PROJECT_CATALOG_SCHEMA = "cityscroll.land_project_catalog.v1";
export const LAND_PROJECT_CATALOG_PATH = "site/data/land_project_catalog.json";
export const LAND_PROJECT_CATALOG_WAREHOUSE_PATH = "site/data/zap_projects_warehouse_lookup.json";
export const LAND_PROJECT_CATALOG_DEFAULTS_PATH = "site/data/land_default_ulurp.json";

const cleanProjectId = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

/** Rows from a warehouse doc, defaults doc, catalog, or bare array. */
export function landProjectRowsFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.projects)) return payload.projects;
  if (Array.isArray(payload?.rows)) return payload.rows;
  return [];
}

/**
 * Exact-ID merge. Later payloads overwrite overlapping fields on the same
 * project_id (defaults-over-warehouse when called as mergeLandProjects(warehouse, defaults)).
 */
export function mergeLandProjects(...payloads) {
  const byId = new Map();
  for (const payload of payloads) {
    for (const row of landProjectRowsFromPayload(payload)) {
      const id = cleanProjectId(row?.project_id);
      if (!id) continue;
      byId.set(id, { ...(byId.get(id) || {}), ...row });
    }
  }
  return [...byId.values()];
}

export function catalogSourceDates({ warehouse = null, defaults = null } = {}) {
  return {
    warehouse_materialized_at: asObject(warehouse)?.materialized_at || null,
    defaults_generated_at: asObject(defaults)?.generated_at || null,
  };
}

/** Stable non-crypto fingerprint for generation identity (browser-safe). */
export function landProjectCatalogContentId({ projectIds, sourceDates }) {
  const ids = (Array.isArray(projectIds) ? projectIds : [])
    .map(cleanProjectId)
    .filter(Boolean)
    .slice()
    .sort((left, right) => left.localeCompare(right));
  const stamp = [
    sourceDates?.warehouse_materialized_at || "",
    sourceDates?.defaults_generated_at || "",
    ids.join("\n"),
  ].join("|");
  let hash = 0x811c9dc5;
  for (let i = 0; i < stamp.length; i += 1) {
    hash ^= stamp.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}:${ids.length}`;
}

/**
 * Build the admitted catalog document.
 *
 * @param {object} inputs
 * @param {object} inputs.warehouse — required warehouse lookup payload
 * @param {object} inputs.defaults — required land_default_ulurp payload
 * @param {object} [inputs.bblIndex] — ignored join source; never admits IDs
 * @param {{ warehouse?: string, defaults?: string }} [inputs.artifactHashes]
 * @throws when warehouse or defaults is missing (failed-source case)
 */
export function buildLandProjectCatalog(inputs = {}) {
  const warehouse = inputs.warehouse;
  const defaults = inputs.defaults;
  if (warehouse == null || defaults == null) {
    const error = new Error("land_project_catalog requires warehouse and defaults payloads");
    error.code = "LAND_PROJECT_CATALOG_SOURCE_MISSING";
    throw error;
  }

  // Historical BBL indexes are join evidence only — never catalog admission.
  void inputs.bblIndex;

  const projects = mergeLandProjects(warehouse, defaults)
    .slice()
    .sort((left, right) => cleanProjectId(left.project_id).localeCompare(cleanProjectId(right.project_id)));
  const projectIds = projects.map((row) => cleanProjectId(row.project_id));
  const sourceDates = catalogSourceDates({ warehouse, defaults });
  const hashes = asObject(inputs.artifactHashes) || {};
  const contentId = landProjectCatalogContentId({ projectIds, sourceDates });

  return {
    schema: LAND_PROJECT_CATALOG_SCHEMA,
    project_count: projects.length,
    projects,
    // Top-level aliases for corpus stamp checks; values always come from the
    // retained source dates below, never from builder wall-clock time.
    materialized_at: sourceDates.warehouse_materialized_at,
    generated_at: sourceDates.defaults_generated_at,
    sources: {
      warehouse: {
        path: LAND_PROJECT_CATALOG_WAREHOUSE_PATH,
        materialized_at: sourceDates.warehouse_materialized_at,
        row_count: landProjectRowsFromPayload(warehouse).length,
        sha256: hashes.warehouse || null,
      },
      defaults: {
        path: LAND_PROJECT_CATALOG_DEFAULTS_PATH,
        generated_at: sourceDates.defaults_generated_at,
        row_count: landProjectRowsFromPayload(defaults).length,
        sha256: hashes.defaults || null,
      },
    },
    source_dates: sourceDates,
    generation: {
      derivation: "node tools/build_land_project_catalog.mjs",
      content_id: contentId,
    },
  };
}

export function catalogProjectIdSet(catalog) {
  return new Set(
    landProjectRowsFromPayload(catalog)
      .map((row) => cleanProjectId(row?.project_id))
      .filter(Boolean),
  );
}

/**
 * Consumer read of one catalog generation. A mismatched content_id yields an
 * empty population so a removed ID cannot persist through a stale cache.
 */
export function landProjectsForCatalogGeneration(catalog, expectedContentId) {
  if (!catalog || catalog.schema !== LAND_PROJECT_CATALOG_SCHEMA) return [];
  const contentId = catalog.generation?.content_id;
  if (expectedContentId != null && contentId !== expectedContentId) return [];
  return landProjectRowsFromPayload(catalog);
}

/**
 * Bind a consumer cache to a catalog generation. Replacing the generation
 * drops the previous project list entirely.
 */
export function bindLandProjectCatalogCache(previousCache, catalog) {
  const contentId = catalog?.generation?.content_id || null;
  if (!contentId || catalog?.schema !== LAND_PROJECT_CATALOG_SCHEMA) {
    return { content_id: null, projects: [] };
  }
  if (previousCache?.content_id && previousCache.content_id !== contentId) {
    // Drop stale entries before adopting the new generation.
    previousCache = null;
  }
  return {
    content_id: contentId,
    projects: landProjectsForCatalogGeneration(catalog, contentId),
  };
}
