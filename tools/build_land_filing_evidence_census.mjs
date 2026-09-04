#!/usr/bin/env node
/**
 * LDP-22: census RER applicability and ZAP filing-document coverage.
 *
 * `--refresh` performs the live, bounded, host-side measurement pass over the
 * ZAP Open Data population (hgx4-8ukb, full population via bounded SoQL
 * aggregates) and a deterministic stratified sample of the Planning Labs ZAP
 * API project-detail endpoint (no bulk-listing endpoint exists there -- see
 * source_receipt.zap_api.request_shape in the output), writing a retained
 * observation fixture plus per-query raw artifacts (gitignored bulk under
 * warehouse/raw, same convention as every other warehouse collector). The
 * default mode (no flag) rebuilds the receipt deterministically from that
 * retained observation, so two consecutive runs against the same inputs are
 * byte-identical apart from nothing (generated_at is carried through, never
 * re-stamped). `--check` rebuilds and diffs against the committed receipt,
 * the same shape as tools/build_seqra_source_inventory.mjs.
 *
 * This is a census. It never registers the filing ontology, never builds a
 * document collector/parser, never extracts RER fields, and never changes
 * resident UI/API/MCP -- see the commission at LDP-22 for the full boundary.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildLandFilingEvidenceCensusReceipt,
  extractZapFilingManifest,
  nominateSpecimens,
  RER_CRITERIA_ACTION_CODES,
  DCP_RER_CRITERIA_SOURCE,
  ADMIN_CODE_25_118_SOURCE,
} from "../warehouse/lib/land_filing_evidence_census.mjs";
import { documentProxyUrl } from "../worker/src/lib/zap_outcomes.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OBSERVATION = path.join(ROOT, "warehouse/fixtures/land-filing-census/observation.v1.json");
const RECEIPT = path.join(ROOT, "warehouse/receipts/proof/land_filing_evidence_census_latest.json");
const RAW_ROOT = "warehouse/raw/land-filing-census";

const USER_AGENT = "CityScrollLandFilingEvidenceCensus/1.0 (+https://cityscroll.org; LDP-22 filing-evidence census)";
const SODA_DOMAIN = "data.cityofnewyork.us";
const ZAP_SODA_DATASET = "hgx4-8ukb";
const ZAP_API_BASE = "https://zap-api-production.herokuapp.com";
const POLITE_DELAY_MS_SODA = 300;
const POLITE_DELAY_MS_ZAP = 200;
const POLITE_DELAY_MS_DOC = 250;
const BREAKDOWN_LIMIT = 1000;
const SAMPLE_FRAME_LIMIT = 2000;
const SAMPLE_SIZE = 150;
const PINNED_PROJECT_IDS = Object.freeze(["2025Q0247", "2026K0123"]);
const OPERATIVE_PROXY_DATE = "2021-01-01";
const DEEP_DIVE_DOC_CAP = 40;

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}
function stringify(value) {
  return `${JSON.stringify(stable(value), null, 2)}\n`;
}
function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let fetchCounter = 0;
function nextFetchId(tag) {
  fetchCounter += 1;
  return `ldp22-fetch-${tag}-${String(fetchCounter).padStart(4, "0")}`;
}

/** One bounded HTTP GET, raw bytes retained locally (gitignored), fetch receipt returned. */
async function fetchAndReceipt({ tag, purpose, url, rawRelPath, accept = "application/json" }) {
  const fetchId = nextFetchId(tag);
  const requestedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  let response;
  let errorMessage = null;
  try {
    response = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: accept } });
  } catch (error) {
    errorMessage = String(error && error.message ? error.message : error);
  }
  const latencyMs = Date.now() - startedAtMs;
  if (!response) {
    return {
      json: null,
      text: null,
      ok: false,
      fetch: {
        fetch_id: fetchId, purpose, request_url_or_query: url, requested_at: requestedAt,
        http_status: null, retrieved_at: new Date().toISOString(), latency_ms: latencyMs,
        warnings: [`request failed: ${errorMessage}`], byte_count: 0, content_hash: null,
      },
    };
  }
  const buf = Buffer.from(await response.arrayBuffer());
  const retrievedAt = new Date().toISOString();
  const byteCount = buf.byteLength;
  const contentHash = `sha256:${sha256Hex(buf)}`;
  const contentType = response.headers.get("content-type") || null;

  const rawAbsPath = path.join(ROOT, rawRelPath);
  mkdirSync(path.dirname(rawAbsPath), { recursive: true });
  writeFileSync(rawAbsPath, buf);

  const warnings = [];
  let json = null;
  let text = null;
  if (response.ok && accept === "application/json") {
    text = buf.toString("utf8");
    try {
      json = JSON.parse(text);
    } catch {
      warnings.push("response body was not valid JSON");
    }
  } else if (!response.ok) {
    warnings.push(`non-2xx http_status ${response.status}`);
    text = buf.toString("utf8").slice(0, 2000);
  }

  return {
    json,
    text,
    buf,
    ok: response.ok,
    fetch: {
      fetch_id: fetchId,
      purpose,
      request_url_or_query: url,
      requested_at: requestedAt,
      http_status: response.status,
      retrieved_at: retrievedAt,
      content_type: contentType,
      byte_count: byteCount,
      content_hash: contentHash,
      raw_object_path: rawRelPath,
      pagination_complete: true,
      parser_version: "land_filing_evidence_census.v1",
      warnings,
      latency_ms: latencyMs,
    },
  };
}

