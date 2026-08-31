/**
 * Exact Administrative Code provision Following identity.
 *
 * Identity and URL serialization stay separate from lifecycle event
 * projection so Following pages do not load the version materializer.
 */

import { subscriptionParamsFromWatch } from "./scope_v0.mjs";

export const CODE_PROVISION_WATCH_SCHEMA = "cityscroll.code_provision_watch.v1";
export const CODE_PROVISION_WATCH_LENS = "legal_code";
export const CODE_PROVISION_WATCH_SCOPE_VERSION = 1;

const ADMIN_CODE = "nyc-administrative-code";
const CITATION = /^(\d+[a-z]?-[0-9a-z.]+)$/i;
const BROADENING_FIELDS = Object.freeze([
  "keywords", "agency", "agency_id", "geographies", "name", "kind", "noticeType",
  "category", "minAmount", "maxAmount", "borough", "boro", "communityBoard",
  "councilDistrict", "mandate_id", "request_ids", "procurement_id",
]);

function freeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (!value || typeof value !== "object") return value;
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freeze(item)])));
}

function clean(value, max = 2_000) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function citationFrom(value) {
  const input = clean(value, 240).normalize("NFKC")
    .replace(/[§]/g, " ")
    .replace(/\b(?:NYC|NEW\s+YORK\s+CITY)\s+(?:ADMIN(?:ISTRATIVE)?\s+)?CODE\b/giu, " ")
    .replace(/\bADMIN(?:ISTRATIVE)?\s+CODE\b/giu, " ")
    .replace(/^(?:nyc-administrative-code|nyc-admin-code):/i, "")
    .trim();
  const match = input.match(CITATION);
  return match ? match[1].toLowerCase() : null;
}

/** Canonical persistent provision identity. Wording and current version are not part of the id. */
export function canonicalCodeProvisionId(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return canonicalCodeProvisionId(value.provision_id || value.id || value.citation);
  }
  const citation = citationFrom(value);
  return citation ? `${ADMIN_CODE}:${citation}` : null;
}

export function provisionWatchCitation(provisionId) {
  const id = canonicalCodeProvisionId(provisionId);
  return id ? `§ ${id.slice(`${ADMIN_CODE}:`.length)}` : null;
}

function hasBroadeningFields(filter = {}) {
  return BROADENING_FIELDS.some((name) => {
    const value = filter[name];
    if (Array.isArray(value)) return value.length > 0;
    return value != null && value !== "" && value !== false;
  });
}

function unsupported(reason, extra = {}) {
  return freeze({
    schema: CODE_PROVISION_WATCH_SCHEMA,
    status: "unsupported",
    lens: null,
    filter: {},
    provision_id: extra.provision_id || null,
    citation: extra.citation || null,
    watch_scope_version: CODE_PROVISION_WATCH_SCOPE_VERSION,
    reason,
    replayable: false,
  });
}

/**
 * Exact-scope Following target for one CodeProvision.
 * Missing identity, inferred citations, and extra topic/agency/corpus fields
 * fail closed instead of widening to legislation search.
 */
export function exactProvisionWatch(input = {}) {
  const lens = String(input.lens || input.filter?.lens || "").trim().toLowerCase();
  const filter = input.filter && typeof input.filter === "object" && !Array.isArray(input.filter)
    ? input.filter
    : (input.provision_id || input.id ? { provision_id: input.provision_id || input.id } : {});
  if (lens && lens !== CODE_PROVISION_WATCH_LENS) {
    return unsupported("watch is not an exact Administrative Code provision scope");
  }
  if (hasBroadeningFields(filter) && !canonicalCodeProvisionId(filter.provision_id || input.provision_id || input.id)) {
    return unsupported("exact provision identity is required; topic, agency, and corpus watches are not substitutes");
  }
  if (hasBroadeningFields(filter) && canonicalCodeProvisionId(filter.provision_id || input.provision_id || input.id)) {
    return unsupported("exact provision watches cannot carry topic, agency, or corpus constraints");
  }
  const provisionId = canonicalCodeProvisionId(filter.provision_id || input.provision_id || input.id || input.citation);
  if (!provisionId) {
    return unsupported("exact provision identity is missing or not a canonical Administrative Code ref");
  }
  const citation = provisionWatchCitation(provisionId);
  return freeze({
    schema: CODE_PROVISION_WATCH_SCHEMA,
    status: "ok",
    lens: CODE_PROVISION_WATCH_LENS,
    filter: { provision_id: provisionId },
    provision_id: provisionId,
    citation,
    watch_scope_version: CODE_PROVISION_WATCH_SCOPE_VERSION,
    reason: null,
    replayable: true,
  });
}

export function provisionFollowHref(input, { frequency = "weekly", base = "https://cityscroll.org/following" } = {}) {
  const watch = exactProvisionWatch(input);
  if (watch.status !== "ok") return null;
  const params = subscriptionParamsFromWatch({
    lens: watch.lens,
    filter: watch.filter,
  });
  const freq = String(frequency || "").toLowerCase();
  if (freq === "daily" || freq === "weekly") params.set("freq", freq);
  const origin = String(base || "").replace(/\/$/, "") || "https://cityscroll.org/following";
  return `${origin}?${params}`;
}
