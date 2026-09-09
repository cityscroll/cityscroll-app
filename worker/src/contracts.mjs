// HTTP adapters and the explicit provider for the public procurement
// capabilities. The provider reads only the committed shared read model;
// publisher APIs and source-record tables are not request-time dependencies.

import {
  combineSharedProcurementReadModel,
} from "../../site/procurement_read_model_shards.mjs";
import { loadAnalyticalProjectionDocument } from "../../site/analytical_projection_shards.mjs";
import {
  buildProcurementBrowseCapabilityIndex,
  composeProcurementBrowseCapabilityContract,
  loadProcurementBrowseCapabilityDetails,
  loadProcurementBrowseCapabilityFilterTier,
  procurementBrowseCapabilityDetail,
  procurementBrowseCapabilityEntryMatches,
  procurementBrowseCapabilityEnvelope,
  PROCUREMENT_BROWSE_CAPABILITY_INDEX_PATH,
  PROCUREMENT_BROWSE_CAPABILITY_INDEX_SCHEMA,
} from "../../site/procurement_browse_capability_index.mjs";
import {
  ANALYTICAL_MEASURES,
  ANALYTICAL_PROJECTION_URL,
  analyticalDrillThroughHref,
  cityRecordCoverage,
  filterAnalyticalContracts,
  groupAnalyticalContracts,
} from "../../site/analytical_projection.mjs";
import { ANALYTICAL_PROJECTION_SCHEMA, REGISTERED_CONTRACT_PROJECTION } from "../../site/analytical_projection_contract.mjs";
import { researchResponseBytes, RESEARCH_STRUCTURED_MAX_BYTES, fitResearchBrowsePage } from "../../capabilities/research_response_limits.mjs";
import { analyzeContractsProjection, registeredGroupRows, registeredContractReference } from "../../site/contracts_analysis_projection.mjs";
import { procurementDetailIndex } from "../../site/procurement_detail_index.mjs";
import {
  CONTRACT_GET_CAPABILITY_REFERENCE,
  CONTRACT_GET_LIMITS,
  CONTRACT_GET_PROVIDER_ID,
  CONTRACT_REPRESENTATIONS,
  CONTRACTS_BROWSE_CAPABILITY_REFERENCE,
  CONTRACTS_BROWSE_LIMITS,
  CONTRACTS_BROWSE_PROVIDER_ID,
  executeContractGet,
  executeContractsBrowse,
} from "../../capabilities/contracts.mjs";
import {
  CONTRACTS_ANALYSIS_AVAILABILITY,
  CONTRACTS_ANALYSIS_CAPABILITY_REFERENCE,
  CONTRACTS_ANALYSIS_LIMITS,
  CONTRACTS_ANALYSIS_PROVIDER_ID,
  CONTRACTS_ANALYSIS_REPRESENTATIONS,
  executeContractsAnalysis,
} from "../../capabilities/contracts_analysis.mjs";

const SHARED_MODEL_ORIGIN = "https://cityscroll.org";
const SHARED_MODEL_PATH = "/data/shared_procurement_read_model.json";
const ANALYTICAL_PROJECTION_ORIGIN = "https://cityscroll.org";

export const CONTRACT_GET_HTTP_ADAPTER = Object.freeze({
  id: "worker-http.contract-get@1",
  capabilityReference: CONTRACT_GET_CAPABILITY_REFERENCE,
  providerId: CONTRACT_GET_PROVIDER_ID,
  route: "GET /contract",
  surface: "Contract detail",
  representations: CONTRACT_REPRESENTATIONS,
});

export const CONTRACTS_BROWSE_HTTP_ADAPTER = Object.freeze({
  id: "worker-http.contracts-browse@1",
  capabilityReference: CONTRACTS_BROWSE_CAPABILITY_REFERENCE,
  providerId: CONTRACTS_BROWSE_PROVIDER_ID,
  route: "GET /contracts",
  surface: "Contracts browse",
  representations: CONTRACT_REPRESENTATIONS,
});

