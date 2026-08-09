// Publisher-backed agency leadership entities.
//
// The NYC agency crosswalk is the authority for the current principal officer
// of an agency. This module turns that row into a typed person-leader entity;
// it does not infer leadership from a name, title, or organizational proximity.

import { agencyCanonicalId } from "../normalizers/agency.mjs";

export const PERSON_LEADER_ENTITY_TYPE = "person-leader";
export const AGENCY_HEAD_ENTITY_TYPE = PERSON_LEADER_ENTITY_TYPE;
export const PERSON_LEADER_TYPE_FAMILY = PERSON_LEADER_ENTITY_TYPE;
export const PERSON_LEADER_PRIMARY_KEY_PATTERN = "person-leader:{agency_id}:{person_id|name}";
export const PERSON_LEADER_RESOLUTION_METHOD = "agency_crosswalk_head_v1";

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

function normalized(value) {
  return clean(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’']/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function crosswalkEntries(crosswalk) {
  const entries = crosswalk?.entries ?? crosswalk;
  return entries && typeof entries === "object" && !Array.isArray(entries) ? entries : {};
}

function agencyEntry({ agencyId = "", agencyName = "", crosswalk = null } = {}) {
  const entries = crosswalkEntries(crosswalk);
  const requestedId = clean(agencyId).replace(/^agency:id:/, "");
  if (requestedId && entries[requestedId]) return { agencyId: requestedId, entry: entries[requestedId] };

  const requestedKey = normalized(agencyName);
  if (!requestedKey) return { agencyId: requestedId, entry: null };
  const match = Object.entries(entries).find(([, entry]) =>
    normalized(entry?.canonical_name) === requestedKey
    || normalized(entry?.acronym) === requestedKey,
  );
  if (match) return { agencyId: match[0], entry: match[1] };

  const canonicalId = agencyCanonicalId(agencyName);
  return canonicalId && entries[canonicalId]
    ? { agencyId: canonicalId, entry: entries[canonicalId] }
    : { agencyId: canonicalId, entry: null };
}

function personKey({ personId = "", personName = "" } = {}) {
  const id = clean(personId);
  if (id) return `id:${encodeURIComponent(id)}`;
  const name = normalized(personName);
  return name ? `name:${encodeURIComponent(name)}` : "";
}

/** Stable identity for one person serving as an agency's publisher-backed head. */
export function personLeaderEntityId({ agencyId = "", personId = "", personName = "" } = {}) {
  const agency = clean(agencyId).replace(/^agency:id:/, "");
  const person = personKey({ personId, personName });
  return agency && person ? `${PERSON_LEADER_ENTITY_TYPE}:${agency}:${person}` : null;
}

/** Convert one crosswalk entry into a public-safe person-leader entity. */
export function buildPersonLeaderEntity({
  agencyId = "",
  agencyName = "",
  headName = "",
  headTitle = "",
  personId = "",
  source = null,
} = {}) {
  const name = clean(headName);
  const agency = clean(agencyId).replace(/^agency:id:/, "");
  if (!agency || !name) return null;
  const id = personLeaderEntityId({ agencyId: agency, personId, personName: name });
  if (!id) return null;
  return {
    id,
    entity_type: PERSON_LEADER_ENTITY_TYPE,
    display_name: name,
    role: clean(headTitle) || null,
    agency_id: agency,
    agency_name: clean(agencyName) || null,
    confidence: { status: "strong", basis: "publisher_record" },
    ...(source ? { source } : {}),
  };
}

/** Materialize all named heads with complete publisher rows. */
export function buildAgencyHeadEntities(crosswalk, { source = null } = {}) {
  return Object.entries(crosswalkEntries(crosswalk)).map(([agencyId, entry]) =>
    buildPersonLeaderEntity({
      agencyId,
      agencyName: entry?.canonical_name,
      headName: entry?.head_name,
      headTitle: entry?.head_title,
      source,
    }),
  ).filter(Boolean);
}

const ROLE_WORDS = Object.freeze([
  "first deputy commissioner", "deputy commissioner", "assistant commissioner",
  "commissioner", "chancellor", "administrator", "director", "chair",
  "president", "chief executive officer", "corporation counsel", "mayor",
  "comptroller", "public advocate", "district attorney", "chief medical examiner",
  "special narcotics prosecutor",
]);

function roleMention(text) {
  const value = normalized(text);
  return [...ROLE_WORDS]
    .sort((left, right) => right.length - left.length)
    .find((role) => new RegExp(`\\b${role}\\b`, "i").test(value)) || "";
}

function mentionMatches(text, name) {
  const haystack = normalized(text);
  const needle = normalized(name);
  return Boolean(needle && new RegExp(`(?:^|\\s)${needle.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}(?:$|\\s)`, "i").test(haystack));
}

function leaderCandidates({
  agencyId = "",
  agencyName = "",
  agency_id: agencyIdAlias = "",
  agency: agencyAlias = "",
  crosswalk = null,
  leaders = [],
} = {}) {
  if (Array.isArray(leaders) && leaders.length) return leaders.filter((leader) => leader?.id);
  const selected = agencyEntry({
    agencyId: agencyId || agencyIdAlias,
    agencyName: agencyName || agencyAlias,
    crosswalk,
  });
  if (selected.entry) {
    const entity = buildPersonLeaderEntity({
      agencyId: selected.agencyId,
      agencyName: selected.entry.canonical_name,
      headName: selected.entry.head_name,
      headTitle: selected.entry.head_title,
    });
    return entity ? [entity] : [];
  }
  return buildAgencyHeadEntities(crosswalk);
}

/**
 * Resolve a named leader or a role referent such as "the commissioner".
 * Role-only mentions require an agency scope and a matching publisher title;
 * a global role mention is intentionally unresolved.
 */
export function resolveLeadershipReferent(referent, context = {}) {
  const text = clean(referent);
  if (!text) return null;
  const candidates = leaderCandidates(context);
  const named = candidates.filter((candidate) => mentionMatches(text, candidate.display_name || candidate.name));
  if (named.length === 1) {
    return {
      referent: text,
      entity: named[0],
      confidence: { status: "strong", basis: "publisher_record" },
      method: "exact_head_name",
    };
  }

  const role = roleMention(text);
  const hasAgencyScope = context.agencyId || context.agencyName || context.agency_id || context.agency;
  if (!role || !hasAgencyScope) return null;
  const roleMatches = candidates.filter((candidate) =>
    normalized(candidate.role || candidate.head_title).includes(role),
  );
  if (roleMatches.length !== 1) return null;
  return {
    referent: text,
    entity: roleMatches[0],
    confidence: { status: "strong", basis: "publisher_record" },
    method: "agency_scoped_role",
  };
}
