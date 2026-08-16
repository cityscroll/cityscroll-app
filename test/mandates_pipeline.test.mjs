import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  extractMandatesForLawChunked,
  splitLawTextForExtraction,
} from "../tools/law_mandates/extract_mandates.mjs";
import {
  fetchEnactedLaws,
  fetchTextSource,
  finalLawAttachmentFromLegistarDetailHtml,
  lawTextFromLegistarDetailHtml,
  lawTextFromMatter,
} from "../tools/law_mandates/fetch_enacted_laws.mjs";
import {
  applyUnverifiedCandidateRemovals,
  applyVerifiedMissingMandates,
  applyVerifiedUnsupportedRemovals,
  applyVerifiedQuoteRepairs,
  buildFidelitySelfCheckPrompt,
  normalizeFidelitySelfCheck,
} from "../tools/law_mandates/fidelity_check.mjs";
import { verifyQuote } from "../tools/law_mandates/quote_verify.mjs";
import { retainedLawsFromReference } from "../tools/law_mandates/retained_retry.mjs";
import { publicRetainedRetryEvidence } from "../tools/law_mandates/build_retained_retry_evidence.mjs";
import { escapeHtml, sanitizeText } from "../tools/law_mandates/sanitize.mjs";
import { computeDeadline, normalizeRecurrence } from "../tools/law_mandates/schema.mjs";
import { runSmoke } from "../tools/law_mandates/smoke.mjs";
import {
  fetchLegistarMatterAttachments,
  fetchLegistarMatters,
} from "../worker/src/lib/legistar_client.mjs";

const TOKEN = "test-token-placeholder";
const LOOKUP_PATH = new URL("../site/data/agency_obligations_lookup.json", import.meta.url);

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
  assert.match(prompt, /cityscroll-mandates-prompt-v2/);
  assert.match(prompt, /mandatory constraints/i);
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
  assert.equal(envelope.enactment_date, "2026-01-15");
  assert.equal(envelope.effective_date, "2026-02-15");
});

test("extraction tolerates a trailing comma in otherwise valid model JSON", async () => {
  const envelope = await extractMandatesForLaw({ matter_id: "m-json", text: "This local law takes effect immediately." }, {
    model: "fixture",
    invokeModel: async () => '{"mandates":[],}',
  });
  assert.deepEqual(envelope.mandates, []);
});

test("extraction retries a malformed model envelope before failing the law", async () => {
  let calls = 0;
  const envelope = await extractMandatesForLaw({ matter_id: "m-json-retry", text: "This local law takes effect immediately." }, {
    model: "fixture",
    invokeModel: async () => {
      calls += 1;
      return calls === 1 ? '{"mandates":[{"agency": invalid}]}' : '{"mandates":[]}';
    },
  });
  assert.equal(calls, 2);
  assert.deepEqual(envelope.mandates, []);
});

test("large-law extraction preserves paragraph boundaries and renumbers merged mandates", async () => {
  const text = [
    "Section 1. The department shall publish alpha.",
    "Section 2. " + "context ".repeat(8),
    "Section 3. The department shall publish beta.",
  ].join("\n\n");
  assert.equal(splitLawTextForExtraction(text, 100).join("\n\n"), text);
  const envelope = await extractMandatesForLawChunked({ matter_id: "m-chunk", text }, {
    model: "fixture",
    chunkSize: 100,
    invokeModel: async ({ prompt }) => ({ mandates: [
      ...(prompt.includes("publish alpha") ? [{ agency: "Department", duty_text: "Publish alpha.", verbatim_quote: "The department shall publish alpha." }] : []),
      ...(prompt.includes("publish beta") ? [{ agency: "Department", duty_text: "Publish beta.", verbatim_quote: "The department shall publish beta." }] : []),
    ] }),
  });
  assert.deepEqual(envelope.mandates.map((row) => row.mandate_id), ["m-chunk-001", "m-chunk-002"]);
  assert.ok(envelope.mandates.every((row) => row.quote_verified));
  assert.equal(envelope.extraction_strategy.chunk_count, 3);
});

