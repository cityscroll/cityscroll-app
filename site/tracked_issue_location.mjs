/**
 * Exact location and bounded property coverage for tracked issues.
 *
 * A tracked issue keeps one curated street address. This module resolves that
 * address through the committed NYC DCP Property Address Directory (PAD)
 * snapshot — via `site/precomputed_address_geocoder.mjs` — and retains the
 * exact-match evidence (method, PAD version, snapshot date, address, BBL).
 * Only an exact match may link the canonical parcel route; ambiguity or an
 * unresolved address suppresses the link.
 *
 * Property observations are reported per bounded dataset, each with its own
 * name and checked-through date. A missing observation inside one bounded
 * lookup is never translated into a claim about permits, violations,
 * certificates, or building records the lookup does not cover.
 */

import { ABSENCE_REASONS } from "./edge_summary.mjs";
import { bblReaderLabel } from "./bbl_reader.mjs";
import { parcelRef } from "./parcel_scope.mjs";

export const TRACKED_ISSUE_LOCATION_SCHEMA = "cityscroll.tracked_issue_location.v1";
export const TRACKED_ISSUE_COVERAGE_SCHEMA = "cityscroll.tracked_issue_coverage.v1";

/** Geocode methods that may carry an exact-parcel link. Closed set. */
export const EXACT_PARCEL_GEOCODE_METHODS = Object.freeze(["nyc_dcp_pad_snapshot"]);

/** Resident-facing coverage states for one bounded dataset lookup. */
export const TRACKED_ISSUE_COVERAGE_STATES = Object.freeze([
  "observed",
  "absent_bounded",
  "stale",
  "unavailable",
  "unsearched",
]);

const UNRESOLVED_COPY = Object.freeze({
  ambiguous: "This address matches more than one parcel in the current property address directory, so no single parcel is linked here.",
  not_covered: "This address is not in the portion of the property address directory this site holds, so no parcel is linked here.",
  not_full_address: "This address is not complete enough to match against the property address directory, so no parcel is linked here.",
  snapshot_unavailable: "The property address directory could not be checked just now, so no parcel is linked here. Reload this page to retry.",
});

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));

const clean = (value, max = 300) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

const validBbl = (value) => (/^\d{10}$/.test(clean(value, 12)) ? clean(value, 12) : null);

const validInstant = (value) => {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(text)) return null;
  const epoch = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(text) || !/T/.test(text) ? text : `${text}Z`);
  return Number.isFinite(epoch) && epoch > 0 ? new Date(epoch).toISOString() : null;
};

const DAY_MS = 86_400_000;

function formatThroughDate(iso) {
  const instant = validInstant(iso);
  if (!instant) return "";
  return new Date(instant).toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric", timeZone: "UTC",
  });
}

/** Canonical parcel document route (same contract as composed_object_documents.parcelPath). */
export function canonicalParcelRoute(bbl) {
  const digits = validBbl(bbl);
  return digits ? `/parcels/${encodeURIComponent(digits)}/` : "";
}

/**
 * Retain the exact address-to-parcel evidence for one curated issue address.
 * `geocode` is a result from `resolveAddressFromShard` /
 * `createPrecomputedAddressGeocoder`. The parcel link is emitted only when the
 * geocode is an exact PAD-snapshot match with a valid BBL; every other outcome
 * keeps the address and an honest unresolved reason instead.
 */
