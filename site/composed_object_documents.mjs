/** Static-first documents for monitor packs and district digests. */

import { nearYouUrlFromScope, scopeFromLensState } from "./scope_v0.mjs";
import { followingUrlFromWatch } from "./following_view.mjs";
import { normalizeWatchTemplateRegistry } from "./watch_templates.mjs";
import { renderCivicDocumentAssets, renderCivicDocumentMast } from "./civic_document_chrome.mjs";
import { buildObservedParcelBiography, parcelBiographyHref, parcelRef } from "./parcel_scope.mjs";
import { bblReaderLabel } from "./bbl_reader.mjs";

export const CIVIC_OBJECT_EXPORT_REGISTRY = Object.freeze({
  "monitor-pack": Object.freeze({ classes: Object.freeze(["object_identity", "object_actions", "object_members", "object_provenance"]) }),
  "district-digest": Object.freeze({ classes: Object.freeze(["object_identity", "object_actions", "object_members", "object_provenance"]) }),
  parcel: Object.freeze({ classes: Object.freeze(["object_identity", "object_actions", "object_members", "object_provenance"]) }),
});

const esc = (value) => String(value ?? "").replace(/[<>&"']/g, (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[char]));
const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

export function normalizePackId(value) {
  const id = clean(value).toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,79}$/.test(id) ? id : null;
}

export function normalizeCouncilDistrict(value) {
  const id = clean(value);
  return /^(?:[1-9]|[1-4]\d|5[01])$/.test(id) ? id : null;
}

export function monitorPackPath(id) {
  const normalized = normalizePackId(id);
  return normalized ? `/following/packs/${encodeURIComponent(normalized)}/` : "/following/packs/";
}

export function districtDigestPath(id) {
  const normalized = normalizeCouncilDistrict(id);
  return normalized ? `/districts/council/${normalized}/digest/` : "/districts/";
}

export function monitorPackSubjectRef(id) {
  const normalized = normalizePackId(id);
  return normalized ? `monitor-pack:${normalized}` : null;
}

export function districtDigestSubjectRef(id) {
  const normalized = normalizeCouncilDistrict(id);
  return normalized ? `district-digest:council-${normalized}` : null;
}

export function parcelPath(bbl) {
  return /^\d{10}$/.test(clean(bbl)) ? `/parcels/${encodeURIComponent(clean(bbl))}/` : "/parcels/";
}

export function parcelSubjectRef(bbl) {
  return parcelRef(bbl) || null;
}

export function buildParcelBiographyView({ bbl, crossDomain, taxLien, cofo } = {}) {
  const view = buildObservedParcelBiography({ bbl, crossDomain, taxLien, cofo });
  if (!view.ok) return null;
  return { ...view, kind: "parcel", id: view.bbl, path: parcelPath(view.bbl), subject_ref: view.parcel_ref };
}

function parcelSectionLabel(kind) {
  return kind === "cofo"
    ? "Certificates of Occupancy"
    : kind === "ll48"
      ? "City-owned or leased property suitability"
      : kind === "tax_lien"
        ? "Tax-lien lists"
        : kind === "property"
          ? "Property dispositions"
          : "Land projects";
}

export function districtPivotHref(id) {
  const normalized = normalizeCouncilDistrict(id);
  if (!normalized) return "/near-you/";
  return nearYouUrlFromScope(scopeFromLensState("district", { councilDistrict: normalized }), { base: "/near-you/" });
}

function subjectHref(ref) {
  const value = clean(ref);
  const match = value.match(/^([a-z-]+):(.+)$/);
  if (!match || /\s/.test(value)) return null;
  const [, kind, id] = match;
  if (kind === "exam" && /^\d{4}$/.test(id)) return `/exams/${encodeURIComponent(id)}/`;
  if (kind === "notice" && /^[A-Za-z0-9_-]{1,80}$/.test(id)) return `/notices/${encodeURIComponent(id)}`;
  if (kind === "project" && /^[A-Za-z0-9_-]{3,30}$/.test(id)) return `/#land?project=${encodeURIComponent(id)}`;
  if (kind === "bbl" && /^\d{10}$/.test(id)) return parcelPath(id);
  return null;
}

export function buildMonitorPackView(registry, id) {
  const pack = normalizeWatchTemplateRegistry(registry).templates.find((item) => item.id === normalizePackId(id));
  if (!pack) return null;
  return {
    schema: "cityscroll.monitor_pack.v1", kind: "monitor-pack", id: pack.id,
    subject_ref: monitorPackSubjectRef(pack.id), path: monitorPackPath(pack.id),
    title: pack.title, description: pack.description, serves: pack.serves,
    watches: pack.watches.map((watch) => ({ ...watch, subject_refs: (watch.filter.subject_refs_all || []).filter((ref) => subjectHref(ref)) })),
  };
}

export function buildDistrictDigestView(payload, id) {
  const district = normalizeCouncilDistrict(id);
  const record = district && payload?.schema === "district_weekly_digests.v1" ? payload.by_council_district?.[district] : null;
  if (!record) return null;
  const sections = (payload.sections || []).map((section) => ({ ...section, items: (record.items || []).filter((item) => item.district_section === section.id) })).filter((section) => section.items.length);
  return {
    schema: "cityscroll.district_digest.v1", kind: "district-digest", id: district,
    subject_ref: districtDigestSubjectRef(district), path: districtDigestPath(district), council_district: district,
    boundary_vintage: payload.boundary_vintage || null, built_at: payload.built_at || null,
    total: Number(record.total) || 0, sections, pivot_href: districtPivotHref(district),
  };
}

function actionMarkup(view, watchHref) {
  const noun = view.kind === "monitor-pack" ? "pack" : view.kind === "district-digest" ? "digest" : "parcel";
  return `<nav class="civic-object-actions" aria-label="Document actions" data-export-class="object_actions"><a class="civic-object-action primary" href="${esc(watchHref)}">Watch this ${noun}</a><button class="civic-object-action" type="button" data-object-copy>Copy link</button><button class="civic-object-action" type="button" data-object-print>Print / save PDF</button><button class="civic-object-action" type="button" data-object-export="json">Download JSON</button><button class="civic-object-action" type="button" data-object-export="xlsx">Download XLSX</button></nav>`;
}

function subjectLink(ref, hrefOverride = null) {
  const href = hrefOverride || subjectHref(ref);
  const value = clean(ref);
  const match = value.match(/^([a-z-]+):(.+)$/);
  const label = match?.[1] === "bbl"
    ? bblReaderLabel(match[2]) || value
    : match?.[1] === "project"
    ? `Project ${match[2]}`
    : match?.[1] === "notice"
    ? `City Record notice ${match[2]}`
    : value;
  return href ? `<a data-subject-ref="${esc(ref)}" href="${esc(href)}">${esc(label)}</a>` : esc(label);
}

export function renderComposedObjectDocument(view, options = {}) {
  if (!view || !CIVIC_OBJECT_EXPORT_REGISTRY[view.kind]) throw new Error("Unknown composed object");
  const isPack = view.kind === "monitor-pack";
  const isParcel = view.kind === "parcel";
  const title = isPack ? view.title : isParcel ? bblReaderLabel(view.bbl) || `Parcel ${view.bbl}` : `Council District ${view.council_district} weekly digest`;
  const watchHref = isPack ? followingUrlFromWatch(view.watches[0] || { lens: "money", filter: {} }, { frequency: "weekly" }) : isParcel ? followingUrlFromWatch({ lens: "property", filter: { subject_refs_all: [view.parcel_ref] } }, { frequency: "weekly" }) : followingUrlFromWatch({ lens: "district", filter: { councilDistrict: view.council_district } }, { frequency: "weekly" });
  const parcelSections = isParcel ? Object.entries(view.sections).map(([kind, section]) => `<section class="civic-object-section" data-parcel-biography-domain="${esc(kind)}"><h2>${esc(kind === "cofo" ? "Certificates of Occupancy" : kind === "tax_lien" ? "Tax-lien lists" : kind === "property" ? "Property dispositions" : "Land projects")}</h2>${section.items.length ? `<ul>${section.items.map(item => `<li>${subjectLink(item.subject_ref, item.href)} — ${esc(item.label || item.id)} <span class="muted">${esc(item.source)} · ${esc(item.date || "date not published")}</span></li>`).join("")}</ul>` : `<p>${esc(section.note || "No linked record is listed for this parcel.")}</p>`}</section>`).join("") : "";
  const members = isParcel
    ? parcelSections
    : isPack
    ? view.watches.map((watch) => `<li><a href="${esc(followingUrlFromWatch(watch, { frequency: "weekly" }))}">${esc(watch.label)}</a>${watch.subject_refs.length ? `<ul>${watch.subject_refs.map(subjectLink).map((link) => `<li>${link}</li>`).join("")}</ul>` : ""}</li>`).join("")
    : view.sections.map((section) => `<section class="civic-object-section"><h2>${esc(section.label)}</h2><ul>${section.items.map((item) => { const ref = item.request_id ? `notice:${item.request_id}` : item.project_id ? `project:${item.project_id}` : null; return `<li>${ref ? subjectLink(ref) : esc(item.short_title || item.project_name || item.district_item_id)}</li>`; }).join("")}</ul></section>`).join("");
  const pivot = isPack ? "" : isParcel ? `<p class="civic-object-pivot"><a data-subject-ref="${esc(view.parcel_ref)}" href="${esc(parcelBiographyHref(view.bbl))}">Open this parcel in Property</a></p>` : `<p class="civic-object-pivot"><a data-subject-ref="district:council-${esc(view.council_district)}" href="${esc(view.pivot_href)}">Explore Council District ${esc(view.council_district)} on Near you</a></p>`;
  const canonical = `https://cityscroll.org${view.path}`;
  const payload = JSON.stringify(view).replace(/<\/script/gi, "<\\/script");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · CityScroll</title><meta name="description" content="${esc(isPack ? view.description : isParcel ? "A reader-friendly record of public information connected with this parcel." : `A weekly public-data digest for Council District ${view.council_district}.`)}"><link rel="canonical" href="${esc(canonical)}"><meta property="og:url" content="${esc(canonical)}">${renderCivicDocumentAssets(options.assetPrefix || "/")}</head><body><a class="skip" href="#main">Skip to content</a>${renderCivicDocumentMast({ current: isParcel ? "property" : "following", surfaceClass: "civic-object-mast" })}<main id="main" class="civic-object-document" data-civic-object-kind="${esc(view.kind)}" data-subject-ref="${esc(view.subject_ref)}"><p><a href="${isParcel ? "/browse/property/" : "/following/"}">Back to ${isParcel ? "Property" : "Following"}</a></p><header class="civic-object-hero" data-export-class="object_identity"><p class="civic-object-kicker">${isPack ? "Monitor pack" : isParcel ? "Parcel record" : "District digest"}</p><h1>${esc(title)}</h1><p>${esc(isPack ? view.serves || view.description : isParcel ? "Public records connected with this parcel, grouped by source. These entries link to the original records available here." : `This digest has ${view.total} current public records for this council district.`)}</p>${pivot}</header>${actionMarkup(view, watchHref)}<section class="civic-object-section" data-export-class="object_members"><h2>${isPack ? "Watches in this pack" : isParcel ? "Records by source" : "This week’s sections"}</h2>${isParcel ? members : `<ul>${members}</ul>`}</section><section class="civic-object-section" data-export-class="object_provenance"><h2>Sources and limits</h2><p>${isParcel ? "This page gathers public records that name this exact parcel. The linked source records remain the official record." : "CityScroll groups public records into one reading aid. Source documents remain the official record."}</p></section></main><footer class="civic-object-footer">CityScroll is an unofficial reading aid. <a href="/about.html">About the data</a>.</footer><script id="civic-object-payload" type="application/json">${payload}</script><script defer src="/export_workflows.js"></script><script type="module" src="/composed_object_documents.mjs"></script></body></html>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · CityScroll</title><meta name="description" content="${esc(isPack ? view.description : isParcel ? "A reader-friendly record of public information connected with this parcel." : `A weekly public-data digest for Council District ${view.council_district}.`)}"><link rel="canonical" href="${esc(canonical)}"><meta property="og:url" content="${esc(canonical)}">${renderCivicDocumentAssets(options.assetPrefix || "/")}</head><body><a class="skip" href="#main">Skip to content</a>${renderCivicDocumentMast({ current: isParcel ? "property" : "following", surfaceClass: "civic-object-mast" })}<main id="main" class="civic-object-document" data-civic-object-kind="${esc(view.kind)}" data-subject-ref="${esc(view.subject_ref)}"><p><a href="${isParcel ? "/browse/property/" : "/following/"}">Back to ${isParcel ? "Property" : "Following"}</a></p><header class="civic-object-hero" data-export-class="object_identity"><p class="civic-object-kicker">${isPack ? "Monitor pack" : isParcel ? "Parcel record" : "District digest"}</p><h1>${esc(title)}</h1><p>${esc(isPack ? view.serves || view.description : isParcel ? "Public records connected with this parcel, grouped by source. These entries link to the original records available here." : `This digest has ${view.total} current public records for this council district.`)}</p>${pivot}</header>${actionMarkup(view, watchHref)}<section class="civic-object-section" data-export-class="object_members"><h2>${isPack ? "Watches in this pack" : isParcel ? "Records by source" : "This week’s sections"}</h2>${isParcel ? members : `<ul>${members}</ul>`}</section><section class="civic-object-section" data-export-class="object_provenance"><h2>Sources and limits</h2><p>${isParcel ? "This page gathers public records that name this exact parcel. The linked source records remain the official record." : "CityScroll groups public records into one reading aid. Source documents remain the official record."}</p></section></main><footer class="civic-object-footer">CityScroll is an unofficial reading aid. <a href="/about.html">About the data</a>.</footer><script id="civic-object-payload" type="application/json">${payload}</script><script defer src="/export_workflows.js"></script><script type="module" src="/composed_object_documents.mjs"></script></body></html>`;
}

if (typeof window !== "undefined") {
  const root = document.querySelector("[data-civic-object-kind]");
  const payload = JSON.parse(document.getElementById("civic-object-payload")?.textContent || "null");
  const canonical = document.querySelector('link[rel="canonical"]')?.href || location.href;
  root?.querySelector("[data-object-copy]")?.addEventListener("click", async (event) => { try { await navigator.clipboard.writeText(canonical); event.currentTarget.textContent = "Copied"; } catch { event.currentTarget.textContent = "Copy failed"; } });
  root?.querySelector("[data-object-print]")?.addEventListener("click", () => window.print());
  root?.querySelector('[data-object-export="json"]')?.addEventListener("click", () => window.CrolExports?.downloadFile(`cityscroll-${payload.kind}-${payload.id}.json`, JSON.stringify({ ...payload, canonical_url: canonical }, null, 2), "application/json"));
  root?.querySelector('[data-object-export="xlsx"]')?.addEventListener("click", () => { if (!window.CrolExports || !payload) return; const rows = payload.kind === "monitor-pack" ? payload.watches : payload.sections.flatMap((section) => section.items.map((item) => ({ section: section.id, ...item }))); const columns = Object.keys(rows[0] || { kind: "" }).filter((key) => typeof rows[0]?.[key] !== "object").map((key) => [key, (row) => row[key]]); window.CrolExports.downloadFile(`cityscroll-${payload.kind}-${payload.id}.xlsx`, new Blob([window.CrolExports.buildListWorkbook(payload.kind, columns, rows)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })); });
}
