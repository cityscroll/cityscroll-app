#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { AWARD_SOURCE_REGISTRY } from "../site/external_awards.js";
import { checkGeneratedSourceFiles } from "./generate_source_docs.mjs";
import {
  awardCoverage,
  classifyMocsFieldCase,
  loadSourceContractFixtures,
  loadSourceContracts,
  resolveProbeEndpoint,
  validateSourceContractFixtures,
  validateSourceContracts,
  verifyCodeReferences,
} from "./source_contracts.mjs";

const DAY_MS = 86_400_000;
const LIVE_CONCURRENCY = 4;
const NETWORK_RETRY = 1;
const DEFAULT_UA = "CityScrollSourceContracts/1.0 (+https://cityscroll.org; source-contract monitor)";

function ageDays(epochMs) {
  return (Date.now() - epochMs) / DAY_MS;
}

function causeMessage(error) {
  if (!error) return "unknown error";
  const cause = error.cause;
  if (cause?.code) return `${cause.code}${cause.hostname ? ` ${cause.hostname}` : ""}`;
  if (cause?.message) return cause.message;
  return error.message || String(error);
}

/** Wrap network failures so every line names source id + URL class. */
export function formatFetchError(contractId, urlClass, error, url) {
  const host = (() => {
    try { return new URL(url).host; } catch { return ""; }
  })();
  const detail = causeMessage(error);
  return `${contractId}: ${urlClass} fetch failed${host ? ` (${host})` : ""}${detail ? `: ${detail}` : ""}`;
}

export async function labeledFetch(contractId, urlClass, url, options = {}) {
  const headers = {
    "User-Agent": DEFAULT_UA,
    Accept: "application/json, text/html, application/xml, text/plain, */*",
    ...(options.headers || {}),
  };
  let lastError;
  for (let attempt = 0; attempt <= NETWORK_RETRY; attempt += 1) {
    try {
      const response = await fetch(url, { ...options, headers });
      // Transient upstream 5xx (common on Socrata under parallel load) — retry once.
      if (response.status >= 500 && response.status <= 599 && attempt < NETWORK_RETRY) {
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < NETWORK_RETRY) {
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
        continue;
      }
    }
  }
  throw new Error(formatFetchError(contractId, urlClass, lastError, url));
}

async function responseJson(response, label) {
  let body;
  try { body = await response.json(); } catch {
    throw new Error(`${label}: response is not JSON`);
  }
  return body;
}

