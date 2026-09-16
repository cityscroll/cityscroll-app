import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  CONNECTED_HISTORY_COHORT_SCHEMA,
  CONNECTED_HISTORY_DEMO_FAMILIES,
  CONNECTED_HISTORY_EVALUATION_SEED,
  CONNECTED_HISTORY_STRATA,
  communityDistrictFieldToBoardIds,
  freezeConnectedHistoryCohort,
  judgeSubjectFromRetainedBundle,
  relabelSampleAsDevelopment,
  selectionRank,
} from "../tools/lib/connected_history_cohort.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const committed = JSON.parse(
  readFileSync(join(ROOT, "site/data/connected_history_evaluation_cohort.json"), "utf8"),
);
const committedReceipt = JSON.parse(
  readFileSync(
    join(
      ROOT,
      "site/data/connected_history_sources/verification_receipts/connected_history_evaluation_cohort_latest.json",
    ),
    "utf8",
  ),
);

const FIXTURE_BOARDS = [
  "brooklyn-cb-09",
  "brooklyn-cb-15",
  "bronx-cb-07",
  "manhattan-cb-02",
  "manhattan-cb-04",
  "queens-cb-01",
  "queens-cb-13",
  "staten-island-cb-01",
];

function fixtureInputs(overrides = {}) {
  return {
    boardIds: FIXTURE_BOARDS,
    zapProjects: [
      {
        project_id: "2023K0398",
        community_district: "K15",
        app_filed_date: "2023-04-01",
        project_name: "Non-demo Brooklyn CB15 project",
      },
      {
        project_id: "2019K0147",
        community_district: "K15",
        app_filed_date: "2019-06-01",
        project_name: "Second non-demo Brooklyn CB15 project",
      },
      {
        project_id: "2024K0444",
        community_district: "K13,K11",
        app_filed_date: "2024-01-15",
        project_name: "Multi-board Brooklyn project",
      },
      {
        project_id: "2020K0270",
        community_district: "K15",
        app_filed_date: "2020-01-01",
        project_name: "Coyle demo project if present in warehouse",
      },
      {
        project_id: "2025X0262",
        community_district: "X07",
        app_filed_date: "2025-02-01",
        project_name: "Kingsbridge demo project if present",
      },
    ],
    landPositionsByBoard: {
      "brooklyn-cb-15": {
        positions: [
          {
            project_id: "2023K0398",
            recorded_on: "2024-05-01",
            position: "Unfavorable",
          },
        ],
      },
    },
    siteLifecycleParcels: [
      {
        parcel_id: "3073670011",
        members: [
          {
            subject_id: "land:project:2020K0270",
            source_event_date: "2022-02-24",
            relation_path: ["land:application:C210239ZMK"],
          },
          {
            subject_id: "procurement:award:20241104015",
            source_event_date: "2024-11-04",
            relation_path: [],
          },
        ],
      },
    ],
    bsaMeetings: [
      {
        event_date: "2026-09-14",
        agenda_items: [
          {
            case_id: "2024-58-BZ",
            affected_area: { community_boards: [] },
          },
          {
            case_id: "2025-54-A",
            affected_area: { community_boards: ["brooklyn-cb-15"] },
          },
        ],
      },
    ],
    explicitRelationsBySubject: {
      "parcel:3073670011": [
        {
          from: "parcel:3073670011",
          to: "land:project:2020K0270",
          relation: "site_lifecycle_member",
        },
      ],
    },
    sourceVersions: {
      fixture: true,
      zap_projects: { row_count: 5 },
      dot_edc_tranche: {
        status: "unavailable",
        reason: "bounded_dossier_urls_not_yet_retained_as_source_bundles",
      },
    },
    ...overrides,
  };
}

test("community district tokens map to canonical board ids", () => {
  assert.deepEqual(communityDistrictFieldToBoardIds("K15"), ["brooklyn-cb-15"]);
  assert.deepEqual(communityDistrictFieldToBoardIds("K13,K11"), [
    "brooklyn-cb-13",
    "brooklyn-cb-11",
  ]);
  assert.deepEqual(communityDistrictFieldToBoardIds(""), []);
});

test("A1: freeze is repeatable for the same seed and retained inputs", () => {
  const first = freezeConnectedHistoryCohort(fixtureInputs(), {
    seed: CONNECTED_HISTORY_EVALUATION_SEED,
  });
  const second = freezeConnectedHistoryCohort(fixtureInputs(), {
    seed: CONNECTED_HISTORY_EVALUATION_SEED,
  });
  assert.equal(first.schema, CONNECTED_HISTORY_COHORT_SCHEMA);
  assert.equal(first.seed, CONNECTED_HISTORY_EVALUATION_SEED);
  assert.equal(first.selection_hash, second.selection_hash);
  assert.deepEqual(first.sample, second.sample);
  assert.deepEqual(
    first.source_versions.demo_family_exclusions.map((row) => row.family_id),
    CONNECTED_HISTORY_DEMO_FAMILIES.map((row) => row.family_id),
  );
  assert.equal(first.boards.length, FIXTURE_BOARDS.length);
  for (const board of first.boards) {
    assert.ok(board.selected_subject_ids.length <= 2);
    assert.deepEqual(
      Object.keys(board.strata).sort(),
      [...CONNECTED_HISTORY_STRATA].sort(),
    );
  }
});

