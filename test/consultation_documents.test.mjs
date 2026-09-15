import assert from "node:assert/strict";
import { test } from "node:test";
import { buildConsultationCollection, buildConsultationDetail, renderConsultationCollectionDocument, renderConsultationDetailDocument } from "../site/consultation_documents.mjs";

test("collection and safe detail documents expose resident-facing consultation facts", () => {
  const view = buildConsultationCollection();
  assert.equal(view.records.length, 6);
  const html = renderConsultationCollectionDocument(view);
  assert.match(html, /Consultations/);
  assert.match(html, /Brooklyn CB14 district needs/);
  assert.match(html, /Bloomingdale/);
  assert.match(html, /Inspect context/);
  assert.match(html, /Open details/);
  assert.doesNotMatch(html, /operator|diagnostic/i);
  const detail = buildConsultationDetail("cb14-community-budget-fy2028");
  const detailHtml = renderConsultationDetailDocument(detail);
  assert.match(detailHtml, /2026-09-04/);
  assert.match(detailHtml, /deadline has passed|passed/i);
  assert.doesNotMatch(detailHtml, /How to respond[\s\S]*<ul class="consultation-actions">/);
});

test("undated and unresolved channels remain source-view actions", () => {
  const bloomingdale = renderConsultationDetailDocument(buildConsultationDetail("bloomingdale-library-and-housing"));
  assert.match(bloomingdale, /No response date published/);
  assert.doesNotMatch(bloomingdale, /Open now/);
  const microsoft = buildConsultationDetail("dot-public-ebike-charging");
  assert.ok(microsoft.channels.some((channel) => channel.kind === "survey"));
  assert.ok(microsoft.channels.every((channel) => channel.open_now === false));
  assert.doesNotMatch(renderConsultationDetailDocument(microsoft), /open-now|available now/i);
});

test("filters preserve a return scope and omit empty optional sections", () => {
  const query = new URLSearchParams("category=Community+budget&place=14");
  const view = buildConsultationCollection({ query });
  assert.equal(view.records.length, 1);
  const detail = buildConsultationDetail("cb14-community-budget-fy2028", { query: query.toString() });
  assert.match(detail.backHref, /category=Community\+budget/);
  assert.doesNotMatch(renderConsultationDetailDocument(detail), /undefined|null/);
});
