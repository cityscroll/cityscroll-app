/**
 * Source-qualified person projection and capability boundary.
 *
 * This module is deliberately additive. It does not rewrite a source
 * identity, publish a person route, or merge source rows. A generic person is
 * the smallest source-qualified unit; a reviewed same-person assertion is
 * the only mechanism that can attach two such units to a public canonical
 * reference.
 */

export const PERSON_PROJECTION_SCHEMA = "cityscroll.person.v1";
export const PERSON_IDENTITY_LINK_SCHEMA = "person_identity_link.v1";
export const PERSON_IDENTITY_LINK_VERSION = "1.0.0";
export const PERSON_IDENTITY_LINK_RELATION = "same_person";
export const PERSON_IDENTITY_LINK_METHOD = "explicit_reviewed_assertion";

export const PERSON_LINK_STATUSES = Object.freeze(["candidate", "accepted", "rejected"]);
export const PERSON_PROFILE_FAMILIES = Object.freeze([
  "generic-person",
  "council-person-alias",
  "community-board-person",
  "agency-person",
  "vendor-contact",
]);

// These are capability names, not display labels. In particular, none of the
// generic person families receive Council capabilities merely because their
// display name matches an official. The legacy `official` object remains the
// sole owner of the Council profile surface.
export const PERSON_CAPABILITIES = Object.freeze([
  "person.identity",
  "community-board.roles",
  "agency.person-role",
  "vendor.contact",
]);
export const COUNCIL_ONLY_CAPABILITIES = Object.freeze([
  "council.votes",
  "council.committee-memberships",
  "council.lobbying",
  "council.campaign-finance",
  "council.official-profile",
]);

const PROFILE_CAPABILITIES = Object.freeze({
  "generic-person": Object.freeze(["person.identity"]),
  "council-person-alias": Object.freeze(["person.identity"]),
  "community-board-person": Object.freeze(["person.identity", "community-board.roles"]),
  "agency-person": Object.freeze(["person.identity", "agency.person-role"]),
  "vendor-contact": Object.freeze(["person.identity", "vendor.contact"]),
});

// The source-qualified legacy object is intentionally represented separately;
// this allowlist is never consulted for a generic person projection.
const LEGACY_PROFILE_CAPABILITIES = Object.freeze({
  "council-official": Object.freeze([
    "council.votes",
    "council.committee-memberships",
    "council.lobbying",
    "council.campaign-finance",
    "council.official-profile",
  ]),
});

const COUNCIL_OFFICIAL_ID = /^official:([^:\s]+)$/;
const GENERIC_PERSON_ID = /^person:([^:\s]+):(.+)$/;

function clean(value, max = 500) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function token(value, field, max = 160, { lowercase = true } = {}) {
  const result = clean(value, max);
  if (!result || /\s/.test(result) || result.includes("/")) {
    throw new TypeError(`${field} must be a non-empty identity token`);
  }
  return lowercase ? result.toLowerCase() : result;
}

function timestamp(value, field, { required = false } = {}) {
  const result = clean(value, 80);
  if (!result) {
    if (required) throw new TypeError(`${field} is required`);
    return null;
  }
  if (Number.isNaN(Date.parse(result))) throw new TypeError(`${field} must be an ISO timestamp`);
  return result;
}

function sourceQualifiedId(value) {
  const id = clean(value, 320);
  return GENERIC_PERSON_ID.test(id) ? id : null;
}

/** Build one immutable generic identity without using its display name. */
export function personIdentity({
  sourceNamespace,
  sourceScope = null,
  nativeKey,
  issuer = sourceNamespace,
} = {}) {
  const namespace = token(sourceNamespace, "source_namespace");
  const issuerToken = token(issuer, "issuer");
  const scope = token(sourceScope || namespace, "source_scope");
  const key = token(nativeKey, "native_key", 240, { lowercase: false });
  const identityId = scope === namespace
    ? `person:${namespace}:${key}`
    : `person:${namespace}:${scope}:${key}`;
  return Object.freeze({
    schema: PERSON_PROJECTION_SCHEMA,
    id: identityId,
    source_namespace: namespace,
    source_scope: scope,
    native_key: key,
    issuer: issuerToken,
  });
}

export const buildPersonIdentity = personIdentity;

export function parsePersonIdentity(value) {
  const id = sourceQualifiedId(value);
  if (!id) return null;
  const [, sourceNamespace, remainder] = id.match(GENERIC_PERSON_ID);
  const parts = remainder.split(":");
  if (parts.length < 1 || parts.some((part) => !part || /\s/.test(part))) return null;
  const sourceScope = parts.length > 1 ? parts.shift() : sourceNamespace;
  return Object.freeze({
    id,
    source_namespace: sourceNamespace,
    source_scope: sourceScope,
    native_key: parts.join(":"),
  });
}

