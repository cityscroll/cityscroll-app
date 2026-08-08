/** Static-first documents for monitor packs, district digests, and parcels. */

import { nearYouUrlFromScope, scopeFromLensState } from "./scope_v0.mjs";
import { followingUrlFromWatch } from "./following_view.mjs";
import { normalizeWatchTemplateRegistry } from "./watch_templates.mjs";
import {
  gateNodePageRender,
  renderCivicDocumentAssets,
  renderCivicDocumentMast,
  renderNodeActions,
  renderNodeBack,
  renderNodeFooter,
  renderNodeSection,
} from "./civic_document_chrome.mjs";
import { constellationLink } from "./affordance_grammar.mjs";
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

/** Stable reader labels for parcel biography source groups (one label per kind). */
export function parcelSectionLabel(kind) {
  return kind === "cofo"
    ? "Certificates of Occupancy"
    : kind === "ll48"
      ? "City-owned or leased property suitability"
      : kind === "tax_lien"
        ? "Tax-lien lists"
        : kind === "property"
          ? "Property dispositions"
          : kind === "land"
            ? "Land projects"
            : null;
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
  return renderNodeActions([
    { kind: "link", label: `Watch this ${noun}`, href: watchHref, primary: true, className: "civic-object-action" },
    { kind: "button", label: "Copy link", attrs: { "data-object-copy": true }, className: "civic-object-action" },
    { kind: "button", label: "Print / save PDF", attrs: { "data-object-print": true }, className: "civic-object-action" },
    { kind: "button", label: "Download JSON", attrs: { "data-object-export": "json" }, className: "civic-object-action" },
    { kind: "button", label: "Download XLSX", attrs: { "data-object-export": "xlsx" }, className: "civic-object-action" },
  ], {
    ariaLabel: "Document actions",
    exportClass: "object_actions",
    extraClass: "civic-object-actions",
  });
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
  return href ? constellationLink({ href, label, className: "composed-object-link", attributes: { "data-subject-ref": ref }, escape: esc }) : esc(label);
}

function parcelRecordItem(item) {
  const metadata = [item.source, item.date].filter(Boolean).join(" · ");
  return `<li class="node-record">
    <div class="node-record-main">${subjectLink(item.subject_ref, item.href)} — ${esc(item.label || item.id)}</div>
    ${metadata ? `<span class="muted node-muted">${esc(metadata)}</span>` : ""}
  </li>`;
}

function parcelMembersMarkup(view) {
  // One top-level card per source group that has items. Empty groups are
  // omitted entirely (no "no records listed" absence disclaimers).
  return Object.entries(view.sections || {}).map(([kind, section]) => {
    const label = parcelSectionLabel(kind);
    if (!label || !section.items?.length) return "";
    return renderNodeSection({
      heading: label,
      exportClass: "object_members",
      extraClass: "node-card civic-object-section",
      attrs: { "data-parcel-biography-domain": kind },
      body: `<ul class="node-record-list">${section.items.map(parcelRecordItem).join("")}</ul>`,
    });
  }).filter(Boolean).join("");
}

function packMembersMarkup(view) {
  const items = view.watches.map((watch) => `<li class="node-record">${constellationLink({ href: followingUrlFromWatch(watch, { frequency: "weekly" }), label: watch.label, className: "composed-object-link", escape: esc })}${watch.subject_refs.length ? `<ul class="node-record-list">${watch.subject_refs.map(subjectLink).map((link) => `<li>${link}</li>`).join("")}</ul>` : ""}</li>`).join("");
  return `<section class="node-section node-card civic-object-section" data-export-class="object_members"><h2>Watches in this pack</h2><ul class="node-record-list">${items}</ul></section>`;
}

function digestMembersMarkup(view) {
  return view.sections.map((section) => {
    const items = section.items.map((item) => {
      const ref = item.request_id ? `notice:${item.request_id}` : item.project_id ? `project:${item.project_id}` : null;
      return `<li class="node-record">${ref ? subjectLink(ref) : esc(item.short_title || item.project_name || item.district_item_id)}</li>`;
    }).join("");
    return `<section class="node-section node-card civic-object-section" data-export-class="object_members"><h2>${esc(section.label)}</h2><ul class="node-record-list">${items}</ul></section>`;
  }).join("");
}