export function buildTrackedIssueLocation({ address, geocode, parcelHref = null } = {}) {
  const curated = clean(address, 200);
  const status = clean(geocode?.status, 30) || "unknown";
  const method = clean(geocode?.method, 60) || null;
  const exact = status === "matched"
    && EXACT_PARCEL_GEOCODE_METHODS.includes(method)
    && Boolean(validBbl(geocode?.bbl));
  if (!exact) {
    const reason = status === "matched" ? "non_exact_method" : (clean(geocode?.reason, 40) || "unresolved");
    return {
      schema: TRACKED_ISSUE_LOCATION_SCHEMA,
      ok: true,
      address: curated,
      geocode_status: status === "matched" ? "matched" : "unknown",
      exact: false,
      parcel: null,
      unresolved_reason: reason,
      unresolved_copy: UNRESOLVED_COPY[reason] || UNRESOLVED_COPY.not_covered,
      method,
      source_version: null,
      snapshot_date: null,
    };
  }
  const bbl = validBbl(geocode.bbl);
  return {
    schema: TRACKED_ISSUE_LOCATION_SCHEMA,
    ok: true,
    address: curated,
    geocode_status: "matched",
    exact: true,
    unresolved_reason: null,
    unresolved_copy: null,
    resolved_label: clean(geocode.label, 200) || curated,
    bbl,
    borough: clean(geocode.borough, 40) || null,
    zip: clean(geocode.zip, 10) || null,
    method,
    source_version: clean(geocode.source_version, 40) || null,
    snapshot_date: validInstant(geocode.data_as_of),
    parcel: {
      bbl,
      subject_ref: parcelRef(bbl),
      href: clean(parcelHref, 300) || canonicalParcelRoute(bbl),
      label: bblReaderLabel(bbl) || `Parcel ${bbl}`,
    },
  };
}

/**
 * Bounded dataset register. `max_stale_days` mirrors the committed source
 * contracts (`city-record`, `dob-certificate-of-occupancy` in
 * site/data/source_contracts.json); the copy owns the reader-facing dataset
 * names, never implementation field names.
 */
export const TRACKED_ISSUE_COVERAGE_DATASETS = Object.freeze({
  property_disposition: Object.freeze({
    id: "property_disposition",
    name: "City Record property disposition notices",
    owner: "NYC Department of Citywide Administrative Services",
    record_noun: "property disposition notices",
    max_stale_days: 7,
    official_href: "https://a856-cityrecord.nyc.gov/",
    bounded_line: "This check covers property disposition notices for parcels this site already carries in its property catalog.",
  }),
  certificate_of_occupancy: Object.freeze({
    id: "certificate_of_occupancy",
    name: "DOB Certificate of Occupancy",
    owner: "NYC Department of Buildings",
    record_noun: "certificate of occupancy records",
    max_stale_days: 30,
    official_href: "https://data.cityofnewyork.us/d/bs8b-p36w",
    bounded_line: "This check covers certificate rows for parcels this site already carries in its property catalog.",
  }),
});

const ENVELOPE_KEYS = new Set(["payload", "unavailable", "unsearched"]);

function datasetEnvelope(value) {
  if (value == null) return { mode: "unsearched", payload: null };
  if (typeof value !== "object") return { mode: "unsearched", payload: null };
  const keys = Object.keys(value);
  if (keys.some((key) => ENVELOPE_KEYS.has(key))) {
    if (value.unavailable === true) return { mode: "unavailable", payload: null };
    if (value.payload == null) return { mode: "unsearched", payload: null };
    return { mode: "searched", payload: value.payload };
  }
  return { mode: "searched", payload: value };
}

function propertyObservations(payload, bbl) {
  if (!payload || typeof payload !== "object") return { count: 0, through: null };
  const demo = payload.demos?.[bbl];
  const bucket = payload.by_bbl?.[bbl];
  const parcel = demo?.ok ? demo : bucket;
  const notices = demo?.property?.notices || bucket?.property_notices || [];
  const through = validInstant(payload?.provenance?.property_feed?.source_generated_at)
    || validInstant(payload?.generated_at);
  return {
    count: parcel && Array.isArray(notices) ? notices.length : 0,
    through,
    in_slice: Boolean(parcel),
  };
}

function cofoObservations(payload, bbl) {
  if (!payload || typeof payload !== "object") return { count: 0, through: null };
  const rows = payload.by_bbl?.[bbl];
  return {
    count: Array.isArray(rows) ? rows.length : 0,
    through: validInstant(payload?.source_generated_at),
    in_slice: Array.isArray(rows),
  };
}