export const CONTRACTS_ANALYSIS_HTTP_ADAPTER = Object.freeze({
  id: "worker-http.contracts-analysis@1",
  capabilityReference: CONTRACTS_ANALYSIS_CAPABILITY_REFERENCE,
  providerId: CONTRACTS_ANALYSIS_PROVIDER_ID,
  route: "GET /contracts/analysis",
  surface: "Contracts analysis",
  representations: CONTRACTS_ANALYSIS_REPRESENTATIONS,
});

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Accept, Content-Type",
  };
}

function json(body, status = 200, cacheControl = "no-store") {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cacheControl,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function staticAssetUrl(path) {
  return `${SHARED_MODEL_ORIGIN}${path}`;
}

async function readStaticJson(path) {
  const response = await fetch(staticAssetUrl(path), {
    headers: { Accept: "application/json" },
    cf: { cacheTtl: 300, cacheEverything: true },
  });
  if (!response.ok) throw new Error(`shared procurement read model ${response.status}`);
  return response.json();
}

async function readAnalyticalProjectionJson(path) {
  const response = await fetch(`${ANALYTICAL_PROJECTION_ORIGIN}/${path}`, {
    headers: { Accept: "application/json" },
    cf: { cacheTtl: 300, cacheEverything: true },
  });
  if (!response.ok) throw new Error(`registered contract analytical projection ${response.status}`);
  return response.json();
}

async function readAnalyticalProjection(env) {
  const injected = env?.ANALYTICAL_PROJECTION
    || env?.ANALYTICAL_REGISTERED_CONTRACTS
    || (env?.schema === ANALYTICAL_PROJECTION_SCHEMA ? env : null);
  if (injected && typeof injected === "object") return injected;
  // The published document is the index; the population it names lives in
  // bounded shards beside it. A shard that cannot be read fails the request
  // rather than answering from a partial population.
  const projection = await loadAnalyticalProjectionDocument(
    ANALYTICAL_PROJECTION_URL,
    readAnalyticalProjectionJson,
  );
  if (!projection) throw new Error("registered contract analytical projection is incomplete");
  return projection;
}

/**
 * Load one object's slice of the committed model, or a test-provided model,
 * without source-store access. The manifest names the single bounded shard that
 * carries a canonical id, so an object read stays one shard wide however large
 * the population grows. There is deliberately no whole-population path here:
 * the browse capability reads the pre-shaped index instead.
 */
async function readModel(env, { procurementId = null } = {}) {
  const injected = env?.PROCUREMENT_READ_MODEL
    || (env?.schema === "cityscroll.shared_procurement_read_model.v1" ? env : null);
  if (injected && typeof injected === "object") return injected;

  const manifest = await readStaticJson(SHARED_MODEL_PATH);
  if (Array.isArray(manifest?.rows)) return manifest;
  const shardPath = procurementId ? manifest?.procurement_shard_by_id?.[procurementId] : null;
  if (!shardPath) return { ...manifest, rows: [], observations: [] };
  const shard = await readStaticJson(`/data/${shardPath}`);
  return combineSharedProcurementReadModel(manifest, [shard]);
}

/**
 * Load the pre-shaped Contracts browse index: the compact filter tier a browse
 * scans, and the envelope its result rows are composed against. A test that
 * already holds a whole read model gets the same index built in memory, so both
 * paths answer through exactly one filter and one composition.
 */
async function readBrowseCapabilityIndex(env) {
  const injectedIndex = env?.PROCUREMENT_BROWSE_CAPABILITY_INDEX
    || (env?.schema === PROCUREMENT_BROWSE_CAPABILITY_INDEX_SCHEMA ? env : null);
  if (injectedIndex && typeof injectedIndex === "object") {
    return { manifest: injectedIndex, entries: injectedIndex.entries || [] };
  }
  const injectedModel = env?.PROCUREMENT_READ_MODEL
    || (env?.schema === "cityscroll.shared_procurement_read_model.v1" ? env : null);
  if (injectedModel && typeof injectedModel === "object") {
    const index = buildProcurementBrowseCapabilityIndex(injectedModel);
    return { manifest: index, entries: index.entries };
  }
  const tier = await loadProcurementBrowseCapabilityFilterTier(
    `/data/${PROCUREMENT_BROWSE_CAPABILITY_INDEX_PATH}`,
    readStaticJson,
  );
  if (!tier) throw new Error("Contracts browse index is incomplete");
  return tier;
}

function sourceSystemFromRef(ref) {
  return clean(ref).split(":", 1)[0].toLowerCase() || null;
}

/**
 * One published contract, composed from the population envelope and this
 * object's detail. The browse page composes the same two parts from the
 * published index, so an object read and a browse row are the same projection
 * rather than two projections that happen to agree.
 */
function projectContract(model, object) {
  return composeProcurementBrowseCapabilityContract(
    procurementBrowseCapabilityEnvelope(model),
    procurementBrowseCapabilityDetail(model, object),
  );
}

function modelObjects(model) {
  if (model?.schema !== "cityscroll.shared_procurement_read_model.v1" || !Array.isArray(model?.rows)) {
    throw new Error("shared procurement read model is unavailable");
  }
  if (model.identity_gate?.ok === false) throw new Error("shared procurement identity gate failed");
  const ids = new Set();
  const contractIds = new Map();
  for (const object of model.rows) {
    if (!object?.procurement_id || ids.has(object.procurement_id)) throw new Error("shared procurement identity is not unique");
    ids.add(object.procurement_id);
    for (const contractId of object.identity_keys?.contract_ids || []) {
      const prior = contractIds.get(contractId);
      if (prior && prior !== object.procurement_id) throw new Error("prime contract identity was collapsed");
      contractIds.set(contractId, object.procurement_id);
    }
  }
  return model.rows;
}

function findObject(model, procurementId) {
  return modelObjects(model).find((object) => object.procurement_id === procurementId) || null;
}

function encodeCursor(id) {
  return btoa(id).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  const padded = cursor.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - cursor.length % 4) % 4);
  const decoded = atob(padded);
  return decoded || null;
}

