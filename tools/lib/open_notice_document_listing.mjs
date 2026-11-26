/**
 * Public file list for an open City Record solicitation, bound to one PASSPort
 * round or left unpublished with a named reason.
 *
 * The list is names and types from the public Navigator page. Size and page
 * count are filled only from an observation the caller already made. A file
 * over the existing document byte cap is listed and not read. This module does
 * not fetch, crawl, schedule a job, authenticate, or call a model.
 */
import { buildEpinIndex, joinPinToEpin, normId } from "../../worker/src/lib/passport_join.mjs";
import {
  MAX_DOCUMENT_BYTES,
  NAVIGATOR_BASE_URL,
  NAVIGATOR_SOURCE_ID,
  looksLikeLoginHtml,
  navigatorUrlForRfpId,
  parseNavigatorRfxHtml,
} from "../../warehouse/lib/navigator_rfx_documents.mjs";
import { RFX_DATA_URL } from "../../worker/src/lib/passport_parse.mjs";

export const LISTING_SCHEMA = "cityscroll.open_notice_document_listings.v1";
export const LISTING_COVERAGE_SCHEMA = "cityscroll.open_notice_document_listing_coverage.v1";
export const LISTING_SOURCE_NAME = NAVIGATOR_SOURCE_ID;
export { MAX_DOCUMENT_BYTES };
export const MAX_LISTING_BYTES = 2 * 1024 * 1024;

export const BASIS = Object.freeze([
  "pin_equals_epin",
  "title_exact",
  "release_date_equal",
  "due_datetime_equal",
  "single_feed_row_for_epin",
  "navigator_round_observed",
  "navigator_displayed_id_equals_bpm_id_numeric",
]);

export const REASON_CODES = Object.freeze([
  "no_pin",
  "pin_not_joined",
  "ambiguous_epin",
  "title_mismatch",
  "release_date_mismatch",
  "due_datetime_mismatch",
  "navigator_not_observed",
  "navigator_unavailable",
  "navigator_identity_mismatch",
  "no_public_files",
  "rfx_unavailable",
  "rfx_empty",
]);

const REASON_TEXT = Object.freeze({
  no_pin: "This notice has no PIN, so no public file list can be bound.",
  pin_not_joined: "This notice's PIN does not equal a PASSPort EPIN.",
  ambiguous_epin: "More than one PASSPort round uses this EPIN, so no file list is bound.",
  title_mismatch: "The PIN matches one round, but the title does not match exactly.",
  release_date_mismatch: "The PIN matches one round, but the release date does not match.",
  due_datetime_mismatch: "The PIN matches one round, but the due date and time do not match.",
  navigator_not_observed: "The round matches, but its public file page was not read.",
  navigator_unavailable: "The public file page could not be read.",
  navigator_identity_mismatch: "The public file page's displayed id does not match this round.",
  no_public_files: "The bound public page lists no files.",
  rfx_unavailable: "The PASSPort round list could not be read, so this count was not measured.",
  rfx_empty: "The PASSPort round list was empty, so this count was not measured.",
});

const JOIN_RULE = "Strict binding: the PIN equals one EPIN, that EPIN has one round after identical rows are collapsed, the title matches verbatim or corroborates after stripping City Record framing prefixes (Bid Extension/Correction/Addendum/Rebid) and the matched EPIN prefix with strict containment or shared-token overlap, the release calendar day matches, the due wall-clock time matches, and the public Navigator page shows that round with a displayed id equal to the round's bpm id. Prefix joins are not a file-list binding. Size is bytes and page count is pages, both only when an observation supplied them. A file over the document byte cap is listed and not read.";

const TITLE_FRAMING_PREFIX = /^(?:bid\s+extension|correction|addendum(?:\s+\d+)?|rebid|amended)\s*[:\-–—]\s*/i;
const TITLE_STOPWORDS = new Set([
  "a", "an", "and", "at", "by", "for", "from", "in", "of", "on", "or", "the", "to", "with",
]);

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Strip City Record editorial framing prefixes and the matched EPIN prefix,
 * then canonicalize punctuation/case for deterministic title corroboration.
 */
