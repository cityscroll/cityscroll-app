/**
 * Public mandate backlinks on notice documents (reader + lookup).
 *
 * Compact by-notice index is built offline (tools/build_notice_mandate_backlinks.mjs)
 * from public cross-spine edges only. This module is SPA-safe: no entity_resolution
 * or bridge imports on the browser wire.
 *
 * Reader card: duty summary, citation / source-law link, relation label,
 * and agency dossier deep link — no machine source keys or raw subject refs.
 */

import { constellationLink, officialSourceLink } from "./affordance_grammar.mjs";
import { resolveAgencyIdentity } from "./agency_identity.mjs";
import { scopeFromWatch, watchFromScope } from "./scope_v0.mjs";

export const NOTICE_MANDATE_BACKLINKS_SCHEMA = "cityscroll.notice_mandate_backlinks.v1";
export const NOTICE_MANDATE_BACKLINKS_METHOD = "notice_mandate_backlinks_v1";
export const NOTICE_MANDATE_BACKLINKS_LOOKUP_PATH =
  "data/notice_mandate_backlinks_lookup.json";

/** Public publication tiers that may appear on notice documents. */
export const PUBLIC_BACKLINK_TIERS = Object.freeze([
  "deterministic",
  "public_inferred",
]);

const PUBLIC_TIER_SET = new Set(PUBLIC_BACKLINK_TIERS);

/** Reader-facing relation labels (no machine edge ids). */
export const BACKLINK_RELATION_LABELS = Object.freeze({
  implemented_by_contract: "Procurement record for this duty",
  requires_public_hearing: "Public hearing for this duty",
  requires_land_use_action: "Land-use action for this duty",
  mandate_rule_filing: "Rules filing for this duty",
  requires_rule_filing: "Rules filing for this duty",
});

const clean = (value, max = 500) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

const escDefault = (value) => String(value ?? "").replace(/[<>&"']/g, (char) => ({
  "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
}[char]));

// Keep the notice reader's one-duty watch link on a small, SPA-safe path. The
// full agency-obligations module imports the Following document renderer and
// belongs to agency/mandate routes, not the home cold path.
function canonicalMandateId(value) {
  let s = typeof value === "string" ? value.trim() : "";
  const legacy = s.match(/^(?:mandate|obligation):([^:\s]+)$/i);
  if (legacy) s = legacy[1];
  return s && !/\s/.test(s) && !s.includes(":")
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(s) ? s : null;
}

function compactWatch(value) {
  const out = {};
  for (const [key, item] of Object.entries(value || {})) {
    if (item == null || item === "" || item === false) continue;
    if (Array.isArray(item) && item.length === 0) continue;
    out[key] = item;
  }
  return out;
}

function mandateFollowHref(mandateId, agencyIdOrName) {
  const exactId = canonicalMandateId(mandateId);
  const identity = resolveAgencyIdentity(agencyIdOrName);
  if (!exactId || !identity?.canonical_id) return null;
  const filter = compactWatch({
    agency_id: identity.canonical_id,
    agency: identity.canonical_name,
    mandate_id: exactId,
  });
  const watch = watchFromScope(scopeFromWatch({ lens: "mandates", filter }), { lens: "mandates" });
  const params = new URLSearchParams({
    lens: watch.lens,
    filter: JSON.stringify(compactWatch(watch.filter)),
    freq: "weekly",
  });
  return `https://cityscroll.org/following?${params}`;
}

export function isPublicBacklinkTier(tier) {
  return PUBLIC_TIER_SET.has(clean(tier, 40));
}

export function noticeIdFromSubject(value) {
  const raw = clean(value, 160);
  if (!raw) return null;
  if (raw.startsWith("notice:")) {
    const id = raw.slice("notice:".length);
    return /^[A-Za-z0-9_-]{1,80}$/.test(id) ? id : null;
  }
  return /^[A-Za-z0-9_-]{1,80}$/.test(raw) ? raw : null;
}

export function relationLabelFor(relation) {
  const key = clean(relation, 80);
  return BACKLINK_RELATION_LABELS[key] || "Connected statutory duty";
}

/**
 * Compact public-safe backlink row. Strips graph subject_ref forms, evidence bags,
 * source-system keys, and shadow tiers. Keeps a canonical bare mandate_id when
 * present so the notice card can offer a one-duty Following watch.
 */
