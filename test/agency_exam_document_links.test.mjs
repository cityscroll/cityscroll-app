/**
 * Regression: agency constellation staffing links must open real exam documents.
 *
 * Field case (user report): /agencies/citywide-administrative-services/ listed
 * exam 1194 from Civil Service List certification edges, but 1194 is not in the
 * staffing-guide materialization and has no /exams/1194/ document. Opening the
 * link fell through to the SPA shell (contracts default) instead of an exam page.
 */
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { buildAgencyConstellationView, renderAgencyConstellationDocument } from "../site/agency_constellation.mjs";
import edgeWorker, { edgeRequestKind, isExamDocumentHtml, renderExamUnavailable } from "../site/pages_edge.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));

const intelligence = readJson("site/data/entity_intelligence_lookup.json");
const certification = readJson("site/data/exam_certification_constellation.json");
const staffingExams = readJson("site/data/staffing_exams.json");
const obligations = existsSync(join(ROOT, "site/data/agency_obligations_lookup.json"))
  ? readJson("site/data/agency_obligations_lookup.json")
  : null;

const DCAS = "citywide-administrative-services";
const DOCUMENTABLE = new Set(
  (staffingExams.exams || []).map((exam) => String(exam.exam_number || "").trim()).filter(Boolean),
);

test("staffing corpus includes 7013 (document path) and excludes 1194 (cert-only)", () => {
  assert.ok(DOCUMENTABLE.has("7013"), "7013 is a staffing-guide exam with a built document");
  assert.equal(DOCUMENTABLE.has("1194"), false, "1194 is certification-only, not a staffing document");
  assert.equal(existsSync(join(ROOT, "site/exams/7013/index.html")), true);
  assert.equal(existsSync(join(ROOT, "site/exams/1194/index.html")), false);
});

test("DCAS agency staffing lists only document-backed exams — never cert-only 1194", () => {
  // Certification alone still names exam:1194 → DCAS (publisher civil-service list).
  const certEdge = (certification.edges || []).find(
    (edge) => edge?.from === "exam:1194"
      && edge?.to === "agency:id:citywide-administrative-services"
      && edge?.type === "certified_to_agency",
  );
  assert.ok(certEdge, "publisher certification still links exam 1194 to DCAS");

  const view = buildAgencyConstellationView(DCAS, {
    intelligence,
    certification,
    obligations,
    staffing_exams: staffingExams,
  });
  assert.ok(view, "DCAS constellation builds");
  const staffing = view.categories.find((category) => category.id === "staffing");
  assert.ok(staffing, "staffing category present");
  assert.equal(staffing.status, "matched");
  assert.ok(staffing.count >= 1, "document-backed exams remain counted");
  // Count must not use the raw certification edge total (field report: 259).
  assert.ok(
    staffing.count <= DOCUMENTABLE.size,
    `staffing count ${staffing.count} must not exceed the document corpus (${DOCUMENTABLE.size})`,
  );
  assert.ok(
    staffing.count < 259,
    `staffing count must drop below the raw certification total (got ${staffing.count})`,
  );

  const ids = staffing.items.map((item) => String(item.id));
  assert.ok(!ids.includes("1194"), "exam 1194 must not appear in the agency staffing list");
  for (const item of staffing.items) {
    assert.match(String(item.id), /^\d{4}$/, `route-safe exam id: ${item.id}`);
    assert.ok(DOCUMENTABLE.has(String(item.id)), `list item ${item.id} must be a staffing document exam`);
    assert.equal(item.href, `/exams/${item.id}/`);
  }

  const html = renderAgencyConstellationDocument(view);
  assert.doesNotMatch(html, /href="\/exams\/1194\/"/);
  assert.doesNotMatch(html, />Exam 1194</);
  // At least one document-backed exam remains linked when present in the list.
  if (staffing.items.length) {
    assert.match(html, new RegExp(`href="/exams/${staffing.items[0].id}/"`));
  }
});

test("unmatched /exams/:id never falls through to the contracts SPA shell", async () => {
  assert.equal(edgeRequestKind("https://cityscroll.org/exams/1194/"), "exam");
  assert.equal(isExamDocumentHtml('<main data-exam-document="1">Exam</main>'), true);
  assert.equal(isExamDocumentHtml('<title>CityScroll · track RFPs, rezonings, meetings</title>'), false);

  const spaShell = `<!doctype html><html><head><title>CityScroll · track RFPs, rezonings, meetings</title></head><body>
    <button class="tabbtn active" data-tab="money">Contracts</button>
    <section class="tabpane active" id="tab-money">Contracts list</section>
    <div id="list">open RFPs</div>
  </body></html>`;
  const realExam = `<!doctype html><html><head><title>Automotive Service Worker · Exam 7013 · CityScroll</title>
    <link rel="canonical" href="https://cityscroll.org/exams/7013/">
    <meta property="og:url" content="https://cityscroll.org/exams/7013/"></head>
    <body><main data-exam-document="1" data-exam-number="7013"><h1>Automotive Service Worker</h1></main></body></html>`;

  const env = {
    ASSETS: {
      fetch: async (request) => {
        const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
        if (path === "/exams/7013") {
          return new Response(realExam, { headers: { "Content-Type": "text/html" } });
        }
        // Cloudflare Pages-style SPA fallback: missing exam paths return the home shell with 200.
        return new Response(spaShell, { status: 200, headers: { "Content-Type": "text/html" } });
      },
    },
  };

  const missing = await edgeWorker.fetch(new Request("https://cityscroll.org/exams/1194/"), env);
  assert.equal(missing.status, 404);
  const missingBody = await missing.text();
  assert.match(missingBody, /data-edge-rendered="exam-unavailable"/);
  assert.match(missingBody, /Exam 1194/);
  assert.doesNotMatch(missingBody, /track RFPs, rezonings, meetings/);
  assert.doesNotMatch(missingBody, /Contracts list|data-tab="money"|open RFPs/);
  assert.match(missingBody, /href="\/browse\/staffing\/"/);

  const present = await edgeWorker.fetch(new Request("https://cityscroll.org/exams/7013/"), env);
  assert.equal(present.status, 200);
  const presentBody = await present.text();
  assert.match(presentBody, /data-exam-document="1"/);
  assert.match(presentBody, /Automotive Service Worker/);
  assert.doesNotMatch(presentBody, /data-edge-rendered="exam-unavailable"/);
});

test("renderExamUnavailable is a self-contained not-found document", () => {
  const html = renderExamUnavailable("1194");
  assert.match(html, /data-edge-rendered="exam-unavailable"/);
  assert.match(html, /data-exam-number="1194"/);
  assert.match(html, /Exam 1194/);
  assert.match(html, /href="\/browse\/staffing\/"/);
  assert.doesNotMatch(html, /data-tab="money"|Contracts list/);
});