export function normalizeTitleForCorroboration(value, epin = null) {
  let text = cleanText(value);
  if (!text) return null;
  let prev;
  do {
    prev = text;
    text = text.replace(TITLE_FRAMING_PREFIX, "").trim();
    if (epin) {
      const epinPrefix = new RegExp(`^${escapeRegex(String(epin).trim())}(?:[\\s:\\-–—]+|$)`, "i");
      text = text.replace(epinPrefix, "").trim();
    }
  } while (text && text !== prev);
  text = text
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  return text || null;
}

function significantTitleTokens(normalized) {
  return normalized
    .split(" ")
    .filter((token) => token && !TITLE_STOPWORDS.has(token));
}

/**
 * Return `"exact"`, `"normalized"`, or `null` for a single-round EPIN pair.
 * Only used alongside exact PIN==EPIN, single round, release day, and due time.
 */
export function matchCorroboratedTitle(noticeTitle, roundTitle, epin = null) {
  const exactNotice = exactTitle(noticeTitle);
  const exactRound = exactTitle(roundTitle);
  if (!exactNotice || !exactRound) return null;
  if (exactNotice === exactRound) return "exact";

  const normNotice = normalizeTitleForCorroboration(exactNotice, epin);
  const normRound = normalizeTitleForCorroboration(exactRound, epin);
  if (!normNotice || !normRound) return null;
  if (normNotice === normRound) return "normalized";

  const shorter = normNotice.length <= normRound.length ? normNotice : normRound;
  const longer = normNotice.length <= normRound.length ? normRound : normNotice;
  const shorterWords = shorter.split(" ").filter(Boolean);
  // Strict phrase containment (e.g. agency project code "bepa gi cons 7" inside full title).
  if (shorter.length >= 10 && shorterWords.length >= 2) {
    const boundary = new RegExp(`(?:^| )${escapeRegex(shorter)}(?: |$)`);
    if (boundary.test(longer)) return "normalized";
  }

  // Strict significant-token overlap (handles address/borough abbreviations like "S 9 St BK" vs "South 9th Street Brooklyn").
  const tokensA = new Set(significantTitleTokens(normNotice));
  const tokensB = new Set(significantTitleTokens(normRound));
  const minSize = Math.min(tokensA.size, tokensB.size);
  if (minSize >= 3) {
    let shared = 0;
    for (const token of tokensA) {
      if (tokensB.has(token)) shared += 1;
    }
    if (shared >= 3 && (shared / minSize) >= 0.5) return "normalized";
  }

  return null;
}