export function workerContractGet(env) {
  return Object.freeze({
    capabilityReference: CONTRACT_GET_CAPABILITY_REFERENCE,
    providerId: CONTRACT_GET_PROVIDER_ID,
    async execute(input) {
      try {
        const model = await readModel(env, { procurementId: input.procurementId });
        const object = findObject(model, input.procurementId.trim());
        if (!object) return { capability_reference: CONTRACT_GET_CAPABILITY_REFERENCE, availability: "not_yet_public", contract: null, error: "not-found" };
        return { capability_reference: CONTRACT_GET_CAPABILITY_REFERENCE, availability: "available", contract: projectContract(model, object), error: null };
      } catch (error) {
        console.error("contract read model unavailable:", String(error?.message || error));
        return { capability_reference: CONTRACT_GET_CAPABILITY_REFERENCE, availability: "unavailable", contract: null, error: "unavailable" };
      }
    },
  });
}

export function workerContractsBrowse(env) {
  return Object.freeze({
    capabilityReference: CONTRACTS_BROWSE_CAPABILITY_REFERENCE,
    providerId: CONTRACTS_BROWSE_PROVIDER_ID,
    async execute(input) {
      try {
        if (input.population === "registered") {
          const detailIndex = await readProcurementDetailIndex(env);
          const projection = await readAnalyticalProjection(env);
          const matches = [...new Map(registeredGroupRows(projection.rows, input).map((row) => [row.prime_contract_id, row])).values()]
            .sort((a, b) => a.prime_contract_id.localeCompare(b.prime_contract_id));
          const cursorId = decodeCursor(input.cursor);
          const after = cursorId ? matches.findIndex((row) => `registered:${row.prime_contract_id}` === cursorId) : -1;
          if (input.cursor && (!cursorId || after < 0)) throw new TypeError("invalid registered cursor");
          const limit = input.limit || CONTRACTS_BROWSE_LIMITS.default;
          const results = matches.slice(after + 1, after + 1 + limit).map((row) => registeredContractReference(row.prime_contract_id, detailIndex));
          const result = {
            capability_reference: CONTRACTS_BROWSE_CAPABILITY_REFERENCE,
            availability: results.length ? "complete" : "empty", results, total_matches: matches.length,
            pagination: { limit, returned: results.length, truncated: false, next_cursor: null },
            coverage: { population: "registered", identity: "exact prime_contract_id", detail_resolution: detailIndex?.resolution || "not_resolved", not_retrievable_reason: "A null procurement_id and href mean no individual detail record is published." },
            freshness: { as_of: projection.generated_at || projection.snapshot_date || "unknown" }, error: null,
          };
          const paginate = () => {
            result.pagination.returned = results.length;
            result.pagination.truncated = after + 1 + results.length < matches.length;
            result.pagination.next_cursor = result.pagination.truncated ? encodeCursor(`registered:${results.at(-1).id}`) : null;
          };
          paginate();
          while (researchResponseBytes(result) > RESEARCH_STRUCTURED_MAX_BYTES && results.length > 1) { results.pop(); paginate(); }
          return result;
        }
        // The filter tier is the whole population in its smallest filterable
        // form, so a match count is exact without materializing anything. Only
        // the page that is actually returned is read in full and composed.
        const { manifest, entries } = await readBrowseCapabilityIndex(env);
        const cursorId = decodeCursor(input.cursor);
        if (input.cursor && !cursorId) throw new Error("invalid cursor");
        const matches = entries.filter((entry) => procurementBrowseCapabilityEntryMatches(entry, input));
        const after = cursorId ? matches.findIndex((entry) => entry.procurement_id === cursorId) : -1;
        if (cursorId && after < 0) throw new Error("invalid cursor");
        const limit = input.limit || CONTRACTS_BROWSE_LIMITS.default;
        const start = after + 1;
        const page = matches.slice(start, start + limit);
        const truncated = start + page.length < matches.length;
        const details = await loadProcurementBrowseCapabilityDetails(
          `/data/${PROCUREMENT_BROWSE_CAPABILITY_INDEX_PATH}`,
          manifest,
          page,
          readStaticJson,
        );
        // A page the index cannot supply in full is a truncated index, not a
        // shorter page. Reporting it as unavailable keeps a partial read from
        // being published as a complete answer.
        if (!details) throw new Error("Contracts browse detail is incomplete");
        const results = details.map((detail) => composeProcurementBrowseCapabilityContract(manifest, detail));
        return fitResearchBrowsePage({
          capability_reference: CONTRACTS_BROWSE_CAPABILITY_REFERENCE,
          availability: results.length ? "complete" : "empty",
          results,
          total_matches: matches.length,
          pagination: {
            limit,
            returned: results.length,
            truncated,
            next_cursor: truncated ? encodeCursor(results.at(-1).procurement_id) : null,
          },
          coverage: {
            sources: manifest.sources || {},
            publication: manifest.publication || null,
          },
          freshness: { ...manifest.freshness },
          error: null,
        }, (row) => encodeCursor(row.procurement_id));
      } catch (error) {
        console.error("contracts browse read model unavailable:", String(error?.message || error));
        return { capability_reference: CONTRACTS_BROWSE_CAPABILITY_REFERENCE, availability: "unavailable", results: null, total_matches: null, pagination: null, coverage: null, freshness: null, error: "unavailable" };
      }
    },
  });
}

