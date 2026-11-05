/**
 * Bounded PASSPort Navigator document observation for explicitly named RFx rounds.
 *
 * This binding keeps round identity on `rfp_id`, records the separately displayed
 * process id and round label, and reuses the shared document-processing primitives
 * for content-addressed storage and extraction receipts. Recognized public
 * templates pass through the bounded deterministic fact reader; every other
 * template records an abstention. This module does not crawl, follow redirects,
 * authenticate, write PDF bytes to D1, invoke a model, or run OCR.
 */
import { createHash } from "node:crypto";

import {
  assessPageQuality,
  buildExtractionReceipt,
  fetchAndStoreDocument,
} from "./document_processing.mjs";
import {
  projectNavigatorDocumentFacts,
  summarizeNavigatorDocumentFacts,
} from "./navigator_rfx_document_facts.mjs";
import { extractPdfPagesViaPython } from "./seqra_document_extraction.mjs";

export const NAVIGATOR_DOCUMENT_SCHEMA = "cityscroll.procurement_document_read_model_shard.v1";
export const NAVIGATOR_MANIFEST_SCHEMA = "cityscroll.procurement_document_read_model.v1";
export const NAVIGATOR_OBSERVER_VERSION = "navigator_rfx_documents.v1";
export const NAVIGATOR_STORAGE_NAMESPACE = "passport-navigator";
export const NAVIGATOR_SOURCE_ID = "passport_navigator_rfx";
export const NAVIGATOR_HOST = "passport.cityofnewyork.us";
export const NAVIGATOR_DOCUMENT_HOST = "webserver-mocs-prd.lfr.cloud";
export const NAVIGATOR_BASE_URL =
  `https://${NAVIGATOR_HOST}/page.aspx/en/bpm/process_manage_extranet`;
export const MAX_TARGET_RFX_IDS = 10;
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

const PDF_SIGNATURE = Buffer.from("%PDF-");

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function headerValue(headers, name) {
  if (typeof headers?.get === "function") return headers.get(name);
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() === wanted) return value;
  }
  return null;
}

function failure(type, details = {}) {
  return Object.freeze({ type, ...details });
}

