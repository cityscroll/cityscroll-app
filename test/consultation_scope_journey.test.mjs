import assert from "node:assert/strict";
import { test } from "node:test";
import { buildConsultationCollection, buildConsultationDetail, renderConsultationCollectionDocument, renderConsultationDetailDocument } from "../site/consultation_documents.mjs";
import { consultationMatchesScope } from "../site/consultation_place_time.mjs";

test("the same evidenced place predicate serves local scope and browse evidence", () => {
  const records = [
    { id: "cb14", title: "CB14 priorities", organizer: "Board", geography: { labels: ["CB14"], evidence: "board_identity" }, channels: [{ url: "https://example.test/cb14" }] },
    { id: "bike", title: "Secure Bike Parking", organizer: "DOT", geography: { kind: "citywide", labels: ["New York City"] }, channels: [{ url: "https://example.test/bike" }] },
    { id: "corridor", title: "Church Avenue", organizer: "DOT", geography: { kind: "corridor", labels: ["Church Avenue"] }, channels: [{ url: "https://example.test/corridor" }] },
  ];
  const scope = { place: { community_districts: ["K14"] }, topic: { keywords: [] } };
  assert.equal(consultationMatchesScope(records[0], scope), true);
  assert.equal(consultationMatchesScope(records[1], scope), false);
  assert.equal(consultationMatchesScope(records[2], { topic: { query: "Church Avenue" } }), true);
  const view = buildConsultationCollection({ materialization: { consultations: records }, query: new URLSearchParams("place=CB14") });
  const html = renderConsultationCollectionDocument(view);
  const detail = renderConsultationDetailDocument(buildConsultationDetail("cb14", { materialization: { consultations: records }, query: view.query }));
  assert.match(html, /data-consultation-id="cb14"/);
  assert.match(html, /href="\/consultations\/cb14\/?\?place=CB14"/);
  assert.match(detail, /href="\/consultations\/\?place=CB14"[^>]*data-return-focus="consultation-cb14"/);
});
