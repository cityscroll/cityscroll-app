/**
 * Retain dated official CEQR, DOT, and EDC materials from the fixed six-case
 * dossier as versioned historical observations.
 *
 * Distinguishes document publication time, internal section dates, and
 * observation time. DOT attachment selectors resolve once against the parent
 * page into an auditable manifest. Unavailable documents remain acquisition
 * failures and never count as retained evidence.
 *
 * Boundaries: does not create a board scraper or a second zoning-board
 * calendar, and does not classify historical project presentations as open
 * consultations.
 */

import { createHash } from "node:crypto";

import {
  buildAcquisitionRequestReceipt,
  contentHashOf,
} from "../../warehouse/lib/document_processing.mjs";

export const CONNECTED_HISTORY_DOCUMENTS_SCHEMA =
  "cityscroll.connected_history_documents.v1";
export const CONNECTED_HISTORY_DOCUMENTS_VERSION = 1;
export const CONNECTED_HISTORY_DOCUMENTS_PARSER_VERSION =
  "connected_history_documents.v1";
export const CONNECTED_HISTORY_DOCUMENTS_RECEIPT_SCHEMA =
  "cityscroll.connected_history_documents_receipt.v1";
export const CONNECTED_HISTORY_DOT_SELECTOR_MANIFEST_SCHEMA =
  "cityscroll.connected_history_dot_selector_manifest.v1";

export const CONNECTED_HISTORY_DOCUMENTS_TRANSPORT = Object.freeze({
  maxRetries: 2,
  maxRequests: 40,
  responseCapBytes: 8_000_000,
  parserVersion: CONNECTED_HISTORY_DOCUMENTS_PARSER_VERSION,
});

export const PUBLICATION_PRECISION = Object.freeze([
  "day",
  "month",
  "year",
  "unknown",
]);

export const DATE_KINDS = Object.freeze([
  "document_publication",
  "internal_section",
  "observation",
]);

export const DOT_PARENT_URL =
  "https://www.nyc.gov/html/dot/html/about/current-projects.shtml";

/**
 * Fixed dossier sources limited to CEQR, DOT, and EDC materials named by the
 * six release cases. Direct URLs and DOT parent-page selectors are closed;
 * this module never searches for substitute examples.
 */