function cleanText(value) {
  return String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizedNumericId(value) {
  const text = String(value ?? "").trim();
  return /^\d+$/.test(text) ? String(Number.parseInt(text, 10)) : null;
}

export function navigatorUrlForRfpId(rfpId) {
  const id = String(rfpId ?? "").trim();
  if (!/^\d{3,}$/.test(id)) throw new Error(`invalid rfp_id ${JSON.stringify(rfpId)}`);
  return `${NAVIGATOR_BASE_URL}/${encodeURIComponent(id)}`;
}

export function isAllowedNavigatorUrl(url) {
  try {
    const parsed = new URL(String(url));
    return parsed.protocol === "https:" && parsed.hostname === NAVIGATOR_HOST
      && /^\/page\.aspx\/en\/bpm\/process_manage_extranet\/\d+$/.test(parsed.pathname);
  } catch {
    return false;
  }
}

export function isAllowedNavigatorDocumentUrl(url) {
  try {
    const parsed = new URL(String(url));
    return parsed.protocol === "https:" && parsed.hostname === NAVIGATOR_DOCUMENT_HOST
      && parsed.pathname === "/c/public_document/download"
      && /^\d+$/.test(parsed.searchParams.get("documentId") || "");
  } catch {
    return false;
  }
}

export function looksLikeLoginHtml(html) {
  const source = String(html || "");
  return /<input\b[^>]*type=["']?password/i.test(source)
    || /<form\b[^>]*(?:action|id|class)=["'][^"']*(?:login|signin|logon)/i.test(source);
}

/** Parse one saved anonymous Navigator response without executing page scripts. */
export function parseNavigatorRfxHtml(html, { navigatorUrl = NAVIGATOR_BASE_URL } = {}) {
  const source = String(html || "");
  if (looksLikeLoginHtml(source)) {
    return { ok: false, failure: failure("access_required") };
  }

  const title = cleanText(source.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "");
  const identity = /\((\d+)\)\s*-\s*Lot\s*:\s*(.*?)\s*\/\s*Round\s*:\s*([^:<]+)/i.exec(title);
  if (!identity) {
    return { ok: false, failure: failure("navigator_identity_missing") };
  }

  const documentsById = new Map();
  const anchorPattern = /<a\b([^>]*\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of source.matchAll(anchorPattern)) {
    const href = match[2] || match[3] || match[4] || "";
    let url;
    try {
      url = new URL(href.replace(/&amp;/gi, "&"), navigatorUrl).toString();
    } catch {
      continue;
    }
    let documentId = null;
    try {
      documentId = new URL(url).searchParams.get("documentId");
    } catch {
      // The URL was already parsed above; retain the defensive branch.
    }
    if (!documentId || !/^\d+$/.test(documentId)) continue;
    if (documentsById.has(documentId)) continue;
    documentsById.set(documentId, Object.freeze({
      document_id: documentId,
      label: cleanText(match[5]),
      official_url: url,
    }));
  }

  return {
    ok: true,
    title,
    displayed_id: identity[1],
    lot_label: cleanText(identity[2]) || null,
    round_label: cleanText(identity[3]),
    documents: Object.freeze([...documentsById.values()]),
  };
}

/**
 * Fetch one response without following redirects and stop reading as soon as
 * the declared or streamed byte limit is crossed.
 */
export async function boundedHttpGet(url, {
  fetchImpl = globalThis.fetch,
  maxBytes = MAX_DOCUMENT_BYTES,
  allowedUrl = () => true,
} = {}) {
  if (!allowedUrl(url)) return { ok: false, failure: failure("host_rejected", { request_url: String(url) }) };
  const response = await fetchImpl(url, { redirect: "manual", credentials: "omit" });
  const finalUrl = response.url || String(url);
  if (response.status >= 300 && response.status < 400) {
    return { ok: false, failure: failure("redirect_rejected", { request_url: String(url), final_url: finalUrl, status: response.status }) };
  }
  if (finalUrl !== String(url) || response.redirected) {
    return { ok: false, failure: failure("redirect_rejected", { request_url: String(url), final_url: finalUrl, status: response.status }) };
  }

  const declared = Number.parseInt(headerValue(response.headers, "content-length") || "", 10);
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, failure: failure("oversize_declared", { bytes: declared, limit: maxBytes }) };
  }

  const chunks = [];
  let length = 0;
  if (typeof response.body?.getReader === "function") {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      length += chunk.length;
      if (length > maxBytes) {
        await reader.cancel();
        return { ok: false, failure: failure("oversize_streamed", { bytes: length, limit: maxBytes }) };
      }
      chunks.push(chunk);
    }
  } else {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) {
      return { ok: false, failure: failure("oversize_streamed", { bytes: bytes.length, limit: maxBytes }) };
    }
    chunks.push(bytes);
    length = bytes.length;
  }

  return {
    ok: true,
    status: response.status,
    headers: response.headers,
    bytes: Buffer.concat(chunks, length),
    finalUrl,
  };
}

function validateTransport(result, { requestUrl, maxBytes = MAX_DOCUMENT_BYTES } = {}) {
  if (result?.ok === false && result.failure) return result.failure;
  const status = result?.status ?? null;
  const finalUrl = result?.finalUrl || result?.final_url || requestUrl;
  if ((status >= 300 && status < 400) || result?.redirected || finalUrl !== requestUrl) {
    return failure("redirect_rejected", { request_url: requestUrl, final_url: finalUrl, status });
  }
  const declared = Number.parseInt(headerValue(result?.headers, "content-length") || "", 10);
  if (Number.isFinite(declared) && declared > maxBytes) {
    return failure("oversize_declared", { bytes: declared, limit: maxBytes });
  }
  if (!result?.bytes) return failure("empty_response", { status });
  if (result.bytes.length > maxBytes) {
    return failure("oversize_streamed", { bytes: result.bytes.length, limit: maxBytes });
  }
  if (status != null && (status < 200 || status >= 300)) return failure("http_error", { status });
  return null;
}

function extractionKey({ sha256, extractorVersion, pdfLibraryVersion, ontologyVersion, rulesVersion }) {
  return Object.freeze({
    sha256,
    extractor: extractorVersion,
    pdf_library: pdfLibraryVersion,
    ontology_version: ontologyVersion,
    rules_version: rulesVersion,
  });
}

function extractionKeyString(key) {
  return JSON.stringify([
    key.sha256,
    key.extractor,
    key.pdf_library,
    key.ontology_version,
    key.rules_version,
  ]);
}

function publicExtractionSummary(extraction) {
  return Object.freeze({
    extraction_key: extraction.extraction_key,
    page_count: extraction.page_count,
    pages_with_text: extraction.pages_with_text,
    ocr_required_pages: Object.freeze([...extraction.ocr_required_pages]),
    extracted_at: extraction.extracted_at,
  });
}

