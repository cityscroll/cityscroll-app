import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { renderAdminCodeProvisionDocument } from "../site/admin_code.mjs";
import { renderMandateDocument } from "../site/mandate_document.mjs";
import pagesEdge, { edgeRequestKind } from "../site/pages_edge.mjs";
import { loadOntologyRegistry } from "../ontology/index.mjs";
import { projectMandateSearchDocuments } from "../site/universal_search_mandate_producer.mjs";
import {
  CREATED_BY_PROVISION_RELATION,
  CREATES_MANDATE_RELATION,
  LEGAL_BASIS_MAY_HAVE_CHANGED_COPY,
  OBLIGATES_RELATION,
  classifyMandateCitation,
  extractAdminCodeSectionTokens,
  joinMandateToProvisions,
  joinsForProvision,
  renderMandateProvisionJoin,
  renderProvisionMandateJoins,
} from "../site/statutory_mandate_provision_join.mjs";
import { getProvisionAsOf } from "../site/code_provision_history.mjs";

const fixtures = JSON.parse(
  readFileSync(new URL("./fixtures/statutory_mandate_provision_join.json", import.meta.url), "utf8"),
);

function lookupProvision(value) {
  const section = extractAdminCodeSectionTokens(value)[0];
  return section ? fixtures.corpus[section] || null : null;
}

function mandate(overrides = {}) {
  const { source, ...rest } = overrides;
  return {
    ...fixtures.base_mandate,
    ...rest,
    source: { ...fixtures.base_mandate.source, ...(source || {}) },
  };
}

function certifiedSearchLookup(row) {
  return {
    schema: "cityscroll.agency_obligations.v1",
    method: "enacted_law_mandate_extract_v1",
    certification_basis: "auto_certified_quote_verify_v1",
    generated_at: "2026-08-07T23:52:53.226Z",
    as_of: "2026-08-07",
    source_receipt: {
      schema_version: "cityscroll-mandates-backfill-v1",
      model: "fixture",
      prompt_version: "cityscroll-mandates-prompt-v1",
      law_count: 1,
      mandate_count: 1,
      extraction: "independent_enacted_law_backfill",
    },
    by_agency: {
      "independent-budget-office": {
        agency_id: "independent-budget-office",
        obligations: [{
          ...row,
          certification: {
            status: "auto_certified",
            basis: "auto_certified_quote_verify_v1",
            quote_verified: true,
          },
        }],
      },
    },
  };
}

test("exact Administrative Code citation joins one CodeProvision without duplicating the mandate", () => {
  const row = mandate(fixtures.cases.exact_join);
  const join = joinMandateToProvisions(row, { lookupProvision });
  assert.equal(join.status, "accepted");
  assert.equal(join.mandate_id, "ibo-eval-001");
  assert.equal(join.edges.length, 1);
  assert.equal(join.edges[0].relation, CREATES_MANDATE_RELATION);
  assert.equal(join.edges[0].from, "nyc-administrative-code:11-2901");
  assert.equal(join.edges[0].to, "mandate:ibo-eval-001");
  assert.equal(join.edges[0].inverse, CREATED_BY_PROVISION_RELATION);
  assert.equal(join.edges[0].provision_href, "/administrative-code/11-2901/");
  assert.equal(join.citation, "Administrative Code § 11-2901(b)(1)");
  assert.equal(join.source.document, row.source.law_text_url);
  assert.equal(join.source.record, "81290");
  assert.equal(join.source.fields.citation, row.citation);
  assert.equal(join.obligates.relation, OBLIGATES_RELATION);
  assert.equal(join.obligates.to, "agency:id:independent-budget-office");
  assert.equal(join.mandate_fields.duty_text, row.duty_text);
  assert.equal(join.mandate_fields.deadline.computed_date, "2020-12-31");
  assert.deepEqual(join.reciprocal[0].to, "nyc-administrative-code:11-2901");

  const html = renderMandateDocument(row, { provisionJoin: join });
  assert.match(html, /data-mandate-id="ibo-eval-001"/);
  assert.match(html, /href="\/administrative-code\/11-2901\/"/);
  assert.match(html, /Administrative Code § 11-2901/);
  assert.match(html, /Evaluate economic development tax expenditures/);
  assert.match(html, /Independent Budget Office/);
  assert.match(html, /href="https:\/\/nyc\.legistar\.com\/Gateway\.aspx\?M=L&amp;ID=81290"/);
  assert.equal(html.includes("mandate:ibo-eval-002"), false);
});

