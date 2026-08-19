import assert from "node:assert/strict";
import test from "node:test";

import {
  KEYWORD_MATCH_SEMANTICS,
  REVIEWED_SYNONYM_EXPANSIONS,
  matchKeywordDocument,
  resolveKeywordQuery,
  searchKeywordDocuments,
} from "../site/keyword_matcher.mjs";
import { buildLandSearchDocuments } from "../site/land_search_producer.mjs";

function document(overrides = {}) {
  return {
    schema: "cityscroll.search_document.v1",
    object_ref: "procurement:81626S0021001",
    object_type: "procurement",
    domain: "contracts",
    canonical_href: "/browse/contracts/?mode=award&q=81626S0021001",
    title: "Pesticides and Mosquito Control Products",
    summary: "Products used by the Health Department.",
    search_text: "Pesticides and Mosquito Control Products Health Department",
    source_family: "city_record",
    source_observation_refs: ["notice:20260710020"],
    ...overrides,
  };
}

test("reviewed plural normalization matches mosquitos to a whole mosquito token", () => {
  const resolved = resolveKeywordQuery("mosquitos");
  assert.deepEqual(resolved.canonical_tokens, ["mosquito"]);
  assert.deepEqual(resolved.retrieval_groups, [["mosquitos", "mosquito"]]);

  const evidence = matchKeywordDocument(document(), resolved);
  assert.equal(evidence.field, "title");
  assert.deepEqual(evidence.token_offsets, [2, 3]);
  assert.equal(evidence.matched_normalized_term, "mosquito");
  assert.equal(evidence.source_identifier, "notice:20260710020");
  assert.equal(
    evidence.snippet.text.slice(evidence.snippet.mark_start, evidence.snippet.mark_end),
    "Mosquito",
  );
});

test("phrases require an adjacent token sequence", () => {
  const resolved = resolveKeywordQuery("industrial development agency");
  assert.ok(matchKeywordDocument(document({
    title: "Industrial Development Agency hearing",
    search_text: "Industrial Development Agency hearing",
  }), resolved));
  assert.equal(matchKeywordDocument(document({
    title: "Industrial projects from the development agency",
    search_text: "Industrial projects from the development agency",
  }), resolved), null);
});

test("IDA aliases become an agency filter and never match inside tidal", () => {
  for (const query of ["ida", "IDA", "NYCIDA"]) {
    const resolved = resolveKeywordQuery(query);
    assert.deepEqual(resolved.canonical_tokens, ["industrial", "development", "agency"]);
    assert.deepEqual(resolved.structured_filters, {
      agency: "Industrial Development Agency",
      agency_id: "industrial-development-agency",
    });
    assert.deepEqual(resolved.retrieval_groups, []);
  }

  const tidal = resolveKeywordQuery("tidal");
  assert.deepEqual(tidal.canonical_tokens, ["tidal"]);
  assert.equal(matchKeywordDocument(document({
    title: "IDA public hearing",
    search_text: "IDA public hearing",
  }), tidal), null);
});

test("rat matches whole tokens and simple plurals, not infixes or prefixes", () => {
  const resolved = resolveKeywordQuery("rat");
  assert.deepEqual(resolved.canonical_tokens, ["rat"]);

  for (const title of [
    "Integrated Visiting 'Rosy' Program",
    "Indirect Rate Implementation Services",
    "Waterfront strategy and ratio study",
    "Accreditation renewal",
  ]) {
    assert.equal(matchKeywordDocument(document({
      title,
      summary: title,
      search_text: title,
    }), resolved), null, title);
  }

  const whole = matchKeywordDocument(document({
    title: "Community Rat Management",
    summary: "Rodent control training",
    search_text: "Community Rat Management training",
  }), resolved);
  assert.ok(whole);
  assert.equal(whole.field, "title");
  assert.equal(
    whole.snippet.text.slice(whole.snippet.mark_start, whole.snippet.mark_end),
    "Rat",
  );

  const plural = matchKeywordDocument(document({
    title: "City rats inspection",
    search_text: "City rats inspection",
  }), resolved);
  assert.ok(plural);
  assert.equal(
    plural.snippet.text.slice(plural.snippet.mark_start, plural.snippet.mark_end),
    "rats",
  );

  const landHit = matchKeywordDocument(document({
    object_type: "land_use_project",
    domain: "zoning",
    title: "Rat mitigation ULURP",
    search_text: "Rat mitigation ULURP Brooklyn",
  }), resolved);
  assert.ok(landHit);
  assert.equal(landHit.matched_normalized_term, "rat");

  const fromPluralQuery = matchKeywordDocument(document({
    title: "Community Rat Management",
    search_text: "Community Rat Management",
  }), resolveKeywordQuery("rats"));
  assert.ok(fromPluralQuery);
  assert.deepEqual(KEYWORD_MATCH_SEMANTICS, {
    schema: "cityscroll.keyword_match.v1",
    mode: "exact_token",
    infix: false,
    prefix: false,
    simple_regular_plural: true,
    reviewed_aliases: true,
    reviewed_synonym_expansion: true,
    evidence_required: true,
  });
});