function analyticalInputFilters(input) {
  return {
    ...(input.agency == null ? {} : { agency: input.agency }),
    ...(input.vendor == null ? {} : { prime_vendor: input.vendor }),
    ...(input.fiscalYear == null ? {} : { registration_fiscal_year: input.fiscalYear }),
    ...(input.amountBand == null ? {} : { contract_amount_band: input.amountBand }),
    ...(input.minAmount == null ? {} : { min_amount: input.minAmount }),
    ...(input.maxAmount == null ? {} : { max_amount: input.maxAmount }),
    ...(input.retroactive == null ? {} : { retroactive: input.retroactive }),
    ...(input.cityRecordMatch == null ? {} : { city_record_match: input.cityRecordMatch }),
  };
}

function publicAnalyticalFilters(input) {
  return {
    group_by: input.groupBy || "agency",
    measure: input.measure || "current",
    ...(input.agency == null ? {} : { agency: input.agency }),
    ...(input.vendor == null ? {} : { vendor: input.vendor }),
    ...(input.fiscalYear == null ? {} : { fiscal_year: input.fiscalYear }),
    ...(input.amountBand == null ? {} : { amount_band: input.amountBand }),
    ...(input.minAmount == null ? {} : { min_amount: input.minAmount }),
    ...(input.maxAmount == null ? {} : { max_amount: input.maxAmount }),
    ...(input.retroactive == null ? {} : { retroactive: input.retroactive }),
    ...(input.cityRecordMatch == null ? {} : { city_record_match: input.cityRecordMatch }),
    limit: input.limit || CONTRACTS_ANALYSIS_LIMITS.defaultGroups,
  };
}