test("A1: six-family exclusions never enter held-out sample seats", () => {
  const frozen = freezeConnectedHistoryCohort(fixtureInputs(), {
    seed: CONNECTED_HISTORY_EVALUATION_SEED,
  });
  const demoIds = new Set(
    CONNECTED_HISTORY_DEMO_FAMILIES.flatMap((family) => family.subject_ids),
  );
  for (const row of frozen.sample) {
    assert.equal(row.sample_role, "held_out");
    assert.equal(row.confirmation_eligible, true);
    assert.equal(demoIds.has(row.subject_id), false);
  }
  const coyle = frozen.population.subjects.find(
    (row) => row.subject_id === "land:project:2020K0270",
  );
  assert.equal(coyle.demo_family_id, "coyle");
  assert.equal(coyle.eligible_for_held_out, false);
  const award = frozen.population.subjects.find(
    (row) => row.subject_id === "procurement:award:20241104015",
  );
  assert.equal(award.demo_family_id, "coyle");
  assert.equal(award.eligible_for_held_out, false);
});

test("A1/A4: missing strata are retained and never filled by substitution", () => {
  const frozen = freezeConnectedHistoryCohort(fixtureInputs(), {
    seed: CONNECTED_HISTORY_EVALUATION_SEED,
  });
  for (const board of frozen.boards) {
    assert.equal(board.strata.corridor_component.status, "unavailable");
    assert.ok(board.unavailable_strata.includes("corridor_component"));
  }
  const emptyBoard = frozen.boards.find((row) => row.board_id === "queens-cb-13");
  assert.equal(emptyBoard.eligible_count, 0);
  assert.deepEqual(emptyBoard.selected_subject_ids, []);
  assert.equal(emptyBoard.strata.parcel_proceeding.status, "unavailable");
  assert.equal(frozen.source_versions.dot_edc_tranche.status, "unavailable");
  assert.equal(
    frozen.population.subjects.some((row) => row.subject_id.startsWith("dot:corridor:")),
    true,
  );
  for (const corridor of frozen.population.subjects.filter((row) =>
    row.subject_id.startsWith("dot:corridor:")
  )) {
    assert.equal(corridor.source_availability, "unavailable");
    assert.equal(corridor.eligible_for_held_out, false);
  }
});

test("A2: multiboard subjects count locally per board and once citywide", () => {
  const frozen = freezeConnectedHistoryCohort(fixtureInputs(), {
    seed: CONNECTED_HISTORY_EVALUATION_SEED,
  });
  const multiId = "land:project:2024K0444";
  // Expand fixture boards so both local scopes exist in the report.
  const withLocalBoards = freezeConnectedHistoryCohort(
    fixtureInputs({
      boardIds: [...FIXTURE_BOARDS, "brooklyn-cb-11", "brooklyn-cb-13"],
    }),
    { seed: CONNECTED_HISTORY_EVALUATION_SEED },
  );
  const localHits = withLocalBoards.boards.filter((board) =>
    board.selected_subject_ids.includes(multiId)
  );
  assert.ok(localHits.length >= 1);
  assert.equal(
    withLocalBoards.sample.filter((row) => row.subject_id === multiId).length,
    1,
  );
  const subject = withLocalBoards.population.subjects.find((row) => row.subject_id === multiId);
  assert.deepEqual(subject.boards, ["brooklyn-cb-11", "brooklyn-cb-13"]);
  assert.equal(frozen.denominators.selected_held_out_subjects, frozen.sample.length);
});

test("A2: failed and unresolved subjects remain in denominators; unavailability ≠ zero", () => {
  const frozen = freezeConnectedHistoryCohort(fixtureInputs(), {
    seed: CONNECTED_HISTORY_EVALUATION_SEED,
  });
  const unresolved = frozen.population.subjects.find(
    (row) => row.subject_id === "bsa:case:2024-58-BZ",
  );
  assert.equal(unresolved.board_assignment, "unresolved");
  assert.equal(unresolved.eligible_for_held_out, false);
  assert.ok(frozen.denominators.unresolved_or_failed_board_subjects >= 1);
  assert.ok(frozen.denominators.unavailable_source_subjects >= 1);
  assert.notEqual(
    frozen.denominators.unavailable_source_subjects,
    0,
    "source unavailability must be an explicit positive count, not an inferred zero-record board",
  );
  const emptyBoard = frozen.boards.find((row) => row.board_id === "queens-cb-13");
  assert.equal(emptyBoard.eligible_count, 0);
  assert.equal(emptyBoard.strata.parcel_proceeding.reason, "no_eligible_retained_subjects");
});