export function createNavigatorObservationState(existingExtractions = [], existingFactProjections = []) {
  const state = {
    extractions: new Map(),
    extraction_runs: 0,
    fact_projections: new Map(),
    fact_projection_runs: 0,
    fact_cache_hits: 0,
  };
  for (const extraction of existingExtractions) {
    if (!extraction?.extraction_key) continue;
    state.extractions.set(extractionKeyString(extraction.extraction_key), extraction);
  }
  for (const entry of existingFactProjections) {
    if (typeof entry?.cache_key !== "string" || !entry.projection) continue;
    state.fact_projections.set(entry.cache_key, entry);
  }
  return state;
}

function extractionsForSha(state, sha256) {
  return [...state.extractions.values()]
    .filter((entry) => entry.extraction_key?.sha256 === sha256)
    .sort((left, right) => extractionKeyString(left.extraction_key).localeCompare(extractionKeyString(right.extraction_key)));
}

async function extractStoredDocument({
  state,
  bytes,
  documentId,
  fetchId,
  contentHash,
  extractor,
  extractorVersion,
  pdfLibraryVersion,
  ontologyVersion,
  rulesVersion,
  extractedAt,
}) {
  const sha256 = contentHash.replace(/^sha256:/, "");
  const key = extractionKey({ sha256, extractorVersion, pdfLibraryVersion, ontologyVersion, rulesVersion });
  const cacheKey = extractionKeyString(key);
  const cached = state.extractions.get(cacheKey);
  if (cached) return cached;

  const result = await extractor(bytes);
  if (result?.status !== "ok") {
    return { failure: failure("extract_failed", { reason: result?.reason || "unknown" }) };
  }
  if (result.pdf_library && result.pdf_library !== pdfLibraryVersion) {
    return {
      failure: failure("pdf_library_mismatch", {
        expected: pdfLibraryVersion,
        observed: result.pdf_library,
      }),
    };
  }
  const pages = (result.pages || []).map((page) => ({
    ...page,
    fetch_id: fetchId,
    content_hash: contentHash,
    ...assessPageQuality({
      text: page.text,
      ocrRequired: page.ocr_required === true,
      ocrAttempted: page.ocr_attempted === true,
      ocrEngineAvailable: page.ocr_attempted === true,
    }),
  }));
  const receipt = buildExtractionReceipt({ documentId, fetchId, contentHash, pages });
  const extraction = Object.freeze({
    extraction_key: key,
    page_count: pages.length,
    pages_with_text: pages.filter((page) => String(page.text || "").trim()).length,
    ocr_required_pages: Object.freeze(pages.filter((page) => page.ocr_required).map((page) => page.page_number)),
    extracted_at: extractedAt,
    method: result.method || "pdf_text_layer_per_page",
    pages: receipt.pages,
    extraction_receipt: receipt,
  });
  state.extractions.set(cacheKey, extraction);
  state.extraction_runs += 1;
  return extraction;
}

function captureReceipt({ requestUrl, result, requestedAt, retrievedAt, accessMode, pdfLibraryVersion = null }) {
  const bytes = result?.bytes || Buffer.alloc(0);
  return Object.freeze({
    access_mode: accessMode,
    request_url: requestUrl,
    final_url: result?.finalUrl || result?.final_url || requestUrl,
    status: result?.status ?? null,
    bytes: bytes.length,
    sha256: bytes.length ? sha256Hex(bytes) : null,
    requested_at: requestedAt,
    retrieved_at: retrievedAt,
    pdf_library_version: pdfLibraryVersion,
  });
}

/** Build the stable public shard shape from already validated observations. */
export function buildProcurementDocumentShard({ subject, observation, rows, failures = [] }) {
  return Object.freeze({
    schema: NAVIGATOR_DOCUMENT_SCHEMA,
    subject: Object.freeze({ ...subject }),
    observation: Object.freeze({ ...observation }),
    rows: Object.freeze(rows.map((row) => Object.freeze({ ...row }))),
    failures: Object.freeze(failures.map((entry) => Object.freeze({ ...entry }))),
  });
}

function targetRows(targetRfpIds, rfxRows) {
  if (!Array.isArray(targetRfpIds) || targetRfpIds.length === 0 || targetRfpIds.length > MAX_TARGET_RFX_IDS) {
    throw new Error(`targetRfpIds must contain 1-${MAX_TARGET_RFX_IDS} explicit ids`);
  }
  const targets = [...new Set(targetRfpIds.map((value) => String(value).trim()))];
  if (targets.length !== targetRfpIds.length || targets.some((id) => !/^\d{3,}$/.test(id))) {
    throw new Error("targetRfpIds must be unique numeric rfp_id values");
  }
  const index = new Map((rfxRows || []).map((row) => [String(row.rfp_id || "").trim(), row]));
  return targets.map((rfpId) => ({ rfpId, row: index.get(rfpId) || null }));
}

