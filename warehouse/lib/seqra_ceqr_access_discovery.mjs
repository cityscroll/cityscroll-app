/**
 * SEQRA-04: the CEQR Access discovery receipt.
 *
 * The commission's Tier 2 registration of `ceqr_access` in
 * warehouse/lib/seqra_source_registry.mjs already carries the constraint
 * this module exists to satisfy: "Search page and linked documents only; no
 * documented bulk API. Do not assume an undocumented bulk API." SEQRA-01
 * recorded a single reachability probe of the base URL. This module builds
 * the richer discovery receipt SEQRA-04 owns: a record of what a bounded,
 * polite sequence of real HTTP probes against the live search interface
 * actually observed, before any manifest or fetcher logic is built on top of
 * an assumption about how that interface behaves.
 *
 * Every field here traces to a probe's own fetch receipt
 * (warehouse/lib/seqra_fetch_receipt.mjs); nothing is asserted from memory or
 * general knowledge of how NYC.gov ASP.NET sites "usually" work. A form
 * field, a search-result shape, or a document-link pattern this module has
 * not itself observed in a probe is recorded as `not_yet_observed`, never
 * inferred.
 */
import { SEQRA_FETCH_RECEIPT_SCHEMA } from "./seqra_fetch_receipt.mjs";

export const SEQRA_CEQR_ACCESS_DISCOVERY_SCHEMA = "cityscroll.seqra_ceqr_access_discovery_receipt.v1";
export const CEQR_ACCESS_SOURCE_ID = "ceqr_access";

export const CEQR_ACCESS_NO_BULK_API_ASSERTION =
  "No documented bulk API was found for CEQR Access in this discovery pass. The site is a stateful " +
  "ASP.NET WebForms application: the search page requires __VIEWSTATE/__EVENTVALIDATION tokens minted " +
  "per-request and posts back to its own URL, not a stable query-string or JSON endpoint. This pipeline " +
  "does not assume an undocumented bulk API exists, and every fetch it performs replays only the search " +
  "and document-link behavior actually observed in a discovery probe, never a guessed interface.";

export const PROBE_OBSERVATION_TYPES = Object.freeze([
  "unmapped_path_behavior",
  "search_form",
  "search_submission",
  "bulk_query_probe",
  "document_link_sample",
]);

function requireArray(value, field) {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value;
}

