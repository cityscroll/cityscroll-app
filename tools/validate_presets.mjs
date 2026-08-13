#!/usr/bin/env node
// Validate task shortcuts and rotating suggestions against the same live datasets their
// destination views use. `--write` refreshes the committed receipt and rotating-suggestion
// fallbacks; `--check` replays the receipt's resolved filters against current data and fails
// on drift.
//
// Homepage scenario-route anchors were removed (owner noise cut). Scenario hashes still live
// in the receipt and demo-links catalog for deep-link validation; this tool no longer rewrites
// or requires `<a class="scenario-route">` markup in index.html.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  deadSelectedSuggestions,
  firstNonEmptyVariant,
  fruitfulSuggestionIndices,
} from "../site/preset_validation.mjs";
import {
  FALLBACK_INDICES,
  SUGGESTION_POOL,
  suggestionCountParams,
} from "../worker/src/lib/suggestions.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INDEX = join(ROOT, "site", "index.html");
const SITE_SUGGESTIONS = join(ROOT, "site", "app", "search-share.mjs");
const RECEIPT = join(ROOT, "site", "data", "preset-validation.json");
const WORKER_SUGGESTIONS = join(ROOT, "worker", "src", "lib", "suggestions.mjs");
const WRITE = process.argv.includes("--write");
const CHECK = process.argv.includes("--check");
const NL_BASE = (process.env.CROL_WORKER_URL || "https://api.cityscroll.org").replace(/\/+$/, "");
const SODA = "https://data.cityofnewyork.us/resource/dg92-zbpx.json";
const ZAP = "https://data.cityofnewyork.us/resource/hgx4-8ukb.json";
const PAYROLL = "https://data.cityofnewyork.us/resource/k397-673e.json";
const PAYROLL_FY = 2025;
const PRESET_MIN_RESULTS = 1;
const TODAY = new Date().toISOString().slice(0, 10);
const FETCH_TIMEOUT_MS = Number(process.env.PRESET_FETCH_TIMEOUT_MS) || (process.env.CI ? 45_000 : 20_000);
const FETCH_ATTEMPTS = Number(process.env.PRESET_FETCH_ATTEMPTS) || (process.env.CI ? 4 : 2);
const FETCH_CONCURRENCY = Number(process.env.PRESET_FETCH_CONCURRENCY) || (process.env.CI ? 1 : 4);
/** Base delay for exponential backoff between live SODA retries (ms). */
const FETCH_BACKOFF_MS = Number(process.env.PRESET_FETCH_BACKOFF_MS) || (process.env.CI ? 2_000 : 500);

if (!WRITE && !CHECK) {
  throw new Error("usage: node tools/validate_presets.mjs --write|--check");
}

function addDays(iso, days) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientFetchError(error) {
  const name = String(error?.name || "");
  const message = String(error?.message || error || "");
  if (name === "TimeoutError" || name === "AbortError") return true;
  return /timeout|aborted|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed|network|socket|\b5\d\d\b|429/i.test(
    message,
  );
}

async function fetchJSON(url, options) {
  let last;
  for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        ...options,
        headers: { "User-Agent": "crol-list-preset-validation/1.0", ...options?.headers },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        const err = new Error(`${response.status} ${response.statusText}`);
        // Retry rate limits and gateway errors; fail closed on other 4xx.
        if (response.status === 429 || response.status >= 500) throw err;
        throw Object.assign(err, { permanent: true });
      }
      return await response.json();
    } catch (error) {
      last = error;
      if (error?.permanent || attempt + 1 >= FETCH_ATTEMPTS) break;
      if (!isTransientFetchError(error)) break;
      const delay = Math.min(16_000, FETCH_BACKOFF_MS * 2 ** attempt);
      console.warn(
        `TRANSIENT preset validation request failed (attempt ${attempt + 1}/${FETCH_ATTEMPTS}); ` +
        `retrying in ${delay}ms: ${error?.message || error}`,
      );
      await sleep(delay);
    }
  }
  throw new Error(
    `preset validation could not read ${new URL(url).origin} after ${FETCH_ATTEMPTS} attempt(s): ${last?.message || last}`,
  );
}

async function countQuery(url, params) {
  const rows = await fetchJSON(`${url}?${new URLSearchParams(params)}`);
  return Number(rows?.[0]?.n) || 0;
}

