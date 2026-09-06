/**
 * Shared resident identity projection for public institutions.
 *
 * Directory, search, People & organizations, profile headings and selected
 * scope labels have to describe the same body in the same useful terms. This
 * module is that shared read: it reuses the reviewed browse classification
 * and the existing agency identity contract, and it never renames a stored
 * identifier, source key or bookmarked scope.
 *
 * A body with no reviewed type still has a name and a destination. It does
 * not receive a guessed badge, a generic "City agency organization" line, or
 * an empty metadata row.
 */

import { resolveAgencyIdentity } from "./agency_identity.mjs";
import { reviewedAgencyAcronyms } from "./canonical_entity_interpretation.mjs";
import {
  projectCommunityBoardClassification,
  projectInstitutionClassification,
} from "./civic_institution_classification_project.mjs";

export const CIVIC_INSTITUTION_RESIDENT_IDENTITY_SCHEMA =
  "cityscroll.civic_institution_resident_identity.v1";
export const CIVIC_INSTITUTION_RESIDENT_IDENTITY_METHOD =
  "reviewed_resident_identity_projection_v1";
export const CIVIC_INSTITUTION_RESIDENT_IDENTITY_ANCHOR = "institution-resident-identity";

function clean(value, max = 500) {
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

function canonicalIdOf(value) {
  return clean(value, 160)
    .replace(/^agency:id:/, "")
    .replace(/^civic-institution:/, "")
    .toLowerCase();
}

function publisherSurfaces(publisherRow) {
  if (!publisherRow || typeof publisherRow !== "object") return [];
  return unique([
    ...(Array.isArray(publisherRow.former_names) ? publisherRow.former_names : []),
    ...(Array.isArray(publisherRow.former_acronyms) ? publisherRow.former_acronyms : []),
    ...(Array.isArray(publisherRow.variants) ? publisherRow.variants : []),
    publisherRow.acronym,
  ]);
}

function formerSurfaces(publisherRow, currentNames) {
  const current = new Set(currentNames.map((name) => name.toLocaleLowerCase("en-US")));
  return unique([
    ...(Array.isArray(publisherRow?.former_names) ? publisherRow.former_names : []),
    ...(Array.isArray(publisherRow?.former_acronyms) ? publisherRow.former_acronyms : []),
  ]).filter((name) => !current.has(name.toLocaleLowerCase("en-US")));
}

function descriptionOf(kindLabel, purpose) {
  if (kindLabel && purpose) return `${kindLabel}. ${purpose}`;
  return kindLabel || purpose || null;
}

function communityBoardId(value) {
  return /^[a-z]+(?:-[a-z]+)*-cb-\d{2}$/.test(canonicalIdOf(value));
}

/**
 * One institution's resident-facing identity, or null when the value is empty.
 *
 * `publisherRow` is the optional OTI/crosswalk card for this canonical id. It
 * supplies evidenced former names and acronyms so a historical spelling stays
 * discoverable without becoming the current display name.
 */
export function projectResidentInstitutionIdentity(value, {
  displayName = null,
  publisherRow = null,
  href = null,
} = {}) {
  const canonicalId = canonicalIdOf(value);
  if (!canonicalId) return null;
  const identity = resolveAgencyIdentity(canonicalId);
  const name = clean(displayName, 400)
    || clean(identity?.canonical_name, 400)
    || canonicalId;
  const classification = communityBoardId(canonicalId)
    ? projectCommunityBoardClassification(canonicalId, name)
    : projectInstitutionClassification(canonicalId, { canonicalName: name });
  const kindLabel = classification?.kind_label || null;
  const purpose = classification?.purpose || null;
  const currentNames = unique([name, identity?.canonical_name]);
  const formerNames = formerSurfaces(publisherRow, currentNames);
  const discoveryTerms = unique([
    name,
    identity?.canonical_name,
    ...(Array.isArray(identity?.variants) ? identity.variants : []),
    ...(classification?.acronyms || []),
    ...reviewedAgencyAcronyms(canonicalId),
    ...publisherSurfaces(publisherRow),
  ]);
  const route = href
    || (communityBoardId(canonicalId) ? null : `/agencies/${canonicalId}/`);
  return Object.freeze({
    schema: CIVIC_INSTITUTION_RESIDENT_IDENTITY_SCHEMA,
    method: CIVIC_INSTITUTION_RESIDENT_IDENTITY_METHOD,
    canonical_id: canonicalId,
    canonical_name: name,
    href: route,
    subject_ref: communityBoardId(canonicalId)
      ? `community-board:${canonicalId}`
      : `agency:id:${canonicalId}`,
    kind_label: kindLabel,
    purpose,
    description: descriptionOf(kindLabel, purpose),
    classified: Boolean(kindLabel),
    acronyms: Object.freeze(unique([
      ...(classification?.acronyms || []),
      ...reviewedAgencyAcronyms(canonicalId),
      publisherRow?.acronym,
    ])),
    former_names: Object.freeze(formerNames),
    discovery_terms: Object.freeze(discoveryTerms),
    successor_basis: clean(publisherRow?.successor_basis, 160) || null,
    stored_identifier: canonicalId,
  });
}

/** Search-result and People & organizations copy. Unclassified bodies omit it. */
export function residentInstitutionSummary(projection, { matchedCategories = null } = {}) {
  if (projection?.description) return projection.description;
  if (Number.isFinite(matchedCategories) && matchedCategories >= 0) {
    const noun = matchedCategories === 1 ? "category" : "categories";
    return `Public records in ${matchedCategories} connected ${noun}.`;
  }
  return null;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[<>&"']/g, (char) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

/**
 * First-paint kind and purpose for a profile heading.
 *
 * Statutory identity already renders this block for the two racial-equity
 * bodies, including the source history a correction preserved. Callers skip
 * this helper when that richer block is present so the same sentence is not
 * printed twice.
 */
export function renderResidentInstitutionIdentity(projection) {
  if (!projection?.kind_label && !projection?.purpose && !projection?.former_names?.length) {
    return "";
  }
  const kind = projection.kind_label
    ? `<span class="institution-statutory-kind-label">${escapeHtml(projection.kind_label)}</span>`
    : "";
  const purpose = projection.purpose ? escapeHtml(projection.purpose) : "";
  const lead = kind || purpose
    ? `<p class="institution-statutory-kind">${[kind, purpose].filter(Boolean).join(" · ")}</p>`
    : "";
  const former = projection.former_names?.length
    ? `<details class="institution-statutory-history" data-resident-former-names="1">
      <summary>Former names</summary>
      <p>Earlier records and notices keep the name they were published under. Current pages use the name in force now.</p>
      <ul class="institution-statutory-sources">${projection.former_names.map((name) => (
        `<li>${escapeHtml(name)}</li>`
      )).join("")}</ul>
      ${projection.successor_basis
        ? `<p class="muted node-muted">Successor evidence ${escapeHtml(projection.successor_basis)}.</p>`
        : ""}
    </details>`
    : "";
  return `<div class="institution-resident-identity" id="${escapeHtml(CIVIC_INSTITUTION_RESIDENT_IDENTITY_ANCHOR)}" data-resident-schema="${escapeHtml(projection.schema)}" data-canonical-id="${escapeHtml(projection.canonical_id)}"${projection.kind_label ? ` data-kind-label="${escapeHtml(projection.kind_label)}"` : ""}>
    ${lead}
    ${former}
  </div>`;
}
