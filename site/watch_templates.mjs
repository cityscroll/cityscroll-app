/**
 * Watch template registry — pure helpers over curated multi-watch bundles.
 *
 * A template is a named list of {lens, filter} watches the existing /subscribe
 * path can instantiate one-by-one. Adding a vertical is registry data, not code.
 *
 * Artifact: site/data/watch_templates.json
 */

import { scopeFromWatch, watchFromScope } from "./scope_v0.mjs";

export const WATCH_TEMPLATES_SCHEMA_VERSION = 1;

/** @type {object|null} */
let cachedRegistry = null;

/**
 * @param {object|null|undefined} raw
 * @returns {{ schema_version: number, templates: object[] }}
 */
export function normalizeWatchTemplateRegistry(raw) {
  const templates = Array.isArray(raw?.templates) ? raw.templates : [];
  const out = [];
  for (const t of templates) {
    if (!t || typeof t !== "object") continue;
    const id = clean(t.id);
    if (!id) continue;
    const watches = normalizeWatches(t.watches);
    if (!watches.length) continue;
    out.push({
      id,
      title: clean(t.title) || id,
      description: clean(t.description) || "",
      serves: clean(t.serves) || clean(t.description) || "",
      watches,
      title_key: clean(t.title_key) || null,
      description_key: clean(t.description_key) || null,
    });
  }
  return {
    schema_version: Number(raw?.schema_version) || WATCH_TEMPLATES_SCHEMA_VERSION,
    pattern: clean(raw?.pattern) || "watch_template_registry",
    templates: out,
  };
}

/**
 * @param {unknown} watches
 * @returns {object[]}
 */
function normalizeWatches(watches) {
  if (!Array.isArray(watches)) return [];
  const out = [];
  for (const w of watches) {
    if (!w || typeof w !== "object") continue;
    const lens = clean(w.lens);
    if (!lens) continue;
    const filter = normalizeFilter(w.filter);
    out.push({
      label: clean(w.label) || `${lens} watch`,
      lens,
      filter,
    });
  }
  return out;
}

/**
 * Sanitize a watch filter into the shape /subscribe + compileSub expect.
 * @param {object|null|undefined} filter
 */
export function normalizeFilter(filter) {
  const f = filter && typeof filter === "object" ? filter : {};
  const keywords = Array.isArray(f.keywords)
    ? f.keywords.map((k) => clean(k)).filter(Boolean)
    : clean(f.keywords)
      ? [clean(f.keywords)]
      : [];
  const out = {};
  if (keywords.length) out.keywords = keywords;
  if (clean(f.agency)) out.agency = clean(f.agency);
  if (clean(f.kind)) out.kind = clean(f.kind);
  if (clean(f.name)) out.name = clean(f.name);
  if (clean(f.status)) out.status = clean(f.status);
  if (f.minAmount != null && Number.isFinite(Number(f.minAmount))) {
    out.minAmount = Number(f.minAmount);
  }
  const subjectRefs = Array.isArray(f.subject_refs_all)
    ? f.subject_refs_all.map((ref) => clean(ref)).filter((ref) => ref && !/\s/.test(ref)).slice(0, 20)
    : [];
  if (subjectRefs.length) out.subject_refs_all = [...new Set(subjectRefs)];
  return out;
}

/**
 * @param {object|null|undefined} registry
 * @param {string} id
 */
export function getWatchTemplate(registry, id) {
  const want = clean(id);
  if (!want) return null;
  const list = normalizeWatchTemplateRegistry(registry).templates;
  return list.find((t) => t.id === want) || null;
}

/**
 * Payload rows ready for sequential /subscribe POSTs.
 * @param {object} template
 * @param {{ email: string, freq?: string, lang?: string }} opts
 */
export function templateSubscribePayloads(template, opts = {}) {
  const email = String(opts.email || "").trim();
  const freq = opts.freq === "weekly" ? "weekly" : "daily";
  const lang = opts.lang || "en";
  const watches = Array.isArray(template?.watches) ? template.watches : [];
  return watches.map((w) => ({
    email,
    ...watchFromScope(scopeFromWatch({ lens: w.lens, filter: normalizeFilter(w.filter) }, { language: lang })),
    freq, lang, label: w.label || w.lens,
  }));
}

/**
 * Human-readable one-line description of a single watch filter.
 * @param {{ lens: string, filter?: object, label?: string }} watch
 */
export function describeWatchLine(watch) {
  if (!watch) return "";
  if (watch.label) return String(watch.label);
  const f = watch.filter || {};
  const bits = [watch.lens];
  if (f.agency) bits.push(`agency ${f.agency}`);
  if (Array.isArray(f.keywords) && f.keywords.length) {
    bits.push(`keywords “${f.keywords.join(" ")}”`);
  }
  return bits.join(" · ");
}

/**
 * Attention-cost copy for a multi-watch pack before commit.
 * Explains one rollup email with N sections (not N emails).
 * @param {{ title?: string, watches?: { label?: string }[] }|null} template
 * @param {{ frequency?: string }} [opts]
 */
export function packAttentionCopy(template, opts = {}) {
  const watches = Array.isArray(template?.watches) ? template.watches : [];
  const n = watches.length;
  const frequency = opts.frequency === "daily" ? "daily" : "weekly";
  const labels = watches.map((w) => clean(w?.label) || "watch").filter(Boolean);
  const sectionWord = n === 1 ? "section" : "sections";
  const watchWord = n === 1 ? "watch" : "watches";
  const summary = n === 0
    ? "This set has no watches yet."
    : `This set makes ${n} ${watchWord}. You get one ${frequency} email with ${n} ${sectionWord}.`;
  const sampleSubject = n > 1
    ? `CityScroll: still watching — ${n} watches`
    : `CityScroll: still watching — ${labels[0] || template?.title || "your watches"}`;
  return { watchCount: n, frequency, labels, summary, sampleSubject };
}

/**
 * Load registry (browser). Tests pass the object directly.
 * @param {{ fetchImpl?: typeof fetch, url?: string }} [opts]
 */
export async function loadWatchTemplateRegistry(opts = {}) {
  if (cachedRegistry) return cachedRegistry;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const url = opts.url || "data/watch_templates.json";
  if (typeof fetchImpl !== "function") {
    return normalizeWatchTemplateRegistry({ templates: [] });
  }
  try {
    const r = await fetchImpl(url, { cache: "no-cache" });
    if (!r.ok) return normalizeWatchTemplateRegistry({ templates: [] });
    const j = await r.json();
    cachedRegistry = normalizeWatchTemplateRegistry(j);
    return cachedRegistry;
  } catch {
    return normalizeWatchTemplateRegistry({ templates: [] });
  }
}

/** Test helper: clear module cache. */
export function _resetWatchTemplateCache() {
  cachedRegistry = null;
}

function clean(value) {
  if (value == null) return null;
  const s = String(value).replace(/\s+/g, " ").trim();
  return s || null;
}