export const CONNECTED_HISTORY_DOCUMENT_SOURCES = Object.freeze([
  Object.freeze({
    source_id: "kingsbridge-ceqr-13dme013x-page",
    family_id: "kingsbridge-armory",
    publisher: "ceqr",
    kind: "direct_url",
    subject_ids: Object.freeze(["ceqr:13DME013X"]),
    url: "https://www.nyc.gov/site/oec/environmental-quality-review/13DME013X.page",
    title: "Kingsbridge Armory ice-center CEQR 13DME013X",
    publication: Object.freeze({
      value: "2013",
      precision: "year",
      kind: "document_publication",
    }),
    internal_dates: Object.freeze([
      Object.freeze({
        value: "2018",
        precision: "year",
        kind: "internal_section",
        locator: "anticipated_operation_forecast",
        note: "forecast operation year, not an opening event",
      }),
    ]),
    source_span: Object.freeze({
      locator: "oec_environmental_quality_review_page",
      quote: "13DME013X",
    }),
  }),
  Object.freeze({
    source_id: "kingsbridge-zap-2025x0262",
    family_id: "kingsbridge-armory",
    publisher: "ceqr",
    kind: "direct_url",
    subject_ids: Object.freeze(["land:project:2025X0262", "ceqr:25DME006X"]),
    url: "https://zap.planning.nyc.gov/projects/2025X0262",
    title: "Kingsbridge Armory redevelopment ZAP 2025X0262",
    publication: Object.freeze({
      value: "2025",
      precision: "year",
      kind: "document_publication",
    }),
    internal_dates: Object.freeze([]),
    source_span: Object.freeze({
      locator: "zap_project_page",
      quote: "2025X0262",
    }),
  }),
  Object.freeze({
    source_id: "kingsbridge-ceqr-25dme006x-details",
    family_id: "kingsbridge-armory",
    publisher: "ceqr",
    kind: "direct_url",
    subject_ids: Object.freeze(["ceqr:25DME006X"]),
    url: "https://a002-ceqraccess.nyc.gov/ceqr/Details?data=MjVETUUwMDZY0&signature=7baabc56de3147946d9415dc8b59f436a8e7c9ca",
    title: "CEQR Access details for 25DME006X",
    publication: Object.freeze({
      value: "2025",
      precision: "year",
      kind: "document_publication",
    }),
    internal_dates: Object.freeze([]),
    source_span: Object.freeze({
      locator: "ceqr_access_details",
      quote: "25DME006X",
    }),
  }),
  Object.freeze({
    source_id: "kingsbridge-ceqr-25dme006x-findings",
    family_id: "kingsbridge-armory",
    publisher: "ceqr",
    kind: "direct_url",
    subject_ids: Object.freeze(["ceqr:25DME006X"]),
    url: "https://a002-ceqraccess.nyc.gov/Handlers/ProjectFile.ashx?file=MjAyNVwyNURNRTAwNlhcZmluZGluZ3NcMjVETUUwMDZYX1N0YXRlbWVudF9PZl9GaW5kaW5nc18xMDAxMjAyNS5wZGY1&signature=203eb9aee503f4ce2970ef6e003267bb39fb5d6c",
    title: "Statement of Findings PDF for 25DME006X",
    publication: Object.freeze({
      value: "2025-10-01",
      precision: "day",
      kind: "document_publication",
    }),
    internal_dates: Object.freeze([]),
    source_span: Object.freeze({
      locator: "ceqr_access_project_file",
      quote: "25DME006X_Statement_Of_Findings",
    }),
  }),
  Object.freeze({
    source_id: "sixth-avenue-june-2024-cb2",
    family_id: "sixth-avenue",
    publisher: "dot",
    kind: "dot_selector",
    subject_ids: Object.freeze(["dot:corridor:sixth-avenue-lispenard-w14"]),
    parent_url: DOT_PARENT_URL,
    selector: Object.freeze({
      heading: "Sixth Avenue, Lispenard Street to West 14th Street",
      link_label: "June 2024 CB2",
    }),
    title: "Sixth Avenue Lispenard–W14 June 2024 CB2 presentation",
    publication: Object.freeze({
      value: "2024-06",
      precision: "month",
      kind: "document_publication",
    }),
    internal_dates: Object.freeze([]),
    source_span: Object.freeze({
      locator: "dot_current_projects_heading_link",
      quote: "June 2024 CB2",
    }),
    consultation: false,
  }),
  Object.freeze({
    source_id: "sixth-avenue-february-2025-cb4-cb5",
    family_id: "sixth-avenue",
    publisher: "dot",
    kind: "dot_selector",
    subject_ids: Object.freeze(["dot:corridor:sixth-avenue-w14-w35"]),
    parent_url: DOT_PARENT_URL,
    selector: Object.freeze({
      heading: "Sixth Avenue, West 14th Street to West 35th Street",
      link_label: "February 2025 CB4/CB5",
    }),
    title: "Sixth Avenue W14–W35 February 2025 CB4/CB5 presentation",
    publication: Object.freeze({
      value: "2025-02",
      precision: "month",
      kind: "document_publication",
    }),
    internal_dates: Object.freeze([]),
    source_span: Object.freeze({
      locator: "dot_current_projects_heading_link",
      quote: "February 2025 CB4/CB5",
    }),
    consultation: false,
  }),
  Object.freeze({
    source_id: "sixth-avenue-june-2026-cb2-cb4-cb5",
    family_id: "sixth-avenue",
    publisher: "dot",
    kind: "dot_selector",
    subject_ids: Object.freeze(["dot:corridor:sixth-avenue-watts-w59"]),
    parent_url: DOT_PARENT_URL,
    selector: Object.freeze({
      heading: "Sixth Avenue, Watts Street to West 59th Street",
      link_label: "June 2026 CB2/CB4/CB5",
    }),
    title: "Sixth Avenue Watts–W59 June 2026 multi-board presentation",
    publication: Object.freeze({
      value: "2026-06",
      precision: "month",
      kind: "document_publication",
    }),
    internal_dates: Object.freeze([]),
    source_span: Object.freeze({
      locator: "dot_current_projects_heading_link",
      quote: "June 2026 CB2/CB4/CB5",
    }),
    consultation: false,
  }),
  Object.freeze({
    source_id: "thirty-first-avenue-september-2023-workshop",
    family_id: "thirty-first-avenue",
    publisher: "dot",
    kind: "dot_selector",
    subject_ids: Object.freeze(["dot:corridor:31st-avenue-vernon-51"]),
    parent_url: DOT_PARENT_URL,
    selector: Object.freeze({
      heading: "31st Avenue, Vernon Boulevard to 51st Street",
      link_label: "September 2023 workshop",
    }),
    title: "31st Avenue September 2023 workshop materials",
    publication: Object.freeze({
      value: "2023-09",
      precision: "month",
      kind: "document_publication",
    }),
    internal_dates: Object.freeze([]),
    source_span: Object.freeze({
      locator: "dot_current_projects_heading_link",
      quote: "September 2023 workshop",
    }),
    consultation: false,
  }),
  Object.freeze({
    source_id: "thirty-first-avenue-may-june-2024",
    family_id: "thirty-first-avenue",
    publisher: "dot",
    kind: "dot_selector",
    subject_ids: Object.freeze(["dot:corridor:31st-avenue-vernon-51"]),
    parent_url: DOT_PARENT_URL,
    selector: Object.freeze({
      heading: "31st Avenue, Vernon Boulevard to 51st Street",
      link_label: "May/June 2024 materials",
    }),
    title: "31st Avenue May/June 2024 materials",
    publication: Object.freeze({
      value: "2024-06",
      precision: "month",
      kind: "document_publication",
    }),
    internal_dates: Object.freeze([]),
    source_span: Object.freeze({
      locator: "dot_current_projects_heading_link",
      quote: "May/June 2024 materials",
    }),
    consultation: false,
  }),
  Object.freeze({
    source_id: "thirty-first-avenue-may-2026-phase-ii",
    family_id: "thirty-first-avenue",
    publisher: "dot",
    kind: "direct_url",
    subject_ids: Object.freeze(["dot:corridor:31st-avenue-vernon-51"]),
    url: "https://www.nyc.gov/html/dot/downloads/pdf/31-ave-phase-ii-steinway-st-51-st-may2026-2.pdf",
    title: "31st Avenue Phase II May 2026 materials",
    publication: Object.freeze({
      value: "2026-05",
      precision: "month",
      kind: "document_publication",
    }),
    internal_dates: Object.freeze([
      Object.freeze({
        value: "2024",
        precision: "year",
        kind: "internal_section",
        locator: "phase_i_implementation_period",
        note: "Phase I measurement period remains distinct from Phase II proposal",
      }),
    ]),
    source_span: Object.freeze({
      locator: "dot_pdf_direct",
      quote: "31-ave-phase-ii-steinway-st-51-st-may2026-2.pdf",
    }),
    consultation: false,
  }),
  Object.freeze({
    source_id: "lighthouse-point-project-page",
    family_id: "lighthouse-point",
    publisher: "edc",
    kind: "direct_url",
    subject_ids: Object.freeze(["edc:project:lighthouse-point"]),
    url: "https://edc.nyc/project/lighthouse-point",
    title: "EDC Lighthouse Point project page",
    publication: Object.freeze({
      value: "2014",
      precision: "year",
      kind: "document_publication",
    }),
    internal_dates: Object.freeze([
      Object.freeze({
        value: "2014",
        precision: "year",
        kind: "internal_section",
        locator: "lease_and_planned_components",
        note: "historical plan remains inspectable separately from later openings",
      }),
    ]),
    source_span: Object.freeze({
      locator: "edc_project_page",
      quote: "Lighthouse Point",
    }),
  }),
  Object.freeze({
    source_id: "lighthouse-point-opening-announcement",
    family_id: "lighthouse-point",
    publisher: "edc",
    kind: "direct_url",
    subject_ids: Object.freeze(["edc:project:lighthouse-point"]),
    url: "https://edc.nyc/press-release/mixed-use-housing-complex-opens-lighthouse-point",
    title: "EDC Lighthouse Point first-phase opening announcement",
    publication: Object.freeze({
      value: "2025-06-05",
      precision: "day",
      kind: "document_publication",
    }),
    internal_dates: Object.freeze([
      Object.freeze({
        value: "2025-06-05",
        precision: "day",
        kind: "internal_section",
        locator: "first_residential_phase_opening",
        note: "first residential phase opening; Phase 2 remains future",
      }),
    ]),
    source_span: Object.freeze({
      locator: "edc_press_release",
      quote: "115 units",
    }),
  }),
]);

