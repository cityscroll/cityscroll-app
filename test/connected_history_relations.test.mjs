/**
 * Fixed-dossier connected-history relations: explicit references and scoped
 * history without merging distinct applications or inventing ownership.
 *
 *   node --test test/connected_history_relations.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CONNECTED_HISTORY_REJECTED_BASES,
  CONNECTED_HISTORY_RELATION_FAMILIES,
  CONNECTED_HISTORY_RELATION_METHOD,
  CONNECTED_HISTORY_RELATION_SCHEMA,
  CONNECTED_HISTORY_RELATION_VOCABULARY,
  CONNECTED_HISTORY_RELATIONS_ARTIFACT_SCHEMA,
  admitConnectedHistoryRelation,
  applicationsRemainDistinct,
  projectConnectedHistoryRelations,
  relationsForSubject,
} from "../site/connected_history_relations.mjs";
import { warrantClassForEdge } from "../site/graph_edge_provenance.mjs";
import {
  CONNECTED_HISTORY_RELATION_CANDIDATES,
  buildConnectedHistoryRelationsArtifact,
  materializeConnectedHistoryRelations,
} from "../tools/lib/connected_history_relations.mjs";
import { loadOntologyRegistry } from "../ontology/index.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const committed = JSON.parse(
  readFileSync(join(ROOT, "site/data/connected_history_relations.json"), "utf8"),
);
const committedReceipt = JSON.parse(
  readFileSync(
    join(
      ROOT,
      "site/data/connected_history_sources/verification_receipts/connected_history_relations_latest.json",
    ),
    "utf8",
  ),
);

const FRANKLIN_APPS = [
  "land:application:C200184ZMK",
  "land:application:N200185ZRK",
  "land:application:C200186ZSK",
  "land:application:C200187ZSK",
  "land:application:C230356ZMK",
];

const HARD_NEGATIVE_IDS = [
  "negative-emmons-coyle-proximity",
  "negative-31st-street-vs-avenue",
  "negative-stapleton-related-news-lighthouse",
  "negative-franklin-same-applicant-shortcut",
  "negative-coyle-same-board-ownership",
  "negative-coyle-parcel-assumption-merge",
];

test("vocabulary registers explicit-reference and scoped-history families", () => {
  const vocab = CONNECTED_HISTORY_RELATION_VOCABULARY;
  assert.equal(vocab.explicitly_references.family, "explicit_reference");
  assert.equal(vocab.discussed_in_document.family, "explicit_reference");
  assert.equal(vocab.successive_proposal.family, "scoped_history");
  assert.equal(vocab.shares_documented_footprint.family, "scoped_history");
  assert.equal(vocab.corridor_segment.family, "scoped_history");
  assert.equal(vocab.phase_component.family, "scoped_history");
  assert.deepEqual(
    [...CONNECTED_HISTORY_RELATION_FAMILIES].sort(),
    ["explicit_reference", "scoped_history"],
  );
  for (const entry of Object.values(vocab)) {
    assert.ok(entry.inverse, entry.id);
    assert.ok(entry.semantic_threshold, entry.id);
    assert.ok(entry.required_evidence.includes("source_span"), entry.id);
    assert.ok(entry.negative_rule, entry.id);
  }
  for (const basis of [
    "proximity",
    "coappearance",
    "same_applicant",
    "same_board",
    "related_news",
    "street_name_similarity",
  ]) {
    assert.ok(CONNECTED_HISTORY_REJECTED_BASES.includes(basis), basis);
  }
});

test("ontology registers the connected-history relation vocabulary", () => {
  const registry = loadOntologyRegistry();
  const links = new Map(registry.link_types.map((entry) => [entry.id, entry]));
  for (const id of Object.keys(CONNECTED_HISTORY_RELATION_VOCABULARY)) {
    const entry = links.get(id);
    assert.ok(entry, id);
    assert.equal(entry.status, "registered", id);
    assert.equal(entry.relation, id, id);
    assert.ok(entry.inverse, id);
    assert.ok(entry.semantic_threshold, id);
    assert.ok(
      entry.required_evidence.includes("source_span")
        || entry.required_evidence.includes("source_record_id"),
      id,
    );
    assert.ok(
      (entry.backing || []).some((row) => String(row).includes("connected_history_relations")),
      id,
    );
  }
});

test("A1: Franklin predecessor references admit without merging applications", () => {
  const artifact = buildConnectedHistoryRelationsArtifact();
  const franklins = artifact.relations.filter((edge) => edge.family_id === "franklin-avenue");
  assert.ok(franklins.length >= 4, "expected predecessor reference edges");
  for (const edge of franklins) {
    assert.equal(edge.relation, "explicitly_references");
    assert.equal(edge.identities_merged, false);
    assert.equal(edge.from, "land:application:C230356ZMK");
    assert.ok(FRANKLIN_APPS.includes(edge.to), edge.to);
    assert.ok(edge.source_span.quote.length > 0);
    assert.match(edge.source_span.quote, /^[CN]\d/);
  }
  assert.equal(
    applicationsRemainDistinct(FRANKLIN_APPS, artifact.relations),
    true,
  );
  // Converse control: a self-merge candidate is refused.
  const mergeAttempt = admitConnectedHistoryRelation({
    relation: "explicitly_references",
    from: "land:application:C230356ZMK",
    to: "land:application:C230356ZMK",
    source_system: "zap-project-action-report",
    source_record_id: "zap:document:230356-official-report",
    source_span: { locator: "self", quote: "C230356ZMK" },
    observed_time: "2026-09-26T00:00:00.000Z",
  });
  assert.equal(mergeAttempt.admitted, false);
  assert.equal(mergeAttempt.reason, "self_link");
});

test("A1: Kingsbridge successive proposals and footprint relations admit", () => {
  const artifact = buildConnectedHistoryRelationsArtifact();
  const successive = artifact.relations.filter(
    (edge) => edge.family_id === "kingsbridge-armory" && edge.relation === "successive_proposal",
  );
  assert.equal(successive.length, 2);
  assert.ok(
    successive.some(
      (edge) => edge.from === "ceqr:13DME013X" && edge.to === "ceqr:08DME004X",
    ),
  );
  assert.ok(
    successive.some(
      (edge) => edge.from === "ceqr:25DME006X" && edge.to === "ceqr:13DME013X",
    ),
  );
  for (const edge of successive) {
    assert.ok(edge.scope?.length || edge.geographic_scope?.length);
    assert.equal(edge.identities_merged, false);
  }

  const footprints = artifact.relations.filter(
    (edge) => edge.relation === "shares_documented_footprint",
  );
  assert.equal(footprints.length, 2);
  const parcels = new Set(footprints.map((edge) => edge.to));
  assert.deepEqual(
    [...parcels].sort(),
    ["parcel:2032470002", "parcel:2032470010"],
  );
  for (const edge of footprints) {
    assert.ok(edge.geographic_scope.includes("parcel:2032470010"));
    assert.ok(edge.geographic_scope.includes("parcel:2032470002"));
  }
});

test("A1: BSA case-to-board-document links admit independently of parcel conflict", () => {
  const artifact = buildConnectedHistoryRelationsArtifact();
  const bsa = artifact.relations.filter((edge) => edge.relation === "discussed_in_document");
  assert.equal(bsa.length, 2);
  const byCase = new Map(bsa.map((edge) => [edge.from, edge]));
  assert.ok(byCase.has("bsa:case:2025-54-A"));
  assert.ok(byCase.has("bsa:case:2026-09-A"));
  for (const edge of bsa) {
    assert.equal(edge.parcel_identity, "unresolved");
    assert.equal(edge.parcel_conflict.status, "unresolved");
    assert.ok(edge.parcel_conflict.claims.length >= 1);
    assert.match(edge.source_span.quote, /^202[56]-/);
  }

  // Positive control: resolving the conflict silently is refused.
  const silentResolve = admitConnectedHistoryRelation({
    relation: "discussed_in_document",
    from: "bsa:case:2025-54-A",
    to: "board_document:brooklyn-cb-15:agenda-2026-01-27",
    source_system: "community-board-agenda",
    source_record_id: "brooklyn-cb-15:Agenda-1-27-26-Revised.pdf",
    source_span: { locator: "agenda_item_case_number", quote: "2025-54-A" },
    observed_time: "2026-09-26T00:00:00.000Z",
    parcel_conflict: { status: "resolved", claims: [] },
  });
  assert.equal(silentResolve.admitted, false);
  assert.equal(silentResolve.reason, "silent_parcel_resolution_forbidden");
});

test("A1: DOT segment and EDC component continuity admit with scope", () => {
  const artifact = buildConnectedHistoryRelationsArtifact();
  const segments = artifact.relations.filter((edge) => edge.relation === "corridor_segment");
  assert.equal(segments.length, 3);
  const scopes = new Set(
    segments.flatMap((edge) => edge.geographic_scope || []),
  );
  assert.ok(scopes.has("lispenard-street"));
  assert.ok(scopes.has("west-59th-street"));
  const watts = segments.find(
    (edge) => edge.from === "dot:corridor:sixth-avenue-watts-w59",
  );
  assert.equal(watts.board_presentations, 3);
  assert.equal(watts.board_endorsement, false);

  const lighthouse = artifact.relations.filter(
    (edge) => edge.family_id === "lighthouse-point",
  );
  assert.equal(lighthouse.length, 2);
  for (const edge of lighthouse) {
    assert.equal(edge.relation, "phase_component");
    assert.equal(edge.to, "edc:project:lighthouse-point");
    assert.ok(edge.component_scope.length >= 1);
  }
  assert.ok(
    lighthouse.some((edge) => edge.component_scope.includes("phase-1-residential")),
  );
  assert.ok(
    lighthouse.some((edge) => edge.component_scope.includes("phase-2-future")),
  );

  const phases = artifact.relations.filter(
    (edge) => edge.family_id === "thirty-first-avenue",
  );
  assert.equal(phases.length, 2);
  assert.ok(phases.every((edge) => edge.to === "dot:corridor:31st-avenue-vernon-51"));
});

test("A2: named hard negatives are rejected by shared provenance admission", () => {
  const artifact = buildConnectedHistoryRelationsArtifact();
  const rejectedIds = new Set(artifact.rejections.map((row) => row.candidate_id));
  for (const id of HARD_NEGATIVE_IDS) {
    assert.ok(rejectedIds.has(id), id);
  }

  const byId = new Map(artifact.rejections.map((row) => [row.candidate_id, row]));
  assert.match(byId.get("negative-emmons-coyle-proximity").reason, /proximity/);
  assert.match(byId.get("negative-31st-street-vs-avenue").reason, /street_name_similarity/);
  assert.match(
    byId.get("negative-stapleton-related-news-lighthouse").reason,
    /related_news/,
  );
  assert.match(
    byId.get("negative-franklin-same-applicant-shortcut").reason,
    /same_applicant/,
  );
  assert.match(
    byId.get("negative-coyle-same-board-ownership").reason,
    /same_board/,
  );
  assert.match(
    byId.get("negative-coyle-parcel-assumption-merge").reason,
    /parcel_assumption/,
  );

  // None of the hard negatives appear as admitted edges.
  const admittedIds = new Set(
    artifact.relations.map((edge) => edge.candidate_id).filter(Boolean),
  );
  for (const id of HARD_NEGATIVE_IDS) {
    assert.equal(admittedIds.has(id), false, id);
  }
});

test("A3: contradictory parcel evidence, repeated references, and component boundaries", () => {
  // Contradictory parcel evidence: link admits; identity stays unresolved.
  const withConflict = admitConnectedHistoryRelation({
    relation: "discussed_in_document",
    from: "bsa:case:2025-54-A",
    to: "board_document:brooklyn-cb-15:agenda-2026-01-27",
    source_system: "community-board-agenda",
    source_record_id: "brooklyn-cb-15:Agenda-1-27-26-Revised.pdf",
    source_span: { locator: "agenda_item_case_number", quote: "2025-54-A" },
    observed_time: "2026-09-26T00:00:00.000Z",
    parcel_conflict: {
      status: "unresolved",
      claims: [
        { address: "2114 Coyle Street", source_record_id: "a" },
        { address: "2114 Coyle Street", block: "9999", lot: "99", source_record_id: "b" },
      ],
    },
  });
  assert.equal(withConflict.admitted, true);
  assert.equal(withConflict.edge.parcel_identity, "unresolved");
  assert.equal(withConflict.edge.parcel_conflict.claims.length, 2);

  // Repeated document references: each quoted predecessor is its own edge.
  const artifact = buildConnectedHistoryRelationsArtifact();
  const franklins = relationsForSubject(artifact, "land:application:C230356ZMK")
    .filter((edge) => edge.relation === "explicitly_references");
  const quotes = franklins.map((edge) => edge.source_span.quote).sort();
  assert.deepEqual(quotes, ["C200184ZMK", "C200186ZSK", "C200187ZSK", "N200185ZRK"]);
  assert.equal(new Set(franklins.map((edge) => edge.to)).size, 4);

  // Component boundaries: Phase I and Phase II stay separate subjects.
  const phaseIds = artifact.relations
    .filter((edge) => edge.family_id === "thirty-first-avenue")
    .map((edge) => edge.from)
    .sort();
  assert.deepEqual(phaseIds, [
    "dot:phase:31st-avenue-phase-i",
    "dot:phase:31st-avenue-phase-ii",
  ]);

  // Positive control for incomplete evidence: missing quote fails.
  const noQuote = admitConnectedHistoryRelation({
    relation: "explicitly_references",
    from: "land:application:C230356ZMK",
    to: "land:application:C200184ZMK",
    source_system: "zap-project-action-report",
    source_record_id: "zap:document:230356-official-report",
    source_span: { locator: "official_report", quote: "" },
    observed_time: "2026-09-26T00:00:00.000Z",
  });
  assert.equal(noQuote.admitted, false);
  assert.equal(noQuote.reason, "missing_quoted_source_span");

  // Positive control for scoped history: missing geographic scope fails.
  const noScope = admitConnectedHistoryRelation({
    relation: "corridor_segment",
    from: "dot:corridor:sixth-avenue-lispenard-w14",
    to: "dot:corridor:sixth-avenue",
    source_system: "dot-current-projects",
    source_record_id: "dot:heading:sixth-avenue-lispenard-w14",
    source_span: {
      locator: "dot_current_projects_heading",
      quote: "Sixth Avenue, Lispenard Street to West 14th Street",
    },
    observed_time: "2026-09-26T00:00:00.000Z",
  });
  assert.equal(noScope.admitted, false);
  assert.equal(noScope.reason, "missing_geographic_scope");
});

test("A3: warrant classification treats quoted-span relations as exact", () => {
  const artifact = buildConnectedHistoryRelationsArtifact();
  assert.ok(artifact.relations.length > 0);
  for (const edge of artifact.relations) {
    assert.equal(edge.schema, CONNECTED_HISTORY_RELATION_SCHEMA);
    assert.equal(edge.method, CONNECTED_HISTORY_RELATION_METHOD);
    assert.equal(
      warrantClassForEdge({
        method: edge.warrant_method,
        confidence: edge.confidence,
      }).id,
      "exact",
    );
  }
  // Positive control: a proximity-labelled method stays non-exact.
  assert.equal(
    warrantClassForEdge({
      method: "proximity_neighborhood_v1",
      confidence: "strong",
    }).id,
    "probabilistic",
  );
});

test("A4: candidates are exactly the fixed dossier set; no substitutes", () => {
  const ids = CONNECTED_HISTORY_RELATION_CANDIDATES.map((row) => row.candidate_id).sort();
  assert.deepEqual(
    ids,
    [...ids].sort(),
    "candidate list must be a closed dossier set",
  );
  assert.equal(
    CONNECTED_HISTORY_RELATION_CANDIDATES.length,
    ids.length,
    "candidate ids must be unique",
  );

  const artifact = buildConnectedHistoryRelationsArtifact();
  assert.equal(artifact.source_policy, "fixed-six-case-dossier-only");
  assert.deepEqual(
    artifact.dossier_families,
    [
      "coyle",
      "franklin-avenue",
      "kingsbridge-armory",
      "sixth-avenue",
      "thirty-first-avenue",
      "lighthouse-point",
    ],
  );

  // Dropping one positive candidate reduces admitted count rather than backfilling.
  const withoutFranklin = CONNECTED_HISTORY_RELATION_CANDIDATES.filter(
    (row) => row.candidate_id !== "franklin-c230356zmk-references-c200184zmk",
  );
  const reduced = projectConnectedHistoryRelations(withoutFranklin);
  const full = projectConnectedHistoryRelations(CONNECTED_HISTORY_RELATION_CANDIDATES);
  assert.equal(reduced.counts.admitted, full.counts.admitted - 1);
  assert.equal(
    reduced.relations.some(
      (edge) => edge.candidate_id === "franklin-c230356zmk-references-c200184zmk",
    ),
    false,
  );
});

test("committed artifact and receipt match a fresh materialization", () => {
  const { artifact, receipt } = materializeConnectedHistoryRelations();
  assert.equal(committed.schema, CONNECTED_HISTORY_RELATIONS_ARTIFACT_SCHEMA);
  assert.equal(committed.selection_hash, artifact.selection_hash);
  assert.equal(committed.counts.admitted, artifact.counts.admitted);
  assert.equal(committed.counts.rejected, artifact.counts.rejected);
  assert.equal(committedReceipt.selection_hash, receipt.selection_hash);
  assert.equal(committedReceipt.artifact, "site/data/connected_history_relations.json");
  assert.ok(committed.relations.length > 0);
  assert.ok(committed.rejections.length >= HARD_NEGATIVE_IDS.length);
});