export function isPersonIdentity(value) {
  return Boolean(parsePersonIdentity(value));
}

function normalizeProfileFamily(value) {
  const family = clean(value, 80).toLowerCase();
  if (!PERSON_PROFILE_FAMILIES.includes(family)) {
    throw new TypeError(`unknown person profile family: ${family || "(missing)"}`);
  }
  return family;
}

function alias(sourceIdentity, sourceKind, sourceHref = null) {
  const id = clean(sourceIdentity, 320);
  if (!id || /\s/.test(id)) throw new TypeError("source alias identity is required");
  return Object.freeze({
    identity: id,
    source_kind: clean(sourceKind, 80) || null,
    compatibility_href: clean(sourceHref, 500) || null,
  });
}

/**
 * Project an existing source identity into the generic envelope. The source
 * alias is retained verbatim and canonical_person_ref is always empty here.
 */
export function projectPerson({
  identity,
  sourceIdentity = null,
  sourceKind = null,
  sourceHref = null,
  displayName = null,
  profileFamily = "generic-person",
  observedAt = null,
  sourceObservationRefs = [],
} = {}) {
  const parsedId = identity?.id || identity;
  const parsedBase = parsePersonIdentity(parsedId);
  if (!parsedBase?.id) throw new TypeError("a source-qualified person identity is required");
  const parsed = {
    ...parsedBase,
    issuer: token(identity?.issuer || parsedBase.source_namespace, "issuer"),
  };
  const refs = [...new Set((Array.isArray(sourceObservationRefs) ? sourceObservationRefs : [])
    .map((ref) => clean(ref, 320))
    .filter(Boolean))];
  return Object.freeze({
    schema: PERSON_PROJECTION_SCHEMA,
    object_type: "person",
    person_ref: parsed.id,
    identity: parsed,
    source_alias: sourceIdentity ? alias(sourceIdentity, sourceKind, sourceHref) : null,
    profile_family: normalizeProfileFamily(profileFamily),
    display_name: clean(displayName, 500) || null,
    canonical_person_ref: null,
    provenance: Object.freeze({
      source_identity: sourceIdentity || parsed.id,
      source_observation_refs: Object.freeze(refs),
      observed_at: timestamp(observedAt, "observed_at"),
      identity_basis: "source_namespace_scope_native_key",
    }),
  });
}

/** Additive alias for the immutable Council `official:{PersonId}` identity. */
export function projectCouncilOfficialAlias({
  personId,
  displayName = null,
  observedAt = null,
  sourceObservationRefs = [],
} = {}) {
  const id = clean(personId, 120);
  if (!id || !COUNCIL_OFFICIAL_ID.test(`official:${id}`)) {
    throw new TypeError("Council PersonId is required");
  }
  return projectPerson({
    identity: personIdentity({ sourceNamespace: "legistar", sourceScope: "legistar", nativeKey: id, issuer: "nyc-council" }),
    sourceIdentity: `official:${id}`,
    sourceKind: "official",
    sourceHref: `/officials/${encodeURIComponent(id)}/`,
    displayName,
    profileFamily: "council-person-alias",
    observedAt,
    sourceObservationRefs,
  });
}

/** Additive alias for the immutable board-local Community Board identity. */
export function projectCommunityBoardPersonAlias({
  boardId,
  personKey,
  displayName = null,
  observedAt = null,
  sourceObservationRefs = [],
} = {}) {
  const board = clean(boardId, 120).toLowerCase();
  const key = clean(personKey, 240);
  if (!/^[a-z]+(?:-[a-z]+)*-cb-\d{2}$/.test(board)
      || !key || /\s/.test(key) || key.toLowerCase() === board) {
    throw new TypeError("Community Board identity requires a board id and publisher person key");
  }
  const sourceIdentity = `community-board-person:${board}:${key}`;
  return projectPerson({
    identity: personIdentity({ sourceNamespace: "community-board", sourceScope: board, nativeKey: key, issuer: "community-board-publisher" }),
    sourceIdentity,
    sourceKind: "community-board-person",
    displayName,
    profileFamily: "community-board-person",
    observedAt,
    sourceObservationRefs,
  });
}

