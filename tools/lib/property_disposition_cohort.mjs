/**
 * Exact-parcel Property disposition cohort evidence.
 *
 * This module deliberately consumes only materialized BBLs, stage labels, and
 * publication dates. It never compares addresses or titles and never emits a
 * duration summary or forecast below the declared sample floor.
 */

import { normalizeBbl } from "../../entity_resolution/cross_domain/property_links.mjs";

export const PROPERTY_DISPOSITION_COHORT_SCHEMA_VERSION = 1;
export const PROPERTY_DISPOSITION_COHORT_VERSION = "property_disposition_exact_bbl_v1";
export const PROPERTY_DISPOSITION_COHORT_MINIMUM_SAMPLE = 20;

const DAY_MS = 86_400_000;
const HEARING = "hearing";
const AUCTION = "auction_or_rfp";

function day(value) {
  const raw = String(value || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const parsed = Date.parse(`${raw}T00:00:00Z`);
  return Number.isFinite(parsed) ? raw : null;
}

function intervalDays(from, to) {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS,
  );
}

function exactCrossDomainIndex(crossDomain = {}) {
  const index = new Map();
  for (const [rawBbl, entry] of Object.entries(crossDomain.by_bbl || {})) {
    const bbl = normalizeBbl(rawBbl);
    if (!bbl || normalizeBbl(entry?.bbl) !== bbl) continue;
    const requestIds = new Set(
      (entry.property_notices || [])
        .map((notice) => String(notice?.request_id || "").trim())
        .filter(Boolean),
    );
    index.set(bbl, requestIds);
  }
  return index;
}

function rowsByExactBbl(observations = {}, crossDomain = {}) {
  const corroborated = exactCrossDomainIndex(crossDomain);
  const groups = new Map();
  for (const row of observations.property_rows || []) {
    const requestId = String(row?.request_id || "").trim();
    const stage = String(row?.disposition_stage || "").trim();
    const publishedDate = day(row?.start_date);
    if (!requestId || !publishedDate || ![HEARING, AUCTION].includes(stage)) continue;

    const bbls = new Set(
      (row?.property_location?.bbls || []).map(normalizeBbl).filter(Boolean),
    );
    for (const bbl of bbls) {
      // Both committed inputs must independently place this request on the
      // same exact normalized parcel. No text field participates in the join.
      if (!corroborated.get(bbl)?.has(requestId)) continue;
      const members = groups.get(bbl) || [];
      members.push({
        request_id: requestId,
        stage,
        date: publishedDate,
        agency_name: row.agency_name || null,
      });
      groups.set(bbl, members);
    }
  }
  return groups;
}

export function buildPropertyDispositionCohort(
  observations = {},
  crossDomain = {},
  options = {},
) {
  const minimumSample = Number.isInteger(options.minimumSample)
    ? options.minimumSample
    : PROPERTY_DISPOSITION_COHORT_MINIMUM_SAMPLE;
  if (minimumSample < 1) throw new RangeError("minimumSample must be a positive integer");

  const pairs = [];
  const groups = rowsByExactBbl(observations, crossDomain);
  for (const [bbl, members] of groups) {
    const hearings = members.filter((row) => row.stage === HEARING);
    const auctions = members.filter((row) => row.stage === AUCTION);
    for (const hearing of hearings) {
      for (const auction of auctions) {
        if (auction.date <= hearing.date) continue;
        pairs.push({
          pair_id: `property-disposition:${bbl}:${hearing.request_id}:${auction.request_id}`,
          bbl,
          hearing: {
            request_id: hearing.request_id,
            date: hearing.date,
            date_basis: "start_date",
          },
          auction_or_rfp: {
            request_id: auction.request_id,
            date: auction.date,
            date_basis: "start_date",
          },
          interval_days: intervalDays(hearing.date, auction.date),
          provenance: {
            join_method: "exact_normalized_bbl",
            join_key: `bbl:${bbl}`,
            source_system: "city_record",
            source_record_ids: [
              `city_record:${hearing.request_id}`,
              `city_record:${auction.request_id}`,
            ],
            source_fields: [
              "property_location.bbls",
              "disposition_stage",
              "start_date",
            ],
            corroborating_artifact: "site/data/property_cross_domain_lookup.json#by_bbl",
            text_match_used: false,
          },
        });
      }
    }
  }
  pairs.sort(
    (left, right) => left.bbl.localeCompare(right.bbl)
      || left.hearing.date.localeCompare(right.hearing.date)
      || left.hearing.request_id.localeCompare(right.hearing.request_id)
      || left.auction_or_rfp.request_id.localeCompare(right.auction_or_rfp.request_id),
  );

  const n = pairs.length;
  const eligible = n >= minimumSample;
  const generatedAt = options.generatedAt || [observations.generated_at, crossDomain.generated_at]
    .filter(Boolean)
    .sort()
    .at(-1)
    || null;
  return {
    schema_version: PROPERTY_DISPOSITION_COHORT_SCHEMA_VERSION,
    version: PROPERTY_DISPOSITION_COHORT_VERSION,
    generated_at: generatedAt,
    sources: {
      observations: {
        artifact: "site/data/property_domain_observations.json",
        version: observations.version || null,
        generated_at: observations.generated_at || null,
        property_count: observations.property_count ?? (observations.property_rows || []).length,
      },
      cross_domain: {
        artifact: "site/data/property_cross_domain_lookup.json",
        version: crossDomain.version || null,
        generated_at: crossDomain.generated_at || null,
      },
    },
    cohort: {
      unit: "exact_normalized_bbl_hearing_to_later_auction_or_rfp",
      date_basis: "city_record_start_date",
      join_method: "exact_normalized_bbl",
      text_match_used: false,
      exact_bbl_groups_considered: groups.size,
      n,
      pairs,
    },
    eligibility: {
      minimum_sample: minimumSample,
      observed_pairs: n,
      status: eligible ? "eligible" : "insufficient_sample",
      label: eligible
        ? `n=${n} meets the minimum sample for a duration model`
        : `n=${n} — insufficient for a duration model`,
      duration_summary_eligible: eligible,
      forecast_eligible: eligible,
    },
    duration_summary: null,
    forecast: null,
  };
}

export function propertyDispositionCohortReceipt(cohort = {}) {
  const eligibility = cohort.eligibility || {};
  return {
    schema_version: 1,
    observed_at: String(cohort.generated_at || "").slice(0, 10) || null,
    artifact: "site/data/property_disposition_cohort.json",
    join_method: cohort.cohort?.join_method || "exact_normalized_bbl",
    text_match_used: cohort.cohort?.text_match_used ?? false,
    n: cohort.cohort?.n ?? 0,
    minimum_sample: eligibility.minimum_sample ?? PROPERTY_DISPOSITION_COHORT_MINIMUM_SAMPLE,
    status: eligibility.status || "insufficient_sample",
    label: eligibility.label || "insufficient for a duration model",
    duration_summary_eligible: eligibility.duration_summary_eligible ?? false,
    forecast_eligible: eligibility.forecast_eligible ?? false,
    pairs: (cohort.cohort?.pairs || []).map((pair) => ({
      bbl: pair.bbl,
      hearing_request_id: pair.hearing.request_id,
      hearing_date: pair.hearing.date,
      auction_or_rfp_request_id: pair.auction_or_rfp.request_id,
      auction_or_rfp_date: pair.auction_or_rfp.date,
      interval_days: pair.interval_days,
    })),
  };
}
