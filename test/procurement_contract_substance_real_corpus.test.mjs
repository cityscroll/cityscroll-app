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
  evaluateExecutedScopeClaims,
  mutationBlocksExecutedScopeClaims,
  refuseNonPublicOrExecutedClaim,
  resolveDocGoAuditIdentity,
  retainCorpusDocument,
  validateAccessStatesWithCorpus,
  validateRealCorpusCoverage,
  verifyRetainedBytes,
} from "../site/procurement_contract_substance_real_corpus.mjs";
import {
  DCAS_BID_IDENTITY,
  ROLE_CORPUS_SCHEMA,
  evaluateRolePassageClaims,
  mineRetainedRoleCorpus,
  mutateRolePassage,
  reportRoleCorpusBuildCounts,
  toPerformanceEvidenceRows,
} from "../site/procurement_contract_substance_role_corpus.mjs";
import {
  EVIDENCE_ROLES,
  FACT_KINDS,
  PROJECTOR_VERSION,
  RESIDENT_VENDOR_PROMISE_LABEL,
  STANDING_LABELS,
} from "../site/procurement_contract_substance.mjs";
import { testClockISOString, withPinnedClock } from "./helpers/test_clock.mjs";

const CORPUS = JSON.parse(readFileSync(
  new URL("../site/data/procurement_contract_substance_real_corpus.json", import.meta.url),
  "utf8",
));

const ACCESS = JSON.parse(readFileSync(
  new URL("../site/data/procurement_contract_substance_access.json", import.meta.url),
  "utf8",
));

const ROLE_PASSAGES = JSON.parse(readFileSync(
  new URL("./fixtures/contract-substance-real-corpus/role-passages.json", import.meta.url),
  "utf8",
));

const ROLE_CORPUS = JSON.parse(readFileSync(
  new URL("../site/data/procurement_contract_substance_role_corpus.json", import.meta.url),
  "utf8",
));

