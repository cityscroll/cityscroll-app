/**
 * Fixed six-case dossier relation candidates and materialization.
 *
 * Candidates are commissioning inputs: stable identifiers and quoted spans
 * named by the dossier. Admission runs through site/connected_history_relations.mjs.
 * This module never searches for substitute examples.
 */

import { createHash } from "node:crypto";

import {
  CONNECTED_HISTORY_RELATION_METHOD,
  CONNECTED_HISTORY_RELATIONS_ARTIFACT_SCHEMA,
  CONNECTED_HISTORY_RELATIONS_VERSION,
  projectConnectedHistoryRelations,
} from "../../site/connected_history_relations.mjs";

export const CONNECTED_HISTORY_RELATIONS_RECEIPT_SCHEMA =
  "cityscroll.connected_history_relations_receipt.v1";

const OBSERVED_AT = "2026-09-26T00:00:00.000Z";

/**
 * Positive and hard-negative candidates for the fixed dossier.
 * Hard negatives carry rejected bases so admission must refuse them.
 */
export const CONNECTED_HISTORY_RELATION_CANDIDATES = Object.freeze([
  // --- Franklin Avenue: predecessor references without merging ---
  Object.freeze({
    candidate_id: "franklin-c230356zmk-references-c200184zmk",
    family_id: "franklin-avenue",
    relation: "explicitly_references",
    from: "land:application:C230356ZMK",
    to: "land:application:C200184ZMK",
    source_system: "zap-project-action-report",
    source_record_id: "zap:document:230356-official-report",
    source_span: Object.freeze({
      locator: "official_report_board_bp_documents_predecessor_applications",
      quote: "C200184ZMK",
    }),
    observed_time: OBSERVED_AT,
    method_version: CONNECTED_HISTORY_RELATION_METHOD,
    preserves_ids: Object.freeze([
      "land:application:C200184ZMK",
      "land:application:C230356ZMK",
    ]),
  }),
  Object.freeze({
    candidate_id: "franklin-c230356zmk-references-n200185zrk",
    family_id: "franklin-avenue",
    relation: "explicitly_references",
    from: "land:application:C230356ZMK",
    to: "land:application:N200185ZRK",
    source_system: "zap-project-action-report",
    source_record_id: "zap:document:230356-official-report",
    source_span: Object.freeze({
      locator: "official_report_board_bp_documents_predecessor_applications",
      quote: "N200185ZRK",
    }),
    observed_time: OBSERVED_AT,
    method_version: CONNECTED_HISTORY_RELATION_METHOD,
    preserves_ids: Object.freeze([
      "land:application:N200185ZRK",
      "land:application:C230356ZMK",
    ]),
  }),
  Object.freeze({
    candidate_id: "franklin-c230356zmk-references-c200186zsk",
    family_id: "franklin-avenue",
    relation: "explicitly_references",
    from: "land:application:C230356ZMK",
    to: "land:application:C200186ZSK",
    source_system: "zap-project-action-report",
    source_record_id: "zap:document:230356-official-report",
    source_span: Object.freeze({
      locator: "official_report_board_bp_documents_predecessor_applications",
      quote: "C200186ZSK",
    }),
    observed_time: OBSERVED_AT,
    method_version: CONNECTED_HISTORY_RELATION_METHOD,
  }),
  Object.freeze({
    candidate_id: "franklin-c230356zmk-references-c200187zsk",
    family_id: "franklin-avenue",
    relation: "explicitly_references",
    from: "land:application:C230356ZMK",
    to: "land:application:C200187ZSK",
    source_system: "zap-project-action-report",
    source_record_id: "zap:document:230356-official-report",
    source_span: Object.freeze({
      locator: "official_report_board_bp_documents_predecessor_applications",
      quote: "C200187ZSK",
    }),
    observed_time: OBSERVED_AT,
    method_version: CONNECTED_HISTORY_RELATION_METHOD,
  }),

  // --- Kingsbridge: successive proposals + multi-parcel footprint ---
  Object.freeze({
    candidate_id: "kingsbridge-13dme013x-successive-of-08dme004x",
    family_id: "kingsbridge-armory",
    relation: "successive_proposal",
    from: "ceqr:13DME013X",
    to: "ceqr:08DME004X",
    source_system: "ceqr",
    source_record_id: "ceqr:13DME013X",
    source_span: Object.freeze({
      locator: "oec_environmental_quality_review_page",
      quote: "13DME013X",
    }),
    scope: Object.freeze(["kingsbridge-armory"]),
    observed_time: OBSERVED_AT,
    method_version: CONNECTED_HISTORY_RELATION_METHOD,
  }),
  Object.freeze({
    candidate_id: "kingsbridge-25dme006x-successive-of-13dme013x",
    family_id: "kingsbridge-armory",
    relation: "successive_proposal",
    from: "ceqr:25DME006X",
    to: "ceqr:13DME013X",
    source_system: "ceqr",
    source_record_id: "ceqr:25DME006X",
    source_span: Object.freeze({
      locator: "ceqr_access_details",
      quote: "25DME006X",
    }),
    scope: Object.freeze(["kingsbridge-armory"]),
    observed_time: OBSERVED_AT,
    method_version: CONNECTED_HISTORY_RELATION_METHOD,
  }),
  Object.freeze({
    candidate_id: "kingsbridge-2025x0262-footprint-3247-10",
    family_id: "kingsbridge-armory",
    relation: "shares_documented_footprint",
    from: "land:project:2025X0262",
    to: "parcel:2032470010",
    source_system: "zap",
    source_record_id: "zap:project:2025X0262",
    source_span: Object.freeze({
      locator: "zap_project_page_tax_lots",
      quote: "3247/10",
    }),
    geographic_scope: Object.freeze(["parcel:2032470010", "parcel:2032470002"]),
    observed_time: OBSERVED_AT,
    method_version: CONNECTED_HISTORY_RELATION_METHOD,
  }),
  Object.freeze({
    candidate_id: "kingsbridge-2025x0262-footprint-3247-2",
    family_id: "kingsbridge-armory",
    relation: "shares_documented_footprint",
    from: "land:project:2025X0262",
    to: "parcel:2032470002",
    source_system: "zap",
    source_record_id: "zap:project:2025X0262",
    source_span: Object.freeze({
      locator: "zap_project_page_tax_lots",
      quote: "3247/2",
    }),
    geographic_scope: Object.freeze(["parcel:2032470010", "parcel:2032470002"]),
    observed_time: OBSERVED_AT,
    method_version: CONNECTED_HISTORY_RELATION_METHOD,
  }),

  // --- Coyle BSA: case-to-board-document links; parcel conflict stays open ---
  Object.freeze({
    candidate_id: "coyle-bsa-2025-54-a-cb15-agenda",
    family_id: "coyle",
    relation: "discussed_in_document",
    from: "bsa:case:2025-54-A",
    to: "board_document:brooklyn-cb-15:agenda-2026-01-27",
    source_system: "community-board-agenda",
    source_record_id: "brooklyn-cb-15:Agenda-1-27-26-Revised.pdf",
    source_span: Object.freeze({
      locator: "agenda_item_case_number",
      quote: "2025-54-A",
    }),
    observed_time: OBSERVED_AT,
    method_version: CONNECTED_HISTORY_RELATION_METHOD,
    parcel_conflict: Object.freeze({
      status: "unresolved",
      notes:
        "Published block/lot for 2114 Coyle conflicts with an assumed common parcel; left unresolved.",
      claims: Object.freeze([
        Object.freeze({
          address: "2114 Coyle Street",
          block: null,
          lot: null,
          source_record_id: "city-record:20260723030",
        }),
        Object.freeze({
          address: "2114 Coyle Street",
          block: "7367",
          lot: "11",
          source_record_id: "assumed-common-parcel",
        }),
      ]),
    }),
  }),
  Object.freeze({
    candidate_id: "coyle-bsa-2026-09-a-cb15-minutes",
    family_id: "coyle",
    relation: "discussed_in_document",
    from: "bsa:case:2026-09-A",
    to: "board_document:brooklyn-cb-15:minutes-2026-02-24",
    source_system: "community-board-minutes",
    source_record_id: "brooklyn-cb-15:Board-Meeting-Minutes-February-24-2026.pdf",
    source_span: Object.freeze({
      locator: "minutes_case_number",
      quote: "2026-09-A",
    }),
    observed_time: OBSERVED_AT,
    method_version: CONNECTED_HISTORY_RELATION_METHOD,
    parcel_conflict: Object.freeze({
      status: "unresolved",
      notes: "2140 Coyle and 2114 Coyle remain separately cited; no silent parcel merge.",
      claims: Object.freeze([
        Object.freeze({
          address: "2140 Coyle Street",
          source_record_id: "city-record:20260723030",
        }),
        Object.freeze({
          address: "2114 Coyle Street",
          source_record_id: "city-record:20260723030",
        }),
      ]),
    }),
  }),

  // --- Sixth Avenue: segment-scoped continuity ---
  Object.freeze({
    candidate_id: "sixth-ave-lispenard-w14-segment",
    family_id: "sixth-avenue",
    relation: "corridor_segment",
    from: "dot:corridor:sixth-avenue-lispenard-w14",
    to: "dot:corridor:sixth-avenue",
    source_system: "dot-current-projects",
    source_record_id: "dot:heading:sixth-avenue-lispenard-w14",
    source_span: Object.freeze({
      locator: "dot_current_projects_heading",
      quote: "Sixth Avenue, Lispenard Street to West 14th Street",
    }),
    geographic_scope: Object.freeze([
      "lispenard-street",
      "west-14th-street",
    ]),
    board_presentations: 1,
    observed_time: OBSERVED_AT,
    method_version: CONNECTED_HISTORY_RELATION_METHOD,
  }),
  Object.freeze({
    candidate_id: "sixth-ave-w14-w35-segment",
    family_id: "sixth-avenue",
    relation: "corridor_segment",
    from: "dot:corridor:sixth-avenue-w14-w35",
    to: "dot:corridor:sixth-avenue",
    source_system: "dot-current-projects",
    source_record_id: "dot:heading:sixth-avenue-w14-w35",
    source_span: Object.freeze({
      locator: "dot_current_projects_heading",
      quote: "Sixth Avenue, West 14th Street to West 35th Street",
    }),
    geographic_scope: Object.freeze([
      "west-14th-street",
      "west-35th-street",
    ]),
    board_presentations: 1,
    observed_time: OBSERVED_AT,
    method_version: CONNECTED_HISTORY_RELATION_METHOD,
  }),
  Object.freeze({
    candidate_id: "sixth-ave-watts-w59-segment",
    family_id: "sixth-avenue",
    relation: "corridor_segment",
    from: "dot:corridor:sixth-avenue-watts-w59",
    to: "dot:corridor:sixth-avenue",
    source_system: "dot-current-projects",
    source_record_id: "dot:heading:sixth-avenue-watts-w59",
    source_span: Object.freeze({
      locator: "dot_current_projects_heading",
      quote: "Sixth Avenue, Watts Street to West 59th Street",
    }),
    geographic_scope: Object.freeze([
      "watts-street",
      "west-59th-street",
    ]),
    board_presentations: 3,
    observed_time: OBSERVED_AT,
    method_version: CONNECTED_HISTORY_RELATION_METHOD,
  }),

  // --- 31st Avenue: phase continuity ---
  Object.freeze({
    candidate_id: "thirty-first-ave-phase-ii-of-corridor",
    family_id: "thirty-first-avenue",
    relation: "phase_component",
    from: "dot:phase:31st-avenue-phase-ii",
    to: "dot:corridor:31st-avenue-vernon-51",
    source_system: "dot-project-materials",
    source_record_id: "dot:31-ave-phase-ii-steinway-st-51-st-may2026-2.pdf",
    source_span: Object.freeze({
      locator: "phase_ii_materials_title",
      quote: "31st Avenue Phase II",
    }),
    component_scope: Object.freeze(["phase-ii", "vernon-boulevard-to-51st-street"]),
    observed_time: OBSERVED_AT,
    method_version: CONNECTED_HISTORY_RELATION_METHOD,
  }),
  Object.freeze({
    candidate_id: "thirty-first-ave-phase-i-of-corridor",
    family_id: "thirty-first-avenue",
    relation: "phase_component",
    from: "dot:phase:31st-avenue-phase-i",
    to: "dot:corridor:31st-avenue-vernon-51",
    source_system: "dot-project-materials",
    source_record_id: "dot:31-ave-phase-ii-steinway-st-51-st-may2026-2.pdf",
    source_span: Object.freeze({
      locator: "phase_i_implementation_note",
      quote: "Phase I implementation",
    }),
    component_scope: Object.freeze(["phase-i", "vernon-boulevard-to-51st-street"]),
    observed_time: OBSERVED_AT,
    method_version: CONNECTED_HISTORY_RELATION_METHOD,
  }),

  // --- Lighthouse Point: component-scoped opening ---
  Object.freeze({
    candidate_id: "lighthouse-phase1-opening-component",
    family_id: "lighthouse-point",
    relation: "phase_component",
    from: "edc:opening:lighthouse-point-phase-1-2025-06-05",
    to: "edc:project:lighthouse-point",
    source_system: "edc-press-release",
    source_record_id: "edc:press-release:lighthouse-point-opening-2025-06-05",
    source_span: Object.freeze({
      locator: "opening_announcement_first_residential_phase",
      quote: "first residential phase with 115 units",
    }),
    component_scope: Object.freeze(["phase-1-residential", "115-units"]),
    observed_time: OBSERVED_AT,
    method_version: CONNECTED_HISTORY_RELATION_METHOD,
  }),
  Object.freeze({
    candidate_id: "lighthouse-phase2-future-component",
    family_id: "lighthouse-point",
    relation: "phase_component",
    from: "edc:phase:lighthouse-point-phase-2",
    to: "edc:project:lighthouse-point",
    source_system: "edc-press-release",
    source_record_id: "edc:press-release:lighthouse-point-opening-2025-06-05",
    source_span: Object.freeze({
      locator: "opening_announcement_future_phase",
      quote: "Phase 2 remains future",
    }),
    component_scope: Object.freeze(["phase-2-future"]),
    observed_time: OBSERVED_AT,
    method_version: CONNECTED_HISTORY_RELATION_METHOD,
  }),

  // --- Hard negatives (must reject) ---
  Object.freeze({
    candidate_id: "negative-emmons-coyle-proximity",
    family_id: "coyle",
    relation: "explicitly_references",
    from: "parcel:emmons-avenue-control",
    to: "land:project:2020K0270",
    basis: "proximity",
    source_system: "neighborhood-heuristic",
    source_record_id: "synthetic:emmons-coyle-proximity",
    source_span: Object.freeze({
      locator: "neighborhood_label",
      quote: "Emmons",
    }),
    observed_time: OBSERVED_AT,
    method_version: CONNECTED_HISTORY_RELATION_METHOD,
  }),
  Object.freeze({
    candidate_id: "negative-31st-street-vs-avenue",
    family_id: "thirty-first-avenue",
    relation: "corridor_segment",
    from: "dot:corridor:31st-street",
    to: "dot:corridor:31st-avenue-vernon-51",
    basis: "street_name_similarity",
    source_system: "street-name-heuristic",
    source_record_id: "synthetic:31st-street-similarity",
    source_span: Object.freeze({
      locator: "street_name",
      quote: "31st Street",
    }),
    geographic_scope: Object.freeze(["31st-street"]),
    observed_time: OBSERVED_AT,
    method_version: CONNECTED_HISTORY_RELATION_METHOD,
  }),
  Object.freeze({
    candidate_id: "negative-stapleton-related-news-lighthouse",
    family_id: "lighthouse-point",
    relation: "phase_component",
    from: "edc:related-news:stapleton",
    to: "edc:project:lighthouse-point",
    basis: "related_news",
    source_system: "edc-related-news",
    source_record_id: "edc:related-news:stapleton-generic",
    source_span: Object.freeze({
      locator: "related_news_listing",
      quote: "Stapleton",
    }),
    component_scope: Object.freeze(["related-news"]),
    observed_time: OBSERVED_AT,
    method_version: CONNECTED_HISTORY_RELATION_METHOD,
  }),
  Object.freeze({
    candidate_id: "negative-franklin-same-applicant-shortcut",
    family_id: "franklin-avenue",
    relation: "explicitly_references",
    from: "land:application:C230356ZMK",
    to: "land:application:C200184ZMK",
    basis: "same_applicant",
    source_system: "applicant-label-heuristic",
    source_record_id: "synthetic:franklin-same-applicant",
    source_span: Object.freeze({
      locator: "primary_applicant",
      quote: "same applicant label",
    }),
    observed_time: OBSERVED_AT,
    method_version: CONNECTED_HISTORY_RELATION_METHOD,
  }),
  Object.freeze({
    candidate_id: "negative-coyle-same-board-ownership",
    family_id: "coyle",
    relation: "discussed_in_document",
    from: "bsa:case:2025-54-A",
    to: "bsa:case:2026-09-A",
    basis: "same_board",
    source_system: "board-calendar-heuristic",
    source_record_id: "synthetic:coyle-same-board",
    source_span: Object.freeze({
      locator: "board_id",
      quote: "brooklyn-cb-15",
    }),
    observed_time: OBSERVED_AT,
    method_version: CONNECTED_HISTORY_RELATION_METHOD,
  }),
  Object.freeze({
    candidate_id: "negative-coyle-parcel-assumption-merge",
    family_id: "coyle",
    relation: "shares_documented_footprint",
    from: "parcel:assumed-2114-coyle",
    to: "parcel:3073670011",
    basis: "parcel_assumption",
    source_system: "parcel-heuristic",
    source_record_id: "synthetic:coyle-parcel-assumption",
    source_span: Object.freeze({
      locator: "assumed_common_parcel",
      quote: "2114 Coyle",
    }),
    geographic_scope: Object.freeze(["parcel:assumed-2114-coyle"]),
    observed_time: OBSERVED_AT,
    method_version: CONNECTED_HISTORY_RELATION_METHOD,
  }),
]);

