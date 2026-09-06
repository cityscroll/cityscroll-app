/**
 * One canonical destination rule for a legislative matter.
 *
 * Several surfaces offer a reader a way out of a hearing and into the matter
 * that hearing concerns: the static meeting document and the meetings card
 * (site/council_hearing_matter_continuation.mjs), the first-paint outcome
 * snapshot (site/meeting_outcomes_static.mjs), and the client-rendered outcome
 * list (site/app/meetings.mjs). Each of those grew its own idea of where a
 * matter identity leads — one built `/matters/<id>/` for every numeric id
 * whether or not that page exists, one named a single published id inline, one
 * checked the published lookup. The same matter could therefore be advertised
 * as a local page on one surface and a publisher link on another, and an
 * unpublished id could be advertised as a local page that answers 404.
 *
 * This module is the single place that decision happens. Every caller asks it
 * where a matter identity leads instead of composing a href itself.
 *
 * Three outcomes, and only three:
 *
 *   local_history   — this matter has a published history in
 *                     site/data/legislative_matter_lookup.json, so `/matters/<id>/`
 *                     is a page that exists. Labelled "View matter history".
 *   official_record — no published local history, but the retained record
 *                     carries this matter's own official address. Labelled
 *                     "View official matter record".
 *   unavailable     — neither. No href, and the caller states that plainly.
 *
 * What this module will not do: derive, guess, or template an official address
 * from an identity; substitute a committee, body, agenda, or browse page for a
 * matter; or advertise a local route that the published lookup does not carry.
 * A missing destination is an absence to disclose, not a link to invent.
 *
 * The labels are navigation labels. They say what the reader will see, never
 * that anything was saved, subscribed, submitted, or attributed to them.
 * Follow language belongs to a saved watch, which this module does not create.
 */

import publishedMatterLookup from "./data/legislative_matter_lookup.json" with { type: "json" };

export const LEGISLATIVE_MATTER_AVAILABILITY_SCHEMA = "cityscroll.legislative_matter_availability.v1";

/** A published local history. Navigation only. */
export const MATTER_HISTORY_LABEL = "View matter history";
/** The publisher's own record for this exact matter. Navigation only. */
export const MATTER_OFFICIAL_RECORD_LABEL = "View official matter record";
/** Plain-language absence, used when neither destination exists. */
export const MATTER_DESTINATION_UNAVAILABLE_NOTE =
  "No matter record is available to open for this identity yet.";

export const MATTER_AVAILABILITY_STATES = Object.freeze([
  "local_history",
  "official_record",
  "unavailable",
]);

function text(value, max = 500) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * The exact publisher identity, with the `matter:` subject prefix removed. Only
 * a bare digit string can address a local matter route, which is the same rule
 * site/pages_edge.mjs applies when it answers one.
 */
export function matterIdentity(value) {
  const id = text(value, 80).replace(/^matter:/, "");
  return /^\d+$/.test(id) ? id : "";
}

function safeHttps(value) {
  try {
    const url = new URL(text(value, 2_000));
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * The published population: the matter ids that have a materialized local
 * history right now. Accepts the lookup artifact, a plain id list, or a Set, so
 * a caller holding a different generation (a test, a build step reading a
 * candidate artifact) can ask the same question of it.
 */
export function publishedMatterIds(source = publishedMatterLookup) {
  if (source instanceof Set) return new Set([...source].map(matterIdentity).filter(Boolean));
  if (Array.isArray(source)) return new Set(source.map(matterIdentity).filter(Boolean));
  const matters = source && typeof source === "object" ? source.matters || source : {};
  return new Set(Object.keys(matters || {}).map(matterIdentity).filter(Boolean));
}

const DEFAULT_PUBLISHED_MATTER_IDS = publishedMatterIds(publishedMatterLookup);

/** True when `/matters/<id>/` is a materialized page rather than a 404. */
export function isPublishedMatter(value, { published = DEFAULT_PUBLISHED_MATTER_IDS } = {}) {
  const id = matterIdentity(value);
  return Boolean(id) && publishedMatterIds(published).has(id);
}

/** The local history route for a published matter, and null for anything else. */
export function publishedMatterHref(value, options = {}) {
  const id = matterIdentity(value);
  return id && isPublishedMatter(id, options) ? `/matters/${encodeURIComponent(id)}/` : null;
}

/**
 * The official address this matter is known by. Read from the record the caller
 * already holds, and otherwise from the published lookup's own retained
 * identity. This module composes no address of its own: it publishes the one
 * its caller or the published lookup already carries, or none at all.
 */
function officialMatterHref(id, matter, lookup) {
  const supplied = safeHttps(matter?.matter_url) || safeHttps(matter?.matter_href);
  if (supplied) return { href: supplied, basis: "supplied_matter_address" };
  const entry = (lookup && typeof lookup === "object" ? lookup.matters : null)?.[id];
  const retained = safeHttps(entry?.matter_href);
  return retained ? { href: retained, basis: "published_matter_address" } : { href: null, basis: null };
}

/**
 * Resolve one matter identity to the one destination a reader may be offered.
 *
 * `matter` is any shape that carries `matter_id` (or `subject_ref`) and,
 * optionally, the matter's own retained official address as `matter_url` or
 * `matter_href` — the retained City Record appearance, the published lookup
 * entry, and the client-side outcome row all satisfy that without conversion.
 */
export function resolveMatterDestination(matter = {}, { published, lookup = publishedMatterLookup } = {}) {
  const id = matterIdentity(matter?.matter_id ?? matter?.subject_ref ?? matter);
  const base = {
    schema: LEGISLATIVE_MATTER_AVAILABILITY_SCHEMA,
    matter_id: id || null,
    availability: "unavailable",
    href: null,
    label: null,
    external: false,
    basis: null,
    note: MATTER_DESTINATION_UNAVAILABLE_NOTE,
  };
  if (!id) return Object.freeze(base);
  const publishedIds = published === undefined ? DEFAULT_PUBLISHED_MATTER_IDS : publishedMatterIds(published);
  if (publishedIds.has(id)) {
    return Object.freeze({
      ...base,
      availability: "local_history",
      href: `/matters/${encodeURIComponent(id)}/`,
      label: MATTER_HISTORY_LABEL,
      external: false,
      basis: "published_matter_document",
      note: null,
    });
  }
  const official = officialMatterHref(id, matter, lookup);
  if (official.href) {
    return Object.freeze({
      ...base,
      availability: "official_record",
      href: official.href,
      label: MATTER_OFFICIAL_RECORD_LABEL,
      external: true,
      basis: official.basis,
      note: null,
    });
  }
  return Object.freeze(base);
}
