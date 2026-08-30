/**
 * Normative affected-review-body projection for Land projects.
 *
 * `affected_review_body_for` is Charter § 196 affectation, not an observed
 * recommendation, meeting, or disposition. Borough Board involvement is the
 * same-borough distinct-community-district rule only.
 */

import { communityBoardPageHref } from "./community_board_links.mjs";
import {
  LAND_PROCEDURE_PROFILE_REGISTRY_VERSION,
} from "./land_procedure_profiles.mjs";
import { resolveLandActionProcedures } from "./land_action_procedure_resolution.mjs";
import { boroughBoardIdentity } from "./borough_board_identity.mjs";

export const AFFECTED_REVIEW_BODY_SCHEMA = "cityscroll.affected_review_body_for.v1";
export const AFFECTED_REVIEW_BODY_RELATION = "affected_review_body_for";
export const AFFECTED_REVIEW_BODY_LEGAL_BASIS = Object.freeze({
  citation: "NYC Charter § 196",
  source_url: "https://codelibrary.amlegal.com/codes/newyorkcity/latest/NYCcharter/0-0-0-824",
});
export const AFFECTED_REVIEW_BODY_DERIVATION = Object.freeze({
  community_board: "exact_cd_covers",
  borough_president: "exact_borough_of_affected_cds",
  borough_board: "same_borough_distinct_community_districts",
});

const BOARD_ID = /^[a-z]+(?:-[a-z]+)*-cb-\d{2}$/;
const CD_RE = /^([MXKQR])(\d{2})$/;
const DEFAULT_BOUNDARY_VINTAGE = "2026-05-26";

function communityBoardIdFromCovers(communityDistrictId, geography = {}) {
  const cd = clean(communityDistrictId).match(/^([MXKQR]\d{2})$/i)?.[1]?.toUpperCase() || null;
  if (!cd || geography?.gate?.publication_allowed !== true) return null;
  const matches = new Set((Array.isArray(geography.public_edges) ? geography.public_edges : [])
    .filter((edge) => edge?.type === "covers" && edge.to === `community-district:${cd}`)
    .map((edge) => String(edge.from || "").match(/^community-board:([a-z]+(?:-[a-z]+)*-cb-\d{2})$/)?.[1] || null)
    .filter((id) => id && BOARD_ID.test(id)));
  return matches.size === 1 ? [...matches][0] : null;
}
const PREFIX_BOROUGH = Object.freeze({
  X: Object.freeze({ name: "Bronx", slug: "bronx" }),
  K: Object.freeze({ name: "Brooklyn", slug: "brooklyn" }),
  M: Object.freeze({ name: "Manhattan", slug: "manhattan" }),
  Q: Object.freeze({ name: "Queens", slug: "queens" }),
  R: Object.freeze({ name: "Staten Island", slug: "staten-island" }),
});

function clean(value) {
  if (value == null) return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  return text || null;
}