export function compactMandateBacklink(input = {}) {
  const duty_text = clean(input.duty_text, 700);
  if (!duty_text) return null;
  const tier = clean(input.publication_tier || input.tier, 40);
  if (tier && !isPublicBacklinkTier(tier)) return null;

  const agencyId = clean(input.agency_id, 120);
  const identity = agencyId ? resolveAgencyIdentity(agencyId) : null;
  const agency_id = identity?.canonical_id || agencyId || null;
  const agency_name = clean(
    input.agency_name || identity?.canonical_name,
    200,
  ) || null;
  const agency_href = agency_id
    ? `/agencies/${encodeURIComponent(agency_id)}/`
    : clean(input.agency_href, 240) || null;

  const relation = clean(input.relation, 80) || null;
  const citation = clean(input.citation, 240) || null;
  const source_href = clean(input.source_href, 500) || null;
  // Only allow https law landings — never opaque keys or internal paths.
  const safeSource = source_href && /^https:\/\//i.test(source_href)
    ? source_href
    : null;

  // Exact product filter key — bare id only (legacy mandate:/obligation: refs normalize).
  const mandate_id = canonicalMandateId(input.mandate_id)
    || canonicalMandateId(input.obligation_id)
    || canonicalMandateId(input.subject_ref)
    || null;
  const watch_href = mandate_id && agency_id
    ? mandateFollowHref(mandate_id, agency_id, { frequency: "weekly" })
    : null;

  const out = {
    duty_text,
    citation,
    source_href: safeSource,
    relation,
    relation_label: clean(input.relation_label, 120) || relationLabelFor(relation),
    agency_id,
    agency_name,
    agency_href,
    publication_tier: isPublicBacklinkTier(tier) ? tier : "public_inferred",
  };
  if (mandate_id) out.mandate_id = mandate_id;
  if (watch_href) out.watch_href = watch_href;
  return out;
}

/** Look up public backlinks for one notice id. Empty → []. */
export function lookupNoticeMandateBacklinks(lookup, requestId) {
  const id = noticeIdFromSubject(requestId);
  if (!id || !lookup || lookup.schema !== NOTICE_MANDATE_BACKLINKS_SCHEMA) return [];
  const rows = lookup.by_notice?.[id];
  if (!Array.isArray(rows) || !rows.length) return [];
  return rows
    .map((row) => compactMandateBacklink(row))
    .filter(Boolean)
    // Defense in depth: never surface a non-public tier if the artifact is stale.
    .filter((row) => isPublicBacklinkTier(row.publication_tier));
}

/**
 * Render the Connected mandate provenance card.
 * Empty input → "" (no absence announcement).
 */
export function renderNoticeMandateBacklinksHTML(rows, { esc = escDefault } = {}) {
  const list = (Array.isArray(rows) ? rows : [])
    .map((row) => compactMandateBacklink(row))
    .filter(Boolean);
  if (!list.length) return "";

  const cards = list.map((row) => {
    const source = row.source_href
      ? ` · ${officialSourceLink({
        href: row.source_href,
        label: "Source law",
        className: "notice-mandate-source",
        escape: esc,
      })}`
      : "";
    const agency = row.agency_href && row.agency_name
      ? ` · ${constellationLink({
        href: row.agency_href,
        label: row.agency_name,
        className: "notice-mandate-agency",
        escape: esc,
      })}`
      : (row.agency_name ? ` · ${esc(row.agency_name)}` : "");
    const citation = row.citation
      ? `<span class="notice-mandate-citation">${esc(row.citation)}</span>`
      : "";
    const metaParts = [
      `<span class="notice-mandate-relation">${esc(row.relation_label)}</span>`,
      citation,
    ].filter(Boolean);
    // Per-mandate Following watch only when a public backlink carries a canonical id.
    const watch = row.watch_href
      ? ` · ${constellationLink({
        href: row.watch_href,
        label: "Watch this mandate",
        className: "notice-mandate-watch",
        escape: esc,
        attributes: {
          "data-mandate-watch": "1",
          "data-mandate-id": row.mandate_id || "",
        },
      })}`
      : "";
    const mandateAttr = row.mandate_id
      ? ` data-mandate-id="${esc(row.mandate_id)}"`
      : "";
    return `<article class="notice-mandate-card" data-relation="${esc(row.relation || "")}"${mandateAttr}>
      <p class="notice-mandate-duty" lang="en" dir="ltr">${esc(row.duty_text)}</p>
      <p class="muted notice-mandate-meta">${metaParts.join(" · ")}${source}${agency}${watch}</p>
    </article>`;
  }).join("");

  const heading = list.length === 1 ? "Connected mandate" : "Connected mandates";
  return `<section class="notice-mandate-backlinks" data-connected-mandate="1" data-mandate-backlink-count="${esc(String(list.length))}" aria-label="${esc(heading)}">
    <div class="chain-h">${esc(heading)}</div>
    ${cards}
  </section>`;
}

/**
 * Convenience: lookup + render for one notice. Empty-safe.
 */
export function renderNoticeMandateBacklinksForId(lookup, requestId, opts) {
  return renderNoticeMandateBacklinksHTML(
    lookupNoticeMandateBacklinks(lookup, requestId),
    opts,
  );
}
