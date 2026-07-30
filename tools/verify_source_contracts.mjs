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
  validateSourceContractFixtures,
  validateSourceContracts,
  verifyCodeReferences,
} from "./source_contracts.mjs";

const DAY_MS = 86_400_000;

function ageDays(epochMs) {
  return (Date.now() - epochMs) / DAY_MS;
}

async function responseJson(response, label) {
  let body;
  try { body = await response.json(); } catch {
    throw new Error(`${label}: response is not JSON`);
  }
  return body;
}

export async function verifySocrata(contract) {
  const metadataResponse = await fetch(`${contract.domain}/api/views/${contract.dataset_id}`);
  if (!metadataResponse.ok) throw new Error(`${contract.id}: metadata HTTP ${metadataResponse.status}`);
  const metadata = await responseJson(metadataResponse, contract.id);
  if (!["dataset", "table"].includes(metadata.assetType)) {
    throw new Error(`${contract.id}: expected a tabular dataset, got ${metadata.assetType || "unknown"}`);
  }
  const fields = new Set((metadata.columns || []).map((column) => column.fieldName));
  const missing = contract.required_fields.filter((field) => !fields.has(field));
  if (missing.length) throw new Error(`${contract.id}: missing fields ${missing.join(", ")}`);
  if (!Number.isFinite(metadata.rowsUpdatedAt)) throw new Error(`${contract.id}: no rowsUpdatedAt freshness timestamp`);
  const age = ageDays(metadata.rowsUpdatedAt * 1000);
  if (age < -2) throw new Error(`${contract.id}: rowsUpdatedAt is unexpectedly in the future`);
  if (age > contract.max_stale_days) {
    throw new Error(`${contract.id}: source is stale (${Math.floor(age)} days; limit ${contract.max_stale_days})`);
  }

  const sampleUrl = new URL(`${contract.domain}/resource/${contract.dataset_id}.json`);
  sampleUrl.searchParams.set("$limit", "1");
  const sampleResponse = await fetch(sampleUrl);
  if (!sampleResponse.ok) throw new Error(`${contract.id}: sample HTTP ${sampleResponse.status}`);
  const rows = await responseJson(sampleResponse, contract.id);
  if (!Array.isArray(rows) || rows.length === 0 || typeof rows[0] !== "object") {
    throw new Error(`${contract.id}: source returned no tabular sample row`);
  }
  return `${contract.dataset_id} · ${Math.max(0, Math.floor(age))}d old`;
}

function checkbookRequest(dataType) {
  const criteria = dataType === "Contracts"
    ? "<criteria><name>status</name><type>value</type><value>registered</value></criteria>"
      + "<criteria><name>category</name><type>value</type><value>expense</value></criteria>"
    : "";
  return `<request><type_of_data>${dataType}</type_of_data><records_from>1</records_from>`
    + `<max_records>1</max_records><search_criteria>${criteria}</search_criteria></request>`;
}

async function verifyCheckbook(contract) {
  const response = await fetch(contract.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/xml" },
    body: checkbookRequest(contract.data_type),
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
  return contract.data_type;
}

async function verifyArcgis(contract) {
  const metadataResponse = await fetch(`${contract.endpoint}?f=json`);
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
  const rowResponse = await fetch(sample);
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
  const response = await fetch(url);
  const body = await responseJson(response, contract.id);
  if (!response.ok || !Array.isArray(body.features) || !body.features[0]?.properties?.label) {
    throw new Error(`${contract.id}: response has no feature label`);
  }
  if (!body.features[0].properties.borough) throw new Error(`${contract.id}: response has no borough`);
  return "availability and schema";
}

async function verifyHtml(contract) {
  const response = await fetch(contract.landing_page, { redirect: "follow" });
  if (!response.ok) throw new Error(`${contract.id}: landing page HTTP ${response.status}`);
  const type = response.headers.get("content-type") || "";
  if (!type.includes("text/html")) throw new Error(`${contract.id}: expected manual HTML source`);
  return "manual source reachable";
}

async function verifyRss(contract) {
  const response = await fetch(contract.endpoint, { redirect: "follow" });
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
    fetch(`https://data.cityofnewyork.us/api/views/${configuredId}`),
    fetch(`https://data.cityofnewyork.us/resource/${configuredId}.json?$limit=1`),
    fetch(`https://data.cityofnewyork.us/resource/${documentedId}.json?$limit=1`),
    fetch(contract.landing_page),
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

async function verifyLiveContract(contract) {
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
    const settled = await Promise.allSettled(registry.contracts.map(async (contract) => ({
      id: contract.id,
      detail: await verifyLiveContract(contract),
    })));
    for (const result of settled) {
      if (result.status === "fulfilled") results.push(result.value);
      else errors.push(result.reason?.message || String(result.reason));
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