function sectionWhere(lens) {
  if (lens === "meetings") {
    return "(section_name='Public Hearings and Meetings' OR (section_name='Agency Rules' AND type_of_notice_description='Public Hearings' AND event_date IS NOT NULL))";
  }
  return `section_name='${lens === "property" ? "Property Disposition" : "Agency Rules"}'`;
}

function normalizeAssetParam(raw) {
  const key = String(raw || "").trim().toLowerCase().replace(/-/g, "_");
  const aliases = {
    vehequip: "vehicle",
    forest: "timber",
    realty: "real_property",
    medallion: "rights_and_interests",
    seized: "seized_property",
  };
  return aliases[key] || key;
}

function classifyAsset(record) {
  const text = `${record.short_title || ""} ${record.additional_description_1 || ""}`.toLowerCase();
  const has = (...terms) => terms.some((term) => text.includes(term));
  if (has("forest management", "board feet", "sawtimber", "cordwood", "timber", "firewood", "roundwood")) return "timber";
  if (has("auto auction", "vehicle auction", "govdeals", "iaai", "fleet auction", "municipal auto")) return "vehicle";
  if (has("heavy machinery", "machine tools", "equipment auction", "construction equipment")) return "equipment";
  if (has("surplus assets", "publicsurplus", "furniture auction")) return "equipment";
  if (has("scrap", "surplus materials", "recyclable metal")) return "scrap_materials";
  if (has("unauthorized", "tobacco", "forfeiture", "pending destruction", "property clerk", "owners are wanted", "in the custody")) return "seized_property";
  if (has("medallion", "easement")) return "rights_and_interests";
  if (has("mortgage and note", "outstanding debt") && text.includes("mortgage")) return "rights_and_interests";
  if (has("disposition area", "city-owned property", "block/lot", "residential property", "public auction", "premises", "reversionary", "real property")) return "real_property";
  if (has("rfp", "request for proposal", "redevelopment", "lease auction", "lease", "license")) return "real_property";
  return "other";
}

async function countScenarioHash(hash) {
  const [lens, query = ""] = hash.slice(1).split("?");
  const params = new URLSearchParams(query);
  const keyword = params.get("q");
  if (lens === "money") {
    const mode = params.get("mode") || "open";
    let where;
    if (mode === "award") {
      where = "type_of_notice_description='Award'";
    } else {
      where = `type_of_notice_description='Solicitation' AND due_date > '${TODAY}'`;
      if (params.get("closing") === "week") where += ` AND due_date <= '${addDays(TODAY, 7)}T23:59:59'`;
    }
    const queryParams = { "$select": "count(1) as n", "$where": where };
    if (keyword) queryParams["$q"] = keyword;
    return countQuery(SODA, queryParams);
  }
  if (lens === "people") {
    return countQuery(PAYROLL, {
      "$select": "count(1) as n",
      "$where": `fiscal_year=${PAYROLL_FY} AND base_salary > 0 AND title_description IS NOT NULL`,
    });
  }
  if (lens === "land") {
    const queryParams = { "$select": "count(1) as n", "$where": "ulurp_non='ULURP'" };
    if (keyword) queryParams["$q"] = keyword;
    return countQuery(ZAP, queryParams);
  }
  if (lens === "property" && params.get("asset")) {
    const rows = await fetchJSON(`${SODA}?${new URLSearchParams({
      "$select": "short_title,additional_description_1",
      "$where": sectionWhere("property"),
      "$order": "start_date DESC",
      "$limit": "300",
    })}`);
    const want = normalizeAssetParam(params.get("asset"));
    return rows.filter((row) => classifyAsset(row) === want).length;
  }
  if (lens === "property" || lens === "rules") {
    const queryParams = { "$select": "count(1) as n", "$where": sectionWhere(lens) };
    if (keyword) queryParams["$q"] = keyword;
    return countQuery(SODA, queryParams);
  }
  if (lens === "meetings") {
    let where = sectionWhere("meetings");
    const when = params.get("when") || "week";
    if (when === "past") {
      where += ` AND event_date < '${TODAY}'`;
    } else {
      where += ` AND event_date >= '${TODAY}'`;
      if (when === "week") where += ` AND event_date <= '${addDays(TODAY, 7)}T23:59:59'`;
      if (when === "month") where += ` AND event_date <= '${addDays(TODAY, 30)}T23:59:59'`;
    }
    const queryParams = { "$select": "count(1) as n", "$where": where };
    if (keyword) queryParams["$q"] = keyword;
    return countQuery(SODA, queryParams);
  }
  throw new Error(`no preset counter for ${hash}`);
}