test("law envelopes fail closed on malformed temporal anchors", async () => {
  const law = {
    matter_id: "m-invalid-date",
    enactment_date: "2026-02-30",
    effective_date: "February 31, 2026",
    text: "The department shall publish a report.",
  };
  const envelope = await extractMandatesForLaw(law, {
    model: "fixture",
    invokeModel: async () => ({ mandates: [] }),
  });
  assert.equal(envelope.enactment_date, null);
  assert.equal(envelope.effective_date, null);
});

test("recurrence requires an explicit recurring signal beyond an effective-date offset", () => {
  assert.equal(normalizeRecurrence("annual", {
    deadlineText: "No later than 1 year after the effective date of the local law",
    dutyText: "Submit a report.",
    verbatimQuote: "No later than 1 year after the effective date of the local law",
    quoteVerified: true,
    deliverableType: "report",
  }), "one-time");
  assert.equal(normalizeRecurrence("one-time", {
    deadlineText: "No later than 1 year after the effective date of the local law",
    dutyText: "Submit a report.",
    verbatimQuote: "No later than 1 year after the effective date of the local law, and annually thereafter",
    quoteVerified: true,
    deliverableType: "report",
  }), "annual");
  // Annual subject matter does not make a rulemaking duty recurring.
  assert.equal(normalizeRecurrence("one-time", {
    dutyText: "Establish by rule annual building emissions limits.",
    verbatimQuote: "Establish annual building emissions limits.",
    quoteVerified: true,
    deliverableType: "rulemaking",
  }), "one-time");
});