export function renderComposedObjectDocument(view, options = {}) {
  if (!view || !CIVIC_OBJECT_EXPORT_REGISTRY[view.kind]) throw new Error("Unknown composed object");
  const isPack = view.kind === "monitor-pack";
  const isParcel = view.kind === "parcel";
  const title = isPack ? view.title : isParcel ? bblReaderLabel(view.bbl) || `Parcel ${view.bbl}` : `Council District ${view.council_district} weekly digest`;
  const watchHref = isPack
    ? followingUrlFromWatch(view.watches[0] || { lens: "money", filter: {} }, { frequency: "weekly" })
    : isParcel
      ? followingUrlFromWatch({ lens: "property", filter: { subject_refs_all: [view.parcel_ref] } }, { frequency: "weekly" })
      : followingUrlFromWatch({ lens: "district", filter: { councilDistrict: view.council_district } }, { frequency: "weekly" });
  const members = isParcel
    ? parcelMembersMarkup(view)
    : isPack
      ? packMembersMarkup(view)
      : digestMembersMarkup(view);
  const pivot = isPack
    ? ""
    : isParcel
      ? `<p class="node-pivot civic-object-pivot">${constellationLink({ href: parcelBiographyHref(view.bbl), label: "Open this parcel in Property", className: "composed-object-link", attributes: { "data-subject-ref": view.parcel_ref }, escape: esc })}</p>`
      : `<p class="node-pivot civic-object-pivot">${constellationLink({ href: view.pivot_href, label: `Explore Council District ${view.council_district} on Near you`, className: "composed-object-link", attributes: { "data-subject-ref": `district:council-${view.council_district}` }, escape: esc })}</p>`;
  const lede = isPack
    ? (view.serves || view.description)
    : isParcel
      ? "Public records connected with this parcel, grouped by source. These entries link to the original records available here."
      : `This digest has ${view.total} current public records for this council district.`;
  const kicker = isPack ? "Monitor pack" : isParcel ? "Parcel record" : "District digest";
  const back = isParcel
    ? renderNodeBack({ href: "/browse/property/", label: "Back to Property", extraClass: "civic-object-back" })
    : renderNodeBack({ href: "/following/", label: "Back to Following", extraClass: "civic-object-back" });
  const description = isPack
    ? view.description
    : isParcel
      ? "A reader-friendly record of public information connected with this parcel."
      : `A weekly public-data digest for Council District ${view.council_district}.`;
  const canonical = `https://cityscroll.org${view.path}`;
  const payload = JSON.stringify(view).replace(/<\/script/gi, "<\\/script");
  // Property is not a primary nav route; highlight Browse for parcel documents.
  const mastHighlight = isParcel ? "browse" : "following";
  return gateNodePageRender(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · CityScroll</title><meta name="description" content="${esc(description)}"><link rel="canonical" href="${esc(canonical)}"><meta property="og:url" content="${esc(canonical)}">${renderCivicDocumentAssets(options.assetPrefix || "/")}</head><body><a class="skip" href="#main">Skip to content</a>${renderCivicDocumentMast({ current: mastHighlight, surfaceClass: "civic-object-mast" })}<main id="main" class="node-document civic-object-document" data-civic-object-kind="${esc(view.kind)}" data-subject-ref="${esc(view.subject_ref)}" data-node-document="1">${back}<header class="node-hero civic-object-hero" data-export-class="object_identity"><p class="node-kicker civic-object-kicker">${esc(kicker)}</p><h1>${esc(title)}</h1><p class="node-lede">${esc(lede)}</p>${pivot}</header>${actionMarkup(view, watchHref)}${members}</main>${renderNodeFooter({ extraClass: "civic-object-footer" })}<script id="civic-object-payload" type="application/json">${payload}</script><script defer src="/export_workflows.js"></script><script type="module" src="/composed_object_documents.mjs"></script></body></html>`);
}

function exportRows(payload) {
  if (!payload) return [];
  if (payload.kind === "monitor-pack") return payload.watches || [];
  if (payload.kind === "parcel") {
    return Object.entries(payload.sections || {}).flatMap(([kind, section]) =>
      (section.items || []).map((item) => ({ section: kind, ...item }))
    );
  }
  return (payload.sections || []).flatMap((section) =>
    (section.items || []).map((item) => ({ section: section.id || section.label, ...item }))
  );
}

if (typeof window !== "undefined") {
  const root = document.querySelector("[data-civic-object-kind]");
  const payload = JSON.parse(document.getElementById("civic-object-payload")?.textContent || "null");
  const canonical = document.querySelector('link[rel="canonical"]')?.href || location.href;
  root?.querySelector("[data-object-copy]")?.addEventListener("click", async (event) => {
    try {
      await navigator.clipboard.writeText(canonical);
      event.currentTarget.textContent = "Copied";
    } catch {
      event.currentTarget.textContent = "Copy failed";
    }
  });
  root?.querySelector("[data-object-print]")?.addEventListener("click", () => window.print());
  root?.querySelector('[data-object-export="json"]')?.addEventListener("click", () => {
    window.CrolExports?.downloadFile(
      `cityscroll-${payload.kind}-${payload.id}.json`,
      JSON.stringify({ ...payload, canonical_url: canonical }, null, 2),
      "application/json",
    );
  });
  root?.querySelector('[data-object-export="xlsx"]')?.addEventListener("click", () => {
    if (!window.CrolExports || !payload) return;
    const rows = exportRows(payload);
    const columns = Object.keys(rows[0] || { kind: "" })
      .filter((key) => typeof rows[0]?.[key] !== "object")
      .map((key) => [key, (row) => row[key]]);
    window.CrolExports.downloadFile(
      `cityscroll-${payload.kind}-${payload.id}.xlsx`,
      new Blob([window.CrolExports.buildListWorkbook(payload.kind, columns, rows)], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
    );
  });
}