const SCENARIOS = [
  { id: "city-work-closing", variants: [
    { id: "week", href: "#money?mode=open&closing=week", labelKey: "closing_this_week", label: "Closing this week" },
    { id: "open", href: "#money?mode=open", labelKey: "scenario_open_contracts", label: "Open contracts" },
    { id: "past", href: "#money?mode=award", labelKey: "scenario_recent_awards", label: "Recent awards" },
  ] },
  { id: "city-work-all", variants: [{ id: "open", href: "#money?mode=open", labelKey: "tab_money", label: "Contracts" }] },
  { id: "neighborhood-land", variants: [{ id: "land", href: "#land", labelKey: "tab_land", label: "Zoning" }] },
  { id: "neighborhood-property", variants: [{ id: "property", href: "#property", labelKey: "tab_property", label: "Property" }] },
  { id: "neighborhood-meetings", variants: [{ id: "upcoming", href: "#meetings?when=upcoming", labelKey: "tab_meetings", label: "Meetings" }] },
  { id: "hearings-meetings", variants: [{ id: "upcoming", href: "#meetings?when=upcoming", labelKey: "tab_meetings", label: "Meetings" }] },
  { id: "hearings-rules", variants: [{ id: "rules", href: "#rules", labelKey: "tab_rules", label: "Rules" }] },
  { id: "city-career-people", variants: [{ id: "people", href: "#people", labelKey: "tab_people", label: "Staffing" }] },
  { id: "subsidies-ida", variants: [
    { id: "week", href: "#meetings?when=week&q=IDA", labelKey: "scenario_ida_week", label: "IDA meetings this week" },
    { id: "month", href: "#meetings?when=month&q=IDA", labelKey: "scenario_ida_month", label: "IDA meetings this month" },
    { id: "upcoming", href: "#meetings?when=upcoming&q=IDA", labelKey: "scenario_ida_upcoming", label: "Upcoming IDA meetings" },
    { id: "past", href: "#meetings?when=past&q=IDA", labelKey: "scenario_ida_past", label: "Past IDA meetings" },
  ] },
  { id: "subsidies-land", variants: [{ id: "land", href: "#land", labelKey: "tab_land", label: "Zoning" }] },
  { id: "legal-property", variants: [
    { id: "realty", href: "#property?asset=real_property", labelKey: "tab_property", label: "Property" },
    { id: "all", href: "#property", labelKey: "tab_property", label: "Property" },
  ] },
  { id: "legal-rules", variants: [{ id: "rules", href: "#rules", labelKey: "tab_rules", label: "Rules" }] },
  { id: "legal-meetings", variants: [{ id: "upcoming", href: "#meetings?when=upcoming", labelKey: "tab_meetings", label: "Meetings" }] },
];

async function validateLiveScenarios() {
  const countMemo = new Map();
  async function count(variant) {
    if (!countMemo.has(variant.href)) countMemo.set(variant.href, countScenarioHash(variant.href));
    return countMemo.get(variant.href);
  }
  const output = {};
  for (const preset of SCENARIOS) {
    const counts = {};
    for (const variant of preset.variants) counts[variant.id] = await count(variant);
    const selected = firstNonEmptyVariant(preset.variants, counts);
    if (!selected) throw new Error(`preset ${preset.id} has no non-empty fallback`);
    output[preset.id] = { ...selected, counts };
  }
  return output;
}

function validScenarioSnapshot(snapshot) {
  return Boolean(
    snapshot &&
      typeof snapshot === "object" &&
      SCENARIOS.every((preset) => {
        const selected = snapshot[preset.id];
        return (
          selected &&
          preset.variants.some((variant) => variant.id === selected.id && variant.href === selected.href) &&
          Number(selected.count) >= PRESET_MIN_RESULTS &&
          selected.counts &&
          typeof selected.counts === "object"
        );
      }),
  );
}

async function validateScenarios(previous) {
  try {
    return await validateLiveScenarios();
  } catch (error) {
    if (CHECK && isTransientFetchError(error) && validScenarioSnapshot(previous?.scenarios)) {
      console.warn(
        `TRANSIENT preset validation outage; using committed scenario snapshot ` +
          `${previous.dataDate || "without data date"} after ${FETCH_ATTEMPTS} bounded attempt(s)`,
      );
      return previous.scenarios;
    }
    throw error;
  }
}