test("A2: samples that inform tuning are relabelled development and leave confirmation", () => {
  const frozen = freezeConnectedHistoryCohort(fixtureInputs(), {
    seed: CONNECTED_HISTORY_EVALUATION_SEED,
  });
  const contaminated = relabelSampleAsDevelopment(frozen.sample, {
    reason: "held_out_failure_informed_rule_tuning",
    newSeed: "connected-history-confirmation-2026-09-17",
  });
  assert.equal(contaminated.label, "development");
  assert.equal(contaminated.excluded_from_confirmation, true);
  assert.equal(contaminated.confirmation_seed, "connected-history-confirmation-2026-09-17");
  assert.ok(contaminated.subjects.length > 0);
  for (const row of contaminated.subjects) {
    assert.equal(row.sample_role, "development");
    assert.equal(row.confirmation_eligible, false);
  }
  assert.equal(
    contaminated.subjects.every((row) => row.confirmation_eligible === false),
    true,
  );
});

test("A3: retained-bundle judgments preserve insufficient evidence before tuning", () => {
  const thin = judgeSubjectFromRetainedBundle(
    {
      subject_id: "land:project:2023K0398",
      source_availability: "retained",
      retained_bundle_refs: ["zap_projects_warehouse_lookup#2023K0398"],
    },
    { explicit_relations: [] },
  );
  assert.equal(thin.judgment, "insufficient_evidence");
  assert.equal(thin.rationale, "retained_bundle_lacks_decidable_relation");

  const missing = judgeSubjectFromRetainedBundle(
    {
      subject_id: "dot:corridor:sixth-avenue-lispenard-w14",
      source_availability: "unavailable",
      retained_bundle_refs: [],
    },
    { availability: "unavailable" },
  );
  assert.equal(missing.judgment, "source_unavailable");

  const supported = judgeSubjectFromRetainedBundle(
    {
      subject_id: "parcel:3073670011",
      source_availability: "retained",
      retained_bundle_refs: ["site_lifecycle#parcel:3073670011"],
    },
    {
      explicit_relations: [
        {
          from: "parcel:3073670011",
          to: "land:project:2020K0270",
          relation: "site_lifecycle_member",
        },
      ],
    },
  );
  assert.equal(supported.judgment, "supported");

  const frozen = freezeConnectedHistoryCohort(fixtureInputs(), {
    seed: CONNECTED_HISTORY_EVALUATION_SEED,
  });
  assert.equal(frozen.judgments.length, frozen.sample.length);
  assert.ok(frozen.judgments.every((row) => row.judged_before_tuning === true));
  assert.ok(
    frozen.judgments.every((row) =>
      ["supported", "insufficient_evidence", "source_unavailable"].includes(row.judgment)
    ),
  );
  assert.equal(frozen.baseline.phase, "pre_tuning");
  assert.equal(frozen.baseline.discovery_recall.status, "not_estimable");
});

test("A3: committed baseline rebuilds and keeps pre-tuning judgments", () => {
  assert.equal(committed.schema, CONNECTED_HISTORY_COHORT_SCHEMA);
  assert.equal(committed.seed, CONNECTED_HISTORY_EVALUATION_SEED);
  assert.equal(committed.selection_hash, committedReceipt.selection_hash);
  assert.equal(committed.sample.length, committed.judgments.length);
  assert.equal(committed.boards.length, 59);
  assert.equal(committed.denominators.registry_boards, 59);
  assert.ok(committed.denominators.boards_missing_corridor_component === 59);
  assert.ok(committed.sample.every((row) => row.confirmation_eligible === true));
  assert.ok(committed.judgments.every((row) => row.judged_before_tuning === true));
  assert.ok(
    committed.judgments.every((row) =>
      ["supported", "insufficient_evidence", "source_unavailable"].includes(row.judgment)
    ),
  );
  const demoIds = new Set(
    committed.source_versions.demo_family_exclusions.flatMap((family) => family.subject_ids),
  );
  assert.equal(demoIds.size > 0, true);
  assert.ok(committed.sample.every((row) => !demoIds.has(row.subject_id)));
  assert.equal(committed.source_versions.dot_edc_tranche.status, "unavailable");
  assert.equal(committed.baseline.phase, "pre_tuning");
});

test("selection rank is stable for seed + source-qualified id", () => {
  const left = selectionRank(CONNECTED_HISTORY_EVALUATION_SEED, "land:project:2023K0398");
  const right = selectionRank(CONNECTED_HISTORY_EVALUATION_SEED, "land:project:2023K0398");
  assert.equal(left, right);
  assert.notEqual(
    left,
    selectionRank(CONNECTED_HISTORY_EVALUATION_SEED, "land:project:2019K0147"),
  );
});
