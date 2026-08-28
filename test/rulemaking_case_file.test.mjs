import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRulemakingObjects } from "../worker/src/lib/rulemaking.mjs";
import { renderRulemakingDocument } from "../site/rulemaking_document.mjs";
import { rulesCardInteractionProjection } from "../site/rules_card_interaction.mjs";
import { loadOntologyRegistry } from "../ontology/index.mjs";
import pagesEdge from "../site/pages_edge.mjs";

const SUBJECT = "rulemaking:dot:bicycle-racks";
const RULES_URL = "https://rules.cityofnewyork.us/rule/city-owned-bicycle-racks/";

const dotRows = [
  {
    request_id: "20260317026",
    agency: "DOT",
    title: "DOT Proposed Rules Relating to City-Owned Bicycle Racks",
    notice_date: "2026-03-25T00:00:00.000",
    stage: "hearing",
    rulemaking_subject_ref: SUBJECT,
    rulemaking_join: { matched: true, confidence: "high", notice_count: 2 },
    nyc_rules: { url: RULES_URL, title: "City-Owned Bicycle Racks", summary: "The proposed rule would amend the City-Owned Bicycle Racks rules.", hearing_date: "2026-04-24" },
    events: [
      { event_type: "public_hearing", valid_at: "2026-04-24", source_url: RULES_URL, status: "occurred" },
      { event_type: "effective", valid_at: "2026-08-13", source_url: RULES_URL, status: "occurred" },
    ],
  },
  {
    request_id: "20260706041",
    agency: "DOT",
    title: "Notice of Adoption: City-Owned Bicycle Racks",
    notice_date: "2026-07-14T00:00:00.000",
    stage: "effective",
    rulemaking_subject_ref: SUBJECT,
    rulemaking_join: { matched: true, confidence: "high", notice_count: 2 },
    events: [],
  },
];

test("DOT City-Owned Bicycle Racks is one case file with four dated stages", () => {
  const [object] = buildRulemakingObjects(dotRows, { now: "2026-08-27" });
  assert.equal(object.rulemaking_id, SUBJECT);
  assert.equal(object.notices.length, 2);
  assert.deepEqual(object.phases.map((phase) => phase.events[0]?.valid_at || phase.events[0]?.published_at), [
    "2026-03-25", "2026-04-24", "2026-07-14", "2026-08-13",
  ]);
  const html = renderRulemakingDocument(object);
  assert.match(html, /What the agency proposes/);
  assert.match(html, /What you can do/);
  assert.match(html, /Follow hearing/);
  assert.match(html, /March 25, 2026/);
  assert.match(html, /April 24, 2026/);
  assert.match(html, /July 14, 2026/);
  assert.match(html, /August 13, 2026/);
  assert.match(html, /\/notices\/20260317026/);
  assert.match(html, /\/notices\/20260706041/);
  assert.doesNotMatch(html, /rulemaking_subject_ref|multi_notice/);
});

test("only grounded subjects target the case-file route", () => {
  const grounded = rulesCardInteractionProjection({ request_id: "20260317026", rulemaking_id: SUBJECT, title: "Bicycle racks" });
  const fallback = rulesCardInteractionProjection({ request_id: "20260804030", title: "Unjoined rule" });
  assert.equal(grounded.target.href, `/rules/${encodeURIComponent(SUBJECT)}`);
  assert.equal(fallback.target.href, "/notices/20260804030");
});

test("rulemaking subject following remains exact-notice fallback until replayable", () => {
  const [object] = buildRulemakingObjects(dotRows);
  assert.deepEqual(object.follow, { state: "notice_fallback", request_id: "20260317026" });
  assert.equal(Object.keys(loadOntologyRegistry().object_types.filter((entry) => entry.id === "rulemaking")).length, 1);
  assert.equal(loadOntologyRegistry().object_types.find((entry) => entry.id === "rulemaking")?.status, "registered");
});

test("Pages edge serves the canonical route from the materialized object", async () => {
  const object = buildRulemakingObjects(dotRows, { now: "2026-08-27" })[0];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ schema_version: 8, rulemakings: [object], rules: [] });
  try {
    const response = await pagesEdge.fetch(
      new Request(`https://cityscroll.org/rules/${encodeURIComponent(SUBJECT)}/`),
      { ASSETS: { fetch: async () => new Response("asset") } },
    );
    assert.equal(response.status, 200);
    assert.match(await response.text(), /data-civic-object-kind="rulemaking"/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