async function resolveSuggestion(candidate) {
  const payload = await fetchJSON(`${NL_BASE}/nl`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lens: candidate.lens, text: candidate.text }),
  });
  if (!payload?.filter) throw new Error(`could not resolve ${candidate.lens}:${candidate.idx} ${candidate.text}`);
  return payload.filter;
}

async function countSuggestion(candidate, filter) {
  const query = suggestionCountParams(candidate.lens, filter, TODAY);
  if (!query) return 0;
  return countQuery(query.url, query.params);
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function validateLiveSuggestions(previous) {
  const previousByKey = new Map(
    (previous?.candidates || []).map((candidate) => [`${candidate.lens}:${candidate.idx}`, candidate]),
  );
  const candidates = await mapLimit(SUGGESTION_POOL, FETCH_CONCURRENCY, async (candidate) => {
    const prior = previousByKey.get(`${candidate.lens}:${candidate.idx}`);
    if (CHECK && (!prior || prior.text !== candidate.text)) {
      throw new Error(`suggestion receipt is missing or stale for ${candidate.lens}:${candidate.idx}`);
    }
    const filter = CHECK ? prior.filter : await resolveSuggestion(candidate);
    const count = await countSuggestion(candidate, filter);
    return { ...candidate, filter, count };
  });
  const byLens = fruitfulSuggestionIndices(candidates, PRESET_MIN_RESULTS);
  for (const lens of ["money", "people", "land", "property", "rules", "meetings", "alerts"]) {
    if ((byLens[lens] || []).length < 1) throw new Error(`no fruitful rotating suggestion remains for ${lens}`);
  }
  if (deadSelectedSuggestions(byLens, candidates, PRESET_MIN_RESULTS).length) {
    throw new Error("a generated rotating suggestion has no current results");
  }
  return { minResults: PRESET_MIN_RESULTS, byLens, candidates };
}

function validSuggestionSnapshot(snapshot) {
  const lenses = ["money", "people", "land", "property", "rules", "meetings", "alerts"];
  const poolByKey = new Map(SUGGESTION_POOL.map((candidate) => [`${candidate.lens}:${candidate.idx}`, candidate]));
  return Boolean(
    snapshot &&
      Array.isArray(snapshot.candidates) &&
      snapshot.candidates.length === SUGGESTION_POOL.length &&
      snapshot.candidates.every((candidate) => {
        const poolCandidate = poolByKey.get(`${candidate.lens}:${candidate.idx}`);
        return Boolean(
          poolCandidate &&
            candidate.text === poolCandidate.text &&
            typeof candidate.text === "string" &&
            candidate.filter &&
            typeof candidate.filter === "object" &&
            Number.isFinite(Number(candidate.count)),
        );
      }) &&
      snapshot.byLens &&
      lenses.every((lens) => Array.isArray(snapshot.byLens[lens]) && snapshot.byLens[lens].length > 0),
  );
}

async function validateSuggestions(previousSuggestions, snapshotDate) {
  try {
    return await validateLiveSuggestions(previousSuggestions);
  } catch (error) {
    if (CHECK && isTransientFetchError(error) && validSuggestionSnapshot(previousSuggestions)) {
      console.warn(
        `TRANSIENT preset suggestion outage; using committed suggestion snapshot ` +
          `${snapshotDate || "without data date"} after ${FETCH_ATTEMPTS} bounded attempt(s)`,
      );
      return previousSuggestions;
    }
    throw error;
  }
}

function htmlHref(value) {
  return value.replace(/&/g, "&amp;");
}

function routeFromHTML(html, id) {
  // Optional: homepage no longer ships scenario-route anchors. When present (legacy / branch),
  // return them so write mode can still rewrite; when absent, callers use the receipt only.
  const pattern = new RegExp(`<a class="scenario-route" href="([^"]+)" data-preset-id="${id}"[^>]* data-i18n="([^"]+)">([^<]*)</a>`);
  const match = html.match(pattern);
  if (!match) return null;
  return { href: match[1].replace(/&amp;/g, "&"), labelKey: match[2], label: match[3] };
}

function replaceRoute(html, id, selected) {
  const pattern = new RegExp(`(<a class="scenario-route" )href="[^"]+"( data-preset-id="${id}"[^>]* data-i18n=")[^"]+(">)[^<]*(</a>)`);
  if (!pattern.test(html)) return html; // no homepage scenario markup to rewrite
  return html.replace(
    pattern,
    `$1href="${htmlHref(selected.href)}"$2${selected.labelKey}$3${selected.label}$4`,
  );
}

function fallbackBlock(byLens) {
  const order = ["money", "people", "land", "property", "rules", "meetings", "alerts"];
  return `const NL_SUGGESTIONS_FALLBACK = {\n${order.map((lens) => `  ${lens}: [${(byLens[lens] || []).join(", ")}],`).join("\n")}\n};`;
}

function workerFallbackBlock(byLens) {
  return `export const FALLBACK_INDICES = {\n${Object.entries(byLens).map(([lens, indices]) => `  ${lens}: [${indices.join(", ")}],`).join("\n")}\n};`;
}

function replaceSiteFallback(source, byLens) {
  const pattern = /const NL_SUGGESTIONS_FALLBACK = \{[\s\S]*?\n\};/;
  if (!pattern.test(source)) throw new Error("search-share.mjs is missing NL_SUGGESTIONS_FALLBACK");
  return source.replace(pattern, fallbackBlock(byLens));
}

function replaceWorkerFallback(source, byLens) {
  const pattern = /export const FALLBACK_INDICES = \{[\s\S]*?\n\};/;
  if (!pattern.test(source)) throw new Error("worker suggestions module is missing FALLBACK_INDICES");
  return source.replace(pattern, workerFallbackBlock(byLens));
}

function fallbackFromSiteSource(source) {
  const match = source.match(/const NL_SUGGESTIONS_FALLBACK = \{([\s\S]*?)\n\};/);
  if (!match) throw new Error("search-share.mjs is missing NL_SUGGESTIONS_FALLBACK");
  const byLens = {};
  for (const item of match[1].matchAll(/^\s*([a-z]+):\s*\[([^\]]*)\]/gm)) {
    byLens[item[1]] = item[2].split(",").map((value) => Number(value.trim())).filter(Number.isFinite);
  }
  return byLens;
}

