/**
 * Shared pursuit-state identity adapter.
 *
 * Canonical procurement routes, list/detail navigation, and proven notice
 * aliases must resolve to the same storage key. An unjoined City Record notice
 * keeps its own notice identity. This module never invents a procurement id
 * from a similar title.
 */

import { noticeProcurementSubjectsForId } from "./notice_subject_projection.mjs";
import { procurementCanonicalHref } from "./procurement_route.mjs";

export const PURSUIT_MATTER_KIND = Object.freeze({
  PROCUREMENT: "procurement",
  NOTICE: "notice",
  LEGACY: "legacy",
});

function clean(value, max = 240) {
  const text = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  return max ? text.slice(0, max) : text;
}

function noticeId(value) {
  const raw = clean(value, 120);
  if (!raw) return null;
  const fromHref = raw.match(/\/notices\/([A-Za-z0-9_-]{1,80})\/?$/i);
  const id = (fromHref?.[1] || raw.replace(/^notice:/i, "")).trim();
  return /^[A-Za-z0-9_-]{1,80}$/.test(id) ? id : null;
}

function procurementId(value) {
  const id = clean(value, 240);
  return id && id.startsWith("procurement:") ? id : null;
}

/** Decode `/procurements/{encoded-id}` into a procurement id when present. */
export function pursuitMatterRefFromProcurementPath(pathname) {
  const path = clean(pathname, 500);
  if (!path) return null;
  const match = path.match(/^\/procurements\/([^/?#]+)\/?$/i);
  if (!match) return null;
  try {
    return procurementId(decodeURIComponent(match[1]));
  } catch {
    return null;
  }
}

/**
 * Build a source-alias → canonical map from known object identity keys.
 * Ambiguous aliases (two objects claiming the same bare token) are omitted.
 */
export function buildPursuitSourceAliasIndex(rows = []) {
  const candidates = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const canonical = procurementId(row?.procurement_id || row?.canonical_id);
    if (!canonical) continue;
    const keys = row?.identity_keys || {};
    const aliases = new Set();
    for (const value of keys.solicitation_ids || []) {
      const token = clean(value, 80);
      if (token) {
        aliases.add(token);
        aliases.add(`solicitation:${token}`);
      }
    }
    for (const value of keys.contract_reporter_numbers || []) {
      const token = clean(value, 80);
      if (token) {
        aliases.add(token);
        aliases.add(`contract_reporter_number:${token}`);
      }
    }
    for (const value of keys.event_ids || []) {
      const token = clean(value, 80);
      if (token) aliases.add(`event:${token}`);
    }
    for (const alias of aliases) {
      const existing = candidates.get(alias);
      if (existing && existing !== canonical) {
        candidates.set(alias, null);
      } else if (!existing) {
        candidates.set(alias, canonical);
      }
    }
  }
  return Object.freeze(Object.fromEntries(
    [...candidates.entries()].filter(([, value]) => value).sort(([left], [right]) => left.localeCompare(right)),
  ));
}

/**
 * Resolve the storage key for one pursuit decision from any supported entry.
 *
 * Preference order:
 *   1. explicit matter_ref / procurement_id that is already canonical
 *   2. canonical /procurements/{encoded-id} route
 *   3. proven single notice→procurement subject alias
 *   4. unambiguous source-alias index hit
 *   5. notice request_id (kept as notice identity when no trustworthy join)
 *   6. caller-supplied legacy token (returned unchanged for migration)
 */
export function resolvePursuitMatterRef(input = {}, {
  subjectsLookup = null,
  sourceAliasIndex = null,
} = {}) {
  const row = input && typeof input === "object" ? input : {};
  const explicitProcurement = procurementId(row.matter_ref)
    || procurementId(row.procurement_id)
    || procurementId(row.canonical_id);
  if (explicitProcurement) {
    return {
      matter_ref: explicitProcurement,
      kind: PURSUIT_MATTER_KIND.PROCUREMENT,
      canonical_href: procurementCanonicalHref(explicitProcurement),
      notice_id: null,
      alias_basis: "procurement_id",
    };
  }

  const fromPath = pursuitMatterRefFromProcurementPath(row.pathname || row.canonical_href || row.href);
  if (fromPath) {
    return {
      matter_ref: fromPath,
      kind: PURSUIT_MATTER_KIND.PROCUREMENT,
      canonical_href: procurementCanonicalHref(fromPath),
      notice_id: null,
      alias_basis: "canonical_route",
    };
  }

  const requestId = noticeId(row.request_id || row.notice_id || row.matter_ref);
  if (requestId) {
    const subjects = noticeProcurementSubjectsForId(subjectsLookup, requestId);
    if (subjects.length === 1) {
      const subject = subjects[0];
      return {
        matter_ref: subject.procurement_id,
        kind: PURSUIT_MATTER_KIND.PROCUREMENT,
        canonical_href: subject.href || procurementCanonicalHref(subject.procurement_id),
        notice_id: requestId,
        alias_basis: subject.relation_basis || "notice_subject",
      };
    }
    return {
      matter_ref: requestId,
      kind: PURSUIT_MATTER_KIND.NOTICE,
      canonical_href: `/notices/${encodeURIComponent(requestId)}`,
      notice_id: requestId,
      alias_basis: subjects.length ? "notice_multi_subject" : "notice_unjoined",
    };
  }

  const legacyToken = clean(row.matter_ref || row.solicitation_id || row.contract_reporter_number, 200);
  if (legacyToken && sourceAliasIndex && typeof sourceAliasIndex === "object") {
    const keyed = sourceAliasIndex[legacyToken]
      || (row.solicitation_id ? sourceAliasIndex[`solicitation:${clean(row.solicitation_id, 80)}`] : null)
      || (row.contract_reporter_number
        ? sourceAliasIndex[`contract_reporter_number:${clean(row.contract_reporter_number, 80)}`]
        : null);
    const canonical = procurementId(keyed);
    if (canonical) {
      return {
        matter_ref: canonical,
        kind: PURSUIT_MATTER_KIND.PROCUREMENT,
        canonical_href: procurementCanonicalHref(canonical),
        notice_id: null,
        alias_basis: "source_alias",
        legacy_key: legacyToken,
      };
    }
  }

  if (legacyToken) {
    return {
      matter_ref: legacyToken,
      kind: PURSUIT_MATTER_KIND.LEGACY,
      canonical_href: null,
      notice_id: null,
      alias_basis: "legacy_token",
      legacy_key: legacyToken,
    };
  }

  return null;
}

/** True when a notice should expose pursuit controls on its published detail path. */
export function noticeSupportsPursuitControls(row = {}, subjects = []) {
  if (Array.isArray(subjects) && subjects.length) return true;
  const section = clean(row.section_name, 120)?.toLowerCase() || "";
  const type = clean(row.type_of_notice_description, 120)?.toLowerCase() || "";
  if (section === "procurement") return true;
  return /solicitation|award|intention to award|contract award|vendor list|concept report/.test(type);
}
