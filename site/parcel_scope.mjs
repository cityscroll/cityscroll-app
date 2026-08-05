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

function coverageBlock({ eligible = null, linked = null, rate = null, vintage = null, gaps }) {
  return {
    eligible: finiteOrNull(eligible),
    linked: finiteOrNull(linked),
    rate: finiteOrNull(rate),
    vintage: clean(vintage, 40) || null,
    gaps: clean(gaps, 500),
  };
}

/**
 * Assemble one bounded observed biography from committed materializations.
 * Owner/counterparty candidates are intentionally absent: current measured
 * public coverage is zero, and tentative ER output cannot render as fact.
 */
export function buildObservedParcelBiography({ bbl, crossDomain, taxLien } = {}) {
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
        : "No Property Disposition notice in the current catalog carries this exact BBL.",
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
        : "No ZAP project in the linked corpus shares this exact BBL — not proof no land-use application exists citywide.",
      coverage: coverageBlock({
        eligible: coverage.by_bbl_count,
        linked: coverage.zap_matched_bbl_count,
        rate: coverage.zap_matched_fraction,
        vintage: generatedAt,
        gaps: "Only projects represented in the current zap-bbl catalog can join; address and name similarity are excluded.",
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
        : "This exact BBL was not observed in the published cycle snapshot — not proof it never appeared on another list.",
      coverage: coverageBlock({
        eligible: Object.keys(taxLien?.rows || {}).length,
        linked: lien ? 1 : 0,
        rate: null,
        vintage: taxLien?.data_vintage,
        gaps: "This is one published cycle snapshot; it does not track the parcel between lists or across every cycle.",
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
