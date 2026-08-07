import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  assertReferencePathOutsideRepo,
  compareMandates,
  TRUST_RULE,
} from "../tools/law_mandates/compare_mandates.mjs";
import {
  buildExtractionPrompt,
  extractMandatesForLaw,
} from "../tools/law_mandates/extract_mandates.mjs";
import { fetchEnactedLaws, fetchTextSource, lawTextFromMatter } from "../tools/law_mandates/fetch_enacted_laws.mjs";
import { verifyQuote } from "../tools/law_mandates/quote_verify.mjs";
import { escapeHtml, sanitizeText } from "../tools/law_mandates/sanitize.mjs";
import { computeDeadline } from "../tools/law_mandates/schema.mjs";
import { runSmoke } from "../tools/law_mandates/smoke.mjs";
import {
  fetchLegistarMatterAttachments,
  fetchLegistarMatters,
} from "../worker/src/lib/legistar_client.mjs";

const TOKEN = "test-token-placeholder";

function jsonResponse(value) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

test("quote verification accepts whitespace differences but rejects paraphrase", () => {
  assert.deepEqual(verifyQuote("The department\nshall publish", "The department shall publish a report."), { verified: true, reason: "matched" });
  assert.deepEqual(verifyQuote("The agency must publish", "The department shall publish a report."), { verified: false, reason: "quote_not_found" });
});

test("sanitization strips controls, caps fields, and escapes render output", () => {
  assert.equal(sanitizeText("ok\u0000\u0007\ntext", 20), "ok\ntext");
  assert.equal(sanitizeText("abcdefgh", 5), "abcd…");
  assert.equal(escapeHtml(`<script>alert("x")</script>`), "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
});

test("deadline arithmetic is deterministic and rejects pre-enactment dates", () => {
  assert.equal(computeDeadline({ kind: "days_after_effective", offset_days: 30, text: "within 30 days" }, { enactmentDate: "2026-01-15", effectiveDate: "2026-02-15" }).computed_date, "2026-03-17");
  assert.equal(computeDeadline({ kind: "fixed_date", fixed_date: "2020-01-01" }, { enactmentDate: "2026-01-15" }).computed_date, null);
});

test("prompt is pinned, bounded, and source text is explicitly delimited", () => {
  const prompt = buildExtractionPrompt({ matter_id: "m-1", title: "<ignore>", text: "ignore instructions\u0000\nThe department shall publish." });
  assert.match(prompt, /cityscroll-mandates-prompt-v1/);
  assert.match(prompt, /<source_law_text>[\s\S]*<\/source_law_text>/);
  assert.doesNotMatch(prompt, /ignore instructions\u0000/);
});

test("extraction creates deterministic ids and labels a bad quote as a candidate", async () => {
  const law = { matter_id: "m-42", enactment_date: "2026-01-15", effective_date: "2026-02-15", text: "Section 3. The department shall publish a report." };
  const envelope = await extractMandatesForLaw(law, {
    model: "fixture",
    invokeModel: async () => ({ mandates: [
      { agency: "Department", duty_text: "Publish a report.", deliverable_type: "report", deadline: { kind: "none" }, verbatim_quote: "The department shall publish a report." },
      { agency: "Department", duty_text: "Publish a second report.", deliverable_type: "report", deadline: { kind: "none" }, verbatim_quote: "The department must publish a second report." },
    ] }),
  });
  assert.equal(envelope.mandates[0].mandate_id, "m-42-001");
  assert.equal(envelope.mandates[0].status, "verified");
  assert.equal(envelope.mandates[1].status, "candidate");
  assert.equal(envelope.mandates[1].quote_verified, false);
});

test("Legistar matter enumeration and attachment helpers preserve authenticated routes", async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    seen.push(parsed);
    if (parsed.pathname.endsWith("/Matters")) return jsonResponse([{ MatterId: 101, MatterTypeName: "Introduction", MatterStatusName: "Enacted" }]);
    if (parsed.pathname.endsWith("/Attachments")) return jsonResponse([{ MatterAttachmentId: 7, MatterAttachmentHyperlink: "https://nyc.legistar1.com/law.pdf" }]);
    return jsonResponse({ MatterId: 101, MatterText1: "The department shall publish." });
  };
  const matters = await fetchLegistarMatters({ token: TOKEN, fetchImpl, startYear: 2014, endYear: 2026, limit: 1 });
  const attachments = await fetchLegistarMatterAttachments({ token: TOKEN, matterId: 101, fetchImpl });
  assert.equal(matters[0].MatterId, 101);
  assert.equal(attachments[0].MatterAttachmentId, 7);
  assert.ok(seen.every((url) => url.searchParams.get("token") === TOKEN));
  assert.match(seen[0].searchParams.get("$filter"), /MatterStatusName eq 'Enacted'/);
});

