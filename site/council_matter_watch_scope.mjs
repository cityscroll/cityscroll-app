/**
 * Exact New York City Council matter Following identity.
 *
 * A meetings watch may name one source-qualified Legistar matter. Validation
 * runs before any lossy sanitizer. Conflicting topic, notice, committee, or
 * all-meetings fields fail closed instead of widening the watch.
 */

import { subscriptionParamsFromWatch } from "./scope_v0.mjs";

export const COUNCIL_MATTER_WATCH_SCHEMA = "cityscroll.council_matter_watch.v1";
export const COUNCIL_MATTER_WATCH_LENS = "meetings";
export const COUNCIL_MATTER_WATCH_SCOPE_VERSION = 1;
export const COUNCIL_MATTER_SOURCE_SYSTEM = "legistar";
export const COUNCIL_MATTER_TENANT_NYC = "nyc";
export const COUNCIL_MATTER_KNOWN_TENANTS = Object.freeze([COUNCIL_MATTER_TENANT_NYC]);

const MATTER_REF = /^(legistar):([a-z0-9-]+):matter:(\d+)$/;
const MATTER_KEYS = Object.freeze([
  "matter_ref", "matter", "matter_id", "matterId", "council_matter",
  "matter_scope_version", "watch_scope_version",
]);
const BROADENING_FIELDS = Object.freeze([
  "keywords", "agency", "agency_id", "geographies", "name", "kind", "noticeType",
  "category", "minAmount", "maxAmount", "borough", "boro", "communityBoard",
  "communityDistrict", "councilDistrict", "neighborhood", "locationScope",
  "dateWindow", "when", "process", "nearMe", "place_role", "request_ids",
  "procurement_id", "mandate_id", "provision_id",
]);

function freeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (!value || typeof value !== "object") return value;
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freeze(item)])));
}

function clean(value, max = 240) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function hasValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  return value != null && value !== "" && value !== false;
}

export function hasCouncilMatterScopeAttempt(input = {}) {
  const filter = input.filter && typeof input.filter === "object" && !Array.isArray(input.filter)
    ? input.filter
    : input;
  if (MATTER_KEYS.some((key) => Object.prototype.hasOwnProperty.call(filter || {}, key))) {
    return true;
  }
  if (hasValue(input.matter_ref) || hasValue(input.matter) || hasValue(input.matter_id) || hasValue(input.id)) {
    return true;
  }
  return false;
}

export function canonicalCouncilMatterRef(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (value.matter_ref || value.ref) return canonicalCouncilMatterRef(value.matter_ref || value.ref);
    const source = clean(value.source_system || value.sourceSystem || COUNCIL_MATTER_SOURCE_SYSTEM, 40).toLowerCase();
    const tenant = clean(value.tenant || value.publisher_tenant || COUNCIL_MATTER_TENANT_NYC, 40).toLowerCase();
    const matterId = clean(value.matter_id || value.matterId || value.id, 40);
    if (!/^\d+$/.test(matterId)) return null;
    if (source !== COUNCIL_MATTER_SOURCE_SYSTEM) return null;
    if (!COUNCIL_MATTER_KNOWN_TENANTS.includes(tenant)) return null;
    return `${source}:${tenant}:matter:${matterId}`;
  }
  const raw = clean(value, 240).toLowerCase();
  if (!raw) return null;
  const match = MATTER_REF.exec(raw);
  if (match) {
    if (match[1] !== COUNCIL_MATTER_SOURCE_SYSTEM) return null;
    if (!COUNCIL_MATTER_KNOWN_TENANTS.includes(match[2])) return null;
    return `${match[1]}:${match[2]}:matter:${match[3]}`;
  }
  if (/^\d+$/.test(raw)) return `${COUNCIL_MATTER_SOURCE_SYSTEM}:${COUNCIL_MATTER_TENANT_NYC}:matter:${raw}`;
  return null;
}

export function parseCouncilMatterRef(value) {
  const ref = canonicalCouncilMatterRef(value);
  if (!ref) return null;
  const match = MATTER_REF.exec(ref);
  return freeze({
    matter_ref: ref,
    source_system: match[1],
    tenant: match[2],
    matter_id: match[3],
  });
}

function hasBroadeningFields(filter = {}) {
  return BROADENING_FIELDS.some((name) => hasValue(filter[name]));
}

function requestedVersion(input, filter) {
  const raw = input.matter_scope_version ?? input.watch_scope_version
    ?? filter.matter_scope_version ?? filter.watch_scope_version;
  if (raw == null || raw === "") return COUNCIL_MATTER_WATCH_SCOPE_VERSION;
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  return Number.isInteger(n) ? n : NaN;
}

