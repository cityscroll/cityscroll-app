import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyDocumentType, classifySupersession } from "../warehouse/lib/seqra_document_classifier.mjs";

const REVIEW_KEY = "environmental_review:ceqr:26DCP139X";

describe("seqra_document_classifier: classifyDocumentType", () => {
  it("classifies a Draft Environmental Impact Statement as deis/draft", () => {
    const result = classifyDocumentType({ title: "Draft Environmental Impact Statement (DEIS)" });
    assert.equal(result.document_type, "deis");
    assert.equal(result.document_stage, "draft");
    assert.equal(result.confidence, "high");
  });

  it("classifies a Final Environmental Impact Statement as feis/final, not confused with deis", () => {
    const result = classifyDocumentType({ title: "Final Environmental Impact Statement" });
    assert.equal(result.document_type, "feis");
    assert.equal(result.document_stage, "final");
  });

  it("prefers the more specific Conditioned Negative Declaration over the general Negative Declaration pattern", () => {
    const result = classifyDocumentType({ title: "Conditioned Negative Declaration" });
    assert.equal(result.document_type, "conditioned_negative_declaration");
  });

  it("classifies a plain Negative Declaration distinctly from the conditioned variant", () => {
    const result = classifyDocumentType({ title: "Negative Declaration" });
    assert.equal(result.document_type, "negative_declaration");
  });

  it("returns document_type: null (never a guess) for unrecognized text", () => {
    const result = classifyDocumentType({ title: "Meeting Agenda for Community Board 7" });
    assert.equal(result.document_type, null);
    assert.equal(result.confidence, "unknown");
  });

  it("falls back to a text-sample match at medium confidence when the title alone does not match", () => {
    const result = classifyDocumentType({ title: "Attachment 3", textSample: "This Final Scope of Work for the environmental review is adopted." });
    assert.equal(result.document_type, "final_scope");
    assert.equal(result.confidence, "medium");
  });
});

describe("seqra_document_classifier: classifySupersession", () => {
  const draftDeis = { document_key: "review_document:x:deis:2023-01-01:aaa", document_type: "deis", document_stage: "draft", issued_date: "2023-01-01", superseded_by_document_key: null };

  it("never supersedes anything from a draft-stage candidate", () => {
    const candidate = { document_type: "deis", document_stage: "draft" };
    const result = classifySupersession({ candidate, existingDocumentsForReview: [draftDeis] });
    assert.equal(result.supersedes_document_key, null);
    assert.equal(result.basis, "none");
  });

  it("links a final document to the same-type unsuperseded draft by stage/type pairing when no explicit text reference exists", () => {
    const candidate = { document_type: "deis", document_stage: "final" };
    const result = classifySupersession({ candidate, existingDocumentsForReview: [draftDeis] });
    assert.equal(result.supersedes_document_key, draftDeis.document_key);
    assert.equal(result.basis, "stage_type_pairing");
    assert.equal(result.confidence, "medium");
  });

  it("prefers an explicit text reference over stage/type pairing when both are available, at high confidence", () => {
    const candidate = { document_type: "deis", document_stage: "final" };
    const textSample = "This document supersedes the Draft Environmental Impact Statement issued on March 3, 2023.";
    const result = classifySupersession({ candidate, textSample, existingDocumentsForReview: [draftDeis] });
    assert.equal(result.supersedes_document_key, draftDeis.document_key);
    assert.equal(result.basis, "explicit_text_reference");
    assert.equal(result.confidence, "high");
  });

  it("never links to a draft that is already superseded by another document", () => {
    const alreadySuperseded = { ...draftDeis, superseded_by_document_key: "review_document:x:deis:2023-06-01:bbb" };
    const candidate = { document_type: "deis", document_stage: "final" };
    const result = classifySupersession({ candidate, existingDocumentsForReview: [alreadySuperseded] });
    assert.equal(result.supersedes_document_key, null);
    assert.equal(result.basis, "none");
  });

  it("links a final feis to its paired draft deis, even though 'deis' and 'feis' are different document_type enum values", () => {
    const candidate = { document_type: "feis", document_stage: "final" };
    const result = classifySupersession({ candidate, existingDocumentsForReview: [draftDeis] });
    assert.equal(result.supersedes_document_key, draftDeis.document_key);
    assert.equal(result.basis, "stage_type_pairing");
  });

  it("links a final feis via explicit text reference to a draft deis (real pairing, not the same type string)", () => {
    const candidate = { document_type: "feis", document_stage: "final" };
    const textSample = "This Final Environmental Impact Statement supersedes the Draft Environmental Impact Statement issued on January 15, 2024.";
    const result = classifySupersession({ candidate, textSample, existingDocumentsForReview: [draftDeis] });
    assert.equal(result.supersedes_document_key, draftDeis.document_key);
    assert.equal(result.basis, "explicit_text_reference");
  });

  it("links a final_scope to its paired draft_scope", () => {
    const draftScope = { document_key: "review_document:x:draft_scope:2022-01-01:ccc", document_type: "draft_scope", document_stage: "draft", issued_date: "2022-01-01", superseded_by_document_key: null };
    const candidate = { document_type: "final_scope", document_stage: "final" };
    const result = classifySupersession({ candidate, existingDocumentsForReview: [draftScope] });
    assert.equal(result.supersedes_document_key, draftScope.document_key);
  });

  it("never links documents of different document_type by filename/date proximity alone", () => {
    const draftScope = { document_key: "review_document:x:draft_scope:2022-01-01:ccc", document_type: "draft_scope", document_stage: "draft", issued_date: "2022-01-01", superseded_by_document_key: null };
    const candidate = { document_type: "feis", document_stage: "final" };
    const result = classifySupersession({ candidate, existingDocumentsForReview: [draftScope] });
    assert.equal(result.supersedes_document_key, null);
  });
});
