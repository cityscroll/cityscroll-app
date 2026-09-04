#!/usr/bin/env node
/**
 * SEQRA-04: CEQR Access discovery probe.
 *
 * `--discover` performs a small, bounded, polite sequence of live HTTP
 * requests against the real CEQR Access site (a002-ceqraccess.nyc.gov) --
 * matching this repository's existing discovery_probe convention
 * (tools/build_seqra_source_inventory.mjs) but going one step further than a
 * single reachability GET: it also submits the public search form (once
 * blank, once with a real dropdown value) so the discovery receipt can
 * record actually-observed search behavior, not just "the base URL answers."
 * Every request is spaced by a polite delay, uses a bounded per-request
 * timeout, and is never retried on failure -- a timeout or an error is
 * itself a recorded observation, not a reason to hammer the source again.
 *
 * Default mode (no flag) rebuilds the receipt deterministically from the
 * retained observation fixture written by the last `--discover` run, so
 * tests and CI never touch the network. `--check` diffs against the
 * committed receipt, matching every other warehouse builder's `--check`
 * convention.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildFetchReceipt, contentHashOf, makeFetchIdSequence } from "../warehouse/lib/seqra_fetch_receipt.mjs";
import { buildCeqrAccessDiscoveryReceipt, CEQR_ACCESS_SOURCE_ID } from "../warehouse/lib/seqra_ceqr_access_discovery.mjs";
import { getSeqraSourceRegistryEntry } from "../warehouse/lib/seqra_source_registry.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OBSERVATION = path.join(ROOT, "warehouse/fixtures/seqra-ceqr-access/discovery_observation.v1.json");
const RECEIPT = path.join(ROOT, "warehouse/receipts/proof/seqra_ceqr_access_discovery_latest.json");
const RAW_ROOT = path.join(ROOT, "warehouse/raw/seqra-ceqr-access/discovery");

const USER_AGENT = "CityScrollSeqraDocumentPipeline/1.0 (+https://cityscroll.org; SEQRA-04 discovery probe)";
const POLITE_DELAY_MS = 1000;
const REQUEST_TIMEOUT_MS = 15000;
const BASE_URL = "https://a002-ceqraccess.nyc.gov";
const DROPDOWN_UNSELECTED = "XYU@2!"; // observed sentinel value for every "-- Select --" option

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}
function stringify(value) {
  return `${JSON.stringify(stable(value), null, 2)}\n`;
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const nextFetchId = makeFetchIdSequence("seqra04-discovery-fetch");

/** Extract every ASP.NET WebForms hidden postback field from a page's HTML. */
function extractHiddenField(html, name) {
  const re = new RegExp(`id="${name}"[^>]*value="([^"]*)"`);
  const match = re.exec(html);
  if (!match) return null;
  return match[1]
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function extractCookies(headers) {
  const raw = headers.getSetCookie ? headers.getSetCookie() : (headers.raw?.()["set-cookie"] ?? []);
  const jar = {};
  for (const entry of raw) {
    const [pair] = entry.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return jar;
}
function cookieHeader(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
}

function extractSearchFormShape(html) {
  const inputFields = [...html.matchAll(/<input name="ctl00\$MainContent\$(tx[tT][A-Za-z]+)"[^>]*type="text"/g)].map((m) => m[1]);
  const selectFields = [...html.matchAll(/<select name="ctl00\$MainContent\$(ddl[A-Za-z]+)"/g)].map((m) => m[1]);
  const submitMatch = /<input type="submit" name="ctl00\$MainContent\$(btn[A-Za-z]+)"/.exec(html);
  const formActionMatch = /<form method="post" action="([^"]*)" id="MyForm"/.exec(html);
  return {
    method: formActionMatch ? "post" : null,
    action: formActionMatch ? formActionMatch[1] : null,
    requires_postback_tokens: /__VIEWSTATE/.test(html) && /__EVENTVALIDATION/.test(html),
    postback_token_fields: ["__VIEWSTATE", "__VIEWSTATEGENERATOR", "__VIEWSTATEENCRYPTED", "__EVENTVALIDATION"].filter((f) => html.includes(`id="${f}"`)),
    input_fields: inputFields,
    select_fields: selectFields,
    submit_field: submitMatch ? submitMatch[1] : null,
  };
}