function unsupported(reason, extra = {}) {
  return freeze({
    schema: COUNCIL_MATTER_WATCH_SCHEMA,
    status: "unsupported",
    attempted: true,
    lens: null,
    filter: {},
    matter_ref: extra.matter_ref || null,
    source_system: extra.source_system || null,
    tenant: extra.tenant || null,
    matter_id: extra.matter_id || extra.matterId || null,
    watch_scope_version: extra.watch_scope_version ?? COUNCIL_MATTER_WATCH_SCOPE_VERSION,
    reason,
    replayable: false,
  });
}

function notApplicable() {
  return freeze({
    schema: COUNCIL_MATTER_WATCH_SCHEMA,
    status: "not-applicable",
    attempted: false,
    lens: null,
    filter: {},
    matter_ref: null,
    source_system: null,
    tenant: null,
    matter_id: null,
    watch_scope_version: COUNCIL_MATTER_WATCH_SCOPE_VERSION,
    reason: null,
    replayable: false,
  });
}

/**
 * Exact-scope Following target for one Council matter.
 * Malformed IDs, unknown tenants, unsupported versions, and extra filters
 * fail closed instead of becoming an all-meetings watch.
 */
export function exactCouncilMatterWatch(input = {}) {
  const lens = String(input.lens || input.filter?.lens || "").trim().toLowerCase();
  const filter = input.filter && typeof input.filter === "object" && !Array.isArray(input.filter)
    ? input.filter
    : {};
  const attempted = hasCouncilMatterScopeAttempt(input);
  if (!attempted) return notApplicable();
  if (lens && lens !== COUNCIL_MATTER_WATCH_LENS) {
    return unsupported("exact Council matter watches belong under the meetings lens");
  }
  const version = requestedVersion(input, filter);
  if (!Number.isInteger(version) || version !== COUNCIL_MATTER_WATCH_SCOPE_VERSION) {
    return unsupported("unsupported exact matter scope version", { watch_scope_version: version });
  }
  if (hasBroadeningFields(filter)) {
    return unsupported("exact matter watches cannot carry notice, committee, place, or all-meetings constraints");
  }
  const parsed = parseCouncilMatterRef(
    filter.matter_ref || filter.matter || filter.council_matter
      || input.matter_ref || input.matter || input.matter_id || input.id
      || { tenant: filter.tenant || input.tenant, matter_id: filter.matter_id || input.matter_id },
  );
  if (!parsed) {
    const rawTenant = clean(filter.tenant || input.tenant, 40).toLowerCase();
    if (rawTenant && !COUNCIL_MATTER_KNOWN_TENANTS.includes(rawTenant)) {
      return unsupported("unknown Legistar tenant", { tenant: rawTenant });
    }
    return unsupported("exact Council matter identity is missing or malformed");
  }
  return freeze({
    schema: COUNCIL_MATTER_WATCH_SCHEMA,
    status: "ok",
    attempted: true,
    lens: COUNCIL_MATTER_WATCH_LENS,
    filter: {
      matter_ref: parsed.matter_ref,
      matter_scope_version: COUNCIL_MATTER_WATCH_SCOPE_VERSION,
    },
    matter_ref: parsed.matter_ref,
    source_system: parsed.source_system,
    tenant: parsed.tenant,
    matter_id: parsed.matter_id,
    watch_scope_version: COUNCIL_MATTER_WATCH_SCOPE_VERSION,
    reason: null,
    replayable: true,
  });
}

export function councilMatterFollowHref(input, { frequency = "weekly", base = "https://cityscroll.org/following" } = {}) {
  const watch = exactCouncilMatterWatch(input);
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

export function retainedMatterIdsFromSnapshot(snapshot) {
  const ids = new Set();
  for (const record of Object.values(snapshot?.by_notice || {})) {
    for (const matter of record?.matters || []) {
      const id = clean(matter?.matter_id, 40);
      if (/^\d+$/.test(id)) ids.add(id);
    }
  }
  return ids;
}

export function isRetainedCouncilMatter(watchOrRef, roster) {
  const parsed = parseCouncilMatterRef(watchOrRef?.matter_ref || watchOrRef);
  if (!parsed) return false;
  if (!roster) return false;
  if (roster instanceof Set) return roster.has(parsed.matter_id);
  if (Array.isArray(roster)) return roster.map(String).includes(parsed.matter_id);
  if (roster.matters && typeof roster.matters === "object") {
    return Object.prototype.hasOwnProperty.call(roster.matters, parsed.matter_id);
  }
  if (roster.by_notice) return retainedMatterIdsFromSnapshot(roster).has(parsed.matter_id);
  return false;
}
