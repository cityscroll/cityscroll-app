import assert from "node:assert/strict";
import { test } from "node:test";
import { buildConsultationCollection, buildConsultationDetail, renderConsultationCollectionDocument, renderConsultationDetailDocument } from "../site/consultation_documents.mjs";

test("scope, inspect, dismiss, detail, back, and continued browsing are real document affordances", () => {
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

test("the static collection remains useful without JavaScript", () => {
  const html = renderConsultationCollectionDocument(buildConsultationCollection());
  assert.doesNotMatch(html, /<script\b/i);
  assert.match(html, /href="\/consultations\//);
  assert.match(html, /href="https:\/\//);
});
