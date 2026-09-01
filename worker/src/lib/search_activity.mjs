/**
 * Worker-owned half of the search-execution receipt.
 *
 * Three identities stay separate here and never collapse into one another:
 *
 *   visitor_id     opaque, random, first-party browser identity. NOT a credential:
 *                  it authenticates nothing, authorizes nothing, and is never
 *                  accepted as proof of an account.
 *   subscriber_id  derived from a recognized `cs_session` email through the
 *                  existing subscriber helper. Present only when recognized.
 *   network        a coarse request-IP observation kept only for the receipt's
 *                  own retention window, for diagnosing coverage incidents.
 *
 * Collapsing any two of these would turn private diagnostics into a tracking
 * join, so each is resolved independently and stored under its own field.
 */

import {
  SEARCH_ACTIVITY_RETENTION_DAYS,
  cleanReceiptText,
} from "../../../capabilities/search_activity.mjs";

export const VISITOR_COOKIE_NAME = "cs_visitor";
/** Only this host issues the cookie, and host-only scope keeps it here too. */
export const VISITOR_COOKIE_ISSUER_HOST = "api.cityscroll.org";
/** ~1 year, matching the "recognize this browser across visits" intent. */
export const VISITOR_COOKIE_TTL_SECONDS = 365 * 24 * 3600;
/** 256 bits of randomness — comfortably above the 128-bit floor. */
export const VISITOR_ID_ENTROPY_BYTES = 32;

/** Production and developer receipts live under disjoint key prefixes. */
export const SEARCH_ACTIVITY_KEY_PREFIX = "search:exec:";
export const SEARCH_ACTIVITY_DEVELOPER_KEY_PREFIX = "search:exec-dev:";

export const SEARCH_ACTIVITY_RETENTION_SECONDS = SEARCH_ACTIVITY_RETENTION_DAYS * 24 * 3600;

/** Bound on one authenticated read page; keeps the desk read predictable. */
export const SEARCH_ACTIVITY_MAX_READ_LIMIT = 100;
export const SEARCH_ACTIVITY_DEFAULT_READ_LIMIT = 25;

const MAX_USER_AGENT_LENGTH = 300;
// Keys sort DESCENDING by time so a bounded list() returns the newest executions
// without paging the whole namespace. 1e15 ms is far beyond any real timestamp.
const KEY_TIME_BASE = 1_000_000_000_000_000;

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomToken(bytes = VISITOR_ID_ENTROPY_BYTES) {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Opaque per-execution identity. Never derived from the reader or the query. */
export function newExecutionId() {
  return `exec_${randomToken(16)}`;
}

export function newReceiptId() {
  return `rcpt_${randomToken(16)}`;
}

export function newVisitorId() {
  return `v1_${randomToken(VISITOR_ID_ENTROPY_BYTES)}`;
}

/** A stored visitor id must look like one we minted; anything else is replaced. */
export function isWellFormedVisitorId(value) {
  return typeof value === "string" && /^v1_[A-Za-z0-9_-]{43}$/.test(value);
}

export function readVisitorCookie(cookieHeader) {
  if (typeof cookieHeader !== "string" || !cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== VISITOR_COOKIE_NAME) continue;
    const value = part.slice(index + 1).trim();
    if (isWellFormedVisitorId(value)) return value;
  }
  return null;
}

/**
 * First-party visitor cookie. HttpOnly so page scripts cannot read or forge it,
 * Secure so it never crosses plaintext, SameSite=Lax so it is not a cross-site
 * tracking primitive, and host-only (no Domain attribute) so it travels only to
 * the intake host and never rides page views on the static site hosts.
 */
export function visitorCookieHeader(visitorId, { maxAge = VISITOR_COOKIE_TTL_SECONDS } = {}) {
  return [
    `${VISITOR_COOKIE_NAME}=${visitorId}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${maxAge}`,
  ].join("; ");
}

/** True only where a response can set a cookie the canonical documents share. */
export function canIssueVisitorCookie(requestUrl) {
  try {
    const url = new URL(requestUrl);
    return url.protocol === "https:" && url.hostname === VISITOR_COOKIE_ISSUER_HOST;
  } catch {
    return false;
  }
}

/**
 * Resolve the browser visitor identity for one request.
 * Returns the existing cookie when present, otherwise a fresh id plus the
 * Set-Cookie header the caller must attach.
 */
export function resolveVisitor(req) {
  const existing = readVisitorCookie(req.headers.get("cookie") || "");
  if (existing) return { visitorId: existing, setCookie: null, issued: false };
  const visitorId = newVisitorId();
  return {
    visitorId,
    setCookie: canIssueVisitorCookie(req.url) ? visitorCookieHeader(visitorId) : null,
    issued: true,
  };
}

