/**
 * Pure typed-entity pivot helpers.
 *
 * Entity refs are the truth boundary; display labels never create links by
 * themselves. Generated links use canonical entity documents; legacy hashes
 * remain parseable for links already in the wild.
 */

import { resolveAgencyIdentity } from "./agency_identity.mjs";
import { cleanNoticeText } from "./text_clean.mjs";
export { reconcileAgencyIdentity, resolveAgencyIdentity } from "./agency_identity.mjs";

const clean = (value, max = 320) =>
  String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

const escapeHTML = (value) => clean(value).replace(/[<>&'"]/g, (char) => ({
  "<": "&lt;",
  ">": "&gt;",
  "&": "&amp;",
  "'": "&#39;",
  '"': "&quot;",
})[char]);

const escapeAttr = escapeHTML;

function decoded(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

/** Parse only the entity families with public routes in the first slice. */
export function parseEntityRef(value) {
  const ref = clean(value);
  if (!ref || /\s/.test(ref)) return null;
  if (ref.startsWith("agency:")) {
    const id = ref.slice("agency:".length);
    return id ? { kind: "agency", id, ref } : null;
  }
  if (ref.startsWith("vendor:stem:")) {
    const id = ref.slice("vendor:".length);
    return decoded(id.slice("stem:".length)) ? { kind: "vendor", id, ref } : null;
  }
  if (ref.startsWith("entity:official:")) {
    const id = ref.slice("entity:official:".length);
    return id ? { kind: "official", id, ref } : null;
  }
  const parcel = ref.match(/^bbl:(\d{10})$/);
  if (parcel) return { kind: "parcel", id: parcel[1], ref };
  return null;
}

/**
 * Compatibility adapter for already-accepted entity mentions that currently
 * have a routed display value but not a materialized ref at the call site.
 */
export function entityRouteRef(kind, value) {
  const label = cleanNoticeText(value).slice(0, 320);
  if (!label) return "";
  if (kind === "agency") return `agency:id:${resolveAgencyIdentity(label).canonical_id}`;
  if (kind === "vendor") return `vendor:stem:${encodeURIComponent(vendorStem(label))}`;
  if (kind === "official") return `entity:official:${encodeURIComponent(label)}`;
  return "";
}

/** Return the existing public route for an allowlisted typed entity ref. */
export function entityHref(entity = {}, options = {}) {
  const parsed = parseEntityRef(entity.ref);
  if (!parsed) return "";
  const label = clean(entity.label);
  if (parsed.kind === "parcel") {
    // The app loads CrolScope before this namespace helper. Accepting the same
    // namespace explicitly keeps direct module consumers deterministic while
    // preserving the legacy inline reconstruction's no-nested-import contract.
    const scopeTools = options.scopeTools || globalThis.CrolScope;
    if (!["emptyScope", "intersectScopes", "routeHashFromScope", "scopeWithEntity"]
      .every((name) => typeof scopeTools?.[name] === "function")) return "";
    const base = options.scope || scopeTools.emptyScope();
    const parcel = scopeTools.scopeWithEntity(scopeTools.emptyScope(base.language), parsed.ref);
    const composed = scopeTools.intersectScopes(base, parcel);
    return scopeTools.routeHashFromScope(composed, { surface: options.surface || "property" });
  }
  const query = new URLSearchParams();
  let route = "";
  if (parsed.kind === "official") {
    route = `/officials/${encodeURIComponent(decoded(parsed.id) || parsed.id)}/`;
    if (options.eventId) query.set("event", clean(options.eventId));
    if (options.noticeId) query.set("notice", clean(options.noticeId));
  } else {
    const identity = parsed.kind === "vendor"
      ? decoded(parsed.id.slice("stem:".length))
      : (parsed.id.startsWith("id:")
        ? parsed.id.slice("id:".length)
        : resolveAgencyIdentity(decoded(parsed.id.replace(/^name:/, ""))).canonical_id);
    if (!identity) return "";
    route = parsed.kind === "vendor"
      ? `/vendors/${encodeURIComponent(identity)}/`
      : `/agencies/${encodeURIComponent(identity)}/`;
    if (options.tab) query.set("tab", clean(options.tab));
  }
  const suffix = query.toString();
  return `${route}${suffix ? `?${suffix}` : ""}`;
}

/** Recover a typed descriptor from an existing entity hash route. */
export function entityFromHref(href, label = "") {
  const raw = clean(href, 1_000);
  const match = raw.match(/^#(agency|vendor|official)\/([^?]+)(?:\?(.*))?$/)
    || raw.match(/^\/(agencies|vendors|officials)\/([^/?#]+)\/?(?:\?(.*))?$/);
  if (!match) return null;
  const kind = ({ agencies: "agency", vendors: "vendor", officials: "official" })[match[1]] || match[1];
  const routed = decoded(match[2]);
  if (!routed) return null;
  const ref = match[1].endsWith("s")
    ? (kind === "agency" ? `agency:id:${routed}` : kind === "vendor" ? `vendor:stem:${encodeURIComponent(routed)}` : `entity:official:${encodeURIComponent(routed)}`)
    : entityRouteRef(kind, routed);
  if (!parseEntityRef(ref)) return null;
  return {
    ref,
    label: clean(label) || routed,
    options: (() => {
      const params = new URLSearchParams(match[3] || "");
      return {
        tab: params.get("tab") || "",
        eventId: params.get("event") || "",
        noticeId: params.get("notice") || "",
      };
    })(),
  };
}

function vendorStem(value) {
  const suffix = /\s+(INCORPORATED|INC|LLC|L\.L\.C|CORPORATION|CORP|COMPANY|CO|LTD|LIMITED|LP|LLP|PLLC|P\.C|PC|USA|OF NY|OF NEW YORK)\.?$/;
  let stem = clean(value).toUpperCase().replace(/[.,'’&]/g, " ").replace(/\s+/g, " ").trim();
  let previous;
  do {
    previous = stem;
    stem = stem.replace(suffix, "").trim();
  } while (stem !== previous && stem.length > 3);
  return stem;
}

/**
 * Render one public entity mention. Strong and tentative published links pivot;
 * review-only/unknown candidates remain escaped text.
 */
export function entityChipHTML(entity = {}, options = {}) {
  const label = escapeHTML(entity.label || "");
  const confidence = clean(entity.link_confidence || entity.confidence).toLowerCase();
  if (!label || !["strong", "tentative"].includes(confidence)) return label;
  const href = entityHref(entity, options);
  if (!href) return label;

  const relation = clean(entity.relation, 80);
  const evidence = clean(entity.evidence, 240);
  const relationAttr = relation ? ` data-relation="${escapeAttr(relation)}"` : "";
  const extraClass = clean(options.className, 80).replace(/[^a-zA-Z0-9 _-]/g, "");
  const classes = ["pivot", "entity-pivot", extraClass].filter(Boolean).join(" ");
  const link = `<a class="${classes}" href="${escapeAttr(href)}" data-entity-ref="${escapeAttr(entity.ref)}" data-link-confidence="${confidence}"${relationAttr}>${label}</a>`;
  if (confidence === "strong") return link;

  const evidenceHTML = evidence
    ? ` <span class="entity-pivot-evidence" title="${escapeAttr(evidence)}">Evidence</span>`
    : "";
  return `<span class="entity-pivot-tentative" data-link-confidence="tentative">${link} <span class="entity-pivot-band">Possible match</span>${evidenceHTML}</span>`;
}
