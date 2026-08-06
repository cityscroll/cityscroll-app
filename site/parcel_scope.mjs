/**
 * Pure exact-BBL scope and observed-biography helpers.
 *
 * A parcel biography is deliberately a bounded evidence view, not a parcel
 * history. Only typed ten-digit BBLs and the committed exact-BBL
 * materializations can contribute records.
 */

import {
  emptyScope,
  intersectScopes,
  normalizeScope,
  routeHashFromScope,
  scopeWithEntity,
} from "./scope_v0.mjs";
import { decodeTaxLienBbl } from "./tax_lien_cycle_context.mjs";

export const PARCEL_REF_RE = /^bbl:(\d{10})$/;
export const PARCEL_BIOGRAPHY_LABEL = "Observed parcel biography";
export const EXACT_BBL_METHOD = "exact_bbl_v1";

const clean = (value, max = 500) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

const finiteOrNull = (value) => Number.isFinite(Number(value)) ? Number(value) : null;

/** Return a typed parcel ref only for an already-normalized exact BBL. */
export function parcelRef(value) {
  const bbl = clean(value, 40);
  return /^\d{10}$/.test(bbl) ? `bbl:${bbl}` : "";
}

export function parcelBblFromRef(value) {
  return clean(value, 80).match(PARCEL_REF_RE)?.[1] || null;
}

/** Compose one exact parcel constraint through gc-01's scope primitive. */
export function scopeWithParcel(input, bbl) {
  const ref = parcelRef(bbl);
  return ref ? scopeWithEntity(input, ref) : normalizeScope(input);
}

/** Recover the single exact parcel constraint carried by a scope. */
export function parcelBblFromScope(input) {
  const scope = normalizeScope(input);
  const refs = Array.isArray(scope.facets.values.entity_refs_all)
    ? scope.facets.values.entity_refs_all
    : [];
  const parcels = [...new Set(refs.map(parcelBblFromRef).filter(Boolean))];
  return parcels.length === 1 ? parcels[0] : null;
}

/** Canonical property-lens route for a BBL composed with an existing scope. */
export function parcelBiographyHref(bbl, { scope = null, surface = "property" } = {}) {
  const ref = parcelRef(bbl);
  if (!ref) return "";
  const base = scope ? normalizeScope(scope) : emptyScope();
  const parcelOnly = scopeWithParcel(emptyScope(base.language), bbl);
  const composed = intersectScopes(base, parcelOnly);
  return routeHashFromScope(composed, { surface });
}

function exactMaterialization(crossDomain) {
  const methods = crossDomain?.provenance?.methods || [];
  return Array.isArray(methods) && methods.includes(EXACT_BBL_METHOD);
}

function noticeItems(source = []) {
  return (Array.isArray(source) ? source : []).flatMap((notice) => {
    const requestId = clean(notice?.request_id, 80);
    if (!requestId) return [];
    return [{
      id: requestId,
      subject_ref: `notice:${requestId}`,
      label: clean(notice.label || requestId),
      date: clean(notice.when || notice.date, 40) || null,
      date_basis: clean(notice.date_basis || "City Record event/start date", 100),
      source: "City Record Online",
      relation: "sits_on_parcel",
      confidence: "strong",
      method: EXACT_BBL_METHOD,
      href: `#notice/${encodeURIComponent(requestId)}`,
    }];
  });
}

function landItems(source = []) {
  return (Array.isArray(source) ? source : []).flatMap((project) => {
    const projectId = clean(project?.project_id, 80);
    if (!projectId) return [];
    return [{
      id: projectId,
      subject_ref: `project:${projectId}`,
      label: clean(project.label || project.project_name || projectId),
      date: clean(project.when || project.date, 40) || null,
      date_basis: clean(project.date_basis, 100) || null,
      source: "ZAP / zap-bbl",
      relation: "sits_on_parcel",
      confidence: "strong",
      method: EXACT_BBL_METHOD,
      status: clean(project.public_status, 100) || null,
      href: `#land?project=${encodeURIComponent(projectId)}`,
    }];
  });
}

function ll48Items(source = []) {
  return (Array.isArray(source) ? source : []).flatMap((item) => item?.bbl ? [{
    id: clean(item.id || item.bbl, 80),
    subject_ref: `bbl:${item.bbl}`,
    label: clean(item.label || item.parcel_name || item.address || item.bbl),
    date: clean(item.observed_at, 40) || null,
    date_basis: "LL48 source observation",
    source: "NYC Open Data · LL48 suitability",
    relation: "suitability_record_for_exact_bbl",
    confidence: "strong",
    method: "exact_bbl_v1",
    href: parcelBiographyHref(item.bbl),
    agency: clean(item.agency) || null,
    current_uses: clean(item.current_uses) || null,
    potential_urban_ag: clean(item.potential_urban_ag) || null,
  }] : []);
}

function coverageBlock({ eligible = null, linked = null, rate = null, vintage = null, gaps }) {
  return {
    eligible: finiteOrNull(eligible),
    linked: finiteOrNull(linked),
    rate: finiteOrNull(rate),
    vintage: clean(vintage, 40) || null,
    gaps: clean(gaps, 500),
  };
}

