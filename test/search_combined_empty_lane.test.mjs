import assert from "node:assert/strict";
import test from "node:test";

import { combinedEmptyLanePresentation } from "../site/search_document.mjs";
import { buildSearchRenderPlan } from "../site/search_render_plan.mjs";

test("combined empty lane: not_covered stays a standing gap without Retry error chrome", () => {
  const presentation = combinedEmptyLanePresentation({
    familyStatus: "not_covered",
    incomplete: true,
  });
  assert.equal(presentation.className, "");
  assert.equal(presentation.retry, false);
  assert.equal(presentation.status, "Not covered");
  assert.match(presentation.body, /not available for this family yet/i);
});

test("combined empty lane: unknown keeps the transient unavailable Retry state", () => {
  const presentation = combinedEmptyLanePresentation({
    familyStatus: "unknown",
    incomplete: true,
  });
  assert.equal(presentation.className, "is-error");
  assert.equal(presentation.retry, true);
  assert.equal(presentation.status, "Unavailable");
  assert.match(presentation.body, /snapshot is unavailable/i);
});

test("combined empty lane: a true empty match stays non-error", () => {
  const presentation = combinedEmptyLanePresentation({
    familyStatus: "empty",
    incomplete: false,
  });
  assert.equal(presentation.className, "");
  assert.equal(presentation.retry, false);
  assert.equal(presentation.status, "No matches");
});

test("housing-shaped combined plan: consultations not_covered stays incomplete without forcing an error class decision", () => {
  const keyword = {
    match_mode: "keyword",
    results: [],
    lanes: [
      { id: "rules", status: "matched", count: 1, cards: [] },
      { id: "meetings", status: "matched", count: 1, cards: [] },
      {
        id: "consultations",
        status: "not_covered",
        count: null,
        cards: [],
        coverage: { reason: "bounded_family_index_not_ready" },
      },
    ],
  };
  const plan = buildSearchRenderPlan({
    state: "combined",
    keyword,
    semantic: { groups: [] },
    keywordCoverage: { lanes: keyword.lanes },
  });
  assert.ok(plan.incomplete_families.includes("consultations"));
  const presentation = combinedEmptyLanePresentation({
    familyStatus: "not_covered",
    incomplete: plan.incomplete_families.includes("consultations"),
  });
  assert.equal(presentation.className, "", "demo-link housing contract forbids visible is-error for standing coverage gaps");
  assert.equal(presentation.retry, false);
});
