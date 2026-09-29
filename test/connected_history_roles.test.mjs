/**
 * Fixed-dossier connected-history participant roles: time-scoped observations
 * without inventing ownership, political alignment, or formal board action.
 *
 *   node --test test/connected_history_roles.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CONNECTED_HISTORY_FORMAL_EVIDENCE_ROLES,
  CONNECTED_HISTORY_ROLE_IDS,
  CONNECTED_HISTORY_ROLE_METHOD,
  CONNECTED_HISTORY_ROLE_REJECTED_BASES,
  CONNECTED_HISTORY_ROLE_SCHEMA,
  CONNECTED_HISTORY_ROLE_VOCABULARY,
  CONNECTED_HISTORY_ROLES_ARTIFACT_SCHEMA,
  admitConnectedHistoryRole,
  projectConnectedHistoryRoles,
  roleAbsenceInference,
  rolesForSubject,
  unresolvedCompanyIdentitiesRemainDistinct,
} from "../site/connected_history_roles.mjs";
import {
  CONNECTED_HISTORY_ROLE_CANDIDATES,
  CONNECTED_HISTORY_ROLES_ARTIFACT_PATH,
  CONNECTED_HISTORY_ROLES_RECEIPT_PATH,
  buildConnectedHistoryRolesArtifact,
  connectedHistoryRolesDrift,
  materializeConnectedHistoryRoles,
  serializeConnectedHistoryRolesJson,
} from "../tools/lib/connected_history_roles.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const committed = JSON.parse(
  readFileSync(join(ROOT, "site/data/connected_history_roles.json"), "utf8"),
);
const committedReceipt = JSON.parse(
  readFileSync(
    join(
      ROOT,
      "site/data/connected_history_sources/verification_receipts/connected_history_roles_latest.json",
    ),
    "utf8",
  ),
);

const HARD_NEGATIVE_IDS = [
  "negative-lighthouse-chair-as-formal-board-action",
  "negative-dot-presentation-as-formal-board-action",
  "negative-same-applicant-spelling-beneficial-ownership",
  "negative-testimony-flags-as-resolution",
];

test("vocabulary registers the six supported history-family roles", () => {
  assert.deepEqual(
    [...CONNECTED_HISTORY_ROLE_IDS].sort(),
    [
      "applicant",
      "formal_board_action",
      "operator",
      "recorded_owner",
      "speaker",
      "sponsor",
    ],
  );
  for (const roleId of CONNECTED_HISTORY_ROLE_IDS) {
    const entry = CONNECTED_HISTORY_ROLE_VOCABULARY[roleId];
    assert.ok(entry, roleId);
    assert.equal(entry.role, roleId);
    assert.ok(entry.relation, roleId);
    assert.ok(entry.inverse, roleId);
    assert.ok(entry.required_evidence.includes("entity_qualifier"), roleId);
    assert.ok(entry.required_evidence.includes("role_date"), roleId);
    assert.ok(entry.required_evidence.includes("source_span"), roleId);
    assert.ok(entry.negative_rule, roleId);
  }
  for (const basis of [
    "same_applicant_spelling",
    "chair_quote_as_formal_board_action",
    "presentation_as_formal_board_action",
    "testimony_flags_as_resolution",
  ]) {
    assert.ok(CONNECTED_HISTORY_ROLE_REJECTED_BASES.includes(basis), basis);
  }
  assert.ok(CONNECTED_HISTORY_FORMAL_EVIDENCE_ROLES.includes("formal_vote"));
  assert.ok(CONNECTED_HISTORY_FORMAL_EVIDENCE_ROLES.includes("resolution"));
  assert.equal(CONNECTED_HISTORY_FORMAL_EVIDENCE_ROLES.includes("testimony"), false);
  assert.equal(CONNECTED_HISTORY_FORMAL_EVIDENCE_ROLES.includes("chair_statement"), false);
});

test("A1: admitted observations carry locator, qualifier, date precision, and scope", () => {
  const artifact = buildConnectedHistoryRolesArtifact();
  assert.ok(artifact.observations.length >= 4);
  // Population beside the floor: every admitted row carries all four fields.
  assert.equal(
    artifact.observations.filter(
      (row) =>
        row.source_locator?.source_span?.locator
        && row.actor?.entity_qualifier
        && row.role_date?.precision
        && Array.isArray(row.scope)
        && row.scope.length > 0,
    ).length,
    artifact.observations.length,
  );

  const byId = new Map(
    artifact.observations.map((row) => [row.candidate_id, row]),
  );

  const franklinLater = byId.get("franklin-applicant-c230356zmk");
  assert.ok(franklinLater);
  assert.equal(franklinLater.role, "applicant");
  assert.equal(franklinLater.schema, CONNECTED_HISTORY_ROLE_SCHEMA);
  assert.equal(franklinLater.method, CONNECTED_HISTORY_ROLE_METHOD);
  assert.equal(
    franklinLater.actor.entity_qualifier,
    "zap:application:C230356ZMK#primary_applicant",
  );
  assert.equal(franklinLater.role_date.precision, "year");
  assert.equal(franklinLater.role_date.value, "2024");
  assert.ok(franklinLater.source_locator.source_span.quote);
  assert.ok(franklinLater.scope.includes("franklin-avenue"));
  assert.equal(franklinLater.beneficial_ownership, false);
  assert.equal(franklinLater.envelope, "civic_institution_role_edge");

  const speaker = byId.get("lighthouse-cb1-chair-speaker");
  assert.equal(speaker.role, "speaker");
  assert.equal(speaker.role_date.precision, "day");
  assert.equal(speaker.formal_board_endorsement, false);
  assert.equal(speaker.chair_statement, true);

  const operator = byId.get("lighthouse-edc-operator-lease");
  assert.equal(operator.role, "operator");
  assert.equal(operator.role_date.value, "2014");
  assert.ok(operator.scope.includes("lighthouse-point"));

  // Coverage reports unsupported strata instead of inventing examples.
  assert.ok(artifact.missing_strata.includes("sponsor"));
  assert.ok(artifact.missing_strata.includes("recorded_owner"));
  assert.ok(artifact.missing_strata.includes("formal_board_action"));
  assert.equal(artifact.role_coverage.applicant.status, "observed");
  assert.equal(artifact.role_coverage.speaker.status, "observed");
  assert.equal(artifact.role_coverage.operator.status, "observed");
  assert.equal(artifact.role_coverage.sponsor.status, "absent");

  // Positive control: admission gate requires scope (not only observation).
  for (const roleId of CONNECTED_HISTORY_ROLE_IDS) {
    assert.ok(
      CONNECTED_HISTORY_ROLE_VOCABULARY[roleId].required_evidence.includes("scope"),
      roleId,
    );
  }
});

test("A1/A3: role changes keep dated applicant observations distinct", () => {
  const artifact = buildConnectedHistoryRolesArtifact();
  const franklins = artifact.observations
    .filter((row) => row.family_id === "franklin-avenue" && row.role === "applicant")
    .sort((left, right) => left.role_date.value.localeCompare(right.role_date.value));
  assert.equal(franklins.length, 2);
  assert.equal(franklins[0].subject, "land:application:C200184ZMK");
  assert.equal(franklins[0].role_date.value, "2021");
  assert.equal(franklins[1].subject, "land:application:C230356ZMK");
  assert.equal(franklins[1].role_date.value, "2024");
  assert.notEqual(
    franklins[0].actor.entity_qualifier,
    franklins[1].actor.entity_qualifier,
  );
  assert.equal(franklins[0].actor.spelling, franklins[1].actor.spelling);

  // Intermediate-state ordering: earlier role_date precedes later.
  assert.ok(franklins[0].role_date.value < franklins[1].role_date.value);
  // Converse control: reversing dates would change observed order.
  const reversed = [...franklins].sort((left, right) =>
    right.role_date.value.localeCompare(left.role_date.value),
  );
  assert.equal(reversed[0].role_date.value, "2024");
  assert.notEqual(reversed[0].candidate_id, franklins[0].candidate_id);
});

test("A2: chair quotation stays speaker; presentation and testimony never become formal action", () => {
  const artifact = buildConnectedHistoryRolesArtifact();
  const rejectedIds = new Set(artifact.rejections.map((row) => row.candidate_id));
  for (const id of HARD_NEGATIVE_IDS) {
    assert.ok(rejectedIds.has(id), id);
  }

  const byId = new Map(artifact.rejections.map((row) => [row.candidate_id, row]));
  assert.match(
    byId.get("negative-lighthouse-chair-as-formal-board-action").reason,
    /chair_quote_as_formal_board_action|forbidden_formal_upgrade/,
  );
  assert.match(
    byId.get("negative-dot-presentation-as-formal-board-action").reason,
    /presentation_as_formal_board_action|forbidden_formal_upgrade/,
  );
  assert.match(
    byId.get("negative-same-applicant-spelling-beneficial-ownership").reason,
    /same_applicant_spelling/,
  );
  assert.match(
    byId.get("negative-testimony-flags-as-resolution").reason,
    /testimony_flags_as_resolution|forbidden_formal_upgrade|formal_evidence_role_rejected/,
  );

  const admittedIds = new Set(
    artifact.observations.map((row) => row.candidate_id).filter(Boolean),
  );
  for (const id of HARD_NEGATIVE_IDS) {
    assert.equal(admittedIds.has(id), false, id);
  }

  const speaker = artifact.observations.find(
    (row) => row.candidate_id === "lighthouse-cb1-chair-speaker",
  );
  assert.equal(speaker.role, "speaker");
  assert.equal(speaker.formal_board_endorsement, false);

  // Positive control: ownership from an applicant-label locator stays rejected
  // even after the self-declared basis field is removed.
  const ownershipNeg = CONNECTED_HISTORY_ROLE_CANDIDATES.find(
    (row) => row.candidate_id === "negative-same-applicant-spelling-beneficial-ownership",
  );
  assert.ok(ownershipNeg);
  const { basis: _basis, ...withoutBasis } = ownershipNeg;
  const stripped = admitConnectedHistoryRole(withoutBasis);
  assert.equal(stripped.admitted, false);
  assert.match(stripped.reason, /applicant_label_as_ownership|same_applicant_spelling/);
  assert.ok(CONNECTED_HISTORY_ROLE_REJECTED_BASES.includes("applicant_label_as_ownership"));
});

test("A3: unresolved company identity stays distinct under shared spelling", () => {
  const artifact = buildConnectedHistoryRolesArtifact();
  const franklins = artifact.observations.filter((row) => row.role === "applicant");
  // Population beside the floor: two dated applicants share spelling.
  assert.equal(franklins.length, 2);
  for (const row of franklins) {
    assert.equal(row.actor.identity_status, "source_qualified");
    assert.equal(row.linking, false);
    assert.equal(row.beneficial_ownership, false);
  }

  const partialCollapse = [
    {
      ...franklins[0],
      actor: { ...franklins[0].actor, entity_id: "collapsed-company-id" },
    },
    {
      ...franklins[1],
      actor: { ...franklins[1].actor, entity_id: "collapsed-company-id" },
    },
  ];

  const totalCollapse = [
    {
      ...franklins[0],
      actor: {
        ...franklins[0].actor,
        entity_id: "merged-company-id",
        entity_qualifier: "merged-source-qualifier",
      },
    },
    {
      ...franklins[1],
      actor: {
        ...franklins[1].actor,
        entity_id: "merged-company-id",
        entity_qualifier: "merged-source-qualifier",
      },
    },
  ];

  const oneActorTwoSubjects = [
    franklins[0],
    {
      ...franklins[0],
      candidate_id: "same-actor-second-subject",
      subject: franklins[1].subject,
      to: franklins[1].subject,
    },
  ];

  // Property: distinct source-qualified identity evidence under one spelling
  // must retain distinct actor identity. Multiple subjects alone do not imply
  // collapse because one evidenced actor may legitimately hold two role edges.
  const controls = [
    {
      name: "distinct identities",
      observations: franklins,
      entityIds: 2,
      qualifiers: 2,
      sourceIdentities: 2,
      subjects: 2,
      expected: true,
    },
    {
      name: "partial collapse",
      observations: partialCollapse,
      entityIds: 1,
      qualifiers: 2,
      sourceIdentities: 2,
      subjects: 2,
      expected: false,
    },
    {
      name: "total collapse",
      observations: totalCollapse,
      entityIds: 1,
      qualifiers: 1,
      sourceIdentities: 2,
      subjects: 2,
      expected: false,
    },
    {
      name: "one actor in two subjects",
      observations: oneActorTwoSubjects,
      entityIds: 1,
      qualifiers: 1,
      sourceIdentities: 1,
      subjects: 2,
      expected: true,
    },
  ];

  for (const control of controls) {
    assert.equal(control.observations.length, 2, `${control.name}: population`);
    assert.equal(
      new Set(control.observations.map((row) => row.actor.entity_id)).size,
      control.entityIds,
      `${control.name}: actor ids`,
    );
    assert.equal(
      new Set(control.observations.map((row) => row.actor.entity_qualifier)).size,
      control.qualifiers,
      `${control.name}: actor qualifiers`,
    );
    assert.equal(
      new Set(control.observations.map((row) => [
        row.source_locator.source_system,
        row.source_locator.source_record_id,
        row.source_locator.source_span.locator,
      ].join("\0"))).size,
      control.sourceIdentities,
      `${control.name}: source identities`,
    );
    assert.equal(
      new Set(control.observations.map((row) => row.subject)).size,
      control.subjects,
      `${control.name}: subjects`,
    );
    assert.equal(
      unresolvedCompanyIdentitiesRemainDistinct(control.observations),
      control.expected,
      `${control.name}: guard outcome`,
    );
  }

  // Positive control — resolved after total merge: a resolved identity claimed
  // once ids are already merged still flips the guard.
  const totalResolved = [
    {
      ...totalCollapse[0],
      actor: { ...totalCollapse[0].actor, identity_status: "resolved" },
      linking: true,
    },
    totalCollapse[1],
  ];
  assert.equal(new Set(totalResolved.map((row) => row.actor.entity_id)).size, 1);
  assert.equal(new Set(totalResolved.map((row) => row.subject)).size, 2);
  assert.equal(
    totalResolved.some((row) => row.actor.identity_status === "resolved"),
    true,
  );
  assert.equal(unresolvedCompanyIdentitiesRemainDistinct(totalResolved), false);

  // Positive control — partial resolved: claiming resolved while distinct
  // entity ids still share the spelling flips the guard.
  assert.equal(
    unresolvedCompanyIdentitiesRemainDistinct([
      {
        ...franklins[0],
        actor: { ...franklins[0].actor, identity_status: "resolved" },
        linking: true,
      },
      franklins[1],
    ]),
    false,
  );

  // Positive control: a beneficial_ownership flag flips the guard.
  assert.equal(
    unresolvedCompanyIdentitiesRemainDistinct([
      { ...franklins[0], beneficial_ownership: true },
    ]),
    false,
  );
});

test("A3: formal-vote admission works only through the board-document evidence gate", () => {
  const admitted = admitConnectedHistoryRole({
    role: "formal_board_action",
    formal_evidence_role: "formal_vote",
    entity_id: "source_qualified:brooklyn-cb-15:formal-vote:fixture",
    entity_qualifier: "brooklyn-cb-15:minutes-fixture#formal_vote",
    subject: "bsa:case:2025-54-A",
    source_system: "community-board-minutes",
    source_record_id: "brooklyn-cb-15:formal-vote-fixture",
    source_span: {
      locator: "minutes_formal_vote",
      quote: "The board voted",
    },
    role_date: { value: "2026-02-24", precision: "day" },
    scope: ["brooklyn-cb-15", "formal-vote-fixture"],
    observed_time: "2026-09-26T00:00:00.000Z",
  });
  assert.equal(admitted.admitted, true);
  assert.equal(admitted.observation.role, "formal_board_action");
  assert.equal(admitted.observation.formal_evidence_role, "formal_vote");
  assert.equal(admitted.observation.formal_board_endorsement, true);
  assert.ok(admitted.observation.scope.includes("brooklyn-cb-15"));

  // Converse / positive controls for the gate.
  const chairUpgrade = admitConnectedHistoryRole({
    role: "formal_board_action",
    claimed_as: "chair_statement",
    formal_evidence_role: "formal_vote",
    entity_id: "source_qualified:edc:press-release:lighthouse-point-opening:cb1-chair",
    entity_qualifier: "edc:press-release:lighthouse-point-opening-2025-06-05#cb1-chair",
    subject: "edc:project:lighthouse-point",
    source_system: "edc-press-release",
    source_record_id: "edc:press-release:lighthouse-point-opening-2025-06-05",
    source_span: {
      locator: "opening_announcement_chair_quotation",
      quote: "quoted community board chair statement",
    },
    role_date: { value: "2025-06-05", precision: "day" },
    scope: ["lighthouse-point"],
    observed_time: "2026-09-26T00:00:00.000Z",
  });
  assert.equal(chairUpgrade.admitted, false);
  assert.match(chairUpgrade.reason, /forbidden_formal_upgrade:chair_statement/);

  const testimonyFlags = admitConnectedHistoryRole({
    role: "formal_board_action",
    claimed_as: "testimony",
    formal_evidence_role: "testimony",
    formal_evidence: true,
    board_action: true,
    formal_stance: "support",
    entity_id: "source_qualified:brooklyn-cb-15:testimony:coyle",
    entity_qualifier: "brooklyn-cb-15:Agenda-4-28-26.pdf#testimony",
    subject: "bsa:case:2025-54-A",
    source_system: "community-board-agenda",
    source_record_id: "brooklyn-cb-15:Agenda-4-28-26.pdf",
    source_span: { locator: "agenda_public_testimony_item", quote: "2025-54-A" },
    role_date: { value: "2026-04-28", precision: "day" },
    scope: ["coyle"],
    observed_time: "2026-09-26T00:00:00.000Z",
  });
  assert.equal(testimonyFlags.admitted, false);

  const presentation = admitConnectedHistoryRole({
    role: "formal_board_action",
    claimed_as: "presentation",
    entity_id: "source_qualified:dot:corridor:sixth-avenue:presenter",
    entity_qualifier: "dot:heading:sixth-avenue-watts-w59#presentation",
    subject: "dot:corridor:sixth-avenue-watts-w59",
    source_system: "dot-current-projects",
    source_record_id: "dot:heading:sixth-avenue-watts-w59",
    source_span: {
      locator: "dot_current_projects_june_2026_attachment",
      quote: "June 2026 CB2/CB4/CB5",
    },
    role_date: { value: "2026-06", precision: "month" },
    scope: ["sixth-avenue"],
    observed_time: "2026-09-26T00:00:00.000Z",
  });
  assert.equal(presentation.admitted, false);
});

test("A3: absence of a role does not produce an adverse inference", () => {
  const artifact = buildConnectedHistoryRolesArtifact();
  const absentSponsor = roleAbsenceInference(artifact, {
    subject: "edc:project:lighthouse-point",
    role: "sponsor",
  });
  assert.equal(absentSponsor.status, "absent");
  assert.equal(absentSponsor.observed, false);
  assert.equal(absentSponsor.adverse_inference, false);
  assert.match(absentSponsor.note, /not evidence against/);

  const absentOwner = roleAbsenceInference(artifact, {
    subject: "land:application:C230356ZMK",
    role: "recorded_owner",
  });
  assert.equal(absentOwner.adverse_inference, false);
  assert.equal(absentOwner.observed, false);

  const observedApplicant = roleAbsenceInference(artifact, {
    subject: "land:application:C230356ZMK",
    role: "applicant",
  });
  assert.equal(observedApplicant.status, "observed");
  assert.equal(observedApplicant.adverse_inference, false);
  assert.ok(observedApplicant.count >= 1);

  // Positive control: helper never invents opposition from absence.
  assert.equal("stance" in absentSponsor, false);
  assert.equal("opposition" in absentSponsor, false);
});

test("A3: incomplete evidence fails with positive controls", () => {
  const base = {
    role: "applicant",
    entity_id: "source_qualified:zap:application:C230356ZMK:primary_applicant",
    entity_qualifier: "zap:application:C230356ZMK#primary_applicant",
    subject: "land:application:C230356ZMK",
    source_system: "zap-project-action-report",
    source_record_id: "zap:document:230356-official-report",
    source_span: {
      locator: "official_report_later_application_applicant",
      quote: "C230356ZMK",
    },
    role_date: { value: "2024", precision: "year" },
    scope: ["franklin-avenue", "brooklyn-1192"],
    observed_time: "2026-09-26T00:00:00.000Z",
  };

  assert.equal(admitConnectedHistoryRole(base).admitted, true);
  assert.equal(
    admitConnectedHistoryRole({ ...base, source_span: { locator: "x", quote: "" } }).admitted,
    false,
  );
  assert.equal(
    admitConnectedHistoryRole({ ...base, role_date: null }).reason,
    "missing_role_date",
  );
  assert.equal(
    admitConnectedHistoryRole({ ...base, entity_qualifier: "" }).reason,
    "missing_entity_qualifier",
  );
  assert.equal(
    admitConnectedHistoryRole({ ...base, subject: "" }).reason,
    "missing_subject",
  );
  // Positive control: omitting scope flips the admission gate.
  const { scope: _scope, ...withoutScope } = base;
  assert.equal(admitConnectedHistoryRole(withoutScope).reason, "missing_scope");
  assert.equal(admitConnectedHistoryRole({ ...base, scope: [] }).reason, "missing_scope");
  assert.equal(admitConnectedHistoryRole({ ...base, scope: null }).reason, "missing_scope");
});

test("A4: candidates are exactly the fixed dossier set; missing strata stay reportable", () => {
  const ids = CONNECTED_HISTORY_ROLE_CANDIDATES.map((row) => row.candidate_id).sort();
  assert.equal(
    CONNECTED_HISTORY_ROLE_CANDIDATES.length,
    new Set(ids).size,
    "candidate ids must be unique",
  );

  const artifact = buildConnectedHistoryRolesArtifact();
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
  assert.ok(artifact.missing_strata.includes("sponsor"));
  assert.ok(artifact.boundaries.absence_is_not_adverse_inference);

  // Dropping one positive candidate reduces admitted count rather than backfilling.
  const withoutFranklin = CONNECTED_HISTORY_ROLE_CANDIDATES.filter(
    (row) => row.candidate_id !== "franklin-applicant-c230356zmk",
  );
  const reduced = projectConnectedHistoryRoles(withoutFranklin);
  const full = projectConnectedHistoryRoles(CONNECTED_HISTORY_ROLE_CANDIDATES);
  assert.equal(reduced.counts.admitted, full.counts.admitted - 1);
  assert.equal(
    reduced.observations.some(
      (row) => row.candidate_id === "franklin-applicant-c230356zmk",
    ),
    false,
  );

  const lighthouseRoles = rolesForSubject(artifact, "edc:project:lighthouse-point");
  assert.ok(lighthouseRoles.some((row) => row.role === "speaker"));
  assert.ok(lighthouseRoles.some((row) => row.role === "operator"));
});

test("committed artifact and receipt match a fresh materialization", () => {
  const { artifact, receipt } = materializeConnectedHistoryRoles();
  assert.equal(committed.schema, CONNECTED_HISTORY_ROLES_ARTIFACT_SCHEMA);
  assert.equal(committed.selection_hash, artifact.selection_hash);
  assert.equal(committed.counts.admitted, artifact.counts.admitted);
  assert.equal(committed.counts.rejected, artifact.counts.rejected);
  assert.deepEqual(committed.missing_strata, artifact.missing_strata);
  assert.equal(committedReceipt.selection_hash, receipt.selection_hash);
  assert.equal(committedReceipt.artifact, "site/data/connected_history_roles.json");
});

const committedArtifactText = readFileSync(join(ROOT, CONNECTED_HISTORY_ROLES_ARTIFACT_PATH), "utf8");
const committedReceiptText = readFileSync(join(ROOT, CONNECTED_HISTORY_ROLES_RECEIPT_PATH), "utf8");

/** Replace the byte at `index` with a different printable byte. */
function flipByte(text, index) {
  const bytes = Buffer.from(text, "utf8");
  bytes[index] = bytes[index] === 0x20 ? 0x21 : 0x20;
  return bytes.toString("utf8");
}