function analyticalMeasure(measure) {
  const id = ANALYTICAL_MEASURES[measure];
  const definition = REGISTERED_CONTRACT_PROJECTION.measures[id];
  const isCount = measure === "count";
  return {
    key: measure,
    id,
    label: definition.label,
    reader_label: definition.reader_label,
    aggregation: definition.aggregation,
    value_field: definition.source_field,
    unit: isCount ? "contracts" : "USD",
    fact: "registered_contract",
    not_payment: true,
  };
}

function analyticalGroupFilters(input, groupBy, label) {
  const filters = publicAnalyticalFilters(input);
  delete filters.group_by;
  delete filters.measure;
  delete filters.limit;
  if (groupBy === "agency" && label !== "Unknown / not published") filters.agency = label;
  if (groupBy === "vendor" && label !== "Unknown / not published") filters.vendor = label;
  if (groupBy === "registration_fiscal_year" && label !== "Unknown / not published") filters.fiscal_year = Number(label);
  if (groupBy === "amount_band" && label !== "Unknown / not published") filters.amount_band = label;
  return filters;
}

function analyticalHref(input, groupBy, label) {
  const filters = analyticalGroupFilters(input, groupBy, label);
  return analyticalDrillThroughHref({
    agency: filters.agency,
    prime_vendor: filters.vendor,
    registration_fiscal_year: filters.fiscal_year,
    contract_amount_band: filters.amount_band,
    min_amount: filters.min_amount,
    max_amount: filters.max_amount,
    retroactive: filters.retroactive,
    city_record_match: filters.city_record_match,
  });
}

/**
 * The detail index the analysis answer resolves its contributing contract
 * identifiers through. It is read before the population so the two documents
 * are not held in memory at once, and it is deliberately skipped when the
 * caller injected a substitute projection: resolving a substituted aggregate
 * against the published detail read model would compare two different
 * snapshots, which is the drift the resolution exists to rule out.
 */
async function readProcurementDetailIndex(env) {
  const injected = env?.PROCUREMENT_READ_MODEL
    || (env?.schema === "cityscroll.shared_procurement_read_model.v1" ? env : null);
  if (injected && typeof injected === "object") return procurementDetailIndex(injected);
  if (env?.ANALYTICAL_PROJECTION || env?.ANALYTICAL_REGISTERED_CONTRACTS
    || env?.schema === ANALYTICAL_PROJECTION_SCHEMA) return null;
  try {
    return procurementDetailIndex(await readStaticJson(SHARED_MODEL_PATH));
  } catch (error) {
    // A missing detail index never fails the aggregate; the answer simply
    // stops claiming that any contributing contract can be fetched.
    console.error("procurement detail index unavailable:", String(error?.message || error));
    return null;
  }
}

