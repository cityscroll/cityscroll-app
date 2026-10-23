/**
 * Lazy Land outcomes-seed loader for detail / first rich paint.
 *
 * The list snapshot stays slim; this module fetches
 * data/land_outcomes_seed.json once when a project needs dispositions/spine
 * and overlays those fields onto the cached static snapshot via the shared
 * merge helper.
 */
import { mergeLandOutcomeSeedRecord } from "./land_outcomes_merge.mjs";

export const LAND_OUTCOMES_SEED_URL = "data/land_outcomes_seed.json";

export function createLandOutcomesSeedRuntime({
  fetchImpl = globalThis.fetch?.bind(globalThis),
  getCached,
  enrichStatic,
  seedUrl = LAND_OUTCOMES_SEED_URL,
} = {}) {
  let seedPromise = null;

  function loadSeed() {
    if (!seedPromise) {
      if (typeof fetchImpl !== "function") {
        seedPromise = Promise.resolve(null);
      } else {
        seedPromise = fetchImpl(seedUrl, { cache: "force-cache", credentials: "omit" })
          .then((response) => (response?.ok ? response.json() : null))
          .catch(() => null);
      }
    }
    return seedPromise;
  }

  async function enrichStaticFromSeed(projectId) {
    const id = String(projectId || "").trim();
    if (!id || typeof getCached !== "function" || typeof enrichStatic !== "function") {
      return null;
    }
    const warm = getCached(id);
    if (!warm?.staticSnapshot || !warm?.data?.record) return warm || null;
    const record = warm.data.record;
    if (Array.isArray(record.dispositions) && record.dispositions.length) return warm;
    if (record.spine?.events?.length) return warm;
    const seedDoc = await loadSeed();
    const seedRecord = seedDoc?.by_project?.[id];
    if (!seedRecord) return warm;
    return enrichStatic(id, seedRecord, mergeLandOutcomeSeedRecord) || warm;
  }

  return { loadSeed, enrichStaticFromSeed };
}