const DEMO_FAMILY_IDS = Object.freeze([
  "coyle",
  "franklin-avenue",
  "kingsbridge-armory",
  "sixth-avenue",
  "thirty-first-avenue",
  "lighthouse-point",
]);

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

export function buildConnectedHistoryRelationsArtifact(options = {}) {
  const candidates = options.candidates || CONNECTED_HISTORY_RELATION_CANDIDATES;
  const generatedAt = options.generatedAt || OBSERVED_AT;
  const projected = projectConnectedHistoryRelations(candidates);

  const familyCounts = {};
  for (const familyId of DEMO_FAMILY_IDS) familyCounts[familyId] = { admitted: 0, rejected: 0 };
  for (const edge of projected.relations) {
    const familyId = edge.family_id || "unscoped";
    familyCounts[familyId] = familyCounts[familyId] || { admitted: 0, rejected: 0 };
    familyCounts[familyId].admitted += 1;
  }
  for (const row of projected.rejections) {
    const candidate = candidates.find((item) => item.candidate_id === row.candidate_id);
    const familyId = candidate?.family_id || "unscoped";
    familyCounts[familyId] = familyCounts[familyId] || { admitted: 0, rejected: 0 };
    familyCounts[familyId].rejected += 1;
  }

  const selectionHash = sha256(stableStringify({
    schema: CONNECTED_HISTORY_RELATIONS_ARTIFACT_SCHEMA,
    version: CONNECTED_HISTORY_RELATIONS_VERSION,
    candidate_ids: candidates.map((row) => row.candidate_id),
    admitted: projected.relations.map((edge) => ({
      candidate_id: edge.candidate_id || null,
      relation: edge.relation,
      from: edge.from,
      to: edge.to,
    })),
    rejected: projected.rejections,
  }));

  return {
    ...projected,
    generated_at: generatedAt,
    source_policy: "fixed-six-case-dossier-only",
    dossier_families: [...DEMO_FAMILY_IDS],
    family_counts: familyCounts,
    selection_hash: selectionHash,
    boundaries: {
      no_identity_merge: true,
      no_same_applicant_ownership: true,
      no_same_board_project_equivalence: true,
      no_related_news_identity: true,
      unresolved_parcel_conflicts_preserved: true,
    },
  };
}

export function buildConnectedHistoryRelationsReceipt(artifact, options = {}) {
  return {
    schema: CONNECTED_HISTORY_RELATIONS_RECEIPT_SCHEMA,
    version: 1,
    artifact: "site/data/connected_history_relations.json",
    generated_at: artifact.generated_at,
    selection_hash: artifact.selection_hash,
    counts: artifact.counts,
    method: CONNECTED_HISTORY_RELATION_METHOD,
    source_policy: artifact.source_policy,
    candidate_count: options.candidateCount
      ?? CONNECTED_HISTORY_RELATION_CANDIDATES.length,
  };
}

export function materializeConnectedHistoryRelations(options = {}) {
  const artifact = buildConnectedHistoryRelationsArtifact(options);
  const receipt = buildConnectedHistoryRelationsReceipt(artifact, {
    candidateCount: (options.candidates || CONNECTED_HISTORY_RELATION_CANDIDATES).length,
  });
  return { artifact, receipt };
}