function extractDefaultDropdownOption(html, selectName) {
  const re = new RegExp(`<select name="ctl00\\$MainContent\\$${selectName}"[^>]*>([\\s\\S]*?)</select>`);
  const block = re.exec(html)?.[1] ?? "";
  const first = /<option[^>]*value="([^"]*)"/.exec(block);
  return first ? first[1] : DROPDOWN_UNSELECTED;
}

function countResultRows(html) {
  // The unauthenticated search page itself always carries a small, fixed
  // number of structural (nav/footer) <tr> rows even with zero results; this
  // count is reported raw, not asserted as a validated results-table count.
  return (html.match(/<tr[^>]*>/g) ?? []).length;
}

/** One bounded, timed-out-safe HTTP request; never retried by this function. */
async function boundedRequest({ purpose, url, method = "GET", body = null, headers = {}, rawSlug }) {
  const fetchId = nextFetchId();
  const requestedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response = null;
  let text = "";
  let warnings = [];
  let errorMessage = null;
  try {
    response = await fetch(url, {
      method,
      body,
      headers: { "User-Agent": USER_AGENT, ...headers },
      signal: controller.signal,
      redirect: "follow",
    });
    text = await response.text();
  } catch (error) {
    errorMessage = error.name === "AbortError" ? `request timed out after ${REQUEST_TIMEOUT_MS}ms` : `request failed: ${error.message}`;
    warnings.push(errorMessage);
  } finally {
    clearTimeout(timer);
  }
  const latencyMs = Date.now() - startedAtMs;
  const retrievedAt = new Date().toISOString();
  const byteCount = Buffer.byteLength(text, "utf8");
  const contentHash = text ? contentHashOf(text) : null;
  const contentType = response?.headers.get("content-type") ?? null;
  const cookies = response ? extractCookies(response.headers) : {};

  let rawRelPath = null;
  if (text) {
    rawRelPath = path.posix.join("warehouse/raw/seqra-ceqr-access/discovery", `${rawSlug}.html`);
    const rawAbsPath = path.join(ROOT, rawRelPath);
    mkdirSync(path.dirname(rawAbsPath), { recursive: true });
    writeFileSync(rawAbsPath, text);
  }

  const fetchReceipt = buildFetchReceipt({
    fetchId,
    sourceId: CEQR_ACCESS_SOURCE_ID,
    requestedAt,
    requestUrlOrQuery: url,
    httpStatus: response?.status ?? null,
    retrievedAt,
    contentType,
    byteCount: text ? byteCount : null,
    contentHash,
    rawObjectPath: rawRelPath,
    rowOrDocumentCount: 0,
    paginationComplete: true,
    parserVersion: "seqra04_ceqr_access_discovery.v1",
    warnings,
    latencyMs,
    purpose,
  });

  return { fetchReceipt, html: text, cookies, ok: response?.ok === true, errorMessage, finalUrl: response?.url ?? url, httpStatus: response?.status ?? null };
}