test("multiple exact sections emit multiple provision edges on the same mandate identity", () => {
  const join = joinMandateToProvisions(mandate(fixtures.cases.multiple_exact), { lookupProvision });
  assert.equal(join.status, "accepted");
  assert.equal(join.mandate_id, "ibo-eval-001");
  assert.deepEqual(join.edges.map((edge) => edge.provision_id), [
    "nyc-administrative-code:11-2901",
    "nyc-administrative-code:11-2902",
  ]);
  assert.equal(new Set(join.edges.map((edge) => edge.to)).size, 1);
});

test("a later provision version marks possible legal-basis change without inventing mandate meaning", () => {
  const row = mandate(fixtures.cases.changed_provision);
  const history = fixtures.changed_provision_history;
  const join = joinMandateToProvisions(row, {
    lookupProvision,
    changes: history.changes,
    versions: history.versions,
  });
  assert.equal(join.status, "accepted");
  assert.equal(join.edges[0].provision_id, "nyc-administrative-code:16-120");
  assert.equal(join.legal_basis_change.status, "possible");
  assert.equal(join.legal_basis_change.copy, LEGAL_BASIS_MAY_HAVE_CHANGED_COPY);
  assert.doesNotMatch(join.legal_basis_change.copy, /deadline|duty|power|agency|90 days/i);
  assert.equal(join.mandate_fields.duty_text, row.duty_text);
  assert.equal(join.mandate_fields.deadline.computed_date, "2018-06-01");
  assert.equal(join.mandate_fields.agency_id, "independent-budget-office");
  assert.notEqual(join.mandate_fields.duty_text, history.versions[1].text);

  const asOf = getProvisionAsOf({
    provision_id: "nyc-administrative-code:16-120",
    versions: history.versions,
    changes: history.changes,
    as_of: "2026-11-01",
  });
  assert.equal(asOf.text, "New receptacle text with a different deadline of 90 days.");
  assert.notEqual(join.mandate_fields.duty_text, asOf.text);

  const html = renderMandateProvisionJoin(join);
  assert.match(html, /data-legal-basis-change="possible"/);
  assert.match(html, /The legal basis for this mandate may have changed/);
  assert.doesNotMatch(html, /90 days/);
  assert.doesNotMatch(html, /New receptacle text/);
});

