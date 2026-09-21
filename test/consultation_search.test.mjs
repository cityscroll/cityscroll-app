import assert from "node:assert/strict";
import { test } from "node:test";
import { admitSearchDocument, SEARCH_DOCUMENT_DOMAINS, SEARCH_DOCUMENT_OBJECT_TYPES } from "../site/search_document_contract.mjs";
import { buildConsultationSearchDocuments, projectConsultationSearchDocument } from "../site/consultation_search_producer.mjs";
import { buildSearchRenderPlan } from "../site/search_render_plan.mjs";
import { buildSearchLensHandoffHref, searchFamilyForResult } from "../site/search_lens_handoff.mjs";
import {
  CONSULTATION_RESPONDENT_TEXT_FIXTURE,
  CONSULTATION_VARIANT_FIXTURE,
} from "./fixtures/consultation_search_dedup.mjs";
import { withPinnedClock } from "./helpers/test_clock.mjs";

const FIXTURE_CLOCK = "2026-09-15T12:00:00.000Z";

test("consultation rounds are admitted as a complete canonical search family", () => {
  assert.ok(SEARCH_DOCUMENT_OBJECT_TYPES.includes("consultation"));
  assert.ok(SEARCH_DOCUMENT_DOMAINS.includes("participation"));
  const corpus = buildConsultationSearchDocuments();
  assert.equal(corpus.coverage.state, "matched");
  assert.deepEqual(corpus.documents.map((row) => row.title), [
    "Fast Buses: Central Brooklyn", "Secure Bike Parking",
    "Brooklyn CB14 district needs, FY2028", "Bloomingdale Library and Housing",
  ]);
  assert.ok(corpus.documents.every((row) => admitSearchDocument(row).document));
  assert.ok(corpus.documents.every((row) => searchFamilyForResult(row) === "consultations"));

  // Consultation facets remain available after SearchDocument admission compacts the row.
  assert.deepEqual(corpus.documents[0].provenance.consultation, {
    organizer: "NYC Department of Transportation",
    geography: ["Church Avenue", "Flatbush Avenue", "Utica Avenue"],
    category: "Transit service and corridor priorities",
  });
});

test("rendering, safe handoff, archive status, and failed retrieval stay explicit", () => {
  const corpus = buildConsultationSearchDocuments();
  const keyword = { match_mode: "keyword", results: corpus.documents.map((document) => ({ ...document, entity_type: document.object_type })) };
  const plan = buildSearchRenderPlan({ state: "legacy", payload: keyword, coverage: { lanes: [{ id: "consultations", status: "matched" }] } });
  assert.equal(plan.families.find((family) => family.id === "consultations").items.length, 4);
  const archived = corpus.documents.find((row) => row.title.includes("FY2028"));
  assert.equal(archived.provenance.lifecycle.state, "closed");
  assert.match(buildSearchLensHandoffHref(archived, { query: "budget", resolved_term: { canonical_tokens: ["budget"] } }, "/search/?q=budget"), /^\/consultations\/\?.*q=budget/);
  const failed = buildSearchRenderPlan({ state: "combined", keyword: null, semantic: { groups: [] }, keywordCoverage: { lanes: [{ id: "consultations", status: "unknown" }] } });
  assert.ok(failed.incomplete_families.includes("consultations"));
});

test("consultation source absence is refused and counted as not indexed", () => {
  const missingSource = buildConsultationSearchDocuments([{
    id: "dot-fast-buses-central-brooklyn",
    title: "Fast Buses: Central Brooklyn",
    sources: [],
    channels: [],
  }]);
  assert.equal(missingSource.coverage.state, "not_indexed");
  assert.equal(missingSource.coverage.not_indexed_count, 1);
  assert.equal(missingSource.outcomes[0].reason, "missing_consultation_source_observation");

  const unavailable = buildConsultationSearchDocuments({});
  assert.equal(unavailable.coverage.state, "not_indexed");
  assert.equal(unavailable.coverage.not_indexed_count, 0);
});

