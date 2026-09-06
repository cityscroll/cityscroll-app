/**
 * Exact-institution follow scope.
 *
 * One selected public body travels from the profile action through preview,
 * save, reload, matching, and delivery. Related bodies stay links, not extra
 * subscriptions. A stored name-only watch keeps that stored name; a reviewed
 * identity correction is offered explicitly and never applied in silence.
 */

import {
  AGENCY_IDENTITY_CORRECTIONS,
  agencyIdentityCorrection,
  canonicalAgency,
  resolveAgencyIdentity,
} from "./agency_identity.mjs";
import { institutionClassification } from "./civic_institution_classification.mjs";
import {
  communityBoardLabel,
  normalizeCommunityBoardRef,
} from "./community_board_watch.mjs";

export const INSTITUTION_FOLLOW_SCOPE_SCHEMA = "cityscroll.institution_follow_scope.v1";
export const INSTITUTION_FOLLOW_SCOPE_METHOD = "exact_institution_follow_v1";
export const INSTITUTION_FOLLOW_RECORD_SCOPE =
  "City Record notices this body publishes, in every section. Connected bodies are not included.";
export const COMMUNITY_BOARD_FOLLOW_RECORD_SCOPE =
  "Meetings published for this Community Board. The district, borough office, and borough board are not included.";

function clean(value, max = 240) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function unique(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const text = clean(value, 240);
    const key = text.toLocaleLowerCase("en-US");
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function freeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (!value || typeof value !== "object") return value;
  return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, freeze(item)]),
  ));
}

function canonicalIdOf(value) {
  const text = clean(value, 160);
  if (!text) return "";
  const board = normalizeCommunityBoardRef(text)
    || normalizeCommunityBoardRef(`community-board:${text.replace(/^community-board:/, "")}`);
  if (board) return board.replace(/^community-board:/, "");
  return text
    .replace(/^agency:id:/, "")
    .replace(/^civic-institution:/, "")
    .toLowerCase();
}

function isCommunityBoardId(value) {
  return /^[a-z]+(?:-[a-z]+)*-cb-\d{2}$/.test(canonicalIdOf(value));
}

const RELATED_BY_ID = Object.freeze({
  "city-planning": Object.freeze(["city-planning-commission"]),
  "city-planning-commission": Object.freeze(["city-planning"]),
  "metropolitan-transportation-authority": Object.freeze([
    "n-y-c-transit-authority",
    "long-island-rail-road",
    "mta-construction-and-development",
    "triborough-bridge-and-tunnel-authority",
  ]),
  "n-y-c-transit-authority": Object.freeze(["metropolitan-transportation-authority"]),
  "long-island-rail-road": Object.freeze(["metropolitan-transportation-authority"]),
  "mta-construction-and-development": Object.freeze(["metropolitan-transportation-authority"]),
  "triborough-bridge-and-tunnel-authority": Object.freeze(["metropolitan-transportation-authority"]),
  "borough-president-brooklyn": Object.freeze(["brooklyn-borough-board", "brooklyn-cb-15"]),
  "brooklyn-cb-15": Object.freeze(["borough-president-brooklyn", "brooklyn-borough-board"]),
});

export function relatedInstitutionIds(value) {
  const id = canonicalIdOf(value);
  return Object.freeze([...(RELATED_BY_ID[id] || [])]);
}

function publisherNamesForInstitution(canonicalId) {
  const identity = resolveAgencyIdentity(canonicalId);
  if (!identity?.canonical_id || identity.canonical_id !== canonicalId) return [];
  const related = new Set(relatedInstitutionIds(canonicalId));
  return unique([
    identity.canonical_name,
    ...(Array.isArray(identity.variants) ? identity.variants : []),
  ]).filter((name) => {
    const resolved = resolveAgencyIdentity(name);
    const id = resolved?.canonical_id;
    return id === canonicalId && !related.has(id);
  });
}

