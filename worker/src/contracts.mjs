// HTTP adapters and the explicit provider for the public procurement
// capabilities. The provider reads only the committed shared read model;
// publisher APIs and source-record tables are not request-time dependencies.

import {
  combineSharedProcurementReadModel,
} from "../../site/procurement_read_model_shards.mjs";
import {
  materializeProcurementSearchDocument,
} from "../../site/procurement_search_producer.mjs";
import { contractSearchDocumentToMoneyRow } from "../../site/contract_search_bridge.mjs";
import { publicProcurementAmount } from "../../site/checkbook_passport_corroboration.mjs";
import {
  ANALYTICAL_MEASURES,
  ANALYTICAL_PROJECTION_URL,
  analyticalDrillThroughHref,
  cityRecordCoverage,
  filterAnalyticalContracts,
  groupAnalyticalContracts,
} from "../../site/analytical_projection.mjs";
import { ANALYTICAL_PROJECTION_SCHEMA, REGISTERED_CONTRACT_PROJECTION } from "../../site/analytical_projection_contract.mjs";
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
const PUBLIC_AMOUNT_MAX_EXCLUSIVE = 10_000_000_000;

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

async function readAnalyticalProjection(env) {
  const injected = env?.ANALYTICAL_PROJECTION
    || env?.ANALYTICAL_REGISTERED_CONTRACTS
    || (env?.schema === ANALYTICAL_PROJECTION_SCHEMA ? env : null);
  if (injected && typeof injected === "object") return injected;
  const response = await fetch(`${ANALYTICAL_PROJECTION_ORIGIN}/${ANALYTICAL_PROJECTION_URL}`, {
    headers: { Accept: "application/json" },
    cf: { cacheTtl: 300, cacheEverything: true },
  });
  if (!response.ok) throw new Error(`registered contract analytical projection ${response.status}`);
  return response.json();
}

/** Load the committed model, or a test-provided model, without source-store access. */
async function readModel(env, { procurementId = null, browse = false } = {}) {
  const injected = env?.PROCUREMENT_READ_MODEL
    || (env?.schema === "cityscroll.shared_procurement_read_model.v1" ? env : null);
  if (injected && typeof injected === "object") return injected;

  const manifest = await readStaticJson(SHARED_MODEL_PATH);
  if (Array.isArray(manifest?.rows)) return manifest;
  const shardPaths = procurementId
    ? [manifest?.procurement_shard_by_id?.[procurementId]].filter(Boolean)
    : browse ? (manifest?.shards || []).map((shard) => shard?.path).filter(Boolean) : [];
  if (!shardPaths.length) return { ...manifest, rows: [], observations: [] };
  const shards = await Promise.all(shardPaths.map((path) => readStaticJson(`/data/${path}`)));
  return combineSharedProcurementReadModel(manifest, shards);
}

function sourceSystemFromRef(ref) {
  return clean(ref).split(":", 1)[0].toLowerCase() || null;
}

function sourceObservationView(observation) {
  return {
    source_observation_ref: observation?.source_observation_ref || null,
    source_system: observation?.source_system || null,
    source_id: observation?.source_system_id || null,
    ingested_at: observation?.ingested_at || null,
  };
}

function sourceEnvelopes(model, observations) {
  const observed = new Set(observations.map((entry) => entry.source_system).filter(Boolean));
  return Object.fromEntries(Object.entries(model?.sources || {}).map(([source, envelope]) => {
    const status = envelope?.status || "unavailable";
    const state = observed.has(source)
      ? "observed"
      : ["unavailable", "partial"].includes(status) ? "not_observed" : "not_published";
    return [source, {
      state,
      status,
      generated_at: envelope?.generated_at || null,
      reason: envelope?.reason || null,
      source_row_count: envelope?.row_count ?? null,
    }];
  }));
}

function publicObject(object) {
  return {
    object_type: object.object_type,
    schema: object.schema,
    procurement_id: object.procurement_id,
    canonical_id: object.canonical_id,
    source_observation_refs: object.source_observation_refs,
    stages: object.stages,
    identity_keys: object.identity_keys,
    identity_edges: object.identity_edges,
    lifecycle: object.lifecycle || null,
    ...(Array.isArray(object.lifecycles) ? { lifecycles: object.lifecycles } : {}),
    compatibility: object.compatibility,
  };
}

function amountView(object, observations) {
  const value = publicProcurementAmount(object, observations);
  const valid = typeof value === "number" && Number.isFinite(value)
    && value > 0 && value < PUBLIC_AMOUNT_MAX_EXCLUSIVE;
  return {
    value: value == null ? null : value,
    valid,
    validity_rule: "finite amount greater than 0 and less than $10,000,000,000",
  };
}

function freshnessView(model) {
  const generatedAt = model?.generated_at || model?.freshness?.generated_at || null;
  return {
    as_of: generatedAt || "unknown",
    generated_at: generatedAt,
    checked_at: model?.freshness?.checked_at || null,
    sources: model?.freshness?.sources || {},
  };
}

