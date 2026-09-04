import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildActionKey,
  buildDeterminationKey,
  buildEnvironmentalReviewKey,
  buildReviewDocumentKey,
  normalizeCeqrNumber,
  normalizeKeyToken,
  SeqraStableKeyError,
} from "../warehouse/lib/seqra_stable_keys.mjs";

describe("SEQRA/CEQR stable keys", () => {
  it("normalizes a published CEQR number and rejects an invalid shape", () => {
    assert.equal(normalizeCeqrNumber(" 26dcp001x "), "26DCP001X");
    assert.equal(normalizeCeqrNumber("11-123M"), "11-123M");
    assert.equal(normalizeCeqrNumber("not a ceqr number"), null);
    assert.equal(normalizeCeqrNumber(null), null);
  });

  it("builds a deterministic environmental_review:ceqr key from a normalized CEQR number", () => {
    const a = buildEnvironmentalReviewKey({ environmentalRegime: "CEQR", ceqrNumber: "26dcp001x" });
    const b = buildEnvironmentalReviewKey({ environmentalRegime: "CEQR", ceqrNumber: " 26DCP001X " });
    assert.equal(a, "environmental_review:ceqr:26DCP001X");
    assert.equal(a, b);
  });

  it("rejects a CEQR review key with a missing or malformed ceqrNumber rather than generating an unstable key", () => {
    assert.throws(() => buildEnvironmentalReviewKey({ environmentalRegime: "CEQR" }), SeqraStableKeyError);
    assert.throws(() => buildEnvironmentalReviewKey({ environmentalRegime: "CEQR", ceqrNumber: "garbage" }), SeqraStableKeyError);
  });

  it("builds a deterministic environmental_review:seqra key from lead agency + source review id", () => {
    const a = buildEnvironmentalReviewKey({ environmentalRegime: "SEQRA", leadAgency: "NYS DEC", sourceReviewId: "APP-001" });
    const b = buildEnvironmentalReviewKey({ environmentalRegime: "SEQRA", leadAgency: " nys dec ", sourceReviewId: "app-001" });
    assert.equal(a, "environmental_review:seqra:nys_dec:app_001");
    assert.equal(a, b);
  });

  it("falls back to a stable hash-derived id only when sourceReviewId is absent, and rejects when neither is given", () => {
    const a = buildEnvironmentalReviewKey({ environmentalRegime: "SEQRA", leadAgency: "NYS DEC", sourceReviewIdHashSeed: "NYS DEC|APP-001|2026-01-05" });
    const b = buildEnvironmentalReviewKey({ environmentalRegime: "SEQRA", leadAgency: "NYS DEC", sourceReviewIdHashSeed: "NYS DEC|APP-001|2026-01-05" });
    assert.equal(a, b);
    assert.match(a, /^environmental_review:seqra:nys_dec:h[0-9a-f]{16}$/);
    assert.throws(() => buildEnvironmentalReviewKey({ environmentalRegime: "SEQRA", leadAgency: "NYS DEC" }), SeqraStableKeyError);
  });

  it("never collides a CEQR key with a SEQRA key even when their normalized identity text would otherwise match", () => {
    const ceqr = buildEnvironmentalReviewKey({ environmentalRegime: "CEQR", ceqrNumber: "26-000A" });
    const seqra = buildEnvironmentalReviewKey({ environmentalRegime: "SEQRA", leadAgency: "26", sourceReviewId: "000A" });
    assert.notEqual(ceqr, seqra);
  });

  it("rejects an environmentalRegime outside SEQRA/CEQR (e.g. CEQA) rather than building a key for it", () => {
    assert.throws(() => buildEnvironmentalReviewKey({ environmentalRegime: "CEQA", ceqrNumber: "26DCP001X" }), SeqraStableKeyError);
  });

  it("builds a deterministic action key and rejects a missing identity input", () => {
    const key = buildActionKey({ agency: "DCP", sourceSystem: "ZAP", sourceActionId: "N-2026-0001" });
    assert.equal(key, "action:dcp:zap:n_2026_0001");
    assert.throws(() => buildActionKey({ agency: "DCP", sourceSystem: "ZAP" }), SeqraStableKeyError);
  });

  it("builds a deterministic determination key requiring an ISO date", () => {
    const key = buildDeterminationKey({ agency: "DCP", actionId: "N-2026-0001", date: "2026-06-01" });
    assert.equal(key, "determination:dcp:n_2026_0001:2026-06-01");
    assert.throws(() => buildDeterminationKey({ agency: "DCP", actionId: "N-2026-0001", date: "06/01/2026" }), SeqraStableKeyError);
  });

  it("builds a deterministic review_document key and rejects an unrecognized document type or short hash", () => {
    const reviewKey = buildEnvironmentalReviewKey({ environmentalRegime: "CEQR", ceqrNumber: "26DCP001X" });
    const key = buildReviewDocumentKey({ reviewKey, documentType: "DEIS", issuedDate: "2026-03-01", contentHash: "sha256:" + "a".repeat(64) });
    assert.equal(key, `review_document:${reviewKey}:deis:2026-03-01:${"a".repeat(12)}`);
    assert.throws(() => buildReviewDocumentKey({ reviewKey, documentType: "not_a_type", issuedDate: "2026-03-01", contentHash: "a".repeat(64) }), SeqraStableKeyError);
    assert.throws(() => buildReviewDocumentKey({ reviewKey, documentType: "deis", issuedDate: "2026-03-01", contentHash: "abc" }), SeqraStableKeyError);
  });

  it("two review_document keys for the same review/type/date but different content never collide", () => {
    const reviewKey = buildEnvironmentalReviewKey({ environmentalRegime: "CEQR", ceqrNumber: "26DCP001X" });
    const first = buildReviewDocumentKey({ reviewKey, documentType: "deis", issuedDate: "2026-03-01", contentHash: "a".repeat(64) });
    const second = buildReviewDocumentKey({ reviewKey, documentType: "deis", issuedDate: "2026-03-01", contentHash: "b".repeat(64) });
    assert.notEqual(first, second);
  });

  it("normalizeKeyToken collapses whitespace/punctuation variance to the same token", () => {
    assert.equal(normalizeKeyToken("NYS Department of Environmental Conservation", "x"), "nys_department_of_environmental_conservation");
    assert.equal(normalizeKeyToken("  DCP  ", "x"), "dcp");
    assert.throws(() => normalizeKeyToken("   ", "x"), SeqraStableKeyError);
    assert.throws(() => normalizeKeyToken(null, "x"), SeqraStableKeyError);
  });
});
