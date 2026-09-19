import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ACCESS_STATES,
  BHRAGS_CONTRACT_ID,
  CORPUS_DOCUMENT_ROLES,
  DOCGO_CONTRACT_ID,
  DOCGO_CONTRACT_NUMBER,
  EXECUTED_SCOPE_CLAIMS,
  FIXED_CONTRACT_IDS,
  FIXED_CORPUS_DOCUMENT_IDS,
  REAL_CORPUS_SCHEMA,
  REQUIRED_DOCUMENT_ROLES,
  attachDocumentViaExactIdentity,
  buildRealCorpusDocument,
  classifyCorpusDocumentRole,
  mutationBlocksExecutedScopeClaims,
  refuseNonPublicOrExecutedClaim,
  resolveDocGoAuditIdentity,
  retainCorpusDocument,
  validateAccessStatesWithCorpus,
  validateRealCorpusCoverage,
  verifyRetainedBytes,
} from "../site/procurement_contract_substance_real_corpus.mjs";

const CORPUS = JSON.parse(readFileSync(
  new URL("../site/data/procurement_contract_substance_real_corpus.json", import.meta.url),
  "utf8",
));

const ACCESS = JSON.parse(readFileSync(
  new URL("../site/data/procurement_contract_substance_access.json", import.meta.url),
  "utf8",
));

const FIXTURES = new URL("./fixtures/contract-substance-real-corpus/", import.meta.url);

function rowById(documentId) {
  return CORPUS.rows.find((row) => row.document_id === documentId);
}