test("committed annual audit corrections retain recurring report mandates", () => {
  const lookup = JSON.parse(readFileSync(LOOKUP_PATH, "utf8"));
  const rows = Object.values(lookup.by_agency).flatMap((agency) => agency.obligations || []);
  for (const id of ["76891-001", "56104-001", "53107-001", "71638-001", "72198-001"]) {
    assert.equal(rows.find((row) => row.obligation_id === id)?.recurrence, "annual", id);
  }
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

test("Legistar detail text extraction isolates the enacted bill text", () => {
  const html = `
    <div id="ctl00_ContentPlaceHolder1_pageText">
      <div id="ctl00_ContentPlaceHolder1_divText">
        <p>Be it enacted by the Council as follows:</p>
        <p>&sect; 1. The department shall publish &amp; retain a report.</p>
      </div>
    </div>
    <div id="ctl00_ContentPlaceHolder1_pagePublicComments"><p>not statute text</p></div>`;
  assert.equal(
    lawTextFromLegistarDetailHtml(html),
    "Be it enacted by the Council as follows:\n\n§ 1. The department shall publish & retain a report.",
  );
});

test("Legistar detail attachment selection prefers the machine-readable final bill", () => {
  const html = `
    <span id="ctl00_ContentPlaceHolder1_lblAttachments2">
      1. <a href="View.ashx?M=F&amp;ID=1">Summary of Int. No. 1</a>,
      2. <a href="View.ashx?M=F&amp;ID=2">Int. No. 1-A (FINAL)</a>,
      3. <a href="View.ashx?M=F&amp;ID=3">Local Law 7</a>
    </span>`;
  assert.deepEqual(
    finalLawAttachmentFromLegistarDetailHtml(html, "https://legistar.council.nyc.gov/LegislationDetail.aspx?ID=9"),
    { name: "Int. No. 1-A (FINAL)", url: "https://legistar.council.nyc.gov/View.ashx?M=F&ID=2" },
  );
});

test("retained retry derives zero-obligation laws instead of trusting a stale count", () => {
  const retained = retainedLawsFromReference({
    laws: [
      { matter_id: "1", obligation_count: 9 },
      { matter_id: "2", obligation_count: 0 },
      { matter_id: "3", obligation_count: 0 },
    ],
    obligations: [{ matter_id: "1", obligation_id: "1-01" }],
  });
  assert.deepEqual(retained.map((law) => law.matter_id), ["2", "3"]);
  assert.ok(retained.every((law) => law.retained_reason === "reference_snapshot_zero_obligations"));
});

test("public retained-retry evidence rejects incomplete or gating receipts", () => {
  const receipt = {
    generated_at: "2026-08-16T00:00:00.000Z",
    retained_definition: "zero obligations",
    source_snapshot: { retained_law_count: 188 },
    retry: { attempted_law_count: 188, completed_law_count: 188, failed_law_count: 0, quote_candidate_count: 0 },
    fidelity: { extractor_bug_count: 0, human_gate_required: false },
    extraction: {},
    human_gate_required: false,
    results: Array.from({ length: 188 }, (_, index) => ({
      matter_id: `m-${index}`,
      status: "completed",
      source: { source_url: `https://example.test/law/${index}`, sha256: "a".repeat(64) },
      extraction: { mandates: [] },
      self_check: { verdict: "faithful", human_gate_required: false },
    })),
  };
  assert.equal(publicRetainedRetryEvidence(receipt).methodology.human_gate_required, false);
  assert.throws(() => publicRetainedRetryEvidence({ ...receipt, human_gate_required: true }), /automated/);
  assert.throws(() => publicRetainedRetryEvidence({ ...receipt, retry: { ...receipt.retry, failed_law_count: 1 } }), /incomplete/);
});

test("fidelity self-check is source-grounded and never becomes a human gate", () => {
  const law = {
    matter_id: "m-7",
    text: "Section 1. The department shall publish a report. The term report may include a summary.",
    provenance: { source_url: "https://law.test/m-7", sha256: "abc" },
  };
  const mandates = [{
    mandate_id: "m-7-001",
    duty_text: "Publish a report.",
    verbatim_quote: "The department shall publish a report.",
    quote_verified: true,
  }];
  assert.match(buildFidelitySelfCheckPrompt(law, mandates), /source law text/i);
  const check = normalizeFidelitySelfCheck({
    verdict: "extractor_bug",
    reason_codes: ["missing_mandate"],
    explanation: "A second duty was omitted.",
    evidence: [{
      kind: "missing_mandate",
      quote: "The term report may include a summary.",
      explanation: "The text is permissive, not mandatory.",
    }],
  }, { law, mandates });
  assert.equal(check.verdict, "extractor_bug");
  assert.equal(check.evidence[0].quote_verified, true);
  assert.equal(check.human_gate_required, false);
});

test("unverified low-fidelity claims fail closed as ambiguous law text", () => {
  const check = normalizeFidelitySelfCheck({
    verdict: "extractor_bug",
    reason_codes: ["missing_mandate"],
    explanation: "Claims a missing duty.",
    evidence: [{ kind: "missing_mandate", quote: "The agency must file.", explanation: "not present" }],
  }, {
    law: { matter_id: "m-8", text: "This local law takes effect immediately." },
    mandates: [],
  });
  assert.equal(check.verdict, "ambiguous_law_text");
  assert.deepEqual(check.reason_codes, ["missing_mandate", "unverified_self_check_evidence"]);
  assert.equal(check.human_gate_required, false);
});

test("unsupported rows use their own verified source span when self-check quote drifts", () => {
  const source = "A person shall be deemed eligible.";
  const mandates = [{
    mandate_id: "m-unsupported-001",
    verbatim_quote: source,
    quote_verified: true,
  }];
  const check = normalizeFidelitySelfCheck({
    verdict: "extractor_bug",
    reason_codes: ["unsupported_mandate"],
    evidence: [{
      kind: "unsupported_mandate",
      mandate_id: "m-unsupported-001",
      quote: "A person is eligible.",
      explanation: "This is a legal classification, not a performable duty.",
    }],
  }, { law: { matter_id: "m-unsupported", text: source }, mandates });
  assert.equal(check.verdict, "extractor_bug");
  assert.equal(check.evidence[0].quote, source);
  assert.equal(check.evidence[0].quote_verification_reason, "matched_from_extracted_mandate");
});

test("verified self-check spans repair legislative-markup quote drift", () => {
  const mandates = [{
    mandate_id: "m-9-001",
    duty_text: "Award 25 percent of proceeds.",
    deliverable_type: "program",
    deadline: { kind: "none", text: null },
    recurrence: "ongoing",
    verbatim_quote: "the board shall award 25 percent of the proceeds",
    quote_verified: false,
    quote_verification_reason: "quote_not_found",
    status: "candidate",
  }];
  const check = {
    evidence: [{
      kind: "supported_mandate",
      mandate_id: "m-9-001",
      quote: "the board shall award [twenty-five] 25 percent of the proceeds",
      quote_verified: true,
    }],
  };
  const repaired = applyVerifiedQuoteRepairs(mandates, check);
  assert.equal(repaired.repaired_count, 1);
  assert.equal(repaired.mandates[0].verbatim_quote, "the board shall award [twenty-five] 25 percent of the proceeds");
  assert.equal(repaired.mandates[0].quote_verified, true);
  assert.equal(repaired.mandates[0].status, "verified");
});

test("verified unsupported evidence removes a clear over-extraction", () => {
  const mandates = [
    { mandate_id: "m-10-001", duty_text: "Publish a report." },
    { mandate_id: "m-10-002", duty_text: "Treat a legal status as a separate action." },
  ];
  const check = { evidence: [{
    kind: "unsupported_mandate",
    mandate_id: "m-10-002",
    quote: "A person shall be deemed eligible.",
    quote_verified: true,
  }] };
  const repaired = applyVerifiedUnsupportedRemovals(mandates, check);
  assert.equal(repaired.removed_count, 1);
  assert.deepEqual(repaired.mandates.map((row) => row.mandate_id), ["m-10-001"]);
});

test("a verified non-government row is an extractor bug and is removed", () => {
  const source = "A prevailing plaintiff shall be awarded statutory damages.";
  const mandates = [{ mandate_id: "m-court-001", verbatim_quote: source, quote_verified: true }];
  const check = normalizeFidelitySelfCheck({
    verdict: "faithful",
    evidence: [{ kind: "no_government_mandate", mandate_id: "m-court-001", quote: source }],
  }, { law: { matter_id: "m-court", text: source }, mandates });
  assert.equal(check.verdict, "extractor_bug");
  const removed = applyVerifiedUnsupportedRemovals(mandates, check);
  assert.equal(removed.removed_count, 1);
});

test("unverified candidates are omitted and verified missing duties are added automatically", () => {
  const law = { matter_id: "m-repair", text: "The department shall consult the advisory board." };
  const removed = applyUnverifiedCandidateRemovals([{ mandate_id: "m-repair-001", quote_verified: false }]);
  assert.equal(removed.removed_count, 1);
  const added = applyVerifiedMissingMandates([], {
    evidence: [{
      kind: "missing_mandate",
      quote: law.text,
      quote_verified: true,
      proposed_mandate: {
        agency: "Department",
        duty_text: "Consult the advisory board.",
        deliverable_type: "other",
        deadline: { kind: "none" },
        recurrence: "one-time",
        citation: "",
        verbatim_quote: law.text,
      },
    }],
  }, { law });
  assert.equal(added.added_count, 1);
  assert.equal(added.mandates[0].status, "verified");
});

test("matter text helper records attachment source without pretending the PDF is decoded", () => {
  const result = lawTextFromMatter({ MatterId: 1 }, [{ MatterAttachmentHyperlink: "https://example.test/law.pdf" }]);
  assert.equal(result.text, null);
  assert.equal(result.text_status, "attachment_requires_text_decoder");
});

test("comparator emits automated agreement and fidelity-mismatch self-checks", () => {
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
  assert.equal(item.state, "fidelity_mismatch");
  assert.equal(item.our_only.length, 1);
  assert.equal(item.reference_only.length, 1);
  assert.deepEqual(item.field_level_disagreements.map((d) => d.field), ["agency", "deadline"]);
  assert.equal(review.methodology.trust_rule, TRUST_RULE);
  assert.equal(review.methodology.human_review_required, false);
  assert.equal(review.human_gate_required, false);
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

test("comparator joins our Legistar ids to oracle obligations by file number", () => {
  const review = compareMandates(
    { laws: [{ matter_id: "79150", matter_file: "Int 0966-2026", provenance: { source_url: "https://law.test/79150", sha256: "abc" }, mandates: [] }], mandates: [
      { mandate_id: "79150-001", matter_id: "79150", file_number: "Int 0966-2026", agency: "HPD", deliverable_type: "program", deadline: { computed_date: "2027-01-01" } },
    ] },
    { obligations: [
      { obligation_id: "8122647-01", matter_id: "8122647", file_number: "Int 0966-2026", agency: "HPD", deliverable_type: "program", deadline_date: "2027-01-01", quote_verified: true },
    ] },
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
