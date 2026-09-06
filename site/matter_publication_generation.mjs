/**
 * Versioned retained matter publication generation.
 *
 * One validated generation governs public matter pages and exact-watch update
 * eligibility. Pages and delivery compare the same identifiers; an older static
 * fallback never claims current coverage. This module is pure: it does not
 * fetch a publisher or write storage.
 */

export const MATTER_PUBLICATION_GENERATION_SCHEMA = "cityscroll.matter_publication_generation.v1";
export const MATTER_PUBLICATION_MANIFEST_SCHEMA = "cityscroll.matter_publication_manifest.v1";
export const LEGISLATIVE_MATTER_LOOKUP_SCHEMA = "cityscroll.legislative_matter_lookup.v1";
export const LEGISLATIVE_MATTER_INDEX_SCHEMA = "cityscroll.legislative_matter_index.v1";

export const MATTER_COVERAGE_STATE = Object.freeze({
  CURRENT: "current",
  STALE_REFRESH: "stale-refresh",
  INCOMPLETE_HISTORY: "incomplete-history",
  NO_LATER_ACTION_LOCATED: "no-later-action-located",
  UNSUPPORTED_SOURCE: "unsupported-source",
  FAILED_CONFIRMATION: "failed-confirmation",
  OLDER_STATIC_FALLBACK: "older-static-fallback",
  UNPUBLISHED: "unpublished",
});

export const MATTER_PUBLICATION_KV_PREFIX = "matter-publication";
export const MATTER_PUBLICATION_CURRENT_KEY = `${MATTER_PUBLICATION_KV_PREFIX}/current`;

function freeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (!value || typeof value !== "object") return value;
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freeze(item)])));
}

function clean(value, max = 500) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function matterPublicationArtifactKey(generationId, artifact) {
  const id = clean(generationId, 128);
  const name = clean(artifact, 40);
  if (!id || !name) return "";
  return `${MATTER_PUBLICATION_KV_PREFIX}/generation/${id}/${name}`;
}

export function compareMatterGenerationOrder(left, right) {
  const leftSeq = Number(left?.sequence);
  const rightSeq = Number(right?.sequence);
  if (Number.isFinite(leftSeq) && Number.isFinite(rightSeq) && leftSeq !== rightSeq) {
    return leftSeq < rightSeq ? -1 : 1;
  }
  const leftAt = clean(left?.published_at, 80);
  const rightAt = clean(right?.published_at, 80);
  if (leftAt && rightAt && leftAt !== rightAt) return leftAt < rightAt ? -1 : 1;
  const leftId = clean(left?.generation_id, 128);
  const rightId = clean(right?.generation_id, 128);
  if (leftId && rightId && leftId === rightId) return 0;
  if (!leftId) return -1;
  if (!rightId) return 1;
  return leftId.localeCompare(rightId);
}

export function pageGenerationCoversUpdate(pageGeneration, update) {
  const updateGeneration = {
    generation_id: clean(update?.published_generation_id || update?.generation_id, 128),
    sequence: update?.published_generation_sequence ?? update?.generation_sequence,
    published_at: clean(update?.published_generation_at || update?.published_at, 80),
  };
  const unversioned = !updateGeneration.generation_id
    && (updateGeneration.sequence == null || Number.isNaN(Number(updateGeneration.sequence)))
    && !updateGeneration.published_at;
  if (unversioned) return true;
  if (!pageGeneration?.generation_id) return false;
  if (pageGeneration.coverage_state === MATTER_COVERAGE_STATE.OLDER_STATIC_FALLBACK) return false;
  if (pageGeneration.coverage_state === MATTER_COVERAGE_STATE.UNPUBLISHED) return false;
  if (updateGeneration.generation_id && updateGeneration.generation_id === pageGeneration.generation_id) return true;
  return compareMatterGenerationOrder(pageGeneration, updateGeneration) >= 0;
}

function matterIds(payload) {
  return Object.keys(payload?.matters || {}).sort((left, right) => Number(left) - Number(right));
}