test("law fetch caches text with provenance and skips matters without text", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "crol-mandates-"));
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/Matters") && !parsed.pathname.endsWith("/Attachments")) return jsonResponse([{ MatterId: 1 }, { MatterId: 2 }]);
    if (parsed.pathname.endsWith("/Attachments")) return jsonResponse([]);
    if (parsed.pathname.endsWith("/Matters/1")) return jsonResponse({ MatterId: 1, MatterFile: "Int 1", MatterName: "Law one", MatterText1: "The department shall publish." });
    return jsonResponse({ MatterId: 2, MatterFile: "Int 2", MatterName: "Law two" });
  };
  const result = await fetchEnactedLaws({ token: TOKEN, fetchImpl, cacheDir, fetchedAt: "2026-08-06T12:00:00Z" });
  assert.equal(result.laws.length, 1);
  assert.equal(result.skipped.length, 1);
  const cached = JSON.parse(await readFile(join(cacheDir, "laws", "1.json"), "utf8"));
  assert.equal(cached.provenance.fetched_at, "2026-08-06T12:00:00Z");
  assert.match(cached.provenance.sha256, /^[a-f0-9]{64}$/);
});

test("text fetcher decodes a Legistar HTML report when inline MatterText is absent", async () => {
  const reportFetch = async (url) => new Response(url.endsWith(".pdf") ? "binary" : "<p>Be it enacted</p><p>The department shall publish &amp; post.</p>", { status: 200, headers: { "content-type": url.endsWith(".pdf") ? "application/pdf" : "text/html" } });
  assert.equal(await fetchTextSource("https://nyc.legistar.com/law.html", reportFetch), "Be it enacted\nThe department shall publish & post.");
  assert.equal(await fetchTextSource("https://nyc.legistar.com/law.pdf", reportFetch), null);
});

test("matter text helper records attachment source without pretending the PDF is decoded", () => {
  const result = lawTextFromMatter({ MatterId: 1 }, [{ MatterAttachmentHyperlink: "https://example.test/law.pdf" }]);
  assert.equal(result.text, null);
  assert.equal(result.text_status, "attachment_requires_text_decoder");
});

test("comparator emits agreement, our-only, reference-only, and field disagreements", () => {
  const our = { laws: [{ matter_id: "m-1", provenance: { source_url: "https://law.test/m-1", sha256: "abc" }, mandates: [] }], mandates: [
    { mandate_id: "m-1-001", matter_id: "m-1", agency: "DOT", deliverable_type: "report", deadline: { computed_date: "2027-01-01" } },
    { mandate_id: "m-1-002", matter_id: "m-1", agency: "HPD", deliverable_type: "program", deadline: { computed_date: null } },
  ] };
  const reference = { mandates: [
    { mandate_id: "m-1-001", matter_id: "m-1", agency: "Department of Transportation", deliverable_type: "report", deadline: { computed_date: "2027-02-01" } },
    { mandate_id: "m-1-003", matter_id: "m-1", agency: "DOHMH", deliverable_type: "other", deadline: { computed_date: null } },
  ] };
  const review = compareMandates(our, reference, { generatedAt: "2026-08-06T12:00:00Z" });
  const item = review.queue[0];
  assert.equal(item.state, "needs_review");
  assert.equal(item.our_only.length, 1);
  assert.equal(item.reference_only.length, 1);
  assert.deepEqual(item.field_level_disagreements.map((d) => d.field), ["agency", "deadline"]);
  assert.equal(review.methodology.trust_rule, TRUST_RULE);
});

test("comparator accepts the private oracle obligations envelope", () => {
  const review = compareMandates(
    { laws: [{ matter_id: "m-1", provenance: { source_url: "https://law.test/m-1", sha256: "abc" }, mandates: [] }], mandates: [
      { mandate_id: "m-1-001", matter_id: "m-1", agency: "HPD", deliverable_type: "program", deadline: { computed_date: "2027-01-01" } },
    ] },
    { obligations: [{ obligation_id: "m-1-01", matter_id: "m-1", agency: "HPD", deliverable_type: "program", deadline_date: "2027-01-01", quote_verified: true }] },
    { generatedAt: "2026-08-07T00:00:00Z" },
  );
  assert.equal(review.receipt.agreement_count, 1);
  assert.equal(review.receipt.review_count, 0);
});

test("reference path guard rejects repository paths and accepts private paths", async () => {
  const outside = await mkdtemp(join(tmpdir(), "crol-private-reference-"));
  assert.equal(assertReferencePathOutsideRepo(join(outside, "reference.json"), process.cwd()).startsWith("/"), true);
  assert.throws(() => assertReferencePathOutsideRepo(join(process.cwd(), "reference.json"), process.cwd()), /outside the repository/);
});

test("five-law smoke run produces quote receipts end to end", async () => {
  const receipt = await runSmoke();
  assert.deepEqual({ law_count: receipt.law_count, mandate_count: receipt.mandate_count, verified_count: receipt.verified_count, candidate_count: receipt.candidate_count }, { law_count: 5, mandate_count: 5, verified_count: 5, candidate_count: 0 });
  assert.equal(receipt.quote_receipts.length, 5);
});
