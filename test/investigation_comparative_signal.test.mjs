import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  INVESTIGATION_COMPARATIVE_SIGNAL_SCHEMA,
  addInvestigationComparativeSignal,
  comparativeSignalCsvFields,
  normalizeInvestigationComparativeSignal,
  storySignalInvestigationItem,
} from "../site/investigation_comparative_signal.mjs";

const signals = JSON.parse(readFileSync(
  new URL("../site/data/comparative_story_signals.json", import.meta.url),
  "utf8",
));
const receipts = JSON.parse(readFileSync(
  new URL("../site/data/comparative_award_rank_receipts.json", import.meta.url),
  "utf8",
));

function publishedSignal() {
  const signal = structuredClone(signals.signals[0]);
  const receipt = structuredClone(receipts.facts[0]);
  signal.comparison_receipt = {
    schema: "cityscroll.comparative_fact_reference.v1",
    receipt_schema: receipt.schema,
    receipt_id: receipt.fact_id,
    metric_method: receipt.metric.method,
    peer_basis: {
      class_id: receipt.peer_class.class_id,
      observability_basis: receipt.peer_class.observability_equivalence.basis,
      source_contract_versions: receipt.peer_class.observability_equivalence.source_contract_versions,
      source_vintages: receipt.peer_class.observability_equivalence.source_vintages,
      inclusion_rule: receipt.peer_class.observability_equivalence.inclusion_rule,
      identity_gate: receipt.peer_class.observability_equivalence.identity_gate,
      observation_quality_class: receipt.peer_class.observability_equivalence.observation_quality_class,
      censoring_class: receipt.peer_class.observability_equivalence.censoring_class,
      selected_level: receipt.peer_class.selected_level,
      small_n_policy_id: receipt.peer_class.small_n_policy_id,
    },
    generated_at: receipt.generated_at,
  };
  return signal;
}

test("an admitted story signal becomes one versioned Investigation item with intact provenance", () => {
  const signal = publishedSignal();
  const peerSetHref = "/experimental/worth-a-look/#peer-20240119104";
  const item = storySignalInvestigationItem(signal, { peerSetHref });

  assert.equal(item.schema, INVESTIGATION_COMPARATIVE_SIGNAL_SCHEMA);
  assert.equal(item.t, "signal");
  assert.equal(item.id, signal.signal_id);
  assert.equal(item.claim, signal.basis_sentence);
  assert.deepEqual(item.subject, signal.subject);
  assert.equal(item.subject_href, "/notices/20240119104/");
  assert.equal(item.peer_set_href, peerSetHref);
  assert.deepEqual(item.comparison, signal.comparison);
  assert.deepEqual(item.comparison_receipt, signal.comparison_receipt);
  assert.deepEqual(item.evidence, signal.evidence);
  assert.equal(item.note, "", "the human note stays separate from the factual claim");
});

test("adding and importing a signal deduplicates by the frozen signal identity", () => {
  const item = storySignalInvestigationItem(publishedSignal(), {
    peerSetHref: "/experimental/worth-a-look/#peer-20240119104",
  });
  const items = [];

  assert.equal(addInvestigationComparativeSignal(items, item, { added: "2026-08-19" }), true);
  assert.equal(addInvestigationComparativeSignal(items, item, { added: "2026-08-20" }), false);
  assert.equal(items.length, 1);

  const sharedSnapshotItem = JSON.parse(JSON.stringify(items[0]));
  const reopened = [];
  assert.equal(addInvestigationComparativeSignal(reopened, sharedSnapshotItem), true);
  assert.deepEqual(reopened[0], sharedSnapshotItem);
});

test("held, eligible, malformed, and provenance-free signals cannot enter Investigation", () => {
  for (const mutate of [
    (signal) => { signal.state = "held_mnar"; },
    (signal) => { signal.state = "eligible"; },
    (signal) => { delete signal.comparison_receipt; },
    (signal) => { signal.basis_sentence = ""; },
    (signal) => { signal.evidence = []; },
  ]) {
    const signal = publishedSignal();
    mutate(signal);
    assert.equal(storySignalInvestigationItem(signal, { peerSetHref: "/experimental/worth-a-look/#peer" }), null);
  }
});

test("CSV and JSON-safe normalization preserve claim, evidence, and receipt while clamping fields", () => {
  const item = storySignalInvestigationItem(publishedSignal(), {
    peerSetHref: "/experimental/worth-a-look/#peer-20240119104",
  });
  item.note = "n".repeat(1500);
  item.evidence[0].href += "x".repeat(1000);

  const normalized = normalizeInvestigationComparativeSignal(item);
  assert.equal(normalized.note.length, 1000);
  assert.equal(normalized.evidence[0].href.length, 500);
  assert.equal(normalized.claim, publishedSignal().basis_sentence);
  assert.equal(normalized.comparison_receipt.receipt_id, publishedSignal().fact_id);

  const csv = comparativeSignalCsvFields(normalized);
  assert.equal(csv.claim, normalized.claim);
  assert.equal(csv.subject, normalized.subject.label);
  assert.equal(csv.peer_set, normalized.peer_set_href);
  assert.equal(csv.comparison_receipt, normalized.comparison_receipt.receipt_id);
  assert.match(csv.evidence, /qyyg-4tf5/);
  assert.deepEqual(JSON.parse(JSON.stringify(normalized)), normalized);
});

test("the handoff routes through the existing workspace, shared import, exports, and aggregate event", () => {
  const workspace = readFileSync(new URL("../site/app/workspace.mjs", import.meta.url), "utf8");
  const routing = readFileSync(new URL("../site/app/routing.mjs", import.meta.url), "utf8");
  const projection = readFileSync(new URL("../site/story_signal_projection.mjs", import.meta.url), "utf8");

  assert.match(projection, /#investigation\/signal\/\$\{encodeURIComponent\(signalId\)\}/);
  assert.match(routing, /showSignalInvestigation\(decodeURIComponent\(raw\.slice\(21\)\)\)/);
  assert.match(workspace, /storySignalInvestigationItem\(signal,/);
  assert.match(workspace, /addInvestigationComparativeSignal\(inv\.items,p,/,
    "read-only shared imports use the same strict add/dedupe path");
  for (const heading of ["Claim", "Subject", "Peer set", "Comparison receipt", "Evidence"]) {
    assert.match(workspace, new RegExp(`\\["${heading}"`));
  }
  assert.match(workspace, /if\(added\)\{[\s\S]*record\("investigation_share",\{detail:"add_signal",surface:"home"\}\)/,
    "the aggregate numerator counts successful adds, not duplicate attempts");
  assert.doesNotMatch(workspace, /crd_(?:story|signal|newsroom|research_package)/,
    "the handoff must not create a parallel local-storage subsystem");
});