test("committed artifact and receipt are byte-identical to a fresh materialization", () => {
  const findings = connectedHistoryRolesDrift({
    artifactText: committedArtifactText,
    receiptText: committedReceiptText,
  });
  assert.deepEqual(findings, [], "rebuild with node tools/build_connected_history_roles.mjs");
});

test("the byte-exact guard catches drift that equal summaries hide", () => {
  const fresh = materializeConnectedHistoryRoles();
  // A lagging artifact of the shape once committed: one rejected basis missing
  // and the scope field serialized in a different position. Selection hash,
  // counts and missing strata are unchanged, so a summary comparison passes.
  const lagging = structuredClone(fresh.artifact);
  lagging.rejected_bases = lagging.rejected_bases.filter((basis) => basis !== "applicant_label_as_ownership");
  lagging.observations = lagging.observations.map(({ scope, family_id: familyId, candidate_id: candidateId, ...rest }) => ({
    ...rest,
    family_id: familyId,
    candidate_id: candidateId,
    scope,
  }));
  assert.equal(lagging.rejected_bases.length, fresh.artifact.rejected_bases.length - 1);
  assert.equal(lagging.schema, fresh.artifact.schema);
  assert.equal(lagging.selection_hash, fresh.artifact.selection_hash);
  assert.deepEqual(lagging.counts, fresh.artifact.counts);
  assert.deepEqual(lagging.missing_strata, fresh.artifact.missing_strata);

  const findings = connectedHistoryRolesDrift({
    artifactText: serializeConnectedHistoryRolesJson(lagging),
    receiptText: serializeConnectedHistoryRolesJson(fresh.receipt),
  }, fresh);
  assert.deepEqual(findings.map((finding) => finding.path), [CONNECTED_HISTORY_ROLES_ARTIFACT_PATH]);
  assert.notEqual(findings[0].committed_sha256, findings[0].materialized_sha256);
  assert.ok(findings[0].first_difference_at >= 0);
});