async function mapPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await fn(items[i], i);
    }
  }
  const n = Math.min(concurrency, Math.max(1, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

export async function verifySocrata(contract) {
  const metaUrl = `${contract.domain}/api/views/${contract.dataset_id}`;
  const metadataResponse = await labeledFetch(contract.id, "metadata", metaUrl);
  if (!metadataResponse.ok) throw new Error(`${contract.id}: metadata HTTP ${metadataResponse.status}`);
  const metadata = await responseJson(metadataResponse, contract.id);
  // "filter" is a Socrata filtered view (e.g. Current Solicitations 3khw-qi8f) — still tabular.
  if (!["dataset", "table", "filter"].includes(metadata.assetType)) {
    throw new Error(`${contract.id}: expected a tabular dataset, got ${metadata.assetType || "unknown"}`);
  }
  const fields = new Set((metadata.columns || []).map((column) => column.fieldName));
  const missing = contract.required_fields.filter((field) => !fields.has(field));
  if (missing.length) throw new Error(`${contract.id}: missing fields ${missing.join(", ")}`);
  if (!Number.isFinite(metadata.rowsUpdatedAt)) throw new Error(`${contract.id}: no rowsUpdatedAt freshness timestamp`);
  const age = ageDays(metadata.rowsUpdatedAt * 1000);
  if (age < -2) throw new Error(`${contract.id}: rowsUpdatedAt is unexpectedly in the future`);

  // Pointer-class / recon-only sources: existence + schema only (no ingest freshness gate).
  const pointerClass = contract.contract_class === "pointer"
    || contract.stale_policy === "skip"
    || (contract.status === "disabled" && contract.contract_class === "pointer");
  if (!pointerClass && age > contract.max_stale_days) {
    throw new Error(`${contract.id}: source is stale (${Math.floor(age)} days; limit ${contract.max_stale_days})`);
  }

  const sampleUrl = new URL(`${contract.domain}/resource/${contract.dataset_id}.json`);
  sampleUrl.searchParams.set("$limit", "1");
  const sampleResponse = await labeledFetch(contract.id, "sample", sampleUrl.toString());
  if (!sampleResponse.ok) throw new Error(`${contract.id}: sample HTTP ${sampleResponse.status}`);
  const rows = await responseJson(sampleResponse, contract.id);
  if (!Array.isArray(rows) || rows.length === 0 || typeof rows[0] !== "object") {
    throw new Error(`${contract.id}: source returned no tabular sample row`);
  }
  if (pointerClass) {
    return `${contract.dataset_id} · reachable (pointer; freshness not gated; ${Math.max(0, Math.floor(age))}d since rowsUpdatedAt)`;
  }
  return `${contract.dataset_id} · ${Math.max(0, Math.floor(age))}d old`;
}

function checkbookRequest(contract) {
  const dataType = contract.data_type;
  if (dataType === "Spending") {
    // Product path: Contracts-then-Spending-by-contract_id (PIN is rejected on Spending).
    const sampleId = contract.probe_contract_id || "CT107120248803393";
    const criteria = `<criteria><name>contract_id</name><type>value</type><value>${sampleId}</value></criteria>`;
    return `<request><type_of_data>Spending</type_of_data><records_from>1</records_from>`
      + `<max_records>1</max_records><search_criteria>${criteria}</search_criteria></request>`;
  }
  const criteria = dataType === "Contracts"
    ? "<criteria><name>status</name><type>value</type><value>registered</value></criteria>"
      + "<criteria><name>category</name><type>value</type><value>expense</value></criteria>"
    : "";
  return `<request><type_of_data>${dataType}</type_of_data><records_from>1</records_from>`
    + `<max_records>1</max_records><search_criteria>${criteria}</search_criteria></request>`;
}

export async function verifyCheckbook(contract) {
  const response = await labeledFetch(contract.id, "checkbook-api", contract.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/xml" },
    body: checkbookRequest(contract),
  });
  if (!response.ok) throw new Error(`${contract.id}: HTTP ${response.status}`);
  const xml = await response.text();
  if (!/<result>\s*success\s*<\/result>/.test(xml) || !/<transaction>[\s\S]*<\/transaction>/.test(xml)) {
    throw new Error(`${contract.id}: response is not a successful tabular XML result`);
  }
  const missing = contract.required_fields.filter((field) => !new RegExp(`<${field}(?:>|\\s)`).test(xml));
  if (missing.length) throw new Error(`${contract.id}: missing XML fields ${missing.join(", ")}`);
  if (contract.max_stale_days) {
    const match = xml.match(/<prime_contract_registration_date>([^<]+)<\/prime_contract_registration_date>/);
    const date = match && Date.parse(match[1]);
    if (!Number.isFinite(date)) throw new Error(`${contract.id}: no contract registration freshness date`);
    const age = ageDays(date);
    if (age > contract.max_stale_days) {
      throw new Error(`${contract.id}: latest bounded sample is stale (${Math.floor(age)} days; limit ${contract.max_stale_days})`);
    }
  }
  return contract.data_type === "Spending"
    ? `${contract.data_type} (contract_id probe)`
    : contract.data_type;
}

async function verifyArcgis(contract) {
  const metadataResponse = await labeledFetch(contract.id, "metadata", `${contract.endpoint}?f=json`);
  if (!metadataResponse.ok) throw new Error(`${contract.id}: metadata HTTP ${metadataResponse.status}`);
  const metadata = await responseJson(metadataResponse, contract.id);
  if (metadata.type !== "Feature Layer") throw new Error(`${contract.id}: expected Feature Layer`);
  const fields = new Set((metadata.fields || []).map((field) => field.name));
  const missing = contract.required_fields.filter((field) => !fields.has(field));
  if (missing.length) throw new Error(`${contract.id}: missing fields ${missing.join(", ")}`);
  const edited = metadata.editingInfo?.lastEditDate;
  if (!Number.isFinite(edited)) throw new Error(`${contract.id}: no lastEditDate freshness timestamp`);
  const age = ageDays(edited);
  if (age > contract.max_stale_days) {
    throw new Error(`${contract.id}: source is stale (${Math.floor(age)} days; limit ${contract.max_stale_days})`);
  }
  const sample = new URL(`${contract.endpoint}/query`);
  sample.search = new URLSearchParams({
    where: "BBL IS NOT NULL",
    returnGeometry: "false",
    outFields: contract.required_fields.join(","),
    resultRecordCount: "1",
    f: "geojson",
  });
  const rowResponse = await labeledFetch(contract.id, "sample", sample.toString());
  const row = await responseJson(rowResponse, contract.id);
  if (!rowResponse.ok || row.type !== "FeatureCollection" || !row.features?.length) {
    throw new Error(`${contract.id}: source returned no tabular feature sample`);
  }
  return `${Math.max(0, Math.floor(age))}d old`;
}

async function verifyGeosearch(contract) {
  const url = new URL(contract.endpoint);
  url.searchParams.set("text", "City Hall New York NY");
  url.searchParams.set("size", "1");
  const response = await labeledFetch(contract.id, "geosearch", url.toString());
  const body = await responseJson(response, contract.id);
  if (!response.ok || !Array.isArray(body.features) || !body.features[0]?.properties?.label) {
    throw new Error(`${contract.id}: response has no feature label`);
  }
  if (!body.features[0].properties.borough) throw new Error(`${contract.id}: response has no borough`);
  return "availability and schema";
}

function jsonHasField(body, field) {
  if (body == null) return false;
  if (Array.isArray(body)) {
    return body.some((row) => jsonHasField(row, field));
  }
  if (typeof body !== "object") return false;
  if (Object.prototype.hasOwnProperty.call(body, field)) return true;
  if (body.attributes && Object.prototype.hasOwnProperty.call(body.attributes, field)) return true;
  if (body.data) {
    if (jsonHasField(body.data, field)) return true;
    if (body.data.attributes && Object.prototype.hasOwnProperty.call(body.data.attributes, field)) return true;
    // ZAP project payload uses dcp-* keys; map product field names loosely.
  }
  if (body.included && Array.isArray(body.included) && field === "actions") {
    return body.included.some((row) => row?.type === "actions");
  }
  if (body.included && Array.isArray(body.included) && field === "dispositions") {
    return body.included.some((row) => row?.type === "dispositions" || row?.type === "disposition");
  }
  if (field === "documents" && body.included) {
    return body.included.some((row) => Array.isArray(row?.attributes?.documents) && row.attributes.documents.length);
  }
  if (field === "project_id") {
    const id = body.data?.id || body.data?.attributes?.["dcp-name"] || body.id;
    return Boolean(id);
  }
  if (field === "public_status") {
    return Boolean(
      body.data?.attributes?.["dcp-publicstatus"]
      || body.data?.attributes?.public_status
      || body.public_status,
    );
  }
  for (const value of Object.values(body)) {
    if (value && typeof value === "object" && jsonHasField(value, field)) return true;
  }
  return false;
}

async function verifyAuthMachineEndpoint(contract, probeUrl) {
  const envName = contract.auth_token_env;
  const token = envName ? process.env[envName] : "";
  if (token) {
    const url = new URL(probeUrl);
    if (!url.searchParams.has("token")) url.searchParams.set("token", token);
    const response = await labeledFetch(contract.id, "machine-endpoint", url.toString(), {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`${contract.id}: authenticated machine endpoint HTTP ${response.status}`);
    }
    const type = response.headers.get("content-type") || "";
    if (!/json/i.test(type) && !/javascript|ecmascript|text\/plain/i.test(type)) {
      // Legistar returns JSON without always advertising it cleanly; accept body parse.
    }
    let body;
    try {
      body = await response.json();
    } catch {
      throw new Error(`${contract.id}: authenticated machine endpoint is not JSON`);
    }
    if (Array.isArray(body)) {
      if (!body.length) throw new Error(`${contract.id}: authenticated machine endpoint returned empty array`);
    } else if (!body || typeof body !== "object") {
      throw new Error(`${contract.id}: authenticated machine endpoint returned unexpected body`);
    }
    return "authenticated machine endpoint reachable";
  }

  // No token in this environment: auth gate must still answer (403/401), never 404/DNS.
  const response = await labeledFetch(contract.id, "machine-endpoint", probeUrl, {
    headers: { Accept: "application/json" },
  });
  if (response.status === 401 || response.status === 403) {
    return "auth-gated machine endpoint reachable (token not configured in this environment)";
  }
  if (response.status === 404) {
    throw new Error(`${contract.id}: machine endpoint HTTP 404 (auth probe path is wrong or gone)`);
  }
  if (!response.ok) {
    throw new Error(`${contract.id}: machine endpoint HTTP ${response.status} without token`);
  }
  return "machine endpoint reachable without token";
}

async function verifyJsonMachineEndpoint(contract, probeUrl) {
  const response = await labeledFetch(contract.id, "machine-endpoint", probeUrl, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`${contract.id}: machine endpoint HTTP ${response.status}`);
  const body = await responseJson(response, `${contract.id} machine-endpoint`);
  for (const field of contract.required_fields || []) {
    if (!jsonHasField(body, field)) {
      throw new Error(`${contract.id}: machine JSON missing field ${field}`);
    }
  }
  if (contract.max_stale_days) {
    const lm = response.headers.get("last-modified");
    const parsed = lm ? Date.parse(lm) : NaN;
    if (Number.isFinite(parsed)) {
      const age = ageDays(parsed);
      if (age > contract.max_stale_days) {
        throw new Error(`${contract.id}: machine endpoint is stale (${Math.floor(age)} days; limit ${contract.max_stale_days})`);
      }
      return `JSON machine endpoint · ${Math.max(0, Math.floor(age))}d old`;
    }
  }
  return "JSON machine endpoint reachable";
}

async function verifyJsDumpMachineEndpoint(contract, probeUrl) {
  const dataRes = await labeledFetch(contract.id, "machine-endpoint", probeUrl, { redirect: "follow" });
  if (!dataRes.ok) throw new Error(`${contract.id}: machine endpoint HTTP ${dataRes.status}`);
  const dataType = dataRes.headers.get("content-type") || "";
  if (!/javascript|ecmascript|text\/plain|octet-stream/i.test(dataType) && !/json/i.test(dataType)) {
    // PASSPort often serves application/javascript; tolerate empty type if body looks like JS.
  }
  const body = await dataRes.text();
  if (body.length < 100) throw new Error(`${contract.id}: machine endpoint body too small`);
  for (const field of contract.required_fields || []) {
    // Row arrays are positional; field names appear in companion portal JS, not always in the dump.
    // Require at least one required join key string to appear as a sample cell for EPIN/PIN sources.
    if (field === "epin" && !/"[A-Z0-9]{6,}"/i.test(body.slice(0, 5000))) {
      throw new Error(`${contract.id}: machine dump does not look like a tabular EPIN array`);
    }
  }
  if (contract.max_stale_days) {
    const lm = dataRes.headers.get("last-modified");
    const parsed = lm ? Date.parse(lm) : NaN;
    if (Number.isFinite(parsed)) {
      const age = ageDays(parsed);
      if (age > contract.max_stale_days) {
        throw new Error(`${contract.id}: machine dump is stale (${Math.floor(age)} days; limit ${contract.max_stale_days})`);
      }
      return `HTML + machine dump · ${Math.max(0, Math.floor(age))}d old`;
    }
  }
  return "machine dump reachable";
}

async function verifyMachineEndpoint(contract) {
  const probeUrl = resolveProbeEndpoint(contract);
  if (!probeUrl) throw new Error(`${contract.id}: missing machine endpoint`);

  if (contract.auth_token_env) {
    return verifyAuthMachineEndpoint(contract, probeUrl);
  }

  const format = contract.endpoint_format
    || (contract.endpoint && /\{[a-z_]+\}/i.test(contract.endpoint) ? "json-api" : null)
    || (/\.js(?:$|\?)/i.test(probeUrl) ? "js-dump" : null)
    || "json-api";

  if (format === "js-dump") return verifyJsDumpMachineEndpoint(contract, probeUrl);
  return verifyJsonMachineEndpoint(contract, probeUrl);
}

async function verifyLandingPage(contract) {
  const landingProbe = contract.landing_probe || "require";
  if (landingProbe === "skip" || landingProbe === "bot_blocked") {
    return null;
  }
  const response = await labeledFetch(contract.id, "landing-page", contract.landing_page, {
    redirect: "follow",
  });
  if (!response.ok) {
    if (response.status === 403 && landingProbe === "tolerate_bot_block") {
      return "landing bot-blocked (tolerated)";
    }
    throw new Error(`${contract.id}: landing page HTTP ${response.status}`);
  }
  const type = response.headers.get("content-type") || "";
  if (!type.includes("text/html")) throw new Error(`${contract.id}: expected manual HTML source`);
  return "landing reachable";
}

export async function verifyHtml(contract) {
  const landingProbe = contract.landing_probe || "require";
  const hasMachine = Boolean(resolveProbeEndpoint(contract));
  const notes = [];

  // Prefer machine endpoint when product uses one; landing is secondary and may be bot-blocked on CI.
  if (hasMachine) {
    notes.push(await verifyMachineEndpoint(contract));
    if (landingProbe === "require") {
      try {
        const landing = await verifyLandingPage(contract);
        if (landing) notes.push(landing);
      } catch (error) {
        // When the machine path the product uses is healthy, a runner-blocked landing
        // is not upstream drift — reclassify as a known CI egress issue.
        const msg = error?.message || String(error);
        if (/landing page HTTP 403/.test(msg)) {
          notes.push("landing bot-blocked on this runner (machine endpoint OK; not treated as drift)");
        } else {
          throw error;
        }
      }
    } else if (landingProbe === "bot_blocked") {
      notes.push("landing known bot-blocked; machine endpoint is the contract");
    }
    return notes.join(" · ");
  }

  if (landingProbe === "bot_blocked" || landingProbe === "skip") {
    return landingProbe === "bot_blocked"
      ? "known bot-blocked landing; no machine probe (product-side challenge handling)"
      : "landing probe skipped";
  }

  const landing = await verifyLandingPage(contract);
  return landing || "manual source reachable";
}

async function verifyRss(contract) {
  const response = await labeledFetch(contract.id, "rss-feed", contract.endpoint, { redirect: "follow" });
  if (!response.ok) throw new Error(`${contract.id}: feed HTTP ${response.status}`);
  const xml = await response.text();
  if (!/<rss[\s>]/i.test(xml) || !/<item>/i.test(xml)) {
    throw new Error(`${contract.id}: response is not an RSS feed with items`);
  }
  for (const field of contract.required_fields) {
    const re = new RegExp(`<${field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^>]*>`, "i");
    if (!re.test(xml)) {
      throw new Error(`${contract.id}: feed is missing field <${field}>`);
    }
  }
  const lastBuildMatch = xml.match(/<lastBuildDate>([^<]+)<\/lastBuildDate>/i);
  const pubMatch = xml.match(/<pubDate>([^<]+)<\/pubDate>/i);
  const dateStr = (lastBuildMatch && lastBuildMatch[1]) || (pubMatch && pubMatch[1]);
  if (dateStr) {
    const parsed = Date.parse(dateStr.trim());
    if (Number.isFinite(parsed)) {
      const age = ageDays(parsed);
      if (age > contract.max_stale_days) {
        throw new Error(`${contract.id}: feed is stale (${Math.floor(age)} days; limit ${contract.max_stale_days})`);
      }
      return `${Math.max(0, Math.floor(age))}d old`;
    }
  }
  return "feed reachable, no parseable freshness date";
}

async function verifyDisabledMocs(contract) {
  const [configuredId, documentedId] = contract.legacy_dataset_ids;
  const [metadataResponse, configuredResponse, documentedResponse, landingResponse] = await Promise.all([
    labeledFetch(contract.id, "metadata", `https://data.cityofnewyork.us/api/views/${configuredId}`),
    labeledFetch(contract.id, "configured-resource", `https://data.cityofnewyork.us/resource/${configuredId}.json?$limit=1`),
    labeledFetch(contract.id, "documented-resource", `https://data.cityofnewyork.us/resource/${documentedId}.json?$limit=1`),
    labeledFetch(contract.id, "landing-page", contract.landing_page),
  ]);
  const [metadata, configuredBody, documentedBody, landing] = await Promise.all([
    responseJson(metadataResponse, contract.id),
    responseJson(configuredResponse, contract.id),
    responseJson(documentedResponse, contract.id),
    landingResponse.text(),
  ]);
  const result = classifyMocsFieldCase(
    metadata,
    { status: configuredResponse.status, body: configuredBody },
    { status: documentedResponse.status, body: documentedBody },
  );
  if (!result.configuredNonTabular || !result.documentedMissing) {
    throw new Error(`${contract.id}: retired dataset behavior changed; review the disabled contract`);
  }
  if (!landingResponse.ok || !/\.xlsx/i.test(landing)) {
    throw new Error(`${contract.id}: official page no longer exposes the documented spreadsheet publication`);
  }
  return "disabled field case confirmed";
}

export async function verifyLiveContract(contract) {
  if (contract.kind === "socrata") return verifySocrata(contract);
  if (contract.kind === "checkbook") return verifyCheckbook(contract);
  if (contract.kind === "arcgis") return verifyArcgis(contract);
  if (contract.kind === "geosearch") return verifyGeosearch(contract);
  if (contract.kind === "html") return verifyHtml(contract);
  if (contract.kind === "rss") return verifyRss(contract);
  if (contract.kind === "mocs-disabled") return verifyDisabledMocs(contract);
  throw new Error(`${contract.id}: no live verifier for ${contract.kind}`);
}

export async function verifySourceContracts({ live = false } = {}) {
  const registry = loadSourceContracts();
  const fixtures = loadSourceContractFixtures();
  const errors = [
    ...validateSourceContracts(registry),
    ...validateSourceContractFixtures(registry, fixtures),
    ...verifyCodeReferences(registry),
  ];
  const generated = checkGeneratedSourceFiles();
  errors.push(...generated.map((path) => `generated source doc is out of date: ${path}`));

  const coverage = awardCoverage(AWARD_SOURCE_REGISTRY);
  const aboContracts = registry.contracts
    .filter((contract) => contract.id.startsWith("abo-"))
    .map((contract) => contract.dataset_id)
    .sort();
  if (JSON.stringify(aboContracts) !== JSON.stringify(coverage.datasets)) {
    errors.push(`ABO contract datasets do not match the runtime registry: ${aboContracts.join(", ")}`);
  }

  const results = [];
  if (live && errors.length === 0) {
    const settled = await mapPool(registry.contracts, LIVE_CONCURRENCY, async (contract) => {
      try {
        return { status: "fulfilled", value: { id: contract.id, detail: await verifyLiveContract(contract) } };
      } catch (reason) {
        return { status: "rejected", reason };
      }
    });
    for (const result of settled) {
      if (result.status === "fulfilled") results.push(result.value);
      else {
        const reason = result.reason;
        const message = reason?.message || String(reason);
        // Never emit a bare "fetch failed" / "TypeError" line.
        errors.push(message.includes(":") ? message : `unknown-source: ${message}`);
      }
    }
  }
  return { errors, results, contracts: registry.contracts.length };
}

async function main() {
  const live = process.argv.includes("--live");
  const report = await verifySourceContracts({ live });
  for (const result of report.results) console.log(`ok ${result.id}: ${result.detail}`);
  if (report.errors.length) {
    for (const error of report.errors) console.error(`error ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`source contracts valid (${report.contracts}, recorded fixtures${live ? " + live" : ""})`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) await main();
