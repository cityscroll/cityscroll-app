import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { buildConsultationCollection, buildConsultationDetail, renderConsultationCollectionDocument, renderConsultationDetailDocument } from "../site/consultation_documents.mjs";

const CAPTURE_MANIFEST = new URL("../docs/evidence/consultation-pages/capture-manifest.json", import.meta.url);

test("scope, inspect, detail, back, and continued browsing are real document affordances", () => {
  const query = new URLSearchParams("category=Transit%20service%20and%20corridor%20priorities");
  const view = buildConsultationCollection({ query });
  const html = renderConsultationCollectionDocument(view);
  assert.match(html, /method="get"/);
  assert.match(html, /href="#inspect-/);
  assert.match(html, /<details/);
  assert.match(html, /<summary>Inspect context<\/summary>/);
  assert.match(html, /Open the canonical detail/);
  const detail = renderConsultationDetailDocument(buildConsultationDetail(view.records[0].id, { query: query.toString() }));
  assert.match(detail, /Back to consultations/);
  assert.match(detail, /category=Transit\+service/);
  assert.match(detail, /rel="noopener noreferrer"/);
  assert.doesNotMatch(html, /<form[^>]+action="https?:/i);
});

test("canonical routes are safe and unknown details remain ordinary links", () => {
  assert.match(renderConsultationCollectionDocument(buildConsultationCollection()), /href="\/consultations\//);
  assert.match(renderConsultationDetailDocument(buildConsultationDetail("cb14-community-budget-fy2028")), /data-return-focus/);
});

test("selection, expanded row, scroll, and return focus are represented by native document state", () => {
  const query = new URLSearchParams("category=Facility+siting+and+program+design&place=New+York+City");
  const view = buildConsultationCollection({ query });
  assert.equal(view.records.length, 1);
  const [selected] = view.records;
  const html = renderConsultationCollectionDocument(view);
  assert.match(html, new RegExp(`data-consultation-id="${selected.id}"`));
  assert.match(html, new RegExp(`href="#inspect-${selected.id}"`));
  assert.match(html, new RegExp(`<details id="inspect-${selected.id}">`));
  assert.match(html, /<summary>Inspect context<\/summary>/);
  assert.match(html, /href="#inspect-/);

  const detail = renderConsultationDetailDocument(buildConsultationDetail(selected.id, { query: query.toString() }));
  assert.match(detail, /data-return-focus="consultation-dot-public-ebike-charging"/);
  assert.match(detail, /category=Facility\+siting\+and\+program\+design/);
  assert.match(detail, /place=New\+York\+City/);
  assert.match(detail, /href="\/consultations\/"/);
});

test("dismissal leaves the native Inspect context disclosure closed by default", () => {
  const html = renderConsultationCollectionDocument(buildConsultationCollection());
  const disclosures = [...html.matchAll(/<details\b[^>]*>/g)].map(([tag]) => tag);
  assert.equal(disclosures.length, 6);
  assert.ok(disclosures.every((tag) => !/\bopen(?:\s|=|>)/i.test(tag)));
  assert.match(html, /<summary>Inspect context<\/summary>/);
});

function renderCaptureRoute(route) {
  const url = new URL(route, "https://cityscroll.org");
  const id = url.pathname.match(/^\/consultations\/([^/]+)\/$/)?.[1];
  if (!id) return renderConsultationCollectionDocument(buildConsultationCollection({ query: url.searchParams }));
  const detail = buildConsultationDetail(decodeURIComponent(id), { query: url.searchParams.toString() });
  return detail
    ? renderConsultationDetailDocument(detail)
    : "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Consultation not found · CityScroll</title></head><body><main><h1>Consultation not found</h1><p>The consultation is not in the current materialized collection.</p><p><a href=\"/consultations/\">Browse consultations</a></p></main></body></html>";
}

test("the retained journey manifest covers every required path with content hashes", async () => {
  const manifest = JSON.parse(await readFile(CAPTURE_MANIFEST, "utf8"));
  assert.equal(manifest.image_binaries_committed, false);
  assert.equal(manifest.captures.length, 10);
  const cases = new Set(manifest.captures.map((capture) => capture.case));
  for (const expected of ["desktop", "narrow-touch", "keyboard", "no-javascript", "failed-detail-load"]) {
    assert.ok(cases.has(`consultations-${expected}`), expected);
  }
  for (const capture of manifest.captures) {
    assert.match(capture.route, /^\/consultations\//);
    assert.ok(capture.viewport.width > 0 && capture.viewport.height > 0, capture.case);
    assert.equal(capture.revision || manifest.revision, manifest.revision, capture.case);
    assert.equal(typeof (capture.data_vintage || manifest.data_vintage), "string", capture.case);
    assert.ok(capture.assertion.length > 20, capture.case);
    assert.match(capture.render_sha256, /^[a-f0-9]{64}$/, capture.case);
  }
  for (const capture of manifest.captures) {
    const rendered = renderCaptureRoute(capture.route);
    const hash = createHash("sha256").update(rendered).digest("hex");
    assert.equal(capture.render_sha256, hash, capture.case);
  }
});

test("the static collection remains useful without JavaScript", () => {
  const html = renderConsultationCollectionDocument(buildConsultationCollection());
  assert.doesNotMatch(html, /<script\b/i);
  assert.match(html, /href="\/consultations\//);
  assert.match(html, /href="https:\/\//);
});