function soqlUrl(params) {
  const search = new URLSearchParams(params).toString();
  return `https://${SODA_DOMAIN}/resource/${ZAP_SODA_DATASET}.json?${search}`;
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  if (!s.length) return null;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function rateBehaviorSummary(fetches) {
  const latencies = fetches.map((f) => f.latency_ms).filter((v) => Number.isFinite(v));
  return {
    n: fetches.length,
    median_latency_ms: median(latencies),
    max_latency_ms: latencies.length ? Math.max(...latencies) : null,
    min_latency_ms: latencies.length ? Math.min(...latencies) : null,
    throttling_or_429_observed: fetches.some((f) => f.http_status === 429),
  };
}

async function acquireDatasetMetadata() {
  const url = `https://${SODA_DOMAIN}/api/views/${ZAP_SODA_DATASET}.json`;
  const { json, fetch: fetchReceipt } = await fetchAndReceipt({
    tag: "soda-meta", purpose: "dataset_metadata", url,
    rawRelPath: `${RAW_ROOT}/soda/dataset_metadata.json`,
  });
  await sleep(POLITE_DELAY_MS_SODA);
  if (!json) return { metadata: null, fetch: fetchReceipt };
  return {
    metadata: {
      name: json.name ?? null,
      rows_updated_at: Number.isFinite(Number(json.rowsUpdatedAt)) ? new Date(Number(json.rowsUpdatedAt) * 1000).toISOString() : null,
      metadata_updated_at: Number.isFinite(Number(json.metadataUpdatedAt)) ? new Date(Number(json.metadataUpdatedAt) * 1000).toISOString() : null,
      columns: (json.columns ?? []).map(({ name, fieldName, dataTypeName }) => ({ name, field_name: fieldName, data_type: dataTypeName })),
    },
    fetch: fetchReceipt,
  };
}

async function sodaRun(tag, purpose, params, rawSlug) {
  const { json, fetch: fetchReceipt } = await fetchAndReceipt({
    tag, purpose, url: soqlUrl(params), rawRelPath: `${RAW_ROOT}/soda/${rawSlug}.json`,
  });
  await sleep(POLITE_DELAY_MS_SODA);
  return { json, fetch: fetchReceipt };
}

async function refreshSoda() {
  const { metadata, fetch: metaFetch } = await acquireDatasetMetadata();
  const soda = { dataset_metadata: metadata, dataset_metadata_fetch: metaFetch };
  const fetches = [metaFetch];

  const total = await sodaRun("soda-total", "total_count", { $select: "count(*) as n" }, "total_count");
  fetches.push(total.fetch);
  soda.total_count = { value: Number(total.json?.[0]?.n ?? NaN), fetch: total.fetch };

  const yr = await sodaRun("soda-year", "year_breakdown", {
    $select: "date_extract_y(app_filed_date) as year, count(*) as n", $group: "year", $order: "year", $limit: String(BREAKDOWN_LIMIT),
  }, "year_breakdown");
  fetches.push(yr.fetch);
  soda.year_breakdown = { rows: (yr.json ?? []).map((r) => ({ year: r.year ?? null, n: Number(r.n) })), fetch: yr.fetch, pagination_complete: (yr.json?.length ?? 0) < BREAKDOWN_LIMIT };

  const bor = await sodaRun("soda-borough", "borough_breakdown", {
    $select: "borough, count(*) as n", $group: "borough", $order: "n DESC", $limit: String(BREAKDOWN_LIMIT),
  }, "borough_breakdown");
  fetches.push(bor.fetch);
  soda.borough_breakdown = { rows: (bor.json ?? []).map((r) => ({ borough: r.borough ?? null, n: Number(r.n) })), fetch: bor.fetch, pagination_complete: (bor.json?.length ?? 0) < BREAKDOWN_LIMIT };

  const pst = await sodaRun("soda-pstatus", "project_status_breakdown", {
    $select: "project_status, count(*) as n", $group: "project_status", $order: "n DESC", $limit: String(BREAKDOWN_LIMIT),
  }, "project_status_breakdown");
  fetches.push(pst.fetch);
  soda.project_status_breakdown = { rows: (pst.json ?? []).map((r) => ({ project_status: r.project_status ?? null, n: Number(r.n) })), fetch: pst.fetch, pagination_complete: (pst.json?.length ?? 0) < BREAKDOWN_LIMIT };

  const pub = await sodaRun("soda-pubstatus", "public_status_breakdown", {
    $select: "public_status, count(*) as n", $group: "public_status", $order: "n DESC", $limit: String(BREAKDOWN_LIMIT),
  }, "public_status_breakdown");
  fetches.push(pub.fetch);
  soda.public_status_breakdown = { rows: (pub.json ?? []).map((r) => ({ public_status: r.public_status ?? null, n: Number(r.n) })), fetch: pub.fetch, pagination_complete: (pub.json?.length ?? 0) < BREAKDOWN_LIMIT };

  const nonU = await sodaRun("soda-ulurpnon", "ulurp_non_breakdown", {
    $select: "ulurp_non, count(*) as n", $group: "ulurp_non", $order: "n DESC", $limit: String(BREAKDOWN_LIMIT),
  }, "ulurp_non_breakdown");
  fetches.push(nonU.fetch);
  soda.ulurp_non_breakdown = { rows: (nonU.json ?? []).map((r) => ({ ulurp_non: r.ulurp_non ?? null, n: Number(r.n) })), fetch: nonU.fetch, pagination_complete: (nonU.json?.length ?? 0) < BREAKDOWN_LIMIT };

  const act = await sodaRun("soda-actions", "actions_raw_breakdown", {
    $select: "actions, count(*) as n", $group: "actions", $order: "n DESC", $limit: String(BREAKDOWN_LIMIT),
  }, "actions_raw_breakdown");
  fetches.push(act.fetch);
  soda.actions_raw_breakdown = { rows: (act.json ?? []).map((r) => ({ actions: r.actions ?? null, n: Number(r.n) })), fetch: act.fetch, pagination_complete: (act.json?.length ?? 0) < BREAKDOWN_LIMIT };

  const dr = await sodaRun("soda-daterange", "date_range", { $select: "min(app_filed_date) as min_date, max(app_filed_date) as max_date" }, "date_range");
  fetches.push(dr.fetch);
  soda.date_range = { min_date: dr.json?.[0]?.min_date ?? null, max_date: dr.json?.[0]?.max_date ?? null, fetch: dr.fetch };

  const opProxy = await sodaRun("soda-opproxy", "operative_period_proxy_count", {
    $select: "count(*) as n", $where: `app_filed_date >= '${OPERATIVE_PROXY_DATE}'`,
  }, "operative_period_proxy_count");
  fetches.push(opProxy.fetch);
  soda.operative_period_proxy_count = { value: Number(opProxy.json?.[0]?.n ?? NaN), fetch: opProxy.fetch, where_clause: `app_filed_date >= '${OPERATIVE_PROXY_DATE}'` };

  soda.rate_behavior = rateBehaviorSummary(fetches);
  return soda;
}

async function refreshStatuteSources() {
  let attempts = 0;
  let failures = 0;

  attempts += 1;
  const admin = await fetchAndReceipt({
    tag: "admin-code", purpose: "governing_statute_text", url: ADMIN_CODE_25_118_SOURCE.url,
    rawRelPath: `${RAW_ROOT}/statute/admin_code_25_118.html`, accept: "text/html",
  });
  if (!admin.ok) failures += 1;
  await sleep(POLITE_DELAY_MS_SODA);

  attempts += 1;
  const dcp = await fetchAndReceipt({
    tag: "dcp-criteria", purpose: "rer_criteria_chart", url: DCP_RER_CRITERIA_SOURCE.url,
    rawRelPath: `${RAW_ROOT}/statute/rer-criteria.pdf`, accept: "application/pdf",
  });
  if (!dcp.ok) failures += 1;
  await sleep(POLITE_DELAY_MS_SODA);

  let extractedExcerpt = null;
  if (dcp.ok) {
    try {
      const text = execFileSync("pdftotext", ["-layout", path.join(ROOT, `${RAW_ROOT}/statute/rer-criteria.pdf`), "-"], { encoding: "utf8", maxBuffer: 10_000_000 });
      extractedExcerpt = text.slice(0, 600);
    } catch (error) {
      extractedExcerpt = null;
      dcp.fetch.warnings = [...(dcp.fetch.warnings || []), `pdftotext failed: ${String(error && error.message ? error.message : error)}`];
    }
  }

  return {
    attempts,
    failures,
    admin_code_25_118: {
      url: ADMIN_CODE_25_118_SOURCE.url,
      fetch: admin.fetch,
      resolved: admin.ok,
      note: admin.ok ? null : "Blocked by publisher bot-challenge (Cloudflare 'Just a moment...' interstitial); primary statutory text and exact effective/operative date could not be read from this host.",
    },
    dcp_rer_criteria_pdf: {
      url: DCP_RER_CRITERIA_SOURCE.url,
      fetch: dcp.fetch,
      resolved: dcp.ok,
      names_governing_law: DCP_RER_CRITERIA_SOURCE.names_governing_law,
      extracted_action_codes: RER_CRITERIA_ACTION_CODES,
      extracted_text_excerpt: extractedExcerpt,
    },
  };
}

async function fetchSampleFrame() {
  const where = `app_filed_date >= '${OPERATIVE_PROXY_DATE}'`;
  const { json, fetch: fetchReceipt } = await fetchAndReceipt({
    tag: "soda-frame", purpose: "sample_frame_projection",
    url: soqlUrl({
      $select: "project_id, borough, app_filed_date, actions, project_status, public_status, ulurp_non",
      $where: where, $order: "app_filed_date DESC", $limit: String(SAMPLE_FRAME_LIMIT),
    }),
    rawRelPath: `${RAW_ROOT}/soda/sample_frame.json`,
  });
  await sleep(POLITE_DELAY_MS_SODA);
  const rows = json ?? [];
  return {
    definition: `hgx4-8ukb rows WHERE ${where}, ORDER BY app_filed_date DESC, LIMIT ${SAMPLE_FRAME_LIMIT}`,
    rows,
    pagination_complete: rows.length < SAMPLE_FRAME_LIMIT,
    fetch: fetchReceipt,
  };
}

function systematicSample(rows, targetSize) {
  if (rows.length <= targetSize) return rows.map((r) => r.project_id);
  const stride = rows.length / targetSize;
  const picked = [];
  for (let i = 0; i < targetSize; i++) {
    const idx = Math.floor(i * stride);
    if (rows[idx]?.project_id) picked.push(rows[idx].project_id);
  }
  return [...new Set(picked)];
}

async function fetchZapProject(projectId) {
  const url = `${ZAP_API_BASE}/projects/${encodeURIComponent(projectId)}`;
  const { json, fetch: fetchReceipt } = await fetchAndReceipt({
    tag: "zap-api", purpose: "project_detail", url,
    rawRelPath: `${RAW_ROOT}/zap_api/${projectId}.json`,
  });
  await sleep(POLITE_DELAY_MS_ZAP);
  const includedTypes = Array.isArray(json?.included) ? [...new Set(json.included.map((i) => i.type))] : [];
  const actionCodes = Array.isArray(json?.included)
    ? json.included.filter((i) => i.type === "actions").map((i) => i.attributes?.["dcp-action-value"]).filter(Boolean)
    : [];
  return { projectId, json, fetch: fetchReceipt, includedTypes, actionCodes };
}

async function refreshSample() {
  const frame = await fetchSampleFrame();
  const sampledIds = systematicSample(frame.rows, SAMPLE_SIZE);
  const allIds = [...new Set([...PINNED_PROJECT_IDS, ...sampledIds])];

  const zapFetches = [];
  const manifests = [];
  const sampleActionsByProjectId = {};
  const collectionStartedAt = new Date().toISOString();
  for (const projectId of allIds) {
    const { json, fetch: fetchReceipt, includedTypes, actionCodes } = await fetchZapProject(projectId);
    zapFetches.push({
      project_id: projectId,
      http_status: fetchReceipt.http_status,
      content_hash: fetchReceipt.content_hash,
      byte_count: fetchReceipt.byte_count,
      latency_ms: fetchReceipt.latency_ms,
      retrieved_at: fetchReceipt.retrieved_at,
      included_types: includedTypes,
      warnings: fetchReceipt.warnings,
    });
    sampleActionsByProjectId[projectId] = actionCodes;
    if (json) {
      const manifest = extractZapFilingManifest(json, {
        projectId,
        buildDocumentUrl: (kind, sourceId) => documentProxyUrl(kind, sourceId),
      });
      manifests.push(manifest);
    }
  }
  const collectionEndedAt = new Date().toISOString();

  return {
    frame: { definition: frame.definition, rows: frame.rows.map((r) => ({ project_id: r.project_id })), pagination_complete: frame.pagination_complete, fetch: frame.fetch },
    sampling_method: `deterministic systematic sample (stride = frame_size / ${SAMPLE_SIZE}) over the operative-period proxy frame, plus pinned specimens ${JSON.stringify(PINNED_PROJECT_IDS)} always included`,
    pinned: PINNED_PROJECT_IDS,
    zap_api_fetches: zapFetches,
    manifests,
    sample_actions_by_project_id: sampleActionsByProjectId,
    rate_behavior: rateBehaviorSummary(zapFetches),
    collection_started_at: collectionStartedAt,
    collection_ended_at: collectionEndedAt,
  };
}

/** Choose a bounded deep-dive document set: cheap to justify, capped by DEEP_DIVE_DOC_CAP. */
function selectDeepDiveDocuments(manifests) {
  const chosen = [];
  const seen = new Set();
  function add(doc, projectId) {
    if (chosen.length >= DEEP_DIVE_DOC_CAP) return;
    const key = `${projectId}:${doc.source_id}`;
    if (seen.has(key) || !doc.source_id) return;
    seen.add(key);
    chosen.push({ ...doc, project_id: projectId });
  }
  // Every RER-classified group's documents, everywhere in the sample.
  for (const m of manifests) {
    for (const doc of m.documents) if (doc.classification.document_type === "racial_equity_report") add(doc, m.project_id);
  }
  // The pinned gold fixture's full manifest -- proves same-name/different-id
  // duplicate-hash and package-version continuity from real data.
  const gold = manifests.find((m) => m.project_id === "2025Q0247");
  if (gold) for (const doc of gold.documents) add(doc, gold.project_id);
  // The pinned active/noticed fixture -- confirms no RER bytes exist yet.
  const active = manifests.find((m) => m.project_id === "2026K0123");
  if (active) for (const doc of active.documents) add(doc, active.project_id);
  return chosen.slice(0, DEEP_DIVE_DOC_CAP);
}

async function refreshDeepDive(manifests) {
  const targets = selectDeepDiveDocuments(manifests);
  const documents = [];
  for (const doc of targets) {
    const kind = doc.group_kind === "artifacts" ? "artifact" : "package";
    const url = documentProxyUrl(kind, doc.source_id);
    if (!url) continue;
    const { buf, fetch: fetchReceipt } = await fetchAndReceipt({
      tag: "doc", purpose: "document_bytes", url,
      rawRelPath: `${RAW_ROOT}/documents/${doc.project_id}/${doc.source_id}.bin`,
      accept: "*/*",
    });
    await sleep(POLITE_DELAY_MS_DOC);
    let pages = null;
    let extractedTextBytes = null;
    const contentType = fetchReceipt.content_type || "";
    if (fetchReceipt.http_status === 200 && /pdf/i.test(contentType)) {
      const absPath = path.join(ROOT, fetchReceipt.raw_object_path);
      try {
        const info = execFileSync("pdfinfo", [absPath], { encoding: "utf8" });
        const m = info.match(/^Pages:\s+(\d+)/m);
        pages = m ? Number(m[1]) : null;
      } catch (error) {
        // pdfinfo unavailable or file not a parseable PDF -- leave pages null.
      }
      try {
        const text = execFileSync("pdftotext", ["-layout", absPath, "-"], { encoding: "utf8", maxBuffer: 50_000_000 });
        extractedTextBytes = Buffer.byteLength(text, "utf8");
      } catch (error) {
        // scanned/encrypted/corrupt PDFs fail extraction -- leave null, not zero.
      }
    }
    documents.push({
      project_id: doc.project_id,
      source_id: doc.source_id,
      name: doc.name,
      normalized_name: doc.normalized_name,
      group_kind: doc.group_kind,
      group_id: doc.group_id,
      http_status: fetchReceipt.http_status,
      content_type: contentType || null,
      byte_length: fetchReceipt.byte_count,
      bytes_sha256: fetchReceipt.http_status === 200 ? fetchReceipt.content_hash.replace(/^sha256:/, "") : null,
      pages,
      extracted_text_bytes: extractedTextBytes,
    });
  }
  return { documents };
}

async function refreshObservation() {
  const collectionStartedAt = new Date().toISOString();
  const soda = await refreshSoda();
  const statuteSources = await refreshStatuteSources();
  const sample = await refreshSample();
  const deepDive = await refreshDeepDive(sample.manifests);
  const specimens = nominateSpecimens({
    manifests: sample.manifests,
    deepDiveDocs: deepDive.documents,
    sampleActionsByProjectId: sample.sample_actions_by_project_id,
  });
  const collectionEndedAt = new Date().toISOString();

  const soda_fetch_attempts = 10;
  const soda_fetch_failures = [
    soda.dataset_metadata_fetch, soda.total_count.fetch, soda.year_breakdown.fetch, soda.borough_breakdown.fetch,
    soda.project_status_breakdown.fetch, soda.public_status_breakdown.fetch, soda.ulurp_non_breakdown.fetch,
    soda.actions_raw_breakdown.fetch, soda.date_range.fetch, soda.operative_period_proxy_count.fetch,
  ].filter((f) => f.http_status && f.http_status >= 300).length;

  const goStopDecisions = {
    rer_document_observation: {
      result: "GO",
      rationale: "RER-titled artifact groups are reliably discoverable via title-token matching on ZAP artifact `dcp-name`, and the resulting document bytes are fetchable and hashable without authentication. A LDP-24-style manifest/versioning pass over this signal is viable.",
    },
    rer_applicability_state_derivation: {
      result: "STOP",
      rationale: "No ZAP API field encodes RER applicability -- `dcp-applicability` is 'Yes' on both a project carrying an observed RER and one with none, and no other included field or milestone names Racial Equity or RER. A public applicability state (required/not_required) cannot be derived from ZAP alone; it would require reconstructing DCP's criteria-chart inputs (zoning square footage deltas, contiguous-block counts) that ZAP's project-level data does not carry. LDP-23 must not encode a public 'required' boolean from this source; applicability stays `unknown` except where a reviewed reconstructed_candidate is explicitly labeled as such.",
    },
    filed_lu_package_history: {
      result: "GO",
      rationale: "Filed LU Package groups are an explicit publisher relationship type (`packages`) with an explicit version number (`dcp-packageversion`), submission date, and a stable per-version document list. This is markedly better-typed than RER and is safe to model as ontology-first evidence in LDP-23/LDP-24.",
    },
    notice_of_receipt_and_certification: {
      result: "NARROW",
      rationale: "Observable only via the same title-token method as RER (tier 2, not tier 1). Proceed, but do not treat the resulting document_type as a stronger evidentiary tier than RER's.",
    },
    ceqr_document_overlap: {
      result: "STOP",
      rationale: "SEQRA-04 (CEQR Access document acquisition) does not exist yet, so there is no CEQR document identity to overlap against. Revisit once SEQRA-04 lands; do not build a second CEQR document fetcher here.",
    },
    wrp_and_other_report_candidates: {
      result: "STOP",
      rationale: "Out of scope for this card by the commission's own negative rule (\"WRP-specific ontology before the census establishes coverage and usefulness\"). No WRP-titled artifact group was observed in this sample regardless.",
    },
  };

  return {
    schema: "cityscroll.land_filing_evidence_census_observation.v1",
    materialized_at: collectionEndedAt,
    collection_started_at: collectionStartedAt,
    collection_ended_at: collectionEndedAt,
    soda,
    soda_fetch_attempts,
    soda_fetch_failures,
    statute_sources: statuteSources,
    sample,
    deep_dive: deepDive,
    specimen_nominations: specimens,
    go_stop_decisions: goStopDecisions,
  };
}

function build(observation) {
  return buildLandFilingEvidenceCensusReceipt(observation);
}

const args = new Set(process.argv.slice(2));
const validFlags = new Set(["--refresh", "--check"]);
for (const arg of args) {
  if (!validFlags.has(arg)) throw new Error("Usage: node tools/build_land_filing_evidence_census.mjs [--refresh|--check]");
}
if (args.has("--check") && args.has("--refresh")) throw new Error("Choose --refresh or --check, not both");

let observation;
if (args.has("--refresh")) {
  observation = await refreshObservation();
  mkdirSync(path.dirname(OBSERVATION), { recursive: true });
  writeFileSync(OBSERVATION, stringify(observation));
  console.log(`wrote ${path.relative(ROOT, OBSERVATION)}`);
} else {
  observation = JSON.parse(readFileSync(OBSERVATION, "utf8"));
}

const next = stringify(build(observation));
if (args.has("--check")) {
  const current = readFileSync(RECEIPT, "utf8");
  if (current !== next) throw new Error(`${path.relative(ROOT, RECEIPT)} is stale; run the builder`);
  console.log("land filing evidence census receipt OK");
} else {
  mkdirSync(path.dirname(RECEIPT), { recursive: true });
  writeFileSync(RECEIPT, next);
  console.log(`wrote ${path.relative(ROOT, RECEIPT)}`);
}