const PERFORMANCE_EVIDENCE = JSON.parse(readFileSync(
  new URL("../site/data/performance_evidence_sources.json", import.meta.url),
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

test("A6: one-at-a-time mutations prove no executed-scope, contractual-price, or vendor-promise assertion survives", async () => {
  await withPinnedClock("2026-09-19T12:00:00.000Z", async () => {
    // Positive control: signed, effective, exact identity, hash, and locator intact.
    // Claims must survive on this base so each single-field removal is shown to
    // knock them down rather than starting from an already-false base.
    const positiveControl = {
      ...rowById("mocs-fcrc-packet-202411-site-schedule"),
      retrieved_at: testClockISOString(),
      identity_links: [
        {
          relation: "exact_contract_id",
          contract_id: "CT999999999999999",
          matched_value: "CT999999999999999",
        },
      ],
      execution_evidence: {
        signature_present: true,
        effective_status_admitted: true,
        status: "executed_admitted",
      },
    };

    const intact = evaluateExecutedScopeClaims(positiveControl);
    assert.equal(intact.retained_ok, true);
    assert.equal(intact.any_claim_survives, true);
    for (const claim of EXECUTED_SCOPE_CLAIMS) {
      assert.equal(intact.claims[claim], true, `intact/${claim}`);
    }

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
      const result = mutationBlocksExecutedScopeClaims(positiveControl, field);
      assert.equal(result.any_claim_survives, false, field);
      for (const claim of EXECUTED_SCOPE_CLAIMS) {
        assert.equal(result.claims[claim], false, `${field}/${claim}`);
      }
    }

    // Unsigned proposed-agreement, bid-tab, and audit bases remain hard negatives.
    const unsignedProposed = {
      ...rowById("mocs-fcrc-packet-202411-proposed-agreement"),
      retrieved_at: testClockISOString(),
      identity_links: [
        {
          relation: "exact_contract_id",
          contract_id: "CT999999999999999",
          matched_value: "CT999999999999999",
        },
      ],
      execution_evidence: {
        signature_present: false,
        effective_status_admitted: false,
        status: "blank_signature",
      },
    };
    assert.equal(evaluateExecutedScopeClaims(unsignedProposed).any_claim_survives, false);
    for (const documentId of ["dcas-bid-tab-2000090", "comptroller-docgo-audit-20248801671"]) {
      const result = mutationBlocksExecutedScopeClaims(
        { ...rowById(documentId), retrieved_at: testClockISOString() },
        "signature_execution_evidence",
      );
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
});

test("role-corpus A1: real extraction yields accepted rows from DCAS, MOCS, and Comptroller with hash, locator, excerpt hash, quality, and projector version", () => {
  const mined = mineRetainedRoleCorpus({ corpus: CORPUS, passages: ROLE_PASSAGES });
  assert.equal(mined.ok, true, mined.errors.join(","));
  assert.equal(mined.document.schema, ROLE_CORPUS_SCHEMA);
  assert.equal(ROLE_CORPUS.schema, ROLE_CORPUS_SCHEMA);

  const byDoc = {
    "dcas-bid-tab-2000090": mined.document.rows.filter((row) => row.corpus_document_id === "dcas-bid-tab-2000090"),
    "mocs-fcrc-packet-202411-proposed-agreement": mined.document.rows.filter((row) => row.corpus_document_id === "mocs-fcrc-packet-202411-proposed-agreement"),
    "comptroller-docgo-audit-20248801671": mined.document.rows.filter((row) => row.corpus_document_id === "comptroller-docgo-audit-20248801671"),
  };
  for (const [documentId, rows] of Object.entries(byDoc)) {
    assert.ok(rows.length >= 1, documentId);
    for (const row of rows) {
      assert.equal(row.provenance_class, "real_source");
      assert.match(row.content_hash, /^sha256:[a-f0-9]{64}$/);
      assert.match(row.excerpt_hash, /^sha256:[a-f0-9]{64}$/);
      assert.ok(row.locator);
      assert.ok(row.extraction_quality);
      assert.equal(row.projector_version, PROJECTOR_VERSION);
      assert.equal(row.status, "admitted");
    }
  }

  // Hand-authored fixture-only rows do not satisfy the positive corpus obligation.
  const counts = reportRoleCorpusBuildCounts({
    realRows: mined.document.rows,
    mutationRows: [],
    fixtureRows: [{ fact_id: "fixture-only" }],
  });
  assert.equal(counts.real_source_row_count, mined.document.rows.length);
  assert.equal(counts.fixture_row_count, 1);
  assert.equal(ROLE_CORPUS.build_counts.real_source_row_count, ROLE_CORPUS.rows.length);
  assert.equal(ROLE_CORPUS.build_counts.fixture_row_count, 0);
});

test("role-corpus A2: DCAS bid tab retains offered washer unit prices and class awards as bid_tab facts, never executed rates", () => {
  const mined = mineRetainedRoleCorpus({ corpus: CORPUS, passages: ROLE_PASSAGES });
  const dcas = mined.document.rows.filter((row) => row.contract_id === DCAS_BID_IDENTITY);
  assert.ok(dcas.length >= 3);
  assert.ok(dcas.some((row) => /item 1/.test(row.locator) && /POT PAN & UTENSIL WASHER/i.test(row.excerpt)));
  assert.ok(dcas.some((row) => /item 2/.test(row.locator)));
  assert.ok(dcas.some((row) => /page 2/.test(row.locator) && /AUKEE TRADING CORPORATION/i.test(row.excerpt)));
  for (const row of dcas) {
    assert.equal(row.document_role, "bid_tab");
    assert.equal(row.standing_label, STANDING_LABELS.BID_OFFER);
    assert.equal(row.resident_claim_label, "Bid offer");
    assert.notEqual(row.standing_label, STANDING_LABELS.EXECUTED);
    assert.notEqual(row.resident_claim_label, RESIDENT_VENDOR_PROMISE_LABEL);
  }
});

test("role-corpus A3: MOCS retains proposed GrowNYC payment, duties, Exhibit A sites, and tennis template fees", () => {
  const mined = mineRetainedRoleCorpus({ corpus: CORPUS, passages: ROLE_PASSAGES });
  const mocs = mined.document.rows.filter((row) => row.corpus_document_id === "mocs-fcrc-packet-202411-proposed-agreement");
  assert.ok(mocs.some((row) => /page 35/.test(row.locator) && /fees payable/i.test(row.excerpt)));
  assert.ok(mocs.some((row) => /pages 41-43/.test(row.locator) && /sole cost and expense/i.test(row.excerpt)));
  assert.ok(mocs.some((row) => /pages 48-53/.test(row.locator)));
  assert.ok(mocs.some((row) => /EXHIBIT A/i.test(row.excerpt) && /Joyce Kilmer Park/i.test(row.excerpt) && /Poe Park/i.test(row.excerpt)));
  assert.ok(mocs.some((row) => /Tennis/i.test(row.excerpt) && /Season 1 \(2024\): \$500\.00/.test(row.excerpt)));
  for (const row of mocs) {
    assert.ok(["proposed_agreement", "template_pricing"].includes(row.document_role), row.document_role);
    assert.ok([STANDING_LABELS.PROPOSED, STANDING_LABELS.TEMPLATE].includes(row.standing_label));
    assert.notEqual(row.resident_claim_label, RESIDENT_VENDOR_PROMISE_LABEL);
    assert.notEqual(row.standing_label, STANDING_LABELS.EXECUTED);
  }
});

test("role-corpus A4: DocGo audit retains reported meal and security rates linked to CT180620248801671 with audit wording", () => {
  const mined = mineRetainedRoleCorpus({ corpus: CORPUS, passages: ROLE_PASSAGES });
  const audit = mined.document.rows.filter((row) => row.contract_id === DOCGO_CONTRACT_ID);
  assert.ok(audit.some((row) => /\$11 per meal/i.test(row.excerpt) && /\$33 per person per day/i.test(row.excerpt)));
  assert.ok(audit.some((row) => /\$50 per hour/i.test(row.excerpt)));
  assert.ok(audit.some((row) => /50 or more Service Recipients/i.test(row.excerpt)));
  for (const row of audit) {
    assert.equal(row.document_role, "performance_evaluation");
    assert.equal(row.standing_label, STANDING_LABELS.AUDIT_REPORTED);
    assert.equal(row.resident_claim_label, "The audit reports these contract terms");
    assert.notEqual(row.resident_claim_label, RESIDENT_VENDOR_PROMISE_LABEL);
  }
});

test("role-corpus A5: performance_evidence_sources.json carries only real retained provenance and separate build counts", () => {
  assert.ok(Array.isArray(PERFORMANCE_EVIDENCE.rows));
  assert.ok(PERFORMANCE_EVIDENCE.rows.length >= 3);
  assert.ok(PERFORMANCE_EVIDENCE.build_counts.real_source_row_count >= 1);
  assert.equal(PERFORMANCE_EVIDENCE.build_counts.fixture_row_count, 0);
  assert.equal(PERFORMANCE_EVIDENCE.build_counts.mutation_row_count, 0);
  assert.ok(PERFORMANCE_EVIDENCE.source_coverage.some((row) => row.source_id === "dcas-bid-tabs"));
  assert.ok(PERFORMANCE_EVIDENCE.source_coverage.some((row) => row.source_id === "mocs-fcrc"));
  assert.ok(PERFORMANCE_EVIDENCE.source_coverage.some((row) => row.source_id === "comptroller-audits"));

  const mined = mineRetainedRoleCorpus({ corpus: CORPUS, passages: ROLE_PASSAGES });
  const expected = toPerformanceEvidenceRows(mined.document.rows);
  assert.deepEqual(
    PERFORMANCE_EVIDENCE.rows.map((row) => row.prime_contract_id).sort(),
    expected.map((row) => row.prime_contract_id).sort(),
  );
  for (const row of PERFORMANCE_EVIDENCE.rows) {
    for (const item of row.evidence_items) {
      assert.ok(item.source_passage.content_hash);
      assert.ok(item.source_passage.excerpt_hash);
      assert.ok(item.source_passage.locator);
      assert.equal(item.source_passage.projector_version, PROJECTOR_VERSION);
    }
  }
});

test("role-corpus A7: role-swap, blank-signature, stale-hash, missing-page, OCR-garble, conflicting-passage, and missing-contract-identity fail closed", async () => {
  await withPinnedClock("2026-09-19T12:00:00.000Z", async () => {
    // Positive control: signed, effective, intact executed obligation. Claims
    // must survive on this base so each adversarial mutation is shown to knock
    // them down rather than starting from an already-false base.
    const positiveControl = {
      contract_id: "CT107120258801626",
      document_id: "doc-executed-obligation-positive",
      source_document_id: "doc-executed-obligation-positive",
      document_role: EVIDENCE_ROLES.EXECUTED_OBLIGATION,
      content_hash: rowById("dcas-bid-tab-2000090").content_hash,
      public_url: "https://www.nyc.gov/assets/example/executed-obligation.pdf",
      publication_date: testClockISOString().slice(0, 10),
      locator: "page 3 / section 2.1 Scope of Services",
      excerpt: "The Contractor shall provide home care services to eligible residents within the service area during the contract term at the agreed unit rates.",
      fact_kind: FACT_KINDS.OBLIGATION,
      obligated_party: "vendor",
      action: "provide",
      deliverable: "home care services",
      execution_evidence: {
        signature_present: true,
        effective_status_admitted: true,
        status: "executed_admitted",
      },
      retrieved_at: testClockISOString(),
    };

    const intact = evaluateRolePassageClaims(positiveControl);
    assert.equal(intact.ok, true);
    assert.equal(intact.any_claim_survives, true);
    assert.equal(intact.fact?.resident_claim_label, RESIDENT_VENDOR_PROMISE_LABEL);
    assert.equal(intact.fact?.resident_assertion, true);
    assert.equal(intact.document_retrievable, true);

    for (const mutation of [
      "role_swap",
      "blank_signature",
      "stale_hash",
      "missing_page",
      "ocr_garble",
      "conflicting_passage",
      "missing_contract_identity",
    ]) {
      const result = mutateRolePassage(positiveControl, mutation);
      assert.equal(result.any_claim_survives, false, mutation);
      assert.equal(result.document_retrievable, true, mutation);
      assert.equal(result.unresolved?.resident_assertion, false, mutation);
    }

    // Bid-tab bases remain hard negatives: the same mutations cannot manufacture
    // a vendor-promise claim from non-executed evidence.
    const bidBase = {
      contract_id: DCAS_BID_IDENTITY,
      document_id: "dcas-bid-tab-2000090",
      source_document_id: "dcas-bid-tab-2000090",
      document_role: EVIDENCE_ROLES.BID_TAB,
      content_hash: rowById("dcas-bid-tab-2000090").content_hash,
      public_url: rowById("dcas-bid-tab-2000090").final_url,
      publication_date: testClockISOString().slice(0, 10),
      locator: "PDF page 1 / item 1",
      excerpt: ROLE_PASSAGES.dcas_page1.slice(0, 500),
      fact_kind: FACT_KINDS.PRICE_TERM,
      payment_basis: "unit_price",
      description: "washer",
      quantity: 1,
      unit: "each",
      rate: 22287,
      retrieved_at: testClockISOString(),
    };
    assert.equal(evaluateRolePassageClaims(bidBase).any_claim_survives, false);
    for (const mutation of [
      "role_swap",
      "blank_signature",
      "stale_hash",
      "missing_page",
      "ocr_garble",
      "conflicting_passage",
      "missing_contract_identity",
    ]) {
      const result = mutateRolePassage(bidBase, mutation);
      assert.equal(result.any_claim_survives, false, `bid/${mutation}`);
      assert.equal(result.document_retrievable, true, `bid/${mutation}`);
    }
  });
});
