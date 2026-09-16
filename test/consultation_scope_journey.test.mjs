import assert from "node:assert/strict";
import { test } from "node:test";
import { buildConsultationCollection, buildConsultationDetail, renderConsultationCollectionDocument, renderConsultationDetailDocument } from "../site/consultation_documents.mjs";
import { consultationDeadline, consultationMatchesScope } from "../site/consultation_place_time.mjs";
import { withPinnedClock } from "./helpers/test_clock.mjs";

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

test("A3: expired, undated, and stale-observation records remain reachable in browse and detail", async () => {
  await withPinnedClock("2026-08-15T12:00:00.000Z", () => {
    const options = { asOf: "2026-08-15T12:00:00.000Z" };
    const records = [
      {
        id: "cb14-expired",
        title: "Expired CB14 invitation",
        organizer: "Brooklyn Community Board 14",
        observed_at: "2026-08-15T00:00:00.000Z",
        deadline: { value: "2026-08-01", precision: "day" },
        geography: { labels: ["CB14"], evidence: "board_identity" },
        channels: [{ url: "https://example.test/cb14-expired" }],
      },
      {
        id: "undated-invitation",
        title: "Undated library invitation",
        organizer: "NYCEDC",
        observed_at: "2026-08-15T00:00:00.000Z",
        deadline: null,
        geography: { labels: ["Bloomingdale"], evidence: "accepted_address_geocoding", community_districts: ["M10"] },
        channels: [{ url: "https://example.test/undated" }],
      },
      {
        id: "stale-observation",
        title: "Stale observation round",
        organizer: "DOT",
        observed_at: "2026-07-31T00:00:00.000Z",
        deadline: { value: "2026-08-20", precision: "day" },
        geography: { kind: "citywide", labels: ["New York City"] },
        channels: [{ url: "https://example.test/stale" }],
      },
    ];

    assert.equal(consultationDeadline(records[0], options).supported, false);
    assert.equal(consultationDeadline(records[0], options).expired, true);
    assert.equal(consultationDeadline(records[1], options).supported, false);
    assert.equal(consultationDeadline(records[2], options).fresh, false);
    assert.equal(consultationDeadline(records[2], options).supported, false);

    const view = buildConsultationCollection({ materialization: { consultations: records }, query: new URLSearchParams() });
    const html = renderConsultationCollectionDocument(view);
    for (const record of records) {
      assert.ok(view.records.some((row) => row.id === record.id), `${record.id} missing from browse collection`);
      assert.match(html, new RegExp(`data-consultation-id="${record.id}"`));
      const detail = renderConsultationDetailDocument(buildConsultationDetail(record.id, { materialization: { consultations: records } }));
      assert.match(detail, new RegExp(`<h1>${record.title.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}</h1>`));
      assert.match(detail, /data-return-focus="consultation-/);
    }
  });
});
