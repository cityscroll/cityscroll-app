/**
 * The reviewed handoff from a district-scoped issue result to Following.
 *
 * A bundle is only saved scope: it is not an entity, alias, or project.  The
 * compiler registry is deliberately the source of truth for which children
 * may be created. Unsupported source families remain visible as omissions.
 */
import {
  canonicalTextQuery,
  textQueryEvaluationSupported,
  textQueryTokens,
} from "./watch_text_query.mjs";
import { normalizeCommunityBoardRef } from "./community_board_watch.mjs";
import { normalizeGeographyKey } from "./scope_v0.mjs";

export const LOCAL_TOPIC_WATCH_BUNDLE_SCHEMA = "cityscroll.local_topic_watch_bundle.v1";
export const LOCAL_TOPIC_WATCH_BUNDLE_VERSION = 1;
export const LOCAL_TOPIC_WATCH_FREQUENCIES = Object.freeze(["daily", "weekly"]);

// These are the only district source families whose exact text + place
// evaluation is currently registered in the watch compiler.
const CHILD_SOURCES = Object.freeze({
  community_board_meeting: Object.freeze({ lens: "meetings", label: "Community Board meetings" }),
  shared_procurement_read_model: Object.freeze({ lens: "money", label: "City contracts" }),
});

const clean = (value, max = 240) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

function districtKey(value) {
  const raw = clean(value, 40).toUpperCase();
  return /^[MKQRX]\d{2}$/.test(raw) ? raw : null;
}

function exactTextQuery(topic) {
  const value = clean(topic, 240);
  const tokens = textQueryTokens(value);
  if (!tokens.length || tokens.join(" ").length > 120) return { ok: false, reason: "invalid_topic" };
  const expression = canonicalTextQuery({
    version: 1,
    all: [[{ kind: tokens.length === 1 ? "term" : "phrase", value: tokens.join(" ") }]],
  });
  return expression
    ? { ok: true, value: expression }
    : { ok: false, reason: "invalid_topic" };
}

function geographyForDistrict(district) {
  return normalizeGeographyKey(`geography:community_district:${district}`);
}

function previewCount(input, family, lens) {
  const source = input?.preview_counts || input?.previews || input?.preview;
  if (typeof source === "function") return null;
  if (source && typeof source === "object") {
    const value = source[family] ?? source[lens];
    if (Number.isInteger(Number(value)) && Number(value) >= 0) return Number(value);
    if (Array.isArray(value)) return value.length;
  }
  return null;
}

function stableText(value) {
  return JSON.stringify(value, Object.keys(value).sort());
}

