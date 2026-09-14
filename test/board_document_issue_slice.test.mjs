import assert from "node:assert/strict";
import test from "node:test";
import {
  BOARD_DOCUMENT_ISSUE_SLICE_SCHEMA,
  EMMONS_BOARD_DOCUMENT_ISSUE_CONFIG,
  classifyBoardDocumentIssueDocuments,
  renderBoardDocumentIssueSlice,
} from "../site/board_document_issue_slice.mjs";

const base = { board_id: "brooklyn-cb-15", meeting_date: "2026-06-30", retrieval_date: "2026-09-10", document_url: "https://www.nyc.gov/cb15/minutes-2026-06-30.pdf" };

test("every admitted hit carries bounded identity, provenance, alias evidence, and a stable route", () => {
  const result = classifyBoardDocumentIssueDocuments([{ ...base, document_id: "minutes-1", source_kind: "minutes", text: "The committee discussed 3218 Emmons Avenue and the shelter." }], EMMONS_BOARD_DOCUMENT_ISSUE_CONFIG);
  assert.equal(result.schema, BOARD_DOCUMENT_ISSUE_SLICE_SCHEMA);
  assert.equal(result.hits.length, 1);
  assert.deepEqual(Object.keys(result.hits[0]).sort(), ["action_label", "action_type", "board_id", "board_name", "document_id", "document_url", "excerpt", "issue_id", "matched_aliases", "meeting_date", "retrieval_date", "route", "schema", "source_kind"].sort());
  assert.equal(result.hits[0].action_type, "mention");
  assert.match(result.hits[0].route, /^\/following\/packs\/emmons-shelter\/board-documents\//);
  assert.ok(result.hits[0].excerpt.length <= 320);
});

test("testimony, recommendation, chair action, and formal board action remain distinct", () => {
  const rows = ["testimony", "committee_recommendation", "chair_statement", "formal_vote"].map((source_kind, index) => ({ ...base, document_id: `doc-${index}`, source_kind, text: `CB15 record: Gold Star Inn; ${source_kind}` }));
  const result = classifyBoardDocumentIssueDocuments(rows, EMMONS_BOARD_DOCUMENT_ISSUE_CONFIG);
  assert.deepEqual(result.hits.map((hit) => hit.action_type), ["public_testimony", "committee_recommendation", "chair_action", "formal_board_action"]);
  assert.match(result.hits[2].action_label, /individual/);
  assert.equal(result.hits[2].action_type === "formal_board_action", false);
});

test("a chair-as-plaintiff passage cannot support a formal-board claim", () => {
  const result = classifyBoardDocumentIssueDocuments([{ ...base, document_id: "litigation", source_kind: "chair_statement", text: "The CB15 chair, as plaintiff, opposed the 3218 Emmons Avenue shelter." }], EMMONS_BOARD_DOCUMENT_ISSUE_CONFIG);
  assert.equal(result.hits[0].action_type, "chair_action");
  assert.notEqual(result.hits[0].action_type, "formal_board_action");
});

test("no-match coverage is explicit and new admitted documents are reevaluated deterministically", () => {
  const empty = classifyBoardDocumentIssueDocuments([{ ...base, document_id: "unrelated", text: "A different topic." }], EMMONS_BOARD_DOCUMENT_ISSUE_CONFIG);
  assert.equal(empty.hits.length, 0);
  assert.deepEqual(empty.coverage, { documents_searched: 1, through_date: "2026-09-10" });
  const expanded = classifyBoardDocumentIssueDocuments([{ ...base, document_id: "unrelated", text: "A different topic." }, { ...base, document_id: "admitted", text: "3218 Emmons Avenue was discussed." }], EMMONS_BOARD_DOCUMENT_ISSUE_CONFIG);
  assert.equal(expanded.hits[0].document_id, "admitted");
  assert.match(renderBoardDocumentIssueSlice(empty), /Searched 1 retained document through 2026-09-10/);
});