async function runDiscoverySequence() {
  const probes = [];

  // 1. robots.txt -- politeness/compliance check before anything else.
  const robots = await boundedRequest({ purpose: "robots_txt_check", url: `${BASE_URL}/robots.txt`, rawSlug: "01_robots_txt" });
  probes.push({
    purpose: robots.fetchReceipt.purpose,
    fetch: robots.fetchReceipt,
    observation: {
      type: "unmapped_path_behavior",
      path_checked: "/robots.txt",
      note: robots.html.includes("Page Not Found")
        ? "No robots.txt is published; the site's ASP.NET pipeline answers an unmapped path with HTTP 200 and a soft-404 HTML body rather than a real 404 status, so HTTP status alone cannot distinguish a real page from a missing one on this host."
        : "robots.txt returned content different from the observed soft-404 shell; see raw_object_path for the captured body.",
    },
  });
  await sleep(POLITE_DELAY_MS);

  // 2. Home page -- find the actual search-page link rather than assuming a path.
  const home = await boundedRequest({ purpose: "home_page", url: `${BASE_URL}/`, rawSlug: "02_home" });
  const homeLinks = [...home.html.matchAll(/<a[^>]*href="([^"]+)"[^>]*>/g)].map((m) => m[1]);
  const searchLinkCandidate = homeLinks.find((href) => /^ceqr$/i.test(href)) ?? null;
  probes.push({
    purpose: home.fetchReceipt.purpose,
    fetch: home.fetchReceipt,
    observation: {
      type: "unmapped_path_behavior",
      path_checked: "/",
      note: searchLinkCandidate
        ? `Home page's only in-app navigation link is a relative href to "${searchLinkCandidate}"; every other anchor points off-domain (nyc.gov shell chrome).`
        : "Home page did not carry the expected relative link to the search interface.",
    },
  });
  await sleep(POLITE_DELAY_MS);
  if (!searchLinkCandidate) {
    return { probes, cookies: home.cookies, lastSearchHtml: null };
  }

  // 3. Follow the discovered link to the actual search page. POST submissions
  //    below target the *post-redirect* URL (response.url) -- a 301 GET
  //    redirect from the bare link does not mean a POST to that same bare
  //    link is accepted; ASP.NET answered a direct POST to the pre-redirect
  //    path with 405 Method Not Allowed in an earlier run of this probe.
  const searchUrlCandidate = new URL(searchLinkCandidate, `${BASE_URL}/`).toString();
  const search = await boundedRequest({ purpose: "search_page", url: searchUrlCandidate, rawSlug: "03_search_page" });
  const searchUrl = search.finalUrl;
  const cookies = { ...home.cookies, ...search.cookies };
  const formShape = extractSearchFormShape(search.html);
  probes.push({
    purpose: search.fetchReceipt.purpose,
    fetch: search.fetchReceipt,
    observation: { type: "search_form", ...formShape },
  });
  await sleep(POLITE_DELAY_MS);

  if (!formShape.requires_postback_tokens) {
    return { probes, cookies, lastSearchHtml: search.html };
  }

  // 4. Submit the search form with every criterion blank -- observes whether
  //    a no-criteria submission enumerates a bulk listing.
  const blankBody = new URLSearchParams({
    __VIEWSTATE: extractHiddenField(search.html, "__VIEWSTATE") ?? "",
    __VIEWSTATEGENERATOR: extractHiddenField(search.html, "__VIEWSTATEGENERATOR") ?? "",
    __VIEWSTATEENCRYPTED: extractHiddenField(search.html, "__VIEWSTATEENCRYPTED") ?? "",
    __EVENTVALIDATION: extractHiddenField(search.html, "__EVENTVALIDATION") ?? "",
    "ctl00$MainContent$txtKeyword": "",
    "ctl00$MainContent$txtCeqrNumber": "",
    "ctl00$MainContent$txtProjectName": "",
    "ctl00$MainContent$txtBlock": "",
    "ctl00$MainContent$txtLot": "",
    "ctl00$MainContent$ddlLeadAgency": extractDefaultDropdownOption(search.html, "ddlLeadAgency"),
    "ctl00$MainContent$ddlCommunityDistrict": extractDefaultDropdownOption(search.html, "ddlCommunityDistrict"),
    "ctl00$MainContent$ddlBorough": extractDefaultDropdownOption(search.html, "ddlBorough"),
    "ctl00$MainContent$btnSearch": " Search",
  }).toString();
  const blankSearch = await boundedRequest({
    purpose: "blank_search_submission",
    url: searchUrl,
    method: "POST",
    body: blankBody,
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookieHeader(cookies) },
    rawSlug: "04_blank_search",
  });
  probes.push({
    purpose: blankSearch.fetchReceipt.purpose,
    fetch: blankSearch.fetchReceipt,
    observation: {
      type: "search_submission",
      criteria_shape: "all_fields_blank",
      outcome: blankSearch.errorMessage
        ? "request_failed"
        : !blankSearch.ok
          ? `rejected_http_${blankSearch.httpStatus}`
          : "same_page_rerendered",
      result_row_count: blankSearch.html ? countResultRows(blankSearch.html) : null,
      note: blankSearch.errorMessage
        ? blankSearch.errorMessage
        : !blankSearch.ok
          ? `The search endpoint rejected this POST with HTTP ${blankSearch.httpStatus}; see raw_object_path for the response body.`
          : "A blank-criteria submission returned the same search-page shell (fresh postback tokens, no added results table), not a bulk listing.",
    },
  });
  await sleep(POLITE_DELAY_MS);
  Object.assign(cookies, blankSearch.cookies);

  // 5. One bounded, single-attempt wide-criteria (borough-only) submission --
  //    the most bulk-listing-shaped request a real user could make through
  //    this UI. Never retried: a timeout here is itself the observation.
  const boroughHtml = blankSearch.html || search.html;
  const boroughBody = new URLSearchParams({
    __VIEWSTATE: extractHiddenField(boroughHtml, "__VIEWSTATE") ?? "",
    __VIEWSTATEGENERATOR: extractHiddenField(boroughHtml, "__VIEWSTATEGENERATOR") ?? "",
    __VIEWSTATEENCRYPTED: extractHiddenField(boroughHtml, "__VIEWSTATEENCRYPTED") ?? "",
    __EVENTVALIDATION: extractHiddenField(boroughHtml, "__EVENTVALIDATION") ?? "",
    "ctl00$MainContent$txtKeyword": "",
    "ctl00$MainContent$txtCeqrNumber": "",
    "ctl00$MainContent$txtProjectName": "",
    "ctl00$MainContent$txtBlock": "",
    "ctl00$MainContent$txtLot": "",
    "ctl00$MainContent$ddlLeadAgency": extractDefaultDropdownOption(boroughHtml, "ddlLeadAgency"),
    "ctl00$MainContent$ddlCommunityDistrict": extractDefaultDropdownOption(boroughHtml, "ddlCommunityDistrict"),
    "ctl00$MainContent$ddlBorough": "Manhattan",
    "ctl00$MainContent$btnSearch": " Search",
  }).toString();
  const boroughSearch = await boundedRequest({
    purpose: "borough_wide_search_submission",
    url: searchUrl,
    method: "POST",
    body: boroughBody,
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookieHeader(cookies) },
    rawSlug: "05_borough_wide_search",
  });
  probes.push({
    purpose: boroughSearch.fetchReceipt.purpose,
    fetch: boroughSearch.fetchReceipt,
    observation: {
      type: "bulk_query_probe",
      criteria_shape: "borough_only_manhattan",
      outcome: boroughSearch.errorMessage
        ? "timeout_or_error_abandoned_no_retry"
        : !boroughSearch.ok
          ? `rejected_http_${boroughSearch.httpStatus}`
          : "responded",
      result_row_count: boroughSearch.html ? countResultRows(boroughSearch.html) : null,
      note: boroughSearch.errorMessage
        ? `A single borough-wide (bulk-shaped) search request did not complete: ${boroughSearch.errorMessage}. Per this pipeline's politeness rule it was abandoned rather than retried; a request this expansive not completing within ${REQUEST_TIMEOUT_MS}ms is itself evidence against treating wide enumeration as a supported, stable access pattern.`
        : !boroughSearch.ok
          ? `The search endpoint rejected this POST with HTTP ${boroughSearch.httpStatus}; see raw_object_path for the response body.`
          : "Borough-wide search request completed; see raw_object_path for the returned page.",
    },
  });

  return { probes, cookies, lastSearchHtml: boroughSearch.html || boroughHtml };
}