export function validateMatterGeneration({ lookup, index, generation_id, sequence, published_at } = {}) {
  const errors = [];
  if (lookup?.schema !== LEGISLATIVE_MATTER_LOOKUP_SCHEMA) errors.push("lookup-schema");
  if (index?.schema !== LEGISLATIVE_MATTER_INDEX_SCHEMA) errors.push("index-schema");
  const lookupIds = matterIds(lookup);
  const indexIds = matterIds(index);
  if (lookupIds.join(",") !== indexIds.join(",")) errors.push("population-mismatch");
  if (!lookupIds.length) errors.push("empty-population");
  for (const id of lookupIds) {
    const entry = lookup.matters[id];
    if (!Array.isArray(entry?.appearances) || !entry.appearances.length) errors.push(`incomplete-history:${id}`);
    if (entry?.matter_id !== id) errors.push(`identity-mismatch:${id}`);
  }
  if (!clean(generation_id, 128)) errors.push("missing-generation-id");
  if (!Number.isInteger(Number(sequence))) errors.push("missing-sequence");
  if (!clean(published_at, 80)) errors.push("missing-published-at");
  return freeze({
    ok: errors.length === 0,
    errors,
    matter_ids: lookupIds,
  });
}

export function stampMatterLookup(lookup, generation) {
  const coverage = clean(generation?.coverage_state, 80) || MATTER_COVERAGE_STATE.CURRENT;
  return {
    ...(lookup && typeof lookup === "object" ? lookup : {}),
    generation_id: clean(generation?.generation_id, 128) || null,
    generation_sequence: Number.isInteger(Number(generation?.sequence)) ? Number(generation.sequence) : null,
    published_at: clean(generation?.published_at, 80) || null,
    coverage_state: coverage,
  };
}

export function staticFallbackGeneration(lookup = {}) {
  return freeze({
    schema: MATTER_PUBLICATION_GENERATION_SCHEMA,
    generation_id: clean(lookup?.generation_id, 128) || `static:${clean(lookup?.generated_at, 80) || "unversioned"}`,
    sequence: Number.isInteger(Number(lookup?.generation_sequence)) ? Number(lookup.generation_sequence) : 0,
    published_at: clean(lookup?.published_at || lookup?.generated_at, 80) || null,
    coverage_state: MATTER_COVERAGE_STATE.OLDER_STATIC_FALLBACK,
    source_vintage: clean(lookup?.generated_at, 80) || null,
    fallback: true,
  });
}

export function coverageStateFor({
  published = false,
  fallback = false,
  stale = false,
  incomplete = false,
  unsupportedSource = false,
  failedConfirmation = false,
  laterActionLocated = true,
} = {}) {
  if (failedConfirmation) return MATTER_COVERAGE_STATE.FAILED_CONFIRMATION;
  if (unsupportedSource) return MATTER_COVERAGE_STATE.UNSUPPORTED_SOURCE;
  if (fallback || !published) {
    return fallback ? MATTER_COVERAGE_STATE.OLDER_STATIC_FALLBACK : MATTER_COVERAGE_STATE.UNPUBLISHED;
  }
  if (stale) return MATTER_COVERAGE_STATE.STALE_REFRESH;
  if (incomplete) return MATTER_COVERAGE_STATE.INCOMPLETE_HISTORY;
  if (!laterActionLocated) return MATTER_COVERAGE_STATE.NO_LATER_ACTION_LOCATED;
  return MATTER_COVERAGE_STATE.CURRENT;
}

export function coverageCopy(state, { latestAction = null, decidingBody = null } = {}) {
  const action = clean(latestAction, 240);
  const body = clean(decidingBody, 240);
  switch (state) {
    case MATTER_COVERAGE_STATE.STALE_REFRESH:
      return "The last known history is still shown. A later refresh has not been applied, so this page may be behind the retained collector.";
    case MATTER_COVERAGE_STATE.INCOMPLETE_HISTORY:
      return "This history is incomplete. CityScroll has not retained every official step that may exist for this matter.";
    case MATTER_COVERAGE_STATE.UNSUPPORTED_SOURCE:
      return "This exact matter source is not supported here, so CityScroll cannot follow it as an exact Council matter.";
    case MATTER_COVERAGE_STATE.FAILED_CONFIRMATION:
      return "Following this matter was not confirmed. Collector or delivery is not ready, so this is not a saved watch.";
    case MATTER_COVERAGE_STATE.OLDER_STATIC_FALLBACK:
      return "This page is an older published snapshot. It is usable, but it is not the current retained generation.";
    case MATTER_COVERAGE_STATE.UNPUBLISHED:
      return "This matter generation has not been published yet. Updates that point here are held.";
    case MATTER_COVERAGE_STATE.NO_LATER_ACTION_LOCATED:
      return "No later official action has been located. That is the limit of what has been retained here, not a finding that the matter is finished.";
    default:
      if (action && body) return `Latest observed official action: ${action}, recorded by ${body}.`;
      if (action) return `Latest observed official action: ${action}.`;
      return "This page is the current published retained generation for this matter.";
  }
}