function analyzeRegisteredContracts(projection, input, detailIndex) {
  return analyzeContractsProjection(projection, input, detailIndex);
}

export function workerContractsAnalysis(env) {
  return Object.freeze({
    capabilityReference: CONTRACTS_ANALYSIS_CAPABILITY_REFERENCE,
    providerId: CONTRACTS_ANALYSIS_PROVIDER_ID,
    async execute(input) {
      try {
        const detailIndex = await readProcurementDetailIndex(env);
        return analyzeRegisteredContracts(await readAnalyticalProjection(env), input, detailIndex);
      } catch (error) {
        console.error("Contracts analysis projection unavailable:", String(error?.message || error));
        return {
          capability_reference: CONTRACTS_ANALYSIS_CAPABILITY_REFERENCE,
          availability: "unavailable",
          group_by: input.groupBy || "agency",
          measure: null,
          groups: null,
          denominator: null,
          population: null,
          coverage: null,
          contract_detail: null,
          filters: null,
          freshness: null,
          error: "unavailable",
        };
      }
    },
  });
}

// Keep both registered operations together for adapters and tests while each
// capability executor still checks its own reference and provider identity.
export function workerProcurementContracts(env) {
  return Object.freeze({
    get: workerContractGet(env),
    browse: workerContractsBrowse(env),
    analysis: workerContractsAnalysis(env),
  });
}

export function mcpContractGetInput(args = {}) {
  return { procurementId: String(args.procurement_id || args.id || "").trim() };
}

export function mcpContractsBrowseInput(args = {}) {
  return {
    ...(args.population == null ? {} : { population: String(args.population) }),
    ...(args.fiscal_year == null ? {} : { fiscalYear: Number(args.fiscal_year) }),
    ...(args.amount_band == null ? {} : { amountBand: String(args.amount_band) }),
    ...(args.retroactive == null ? {} : { retroactive: args.retroactive === true || args.retroactive === "true" }),
    ...(args.city_record_match == null ? {} : { cityRecordMatch: String(args.city_record_match) }),
    ...(args.group_by == null ? {} : { groupBy: String(args.group_by) }),
    ...(args.group_label == null ? {} : { groupLabel: String(args.group_label) }),
    ...(args.query == null ? {} : { query: String(args.query).trim() }),
    ...(args.agency == null ? {} : { agency: String(args.agency).trim() }),
    ...(args.vendor == null ? {} : { vendor: String(args.vendor).trim() }),
    ...(args.stage == null ? {} : { stage: String(args.stage).trim() }),
    ...(args.source_system == null ? {} : { sourceSystem: String(args.source_system).trim() }),
    ...(args.min_amount == null ? {} : { minAmount: Number(args.min_amount) }),
    ...(args.max_amount == null ? {} : { maxAmount: Number(args.max_amount) }),
    ...(args.limit == null ? {} : { limit: Number(args.limit) }),
    ...(args.cursor == null ? {} : { cursor: String(args.cursor).trim() }),
  };
}