function requireNonEmptyString(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required and must be a non-empty string`);
  return value;
}

/**
 * Validate one probe entry: `{ purpose, fetch, observation }`. `fetch` must
 * be a receipt built by `buildFetchReceipt`; `observation` is a plain,
 * purely descriptive record of what that fetch's response actually
 * contained, tagged with one of PROBE_OBSERVATION_TYPES.
 */
export function validateDiscoveryProbe(probe, label = "probe") {
  const findings = [];
  if (!probe || typeof probe !== "object") {
    findings.push(`${label}: must be an object`);
    return findings;
  }
  if (typeof probe.purpose !== "string" || probe.purpose.trim() === "") {
    findings.push(`${label}: purpose is required`);
  }
  if (!probe.fetch || probe.fetch.schema !== SEQRA_FETCH_RECEIPT_SCHEMA) {
    findings.push(`${label}: fetch must be a receipt built by buildFetchReceipt`);
  }
  if (!probe.observation || typeof probe.observation !== "object") {
    findings.push(`${label}: observation is required`);
  } else if (!PROBE_OBSERVATION_TYPES.includes(probe.observation.type)) {
    findings.push(`${label}: observation.type ${JSON.stringify(probe.observation?.type)} is not one of PROBE_OBSERVATION_TYPES`);
  }
  return findings;
}

/**
 * Summarize the observed search-form shape from every `search_form`
 * observation in the probe set. Returns `status: "not_yet_observed"` (never
 * a guessed shape) when no probe actually captured a search form.
 */
function summarizeSearchInterface(probes) {
  const formObservations = probes.filter((p) => p.observation.type === "search_form").map((p) => p.observation);
  if (formObservations.length === 0) {
    return { status: "not_yet_observed", reason: "no probe in this discovery pass captured a search-page form" };
  }
  const latest = formObservations[formObservations.length - 1];
  return {
    status: "observed",
    method: latest.method,
    action: latest.action,
    requires_postback_tokens: latest.requires_postback_tokens === true,
    postback_token_fields: Object.freeze([...(latest.postback_token_fields ?? [])]),
    input_fields: Object.freeze([...(latest.input_fields ?? [])]),
    select_fields: Object.freeze([...(latest.select_fields ?? [])]),
    submit_field: latest.submit_field ?? null,
    note:
      "A stateful postback form (VIEWSTATE/EVENTVALIDATION minted per GET, replayed on POST) is not a " +
      "stable, cacheable query-string API; a fetcher built on this shape must mint its own tokens per " +
      "search rather than constructing a reusable URL.",
  };
}

/** Summarize what a wide/blank-criteria ("bulk-shaped") search request actually did. */
function summarizeBulkEnumerationAttempt(probes) {
  const bulkObservations = probes.filter((p) => p.observation.type === "bulk_query_probe").map((p) => p.observation);
  if (bulkObservations.length === 0) {
    return { attempted: false, reason: "no bulk-shaped (blank or wide-criteria) search request was attempted in this discovery pass" };
  }
  return {
    attempted: true,
    outcomes: Object.freeze(bulkObservations.map((o) => ({
      criteria_shape: o.criteria_shape,
      outcome: o.outcome,
      result_row_count: o.result_row_count ?? null,
      note: o.note ?? null,
    }))),
    conclusion:
      "A wide or blank-criteria search was not observed to return an enumerable bulk listing of reviews. " +
      "This pipeline treats that as further evidence against an undocumented bulk API, not as proof one " +
      "cannot exist -- a later, narrower discovery pass may observe otherwise.",
  };
}

function summarizeDocumentLinkPattern(probes) {
  const linkObservations = probes.filter((p) => p.observation.type === "document_link_sample").map((p) => p.observation);
  if (linkObservations.length === 0) {
    return {
      status: "not_yet_observed",
      reason:
        "This discovery pass reached the search interface but did not capture a real search result or " +
        "project detail page carrying document links; the document-link URL shape is unknown, not assumed.",
    };
  }
  return {
    status: "observed",
    samples: Object.freeze(linkObservations.map((o) => ({ href_pattern: o.href_pattern, sample_href: o.sample_href, link_text: o.link_text ?? null }))),
  };
}

/**
 * Build the discovery receipt from a set of already-performed, already
 * -validated probes. `generatedAt` must be the wall-clock time the receipt
 * was assembled (not the probe times, which live on each probe's own
 * fetch receipt).
 */
export function buildCeqrAccessDiscoveryReceipt({ generatedAt, probes = [], knownGaps = [] } = {}) {
  requireNonEmptyString(generatedAt, "generatedAt");
  requireArray(probes, "probes");
  const findings = [];
  probes.forEach((probe, index) => findings.push(...validateDiscoveryProbe(probe, `probes[${index}]`)));
  if (findings.length > 0) throw new Error(`invalid discovery probe(s):\n${findings.join("\n")}`);

  return Object.freeze({
    schema: SEQRA_CEQR_ACCESS_DISCOVERY_SCHEMA,
    generated_at: generatedAt,
    source_id: CEQR_ACCESS_SOURCE_ID,
    probe_count: probes.length,
    probes: Object.freeze(probes.map((p) => Object.freeze({ purpose: p.purpose, fetch: p.fetch, observation: Object.freeze({ ...p.observation }) }))),
    search_interface: summarizeSearchInterface(probes),
    bulk_enumeration_probe: summarizeBulkEnumerationAttempt(probes),
    document_link_pattern: summarizeDocumentLinkPattern(probes),
    bulk_api_documented: false,
    negative_rule: CEQR_ACCESS_NO_BULK_API_ASSERTION,
    known_gaps: Object.freeze([...knownGaps]),
  });
}
