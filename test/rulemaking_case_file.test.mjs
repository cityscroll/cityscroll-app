import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRulemakingObjects } from "../worker/src/lib/rulemaking.mjs";
import { renderRulemakingDocument } from "../site/rulemaking_document.mjs";
import {
  deriveRulemakingLifecycleState,
  rulemakingActionMatrix,
  rulesCardInteractionProjection,
} from "../site/rules_card_interaction.mjs";
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
  assert.match(html, /In effect since August 13, 2026/);
  assert.match(html, /Read final rule/);
  assert.doesNotMatch(html, /Follow hearing|Comment/);
  assert.match(html, /March 25, 2026/);
  assert.match(html, /April 24, 2026/);
  assert.match(html, /July 14, 2026/);
  assert.match(html, /August 13, 2026/);
  assert.match(html, /data-history-coverage="partial"/);
  assert.match(html, /data-event-kind="observed"/);
  assert.match(html, /data-event-kind="derived"/);
  assert.match(html, /Derived from the observed event dates and statuses/);
  assert.match(html, /data-missing-events="comment_close"/);
  assert.match(html, /\/notices\/20260317026/);
  assert.match(html, /\/notices\/20260706041/);
  assert.doesNotMatch(html, /rulemaking_subject_ref|multi_notice/);
});

const FOLLOW_HREF = "/following/?lens=rules&filter=%7B%22request_ids%22%3A%5B%2220260317026%22%5D%7D";
const RULE_FIXTURE_BASE = {
  rulemaking_id: "rulemaking:dot:fixture",
  title: "Fixture rule",
  rule_url: RULES_URL,
  source_documents: [
    { kind: "proposed_rule", source_url: "https://rules.cityofnewyork.us/rule/proposed/" },
    { kind: "final_rule", source_url: "https://rules.cityofnewyork.us/rule/final/" },
    { kind: "hearing_record", source_url: "https://rules.cityofnewyork.us/rule/hearing-record/" },
  ],
};

function actionsFor(input) {
  return rulemakingActionMatrix({
    ...RULE_FIXTURE_BASE,
    ...input,
    nyc_rules: { url: RULES_URL, ...(input.nyc_rules || {}) },
  });
}

test("lifecycle action matrix keeps the five CAPA states distinct", () => {
  const proposed = actionsFor({ fine_stage: "proposed", now: "2026-04-01", follow_href: FOLLOW_HREF });
  assert.equal(proposed.state, "proposed");
  assert.deepEqual(proposed.actions.map((action) => action.id), ["read_proposed", "watch_rulemaking"]);

  const open = actionsFor({
    fine_stage: "comment-open",
    now: "2026-04-01",
    follow_href: FOLLOW_HREF,
    testimony_url: "https://rules.cityofnewyork.us/rule/testimony/",
    nyc_rules: { comment_by_date: "2026-04-24", hearing_date: "2026-04-20", comment_url: "https://rules.cityofnewyork.us/comment/" },
  });
  assert.equal(open.state, "comment_hearing_open");
  assert.deepEqual(open.actions.map((action) => action.id), [
    "comment", "attend_hearing", "testify", "read_proposed", "watch_rulemaking",
  ]);

  const closed = actionsFor({
    fine_stage: "comment-closed",
    now: "2026-05-01",
    follow_href: FOLLOW_HREF,
    comments_url: "https://rules.cityofnewyork.us/rule/comments/",
    nyc_rules: { comment_by_date: "2026-04-24", hearing_date: "2026-04-20" },
    events: [
      { event_type: "comment_close", valid_at: "2026-04-24", status: "occurred" },
      { event_type: "public_hearing", valid_at: "2026-04-20", status: "occurred" },
    ],
  });
  assert.equal(closed.state, "comment_closed_awaiting_action");
  assert.deepEqual(closed.actions.map((action) => action.id), [
    "watch_adoption", "hearing_record", "comments", "read_proposed",
  ]);

  const adopted = actionsFor({
    fine_stage: "adopted",
    now: "2026-07-20",
    follow_href: FOLLOW_HREF,
    nyc_rules: { adoption_published_at: "2026-07-14", effective_date: "2026-08-13" },
  });
  assert.equal(adopted.state, "adopted");
  assert.deepEqual(adopted.actions.map((action) => action.id), [
    "read_final", "read_proposed", "open_final", "watch_effective",
  ]);

  const effective = actionsFor({
    fine_stage: "effective",
    now: "2026-08-20",
    history_url: "/rules/rulemaking%3Adot%3Afixture/",
    nyc_rules: { adoption_published_at: "2026-07-14", effective_date: "2026-08-13" },
    petition_url: "https://rules.cityofnewyork.us/petition/",
  });
  assert.equal(effective.state, "effective");
  assert.deepEqual(effective.actions.map((action) => action.id), [
    "read_final", "rulemaking_history", "petition",
  ]);
});

test("expired comments never survive as a Comment action, and a hearing does not become its deadline", () => {
  const expired = rulesCardInteractionProjection({
    request_id: "20260317026",
    rulemaking_id: SUBJECT,
    title: "Bicycle racks",
    fine_stage: "hearing",
    now: "2026-04-25",
    rule_url: RULES_URL,
    comment_url: "https://rules.cityofnewyork.us/comment/",
    comment_by_date: "2026-04-24",
    hearing_date: "2026-05-10",
  });
  assert.equal(expired.lifecycle_state, "comment_hearing_open");
  assert.deepEqual(expired.kinetic_actions.map((action) => action.kind), ["attend", "document"]);
  assert.doesNotMatch(JSON.stringify(expired.kinetic_actions), /comment|2026-04-24/);
  assert.equal(expired.lifecycle_dates.comment_deadline, "2026-04-24");
});

test("adopted and effective labels use the authoritative effective date", () => {
  const adopted = deriveRulemakingLifecycleState({
    fine_stage: "adopted",
    now: "2026-07-20",
    nyc_rules: { adoption_published_at: "2026-07-14", effective_date: "2026-08-13" },
  });
  assert.equal(adopted.state, "adopted");
  assert.equal(adopted.effective_date, "2026-08-13");
  const effective = deriveRulemakingLifecycleState({
    fine_stage: "adopted",
    now: "2026-08-14",
    nyc_rules: { adoption_published_at: "2026-07-14", effective_date: "2026-08-13" },
  });
  assert.equal(effective.state, "effective");
});

test("sparse proposals expose no invented hearing or final-rule destinations", () => {
  const sparse = actionsFor({ fine_stage: "proposed", now: "2026-04-01" });
  assert.deepEqual(sparse.actions.map((action) => action.id), ["read_proposed"]);
  assert.deepEqual(sparse.missing, []);
  const open = actionsFor({ fine_stage: "comment-open", now: "2026-04-01", nyc_rules: { comment_by_date: "2026-04-24" } });
  assert.deepEqual(open.actions.map((action) => action.id), ["comment", "read_proposed"]);
  assert.ok(open.missing.includes("hearing_date"));
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