test("A1: retains the four official documents with publisher, retrieval, URL, hash, media type, extent, and locator", () => {
  assert.equal(CORPUS.schema, REAL_CORPUS_SCHEMA);
  const coverage = validateRealCorpusCoverage(CORPUS);
  assert.deepEqual(coverage, { ok: true, errors: [] });

  const requiredIds = [
    "city-record-notice-20240829105",
    "dcas-bid-tab-2000090",
    "mocs-fcrc-packet-202411-proposed-agreement",
    "mocs-fcrc-packet-202411-site-schedule",
    "comptroller-docgo-audit-20248801671",
  ];
  assert.deepEqual([...FIXED_CORPUS_DOCUMENT_IDS], requiredIds);

  for (const documentId of requiredIds) {
    const raw = rowById(documentId);
    assert.ok(raw, documentId);
    const retained = retainCorpusDocument(raw);
    assert.equal(retained.ok, true, `${documentId}: ${retained.reasons?.join(",")}`);
    const doc = retained.document;
    assert.equal(doc.document_id, documentId);
    assert.ok(doc.publisher);
    assert.match(doc.retrieved_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(doc.final_url, /^https:\/\//);
    assert.match(doc.content_hash, /^sha256:[a-f0-9]{64}$/);
    assert.ok(doc.media_type);
    assert.ok(doc.page_count >= 1 || doc.extraction_extent);
    assert.ok(doc.locator);
    assert.ok(doc.publication_date);
  }

  // Re-hash the retained DCAS bid-tab fixture against the committed content hash.
  const bidBytes = readFileSync(new URL("dcas-bid-tab-2000090.pdf", FIXTURES));
  assert.equal(verifyRetainedBytes(rowById("dcas-bid-tab-2000090"), bidBytes).ok, true);

  // Notice and audit hashes are recorded from first-party retrieval; verify the
  // hasher rejects mismatched bytes rather than committing full HTML mirrors.
  assert.equal(
    verifyRetainedBytes(rowById("city-record-notice-20240829105"), Buffer.from("not-the-notice")).ok,
    false,
  );
  assert.equal(
    verifyRetainedBytes(rowById("comptroller-docgo-audit-20248801671"), Buffer.from("not-the-audit")).ok,
    false,
  );

  // MOCS packet hash is recorded from the official retrieval; both MOCS rows share it.
  assert.equal(
    rowById("mocs-fcrc-packet-202411-proposed-agreement").content_hash,
    rowById("mocs-fcrc-packet-202411-site-schedule").content_hash,
  );
  assert.equal(rowById("mocs-fcrc-packet-202411-proposed-agreement").page_count, 207);
});

test("A2: classifies retained objects as award_notice, bid_tab, proposed_agreement + site_schedule, and performance_evaluation", () => {
  const expected = {
    "city-record-notice-20240829105": CORPUS_DOCUMENT_ROLES.AWARD_NOTICE,
    "dcas-bid-tab-2000090": CORPUS_DOCUMENT_ROLES.BID_TAB,
    "mocs-fcrc-packet-202411-proposed-agreement": CORPUS_DOCUMENT_ROLES.PROPOSED_AGREEMENT,
    "mocs-fcrc-packet-202411-site-schedule": CORPUS_DOCUMENT_ROLES.SITE_SCHEDULE,
    "comptroller-docgo-audit-20248801671": CORPUS_DOCUMENT_ROLES.PERFORMANCE_EVALUATION,
  };

  for (const [documentId, role] of Object.entries(expected)) {
    const classified = classifyCorpusDocumentRole(rowById(documentId));
    assert.equal(classified.ok, true, documentId);
    assert.deepEqual(classified.roles, [role]);
    assert.equal(classified.executed_agreement, false);
  }

  const mocs = rowById("mocs-fcrc-packet-202411-proposed-agreement");
  assert.equal(mocs.execution_evidence.signature_present, false);
  assert.equal(mocs.execution_evidence.effective_status_admitted, false);

  // Even if a caller stamps executed status, blank signature evidence keeps it proposed.
  const forced = classifyCorpusDocumentRole({
    ...mocs,
    document_role: CORPUS_DOCUMENT_ROLES.PROPOSED_AGREEMENT,
    execution_evidence: {
      signature_present: false,
      effective_status_admitted: true,
      status: "effective_without_signature",
    },
  });
  assert.equal(forced.ok, true);
  assert.deepEqual(forced.roles, [CORPUS_DOCUMENT_ROLES.PROPOSED_AGREEMENT]);
  assert.equal(forced.executed_agreement, false);
});

test("A3: the four fixed contracts retain dated role-specific access states; real docs attach only by exact identity", () => {
  const combined = validateAccessStatesWithCorpus(ACCESS, CORPUS);
  assert.deepEqual(combined, { ok: true, errors: [] });

  assert.deepEqual([...FIXED_CONTRACT_IDS], [
    BHRAGS_CONTRACT_ID,
    "CT110220271400991",
    "CT105720278802113",
    "CT104020273009333",
  ]);

  for (const contractId of FIXED_CONTRACT_IDS) {
    for (const role of REQUIRED_DOCUMENT_ROLES) {
      const row = ACCESS.rows.find((entry) => (
        entry.contract_id === contractId && entry.document_role === role
      ));
      assert.ok(row, `${contractId}/${role}`);
      assert.ok(Object.values(ACCESS_STATES).includes(row.access_state));
      assert.ok(row.observed_at);
      assert.ok(Array.isArray(row.checked_source_ids) && row.checked_source_ids.length >= 1);
    }
  }

  const notice = rowById("city-record-notice-20240829105");
  const attached = attachDocumentViaExactIdentity(notice, notice.identity_links[0]);
  assert.equal(attached.ok, true);
  assert.equal(attached.attachment.contract_id, BHRAGS_CONTRACT_ID);
  assert.equal(attached.attachment.treats_as_executed_agreement, false);

  const soft = attachDocumentViaExactIdentity(notice, {
    relation: "title_resemblance",
    contract_id: BHRAGS_CONTRACT_ID,
    matched_value: BHRAGS_CONTRACT_ID,
  });
  assert.equal(soft.ok, false);
  assert.ok(soft.reasons.includes("identity_relation_must_be_exact"));
});

test("A4: DocGo CT180620248801671 links to the Comptroller audit by contract number without treating it as the executed agreement", () => {
  const audit = rowById("comptroller-docgo-audit-20248801671");
  const resolved = resolveDocGoAuditIdentity(audit);
  assert.equal(resolved.ok, true, resolved.reasons?.join(","));
  assert.equal(resolved.link.cityscroll_contract_id, DOCGO_CONTRACT_ID);
  assert.equal(resolved.link.publisher_contract_number, DOCGO_CONTRACT_NUMBER);
  assert.equal(resolved.link.executed_agreement, false);
  assert.equal(resolved.link.document_role, CORPUS_DOCUMENT_ROLES.PERFORMANCE_EVALUATION);
  assert.equal(resolved.link.treats_as_executed_agreement, false);

  assert.equal(CORPUS.docgo_contract_id, DOCGO_CONTRACT_ID);
  assert.equal(CORPUS.docgo_contract_number, DOCGO_CONTRACT_NUMBER);
});

test("A5: nonofficial reposts, authenticated PASSPort views, login URLs, unsigned templates, titles, metadata rows, and agency descriptions cannot become public_document or executed_agreement", () => {
  const base = rowById("dcas-bid-tab-2000090");
  const negatives = [
    { ...base, nonofficial_repost: true, claim: "public_document" },
    { ...base, authenticated_passport_view: true, claim: "public_document" },
    {
      ...base,
      final_url: "https://passport.cityofnewyork.us/page.aspx/en/r/login",
      public_url: "https://passport.cityofnewyork.us/page.aspx/en/r/login",
      claim: "public_document",
    },
    {
      ...base,
      unsigned_template: true,
      claim: "executed_agreement",
      document_role: "executed_agreement",
    },
    { ...base, document_role: "title", evidence_kind: "title", claim: "public_document" },
    { ...base, document_role: "metadata_row", evidence_kind: "metadata_row", claim: "public_document" },
    {
      ...base,
      document_role: "agency_description",
      evidence_kind: "agency_description",
      claim: "public_document",
    },
    {
      ...base,
      held_candidate: true,
      redistribution_authority: false,
      claim: "public_document",
    },
  ];

  for (const candidate of negatives) {
    const refused = refuseNonPublicOrExecutedClaim(candidate);
    assert.equal(refused.ok, false, JSON.stringify(candidate.claim));
    assert.equal(refused.public_document, false);
    assert.equal(refused.executed_agreement, false);
    assert.ok(refused.reasons.length >= 1);

    // Retention itself also refuses login / nonofficial hosts without provenance.
    if (candidate.public_url?.includes("passport") || candidate.nonofficial_repost || candidate.held_candidate) {
      const retained = retainCorpusDocument({
        ...candidate,
        document_role: CORPUS_DOCUMENT_ROLES.BID_TAB,
        first_party_provenance: candidate.nonofficial_repost ? false : candidate.first_party_provenance,
        provenance_class: candidate.nonofficial_repost ? "nonofficial_repost" : candidate.provenance_class,
      });
      if (candidate.public_url?.includes("passport") || candidate.nonofficial_repost || candidate.held_candidate) {
        assert.equal(retained.ok, false);
      }
    }
  }
});

test("A6: one-at-a-time mutations prove no executed-scope, contractual-price, or vendor-promise assertion survives", () => {
  const base = {
    ...rowById("mocs-fcrc-packet-202411-proposed-agreement"),
    identity_links: [
      {
        relation: "exact_contract_id",
        contract_id: "CT999999999999999",
        matched_value: "CT999999999999999",
      },
    ],
    // Even with a fabricated "would-be executed" stamp, blank signature evidence blocks claims.
    execution_evidence: {
      signature_present: false,
      effective_status_admitted: false,
      status: "blank_signature",
    },
  };

  const fields = [
    "document_role",
    "publisher",
    "contract_identity",
    "signature_execution_evidence",
    "public_url",
    "content_hash",
    "page_locator",
  ];

  for (const field of fields) {
    const result = mutationBlocksExecutedScopeClaims(base, field);
    assert.equal(result.any_claim_survives, false, field);
    for (const claim of EXECUTED_SCOPE_CLAIMS) {
      assert.equal(result.claims[claim], false, `${field}/${claim}`);
    }
  }

  // Bid tab and audit bases likewise cannot support executed-scope claims after mutation.
  for (const documentId of ["dcas-bid-tab-2000090", "comptroller-docgo-audit-20248801671"]) {
    const result = mutationBlocksExecutedScopeClaims(rowById(documentId), "signature_execution_evidence");
    assert.equal(result.any_claim_survives, false, documentId);
  }

  const built = buildRealCorpusDocument({
    rows: CORPUS.rows,
    generatedAt: CORPUS.generated_at,
    retrievalVintage: CORPUS.retrieval_vintage,
  });
  assert.equal(validateRealCorpusCoverage(built).ok, true);
  assert.equal(built.rows.length, CORPUS.rows.length);
});