function cleanText(value) {
  return String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function exactTitle(value) {
  const text = cleanText(value);
  return text || null;
}

function validDay(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const ms = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === day;
}

/** Publisher wall clock. No timezone conversion: both sides are naive local times. */
export function parsePublisherClock(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const iso = raw.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2}))?/);
  if (iso) {
    if (!validDay(iso[1])) return null;
    if (!iso[2]) return { day: iso[1], stamp: null };
    return { day: iso[1], stamp: `${iso[1]}T${iso[2]}:${iso[3]}:${iso[4]}` };
  }
  const us = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}):(\d{2})\s*([AP]M))?/i);
  if (!us) return null;
  const day = `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
  if (!validDay(day)) return null;
  if (!us[4]) return { day, stamp: null };
  let hour = Number(us[4]);
  const ampm = us[7].toUpperCase();
  if (hour < 1 || hour > 12) return null;
  if (ampm === "AM") hour = hour === 12 ? 0 : hour;
  else hour = hour === 12 ? 12 : hour + 12;
  const time = `${String(hour).padStart(2, "0")}:${us[5]}:${us[6]}`;
  return { day, stamp: `${day}T${time}` };
}

function numericId(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (!digits) return null;
  const stripped = digits.replace(/^0+/, "");
  return stripped || "0";
}

function typesByDocumentId(html) {
  const types = new Map();
  const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  for (const row of String(html || "").matchAll(rowPattern)) {
    const id = row[1].match(/documentId=(\d+)/i);
    if (!id || types.has(id[1])) continue;
    const anchor = cleanText((row[1].match(/<a\b[^>]*>([\s\S]*?)<\/a>/i) || [])[1] || "");
    const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => cleanText(cell[1]));
    const type = cells.find((cell) => cell && cell !== anchor) || null;
    types.set(id[1], type);
  }
  return types;
}

/** Names, types and ids from one Navigator page. No download. */
export function listNavigatorDocuments(html) {
  if (looksLikeLoginHtml(html)) {
    return { ok: false, failure: "access_required", documents: [] };
  }
  const parsed = parseNavigatorRfxHtml(html);
  if (!parsed.ok) {
    return { ok: false, failure: parsed.failure?.type || "navigator_unreadable", documents: [] };
  }
  const types = typesByDocumentId(html);
  return {
    ok: true,
    failure: null,
    displayed_id: parsed.displayed_id,
    round_label: parsed.round_label,
    documents: parsed.documents.map((document) => ({
      document_id: document.document_id,
      name: document.label.replace(/&lt;/gi, "<").replace(/&gt;/gi, ">"),
      type: types.get(document.document_id) || null,
      official_url: document.official_url,
    })),
  };
}

function fileKind(observation, name) {
  const type = String(observation?.content_type || "").toLowerCase();
  const filename = String(observation?.filename || name || "").toLowerCase();
  if (type.includes("pdf") || filename.endsWith(".pdf")) return "pdf";
  if (type.includes("spreadsheet") || type.includes("excel") || filename.endsWith(".xlsx") || filename.endsWith(".xls")) {
    return "spreadsheet";
  }
  if (type.includes("wordprocessing") || filename.endsWith(".docx") || filename.endsWith(".doc")) return "word";
  if (type) return "other";
  return "unknown";
}

function publishedFile(document, observation) {
  const kind = fileKind(observation, document.name);
  const size = Number.isInteger(observation?.size_bytes) && observation.size_bytes >= 0
    ? observation.size_bytes
    : null;
  const oversize = observation?.oversize === true || (size != null && size > MAX_DOCUMENT_BYTES);
  let pageCount = Number.isInteger(observation?.page_count) && observation.page_count >= 0
    ? observation.page_count
    : null;
  let pageState = "not_measured";
  if (kind === "spreadsheet" || kind === "word") {
    pageCount = null;
    pageState = "not_applicable";
  } else if (oversize) {
    pageCount = null;
    pageState = "oversize";
  } else if (pageCount != null) {
    pageState = "measured";
  }
  return {
    document_id: document.document_id,
    name: document.name,
    type: document.type,
    file_kind: kind,
    size_bytes: size,
    size_unit: "bytes",
    size_state: size == null ? "not_measured" : "measured",
    page_count: pageCount,
    page_unit: "pages",
    page_state: pageState,
    official_url: document.official_url,
  };
}

function pageTotal(files) {
  const complete = files.every((file) => file.page_state === "measured" || file.page_state === "not_applicable");
  if (!complete) return null;
  return files.reduce((sum, file) => sum + (file.page_count || 0), 0);
}

function coverageRecord(state, reasonCode, asOf, data) {
  return {
    key: "documents_listed",
    state,
    reason: state === "available" ? null : REASON_TEXT[reasonCode],
    source: { name: LISTING_SOURCE_NAME },
    as_of: asOf,
    data,
  };
}

function noticeEntry(notice, record) {
  const requestId = String(notice?.request_id || "");
  return {
    request_id: requestId,
    notice_id: requestId ? `notice:${requestId}` : null,
    coverage: { documents_listed: record },
  };
}

function orderedBasis(tokens) {
  const have = new Set(tokens || []);
  return BASIS.filter((token) => have.has(token));
}

function missing(notice, asOf, reasonCode, data) {
  return noticeEntry(notice, coverageRecord("missing", reasonCode, asOf, {
    binding: reasonCode === "ambiguous_epin" ? "ambiguous" : "unmatched",
    reason_code: reasonCode,
    basis: orderedBasis(data.basis),
    basis_failed: data.basis_failed || [reasonCode],
    rfp_id: data.rfp_id || null,
    epin: data.epin || null,
    failure: data.failure || null,
    files: [],
  }));
}

function rowsForEpin(rows, epin) {
  const key = normId(epin);
  return rows.filter((row) => normId(row?.epin) === key);
}

function roundKey(row) {
  const release = parsePublisherClock(row?.release_date);
  const due = parsePublisherClock(row?.due_date);
  return [
    String(row?.rfp_id || ""),
    exactTitle(row?.procurement_name) || "",
    release?.day || "",
    due?.stamp || due?.day || "",
  ].join("\u001f");
}

function distinctRounds(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = roundKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function readNavigator(pages, rfpId) {
  if (!pages || !Object.prototype.hasOwnProperty.call(pages, rfpId)) return { status: "absent" };
  const value = pages[rfpId];
  if (value == null) return { status: "absent" };
  if (typeof value === "string") return { status: "html", list: listNavigatorDocuments(value) };
  if (value.ok === false) return { status: "html", list: { ok: false, failure: value.failure || "navigator_unreadable", documents: [] } };
  return { status: "html", list: value };
}

function bindNotice(notice, rows, pages, observations, asOf) {
  const pin = normId(notice?.pin);
  if (!pin) return missing(notice, asOf, "no_pin", { basis: [], basis_failed: ["pin_equals_epin"] });
  const index = buildEpinIndex(rows.map((row) => row?.epin));
  const join = joinPinToEpin(pin, index);
  if (!join || join.method !== "exact") {
    return missing(notice, asOf, "pin_not_joined", { basis: [], basis_failed: ["pin_equals_epin"] });
  }
  const rounds = distinctRounds(rowsForEpin(rows, join.epin));
  if (rounds.length !== 1) {
    return missing(notice, asOf, "ambiguous_epin", {
      basis: ["pin_equals_epin"],
      basis_failed: ["single_feed_row_for_epin"],
      epin: join.epin,
    });
  }
  const row = rounds[0];
  const basis = ["pin_equals_epin", "single_feed_row_for_epin"];
  const rfpId = String(row.rfp_id || "");
  const shared = { rfp_id: rfpId || null, epin: join.epin };
  const titleMatch = matchCorroboratedTitle(notice?.short_title, row.procurement_name, join.epin);
  if (!titleMatch) {
    return missing(notice, asOf, "title_mismatch", { ...shared, basis, basis_failed: ["title_exact"] });
  }
  basis.push("title_exact");
  const noticeRelease = parsePublisherClock(notice?.start_date);
  const roundRelease = parsePublisherClock(row.release_date);
  if (!noticeRelease?.day || noticeRelease.day !== roundRelease?.day) {
    return missing(notice, asOf, "release_date_mismatch", { ...shared, basis, basis_failed: ["release_date_equal"] });
  }
  basis.push("release_date_equal");
  const noticeDue = parsePublisherClock(notice?.due_date);
  const roundDue = parsePublisherClock(row.due_date);
  if (!noticeDue?.stamp || noticeDue.stamp !== roundDue?.stamp) {
    return missing(notice, asOf, "due_datetime_mismatch", { ...shared, basis, basis_failed: ["due_datetime_equal"] });
  }
  basis.push("due_datetime_equal");
  const navigator = readNavigator(pages, rfpId);
  if (navigator.status === "absent") {
    return missing(notice, asOf, "navigator_not_observed", { ...shared, basis, basis_failed: ["navigator_round_observed"] });
  }
  if (!navigator.list?.ok) {
    return missing(notice, asOf, "navigator_unavailable", {
      ...shared,
      basis,
      basis_failed: ["navigator_round_observed"],
      failure: navigator.list?.failure || "navigator_unreadable",
    });
  }
  if (!navigator.list.round_label) {
    return missing(notice, asOf, "navigator_unavailable", {
      ...shared,
      basis,
      basis_failed: ["navigator_round_observed"],
      failure: "navigator_identity_missing",
    });
  }
  basis.push("navigator_round_observed");
  const displayed = numericId(navigator.list.displayed_id);
  const bpm = numericId(row.bpm_id);
  if (!displayed || !bpm || displayed !== bpm) {
    return missing(notice, asOf, "navigator_identity_mismatch", {
      ...shared,
      basis,
      basis_failed: ["navigator_displayed_id_equals_bpm_id_numeric"],
    });
  }
  basis.push("navigator_displayed_id_equals_bpm_id_numeric");
  const documents = navigator.list.documents || [];
  if (!documents.length) {
    return missing(notice, asOf, "no_public_files", { ...shared, basis, basis_failed: ["public_files"] });
  }
  const files = documents.map((document) => publishedFile(document, observations?.[document.document_id]));
  return noticeEntry(notice, coverageRecord("available", null, asOf, {
    binding: "corroborated",
    reason_code: null,
    basis: orderedBasis(basis),
    basis_failed: [],
    rfp_id: rfpId,
    epin: join.epin,
    bpm_id: String(row.bpm_id || ""),
    round_label: navigator.list.round_label,
    displayed_id: navigator.list.displayed_id,
    navigator_url: navigatorUrlForRfpId(rfpId),
    file_count: files.length,
    page_count_total: pageTotal(files),
    page_unit: "pages",
    files,
  }));
}

function emptyReasons() {
  return Object.fromEntries(REASON_CODES.map((code) => [code, 0]));
}

/**
 * One plain record per open notice. `rfxFailure` is a failed read, and the
 * artifact state is then unavailable rather than a measured zero.
 */
export function buildOpenNoticeDocumentListings({
  notices,
  rfxRows = [],
  navigatorByRfpId = {},
  fileObservations = {},
  asOf,
  observedAt = null,
  rfxFailure = null,
} = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(asOf || ""))) {
    throw new Error("asOf must be a calendar day YYYY-MM-DD");
  }
  const list = Array.isArray(notices) ? notices : [];
  const rows = Array.isArray(rfxRows) ? rfxRows : [];
  let entries;
  let unavailable = null;
  if (rfxFailure) {
    unavailable = String(rfxFailure);
    entries = list.map((notice) => missing(notice, asOf, "rfx_unavailable", {
      basis: [],
      basis_failed: ["rfx_read"],
      failure: unavailable,
    }));
  } else if (!rows.length) {
    unavailable = "rfx_empty";
    entries = list.map((notice) => missing(notice, asOf, "rfx_empty", { basis: [], basis_failed: ["rfx_read"] }));
  } else {
    entries = list.map((notice) => bindNotice(notice, rows, navigatorByRfpId, fileObservations, asOf));
  }
  entries.sort((a, b) => String(a.request_id).localeCompare(String(b.request_id)));
  const byReason = emptyReasons();
  let available = 0;
  let filesListed = 0;
  let filesSizeMeasured = 0;
  let filesPagesMeasured = 0;
  let filesOversize = 0;
  for (const entry of entries) {
    const record = entry.coverage.documents_listed;
    if (record.state === "available") {
      available += 1;
      for (const file of record.data.files) {
        filesListed += 1;
        if (file.size_state === "measured") filesSizeMeasured += 1;
        if (file.page_state === "measured") filesPagesMeasured += 1;
        if (file.page_state === "oversize") filesOversize += 1;
      }
    } else {
      const code = record.data.reason_code;
      if (Object.prototype.hasOwnProperty.call(byReason, code)) byReason[code] += 1;
    }
  }
  const artifact = {
    schema: LISTING_SCHEMA,
    state: unavailable ? "unavailable" : "measured",
    unavailable_reason: unavailable,
    join_rule: JOIN_RULE,
    source: { name: LISTING_SOURCE_NAME, url: NAVIGATOR_BASE_URL },
    rfx_source: { name: "passport_public_rfx", url: RFX_DATA_URL },
    notice_source: { name: "City Record Online", dataset: "dg92-zbpx" },
    as_of: asOf,
    observed_at: observedAt,
    open_notices: entries.length,
    available,
    missing: entries.length - available,
    documents_listed_coverage: {
      schema: LISTING_COVERAGE_SCHEMA,
      state: unavailable ? "unavailable" : "measured",
      unavailable_reason: unavailable,
      join_rule: JOIN_RULE,
      source: { name: LISTING_SOURCE_NAME },
      as_of: asOf,
      observed_at: observedAt,
      open_notices: entries.length,
      available,
      missing: entries.length - available,
      by_reason: byReason,
      files_listed: filesListed,
      files_size_measured: filesSizeMeasured,
      files_pages_measured: filesPagesMeasured,
      files_oversize: filesOversize,
    },
    notices: entries,
  };
  assertListingWithinBound(artifact);
  return artifact;
}

export function assertListingWithinBound(artifact) {
  const bytes = Buffer.byteLength(JSON.stringify(artifact));
  if (bytes > MAX_LISTING_BYTES) {
    const error = new Error(`document listing is ${bytes} bytes, over ${MAX_LISTING_BYTES}`);
    error.code = "listing_oversize";
    throw error;
  }
  return bytes;
}