/**
 * Observe up to ten explicitly named RFx rounds. Network and extraction are
 * injected for deterministic tests; production callers use boundedHttpGet and
 * the existing Python page extractor.
 */
export async function observeNavigatorRfxDocuments({
  targetRfpIds,
  rfxRows,
  httpGet,
  projectRoot,
  state = createNavigatorObservationState(),
  extractor = extractPdfPagesViaPython,
  extractorVersion,
  pdfLibraryVersion,
  ontologyVersion,
  rulesVersion,
  now = () => new Date().toISOString(),
  nowMilliseconds = () => performance.now(),
  maxDocumentBytes = MAX_DOCUMENT_BYTES,
} = {}) {
  for (const [field, value] of Object.entries({ projectRoot, extractorVersion, pdfLibraryVersion, ontologyVersion, rulesVersion })) {
    if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  }
  if (typeof httpGet !== "function") throw new Error("httpGet is required");

  const shards = new Map();
  const failures = [];
  for (const target of targetRows(targetRfpIds, rfxRows)) {
    if (!target.row) {
      failures.push(failure("unknown_rfp_id", { rfp_id: target.rfpId }));
      continue;
    }

    const navigatorUrl = navigatorUrlForRfpId(target.rfpId);
    const requestedAt = now();
    const navigatorResult = await httpGet(navigatorUrl, {
      kind: "navigator",
      maxBytes: maxDocumentBytes,
      allowedUrl: isAllowedNavigatorUrl,
    });
    const retrievedAt = now();
    const transportFailure = validateTransport(navigatorResult, { requestUrl: navigatorUrl, maxBytes: maxDocumentBytes });
    if (transportFailure) {
      failures.push(failure(transportFailure.type, { rfp_id: target.rfpId, ...transportFailure }));
      continue;
    }

    const html = navigatorResult.bytes.toString("utf8");
    const parsed = parseNavigatorRfxHtml(html, { navigatorUrl });
    if (!parsed.ok) {
      failures.push(failure(parsed.failure.type, { rfp_id: target.rfpId }));
      continue;
    }
    if (normalizedNumericId(parsed.displayed_id) !== normalizedNumericId(target.row.bpm_id)) {
      failures.push(failure("displayed_id_mismatch", {
        rfp_id: target.rfpId,
        expected_bpm_id: String(target.row.bpm_id || ""),
        displayed_id: parsed.displayed_id,
      }));
      continue;
    }

    const rowFailures = [];
    const rows = [];
    for (const document of parsed.documents) {
      if (!isAllowedNavigatorDocumentUrl(document.official_url)) {
        rowFailures.push(failure("host_rejected", { document_id: document.document_id, request_url: document.official_url }));
        continue;
      }
      const documentRequestedAt = now();
      const response = await httpGet(document.official_url, {
        kind: "document",
        maxBytes: maxDocumentBytes,
        allowedUrl: isAllowedNavigatorDocumentUrl,
      });
      const documentRetrievedAt = now();
      const responseFailure = validateTransport(response, { requestUrl: document.official_url, maxBytes: maxDocumentBytes });
      if (responseFailure) {
        rowFailures.push(failure(responseFailure.type, { document_id: document.document_id, ...responseFailure }));
        continue;
      }
      if (looksLikeLoginHtml(response.bytes.toString("utf8"))) {
        rowFailures.push(failure("access_required", { document_id: document.document_id }));
        continue;
      }
      if (response.bytes.length < PDF_SIGNATURE.length || !response.bytes.subarray(0, PDF_SIGNATURE.length).equals(PDF_SIGNATURE)) {
        rowFailures.push(failure("non_pdf_signature", { document_id: document.document_id }));
        continue;
      }

      const fetchId = `navigator-rfx-${target.rfpId}-${document.document_id}-${sha256Hex(response.bytes).slice(0, 12)}`;
      const stored = await fetchAndStoreDocument({
        url: document.official_url,
        sourceId: NAVIGATOR_SOURCE_ID,
        httpGet: async () => response,
        projectRoot,
        fetchId,
        storageNamespace: NAVIGATOR_STORAGE_NAMESPACE,
        parserVersion: NAVIGATOR_OBSERVER_VERSION,
      });
      if (!stored.ok) {
        rowFailures.push(failure("document_store_failed", { document_id: document.document_id }));
        continue;
      }

      const extraction = await extractStoredDocument({
        state,
        bytes: stored.bytes,
        documentId: document.document_id,
        fetchId,
        contentHash: stored.contentHash,
        extractor,
        extractorVersion,
        pdfLibraryVersion,
        ontologyVersion,
        rulesVersion,
        extractedAt: documentRetrievedAt,
      });
      if (extraction.failure) {
        rowFailures.push(failure(extraction.failure.type, { document_id: document.document_id, reason: extraction.failure.reason }));
        continue;
      }
      const reading = projectNavigatorDocumentFacts({
        document,
        extraction,
        state,
        nowMilliseconds,
      });

      const sha256 = stored.contentHash.replace(/^sha256:/, "");
      rows.push(Object.freeze({
        document_id: document.document_id,
        label: document.label,
        official_url: document.official_url,
        sha256,
        bytes: stored.bytes.length,
        content_type: headerValue(response.headers, "content-type") || "application/pdf",
        acquired_at: documentRetrievedAt,
        access_mode: "anonymous-direct-http",
        raw_object_path: stored.rawObjectPath,
        page_count: extraction.page_count,
        pages_with_text: extraction.pages_with_text,
        ocr_required_pages: extraction.ocr_required_pages,
        extraction_key: extraction.extraction_key,
        extractions: Object.freeze(extractionsForSha(state, sha256).map(publicExtractionSummary)),
        recognized_template: reading.projection.recognized_template,
        roles: reading.projection.roles,
        standing: reading.projection.standing,
        evidence_role: reading.projection.evidence_role,
        standing_label: reading.projection.standing_label,
        container: reading.projection.container,
        unsectioned_pages: reading.projection.unsectioned_pages,
        sections: reading.projection.sections,
        events: reading.projection.events,
        facts: reading.projection.facts,
        abstentions: reading.projection.abstentions,
        reading_receipt: reading.receipt,
        capture_receipt: captureReceipt({
          requestUrl: document.official_url,
          result: response,
          requestedAt: documentRequestedAt,
          retrievedAt: documentRetrievedAt,
          accessMode: "anonymous-direct-http",
          pdfLibraryVersion,
        }),
      }));
    }

    const subject = {
      rfp_id: target.rfpId,
      bpm_id: String(target.row.bpm_id),
      epin: String(target.row.epin),
      round_label: parsed.round_label,
      displayed_id: parsed.displayed_id,
      title: target.row.procurement_name || null,
      agency: target.row.agency || null,
      navigator_url: navigatorUrl,
      observed_at: retrievedAt,
    };
    const observation = {
      access_mode: "anonymous-direct-http",
      lot_label: parsed.lot_label,
      round_label: parsed.round_label,
      capture_receipt: captureReceipt({
        requestUrl: navigatorUrl,
        result: navigatorResult,
        requestedAt,
        retrievedAt,
        accessMode: "anonymous-direct-http",
      }),
    };
    const shard = buildProcurementDocumentShard({ subject, observation, rows, failures: rowFailures });
    shards.set(target.rfpId, shard);
    failures.push(...rowFailures.map((entry) => failure(entry.type, { rfp_id: target.rfpId, ...entry })));
  }

  const metrics = summarizeNavigatorDocumentFacts([...shards.values()].flatMap((shard) => shard.rows));
  const manifest = Object.freeze({
    schema: NAVIGATOR_MANIFEST_SCHEMA,
    version: 1,
    generated_at: now(),
    representation: "sharded",
    shard_schema: NAVIGATOR_DOCUMENT_SCHEMA,
    ontology_version: ontologyVersion,
    rules_version: rulesVersion,
    row_count: [...shards.values()].reduce((sum, shard) => sum + shard.rows.length, 0),
    shards: Object.freeze([...shards.entries()].map(([rfpId, shard]) => Object.freeze({
      rfp_id: rfpId,
      path: `procurement_documents/rfx-${rfpId}.json`,
      row_count: shard.rows.length,
    }))),
    coverage: Object.freeze({
      documents: metrics.documents,
      pages: metrics.pages,
      contract_book_pages_sectioned: metrics.sectioned_pages,
      facts: metrics.facts,
      events: metrics.events,
      abstentions: metrics.abstentions,
    }),
    cost: Object.freeze({
      model_calls: metrics.model_calls,
      model_tokens: 0,
      ocr_pages: metrics.ocr_pages_selected,
    }),
    measurement: Object.freeze({
      latency_ms: metrics.latency_ms,
      fact_bytes_stored: metrics.stored_bytes,
      cache_hits: metrics.cache_hits,
      cache_misses: metrics.cache_misses,
      per_role: metrics.per_role,
    }),
  });
  return { manifest, shards, failures: Object.freeze(failures), metrics, state };
}