function coverageEntry(dataset, envelope, observations, now) {
  const base = {
    dataset_id: dataset.id,
    dataset_name: dataset.name,
    dataset_owner: dataset.owner,
    dataset_record_noun: dataset.record_noun,
    max_stale_days: dataset.max_stale_days,
    official_href: dataset.official_href,
    through_date: null,
    stale: false,
    observation_count: null,
    in_bounded_slice: null,
    absence_reason: null,
    copy: "",
  };
  if (envelope.mode === "unsearched") {
    return { ...base, state: "unsearched", absence_reason: ABSENCE_REASONS.UNSEARCHED };
  }
  if (envelope.mode === "unavailable") {
    return { ...base, state: "unavailable", absence_reason: ABSENCE_REASONS.RETRIEVAL_FAILURE };
  }
  const through = observations.through;
  const nowInstant = validInstant(now);
  const stale = Boolean(through && nowInstant && Date.parse(nowInstant) - Date.parse(through) > dataset.max_stale_days * DAY_MS);
  const observed = observations.count > 0;
  const state = stale ? "stale" : (observed ? "observed" : "absent_bounded");
  return {
    ...base,
    state,
    through_date: through,
    stale,
    observation_count: observations.count,
    in_bounded_slice: observations.in_slice,
    absence_reason: observed ? null : ABSENCE_REASONS.CHECKED_NO_RECORD,
  };
}

/**
 * Build source-specific checked-through coverage for the bounded property and
 * certificate-of-occupancy lookups. Each dataset is passed either as a raw
 * committed payload (`crossDomain` / `cofo`), as an explicit envelope
 * (`{ payload }`, `{ unavailable: true }`, `{ unsearched: true }`), or omitted
 * entirely — omitted means not checked yet, never "no records exist".
 */
export function buildTrackedIssueCoverage({
  bbl,
  property = null,
  certificateOfOccupancy = null,
  crossDomain = null,
  cofo = null,
  now = null,
} = {}) {
  const digits = validBbl(bbl);
  if (!digits) return { schema: TRACKED_ISSUE_COVERAGE_SCHEMA, ok: false, reason: "invalid_bbl", datasets: [] };
  const propertyInput = property ?? crossDomain;
  const cofoInput = certificateOfOccupancy ?? cofo;
  const propertyEnvelope = datasetEnvelope(propertyInput);
  const cofoEnvelope = datasetEnvelope(cofoInput);
  const datasets = [
    coverageEntry(
      TRACKED_ISSUE_COVERAGE_DATASETS.property_disposition,
      propertyEnvelope,
      propertyObservations(propertyEnvelope.payload, digits),
      now,
    ),
    coverageEntry(
      TRACKED_ISSUE_COVERAGE_DATASETS.certificate_of_occupancy,
      cofoEnvelope,
      cofoObservations(cofoEnvelope.payload, digits),
      now,
    ),
  ];
  return {
    schema: TRACKED_ISSUE_COVERAGE_SCHEMA,
    ok: true,
    bbl: digits,
    now: validInstant(now),
    datasets: datasets.map((entry) => ({ ...entry, copy: trackedIssueCoverageCopy(entry) })),
  };
}

/**
 * Resident copy for one coverage entry. Every state names its dataset; only a
 * fresh searched lookup may state a checked-through date; no state ever
 * generalizes a bounded absence to permits, violations, certificates, or
 * building records at large.
 */
export function trackedIssueCoverageCopy(entry) {
  const name = entry.dataset_name || "This dataset";
  const through = formatThroughDate(entry.through_date);
  if (entry.state === "unsearched") {
    return `${name} has not been checked for this parcel yet.`;
  }
  if (entry.state === "unavailable") {
    return `${name} could not be checked just now. This page has verified nothing from it for this parcel. Reload this page to retry, or open the official source.`;
  }
  if (entry.state === "stale") {
    const staleLead = `${name}: last refreshed ${through}, past the ${entry.max_stale_days}-day freshness this site aims for. Nothing after ${through} is verified here.`;
    if (entry.observation_count > 0) {
      return `${staleLead} ${entry.observation_count} records for this parcel appear as of that refresh.`;
    }
    return `${staleLead} This parcel has no entry in that refresh, and the age of the data means that may not reflect the source today.`;
  }
  if (entry.observation_count > 0) {
    return through
      ? `${name}: ${entry.observation_count} records for this parcel, checked through ${through}.`
      : `${name}: ${entry.observation_count} records for this parcel in the records this site holds.`;
  }
  if (!through) {
    return `${name}: the records this site holds name no refresh date; this parcel has no entry in them. A missing entry here is not a finding about any other city record.`;
  }
  const dataset = Object.values(TRACKED_ISSUE_COVERAGE_DATASETS).find((item) => item.id === entry.dataset_id);
  const bounded = dataset?.bounded_line || "";
  return `Checked ${name} through ${through}: this parcel has no entry in the records this site holds. ${bounded} A missing entry here is not a finding about any other city record.`;
}