/**
 * Redact a recognized address to an operator-legible label. The domain stays
 * because coverage incidents cluster by mail provider; the local part does not.
 */
export function redactedAccountLabel(email) {
  const address = cleanReceiptText(email, 320).toLowerCase();
  const at = address.lastIndexOf("@");
  if (at <= 0 || at === address.length - 1) return null;
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  return `${local.slice(0, 1)}…@${domain}`.slice(0, 120);
}

const BROWSER_RULES = Object.freeze([
  { family: "edge", pattern: /Edg(?:e|A|iOS)?\/(\d{1,4})/ },
  { family: "opera", pattern: /OPR\/(\d{1,4})/ },
  { family: "samsung", pattern: /SamsungBrowser\/(\d{1,4})/ },
  { family: "firefox", pattern: /Firefox\/(\d{1,4})/ },
  { family: "chrome", pattern: /(?:Chrome|CriOS)\/(\d{1,4})/ },
  { family: "safari", pattern: /Version\/(\d{1,4})[.\d]*\s+(?:Mobile\/\S+\s+)?Safari\// },
]);

const OS_RULES = Object.freeze([
  { family: "android", pattern: /Android/ },
  { family: "ios", pattern: /(iPhone|iPad|iPod)/ },
  { family: "macos", pattern: /Mac OS X|Macintosh/ },
  { family: "windows", pattern: /Windows NT/ },
  { family: "chromeos", pattern: /CrOS/ },
  { family: "linux", pattern: /Linux/ },
]);

/**
 * Bounded, low-cardinality browser observation. Deliberately coarse: family plus
 * major version is enough to diagnose a rendering or coverage incident and is far
 * too weak to act as a fingerprint on its own.
 */
export function classifyUserAgent(rawUserAgent) {
  const userAgent = cleanReceiptText(rawUserAgent, MAX_USER_AGENT_LENGTH);
  const browser = BROWSER_RULES.find((rule) => rule.pattern.test(userAgent));
  const match = browser ? userAgent.match(browser.pattern) : null;
  const os = OS_RULES.find((rule) => rule.pattern.test(userAgent));
  const isTablet = /iPad|Tablet/.test(userAgent) || (/Android/.test(userAgent) && !/Mobile/.test(userAgent));
  const isMobile = /Mobi|iPhone|iPod/.test(userAgent);
  return {
    user_agent: userAgent || null,
    browser_family: browser?.family || (userAgent ? "other" : null),
    browser_major_version: match?.[1] ? Number(match[1]) : null,
    os_family: os?.family || (userAgent ? "other" : null),
    device_class: !userAgent ? null : isTablet ? "tablet" : isMobile ? "mobile" : "desktop",
  };
}

/** Coarse network observation, retained only for this receipt's window. */
export function networkObservation(req) {
  return {
    request_ip: cleanReceiptText(req.headers.get("CF-Connecting-IP"), 60) || null,
    country: cleanReceiptText(req.headers.get("CF-IPCountry"), 8) || null,
    retention_days: SEARCH_ACTIVITY_RETENTION_DAYS,
  };
}

/** Descending-by-time key so a bounded list() reads the newest receipts first. */
export function searchActivityKey({ receivedAtMs, receiptId, trafficClass }) {
  const prefix = trafficClass === "developer"
    ? SEARCH_ACTIVITY_DEVELOPER_KEY_PREFIX
    : SEARCH_ACTIVITY_KEY_PREFIX;
  const stamp = String(Math.max(0, KEY_TIME_BASE - receivedAtMs)).padStart(16, "0");
  return `${prefix}${stamp}:${receiptId}`;
}

/** Assemble the stored receipt. Worker-owned fields always win over submitted ones. */
export function buildSearchExecutionReceipt(submission, {
  receiptId,
  executionId,
  receivedAt,
  visitorId,
  subscriberId = null,
  accountLabel = null,
  recognized = false,
  trafficClass = "production",
  userAgentObservation,
  network,
}) {
  return {
    ...submission,
    receipt_id: receiptId,
    execution_id: executionId,
    received_at: receivedAt,
    visitor_id: visitorId,
    subscriber_id: subscriberId,
    account_label: accountLabel,
    recognition: recognized ? "recognized" : "anonymous",
    ...userAgentObservation,
    network,
    traffic_class: trafficClass,
    retention_days: SEARCH_ACTIVITY_RETENTION_DAYS,
  };
}
