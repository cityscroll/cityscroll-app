/**
 * Public "why this is here" paths for Near-you cards.
 *
 * Candidates are composed offline from the district activity `located_in`
 * graph and the compact notice → mandate reverse index. The renderer selects
 * one exact place match; it never traverses or scores raw records in-browser.
 */

import { PLACE_ROLES } from "./scope_v0.mjs";
import {
  classifyLocationEvidence,
  locationEvidenceAllowsExactPredicate,
} from "./location_evidence_tier.mjs";

export const NEAR_YOU_EXPLANATION_PATH_SCHEMA = "cityscroll.near_you_explanation_path.v1";
export const NEAR_YOU_GEOGRAPHY_EVIDENCE_SCHEMA = "cityscroll.near_you_geography_evidence.v1";

const PUBLIC_TIERS = new Set(["deterministic", "public_inferred"]);
const DISTRICT_KINDS = new Set(["borough", "community-district", "council-district"]);
const NON_DISTRICT_BASES = new Set(["Citywide", "Virtual", "No place signal", "Weak fallback"]);

const clean = (value, max = 700) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

function publicBacklink(row = {}) {
  const publicationTier = clean(row.publication_tier, 40);
  const dutyText = clean(row.duty_text);
  const agencyName = clean(row.agency_name, 200);
  const agencyHref = clean(row.agency_href, 240);
  return PUBLIC_TIERS.has(publicationTier)
    && dutyText
    && agencyName
    && /^\/agencies\/[a-z0-9][a-z0-9-]*\/?$/i.test(agencyHref);
}

function backlinkStrength(row = {}) {
  return (clean(row.publication_tier, 40) === "deterministic" ? 100 : 50)
    + (row.source_href ? 4 : 0)
    + (row.citation ? 2 : 0);
}

function strongestBacklink(rows = []) {
  return rows.filter(publicBacklink).slice().sort((left, right) =>
    backlinkStrength(right) - backlinkStrength(left)
      || clean(left.agency_name).localeCompare(clean(right.agency_name))
      || clean(left.relation).localeCompare(clean(right.relation))
      || clean(left.duty_text).localeCompare(clean(right.duty_text)))[0] || null;
}

/**
 * Bucket a compact district-activity basis string into the one canonical place-role
 * predicate, or null when the basis carries no district-specific evidence at all (citywide,
 * virtual, unlocated, or a weak agency/vendor fallback). Shared by the explanation-path
 * builder below and the Near-you result filter (site/near_you_view.mjs) so the predicate
 * that decides whether a record matches a requested role is the same one that labels why it
 * matched — see PS-02 acceptance A9.
 */
export function placeRoleForBasis(basis) {
  if (NON_DISTRICT_BASES.has(basis)) return null;
  if (basis === "Venue / logistics") return "venue";
  if (basis === "Matter place") return "matter";
  return "affected_area"; // Never fabricate venue/matter from weaker district evidence.
}

/** Bucket the district-activity basis string into the one canonical place-role predicate. */
function locationPlaceRole(record = {}) {
  return placeRoleForBasis(record.basis) ?? "affected_area";
}

function subjectForRecord(lens, id) {
  const kind = lens === "land" ? "project" : "notice";
  const safeId = clean(id, 100);
  return safeId ? `${kind}:${safeId}` : null;
}

