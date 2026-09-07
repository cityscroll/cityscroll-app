// One place to tell "the city's data service did not answer" apart from "the digest we build is
// wrong". The distinction is load-bearing in two directions. A gateway timeout at the source must
// not be reported as a defect in a rendering nobody has found fault with, and it must not put a
// hold on a subscriber's mail. A malformed query of ours must not hide behind the word upstream.
//
// The boundary is the response status, not the word SODA: a transient class (the source is
// unwell) is upstream; a rejection of the request itself (400, 403, 404, 422) is ours.

export const UPSTREAM_UNAVAILABLE = "upstream_source_unavailable";
// The rehearsal outcome that names this condition. It lives here, next to the rule that decides
// it, so the detector and the delivery-hold policy can both read it without importing each other.
export const DIGEST_SHADOW_DEGRADED_UPSTREAM = "DEGRADED_UPSTREAM";
export const BUILD_DEFECT = "build_defect";

/** Statuses a source returns while it is unwell, rather than while we are asking wrongly. */
export const TRANSIENT_UPSTREAM_STATUSES = Object.freeze(
  new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]),
);

// "SODA 524", "hearing SODA 503", "current-solicitations SODA 502", "SODA status 500".
const SOURCE_STATUS_RE = /(?:([A-Za-z][A-Za-z0-9/_-]*)\s+)?\bSODA\b(?:\s+status)?\s+(\d{3})\b/i;
const TRANSIENT_MESSAGE_RE =
  /\b(?:fetch failed|network error|connection (?:reset|refused|closed)|socket hang up|timed out|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN)\b/i;

function sourceLabel(prefix) {
  const label = String(prefix || "").trim();
  return label ? `${label.toLowerCase()}-soda` : "soda";
}

function finite(value, fallback = null) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

/**
 * Tag a thrown error with the upstream it came from, so the caller that stringifies it does not
 * have to guess afterwards. Returns the same error for `throw markUpstreamFailure(...)`.
 */
export function markUpstreamFailure(error, { source, httpStatus = null, attempts = 1 } = {}) {
  if (!error || typeof error !== "object") return error;
  error.upstream_source = source || "upstream";
  error.upstream_status = finite(httpStatus);
  error.upstream_attempts = finite(attempts, 1);
  return error;
}

/** Classify a caught error (or its already-stringified message). */
export function classifyDigestBuildError(input) {
  const error = input && typeof input === "object" ? input : null;
  const message = String(error?.message ?? input ?? "").trim();
  if (error?.upstream_source) {
    return {
      class: UPSTREAM_UNAVAILABLE,
      source: String(error.upstream_source),
      http_status: finite(error.upstream_status),
      attempts: finite(error.upstream_attempts, 1),
      message,
    };
  }
  const matched = SOURCE_STATUS_RE.exec(message);
  if (matched) {
    const status = Number(matched[2]);
    return {
      class: TRANSIENT_UPSTREAM_STATUSES.has(status) ? UPSTREAM_UNAVAILABLE : BUILD_DEFECT,
      source: sourceLabel(matched[1]),
      http_status: status,
      attempts: null,
      message,
    };
  }
  if (TRANSIENT_MESSAGE_RE.test(message)) {
    return { class: UPSTREAM_UNAVAILABLE, source: "upstream", http_status: null, attempts: null, message };
  }
  return { class: BUILD_DEFECT, source: null, http_status: null, attempts: null, message };
}

/**
 * Classify a failed digest result. The structured tag stamped at the throw site wins; a result
 * that only carries the stringified message still classifies, which keeps older stored runs and
 * every non-legacy watch path readable through the same rule.
 */
export function classifyDigestResultError(result) {
  if (!result?.error) return null;
  const upstream = result.upstream;
  if (upstream?.source) {
    return {
      class: UPSTREAM_UNAVAILABLE,
      source: String(upstream.source),
      http_status: finite(upstream.http_status),
      attempts: finite(upstream.attempts),
      message: String(result.error),
    };
  }
  return classifyDigestBuildError(result.error);
}

/** Fields to spread onto a digest result whose build failed. Empty when the fault is ours. */
export function upstreamResultFields(error) {
  const finding = classifyDigestBuildError(error);
  if (finding.class !== UPSTREAM_UNAVAILABLE) return {};
  return {
    upstream: {
      source: finding.source,
      http_status: finding.http_status,
      attempts: finding.attempts,
    },
  };
}
