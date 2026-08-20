// Pure parse/floor for the live-derived suggestion fallback stored in ALERT_STATE.
// The daily cron writes suggestions:validated (rich records) plus preset:fallback
// (slim indices). GET /suggestions reads those keys; missing, empty, unparseable,
// or stale KV uses the in-code FALLBACK_INDICES floor so chips never go blank.

import { FALLBACK_INDICES, MIN_SUGGESTION_RESULTS } from "./suggestions.mjs";

export const SUGGESTIONS_KV_KEY = "suggestions:validated";
export const PRESET_FALLBACK_KV_KEY = "preset:fallback";
export const PRESET_FALLBACK_SCHEMA = "cityscroll.preset_fallback.v1";
export const PRESET_FALLBACK_MAX_AGE_MS = 48 * 60 * 60 * 1000;
export const PRESET_FALLBACK_TTL_SECONDS = Math.floor(PRESET_FALLBACK_MAX_AGE_MS / 1000);

export const SUGGESTION_LENSES = [
  "money",
  "people",
  "land",
  "property",
  "rules",
  "meetings",
  "alerts",
];

export function codeFloorSuggestionRecord({
  nowMs = Date.now(),
  minResults = MIN_SUGGESTION_RESULTS,
} = {}) {
  return {
    generatedAt: new Date(nowMs).toISOString(),
    minResults,
    source: "code_floor",
    byLens: Object.fromEntries(
      SUGGESTION_LENSES.map((lens) => [
        lens,
        (FALLBACK_INDICES[lens] || []).map((idx) => ({ idx, count: minResults })),
      ]),
    ),
  };
}

function generatedAtMs(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function isFresh(generatedAt, nowMs, maxAgeMs) {
  const ms = generatedAtMs(generatedAt);
  if (ms == null) return false;
  return nowMs - ms <= maxAgeMs;
}

function normalizeRichLens(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const out = [];
  for (const row of rows) {
    const idx = Number(row?.idx);
    if (!Number.isInteger(idx) || idx < 0) return null;
    const count = Number(row?.count);
    const entry = {
      idx,
      count: Number.isFinite(count) ? count : 0,
    };
    if (row?.destination) entry.destination = row.destination;
    if (row?.lineageRich) entry.lineageRich = true;
    if (row?.forecastBearing) entry.forecastBearing = true;
    out.push(entry);
  }
  return out;
}

function normalizeSlimLens(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const out = [];
  for (const value of rows) {
    const idx = Number(value);
    if (!Number.isInteger(idx) || idx < 0) return null;
    out.push(idx);
  }
  return out;
}

export function parseValidatedSuggestionRecord(raw, {
  nowMs = Date.now(),
  maxAgeMs = PRESET_FALLBACK_MAX_AGE_MS,
} = {}) {
  if (raw == null || raw === "") return null;
  let parsed;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (!isFresh(parsed.generatedAt, nowMs, maxAgeMs)) return null;
  const minResults = Number(parsed.minResults);
  if (!Number.isFinite(minResults) || minResults < 1) return null;
  if (!parsed.byLens || typeof parsed.byLens !== "object") return null;
  const byLens = {};
  for (const [lens, rows] of Object.entries(parsed.byLens)) {
    const normalized = normalizeRichLens(rows);
    if (!normalized) return null;
    byLens[lens] = normalized;
  }
  if (!Object.keys(byLens).length) return null;
  return {
    generatedAt: parsed.generatedAt,
    minResults,
    byLens,
  };
}

export function parsePresetFallbackRecord(raw, {
  nowMs = Date.now(),
  maxAgeMs = PRESET_FALLBACK_MAX_AGE_MS,
  minResults = MIN_SUGGESTION_RESULTS,
} = {}) {
  if (raw == null || raw === "") return null;
  let parsed;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (parsed.schema !== PRESET_FALLBACK_SCHEMA) return null;
  if (!isFresh(parsed.generatedAt, nowMs, maxAgeMs)) return null;
  const floor = Number(parsed.minResults);
  const useMin = Number.isFinite(floor) && floor >= 1 ? floor : minResults;
  if (!parsed.byLens || typeof parsed.byLens !== "object") return null;
  const byLens = {};
  for (const [lens, rows] of Object.entries(parsed.byLens)) {
    const indices = normalizeSlimLens(rows);
    if (!indices) return null;
    byLens[lens] = indices.map((idx) => ({ idx, count: useMin }));
  }
  if (!Object.keys(byLens).length) return null;
  return {
    generatedAt: parsed.generatedAt,
    minResults: useMin,
    byLens,
  };
}

export function toPresetFallbackPayload(record) {
  return {
    schema: PRESET_FALLBACK_SCHEMA,
    generatedAt: record.generatedAt,
    minResults: record.minResults,
    byLens: Object.fromEntries(
      Object.entries(record.byLens || {}).map(([lens, rows]) => [
        lens,
        rows.map((row) => (typeof row === "number" ? row : row.idx)),
      ]),
    ),
  };
}

export async function readKvValue(store, key) {
  if (!store || typeof store.get !== "function") return null;
  try {
    return await store.get(key);
  } catch {
    return null;
  }
}

export async function loadSuggestionRecord(env, {
  nowMs = Date.now(),
  maxAgeMs = PRESET_FALLBACK_MAX_AGE_MS,
} = {}) {
  const floor = codeFloorSuggestionRecord({ nowMs });
  const kv = env?.ALERT_STATE;
  if (!kv) return { source: "code_floor", record: floor };
  const validated = parseValidatedSuggestionRecord(
    await readKvValue(kv, SUGGESTIONS_KV_KEY),
    { nowMs, maxAgeMs },
  );
  if (validated) return { source: "kv", record: validated };
  const slim = parsePresetFallbackRecord(
    await readKvValue(kv, PRESET_FALLBACK_KV_KEY),
    { nowMs, maxAgeMs },
  );
  if (slim) return { source: "kv", record: slim };
  return { source: "code_floor", record: floor };
}
