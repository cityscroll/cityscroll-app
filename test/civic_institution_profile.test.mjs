import assert from "node:assert/strict";
import test from "node:test";

import { renderAgencyIdentitySection } from "../site/agency_identity_evidence.mjs";
import { buildAgencyIdentityEvidence } from "../tools/lib/agency_identity_evidence.mjs";

function profileView(identity, categories, identityEvidence) {
  return {
    path: `/agencies/${identity.canonical_id}/`,
    display_name: identity.canonical_name,
    canonical_id: identity.canonical_id,
    identity_evidence: identityEvidence,
    categories,
  };
}

test("DSNY profile exposes the retained source value and both relation endpoints", () => {
  const identity = {
    canonical_id: "sanitation",
    canonical_name: "New York City Department of Sanitation",
  };
  const evidence = buildAgencyIdentityEvidence({
    identity,
    publisherRow: {
      canonical_name: identity.canonical_name,
      org_type: "Mayoral Agency",
      match_method: "normalized+budget",
      variants: ["DEPARTMENT OF SANITATION"],
    },
    view: profileView(identity, [{ items: [{
      label: "DSNY public hearing",
      href: "/notices/20260708002",
      source: "city_record",
      confidence: "strong",
      method: "agency_browse_snapshot_v1",
      provenance: {
        source_system: "city_record",
        source_record_id: "city_record:20260708002",
        source_fields: ["agency_name"],
        input_value: "DEPARTMENT OF SANITATION",
        observed_at: "2026-08-25T10:00:00.000Z",
      },
    }] }], null),
    generatedAt: "2026-08-09T00:00:00Z",
  });
  const html = renderAgencyIdentitySection(profileView(identity, [], evidence));
  assert.match(html, /Source identity/);
  assert.match(html, /DEPARTMENT OF SANITATION/);
  assert.match(html, /href="\/notices\/20260708002"/);
  assert.match(html, /href="\/agencies\/sanitation\/"/);
  assert.match(html, /Publisher classification: Mayoral Agency/);
  assert.match(html, /Institution classification: unclassified/);
  assert.doesNotMatch(html, /institution kind: Mayoral Agency/i);
});

test("NYCEDC profile keeps an exact notice anchor and leaves institution kind optional", () => {
  const identity = {
    canonical_id: "economic-development-corporation",
    canonical_name: "Economic Development Corporation",
  };
  const evidence = buildAgencyIdentityEvidence({
    identity,
    publisherRow: {
      canonical_name: identity.canonical_name,
      org_type: "Public Benefit or Development Organization",
      match_method: "normalized+budget",
      variants: ["Economic Development Corporation"],
    },
    view: profileView(identity, [{ items: [{
      label: "NYCEDC contract notice",
      href: "/notices/20260803001",
      provenance: {
        source_system: "city_record",
        source_record_id: "city_record:20260803001",
        source_fields: ["agency_name"],
        input_value: "Economic Development Corporation",
        observed_at: "2026-08-03",
      },
      confidence: "strong",
      method: "agency_canonical_v1",
    }] }], null),
    generatedAt: "2026-08-09",
  });
  assert.equal(evidence.institution.institution_kind, null);
  assert.equal(evidence.observations.some((row) => row.source_record_id === "city_record:20260803001"), true);
  const html = renderAgencyIdentitySection(profileView(identity, [], evidence));
  assert.match(html, /Economic Development Corporation/);
  assert.match(html, /href="\/notices\/20260803001"/);
  assert.match(html, /data-identity-schema="cityscroll\.civic_institution_identity_evidence\.v1"/);
});