function cofoItems(cofo, bbl) {
  return (cofo?.by_bbl?.[bbl] || []).map((row) => ({
    id: clean(row.job_number),
    label: clean(row.issue_type || row.job_type || row.job_number),
    date: clean(row.c_o_issue_date, 40) || null,
    date_basis: "CofO issue date",
    source: "NYC Department of Buildings",
    relation: "legal_occupancy_on_parcel",
    confidence: "strong",
    method: cofo.method || "exact_bbl_v1",
    issue_type: clean(row.issue_type, 80) || null,
    application_status: clean(row.application_status_raw, 80) || null,
    filing_status: clean(row.filing_status_raw, 80) || null,
    conflicts: Array.isArray(row.conflicts) ? row.conflicts : [],
    href: parcelBiographyHref(bbl),
  }));
}

/**
 * Assemble one bounded observed biography from committed materializations.
 * Owner/counterparty candidates are intentionally absent: current measured
 * public coverage is zero, and tentative ER output cannot render as fact.
 */
export function buildObservedParcelBiography({ bbl, crossDomain, taxLien, cofo } = {}) {
  const ref = parcelRef(bbl);
  if (!ref) return { ok: false, reason: "invalid_bbl" };
  if (!exactMaterialization(crossDomain)) {
    return { ok: false, reason: "unverified_join_method", bbl, parcel_ref: ref };
  }

  const demo = crossDomain?.demos?.[bbl];
  const bucket = crossDomain?.by_bbl?.[bbl];
  const parcel = demo?.ok ? demo : bucket;
  if (!parcel || parcel.bbl !== bbl || parcel.parcel_ref !== ref) {
    return { ok: false, reason: "not_observed", bbl, parcel_ref: ref };
  }

  const propertySource = demo?.property?.notices || bucket?.property_notices || [];
  const landSource = demo?.land?.projects || bucket?.land_projects || [];
  const ll48Source = demo?.ll48?.items || bucket?.ll48?.items || [];
  const property = noticeItems(propertySource);
  const land = landItems(landSource);
  const lien = decodeTaxLienBbl(taxLien, bbl);
  const coverage = crossDomain?.coverage || {};
  const generatedAt = crossDomain?.generated_at || null;
  const propertyVintage = crossDomain?.provenance?.property_feed?.source_generated_at || generatedAt;

  const sections = {
    property: {
      status: property.length ? "observed" : "not_observed",
      items: property,
      note: property.length
        ? null
        : "No Property Disposition notice lists this parcel in the available records.",
      coverage: coverageBlock({
        eligible: coverage.property_observation_count,
        linked: coverage.property_rows_with_bbl,
        rate: coverage.fraction_observations_with_bbl,
        vintage: propertyVintage,
        gaps: "Only observed City Record Property Disposition rows in the current snapshot are eligible.",
      }),
    },
    land: {
      status: land.length ? "observed" : "not_observed",
      items: land,
      note: land.length
        ? null
        : "No ZAP project is listed for this parcel in the available records.",
      coverage: coverageBlock({
        eligible: coverage.by_bbl_count,
        linked: coverage.zap_matched_bbl_count,
        rate: coverage.zap_matched_fraction,
        vintage: generatedAt,
        gaps: "Only projects represented in the current zap-bbl catalog can join; address and name similarity are excluded.",
      }),
    },
    ll48: {
      status: ll48Source.length ? "observed" : "not_observed",
      items: ll48Items(ll48Source),
      note: ll48Source.length
        ? null
        : "No LL48 suitability row in the current exact-BBL graph slice.",
      coverage: coverageBlock({
        eligible: coverage.ll48_eligible_bbl_count,
        linked: coverage.ll48_linked_bbl_count,
        rate: coverage.ll48_bbl_join_rate,
        vintage: coverage.ll48_vintage || generatedAt,
        gaps: "Only exact BBLs in the current Property Disposition graph slice are eligible; absence is not proof of no LL48 record citywide.",
      }),
    },
    tax_lien: {
      status: lien ? "observed" : "not_observed",
      items: lien ? [{
        id: `${taxLien.cycle_id || "cycle"}:${bbl}`,
        subject_ref: ref,
        label: clean(lien.stage || "published list"),
        date: clean(taxLien.data_vintage, 40) || null,
        date_basis: "DOF list data vintage",
        source: "NYC Department of Finance",
        relation: "appeared_on_published_list",
        confidence: "strong",
        method: "exact_bbl_lookup",
        stage: clean(lien.stage, 40) || null,
        outcome: clean(lien.outcome, 80) || null,
        nta_name: clean(lien.nta_name, 160) || null,
        href: parcelBiographyHref(bbl),
      }] : [],
      note: lien
        ? null
        : "This parcel is not listed in the available tax-lien record for this cycle.",
      coverage: coverageBlock({
        eligible: Object.keys(taxLien?.rows || {}).length,
        linked: lien ? 1 : 0,
        rate: null,
        vintage: taxLien?.data_vintage,
        gaps: "This is one published cycle snapshot; it does not track the parcel between lists or across every cycle.",
      }),
    },
    cofo: {
      status: cofoItems(cofo, bbl).length ? "observed" : "not_observed",
      items: cofoItems(cofo, bbl),
      note: cofoItems(cofo, bbl).length
        ? null
        : "No Certificate of Occupancy is listed for this parcel in the available records.",
      coverage: coverageBlock({
        eligible: cofo?.coverage?.eligible,
        linked: cofo?.coverage?.linked,
        rate: cofo?.coverage?.rate,
        vintage: cofo?.source_generated_at,
        gaps: cofo?.coverage?.gap || "Only exact BBLs already present in the committed parcel graph are eligible.",
      }),
    },
  };

  return {
    ok: true,
    schema_version: 1,
    label: PARCEL_BIOGRAPHY_LABEL,
    bbl,
    parcel_ref: ref,
    method: EXACT_BBL_METHOD,
    observed_only: true,
    sections,
  };
}