function clone(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function sourceBag(input = {}) {
  const source = input.source && typeof input.source === "object" ? input.source : input;
  return {
    ...source,
    ...(input.open_data && typeof input.open_data === "object" ? input.open_data : {}),
  };
}

function exactCommunityDistrictTokens(value) {
  if (Array.isArray(value)) {
    return value.map((item) => clean(item)).filter(Boolean);
  }
  const text = clean(value);
  if (!text) return [];
  return text.split(/[;,]/).map((part) => clean(part)).filter(Boolean);
}

function parseExactCommunityDistricts(value) {
  const tokens = exactCommunityDistrictTokens(value);
  const cds = [];
  const invalid = [];
  for (const token of tokens) {
    const match = token.toUpperCase().match(CD_RE);
    if (!match) {
      invalid.push(token);
      continue;
    }
    cds.push(match[0]);
  }
  return {
    tokens,
    community_districts: [...new Set(cds)],
    invalid,
  };
}

const SLUG_BOROUGH = Object.freeze(Object.fromEntries(
  Object.values(PREFIX_BOROUGH).map((row) => [row.slug, row.name]),
));

function boardLabel(boardId) {
  const match = String(boardId || "").match(/^([a-z]+(?:-[a-z]+)*)-cb-(\d{2})$/);
  if (!match) return boardId;
  const borough = SLUG_BOROUGH[match[1]] || match[1];
  return `${borough} Community Board ${Number(match[2])}`;
}

function legalBasis() {
  return clone(AFFECTED_REVIEW_BODY_LEGAL_BASIS);
}

function emptyFacts() {
  return {
    community_boards: [],
    borough_president: null,
    borough_presidents: [],
    borough_board: false,
    borough_boards: [],
  };
}

function unresolvedProjection({
  projectId,
  reason,
  sourceFields = [],
  geographySource = null,
  procedureId = null,
  profileVersion = null,
  boundaryVintage = null,
  procedureResolution = null,
}) {
  return {
    schema: AFFECTED_REVIEW_BODY_SCHEMA,
    relation: AFFECTED_REVIEW_BODY_RELATION,
    layer: "normative",
    status: "unresolved",
    linking: false,
    project_id: projectId || null,
    procedure_id: procedureId,
    procedure_resolution: procedureResolution,
    profile_version: profileVersion,
    boundary_vintage: boundaryVintage,
    reason,
    facts: emptyFacts(),
    edges: [],
    geography_source: geographySource,
    provenance: {
      source_fields: sourceFields,
      legal_basis: legalBasis(),
      derivation_rules: AFFECTED_REVIEW_BODY_DERIVATION,
    },
  };
}

function makeEdge({
  projectId,
  role,
  bodyRef,
  href,
  sourceBorough,
  sourceCommunityDistricts,
  derivationRule,
  profileVersion,
  procedureId,
  boundaryVintage,
  explanation,
}) {
  return {
    schema: AFFECTED_REVIEW_BODY_SCHEMA,
    relation: AFFECTED_REVIEW_BODY_RELATION,
    layer: "normative",
    status: "accepted",
    linking: true,
    observed: false,
    project_id: projectId,
    body_ref: bodyRef,
    role,
    href: href || null,
    source_borough: sourceBorough,
    source_community_districts: [...sourceCommunityDistricts],
    derivation_rule: derivationRule,
    profile_version: profileVersion,
    procedure_id: procedureId,
    boundary_vintage: boundaryVintage,
    legal_basis: legalBasis(),
    explanation,
  };
}

/**
 * Draft or empty ZAP dispositions never become an observed recommendation
 * because an affected role exists.
 */
export function observedRecommendationFromDisposition(disposition = {}) {
  const status = clean(disposition.status);
  if (!status || /^draft$/i.test(status)) return null;
  const value = clean(
    disposition.borough_board
    || disposition.community_board
    || disposition.borough_president,
  );
  if (!value) return null;
  const representing = clean(disposition.representing);
  let kind = null;
  if (disposition.borough_board) kind = "borough_board";
  else if (disposition.community_board) kind = "community_board";
  else if (disposition.borough_president) kind = "borough_president";
  if (!kind) return null;
  return {
    kind,
    representing,
    value,
    status,
    observed: true,
  };
}

/**
 * Project Charter § 196 affected bodies from exact project/action geography.
 */
export function projectAffectedReviewBodies(input = {}, opts = {}) {
  const row = sourceBag(input);
  const projectId = clean(row.project_id);
  const geography = opts.geography || null;
  const boundaryVintage = clean(
    opts.boundary_vintage
    || geography?.boundary_vintage
    || DEFAULT_BOUNDARY_VINTAGE,
  );
  const parsed = parseExactCommunityDistricts(row.community_district);
  const geographySource = {
    borough: clean(row.borough),
    community_district: row.community_district ?? null,
    source_fields: row.community_district != null && row.community_district !== ""
      ? ["community_district"]
      : [],
  };

  const actionResolution = resolveLandActionProcedures(row, opts);
  const procedureResolution = actionResolution.procedure_resolution;
  const resolvedActions = actionResolution.land_actions.filter((action) => action.status === "resolved");
  const procedureIds = [...new Set(resolvedActions.map((action) => action.procedure_id).filter(Boolean))];
  const procedureId = procedureIds.length === 1 ? procedureIds[0] : null;
  const profileVersion = resolvedActions.some((action) => action.profile_version)
    ? LAND_PROCEDURE_PROFILE_REGISTRY_VERSION
    : null;

  if (!geography || geography.gate?.publication_allowed !== true) {
    return unresolvedProjection({
      projectId,
      reason: "geography_unavailable",
      sourceFields: geographySource.source_fields,
      geographySource,
      procedureId,
      profileVersion,
      boundaryVintage,
      procedureResolution,
    });
  }

  if (!parsed.tokens.length || parsed.invalid.length) {
    return unresolvedProjection({
      projectId,
      reason: parsed.tokens.length ? "incomplete_geography" : "missing_location",
      sourceFields: geographySource.source_fields,
      geographySource,
      procedureId,
      profileVersion,
      boundaryVintage,
      procedureResolution,
    });
  }

  if (procedureResolution !== "uniform" || !procedureId) {
    return unresolvedProjection({
      projectId,
      reason: procedureResolution === "mixed" ? "mixed_procedure" : "unresolved_procedure",
      sourceFields: [...geographySource.source_fields, "actions", "ulurp_numbers", "ulurp_non"],
      geographySource,
      procedureId,
      profileVersion,
      boundaryVintage,
      procedureResolution,
    });
  }

  const byBorough = new Map();
  const edges = [];
  const facts = emptyFacts();

  for (const cd of parsed.community_districts) {
    const prefix = cd[0];
    const borough = PREFIX_BOROUGH[prefix];
    const boardId = communityBoardIdFromCovers(cd, geography);
    if (!borough || !boardId) {
      return unresolvedProjection({
        projectId,
        reason: "unresolved_covers",
        sourceFields: geographySource.source_fields,
        geographySource,
        procedureId,
        profileVersion,
        boundaryVintage,
        procedureResolution,
      });
    }
    const bodyRef = `community-board:${boardId}`;
    if (!byBorough.has(borough.slug)) {
      byBorough.set(borough.slug, {
        borough: borough.name,
        slug: borough.slug,
        cds: [],
        boards: [],
      });
    }
    const group = byBorough.get(borough.slug);
    if (!group.cds.includes(cd)) group.cds.push(cd);
    if (!group.boards.includes(bodyRef)) group.boards.push(bodyRef);
    if (!facts.community_boards.includes(bodyRef)) {
      facts.community_boards.push(bodyRef);
      edges.push(makeEdge({
        projectId,
        role: "affected_community_board",
        bodyRef,
        href: communityBoardPageHref(boardId),
        sourceBorough: borough.name,
        sourceCommunityDistricts: [cd],
        derivationRule: AFFECTED_REVIEW_BODY_DERIVATION.community_board,
        profileVersion,
        procedureId,
        boundaryVintage,
        explanation: `${boardLabel(boardId)} has a review role because this application includes land in community district ${cd}.`,
      }));
    }
  }

  for (const group of byBorough.values()) {
    group.cds.sort();
    group.boards.sort();
    const presidentRef = `borough-president:${group.slug}`;
    facts.borough_presidents.push(presidentRef);
    if (!facts.borough_president) facts.borough_president = presidentRef;
    edges.push(makeEdge({
      projectId,
      role: "affected_borough_president",
      bodyRef: presidentRef,
      href: `/agencies/borough-president-${group.slug}/`,
      sourceBorough: group.borough,
      sourceCommunityDistricts: group.cds,
      derivationRule: AFFECTED_REVIEW_BODY_DERIVATION.borough_president,
      profileVersion,
      procedureId,
      boundaryVintage,
      explanation: `The ${group.borough} Borough President has a review role because this application includes land in ${group.borough}.`,
    }));

    const board = boroughBoardIdentity(group.slug);
    if (group.cds.length >= 2 && board) {
      facts.borough_board = true;
      facts.borough_boards.push(board.id);
      edges.push(makeEdge({
        projectId,
        role: "affected_borough_board",
        bodyRef: board.id,
        href: null,
        sourceBorough: group.borough,
        sourceCommunityDistricts: group.cds,
        derivationRule: AFFECTED_REVIEW_BODY_DERIVATION.borough_board,
        profileVersion,
        procedureId,
        boundaryVintage,
        explanation: `The ${group.borough} Borough Board has a review role because this application includes land in two or more community districts in ${group.borough} (${group.cds.join(", ")}).`,
      }));
    }
  }

  facts.community_boards.sort();
  facts.borough_presidents.sort();
  facts.borough_boards.sort();
  if (facts.borough_presidents.length === 1) {
    facts.borough_president = facts.borough_presidents[0];
  } else if (facts.borough_presidents.length > 1) {
    facts.borough_president = null;
  }

  const roleOrder = {
    affected_community_board: 0,
    affected_borough_president: 1,
    affected_borough_board: 2,
  };
  edges.sort((left, right) => {
    const byRole = (roleOrder[left.role] ?? 9) - (roleOrder[right.role] ?? 9);
    if (byRole) return byRole;
    return String(left.body_ref).localeCompare(String(right.body_ref));
  });

  return {
    schema: AFFECTED_REVIEW_BODY_SCHEMA,
    relation: AFFECTED_REVIEW_BODY_RELATION,
    layer: "normative",
    status: "resolved",
    linking: true,
    project_id: projectId,
    procedure_id: procedureId,
    procedure_resolution: procedureResolution,
    profile_version: profileVersion,
    boundary_vintage: boundaryVintage,
    reason: null,
    facts,
    edges,
    geography_source: geographySource,
    provenance: {
      source_fields: ["community_district", "actions", "ulurp_numbers", "ulurp_non"],
      legal_basis: legalBasis(),
      derivation_rules: AFFECTED_REVIEW_BODY_DERIVATION,
      covers_relation: "community-board --covers--> community-district",
    },
  };
}

export function stampAffectedReviewBodies(row, opts = {}) {
  if (!row || typeof row !== "object") return row;
  const projection = projectAffectedReviewBodies(row, opts);
  row.affected_review_body_for = projection;
  row.affected_review_bodies = clone(projection.facts);
  return row;
}