function communityBoardFollow(value) {
  const bodyId = canonicalIdOf(value);
  const ref = normalizeCommunityBoardRef(`community-board:${bodyId}`);
  const name = communityBoardLabel(ref);
  if (!ref || !name) {
    return freeze({
      schema: INSTITUTION_FOLLOW_SCOPE_SCHEMA,
      method: INSTITUTION_FOLLOW_SCOPE_METHOD,
      status: "unsupported",
      attempted: true,
      lens: null,
      filter: {},
      reason: "Community Board identity is missing or not canonical",
    });
  }
  return freeze({
    schema: INSTITUTION_FOLLOW_SCOPE_SCHEMA,
    method: INSTITUTION_FOLLOW_SCOPE_METHOD,
    status: "ok",
    attempted: true,
    capability: "community-board-meetings",
    matching_mode: "community_board",
    lens: "meetings",
    filter: { communityBoard: ref },
    canonical_id: bodyId,
    canonical_name: name,
    kind_label: "Community board",
    subject_ref: ref,
    follow_label: `Follow ${name}`,
    record_scope: COMMUNITY_BOARD_FOLLOW_RECORD_SCOPE,
    rule_sentence: `Notify me when meetings for ${name} are published.`,
    related_ids: relatedInstitutionIds(bodyId),
    publisher_names: [name],
    correction: null,
  });
}

function agencyFollow(canonicalId) {
  const identity = resolveAgencyIdentity(canonicalId);
  if (!identity?.canonical_id || !identity.canonical_name) {
    return freeze({
      schema: INSTITUTION_FOLLOW_SCOPE_SCHEMA,
      method: INSTITUTION_FOLLOW_SCOPE_METHOD,
      status: "unsupported",
      attempted: true,
      lens: null,
      filter: {},
      reason: "Institution identity is missing",
    });
  }
  const name = identity.canonical_name;
  const ref = `agency:id:${identity.canonical_id}`;
  const kindLabel = institutionClassification(identity.canonical_id)?.kind_label || "Public body";
  return freeze({
    schema: INSTITUTION_FOLLOW_SCOPE_SCHEMA,
    method: INSTITUTION_FOLLOW_SCOPE_METHOD,
    status: "ok",
    attempted: true,
    capability: "exact-institution-records",
    matching_mode: "canonical_id",
    lens: "entity",
    filter: {
      kind: "agency",
      name,
      entity_refs_all: [ref],
    },
    canonical_id: identity.canonical_id,
    canonical_name: name,
    kind_label: kindLabel,
    subject_ref: ref,
    follow_label: `Follow ${name}`,
    record_scope: INSTITUTION_FOLLOW_RECORD_SCOPE,
    rule_sentence: `Notify me when City Record notices published by ${name} appear.`,
    related_ids: relatedInstitutionIds(identity.canonical_id),
    publisher_names: publisherNamesForInstitution(identity.canonical_id),
    correction: null,
  });
}

/** New follow for one selected institution. Relationships never enter the filter. */
export function exactInstitutionFollow(value) {
  const id = canonicalIdOf(value);
  if (!id) {
    return freeze({
      schema: INSTITUTION_FOLLOW_SCOPE_SCHEMA,
      method: INSTITUTION_FOLLOW_SCOPE_METHOD,
      status: "unsupported",
      attempted: false,
      lens: null,
      filter: {},
      reason: "No institution was selected",
    });
  }
  if (isCommunityBoardId(id)) return communityBoardFollow(id);
  return agencyFollow(id);
}

function agencyRefsFromFilter(filter = {}) {
  const refs = Array.isArray(filter.entity_refs_all) ? filter.entity_refs_all : [];
  return unique(refs.map((ref) => String(ref || "").trim()).filter((ref) => /^agency:id:[a-z0-9][a-z0-9.-]*$/.test(ref)));
}

function storedNameCorrection(name) {
  const correction = agencyIdentityCorrection(name);
  if (!correction) return null;
  const listed = AGENCY_IDENTITY_CORRECTIONS.find((row) => (
    row.source_spelling === correction.source_spelling
    && row.corrected_id === correction.corrected_id
  ));
  const row = listed || correction;
  return freeze({
    stored_name: clean(name, 240),
    corrected_id: row.corrected_id,
    corrected_name: row.corrected_name,
    superseded_id: row.superseded_id,
    superseded_name: row.superseded_name,
    basis: row.basis,
    offer: `This watch still uses the stored name ${clean(name, 240)}. ${row.corrected_name} is now a separate body from ${row.superseded_name}. Updating it is a new follow you choose; the saved selection is not reassigned.`,
    follow: exactInstitutionFollow(row.corrected_id),
  });
}

/**
 * Read a stored watch without rewriting it.
 *
 * Name-only agency watches keep exact stored-name matching. A reviewed
 * correction is attached as an offer, never applied to the filter.
 */
