// Procurement-plan index watch: pure comparison of the two MOCS index pages
// against what the committed planning manifest recorded at collection.
//
// The collector (warehouse/scripts/procurement_plans_run.py) records, per
// workbook, the url, link label, sha256 and plan_rows it found on each index
// page, filtered to the collected fiscal-year folder (parse_plan_index in
// warehouse/lib/procurement_plans.py). It also records the index page sha256,
// but the pages carry dynamic markup, so a page hash differs on every fetch and
// is useless for change detection. This module compares the workbook LINK SET
// and, once the collector also records it, the per-link "updated" /
// "Posted on" text. A page that could not be fetched is could_not_check and is
// never counted as unchanged.

export const PLAN_INDEX_WATCH_SCHEMA = "cityscroll.procurement_plan_index_watch.v1";
export const INDEX_SOURCES = Object.freeze({
  mocs_ll1: "mocs_ll1_index",
  mocs_ll63: "mocs_ll63_index",
});

const decodeEntities = (text) => String(text)
  .replace(/&nbsp;/g, " ")
  .replace(/&amp;/g, "&")
  .replace(/&#39;|&apos;|&rsquo;|&#8217;/g, "'")
  .replace(/&quot;/g, "\"")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">");
const cleanText = (text) => decodeEntities(String(text).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

/** Fiscal year a workbook link belongs to, from its MOCS folder (/fy27/ or /2027fy/). */
export function fiscalYearOfUrl(url) {
  const path = String(url).toLowerCase();
  const ll1 = /\/fy(\d{2})\//.exec(path);
  if (ll1) return 2000 + Number(ll1[1]);
  const ll63 = /\/(\d{4})fy\//.exec(path);
  if (ll63) return Number(ll63[1]);
  return null;
}

/**
 * Every .xlsx link on an index page with its label and the trailing
 * parenthetical note ("(updated 6/30/2026)", "(Posted on 07/27/2026)").
 * Relative hrefs resolve against baseUrl, as urljoin does in the collector.
 */
export function extractIndexLinks(html, baseUrl) {
  const out = new Map();
  const re = /<a\b[^>]*\bhref\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/a>([^<]*)/gi;
  let match;
  while ((match = re.exec(String(html)))) {
    const href = decodeEntities(match[1]).trim();
    if (!/\.xlsx$/i.test(href.split("?")[0])) continue;
    let url;
    try { url = new URL(href, baseUrl).href; } catch { continue; }
    const note = /\((?:updated|posted on)[^)]*\)/i.exec(match[3]);
    if (!out.has(url)) out.set(url, { url, label: cleanText(match[2]), note: note ? note[0].replace(/\s+/g, " ").trim() : null });
  }
  return [...out.values()].sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
}

/** What the manifest recorded for one index: its url and the workbook set collected from it. */
export function recordedIndex(manifest, source) {
  const sources = Array.isArray(manifest?.sources) ? manifest.sources : [];
  const index = sources.find((s) => s.source === INDEX_SOURCES[source]);
  const workbooks = sources.filter((s) => s.source === source).map((s) => ({
    url: s.url,
    label: s.label ?? null,
    note: s.index_note ?? null,
    note_recorded: Object.hasOwn(s, "index_note"),
  }));
  return { url: index?.url ?? null, workbooks };
}

/**
 * Compare one index page observation with the manifest.
 * observation: { ok: true, html } | { ok: false, reason }
 */
export function compareIndex(manifest, source, observation) {
  const recorded = recordedIndex(manifest, source);
  const fiscalYear = manifest?.fiscal_year;
  const base = { source, url: recorded.url, fiscal_year: fiscalYear };
  if (!recorded.url || !recorded.workbooks.length) {
    return { ...base, status: "could_not_check", reason: "manifest records no index or workbooks for this source" };
  }
  if (!observation || observation.ok !== true || typeof observation.html !== "string") {
    return { ...base, status: "could_not_check", reason: observation?.reason || "not observed" };
  }
  const links = extractIndexLinks(observation.html, recorded.url);
  if (!links.length) {
    // A page with no workbook links at all is a page we could not read, not an empty publication.
    return { ...base, status: "could_not_check", reason: "no workbook links found on the page" };
  }
  const current = links.filter((l) => fiscalYearOfUrl(l.url) === fiscalYear);
  const newer = [...new Set(links.map((l) => fiscalYearOfUrl(l.url)).filter((fy) => fy != null && fy > fiscalYear))].sort();
  const recordedUrls = new Set(recorded.workbooks.map((w) => w.url));
  const currentUrls = new Set(current.map((l) => l.url));
  const added = current.filter((l) => !recordedUrls.has(l.url)).map((l) => ({ url: l.url, label: l.label, note: l.note }));
  const removed = recorded.workbooks.filter((w) => !currentUrls.has(w.url)).map((w) => ({ url: w.url, label: w.label }));
  const noteChanges = [];
  let notesNotRecorded = 0;
  for (const w of recorded.workbooks) {
    const seen = current.find((l) => l.url === w.url);
    if (!seen) continue;
    if (!w.note_recorded) { notesNotRecorded += 1; continue; }
    if ((w.note ?? null) !== (seen.note ?? null)) noteChanges.push({ url: w.url, recorded: w.note, observed: seen.note });
  }
  const changed = added.length > 0 || removed.length > 0 || noteChanges.length > 0 || newer.length > 0;
  return {
    ...base,
    status: changed ? "changed" : "unchanged",
    recorded_workbooks: recorded.workbooks.length,
    observed_workbooks: current.length,
    added,
    removed,
    note_changes: noteChanges,
    notes_not_recorded: notesNotRecorded,
    new_fiscal_years: newer,
  };
}

/** One receipt over both index pages. observations: { mocs_ll1, mocs_ll63 }. */
export function comparePlanIndexes(manifest, observations, { checkedAt = null } = {}) {
  const indexes = Object.keys(INDEX_SOURCES).map((source) => compareIndex(manifest, source, observations?.[source]));
  const changes = indexes.filter((i) => i.status === "changed").length;
  const couldNot = indexes.filter((i) => i.status === "could_not_check").length;
  const summary = changes && couldNot ? "changed_and_could_not_check"
    : changes ? "changed"
      : couldNot ? "could_not_check" : "unchanged";
  return {
    schema: PLAN_INDEX_WATCH_SCHEMA,
    checked_at: checkedAt,
    manifest_generated_at: manifest?.generated_at ?? null,
    fiscal_year: manifest?.fiscal_year ?? null,
    summary,
    changes_found: changes > 0,
    could_not_check: couldNot > 0,
    indexes,
  };
}