test("malformed, ambiguous, RCNY, external, missing-source, and unresolved citations stay visible and non-linking", () => {
  const cases = [
    ["malformed_citation", "malformed_citation"],
    ["ambiguous_citation", "ambiguous_citation"],
    ["rcny_boundary", "rcny_not_administrative_code"],
    ["external_citation", "external_statute"],
    ["missing_source_document", "missing_source_document"],
    ["unresolved_basis", "no_exact_section"],
  ];
  for (const [name, reason] of cases) {
    const join = joinMandateToProvisions(mandate(fixtures.cases[name]), { lookupProvision });
    assert.equal(join.edges.length, 0, name);
    assert.equal(join.unresolved_reason, reason, name);
    assert.notEqual(join.status, "accepted", name);
    const html = renderMandateProvisionJoin(join);
    assert.match(html, new RegExp(`data-unresolved-reason="${reason}"`), name);
    assert.doesNotMatch(html, /href="\/administrative-code\//, name);
    if (name === "rcny_boundary") {
      assert.equal(classifyMandateCitation(fixtures.cases[name].citation).domain, "rcny");
      assert.equal(join.corpus_boundary, "rcny");
    }
  }
});

test("reciprocal provision navigation keeps source hashes and existing agency obligation edges", () => {
  const exact = joinMandateToProvisions(mandate(fixtures.cases.exact_join), { lookupProvision });
  const changed = joinMandateToProvisions(mandate(fixtures.cases.changed_provision), {
    lookupProvision,
    ...fixtures.changed_provision_history,
  });
  const reverse = joinsForProvision("nyc-administrative-code:11-2901", [
    mandate(fixtures.cases.exact_join),
    mandate(fixtures.cases.changed_provision),
  ], { lookupProvision });
  assert.equal(reverse.length, 1);
  assert.equal(reverse[0].mandate_id, "ibo-eval-001");
  assert.equal(exact.edges[0].content_hash, "sha256:11-2901");
  assert.equal(exact.obligates.href, "/agencies/independent-budget-office/");
  const provisionHtml = renderAdminCodeProvisionDocument({
    id: "nyc-administrative-code:11-2901",
    citation: "§ 11-2901",
    heading: "Economic development tax expenditure evaluation.",
    current_text: "Section text.",
    source: { url: "https://codelibrary.amlegal.com/codes/newyorkcity/latest/NYCadmin/0-0-0-1", observed_at: "2026-08-24", content_hash: "sha256:11-2901" },
  }, { mandateJoins: reverse });
  assert.match(provisionHtml, /href="\/mandates\/ibo-eval-001\//);
  assert.match(provisionHtml, /Evaluate economic development tax expenditures/);
  assert.match(provisionHtml, /sha256:11-2901/);
  assert.equal(renderProvisionMandateJoins([changed]).includes("/mandates/sanitation-receptacles-001/"), true);
});

test("search still indexes the existing mandate object and does not mint a provision document", () => {
  const row = mandate(fixtures.cases.exact_join);
  const projection = projectMandateSearchDocuments(certifiedSearchLookup(row), { lookupProvision });
  assert.equal(projection.documents.length, 1);
  assert.equal(projection.documents[0].object_ref, "mandate:ibo-eval-001");
  assert.equal(projection.documents[0].object_type, "mandate");
  assert.equal(projection.documents[0].canonical_href, "/mandates/ibo-eval-001");
  assert.deepEqual(projection.documents[0].provenance.provision_ids, ["nyc-administrative-code:11-2901"]);
  assert.equal(projection.documents[0].provenance.citation, row.citation);
});

test("registry catalogs the creates_mandate and obligates relations", () => {
  const registry = loadOntologyRegistry();
  const objects = new Map(registry.object_types.map((entry) => [entry.id, entry]));
  const links = new Map(registry.link_types.map((entry) => [entry.id, entry]));
  assert.equal(objects.get("code_provision")?.status, "registered");
  assert.equal(links.get("creates_mandate")?.from, "code_provision");
  assert.equal(links.get("creates_mandate")?.to, "mandate");
  assert.equal(links.get("creates_mandate")?.inverse, "created_by_provision");
  assert.equal(links.get("obligates")?.from, "mandate");
  assert.equal(links.get("obligates")?.to, "agency");
});

test("Pages edge mandate documents keep identity while adding the provision join", async () => {
  const row = mandate(fixtures.cases.exact_join);
  const lookup = certifiedSearchLookup(row);
  const response = await pagesEdge.fetch(
    new Request("https://cityscroll.org/mandates/ibo-eval-001"),
    {
      ASSETS: {
        async fetch(request) {
          const path = new URL(request.url).pathname;
          if (path === "/data/agency_obligations_lookup.json") return Response.json(lookup);
          if (path === "/data/notice_mandate_backlinks_lookup.json") return Response.json({ by_notice: {} });
          if (path === "/data/process_conformance_lookup.json") return Response.json({ by_agency: {} });
          return new Response("missing", { status: 404 });
        },
      },
    },
  );
  assert.equal(edgeRequestKind("https://cityscroll.org/mandates/ibo-eval-001"), "mandate");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /data-mandate-id="ibo-eval-001"/);
  assert.match(html, /href="\/administrative-code\/11-2901\//);
  assert.match(html, /Evaluate economic development tax expenditures/);
});
