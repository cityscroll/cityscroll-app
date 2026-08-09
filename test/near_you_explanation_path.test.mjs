import assert from "node:assert/strict";
import test from "node:test";

import {
  buildNearYouExplanationCandidates,
  selectNearYouExplanationPath,
} from "../site/near_you_explanation_path.mjs";

const nodes = [
  { subject_ref: "borough:queens", kind: "borough", label: "Queens" },
  { subject_ref: "community-district:Q01", kind: "community-district", label: "Community District Q01" },
  { subject_ref: "council-district:22", kind: "council-district", label: "Council District 22" },
  { subject_ref: "borough:manhattan", kind: "borough", label: "Manhattan" },
];

const locatedEdges = [
  {
    type: "located_in",
    from: "notice:n-1",
    to: "borough:queens",
    decision: "public",
    method: "district_activity_placement_v1",
    method_version: "1.0.0",
    evidence: { lens: "meetings", placement_method: "matter_title_place", boundary_vintage: "2026-05-26" },
  },
  {
    type: "located_in",
    from: "notice:n-1",
    to: "community-district:Q01",
    decision: "public",
    method: "district_activity_placement_v1",
    method_version: "1.0.0",
    evidence: { lens: "meetings", placement_method: "matter_title_place", boundary_vintage: "2026-05-26" },
  },
  {
    type: "located_in",
    from: "notice:n-1",
    to: "council-district:22",
    decision: "public",
    method: "district_activity_placement_v1",
    method_version: "1.0.0",
    evidence: { lens: "meetings", placement_method: "cd_centroid_council", boundary_vintage: "2026-05-26" },
  },
  {
    type: "located_in",
    from: "notice:n-1",
    to: "borough:manhattan",
    decision: "evidence_only",
    method: "district_activity_placement_v1",
    method_version: "1.0.0",
    evidence: { lens: "meetings", placement_method: "agency_hq", boundary_vintage: "2026-05-26" },
  },
];

const backlinks = [
  {
    duty_text: "Hold a public hearing before adopting the plan.",
    relation: "requires_public_hearing",
    relation_label: "Public hearing for this duty",
    agency_id: "transportation",
    agency_name: "Transportation",
    agency_href: "/agencies/transportation/",
    publication_tier: "public_inferred",
  },
  {
    duty_text: "Publish the annual district safety plan.",
    citation: "Local Law § 1",
    relation: "requires_public_hearing",
    relation_label: "Public hearing for this duty",
    agency_id: "transportation",
    agency_name: "Transportation",
    agency_href: "/agencies/transportation/",
    publication_tier: "deterministic",
  },
  {
    duty_text: "Unpublished review candidate.",
    agency_id: "transportation",
    agency_name: "Transportation",
    publication_tier: "evidence_only",
  },
];

test("Near-you path selection uses one strongest public path matching the requested district", () => {
  const candidates = buildNearYouExplanationCandidates({
    record: { id: "n-1", basis: "Matter place" },
    lens: "meetings",
    locatedEdges,
    geographyNodes: nodes,
    mandateBacklinks: backlinks,
    reverseIndexMethod: "notice_mandate_backlinks_v1",
  });

  assert.equal(candidates.length, 3);
  assert.ok(candidates.every((candidate) => candidate.mandate.publication_tier === "deterministic"));
  assert.ok(candidates.every((candidate) => candidate.location.subject_ref !== "borough:manhattan"));

  const boroughPath = selectNearYouExplanationPath(candidates, {
    place: { boroughs: ["Queens"], community_districts: [], council_districts: [], location_scope: null },
  });
  assert.equal(boroughPath.location.subject_ref, "borough:queens");
  assert.equal(boroughPath.location.place_role, "matter");
  assert.equal(boroughPath.agency.href, "/agencies/transportation/");

  const districtPath = selectNearYouExplanationPath(candidates, {
    place: { boroughs: ["Queens"], community_districts: ["Q01"], council_districts: [], location_scope: null },
  });
  assert.equal(districtPath.location.subject_ref, "community-district:Q01");
  assert.equal(districtPath.mandate.citation, "Local Law § 1");
});

test("Near-you paths suppress special buckets and label venue logistics explicitly", () => {
  const venueCandidates = buildNearYouExplanationCandidates({
    record: { id: "n-1", basis: "Venue / logistics" },
    lens: "meetings",
    locatedEdges,
    geographyNodes: nodes,
    mandateBacklinks: backlinks,
  });
  const venuePath = selectNearYouExplanationPath(venueCandidates, {
    place: { boroughs: ["Queens"], community_districts: [], council_districts: [], location_scope: null },
  });
  assert.equal(venuePath.location.place_role, "venue");

  for (const location_scope of ["citywide", "virtual", "unlocated"]) {
    assert.equal(selectNearYouExplanationPath(venueCandidates, {
      place: { boroughs: [], community_districts: [], council_districts: [], location_scope },
    }), null);
  }
});
