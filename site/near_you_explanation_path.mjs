/**
 * Public "why this is here" paths for Near-you cards.
 *
 * Candidates are composed offline from the district activity `located_in`
 * graph and the compact notice → mandate reverse index. The renderer selects
 * one exact place match; it never traverses or scores raw records in-browser.
 */

export const NEAR_YOU_EXPLANATION_PATH_SCHEMA = "cityscroll.near_you_explanation_path.v1";

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

function locationPlaceRole(record = {}) {
  if (record.basis === "Venue / logistics") return "venue";
  if (record.basis === "Matter place") return "matter";
  return "affected_area";
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
          confidence: clean(edge.confidence, 40) || null,
          method: clean(edge.method, 100),
          method_version: clean(edge.method_version, 40),
          placement_method: clean(edge.evidence?.placement_method, 100),
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

const DIRECT_LOCATION_METHODS = new Set([
  "coordinates_pip",
  "publisher_council",
  "publisher_district",
  "matter_address",
  "matter_body_borough",
  "matter_title_place",
  "structured_bag",
]);

function candidateStrength(candidate = {}) {
  const location = candidate.location || {};
  const tier = candidate.mandate?.publication_tier === "deterministic" ? 1000 : 500;
  const confidence = location.confidence === "strong" ? 100 : location.confidence === "derived" ? 50 : 0;
  const method = DIRECT_LOCATION_METHODS.has(location.placement_method) ? 20
    : location.placement_method === "cd_centroid_council" ? -20 : 0;
  const specificity = location.kind === "community-district" ? 3
    : location.kind === "council-district" ? 2 : 1;
  return tier + confidence + method + specificity;
}

/** Select at most one strongest path, constrained to the exact displayed place. */
export function selectNearYouExplanationPath(candidates = [], scope = {}) {
  const place = scope.place || {};
  if (["citywide", "virtual", "unlocated"].includes(place.location_scope)) return null;
  // A neighborhood alone is not an exact graph subject in this artifact.
  if (place.neighborhood && !place.boroughs?.length
    && !place.community_districts?.length && !place.council_districts?.length) return null;
  const subject = exactPlaceSubject(scope);
  const eligible = candidates.filter((candidate) =>
    candidate?.schema === NEAR_YOU_EXPLANATION_PATH_SCHEMA
      && candidate.location?.relation === "located_in"
      && DISTRICT_KINDS.has(candidate.location?.kind)
      && PUBLIC_TIERS.has(candidate.mandate?.publication_tier)
      && (!subject || candidate.location.subject_ref === subject));
  return eligible.slice().sort((left, right) =>
    candidateStrength(right) - candidateStrength(left)
      || left.location.subject_ref.localeCompare(right.location.subject_ref))[0] || null;
}