/** Compose public-safe candidate paths for one compact district record. */
export function buildNearYouExplanationCandidates({
  record,
  lens,
  locatedEdges = [],
  geographyNodes = [],
  mandateBacklinks = [],
  reverseIndexMethod = "notice_mandate_backlinks_v1",
} = {}) {
  if (!record?.id || NON_DISTRICT_BASES.has(record.basis)) return [];
  const from = subjectForRecord(lens, record.id);
  // The current cross-spine reverse index is notice-keyed. Land projects stay
  // empty until a public project-keyed mandate reverse edge exists.
  if (!from || !from.startsWith("notice:")) return [];
  const backlink = strongestBacklink(mandateBacklinks);
  if (!backlink) return [];
  const nodeByRef = new Map(geographyNodes.map((node) => [node?.subject_ref, node]));
  const noticeHref = `/notices/${encodeURIComponent(clean(record.id, 100))}`;

  return locatedEdges
    .filter((edge) => edge?.type === "located_in" && edge.from === from && edge.decision === "public")
    .map((edge) => {
      const node = nodeByRef.get(edge.to);
      if (!node || !DISTRICT_KINDS.has(node.kind) || !clean(node.label, 160)) return null;
      const placementMethod = clean(edge.evidence?.placement_method, 100);
      return {
        schema: NEAR_YOU_EXPLANATION_PATH_SCHEMA,
        hop_count: 3,
        notice_href: noticeHref,
        location: {
          relation: "located_in",
          subject_ref: edge.to,
          kind: node.kind,
          label: clean(node.label, 160),
          place_role: locationPlaceRole(record),
          // PS-04: the one canonical evidence tier (site/location_evidence_tier.mjs), derived
          // once here rather than re-guessed by whichever surface renders this candidate.
          tier: classifyLocationEvidence({ confidence_tier: edge.confidence, method: placementMethod }),
          confidence: clean(edge.confidence, 40) || null,
          method: clean(edge.method, 100),
          method_version: clean(edge.method_version, 40),
          placement_method: placementMethod,
          boundary_vintage: clean(edge.evidence?.boundary_vintage, 40),
        },
        agency: {
          id: clean(backlink.agency_id, 120) || null,
          name: clean(backlink.agency_name, 200),
          href: clean(backlink.agency_href, 240),
        },
        mandate: {
          relation: clean(backlink.relation, 100) || null,
          relation_label: clean(backlink.relation_label, 180) || "Connected statutory duty",
          duty_text: clean(backlink.duty_text),
          citation: clean(backlink.citation, 240) || null,
          source_href: /^https:\/\//i.test(clean(backlink.source_href, 500))
            ? clean(backlink.source_href, 500)
            : null,
          publication_tier: clean(backlink.publication_tier, 40),
        },
        provenance: {
          located_in_method: clean(edge.method, 100),
          cross_spine_method: clean(reverseIndexMethod, 100),
          publication_tier: clean(backlink.publication_tier, 40),
        },
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.location.subject_ref.localeCompare(right.location.subject_ref));
}

function boroughSubject(value) {
  const id = clean(value, 80).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return id ? `borough:${id}` : null;
}

function exactPlaceSubject(scope = {}) {
  const place = scope.place || {};
  const community = place.community_districts?.[0];
  if (community) return `community-district:${clean(community, 20)}`;
  const council = place.council_districts?.[0];
  if (council) return `council-district:${clean(council, 20)}`;
  const borough = place.boroughs?.[0];
  return borough ? boroughSubject(borough) : null;
}

function candidateStrength(candidate = {}) {
  const location = candidate.location || {};
  const tier = candidate.mandate?.publication_tier === "deterministic" ? 1000 : 500;
  const evidenceTier = location.tier === "strong" ? 100 : location.tier === "derived" ? 50 : 0;
  const specificity = location.kind === "community-district" ? 3
    : location.kind === "council-district" ? 2 : 1;
  return tier + evidenceTier + specificity;
}

/**
 * Select at most one strongest path, constrained to the exact displayed place. Selecting an
 * exact-subject path is itself a predicate that requires exact local applicability (PS-04
 * AC3): weak evidence tiers (an agency HQ pin, a vendor address, a district centroid) are
 * excluded here rather than merely deprioritized, so a weak match can never silently win by
 * being the only candidate for its subject.
 */
export function selectNearYouExplanationPath(candidates = [], scope = {}) {
  const place = scope.place || {};
  if (["citywide", "virtual", "unlocated"].includes(place.location_scope)) return null;
  // A neighborhood alone is not an exact graph subject in this artifact.
  if (place.neighborhood && !place.boroughs?.length
    && !place.community_districts?.length && !place.council_districts?.length) return null;
  const subject = exactPlaceSubject(scope);
  const requestedRole = scope.facets?.values?.place_role;
  const wantsRole = PLACE_ROLES.includes(requestedRole) ? requestedRole : null;
  const eligible = candidates.filter((candidate) =>
    candidate?.schema === NEAR_YOU_EXPLANATION_PATH_SCHEMA
      && candidate.location?.relation === "located_in"
      && DISTRICT_KINDS.has(candidate.location?.kind)
      && PUBLIC_TIERS.has(candidate.mandate?.publication_tier)
      && locationEvidenceAllowsExactPredicate({
        method: candidate.location?.placement_method,
        confidence_tier: candidate.location?.tier,
      })
      && (!subject || candidate.location.subject_ref === subject)
      // An absent role preserves today's broader behavior; a requested role never
      // widens past the exact evidenced relationship (no fabricating a match).
      && (!wantsRole || candidate.location.place_role === wantsRole));
  return eligible.slice().sort((left, right) =>
    candidateStrength(right) - candidateStrength(left)
      || left.location.subject_ref.localeCompare(right.location.subject_ref))[0] || null;
}

/** Select the exact registry-backed evidence for a generic geography scope. */
export function selectNearYouGeographyEvidence(record = {}, scope = {}) {
  const key = Array.isArray(scope?.place?.geographies) ? scope.place.geographies[0] : null;
  if (!key) return null;
  const match = record?.place?.geographies?.find((candidate) =>
    candidate?.key === key && candidate.visibility === "public");
  if (!match?.source_id || !match?.boundary_vintage || !match?.method
      || !match?.location_role || !match?.basis) return null;
  return {
    schema: NEAR_YOU_GEOGRAPHY_EVIDENCE_SCHEMA,
    key: match.key,
    type: match.type,
    label: clean(match.label, 160),
    relation: "located_in",
    location_role: clean(match.location_role, 80),
    basis: clean(match.basis, 160),
    // PS-04: the one canonical evidence tier, alongside the raw confidence/method beneath it.
    tier: classifyLocationEvidence({ confidence_tier: match.confidence, method: match.method }),
    confidence: clean(match.confidence, 40) || null,
    method: clean(match.method, 100),
    source_id: clean(match.source_id, 160),
    boundary_vintage: clean(match.boundary_vintage, 80),
  };
}