test("reviewed school→education expansion ORs without rewriting query identity", () => {
  const resolved = resolveKeywordQuery("school");
  assert.deepEqual(resolved.canonical_tokens, ["school"]);
  assert.deepEqual(resolved.expansion_tokens, ["education"]);
  assert.equal(resolved.expansion.receipt, "reviewed_synonym_v1");
  assert.deepEqual(resolved.expansion.pairs, [{
    from: "school",
    to: "education",
    receipt: "reviewed_synonym_v1",
  }]);
  assert.deepEqual(resolved.retrieval_groups, [["school", "education"]]);
  assert.deepEqual(REVIEWED_SYNONYM_EXPANSIONS.school.expansion_tokens, ["education"]);

  const plural = resolveKeywordQuery("schools");
  assert.deepEqual(plural.canonical_tokens, ["school"]);
  assert.deepEqual(plural.expansion_tokens, ["education"]);
  assert.deepEqual(plural.retrieval_groups, [["schools", "school", "education"]]);

  const educationDoc = document({
    object_ref: "procurement:education-synonym-fixture",
    title: "Education Department professional development",
    summary: "Education services award",
    search_text: "Education Department professional development Education services award",
  });
  const schoolDoc = document({
    title: "School construction bid",
    search_text: "School construction bid",
  });
  const decoy = document({
    title: "Catch basin maintenance",
    search_text: "Catch basin maintenance Vendor mosquito supplies",
  });

  const educationHit = matchKeywordDocument(educationDoc, resolved);
  assert.ok(educationHit);
  assert.equal(educationHit.matched_normalized_term, "education");
  assert.equal(
    educationHit.snippet.text.slice(educationHit.snippet.mark_start, educationHit.snippet.mark_end),
    "Education",
  );

  const schoolHit = matchKeywordDocument(schoolDoc, resolved);
  assert.ok(schoolHit);
  assert.equal(schoolHit.matched_normalized_term, "school");
  assert.equal(
    schoolHit.snippet.text.slice(schoolHit.snippet.mark_start, schoolHit.snippet.mark_end),
    "School",
  );
  assert.equal(matchKeywordDocument(decoy, resolved), null);

  const hits = searchKeywordDocuments([educationDoc, schoolDoc, decoy], resolved);
  assert.deepEqual(hits.map((row) => row.object_ref), [
    "procurement:education-synonym-fixture",
    "procurement:81626S0021001",
  ]);
});

test("unreviewed tokens and education itself do not silently merge identities", () => {
  const typo = resolveKeywordQuery("mosqito");
  assert.deepEqual(typo.canonical_tokens, ["mosqito"]);
  assert.deepEqual(typo.expansion_tokens, []);
  assert.equal(typo.expansion, null);

  const academy = resolveKeywordQuery("academy");
  assert.deepEqual(academy.canonical_tokens, ["academy"]);
  assert.deepEqual(academy.expansion_tokens, []);
  assert.equal(academy.expansion, null);
  assert.equal(matchKeywordDocument(document({
    title: "Education Department professional development",
    search_text: "Education Department professional development",
  }), academy), null);

  const education = resolveKeywordQuery("education");
  assert.deepEqual(education.canonical_tokens, ["education"]);
  assert.deepEqual(education.expansion_tokens, []);
  assert.equal(education.expansion, null);
  assert.equal(matchKeywordDocument(document({
    title: "School construction bid",
    search_text: "School construction bid",
  }), education), null);

  const educational = resolveKeywordQuery("school");
  assert.equal(matchKeywordDocument(document({
    title: "Educational materials catalog",
    search_text: "Educational materials catalog",
  }), educational), null);
});

test("a multi-token contract phrase still requires adjacent whole tokens", () => {
  const resolved = resolveKeywordQuery("mosquito control");
  assert.ok(matchKeywordDocument(document({
    title: "Aerial Mosquito Control",
    search_text: "Aerial Mosquito Control Health Department",
  }), resolved));
  assert.equal(matchKeywordDocument(document({
    title: "Mosquito products and rodent control",
    search_text: "Mosquito products and rodent control",
  }), resolved), null);
});

test("bounded ZAP rows become provenance-bearing typed Land cards", () => {
  const corpus = buildLandSearchDocuments({
    schema_version: 1,
    dataset_id: "hgx4-8ukb",
    source: "warehouse",
    materialized_at: "2026-08-02T10:22:34.003Z",
    rows: [{
      project_id: "2019K0190",
      project_name: "862-868 Kent Avenue",
      public_status: "In Public Review",
      project_status: "Active",
      borough: "Brooklyn",
      community_district: "K03",
      current_milestone: "Community Board Referral",
    }],
  });
  assert.equal(corpus.coverage.state, "matched");
  assert.deepEqual({
    object_ref: corpus.documents[0].object_ref,
    object_type: corpus.documents[0].object_type,
    domain: corpus.documents[0].domain,
    canonical_href: corpus.documents[0].canonical_href,
    source_ref: corpus.documents[0].source_observation_refs[0],
  }, {
    object_ref: "land_use_project:2019K0190",
    object_type: "land_use_project",
    domain: "zoning",
    canonical_href: "/browse/zoning/#land/2019K0190",
    source_ref: "nyc_open_data:hgx4-8ukb:2019K0190",
  });
});
