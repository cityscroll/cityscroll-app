/**
 * Runtime observation helpers for Land catalog generation identity.
 *
 * Kept off the shared land_project_catalog module so Notice cold-path
 * consumers that already import the catalog helpers do not pay for
 * observation-only surface area.
 */

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

/**
 * Catalog generation identity a consumer actually loaded: content_id plus the
 * publisher source dates. Absence stays null rather than inventing stamps.
 */
export function catalogGenerationIdentity(doc) {
  const sourceDates = asObject(doc?.source_dates);
  return {
    content_id: doc?.generation?.content_id || null,
    source_dates: {
      warehouse_materialized_at: sourceDates?.warehouse_materialized_at || null,
      defaults_generated_at: sourceDates?.defaults_generated_at || null,
    },
  };
}

/**
 * Findings when consumer observations do not share one catalog generation.
 * Empty means every observation carries the same content_id and source dates.
 *
 * @param {Array<{ consumer?: string, identity?: object }>} observations
 * @returns {string[]}
 */
export function catalogGenerationMismatchFindings(observations) {
  const rows = Array.isArray(observations) ? observations : [];
  if (rows.length < 2) return [];
  const findings = [];
  const baseline = rows[0]?.identity || catalogGenerationIdentity(null);
  for (let i = 1; i < rows.length; i += 1) {
    const other = rows[i]?.identity || catalogGenerationIdentity(null);
    if (other.content_id !== baseline.content_id) {
      findings.push(
        `${rows[i]?.consumer || `consumer_${i}`} content_id ${JSON.stringify(other.content_id)} != ${JSON.stringify(baseline.content_id)}`,
      );
    }
    const left = baseline.source_dates || {};
    const right = other.source_dates || {};
    if (right.warehouse_materialized_at !== left.warehouse_materialized_at
      || right.defaults_generated_at !== left.defaults_generated_at) {
      findings.push(
        `${rows[i]?.consumer || `consumer_${i}`} source_dates diverge from ${rows[0]?.consumer || "baseline"}`,
      );
    }
  }
  return findings;
}

/**
 * Land browse catalog bind. Same projects/vintage semantics as the Land app
 * load path; also records the generation identity for runtime observation.
 */
export function bindLandBrowseCatalog(catalog) {
  const identity = catalogGenerationIdentity(catalog);
  return {
    projects: Array.isArray(catalog?.projects) ? catalog.projects : [],
    vintage: identity.source_dates.warehouse_materialized_at,
    identity,
  };
}