const previous = await readFile(RECEIPT, "utf8").then(JSON.parse).catch(() => null);
// Keep scenario and suggestion validation sequential. Both hit NYC Open Data; bursting the
// upstream API from shared CI runners caused avoidable timeouts and must not turn a truthful
// fail-closed gate into a flaky one.
const scenarios = await validateScenarios(previous);
const suggestions = await validateSuggestions(previous?.suggestions, previous?.dataDate);
let html = await readFile(INDEX, "utf8");
let siteSuggestions = await readFile(SITE_SUGGESTIONS, "utf8");
let workerSource = await readFile(WORKER_SUGGESTIONS, "utf8");

if (CHECK) {
  // When homepage still has scenario-route anchors, they must match the live-validated
  // receipt. When they are absent (current product surface), only receipt + fallbacks gate.
  for (const [id, selected] of Object.entries(scenarios)) {
    const actual = routeFromHTML(html, id);
    if (!actual) continue;
    if (actual.href !== selected.href || actual.labelKey !== selected.labelKey) {
      throw new Error(`${id} is stale: expected ${selected.href} (${selected.labelKey})`);
    }
  }
  const actualFallback = fallbackFromSiteSource(siteSuggestions);
  if (JSON.stringify(actualFallback) !== JSON.stringify(suggestions.byLens)) {
    throw new Error("rotating suggestion fallback is stale; run node tools/validate_presets.mjs --write");
  }
  if (JSON.stringify(FALLBACK_INDICES) !== JSON.stringify(suggestions.byLens)) {
    throw new Error("worker rotating suggestion fallback is stale; run node tools/validate_presets.mjs --write");
  }
  console.log(`preset validation green for ${Object.keys(scenarios).length} shortcuts and ${suggestions.candidates.length} suggestions (${TODAY})`);
} else {
  for (const [id, selected] of Object.entries(scenarios)) html = replaceRoute(html, id, selected);
  siteSuggestions = replaceSiteFallback(siteSuggestions, suggestions.byLens);
  workerSource = replaceWorkerFallback(workerSource, suggestions.byLens);
  await writeFile(INDEX, html);
  await writeFile(SITE_SUGGESTIONS, siteSuggestions);
  await writeFile(WORKER_SUGGESTIONS, workerSource);
  const receipt = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    dataDate: TODAY,
    scenarios,
    suggestions,
  };
  await writeFile(RECEIPT, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`wrote ${RECEIPT.slice(ROOT.length + 1)} and refreshed ${Object.keys(scenarios).length} shortcuts`);
}