const SOURCE_BY_ID = new Map(
  CONNECTED_HISTORY_DOCUMENT_SOURCES.map((source) => [source.source_id, source]),
);

function clean(value, max = 400) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function sha256Text(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function absolutizeUrl(href, baseUrl) {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

/**
 * Resolve one DOT parent-page heading + link-label selector into a concrete URL.
 * Returns an auditable result; a mismatch is never silently substituted.
 */
export function resolveDotAttachmentSelector(html, selector, { parentUrl = DOT_PARENT_URL } = {}) {
  const heading = clean(selector?.heading, 240);
  const linkLabel = clean(selector?.link_label, 240);
  if (!heading || !linkLabel) {
    return {
      status: "selector_invalid",
      reason: "heading_and_link_label_required",
      heading: heading || null,
      link_label: linkLabel || null,
      resolved_url: null,
      matched_anchor_text: null,
    };
  }

  const normalized = String(html || "").replace(/\r\n?/g, "\n");
  const headingPattern = new RegExp(
    heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    "i",
  );
  const headingMatch = headingPattern.exec(normalized);
  if (!headingMatch) {
    return {
      status: "selector_mismatch",
      reason: "heading_not_found",
      heading,
      link_label: linkLabel,
      resolved_url: null,
      matched_anchor_text: null,
    };
  }

  const afterHeading = normalized.slice(headingMatch.index);
  const nextHeading = afterHeading.search(/<h[1-6]\b/i);
  const section = nextHeading > 0 ? afterHeading.slice(0, nextHeading) : afterHeading;
  const anchorPattern = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorPattern.exec(section)) !== null) {
    const href = decodeHtmlEntities(match[1]);
    const text = clean(decodeHtmlEntities(match[2].replace(/<[^>]+>/g, " ")), 240);
    if (text.toLowerCase() !== linkLabel.toLowerCase()) continue;
    const resolved = absolutizeUrl(href, parentUrl);
    if (!resolved) {
      return {
        status: "selector_mismatch",
        reason: "href_unresolvable",
        heading,
        link_label: linkLabel,
        resolved_url: null,
        matched_anchor_text: text,
      };
    }
    return {
      status: "resolved",
      reason: null,
      heading,
      link_label: linkLabel,
      resolved_url: resolved,
      matched_anchor_text: text,
    };
  }

  return {
    status: "selector_mismatch",
    reason: "link_label_not_found_under_heading",
    heading,
    link_label: linkLabel,
    resolved_url: null,
    matched_anchor_text: null,
  };
}