function coverageDisclosure(entry) {
  const rows = [];
  if (entry.through_date) rows.push(`Checked through ${esc(formatThroughDate(entry.through_date))} (dataset refresh date).`);
  if (entry.observation_count != null) rows.push(`Rows listed for this parcel: ${entry.observation_count}.`);
  rows.push(`Publisher: ${esc(entry.dataset_owner)}.`);
  return `<details class="tracked-issue-coverage-provenance"><summary>Sources and coverage</summary><p>${rows.join(" ")}</p><p><a class="tracked-issue-coverage-source" href="${esc(entry.official_href)}" rel="noopener">Open the official source<span class="sr-only"> for ${esc(entry.dataset_name)}</span></a></p></details>`;
}

function coverageItemHTML(entry) {
  const stateLabel = entry.state === "observed"
    ? "Listed"
    : entry.state === "absent_bounded"
      ? "Checked; not listed"
      : entry.state === "stale"
        ? "Checked; refresh is old"
        : entry.state === "unavailable"
          ? "Could not be checked"
          : "Not yet checked";
  return `<li class="tracked-issue-coverage-item" data-coverage-dataset="${esc(entry.dataset_id)}" data-coverage-state="${esc(entry.state)}"${entry.absence_reason ? ` data-absence-reason="${esc(entry.absence_reason)}"` : ""}>
    <h3 class="tracked-issue-coverage-name">${esc(entry.dataset_name)}</h3>
    <p class="tracked-issue-coverage-state">${esc(stateLabel)}</p>
    <p class="tracked-issue-coverage-copy">${esc(entry.copy)}</p>
    ${coverageDisclosure(entry)}
  </li>`;
}

function locationHTML(location) {
  if (!location?.ok) return "";
  const provenance = location.exact
    ? `<details class="tracked-issue-location-provenance"><summary>Parcel match method</summary><p>Matched against the NYC Department of City Planning Property Address Directory (PAD), version ${esc(location.source_version)}, snapshot taken ${esc(formatThroughDate(location.snapshot_date))}.</p></details>`
    : "";
  const body = location.exact
    ? `<p class="tracked-issue-address">${esc(location.resolved_label || location.address)}</p>
      <p class="tracked-issue-parcel"><a class="tracked-issue-parcel-link" href="${esc(location.parcel.href)}" data-subject-ref="${esc(location.parcel.subject_ref)}">${esc(location.parcel.label)}</a></p>
      ${provenance}`
    : `<p class="tracked-issue-address">${esc(location.address)}</p>
      <p class="tracked-issue-unresolved">${esc(location.unresolved_copy)}</p>`;
  return `<section class="tracked-issue-location" data-tracked-issue-location="1" data-location-state="${location.exact ? "exact" : esc(location.unresolved_reason || "unresolved")}">
    <h2 class="tracked-issue-location-heading">Location and parcel</h2>
    ${body}
  </section>`;
}

function coverageHTML(coverage) {
  if (!coverage?.ok || !coverage.datasets.length) return "";
  return `<section class="tracked-issue-coverage" data-tracked-issue-coverage="1">
    <h2 class="tracked-issue-coverage-heading">Property records checked for this parcel</h2>
    <ul class="tracked-issue-coverage-list">${coverage.datasets.map(coverageItemHTML).join("")}</ul>
    <p class="tracked-issue-coverage-scope">Each line above describes only the dataset it names. Other city records about this parcel are separate and are not judged here.</p>
  </section>`;
}

/**
 * Static-first resident rendering: the civic fact (address, parcel link, or an
 * honest unresolved line) and per-dataset coverage are server-renderable HTML
 * with no script dependency; provenance sits behind optional disclosures.
 */
export function renderTrackedIssueLocationHTML(location, coverage = null) {
  return `${locationHTML(location)}${coverageHTML(coverage)}`;
}
