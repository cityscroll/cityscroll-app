import assert from "node:assert/strict";
import { test } from "node:test";
import { CONSULTATION_STRINGS, buildConsultationCollection, buildConsultationDetail, renderConsultationCollectionDocument, renderConsultationDetailDocument } from "../site/consultation_documents.mjs";

test("collection and safe detail documents expose resident-facing consultation facts", () => {
  const view = buildConsultationCollection();
  assert.equal(view.records.length, 6);
  const html = renderConsultationCollectionDocument(view);
  assert.match(html, /Consultations/);
  assert.match(html, /href="\/brand\.css"/);
  assert.match(html, /href="\/civic-documents\.css"/);
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

test("channel and source classifications render as bilingual resident words", () => {
  const detail = buildConsultationDetail("dot-public-ebike-charging");
  const english = renderConsultationDetailDocument(detail);
  const spanish = renderConsultationDetailDocument(detail, { locale: "es" });
  assert.equal(CONSULTATION_STRINGS.en.source.microsoft_form, "Response form");
  assert.equal(CONSULTATION_STRINGS.es.source.microsoft_form, "Formulario de respuesta");
  assert.equal(CONSULTATION_STRINGS.en.channel.google_form, "Response form");
  assert.equal(CONSULTATION_STRINGS.es.channel.offline_pdf, "Formulario en papel");
  assert.match(english, />Feedback information</);
  assert.match(english, />Response form</);
  assert.match(spanish, />Información para enviar comentarios</);
  assert.match(spanish, />Formulario de respuesta</);
  for (const html of [english, spanish]) {
    assert.doesNotMatch(html, /organizer_invitation|feedback_landing|microsoft_form|feedback_page|feedback_map|location_suggestion/);
  }
});

test("filters preserve a return scope and omit empty optional sections", () => {
  const query = new URLSearchParams("category=Community+budget&place=14");
  const view = buildConsultationCollection({ query });
  assert.equal(view.records.length, 1);
  const detail = buildConsultationDetail("cb14-community-budget-fy2028", { query: query.toString() });
  assert.match(detail.backHref, /category=Community\+budget/);
  assert.doesNotMatch(renderConsultationDetailDocument(detail), /undefined|null/);
});

test("place and lifecycle filters narrow the materialized collection", () => {
  const place = buildConsultationCollection({ query: new URLSearchParams("place=Coney+Island") });
  assert.deepEqual(place.records.map((record) => record.id), ["dot-coney-island-transportation-study"]);

  const dated = buildConsultationCollection({ query: new URLSearchParams("lifecycle=dated") });
  assert.equal(dated.records.length, 2);
  assert.ok(dated.records.every((record) => record.deadline));

  const undated = buildConsultationCollection({ query: new URLSearchParams("lifecycle=undated") });
  assert.equal(undated.records.length, 4);
  assert.ok(undated.records.every((record) => !record.deadline));

  const closed = buildConsultationCollection({ query: new URLSearchParams("lifecycle=closed") });
  assert.deepEqual(closed.records.map((record) => record.id), ["cb14-community-budget-fy2028"]);
});