/**
 * Build the one-shot auditable DOT selector manifest from a parent-page body.
 */
export function buildDotSelectorManifest(html, {
  parentUrl = DOT_PARENT_URL,
  observedAt = new Date().toISOString(),
  sources = CONNECTED_HISTORY_DOCUMENT_SOURCES,
} = {}) {
  const selectors = sources.filter((source) => source.kind === "dot_selector");
  const entries = selectors.map((source) => {
    const resolution = resolveDotAttachmentSelector(html, source.selector, { parentUrl });
    return {
      source_id: source.source_id,
      family_id: source.family_id,
      subject_ids: [...source.subject_ids],
      parent_url: parentUrl,
      selector: { ...source.selector },
      ...resolution,
      consultation: false,
    };
  });
  return {
    schema: CONNECTED_HISTORY_DOT_SELECTOR_MANIFEST_SCHEMA,
    version: CONNECTED_HISTORY_DOCUMENTS_VERSION,
    parent_url: parentUrl,
    observed_at: observedAt,
    entry_count: entries.length,
    resolved_count: entries.filter((row) => row.status === "resolved").length,
    mismatch_count: entries.filter((row) => row.status === "selector_mismatch").length,
    entries,
  };
}

function dateRecord(date, observedAt) {
  return {
    value: date?.value ?? null,
    precision: date?.precision ?? "unknown",
    kind: date?.kind ?? "document_publication",
    locator: date?.locator ?? null,
    note: date?.note ?? null,
    observation_time: observedAt,
  };
}