export function mcpContractsAnalysisInput(args = {}) {
  return {
    ...(args.sample_limit == null ? {} : { sampleLimit: Number(args.sample_limit) }),
    ...(args.cursor == null ? {} : { cursor: String(args.cursor) }),
    ...(args.group_by == null ? {} : { groupBy: String(args.group_by).trim() }),
    ...(args.measure == null ? {} : { measure: String(args.measure).trim() }),
    ...(args.agency == null ? {} : { agency: String(args.agency).trim() }),
    ...(args.vendor == null ? {} : { vendor: String(args.vendor).trim() }),
    ...(args.fiscal_year == null ? {} : { fiscalYear: Number(args.fiscal_year) }),
    ...(args.amount_band == null ? {} : { amountBand: String(args.amount_band).trim() }),
    ...(args.min_amount == null ? {} : { minAmount: Number(args.min_amount) }),
    ...(args.max_amount == null ? {} : { maxAmount: Number(args.max_amount) }),
    ...(args.retroactive == null ? {} : { retroactive: !!args.retroactive }),
    ...(args.city_record_match == null ? {} : { cityRecordMatch: String(args.city_record_match).trim() }),
    ...(args.limit == null ? {} : { limit: Number(args.limit) }),
  };
}

function providerForGet(env) { return workerProcurementContracts(env).get; }
function providerForBrowse(env) { return workerProcurementContracts(env).browse; }

function contractSummary(contract) {
  if (contract.id) return `${contract.id} · ${contract.procurement_id || "No individual detail record published"}`;
  const fields = contract.fields || {};
  return [contract.procurement_id, fields.short_title, fields.agency_name, fields.vendor_name]
    .filter(Boolean).join(" · ");
}

export function formatContractText(result) {
  if (result.availability === "available") return contractSummary(result.contract);
  return `Contract is ${result.availability.replaceAll("_", " ")} (${result.error}).`;
}

export function formatContractsBrowseText(result) {
  if (result.availability === "empty") return "No contracts match the bounded filters in the shared read model.";
  if (result.availability === "unavailable") return "Contracts browse is unavailable right now.";
  const lines = result.results.map((contract, index) => `${index + 1}. ${contractSummary(contract)}`);
  if (result.pagination.truncated) lines.push(`More results are available with cursor ${result.pagination.next_cursor}.`);
  return lines.join("\n");
}

export function formatContractsAnalysisText(result) {
  if (result.filters?.discovery?.agency?.status === "unrecognized") return result.filters.discovery.agency.message;
  if (result.availability === "empty") return "No registered contracts match the bounded analytical filters.";
  if (result.availability === "unavailable") return "Contracts analysis is unavailable right now.";
  const measure = `${result.measure.reader_label} (${result.measure.unit})`;
  const lines = [
    `${result.group_by}: ${measure}; denominator ${result.denominator.value.toLocaleString("en-US")} ${result.denominator.unit} across ${result.denominator.contract_count.toLocaleString("en-US")} contracts.`,
    ...result.groups.map((group, index) => `${index + 1}. ${group.label} — ${group.value.toLocaleString("en-US")} ${group.unit}; ${group.contract_count} contracts; ${group.contract_sample.length} sampled. Use the structured browse continuation for every registration.`),
    result.coverage.statement,
    result.contract_detail.identifier_note,
    ...(result.filters.pagination?.next_cursor ? [`More groups: repeat these filters with cursor ${result.filters.pagination.next_cursor}.`] : []),
  ];
  return lines.join("\n");
}

function formatRequested(request) {
  const format = new URL(request.url).searchParams.get("format");
  return format === "text" || (request.headers.get("accept") || "").includes("text/plain");
}

export async function handleContract(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (request.method !== "GET") return json({ ok: false, reason: "method" }, 405);
  const url = new URL(request.url);
  const procurementId = String(url.searchParams.get("id") || url.searchParams.get("procurement_id") || "").trim();
  if (!procurementId || procurementId.length > CONTRACT_GET_LIMITS.procurementIdMaximumLength || !procurementId.startsWith("procurement:")) {
    return json({ ok: false, reason: "invalid-request" }, 400);
  }
  const result = await executeContractGet(providerForGet(env), { procurementId });
  if (result.availability === "not_yet_public") return json(result, 404);
  if (result.availability === "unavailable") return json(result, 503);
  if (formatRequested(request)) return new Response(formatContractText(result), { status: 200, headers: { ...corsHeaders(), "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=60" } });
  return json(result, 200, "public, max-age=60, s-maxage=300, stale-while-revalidate=3600");
}