async function refreshObservation() {
  const { probes } = await runDiscoverySequence();
  return {
    schema: "cityscroll.seqra_ceqr_access_discovery_observation.v1",
    materialized_at: new Date().toISOString(),
    probes,
  };
}

function build(observation) {
  const registryEntry = getSeqraSourceRegistryEntry(CEQR_ACCESS_SOURCE_ID);
  return buildCeqrAccessDiscoveryReceipt({
    generatedAt: observation.materialized_at,
    probes: observation.probes,
    knownGaps: registryEntry?.known_gaps ?? [],
  });
}

const args = new Set(process.argv.slice(2));
const validFlags = new Set(["--discover", "--check"]);
for (const arg of args) {
  if (!validFlags.has(arg)) throw new Error("Usage: node tools/build_seqra_ceqr_access_discovery.mjs [--discover|--check]");
}
if (args.has("--check") && args.has("--discover")) throw new Error("Choose --discover or --check, not both");

let observation;
if (args.has("--discover")) {
  observation = await refreshObservation();
  mkdirSync(path.dirname(OBSERVATION), { recursive: true });
  writeFileSync(OBSERVATION, stringify(observation));
  console.log(`wrote ${path.relative(ROOT, OBSERVATION)} (${observation.probes.length} probes)`);
} else {
  observation = JSON.parse(readFileSync(OBSERVATION, "utf8"));
}

const next = stringify(build(observation));
if (args.has("--check")) {
  const current = readFileSync(RECEIPT, "utf8");
  if (current !== next) throw new Error(`${path.relative(ROOT, RECEIPT)} is stale; run: node tools/build_seqra_ceqr_access_discovery.mjs`);
  console.log("SEQRA-04 CEQR Access discovery receipt OK");
} else {
  mkdirSync(path.dirname(RECEIPT), { recursive: true });
  writeFileSync(RECEIPT, next);
  console.log(`wrote ${path.relative(ROOT, RECEIPT)}`);
}
