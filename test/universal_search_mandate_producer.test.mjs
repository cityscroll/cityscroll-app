import assert from "node:assert/strict";
import test from "node:test";

import {
  UNIVERSAL_SEARCH_MANDATE_PRODUCER_SCHEMA,
  projectMandateSearchDocuments,
} from "../site/universal_search_mandate_producer.mjs";
import { admitSearchDocument } from "../site/search_document_contract.mjs";

const CERTIFICATION_BASIS = "auto_certified_quote_verify_v1";

function certifiedMandate(overrides = {}) {
  return {
    obligation_id: "66056-006",
    matter_id: "66056",
    agency_id: "homeless-services",
    agency_name: "Homeless Services",
    duty_text: "Renegotiate shelter contracts within the statutory period.",
    deliverable_type: "report",
    deadline: {
      kind: "days_after_effective",
      computed_date: "2021-12-07",
      text: "No later than 30 days after the effective date",
    },
    recurrence: "one-time",
    citation: "Administrative Code § 6-109.2(i)",
    source: {
      matter_id: "66056",
      legistar_url: "https://nyc.legistar.com/Gateway.aspx?M=L&ID=66056",
      law_text_url: "https://nyc.legistar1.com/nyc/attachments/law.doc",
      citation: "Administrative Code § 6-109.2(i)",
      file_number: "Int 146-C",
    },
    certification: {
      status: "auto_certified",
      basis: CERTIFICATION_BASIS,
      quote_verified: true,
    },
    notice_evidence_refs: ["notice:20210820102"],
    ...overrides,
  };
}

function lawLookup(rows, overrides = {}) {
  return {
    schema: "cityscroll.agency_obligations.v1",
    method: "enacted_law_mandate_extract_v1",
    certification_basis: CERTIFICATION_BASIS,
    generated_at: "2026-08-07T23:52:53.226Z",
    as_of: "2026-08-07",
    source_receipt: {
      schema_version: "cityscroll-mandates-backfill-v1",
      model: "fixture",
      prompt_version: "cityscroll-mandates-prompt-v1",
      law_count: 1,
      mandate_count: rows.length,
      extraction: "independent_enacted_law_backfill",
    },
    by_agency: {
      "homeless-services": {
        agency_id: "homeless-services",
        obligations: rows,
      },
    },
    ...overrides,
  };
}

test("quote-certified law mandates become admitted canonical SearchDocuments", () => {
  const projection = projectMandateSearchDocuments(lawLookup([certifiedMandate()]));

  assert.equal(projection.schema, UNIVERSAL_SEARCH_MANDATE_PRODUCER_SCHEMA);
  assert.equal(projection.coverage.state, "matched");
  assert.deepEqual(projection.coverage.counts, {
    source: 1,
    indexed: 1,
    not_indexed: 0,
  });
  assert.deepEqual(projection.coverage.not_indexed_reasons, {});

  const [document] = projection.documents;
  assert.equal(document.object_ref, "mandate:66056-006");
  assert.equal(document.object_type, "mandate");
  assert.equal(document.domain, "mandates");
  assert.equal(document.canonical_href, "/mandates/66056-006");
  assert.equal(document.source_family, "enacted_law_mandate");
  assert.deepEqual(document.source_observation_refs, ["law:66056"]);
  assert.equal(document.process_role, "report");
  assert.equal(document.classification.method, "law_derived_mandate_projection");
  assert.equal(document.provenance.producer, "universal_search_mandate_producer.v1");
  assert.equal(document.provenance.law_matter_id, "66056");
  assert.equal(document.provenance.citation, "Administrative Code § 6-109.2(i)");
  assert.equal(document.provenance.certification.status, "auto_certified");
  assert.equal(document.provenance.certification.basis, CERTIFICATION_BASIS);
  assert.equal(document.provenance.certification.quote_verified, true);
  assert.deepEqual(document.provenance.notice_evidence_refs, ["notice:20210820102"]);
  assert.deepEqual(document.provenance.evidence_hrefs, ["/notices/20210820102"]);
  assert.notDeepEqual(document.provenance.notice_evidence_refs, document.source_observation_refs);
  assert.equal(admitSearchDocument(document, { outcome: "indexed" }).outcome, "indexed");
  assert.ok(Object.isFrozen(document));
});

