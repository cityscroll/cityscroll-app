// The community-board decision candidates that were read but not published to
// residents are operator material, not public record: a document that states no
// meeting date, a passage not read to the reviewed standard, an address the
// board's own agenda and its own resolution spell differently. They are held in
// a worker-side artifact rather than under site/, so this route is the only read
// of them. Authenticated identically to every other /admin/* route
// (checkAdminKey, admin.mjs): 404 until ADMIN_KEY is configured, 401 on a wrong
// or missing key, read-only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleAdminBoardResolutionReview } from "../src/admin.mjs";
import queue from "../src/data/community_board_resolution_review_queue.json" with { type: "json" };
import publicPilot from "../../site/data/community_board_resolution_pilot.json" with { type: "json" };

const KEY = "s3cr3t";
const env = { ADMIN_KEY: KEY };
const get = (url) => new Request(url, { method: "GET" });
const ROUTE = "https://w/admin/board-resolution-review";

test("fails closed until an operator key is configured", async () => {
  const res = await handleAdminBoardResolutionReview(get(ROUTE), {});
  assert.equal(res.status, 404);
});

test("rejects a missing or wrong key without disclosing the queue", async () => {
  assert.equal((await handleAdminBoardResolutionReview(get(ROUTE), env)).status, 401);
  assert.equal((await handleAdminBoardResolutionReview(get(`${ROUTE}?key=wrong`), env)).status, 401);
});

test("rejects a write", async () => {
  const res = await handleAdminBoardResolutionReview(
    new Request(`${ROUTE}?key=${KEY}`, { method: "POST" }), env);
  assert.equal(res.status, 405);
});

test("returns every held candidate with the reason it was held", async () => {
  const res = await handleAdminBoardResolutionReview(get(`${ROUTE}?key=${KEY}`), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.schema, queue.schema);
  assert.equal(body.held_candidates.length, queue.held_candidates.length);
  assert.ok(body.held_candidates.length > 0);
  for (const row of body.held_candidates) {
    assert.ok(row.held_reason, `${row.candidate_id} states why it was held`);
    assert.equal(row.admission, "held");
  }
  // The reasons the pilot exists to keep separate are all reachable here.
  const reasons = new Set(body.held_candidates.map((row) => row.held_reason));
  assert.ok(reasons.has("conflicting_address_assertions"));
  assert.ok(reasons.has("document_states_no_meeting_date"));
});

test("filters by board and by reason without inventing rows", async () => {
  const byBoard = await (await handleAdminBoardResolutionReview(
    get(`${ROUTE}?key=${KEY}&board=brooklyn-cb-15`), env)).json();
  assert.ok(byBoard.held_candidates.every((row) => row.board_id === "brooklyn-cb-15"));
  assert.equal(byBoard.selection.board, "brooklyn-cb-15");

  const byReason = await (await handleAdminBoardResolutionReview(
    get(`${ROUTE}?key=${KEY}&reason=conflicting_address_assertions`), env)).json();
  assert.ok(byReason.held_candidates.length >= 1);
  assert.ok(byReason.held_candidates.every((row) => row.held_reason === "conflicting_address_assertions"));

  const unknown = await (await handleAdminBoardResolutionReview(
    get(`${ROUTE}?key=${KEY}&board=queens-cb-01`), env)).json();
  assert.deepEqual(unknown.held_candidates, []);
  // An empty selection still reports the full coverage, so "none here" is never
  // mistaken for "nothing was read".
  assert.equal(unknown.coverage.documents, queue.coverage.documents);
  assert.equal(unknown.coverage.candidates_held, queue.coverage.candidates_held);
});

test("the held candidates are absent from the artifact residents read", () => {
  const publicText = JSON.stringify(publicPilot);
  for (const row of queue.held_candidates) {
    assert.ok(!publicText.includes(row.candidate_id),
      `${row.candidate_id} stays out of the resident artifact`);
  }
  assert.ok(!publicText.includes("103 Bayard"), "the contested address never ships to residents");
  assert.ok(JSON.stringify(queue).includes("103 Bayard"), "the contested address is retained for review");
});