function projectContract(model, object) {
  const observations = (Array.isArray(model?.observations) ? model.observations : [])
    .filter((entry) => object.source_observation_refs?.includes(entry.source_observation_ref));
  const document = materializeProcurementSearchDocument(object, model);
  const browseRow = document ? contractSearchDocumentToMoneyRow(document) : null;
  const sourceObservations = observations.map(sourceObservationView);
  const coverage = {
    state: "observed",
    source_envelopes: sourceEnvelopes(model, observations),
    not_published: Object.entries(sourceEnvelopes(model, observations))
      .filter(([, entry]) => entry.state === "not_published").map(([source]) => source),
    not_observed: Object.entries(sourceEnvelopes(model, observations))
      .filter(([, entry]) => entry.state === "not_observed").map(([source]) => source),
    not_yet_joined: Array.isArray(object.coverage?.not_yet_joined)
      ? object.coverage.not_yet_joined : [],
    publication: model?.publication || null,
  };
  return {
    ...publicObject(object),
    ...(browseRow ? { fields: (() => { const { search_document: _private, ...fields } = browseRow; return fields; })() } : {}),
    provenance: {
      identity: {
        exact: true,
        basis: "site/procurement_object_contract.mjs exact identity gate",
        canonical_id: object.procurement_id,
        prime_contract_ids: object.identity_keys?.contract_ids || [],
        epins: object.identity_keys?.epins || [],
      },
      source_observations: sourceObservations,
    },
    coverage,
    freshness: freshnessView(model),
    amount: amountView(object, observations),
  };
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

function lower(value) { return clean(value).toLowerCase(); }

function matchesBrowseInput(contract, input) {
  const fields = contract.fields || {};
  const query = lower(input.query);
  if (query && !query.split(/\s+/).filter(Boolean).every((term) => lower(JSON.stringify(fields)).includes(term))) return false;
  if (input.agency && !lower(fields.agency_name).includes(lower(input.agency))) return false;
  if (input.vendor && !lower(fields.vendor_name).includes(lower(input.vendor))) return false;
  if (input.stage && !(fields.procurement_stages || []).includes(input.stage)) return false;
  if (input.sourceSystem && !(fields.source_systems || []).includes(input.sourceSystem)) return false;
  const amount = contract.amount;
  if (input.minAmount !== undefined && (!amount.valid || amount.value < input.minAmount)) return false;
  if (input.maxAmount !== undefined && (!amount.valid || amount.value > input.maxAmount)) return false;
  return true;
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
        const model = await readModel(env, { browse: true });
        const cursorId = decodeCursor(input.cursor);
        if (input.cursor && !cursorId) throw new Error("invalid cursor");
        const candidates = modelObjects(model).slice().sort((a, b) => a.procurement_id.localeCompare(b.procurement_id));
        const matches = candidates.map((object) => projectContract(model, object)).filter((contract) => matchesBrowseInput(contract, input));
        const after = cursorId ? matches.findIndex((contract) => contract.procurement_id === cursorId) : -1;
        if (cursorId && after < 0) throw new Error("invalid cursor");
        const start = after + 1;
        const results = matches.slice(start, start + (input.limit || CONTRACTS_BROWSE_LIMITS.default));
        const truncated = start + results.length < matches.length;
        return {
          capability_reference: CONTRACTS_BROWSE_CAPABILITY_REFERENCE,
          availability: results.length ? "complete" : "empty",
          results,
          total_matches: matches.length,
          pagination: {
            limit: input.limit || CONTRACTS_BROWSE_LIMITS.default,
            returned: results.length,
            truncated,
            next_cursor: truncated ? encodeCursor(results.at(-1).procurement_id) : null,
          },
          coverage: {
            sources: model.sources || {},
            publication: model.publication || null,
          },
          freshness: freshnessView(model),
          error: null,
        };
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

function analyzeRegisteredContracts(projection, input) {
  if (projection?.schema !== ANALYTICAL_PROJECTION_SCHEMA || !Array.isArray(projection.rows)) {
    throw new Error("registered contract analytical projection is unavailable");
  }
  const filtered = filterAnalyticalContracts(projection.rows, analyticalInputFilters(input));
  const groupBy = input.groupBy || "agency";
  const measure = input.measure || "current";
  const grouped = groupAnalyticalContracts(filtered, { groupBy, measure, topN: input.limit || CONTRACTS_ANALYSIS_LIMITS.defaultGroups });
  const measureView = analyticalMeasure(measure);
  const valueKey = grouped.value_key;
  const groups = grouped.shown_groups.map((group) => {
    const value = Number(group[valueKey]) || 0;
    return {
      label: group.label,
      value,
      measure_value: value,
      unit: measureView.unit,
      contract_count: group.contract_count,
      contract_ids: [...group.contract_ids],
      drill_through: {
        href: analyticalHref(input, groupBy, group.label),
        filters: analyticalGroupFilters(input, groupBy, group.label),
      },
    };
  });
  const denominatorValue = grouped.groups.reduce((sum, group) => sum + (Number(group[valueKey]) || 0), 0);
  const denominatorContractCount = new Set(filtered.map((row) => row.prime_contract_id)).size;
  const denominatorValueCount = filtered.filter((row) => {
    const field = measure === "original" ? "original_registered_amount" : "current_registered_amount";
    return measure === "count" || Number.isFinite(Number(row[field]));
  }).length;
  const coverage = cityRecordCoverage(filtered, { min_amount: -Number.MAX_VALUE });
  const sourcePopulation = projection.source_population || {};
  const selectedDescription = denominatorContractCount
    ? `${denominatorContractCount.toLocaleString("en-US")} exact registered-contract rows after the requested filters`
    : "No exact registered-contract rows after the requested filters";
  return {
    capability_reference: CONTRACTS_ANALYSIS_CAPABILITY_REFERENCE,
    availability: groups.length ? CONTRACTS_ANALYSIS_AVAILABILITY[0] : CONTRACTS_ANALYSIS_AVAILABILITY[1],
    group_by: groupBy,
    measure: measureView,
    groups,
    denominator: {
      value: denominatorValue,
      unit: measureView.unit,
      contract_count: denominatorContractCount,
      value_count: denominatorValueCount,
      definition: `Selected filtered registered-contract population; ${measureView.reader_label} is not payments or agency spending.`,
    },
    population: {
      fact: "registered_contract",
      basis: projection.population_definition || "Normalized Checkbook NYC registered expense contracts",
      included: selectedDescription,
      excluded: [
        "AP-08 payment transactions and actual payment amounts",
        "contracts outside the committed analytical projection",
        ...(denominatorValueCount < denominatorContractCount ? [`${denominatorContractCount - denominatorValueCount} rows without a numeric value for this measure` ] : []),
      ],
      contract_count: denominatorContractCount,
      source_population: sourcePopulation,
      snapshot_date: projection.snapshot_date || null,
    },
    coverage: {
      statement: `City Record exact-PIN match coverage for the selected registered-contract population: ${coverage.matched_contract_count.toLocaleString("en-US")} of ${coverage.eligible_contract_count.toLocaleString("en-US")} eligible contracts; rows without a published PIN cannot be evaluated.`,
      basis: "existing exact normalized Checkbook PIN ↔ City Record award PIN overlap",
      eligible_contract_count: coverage.eligible_contract_count,
      matched_contract_count: coverage.matched_contract_count,
      unmatched_contract_count: coverage.unmatched_contract_count,
      missing_pin_contract_count: coverage.missing_pin_contract_count,
      eligible_registered_value: coverage.eligible_registered_value,
      matched_registered_value: coverage.matched_registered_value,
      buckets: coverage.buckets,
    },
    filters: publicAnalyticalFilters(input),
    freshness: {
      as_of: projection.generated_at || projection.snapshot_date || "unknown",
      generated_at: projection.generated_at || null,
      snapshot_date: projection.snapshot_date || null,
      source: "committed site/data/analytics_registered_contracts.json",
    },
    error: null,
  };
}

export function workerContractsAnalysis(env) {
  return Object.freeze({
    capabilityReference: CONTRACTS_ANALYSIS_CAPABILITY_REFERENCE,
    providerId: CONTRACTS_ANALYSIS_PROVIDER_ID,
    async execute(input) {
      try {
        return analyzeRegisteredContracts(await readAnalyticalProjection(env), input);
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
  if (result.availability === "empty") return "No registered contracts match the bounded analytical filters.";
  if (result.availability === "unavailable") return "Contracts analysis is unavailable right now.";
  const measure = `${result.measure.reader_label} (${result.measure.unit})`;
  const lines = [
    `${result.group_by}: ${measure}; denominator ${result.denominator.value.toLocaleString("en-US")} ${result.denominator.unit} across ${result.denominator.contract_count.toLocaleString("en-US")} contracts.`,
    ...result.groups.map((group, index) => `${index + 1}. ${group.label} — ${group.value.toLocaleString("en-US")} ${group.unit}; ${group.contract_count} contracts (${group.contract_ids.join(", ")})`),
    result.coverage.statement,
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
  const input = {
    ...(url.searchParams.has("q") ? { query: String(url.searchParams.get("q")) } : {}),
    ...(url.searchParams.has("query") ? { query: String(url.searchParams.get("query")) } : {}),
    ...(url.searchParams.has("agency") ? { agency: String(url.searchParams.get("agency")) } : {}),
    ...(url.searchParams.has("vendor") ? { vendor: String(url.searchParams.get("vendor")) } : {}),
    ...(url.searchParams.has("stage") ? { stage: String(url.searchParams.get("stage")) } : {}),
    ...(url.searchParams.has("source_system") ? { sourceSystem: String(url.searchParams.get("source_system")) } : {}),
    ...(url.searchParams.has("min_amount") ? { minAmount: Number(url.searchParams.get("min_amount")) } : {}),
    ...(url.searchParams.has("max_amount") ? { maxAmount: Number(url.searchParams.get("max_amount")) } : {}),
    ...(url.searchParams.has("limit") ? { limit: Number(url.searchParams.get("limit")) } : {}),
    ...(url.searchParams.has("cursor") ? { cursor: String(url.searchParams.get("cursor")) } : {}),
  };
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