function normalizedEvidence(evidence) {
  if (!Array.isArray(evidence) || evidence.length === 0) {
    throw new TypeError("same_person links require evidence");
  }
  return evidence.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new TypeError(`evidence[${index}] must be an inspectable object`);
    }
    const sourceRef = clean(item.source_ref || item.source_record_id || item.source_url, 500);
    if (!sourceRef) throw new TypeError(`evidence[${index}] requires a source locator`);
    return Object.freeze({
      source_ref: sourceRef,
      source_url: clean(item.source_url, 2_000) || null,
      excerpt: clean(item.excerpt, 2_000) || null,
      observed_at: timestamp(item.observed_at, `evidence[${index}].observed_at`),
      fields: Object.freeze(Array.isArray(item.fields) ? item.fields.map((field) => clean(field, 120)).filter(Boolean) : []),
    });
  });
}

/** Build an evidence-bearing link; no name-based link helper exists. */
export function buildPersonIdentityLink({
  leftIdentity,
  rightIdentity,
  status,
  evidence,
  observedAt,
  reviewedAt = null,
  canonicalPersonRef = null,
} = {}) {
  const left = sourceQualifiedId(leftIdentity);
  const right = sourceQualifiedId(rightIdentity);
  if (!left || !right) throw new TypeError("same_person endpoints must be generic person identities");
  if (left === right) throw new TypeError("same_person endpoints must be distinct");
  if (!PERSON_LINK_STATUSES.includes(status)) throw new TypeError(`invalid same_person status: ${status || "(missing)"}`);
  const evidenceRows = normalizedEvidence(evidence);
  const canonical = clean(canonicalPersonRef, 320) || null;
  if (canonical && !sourceQualifiedId(canonical)) throw new TypeError("canonical_person_ref must be a generic person identity");
  return Object.freeze({
    schema: PERSON_IDENTITY_LINK_SCHEMA,
    version: PERSON_IDENTITY_LINK_VERSION,
    left_identity: left,
    right_identity: right,
    relation: PERSON_IDENTITY_LINK_RELATION,
    status,
    method: PERSON_IDENTITY_LINK_METHOD,
    evidence: Object.freeze(evidenceRows),
    observed_at: timestamp(observedAt, "observed_at", { required: true }),
    reviewed_at: timestamp(reviewedAt, "reviewed_at"),
    canonical_person_ref: status === "accepted" ? canonical : null,
    provenance: Object.freeze({
      evidence_count: evidenceRows.length,
      evidence_refs: Object.freeze(evidenceRows.map(({ source_ref }) => source_ref)),
      review_required: true,
    }),
  });
}

export const personIdentityLink = buildPersonIdentityLink;

/** Candidate and rejected evidence never populate this public field. */
export function acceptedCanonicalPersonRef(link, identity = null) {
  if (link?.schema !== PERSON_IDENTITY_LINK_SCHEMA || link.status !== "accepted") return null;
  const canonical = sourceQualifiedId(link.canonical_person_ref);
  if (!canonical) return null;
  if (identity && identity !== link.left_identity && identity !== link.right_identity) return null;
  return canonical;
}

export function applyAcceptedPersonLink(person, link) {
  const canonical = acceptedCanonicalPersonRef(link, person?.person_ref);
  return canonical ? Object.freeze({ ...person, canonical_person_ref: canonical }) : person;
}

/**
 * Explicit capability boundary. Generic person projections never select the
 * Council surfaces; only the legacy official object with the Council family
 * can do so, and it must retain an exact `official:{PersonId}` source id.
 */
export function allowedPersonCapabilities(subject = {}) {
  const objectType = clean(subject.object_type, 80);
  const family = clean(subject.profile_family, 80).toLowerCase();
  if (objectType === "person") return Object.freeze([...(PROFILE_CAPABILITIES[family] || [])]);
  if (objectType === "official" && COUNCIL_OFFICIAL_ID.test(clean(subject.id, 160))) {
    return Object.freeze([...(LEGACY_PROFILE_CAPABILITIES[family] || [])]);
  }
  return Object.freeze([]);
}

export const personCapabilities = allowedPersonCapabilities;

export function canUsePersonCapability(subject, capability) {
  return allowedPersonCapabilities(subject).includes(capability);
}

export function councilOfficialHref(subject = {}) {
  if (!canUsePersonCapability(subject, "council.official-profile")) return null;
  const match = clean(subject.id, 160).match(COUNCIL_OFFICIAL_ID);
  return match ? `/officials/${encodeURIComponent(match[1])}/` : null;
}

export function canLoadCouncilSurface(subject, capability = "council.official-profile") {
  return canUsePersonCapability(subject, capability);
}