test("A3 one result per round: first-wins identity retains every channel reference", () => {
  return withPinnedClock(FIXTURE_CLOCK, () => {
    const firstOnly = buildConsultationSearchDocuments([CONSULTATION_VARIANT_FIXTURE[0]]);
    const secondOnly = buildConsultationSearchDocuments([CONSULTATION_VARIANT_FIXTURE[4]]);
    const corpus = buildConsultationSearchDocuments(CONSULTATION_VARIANT_FIXTURE);

    assert.deepEqual(
      corpus.documents.map((row) => row.object_ref).sort(),
      [
        "consultation:bloomingdale-library-and-housing",
        "consultation:dot-fast-buses-central-brooklyn",
      ],
    );
    assert.equal(corpus.coverage.indexed_count, 2);
    assert.equal(new Set(corpus.documents.map((row) => row.object_ref)).size, corpus.documents.length);

    const bloomingdale = corpus.documents.find((row) => row.object_ref === "consultation:bloomingdale-library-and-housing");
    const fastBuses = corpus.documents.find((row) => row.object_ref === "consultation:dot-fast-buses-central-brooklyn");

    // First-wins: the retained public fields match the first row for that identity.
    assert.equal(bloomingdale.title, firstOnly.documents[0].title);
    assert.equal(bloomingdale.summary, firstOnly.documents[0].summary);
    assert.equal(bloomingdale.source_observation_refs[0], firstOnly.documents[0].source_observation_refs[0]);
    assert.equal(fastBuses.title, secondOnly.documents[0].title);
    assert.equal(fastBuses.source_observation_refs[0], secondOnly.documents[0].source_observation_refs[0]);

    // Later channel and source rows remain evidence on the retained round.
    for (const ref of firstOnly.documents[0].source_observation_refs) {
      assert.ok(bloomingdale.source_observation_refs.includes(ref));
    }
    assert.ok(bloomingdale.source_observation_refs.includes("consultation:https://edc.nyc/project/bloomingdale-library/map"));
    assert.ok(bloomingdale.source_observation_refs.includes("consultation:https://edc.nyc/project/bloomingdale-library/feedback"));
    assert.ok(bloomingdale.source_observation_refs.includes("consultation:https://nycedc.formstack.com/forms/bloomingdale_library_and_housing_survey_sp"));
    assert.ok(bloomingdale.source_observation_refs.length >= 4);

    for (const ref of secondOnly.documents[0].source_observation_refs) {
      assert.ok(fastBuses.source_observation_refs.includes(ref));
    }
    assert.ok(fastBuses.source_observation_refs.some((ref) => ref.includes("feedback-map-centralbk") || ref.includes("fast-buses-map")));
  });
});

test("A3 excludes respondent text and inferred project outcomes from search documents", () => {
  return withPinnedClock(FIXTURE_CLOCK, () => {
    const forbidden = [
      "Please keep the existing reading room open every evening.",
      "Strongly oppose demolition",
      "Put housing on the corner lot marked in red.",
      "resident-42@example.com",
      "Library will be demolished and replaced by market-rate towers",
    ];
    const projected = projectConsultationSearchDocument(CONSULTATION_RESPONDENT_TEXT_FIXTURE);
    assert.equal(projected.outcome, "indexed");
    const document = projected.document;
    const haystack = [
      document.search_text,
      document.summary,
      document.title,
      ...(document.provenance?.search_text_fields || []),
      JSON.stringify(document),
    ].join("\n");
    for (const fragment of forbidden) {
      assert.equal(haystack.includes(fragment), false, `excluded text leaked: ${fragment}`);
    }
    assert.match(document.search_text, /Share feedback on the library and housing proposal/);
    assert.match(document.search_text, /Manhattan Community District 10/);
  });
});

test("A3 keeps consultation keyword results visible beside non-empty semantic families", () => {
  return withPinnedClock(FIXTURE_CLOCK, () => {
    const corpus = buildConsultationSearchDocuments();
    const keyword = {
      match_mode: "keyword",
      schema: "cityscroll.keyword_search_response.v1",
      lanes: [
        { id: "consultations", status: "matched" },
        { id: "exams", status: "empty" },
      ],
      results: corpus.documents.map((document) => ({ ...document, entity_type: document.object_type })),
    };
    const semantic = {
      method: "semantic_topic_search.v1",
      schema: "cityscroll.semantic_candidates.v1",
      groups: [
        {
          id: "exams",
          candidates: [{
            candidate_id: "exam:sanitation-supervisor",
            civic_object_family: "exams",
            source: { canonical_href: "/exams/sanitation-supervisor/", title: "Sanitation Supervisor", family: "exam" },
            passage: { text: "Open civil-service exam" },
            matched_terms: ["exam"],
          }],
        },
        { id: "consultations", candidates: [] },
      ],
    };
    const plan = buildSearchRenderPlan({
      state: "combined",
      keyword,
      semantic,
      keywordCoverage: { lanes: keyword.lanes },
    });
    const consultations = plan.families.find((family) => family.id === "consultations");
    const exams = plan.families.find((family) => family.id === "exams");
    assert.equal(consultations.items.length, 4);
    assert.ok(consultations.items.every((item) => item.kind === "keyword"));
    assert.equal(exams.items.length, 1);
    assert.equal(exams.items[0].kind, "semantic");
    assert.ok(plan.rows.some((row) => row.family === "consultations" && row.kind === "keyword"));
    assert.ok(plan.rows.some((row) => row.family === "exams" && row.kind === "semantic"));
  });
});