export function interpretStoredInstitutionFollow(input = {}) {
  const lens = String(input.lens || "").trim();
  const filter = input.filter && typeof input.filter === "object" ? input.filter : {};
  if (lens === "meetings" && filter.communityBoard) {
    const stored = communityBoardFollow(filter.communityBoard);
    if (stored.status !== "ok") return stored;
    return freeze({
      ...stored,
      filter: { communityBoard: filter.communityBoard },
      matching_mode: "community_board",
    });
  }
  if (lens !== "entity" || filter.kind !== "agency") {
    return freeze({
      schema: INSTITUTION_FOLLOW_SCOPE_SCHEMA,
      method: INSTITUTION_FOLLOW_SCOPE_METHOD,
      status: "not_institution",
      attempted: false,
      lens,
      filter,
    });
  }
  const refs = agencyRefsFromFilter(filter);
  if (refs.length > 1) {
    return freeze({
      schema: INSTITUTION_FOLLOW_SCOPE_SCHEMA,
      method: INSTITUTION_FOLLOW_SCOPE_METHOD,
      status: "unsupported",
      attempted: true,
      lens: "entity",
      filter,
      reason: "Multiple institution references are not a group follow and are not compiled as a union",
    });
  }
  const name = clean(filter.name, 120);
  if (refs.length === 1) {
    const id = refs[0].slice("agency:id:".length);
    const exact = exactInstitutionFollow(id);
    if (exact.status !== "ok") return exact;
    return freeze({
      ...exact,
      filter: {
        kind: "agency",
        name: name || exact.canonical_name,
        entity_refs_all: [refs[0]],
      },
      matching_mode: "canonical_id",
      correction: null,
    });
  }
  if (!name || name === "an agency") {
    return freeze({
      schema: INSTITUTION_FOLLOW_SCOPE_SCHEMA,
      method: INSTITUTION_FOLLOW_SCOPE_METHOD,
      status: "placeholder",
      attempted: true,
      lens: "entity",
      filter: { kind: "agency", name: name || "an agency" },
      matching_mode: "stored_name",
      canonical_name: name || "an agency",
      follow_label: "Follow an agency",
      record_scope: INSTITUTION_FOLLOW_RECORD_SCOPE,
      rule_sentence: "Notify me when public records name an agency.",
      related_ids: [],
      publisher_names: [],
      correction: null,
    });
  }
  return freeze({
    schema: INSTITUTION_FOLLOW_SCOPE_SCHEMA,
    method: INSTITUTION_FOLLOW_SCOPE_METHOD,
    status: "ok",
    attempted: true,
    capability: "stored-name-agency-records",
    matching_mode: "stored_name",
    lens: "entity",
    filter: { kind: "agency", name },
    canonical_id: null,
    canonical_name: name,
    kind_label: "Public body",
    subject_ref: null,
    follow_label: `Follow ${name}`,
    record_scope: INSTITUTION_FOLLOW_RECORD_SCOPE,
    rule_sentence: `Notify me when City Record notices published by ${name} appear.`,
    related_ids: [],
    publisher_names: [name],
    correction: storedNameCorrection(name),
  });
}

export function exactInstitutionFollowHref(value, { frequency = "weekly", followingUrlFromWatch } = {}) {
  const exact = exactInstitutionFollow(value);
  if (exact.status !== "ok" || typeof followingUrlFromWatch !== "function") return "/following/";
  return followingUrlFromWatch(
    { lens: exact.lens, filter: exact.filter },
    { frequency },
  );
}

export function sodaAgencyNameClause(names) {
  const list = unique(Array.isArray(names) ? names : [names]);
  if (!list.length) return null;
  const clauses = list.map((name) => `agency_name='${name.replace(/'/g, "''")}'`);
  return clauses.length === 1 ? clauses[0] : `(${clauses.join(" OR ")})`;
}

/** True when a City Record row belongs to this exact stored institution follow. */
export function exactInstitutionNoticeMatches(follow, row = {}) {
  if (!follow || follow.status !== "ok") return false;
  const publishedAs = clean(row.agency_name || row.agency, 240);
  if (!publishedAs) return false;
  if (follow.matching_mode === "stored_name") {
    return publishedAs === follow.canonical_name;
  }
  if (follow.matching_mode !== "canonical_id" || !follow.canonical_id) return false;
  const resolved = canonicalAgency(publishedAs);
  if (resolved.canonical_id !== follow.canonical_id) return false;
  return !follow.related_ids.includes(resolved.canonical_id);
}

export function institutionFollowUnsupportedGroup(filter = {}) {
  return agencyRefsFromFilter(filter).length > 1;
}