test("a one-byte change to the committed artifact or receipt fails the byte-exact guard", () => {
  const fresh = materializeConnectedHistoryRoles();
  const current = { artifactText: committedArtifactText, receiptText: committedReceiptText };
  assert.deepEqual(connectedHistoryRolesDrift(current, fresh), [], "the unmutated tree is current");

  for (const [field, path] of [
    ["artifactText", CONNECTED_HISTORY_ROLES_ARTIFACT_PATH],
    ["receiptText", CONNECTED_HISTORY_ROLES_RECEIPT_PATH],
  ]) {
    const text = current[field];
    for (const index of [0, Math.floor(text.length / 2), text.length - 1]) {
      const mutated = { ...current, [field]: flipByte(text, index) };
      assert.equal(Buffer.byteLength(mutated[field]), Buffer.byteLength(text), `${path}@${index}: same length`);
      const findings = connectedHistoryRolesDrift(mutated, fresh);
      assert.deepEqual(findings.map((finding) => finding.path), [path], `${path}@${index}`);
      assert.equal(findings[0].first_difference_at, index, `${path}@${index}: located`);
    }
    // A missing trailing newline or a missing file is drift, not a pass.
    assert.deepEqual(
      connectedHistoryRolesDrift({ ...current, [field]: text.slice(0, -1) }, fresh).map((finding) => finding.path),
      [path],
    );
    assert.deepEqual(
      connectedHistoryRolesDrift({ ...current, [field]: null }, fresh).map((finding) => finding.path),
      [path],
    );
  }
});