export function approvalLanguage(actionName) {
  const action = clean(actionName, 240);
  if (!action) return null;
  return freeze({
    text: action,
    retains_deciding_body: /by (subcommittee|committee|commission|council|board|body)\b/i.test(action),
    claims_testimony: /\btestif/i.test(action),
    claims_agency_reply: /\bagency (replied|response)\b/i.test(action),
    claims_resident_causation: /\bbecause you\b|\byour testimony\b|\bcaused\b/i.test(action),
  });
}

export function decideUpdateRelease(update, pageGeneration) {
  if (!pageGenerationCoversUpdate(pageGeneration, update)) {
    return freeze({
      release: false,
      hold: true,
      reason: pageGeneration?.coverage_state === MATTER_COVERAGE_STATE.OLDER_STATIC_FALLBACK
        ? "older-static-fallback-not-current"
        : "destination-not-published",
    });
  }
  return freeze({ release: true, hold: false, reason: null });
}

export function buildMatterPublicationManifest(generation, validation) {
  return freeze({
    schema: MATTER_PUBLICATION_MANIFEST_SCHEMA,
    generation_id: clean(generation?.generation_id, 128),
    sequence: Number(generation?.sequence),
    published_at: clean(generation?.published_at, 80),
    coverage_state: clean(generation?.coverage_state, 80) || MATTER_COVERAGE_STATE.CURRENT,
    source_vintage: clean(generation?.source_vintage, 80) || null,
    matter_count: Array.isArray(validation?.matter_ids) ? validation.matter_ids.length : 0,
    artifacts: {
      lookup: matterPublicationArtifactKey(generation?.generation_id, "lookup.json"),
      index: matterPublicationArtifactKey(generation?.generation_id, "index.json"),
    },
  });
}

function publicationKv(env) {
  return env?.MATTER_PUBLICATION || env?.ALERT_STATE || null;
}

async function kvJson(kv, key) {
  if (!kv?.get) return null;
  const value = await kv.get(key);
  if (value == null) return null;
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return null; }
  }
  return value;
}

/**
 * Read the current published generation from retained CityScroll storage.
 * Falls back to a committed lookup only as an explicit older snapshot.
 */
export async function resolvePublishedMatterLookup(env, { staticLookup = null } = {}) {
  const kv = publicationKv(env);
  const current = kv ? await kvJson(kv, MATTER_PUBLICATION_CURRENT_KEY) : null;
  if (current?.generation_id && kv) {
    const lookup = await kvJson(kv, matterPublicationArtifactKey(current.generation_id, "lookup.json"));
    const index = await kvJson(kv, matterPublicationArtifactKey(current.generation_id, "index.json"));
    const manifest = await kvJson(kv, matterPublicationArtifactKey(current.generation_id, "manifest.json")) || current;
    if (lookup?.schema && index?.schema) {
      return {
        lookup: stampMatterLookup(lookup, manifest),
        index,
        generation: freeze({
          schema: MATTER_PUBLICATION_GENERATION_SCHEMA,
          generation_id: manifest.generation_id,
          sequence: manifest.sequence,
          published_at: manifest.published_at,
          coverage_state: manifest.coverage_state || MATTER_COVERAGE_STATE.CURRENT,
          source_vintage: manifest.source_vintage || lookup.generated_at || null,
          fallback: false,
        }),
        fallback: false,
      };
    }
  }
  if (staticLookup) {
    const generation = staticFallbackGeneration(staticLookup);
    return {
      lookup: stampMatterLookup(staticLookup, generation),
      index: null,
      generation,
      fallback: true,
    };
  }
  return {
    lookup: null,
    index: null,
    generation: freeze({
      schema: MATTER_PUBLICATION_GENERATION_SCHEMA,
      generation_id: null,
      sequence: null,
      published_at: null,
      coverage_state: MATTER_COVERAGE_STATE.UNPUBLISHED,
      fallback: false,
    }),
    fallback: false,
  };
}