/**
 * Historical DOT presentations are retained evidence, never open consultations.
 */
export function assertNotOpenConsultation(source) {
  if (source?.publisher === "dot" && source?.consultation !== false) {
    throw new Error(
      `${source.source_id}: historical DOT presentations must remain consultation=false`,
    );
  }
  return true;
}

/**
 * Refuse to open a second board-document scraper or zoning-board calendar
 * from this path. Checks import-like identifiers, not prose mentions.
 */
export function assertRetentionBoundaries(moduleSourceText) {
  const text = String(moduleSourceText || "");
  const forbidden = [
    /from\s+["'][^"']*bsa_calendar[^"']*["']/,
    /import\s+[^;]*parseBsaAgendaPages/,
    /from\s+["'][^"']*community_board_source_adapters[^"']*["']/,
    /acquireConsultationSources\s*\(/,
    /\bDOT_PILOT_SEEDS\b/,
  ];
  for (const pattern of forbidden) {
    if (pattern.test(text)) {
      throw new Error(`retention boundary violated: ${pattern}`);
    }
  }
  return true;
}

function failureObservation({
  source,
  observedAt,
  reason,
  resolvedUrl = null,
  requestReceipt = null,
  selectorResolution = null,
}) {
  return {
    source_id: source.source_id,
    family_id: source.family_id,
    publisher: source.publisher,
    subject_ids: [...source.subject_ids],
    title: source.title,
    status: "acquisition_failure",
    retained: false,
    reason,
    requested_url: source.url || source.parent_url || null,
    resolved_url: resolvedUrl,
    content_hash: null,
    source_span: { ...source.source_span },
    publication: dateRecord(source.publication, observedAt),
    internal_dates: (source.internal_dates || []).map((row) => dateRecord(row, observedAt)),
    observation_time: observedAt,
    consultation: source.consultation === false ? false : null,
    request_receipt: requestReceipt,
    selector_resolution: selectorResolution,
  };
}

function successObservation({
  source,
  observedAt,
  resolvedUrl,
  bytes,
  requestReceipt,
  selectorResolution = null,
}) {
  return {
    source_id: source.source_id,
    family_id: source.family_id,
    publisher: source.publisher,
    subject_ids: [...source.subject_ids],
    title: source.title,
    status: "retained",
    retained: true,
    reason: null,
    requested_url: source.url || source.parent_url || null,
    resolved_url: resolvedUrl,
    content_hash: contentHashOf(bytes),
    byte_count: bytes.length,
    source_span: { ...source.source_span },
    publication: dateRecord(source.publication, observedAt),
    internal_dates: (source.internal_dates || []).map((row) => dateRecord(row, observedAt)),
    observation_time: observedAt,
    consultation: source.consultation === false ? false : null,
    request_receipt: requestReceipt,
    selector_resolution: selectorResolution,
  };
}

async function fetchWithRetries(httpGet, url, {
  maxRetries = CONNECTED_HISTORY_DOCUMENTS_TRANSPORT.maxRetries,
  requestId,
  parentRequestId = null,
  observedAt,
} = {}) {
  let retries = 0;
  let lastError = null;
  while (retries <= maxRetries) {
    const requestedAt = observedAt;
    const started = Date.now();
    try {
      const result = await httpGet(url);
      const retrievedAt = observedAt;
      const status = Number.isInteger(result?.status) ? result.status : null;
      const bytes = result?.bytes ? Buffer.from(result.bytes) : null;
      const ok = Boolean(bytes) && status != null && status >= 200 && status < 300;
      const receipt = buildAcquisitionRequestReceipt({
        requestId: retries === 0 ? requestId : `${requestId}:retry${retries}`,
        parentRequestId,
        url,
        requestedAt,
        retrievedAt,
        status,
        bytes: ok ? bytes : null,
        latencyMs: Date.now() - started,
        parserVersion: CONNECTED_HISTORY_DOCUMENTS_PARSER_VERSION,
        outcome: ok ? "ok" : "retrieval_failure",
        reason: ok ? null : `http_status_${status ?? "missing"}`,
        retries,
      });
      if (ok) return { ok: true, bytes, receipt, status };
      lastError = receipt;
      if (status != null && status >= 400 && status < 500 && status !== 408 && status !== 429) {
        return { ok: false, bytes: null, receipt, status };
      }
    } catch (error) {
      const retrievedAt = observedAt;
      lastError = buildAcquisitionRequestReceipt({
        requestId: retries === 0 ? requestId : `${requestId}:retry${retries}`,
        parentRequestId,
        url,
        requestedAt,
        retrievedAt,
        status: null,
        bytes: null,
        latencyMs: Date.now() - started,
        parserVersion: CONNECTED_HISTORY_DOCUMENTS_PARSER_VERSION,
        outcome: "retrieval_failure",
        reason: `request_failed:${clean(error?.message, 120)}`,
        retries,
      });
    }
    retries += 1;
  }
  return { ok: false, bytes: null, receipt: lastError, status: lastError?.http_status ?? null };
}

/**
 * Run one bounded acquisition over the fixed dossier using an injected httpGet.
 * Checkpoints after each source so a retry can resume without re-fetching
 * completed observations.
 */
export async function acquireConnectedHistoryDocuments({
  httpGet,
  observedAt = new Date().toISOString(),
  sources = CONNECTED_HISTORY_DOCUMENT_SOURCES,
  checkpoint = null,
  maxRetries = CONNECTED_HISTORY_DOCUMENTS_TRANSPORT.maxRetries,
  storeParentHtml = null,
} = {}) {
  if (typeof httpGet !== "function") {
    throw new Error("acquireConnectedHistoryDocuments: httpGet is required");
  }

  const prior = checkpoint && typeof checkpoint === "object" ? checkpoint : null;
  const completed = new Map(
    (prior?.observations || [])
      .filter((row) => row && row.source_id)
      .map((row) => [row.source_id, row]),
  );

  const observations = [];
  const requestGraph = [];
  let parentHtml = prior?.parent_html || null;
  let parentReceipt = prior?.parent_receipt || null;
  let dotManifest = prior?.dot_selector_manifest || null;

  const needsParent = sources.some((source) => source.kind === "dot_selector");
  if (needsParent && !parentHtml) {
    const parentFetch = await fetchWithRetries(httpGet, DOT_PARENT_URL, {
      maxRetries,
      requestId: "dot-parent-current-projects",
      observedAt,
    });
    requestGraph.push(parentFetch.receipt);
    parentReceipt = parentFetch.receipt;
    if (!parentFetch.ok) {
      for (const source of sources.filter((row) => row.kind === "dot_selector")) {
        if (completed.has(source.source_id)) {
          observations.push(completed.get(source.source_id));
          continue;
        }
        const row = failureObservation({
          source,
          observedAt,
          reason: "parent_page_retrieval_failure",
          requestReceipt: parentFetch.receipt,
          selectorResolution: {
            status: "unresolved",
            reason: "parent_page_unavailable",
            heading: source.selector.heading,
            link_label: source.selector.link_label,
            resolved_url: null,
          },
        });
        observations.push(row);
        completed.set(source.source_id, row);
      }
    } else {
      parentHtml = parentFetch.bytes.toString("utf8");
      if (typeof storeParentHtml === "function") storeParentHtml(parentHtml);
      dotManifest = buildDotSelectorManifest(parentHtml, {
        parentUrl: DOT_PARENT_URL,
        observedAt,
        sources,
      });
    }
  } else if (needsParent && parentHtml && !dotManifest) {
    dotManifest = buildDotSelectorManifest(parentHtml, {
      parentUrl: DOT_PARENT_URL,
      observedAt,
      sources,
    });
  }

  for (const source of sources) {
    assertNotOpenConsultation(source);
    if (completed.has(source.source_id)) {
      observations.push(completed.get(source.source_id));
      continue;
    }

    if (source.kind === "dot_selector") {
      const entry = (dotManifest?.entries || []).find((row) => row.source_id === source.source_id);
      if (!entry || entry.status !== "resolved") {
        const row = failureObservation({
          source,
          observedAt,
          reason: entry?.reason || "selector_mismatch",
          selectorResolution: entry || {
            status: "selector_mismatch",
            reason: "manifest_entry_missing",
            heading: source.selector.heading,
            link_label: source.selector.link_label,
            resolved_url: null,
          },
        });
        observations.push(row);
        completed.set(source.source_id, row);
        continue;
      }

      const fetched = await fetchWithRetries(httpGet, entry.resolved_url, {
        maxRetries,
        requestId: source.source_id,
        parentRequestId: "dot-parent-current-projects",
        observedAt,
      });
      requestGraph.push(fetched.receipt);
      if (!fetched.ok) {
        const row = failureObservation({
          source,
          observedAt,
          reason: "retrieval_failure",
          resolvedUrl: entry.resolved_url,
          requestReceipt: fetched.receipt,
          selectorResolution: entry,
        });
        observations.push(row);
        completed.set(source.source_id, row);
        continue;
      }
      const row = successObservation({
        source,
        observedAt,
        resolvedUrl: entry.resolved_url,
        bytes: fetched.bytes,
        requestReceipt: fetched.receipt,
        selectorResolution: entry,
      });
      observations.push(row);
      completed.set(source.source_id, row);
      continue;
    }

    const fetched = await fetchWithRetries(httpGet, source.url, {
      maxRetries,
      requestId: source.source_id,
      observedAt,
    });
    requestGraph.push(fetched.receipt);
    if (!fetched.ok) {
      const row = failureObservation({
        source,
        observedAt,
        reason: "retrieval_failure",
        resolvedUrl: source.url,
        requestReceipt: fetched.receipt,
      });
      observations.push(row);
      completed.set(source.source_id, row);
      continue;
    }
    const row = successObservation({
      source,
      observedAt,
      resolvedUrl: source.url,
      bytes: fetched.bytes,
      requestReceipt: fetched.receipt,
    });
    observations.push(row);
    completed.set(source.source_id, row);
  }

  const retained = observations.filter((row) => row.retained);
  const failures = observations.filter((row) => !row.retained);

  const artifact = {
    schema: CONNECTED_HISTORY_DOCUMENTS_SCHEMA,
    version: CONNECTED_HISTORY_DOCUMENTS_VERSION,
    generated_at: observedAt,
    parser_version: CONNECTED_HISTORY_DOCUMENTS_PARSER_VERSION,
    transport: { ...CONNECTED_HISTORY_DOCUMENTS_TRANSPORT, maxRetries },
    source_policy: "fixed-six-case-dossier-ceqr-dot-edc-only",
    boundaries: {
      board_scraper: false,
      bsa_calendar: false,
      historical_presentations_as_consultations: false,
    },
    counts: {
      sources: sources.length,
      retained: retained.length,
      acquisition_failures: failures.length,
      dot_selectors_resolved: dotManifest?.resolved_count ?? 0,
      dot_selectors_mismatched: dotManifest?.mismatch_count ?? 0,
    },
    dot_selector_manifest: dotManifest,
    observations: observations.sort((a, b) => a.source_id.localeCompare(b.source_id)),
  };

  const nextCheckpoint = {
    schema: "cityscroll.connected_history_documents_checkpoint.v1",
    observed_at: observedAt,
    completed_source_ids: [...completed.keys()].sort(),
    observations: [...completed.values()],
    parent_html: parentHtml,
    parent_receipt: parentReceipt,
    dot_selector_manifest: dotManifest,
    request_graph: requestGraph,
  };

  const receipt = {
    schema: CONNECTED_HISTORY_DOCUMENTS_RECEIPT_SCHEMA,
    version: CONNECTED_HISTORY_DOCUMENTS_VERSION,
    observed_at: observedAt,
    parser_version: CONNECTED_HISTORY_DOCUMENTS_PARSER_VERSION,
    max_retries: maxRetries,
    checkpointed: true,
    request_count: requestGraph.length,
    counts: artifact.counts,
    selection_hash: sha256Text(
      artifact.observations
        .map((row) => `${row.source_id}:${row.status}:${row.content_hash || row.reason}`)
        .join("|"),
    ),
    artifact: "site/data/connected_history_documents.json",
    failures: failures.map((row) => ({
      source_id: row.source_id,
      reason: row.reason,
      resolved_url: row.resolved_url,
    })),
  };

  return { artifact, receipt, checkpoint: nextCheckpoint, requestGraph };
}

export function getConnectedHistoryDocumentSource(sourceId) {
  return SOURCE_BY_ID.get(sourceId) || null;
}

export function listConnectedHistoryDocumentSourceIds() {
  return CONNECTED_HISTORY_DOCUMENT_SOURCES.map((source) => source.source_id);
}
