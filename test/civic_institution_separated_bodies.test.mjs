/**
 * Search -> profile -> follow for two bodies an earlier reviewed group merged.
 *
 * The identity contract test owns the correction record; this file walks the
 * resident journey the correction has to deliver: a name or acronym search
 * reaches one institution, its profile says which body it is with its own
 * sources, and the follow it offers watches only that institution.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  buildAgencyConstellationView,
  renderAgencyConstellationDocument,
} from "../site/agency_constellation.mjs";
import { buildAgencySearchDocuments } from "../site/agency_search_producer.mjs";
import { interpretEntityPhrase } from "../site/canonical_entity_interpretation.mjs";
import { resolveKeywordQuery, searchKeywordDocuments } from "../site/keyword_matcher.mjs";
import { projectStatutoryInstitutionIdentity } from "../site/civic_institution_statutory_identity.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CASES = JSON.parse(
  readFileSync(
    new URL("./fixtures/agency_source_identity_compatibility/cases.json", import.meta.url),
    "utf8",
  ),
).separated_institutions;
const LOOKUP = JSON.parse(readFileSync(join(ROOT, "site/data/agency_constellation_lookup.json"), "utf8"));
const IDENTITY_REPORT = JSON.parse(
  readFileSync(join(ROOT, "site/data/agency_route_identity_report.json"), "utf8"),
);
const SOURCES = {
  intelligence: JSON.parse(readFileSync(join(ROOT, "site/data/entity_intelligence_lookup.json"), "utf8")),
  certification: JSON.parse(readFileSync(join(ROOT, "site/data/exam_certification_constellation.json"), "utf8")),
  staffing_exams: JSON.parse(readFileSync(join(ROOT, "site/data/staffing_exams.json"), "utf8")),
  obligations: JSON.parse(readFileSync(join(ROOT, "site/data/agency_obligations_lookup.json"), "utf8")),
};

const CORRECTION = CASES.correction;
const BOTH = [CORRECTION.corrected_id, CORRECTION.superseded_id];

function searchDocuments() {
  const built = buildAgencySearchDocuments(LOOKUP, { identityReport: IDENTITY_REPORT });
  assert.notEqual(built.coverage.state, "not_indexed");
  return built.documents;
}

function topHit(documents, query) {
  const hits = searchKeywordDocuments(documents, resolveKeywordQuery(query), { limit: 5 });
  return hits[0]?.document || hits[0] || null;
}

// A1 [outcome]
test("a full-name search reaches the institution that was searched for", () => {
  const documents = searchDocuments();
  for (const [query, expectedId] of Object.entries(CASES.full_name_queries)) {
    const hit = topHit(documents, query);
    assert.ok(hit, `no search hit for ${query}`);
    assert.equal(hit.object_ref, `agency:id:${expectedId}`, query);
    assert.equal(hit.canonical_href, `/agencies/${expectedId}/`, query);
  }
});

test("an acronym search reaches the institution that was searched for", () => {
  const documents = searchDocuments();
  for (const [query, expectedId] of Object.entries(CASES.acronym_queries)) {
    const hit = topHit(documents, query);
    assert.ok(hit, `no search hit for ${query}`);
    assert.equal(hit.object_ref, `agency:id:${expectedId}`, query);

    // The reviewed resolver agrees with the index, so the acronym cannot mean
    // one body in search and the other in an interpreted query.
    const interpreted = interpretEntityPhrase(query);
    assert.equal(interpreted.status, "resolved", query);
    assert.equal(interpreted.canonical_id, expectedId, query);
    assert.equal(interpreted.subject_ref, `agency:id:${expectedId}`, query);
  }
});

test("the two institutions stay separate documents with separate destinations", () => {
  const documents = searchDocuments();
  const [office, commission] = BOTH.map((id) =>
    documents.find((document) => document.object_ref === `agency:id:${id}`));
  assert.ok(office, "the corrected institution must be indexed");
  assert.ok(commission, "the superseded institution must stay indexed");
  assert.notEqual(office.object_ref, commission.object_ref);
  assert.notEqual(office.canonical_href, commission.canonical_href);
  assert.notEqual(office.title, commission.title);

  // The moved spelling reads from exactly one of them.
  assert.ok(office.search_text.includes(CORRECTION.source_spelling));
  assert.equal(commission.search_text.includes(CORRECTION.source_spelling), false);
  assert.ok(commission.search_text.includes(CASES.commission_stable_references.publisher_variant));
});

// A2 [boundary]
test("a query naming neither body specifically resolves to neither", () => {
  const documents = searchDocuments();
  for (const query of CASES.ambiguous_source_spellings) {
    const interpreted = interpretEntityPhrase(query);
    assert.equal(interpreted.status, "unresolved", query);
    assert.equal(interpreted.subject_ref, null, query);

    // A lexical search may still surface both bodies as candidates; what it
    // must never do is hand an ambiguous phrase one canonical identity.
    const refs = searchKeywordDocuments(documents, resolveKeywordQuery(query), { limit: 5 })
      .map((hit) => (hit.document || hit).object_ref)
      .filter((ref) => BOTH.some((id) => ref === `agency:id:${id}`));
    assert.notEqual(refs.length, 1, `${query} must not resolve to a single body`);
  }
});

// A3 [verification]
test("each profile is a real anchor that names its own body and sources", () => {
  for (const canonicalId of BOTH) {
    const view = buildAgencyConstellationView(canonicalId, SOURCES);
    assert.ok(view, canonicalId);
    assert.equal(view.path, `/agencies/${canonicalId}/`);
    assert.equal(view.subject_ref, `agency:id:${canonicalId}`);

    const statutory = projectStatutoryInstitutionIdentity(canonicalId);
    const document = renderAgencyConstellationDocument(view);
    // Static markup, so a direct visit with no script still explains the body.
    assert.ok(document.includes(`<h1>${view.display_name}</h1>`), canonicalId);
    assert.ok(document.includes(statutory.kind_label), canonicalId);
    assert.ok(document.includes(statutory.legal_basis.citation), canonicalId);
    assert.ok(document.includes(statutory.legal_basis.source_url), canonicalId);
    // A plain anchor to the sibling body: no script, no query state.
    assert.ok(
      document.includes(`href="/agencies/${statutory.distinguished_from.canonical_id}/"`),
      canonicalId,
    );
    // The back link to the directory is an ordinary anchor too.
    assert.ok(document.includes('href="/agencies/"'), canonicalId);
  }
});

test("each profile offers a follow scoped to its own institution only", () => {
  const follows = BOTH.map((canonicalId) => {
    const view = buildAgencyConstellationView(canonicalId, SOURCES);
    const href = view.follow_href;
    assert.ok(href, canonicalId);
    const document = renderAgencyConstellationDocument(view);
    assert.ok(document.includes(href.replace(/&/g, "&amp;")), `${canonicalId} must offer its follow`);
    return { canonicalId, href, filter: new URL(href).searchParams.get("filter") };
  });

  const [office, commission] = follows;
  assert.notEqual(office.href, commission.href);
  for (const follow of follows) {
    const other = follows.find((row) => row !== follow);
    const filter = JSON.parse(follow.filter);
    const values = JSON.stringify(filter);
    // The watch names this institution and never widens to the other one.
    assert.ok(values.includes(follow.canonicalId) || values.includes(
      LOOKUP.by_id[follow.canonicalId].display_name,
    ), follow.canonicalId);
    assert.equal(values.includes(other.canonicalId), false, follow.canonicalId);
    assert.equal(
      values.includes(LOOKUP.by_id[other.canonicalId].display_name),
      false,
      follow.canonicalId,
    );
  }
});