export async function handleContractsBrowse(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (request.method !== "GET") return json({ ok: false, reason: "method" }, 405);
  const url = new URL(request.url);
  const args = Object.fromEntries(url.searchParams);
  if (args.q !== undefined && args.query === undefined) args.query = args.q;
  const input = mcpContractsBrowseInput(args);
  try {
    const result = await executeContractsBrowse(providerForBrowse(env), input);
    if (result.availability === "unavailable") return json(result, 503);
    if (formatRequested(request)) return new Response(formatContractsBrowseText(result), { status: 200, headers: { ...corsHeaders(), "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=60" } });
    return json(result, 200, "public, max-age=60, s-maxage=300, stale-while-revalidate=3600");
  } catch (error) {
    const invalid = /(?:field|bounded|string|finite|integer|amount|cursor|does not accept)/i.test(String(error?.message || error));
    return json({ ok: false, reason: invalid ? "invalid-request" : "unavailable" }, invalid ? 400 : 503);
  }
}

export async function handleContractsAnalysis(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (request.method !== "GET") return json({ ok: false, reason: "method" }, 405);
  const url = new URL(request.url);
  const input = {
    ...(url.searchParams.has("sample_limit") ? { sampleLimit: Number(url.searchParams.get("sample_limit")) } : {}),
    ...(url.searchParams.has("cursor") ? { cursor: String(url.searchParams.get("cursor")) } : {}),
    ...(url.searchParams.has("identifiers") ? { identifiers: String(url.searchParams.get("identifiers")) } : {}),
    ...(url.searchParams.has("group_by") ? { groupBy: String(url.searchParams.get("group_by")) } : {}),
    ...(url.searchParams.has("groupBy") ? { groupBy: String(url.searchParams.get("groupBy")) } : {}),
    ...(url.searchParams.has("measure") ? { measure: String(url.searchParams.get("measure")) } : {}),
    ...(url.searchParams.has("agency") ? { agency: String(url.searchParams.get("agency")) } : {}),
    ...(url.searchParams.has("vendor") ? { vendor: String(url.searchParams.get("vendor")) } : {}),
    ...(url.searchParams.has("fiscal_year") ? { fiscalYear: Number(url.searchParams.get("fiscal_year")) } : {}),
    ...(url.searchParams.has("fy") ? { fiscalYear: Number(url.searchParams.get("fy")) } : {}),
    ...(url.searchParams.has("amount_band") ? { amountBand: String(url.searchParams.get("amount_band")) } : {}),
    ...(url.searchParams.has("min_amount") ? { minAmount: Number(url.searchParams.get("min_amount")) } : {}),
    ...(url.searchParams.has("max_amount") ? { maxAmount: Number(url.searchParams.get("max_amount")) } : {}),
    ...(url.searchParams.has("retroactive") ? { retroactive: url.searchParams.get("retroactive") === "true" } : {}),
    ...(url.searchParams.has("city_record_match") ? { cityRecordMatch: String(url.searchParams.get("city_record_match")) } : {}),
    ...(url.searchParams.has("limit") ? { limit: Number(url.searchParams.get("limit")) } : {}),
  };
  try {
    const result = await executeContractsAnalysis(workerProcurementContracts(env).analysis, input);
    if (result.availability === "unavailable") return json(result, 503);
    if (formatRequested(request)) return new Response(formatContractsAnalysisText(result), { status: 200, headers: { ...corsHeaders(), "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=60" } });
    return json(result, 200, "public, max-age=60, s-maxage=300, stale-while-revalidate=3600");
  } catch (error) {
    const invalid = /(?:field|bounded|string|finite|integer|measure|group|fiscal|amount|cityRecord|does not accept)/i.test(String(error?.message || error));
    return json({ ok: false, reason: invalid ? "invalid-request" : "unavailable" }, invalid ? 400 : 503);
  }
}