// A compact deterministic ID for the child predicate. It intentionally
// excludes email and cadence: replaying the same reviewed scope is idempotent.
export function canonicalLocalTopicWatchId(child) {
  const input = stableText({ lens: child?.lens, filter: child?.filter || {} });
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `local-watch:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function omission(sourceFamily, reason = "exact text-and-place evaluation is not supported") {
  return Object.freeze({ source_family: sourceFamily, status: "omitted", reason });
}

/** Build a confirmed, fail-closed bundle from the visible district result. */
export function buildLocalTopicWatchBundle(input = {}, options = {}) {
  const district = districtKey(options.district ?? input.district ?? input.locality?.district);
  const topic = clean(options.topic ?? options.query ?? input.topic ?? input.query, 240);
  const frequency = options.frequency === "daily" ? "daily" : "weekly";
  const text = exactTextQuery(topic);
  if (!district) return Object.freeze({ schema: LOCAL_TOPIC_WATCH_BUNDLE_SCHEMA, version: 1, status: "invalid_scope", children: [], omissions: [], reason: "invalid_district" });
  if (!text.ok) return Object.freeze({ schema: LOCAL_TOPIC_WATCH_BUNDLE_SCHEMA, version: 1, status: "invalid_topic", district, topic, children: [], omissions: [], reason: text.reason });

  const requestedScope = districtKey(input?.district ?? input?.scope?.district ?? input?.locality?.district);
  if (requestedScope && requestedScope !== district) {
    return Object.freeze({ schema: LOCAL_TOPIC_WATCH_BUNDLE_SCHEMA, version: 1, status: "scope_changed", district, topic, children: [], omissions: [], reason: "district_scope_changed" });
  }
  const geography = geographyForDistrict(district);
  if (!geography) return Object.freeze({ schema: LOCAL_TOPIC_WATCH_BUNDLE_SCHEMA, version: 1, status: "invalid_scope", district, topic, children: [], omissions: [], reason: "unsupported_district" });

  const boardRaw = options.board ?? input.board;
  const board = boardRaw && normalizeCommunityBoardRef(boardRaw.id || boardRaw.key || boardRaw.ref || boardRaw);
  const sourceFamilies = Array.isArray(options.source_families ?? input.source_families)
    ? (options.source_families ?? input.source_families).map(String)
    : Object.keys(CHILD_SOURCES);
  const children = [];
  const omissions = [];
  for (const family of sourceFamilies) {
    const definition = CHILD_SOURCES[family];
    if (!definition || !textQueryEvaluationSupported(definition.lens)) {
      omissions.push(omission(family));
      continue;
    }
    const filter = { geographies: [geography], text_query: text.value };
    if (definition.lens === "meetings" && board) filter.communityBoard = board;
    const child = {
      id: canonicalLocalTopicWatchId({ lens: definition.lens, filter }),
      source_family: family,
      label: definition.label,
      lens: definition.lens,
      district,
      board: board || null,
      literal_query: topic,
      filter,
      frequency,
      preview_count: previewCount(input, family, definition.lens),
      status: "valid",
    };
    children.push(Object.freeze(child));
  }
  return Object.freeze({
    schema: LOCAL_TOPIC_WATCH_BUNDLE_SCHEMA,
    version: LOCAL_TOPIC_WATCH_BUNDLE_VERSION,
    status: children.length ? "confirmed" : "no_supported_children",
    district, board: board || null, literal_query: topic, frequency,
    children: Object.freeze(children), omissions: Object.freeze(omissions),
  });
}

export const createLocalTopicWatchBundle = buildLocalTopicWatchBundle;
export const compileLocalTopicWatchBundle = buildLocalTopicWatchBundle;

/**
 * Apply children one at a time. Existing IDs are skipped, successful children
 * survive a later failure, and retrying receives only the missing children.
 */
export async function applyLocalTopicWatchBundle(bundle, createChild, existingIds = []) {
  if (typeof createChild !== "function" || bundle?.status !== "confirmed") {
    return { status: "invalid", created: [], failed: [], remaining: bundle?.children || [] };
  }
  const existing = new Set(existingIds);
  const created = [], failed = [], remaining = [];
  for (const child of bundle.children) {
    if (existing.has(child.id)) continue;
    try {
      await createChild(child);
      existing.add(child.id);
      created.push(child.id);
    } catch (error) {
      failed.push({ id: child.id, reason: clean(error?.message || "creation failed", 180) });
      remaining.push(child);
    }
  }
  return { status: failed.length ? (created.length ? "partial" : "failed") : "created", created, failed, remaining };
}

/** Confirmation copy/data: every predicate is explicit and omissions remain visible. */
export function localTopicWatchConfirmation(bundle) {
  if (!bundle || bundle.schema !== LOCAL_TOPIC_WATCH_BUNDLE_SCHEMA) return null;
  return {
    status: bundle.status,
    district: bundle.district,
    frequency: bundle.frequency,
    children: bundle.children.map((child) => ({
      id: child.id, label: child.label, lens: child.lens, district: child.district,
      board: child.board, literal_query: child.literal_query,
      frequency: child.frequency, preview_count: child.preview_count,
    })),
    omissions: bundle.omissions,
  };
}

export function renderLocalTopicWatchConfirmation(bundle) {
  const view = localTopicWatchConfirmation(bundle);
  if (!view) return "";
  const esc = (value) => String(value ?? "").replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[c]));
  const rows = view.children.map((child) => `<li data-watch-child-id="${esc(child.id)}"><strong>${esc(child.label)}</strong> · ${esc(child.district)}${child.board ? ` · ${esc(child.board)}` : ""} · “${esc(child.literal_query)}” · ${esc(child.frequency)} · ${child.preview_count == null ? "preview unavailable" : `${child.preview_count} preview matches`}</li>`).join("");
  const omitted = view.omissions.map((item) => `<li data-watch-omitted-family="${esc(item.source_family)}">${esc(item.source_family)}: ${esc(item.reason)}</li>`).join("");
  return `<section data-local-topic-watch-confirmation="1"><h2>Follow this topic in ${esc(view.district)}</h2><ul>${rows}</ul>${omitted ? `<h3>Not included</h3><ul>${omitted}</ul>` : ""}</section>`;
}