test("candidate and incomplete mandate rows fail closed with explicit coverage counts", () => {
  const rows = [
    certifiedMandate({
      obligation_id: "66056-007",
      certification: {
        status: "auto_candidate",
        basis: CERTIFICATION_BASIS,
        quote_verified: false,
      },
    }),
    certifiedMandate({ obligation_id: "66056-008", duty_text: "" }),
    certifiedMandate({ obligation_id: "66056-009", agency_id: null, agency_name: null }),
    certifiedMandate({
      obligation_id: "66056-010",
      matter_id: null,
      citation: null,
      source: {},
    }),
    certifiedMandate({
      obligation_id: "66056-011",
      deadline: { kind: "none", computed_date: null, text: null },
      recurrence: "none",
    }),
  ];
  const projection = projectMandateSearchDocuments(lawLookup(rows));

  assert.deepEqual(projection.documents, []);
  assert.equal(projection.coverage.state, "not_indexed");
  assert.deepEqual(projection.coverage.counts, {
    source: 5,
    indexed: 0,
    not_indexed: 5,
  });
  assert.deepEqual(projection.coverage.not_indexed_reasons, {
    mandate_gate_failed: 4,
    quote_not_verified: 1,
  });
});

test("coverage includes law mandates omitted from agency buckets when their actor is unresolved", () => {
  const projection = projectMandateSearchDocuments(lawLookup([certifiedMandate()], {
    summary: {
      obligation_count: 3,
      matched_obligation_count: 1,
      unmatched_obligation_count: 2,
    },
  }));

  assert.equal(projection.coverage.state, "partial");
  assert.deepEqual(projection.coverage.counts, {
    source: 3,
    indexed: 1,
    not_indexed: 2,
  });
  assert.deepEqual(projection.coverage.not_indexed_reasons, {
    subject_not_resolved: 2,
  });
});

test("notice-shaped rows cannot manufacture mandates, including the mosquito notice", () => {
  const mosquitoNotice = {
    request_id: "20260710020",
    title: "Pesticides and Mosquito Control Products",
    section_name: "Public Comment on Contract Awards",
    agency_name: "Health and Mental Hygiene",
    additional_description_1: "E-PIN: 81626S0021001.",
  };
  const projection = projectMandateSearchDocuments(lawLookup([mosquitoNotice]));

  assert.deepEqual(projection.documents, []);
  assert.equal(projection.coverage.not_indexed_reasons.quote_not_verified, 1);
  assert.equal(
    projection.documents.some((document) => document.object_ref.includes("20260710020")),
    false,
  );
});

test("only the enacted-law lookup envelope is accepted as producer input", () => {
  const projection = projectMandateSearchDocuments({
    schema: "cityscroll.notice_index.v1",
    by_agency: {
      "homeless-services": { obligations: [certifiedMandate()] },
    },
  });

  assert.deepEqual(projection.documents, []);
  assert.equal(projection.coverage.state, "not_indexed");
  assert.deepEqual(projection.coverage.counts, {
    source: 0,
    indexed: 0,
    not_indexed: 0,
  });
  assert.equal(projection.coverage.reason, "invalid_law_mandate_lookup");
});

test("notice evidence is sanitized and never changes law provenance or mandate identity", () => {
  const row = certifiedMandate({
    notice_evidence_refs: [
      "notice:20210820102",
      "notice:20210820102",
      "law:66056",
      "notice:bad/id",
    ],
  });
  const [document] = projectMandateSearchDocuments(lawLookup([row])).documents;

  assert.deepEqual(document.source_observation_refs, ["law:66056"]);
  assert.deepEqual(document.provenance.notice_evidence_refs, ["notice:20210820102"]);
  assert.deepEqual(document.provenance.evidence_hrefs, ["/notices/20210820102"]);
  assert.equal(document.object_ref, "mandate:66056-006");
  assert.equal(document.canonical_href, "/mandates/66056-006");
});
