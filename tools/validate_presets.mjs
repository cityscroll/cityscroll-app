#!/usr/bin/env node
// Validate task shortcuts and rotating suggestions against the same live datasets their
// destination views use. `--write` refreshes the committed receipt and generated HTML choices;
// `--check` replays the receipt's resolved filters against current data and fails on drift.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  deadSelectedSuggestions,
  firstNonEmptyVariant,
  fruitfulSuggestionIndices,
} from "../preset_validation.mjs";
import {
  FALLBACK_INDICES,
  SUGGESTION_POOL,
  suggestionCountParams,
} from "../worker/src/lib/suggestions.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INDEX = join(ROOT, "index.html");
const RECEIPT = join(ROOT, "data", "preset-validation.json");
const WORKER_SUGGESTIONS = join(ROOT, "worker", "src", "lib", "suggestions.mjs");
const WRITE = process.argv.includes("--write");
const CHECK = process.argv.includes("--check");
const NL_BASE = (process.env.CROL_WORKER_URL || "https://api.crol-list.org").replace(/\/+$/, "");
const SODA = "https://data.cityofnewyork.us/resource/dg92-zbpx.json";
const ZAP = "https://data.cityofnewyork.us/resource/hgx4-8ukb.json";
const PAYROLL = "https://data.cityofnewyork.us/resource/k397-673e.json";
const PAYROLL_FY = 2025;
const PRESET_MIN_RESULTS = 1;
const TODAY = new Date().toISOString().slice(0, 10);

if (!WRITE && !CHECK) {
  throw new Error("usage: node tools/validate_presets.mjs --write|--check");
}

function addDays(iso, days) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function fetchJSON(url, options) {
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(url, { ...options, signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return await response.json();
    } catch (error) {
      last = error;
    }
  }
  throw new Error(`preset validation could not read ${new URL(url).origin}: ${last?.message || last}`);
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

function classifyAsset(record) {
  const text = `${record.short_title || ""} ${record.additional_description_1 || ""}`.toLowerCase();
  const has = (...terms) => terms.some((term) => text.includes(term));
  if (has("forest management", "board feet", "sawtimber", "cordwood", "timber")) return "forest";
  if (has("medallion")) return "medallion";
  if (has("auto auction", "heavy machinery", "fleet", "iaai")) return "vehequip";
  if (has("unauthorized", "tobacco", "forfeiture", "pending destruction", "property clerk", "owners are wanted", "in the custody")) return "seized";
  if (has("surplus assets", "machine tools", "furniture", "publicsurplus")) return "vehequip";
  if (text.includes("easement")) return "other";
  if (has("mortgage and note", "outstanding debt") && text.includes("mortgage")) return "other";
  if (has("disposition area", "city-owned property", "block/lot", "residential property", "public auction", "premises", "reversionary")) return "realty";
  if (has("rfp", "request for proposal", "redevelopment", "lease auction", "lease", "license")) return "realty";
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
    return rows.filter((row) => classifyAsset(row) === params.get("asset")).length;
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
    { id: "realty", href: "#property?asset=realty", labelKey: "tab_property", label: "Property" },
    { id: "all", href: "#property", labelKey: "tab_property", label: "Property" },
  ] },
  { id: "legal-rules", variants: [{ id: "rules", href: "#rules", labelKey: "tab_rules", label: "Rules" }] },
  { id: "legal-meetings", variants: [{ id: "upcoming", href: "#meetings?when=upcoming", labelKey: "tab_meetings", label: "Meetings" }] },
];

async function validateScenarios() {
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

async function validateSuggestions(previous) {
  const previousByKey = new Map(
    (previous?.candidates || []).map((candidate) => [`${candidate.lens}:${candidate.idx}`, candidate]),
  );
  const candidates = await mapLimit(SUGGESTION_POOL, 4, async (candidate) => {
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

function htmlHref(value) {
  return value.replace(/&/g, "&amp;");
}

function routeFromHTML(html, id) {
  const pattern = new RegExp(`<a class="scenario-route" href="([^"]+)" data-preset-id="${id}"[^>]* data-i18n="([^"]+)">([^<]*)</a>`);
  const match = html.match(pattern);
  if (!match) throw new Error(`index.html is missing data-preset-id="${id}"`);
  return { href: match[1].replace(/&amp;/g, "&"), labelKey: match[2], label: match[3] };
}

function replaceRoute(html, id, selected) {
  const pattern = new RegExp(`(<a class="scenario-route" )href="[^"]+"( data-preset-id="${id}"[^>]* data-i18n=")[^"]+(">)[^<]*(</a>)`);
  if (!pattern.test(html)) throw new Error(`index.html is missing generated route ${id}`);
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

function replaceFallbackBlock(html, byLens) {
  const pattern = /const NL_SUGGESTIONS_FALLBACK = \{[\s\S]*?\n\};/;
  if (!pattern.test(html)) throw new Error("index.html is missing NL_SUGGESTIONS_FALLBACK");
  return html.replace(pattern, fallbackBlock(byLens));
}

function replaceWorkerFallback(source, byLens) {
  const pattern = /export const FALLBACK_INDICES = \{[\s\S]*?\n\};/;
  if (!pattern.test(source)) throw new Error("worker suggestions module is missing FALLBACK_INDICES");
  return source.replace(pattern, workerFallbackBlock(byLens));
}

function fallbackFromHTML(html) {
  const match = html.match(/const NL_SUGGESTIONS_FALLBACK = \{([\s\S]*?)\n\};/);
  if (!match) throw new Error("index.html is missing NL_SUGGESTIONS_FALLBACK");
  const byLens = {};
  for (const item of match[1].matchAll(/^\s*([a-z]+):\s*\[([^\]]*)\]/gm)) {
    byLens[item[1]] = item[2].split(",").map((value) => Number(value.trim())).filter(Number.isFinite);
  }
  return byLens;
}

const previous = await readFile(RECEIPT, "utf8").then(JSON.parse).catch(() => null);
const [scenarios, suggestions] = await Promise.all([
  validateScenarios(),
  validateSuggestions(previous?.suggestions),
]);
let html = await readFile(INDEX, "utf8");
let workerSource = await readFile(WORKER_SUGGESTIONS, "utf8");

if (CHECK) {
  for (const [id, selected] of Object.entries(scenarios)) {
    const actual = routeFromHTML(html, id);
    if (actual.href !== selected.href || actual.labelKey !== selected.labelKey) {
      throw new Error(`${id} is stale: expected ${selected.href} (${selected.labelKey})`);
    }
  }
  const actualFallback = fallbackFromHTML(html);
  if (JSON.stringify(actualFallback) !== JSON.stringify(suggestions.byLens)) {
    throw new Error("rotating suggestion fallback is stale; run node tools/validate_presets.mjs --write");
  }
  if (JSON.stringify(FALLBACK_INDICES) !== JSON.stringify(suggestions.byLens)) {
    throw new Error("worker rotating suggestion fallback is stale; run node tools/validate_presets.mjs --write");
  }
  console.log(`preset validation green for ${Object.keys(scenarios).length} shortcuts and ${suggestions.candidates.length} suggestions (${TODAY})`);
} else {
  for (const [id, selected] of Object.entries(scenarios)) html = replaceRoute(html, id, selected);
  html = replaceFallbackBlock(html, suggestions.byLens);
  workerSource = replaceWorkerFallback(workerSource, suggestions.byLens);
  await writeFile(INDEX, html);
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
