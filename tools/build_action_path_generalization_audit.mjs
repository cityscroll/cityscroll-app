#!/usr/bin/env node
/**
 * Materialize the CAP-7 Action Path generalization audit from retained fixtures.
 *
 * Usage:
 *   node tools/build_action_path_generalization_audit.mjs
 *   node tools/build_action_path_generalization_audit.mjs --check
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildActionPath } from "../site/action_path_v0.mjs";
import {
  COMMUNITY_BOARD_PARTICIPATION_PATH_KINDS,
  communityBoardParticipationPaths,
} from "../site/community_board_participation.mjs";
import { projectCouncilHearingMatterContinuation } from "../site/council_hearing_matter_continuation.mjs";
import { DISPOSITION_STAGES } from "../worker/src/lib/property_disposition_spine.mjs";
import { compileActionRail } from "../worker/src/lib/action_registry.mjs";
import { LENSES } from "../worker/src/lib/filter.mjs";
import { continuationReplayForSubject } from "../worker/src/lib/continuation_replay.mjs";
import {
  EXACT_REPLAY_FAMILY,
  assembleActionPathGeneralizationAudit,
  assertActionPathGeneralizationContract,
  measureDotBicycleRacksCanary,
  renderActionPathGeneralizationMarkdown,
  stableStringify,
} from "./lib/action_path_generalization_audit.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const AUDIT_JSON = "docs/evidence/civic-action-paths/generalization-audit.json";
export const AUDIT_MD = "docs/evidence/civic-action-paths/generalization-audit.md";

const DOT_SUBJECT = "rulemaking:dot:bicycle-owned-racks";
const DOT_NOTICE_IDS = ["20260317026", "20260706041"];

function parseArgs(argv) {
  const out = { check: false };
  for (const arg of argv.slice(2)) {
    if (arg === "--check") out.check = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

function uniqueTypes(actions) {
  return [...new Set((actions || []).map((action) => action.type).filter(Boolean))];
}

function evidence(...rows) {
  return rows;
}

function councilRecord(requestId, outcome) {
  return {
    source_system: "city_record",
    meeting_id: `meeting:city_record:${requestId}`,
    request_id: requestId,
    meeting_outcome: outcome,
  };
}

function dotCandidate(originRef) {
  return {
    kind: "subject",
    subject_ref: DOT_SUBJECT,
    replayable: true,
    subject_exists: true,
    relation: {
      status: "accepted",
      method: "exact_notice_membership",
      from: originRef,
      to: DOT_SUBJECT,
      member_refs: DOT_NOTICE_IDS.map((id) => `notice:${id}`),
    },
    scope: {
      schema: "cityscroll.scope",
      version: 0,
      facets: {
        domains: ["rules"],
        agencies: ["Transportation"],
        values: { request_ids: DOT_NOTICE_IDS },
      },
    },
    replay_proof: {
      following: { subject_ref: DOT_SUBJECT },
      delivery: {
        soda_subject_refs: [DOT_SUBJECT],
        d1_subject_refs: [DOT_SUBJECT],
      },
    },
  };
}

function matterReplayProbe() {
  return continuationReplayForSubject("meeting:city_record:20260707022", {
    kind: "subject",
    subject_ref: "matter:79200",
    replayable: true,
    subject_exists: true,
    relation: {
      status: "accepted",
      method: "strict",
      from: "meeting:city_record:20260707022",
      to: "matter:79200",
    },
    scope: {
      schema: "cityscroll.scope",
      version: 0,
      facets: { domains: ["meetings"] },
    },
    replay_proof: {
      following: { subject_ref: "matter:79200" },
      delivery: { soda_subject_refs: ["matter:79200"], d1_subject_refs: ["matter:79200"] },
    },
  });
}

export function collectActionPathGeneralizationProbes(root = ROOT) {
  const fixtures = JSON.parse(readFileSync(path.join(root, "test/fixtures/action_path_v0.json"), "utf8"));
  const snapshot = JSON.parse(readFileSync(path.join(root, "site/data/meeting_outcomes_snapshot.json"), "utf8"));
  const feedActions = readFileSync(path.join(root, "site/app/feed-actions.mjs"), "utf8");
  const participationSrc = readFileSync(path.join(root, "site/community_board_participation.mjs"), "utf8");

  const hearingActions = uniqueTypes(compileActionRail({
    kind: "hearing",
    deadline: "2026-08-10T14:30:00.000",
    participation_url: "https://www.nyc.gov/site/mocs/opportunities/franchises-concessions.page",
    official_notice_url: "https://a856-cityrecord.nyc.gov/RequestDetail/20260707022",
  }, { today: "2026-08-01" }));
  const moneyActions = uniqueTypes(compileActionRail({
    kind: "solicitation",
    lifecycle_stage: "open",
    deadline: "2026-09-30",
    official_application_url: "https://passport.cityofnewyork.us/page.aspx/en/rfp/request_browse_public",
    official_notice_url: "https://a856-cityrecord.nyc.gov/RequestDetail/2141200",
  }, { today: "2026-08-01" }));
  const examActions = uniqueTypes(compileActionRail({
    kind: "exam",
    lifecycle_stage: "open",
    deadline: "2026-08-20",
    exam_number: "7016",
    official_application_url: "https://a856-exams.nyc.gov/OASysWeb/noe?examId=9629",
  }, { today: "2026-08-01" }));
  const landActions = uniqueTypes(compileActionRail({
    kind: "zoning",
    public_status: "In Public Review",
    deadline: "2026-08-20T18:30:00.000",
    official_notice_url: "https://a856-cityrecord.nyc.gov/RequestDetail/20230912001",
  }, { today: "2026-08-01" }));
  const propertyActions = uniqueTypes(compileActionRail({
    kind: "property",
    section_name: "Property Disposition",
    deadline: "2026-08-20",
    official_notice_url: "https://a856-cityrecord.nyc.gov/RequestDetail/20150421106",
  }, { today: "2026-08-01" }));

  const single = projectCouncilHearingMatterContinuation(
    councilRecord("20260707022", snapshot.by_notice["20260707022"]),
  );
  const multiple = projectCouncilHearingMatterContinuation(
    councilRecord("20260707021", snapshot.by_notice["20260707021"]),
  );
  const unmatched = projectCouncilHearingMatterContinuation(
    councilRecord("20260728026", snapshot.by_notice["20260728026"]),
  );

  const snapshotInputs = fixtures.dot_bicycle_racks;
  const paths = Object.fromEntries(Object.entries(snapshotInputs).map(([key, input]) => [key, buildActionPath(input)]));
  const replayBySnapshot = Object.fromEntries(Object.entries(snapshotInputs).map(([key, input]) => {
    const origin = `notice:${String(input.subject_ref).replace(/^notice:/, "")}`;
    return [key, continuationReplayForSubject(origin, dotCandidate(origin))];
  }));
  const dotCanary = measureDotBicycleRacksCanary(
    Object.fromEntries(Object.entries(snapshotInputs).map(([key, input]) => [key, {
      ...input,
      path: paths[key],
    }])),
    replayBySnapshot,
  );

  const boardPaths = communityBoardParticipationPaths({
    board_id: "manhattan-cb-06",
    board: { body_id: "manhattan-cb-06", homepage_url: "https://cbsix.org/" },
  });
  const landHashContinuation = /href:`#land\/\$\{encodeURIComponent\(projectId\)\}`/.test(feedActions);
  const committeeOmitted = /Follow committee remains omitted/.test(participationSrc);

  return {
    exact_replay_family: EXACT_REPLAY_FAMILY,
    dotCanary,
    meetings: {
      action_types: hearingActions,
      action_evidence: evidence(
        { kind: "source", ref: "docs/evidence/civic-action-paths/before/characterization-receipt.md", locator: "Meeting action rail" },
        { kind: "test", ref: "test/action-rail.test.mjs", locator: "open rule comments and upcoming hearings use their joined deadlines and handoffs" },
      ),
      single_continuation: single.state === "single" && single.matters[0]?.subject_ref === "matter:79200",
      single_subject_ref: single.matters[0]?.subject_ref || null,
      multiple_cta: multiple.state === "multiple" && multiple.matters.length > 1,
      unmatched_cta: unmatched.state === "unmatched" || unmatched.state === "none",
      continuation_evidence: evidence(
        { kind: "fixture", ref: "site/data/meeting_outcomes_snapshot.json", locator: "by_notice.20260707022 / 20260707021 / 20260728026" },
        { kind: "test", ref: "test/council_hearing_matter_continuation.test.mjs" },
      ),
      join_method: single.join_method || "exact_date_body_tokens",
      canaries: ["20260707022", "20260707021", "20260728026"],
      grounding_evidence: evidence(
        { kind: "source", ref: "site/council_hearing_matter_continuation.mjs", locator: "STRICT_COUNCIL_MEETING_JOIN_METHOD" },
        { kind: "fixture", ref: "site/data/meeting_outcomes_snapshot.json" },
      ),
      exact_replay: matterReplayProbe() != null,
      replay_evidence: evidence(
        { kind: "test", ref: "worker/test/continuation_replay.test.mjs", locator: "matter continuation remains absent until an exact relation compiler exists" },
        { kind: "source", ref: "worker/src/lib/continuation_replay.mjs", locator: EXACT_REPLAY_FAMILY },
      ),
      card_evidence: evidence(
        { kind: "source", ref: "site/council_hearing_action_path.mjs" },
        { kind: "test", ref: "test/civic_outcome_transition.test.mjs" },
      ),
    },
    rules: {
      action_evidence: evidence(
        { kind: "fixture", ref: "test/fixtures/action_path_v0.json", locator: "dot_bicycle_racks.t1_before_hearing" },
        { kind: "test", ref: "test/action_path_v0.test.mjs", locator: "DOT City-Owned Bicycle Racks keeps one rulemaking subject" },
      ),
      continuation_evidence: evidence(
        { kind: "fixture", ref: "test/fixtures/action_path_v0.json", locator: "dot_bicycle_racks T1/T2/T3" },
        { kind: "receipt", ref: "site/data/rules_sources/verification_receipts/rulemaking_sibling_stitch_2026-08-02.json" },
      ),
      grounding_evidence: evidence(
        { kind: "source", ref: "https://a856-cityrecord.nyc.gov/RequestDetail/20260317026" },
        { kind: "source", ref: "https://a856-cityrecord.nyc.gov/RequestDetail/20260706041" },
        { kind: "fixture", ref: "test/fixtures/action_path_v0.json" },
      ),
      replay_evidence: evidence(
        { kind: "test", ref: "worker/test/continuation_replay.test.mjs", locator: "DOT canary T1 through T3" },
        { kind: "source", ref: "worker/src/lib/filter.mjs", locator: "LENSES.rules request_ids" },
      ),
      card_evidence: evidence(
        { kind: "test", ref: "test/civic_outcome_transition.test.mjs", locator: "DOT adoption and effectiveness" },
        { kind: "source", ref: "site/civic_outcome_transition.mjs" },
      ),
    },
    land: {
      action_types: landActions,
      action_evidence: evidence(
        { kind: "test", ref: "test/land_action_rail.test.mjs" },
        { kind: "source", ref: "docs/evidence/civic-action-paths/before/characterization-receipt.md", locator: "zoning / land use rail" },
      ),
      document_continuation: landHashContinuation,
      href_kind: landHashContinuation ? "hash_document" : "unknown",
      continuation_evidence: evidence(
        { kind: "source", ref: "site/app/feed-actions.mjs", locator: "exactLandActionPath" },
        { kind: "test", ref: "test/notice_land_spine.test.mjs", locator: "Timbale Terrace 20230912001" },
      ),
      grounded_project_id: "2022M0258",
      grounded_notice_id: "20230912001",
      grounding_evidence: evidence(
        { kind: "test", ref: "test/notice_land_spine.test.mjs", locator: "notice 20230912001 → project 2022M0258" },
        { kind: "source", ref: "site/notice_land_spine.mjs" },
      ),
      exact_replay: false,
      replay_evidence: evidence(
        { kind: "source", ref: "worker/src/lib/filter.mjs", locator: `LENSES.land=${JSON.stringify(LENSES.land)}` },
        { kind: "source", ref: "worker/src/lib/continuation_replay.mjs", locator: EXACT_REPLAY_FAMILY },
      ),
      card_evidence: evidence(
        { kind: "source", ref: "site/app/feed-actions.mjs", locator: "hash document destination is not Following replay" },
      ),
    },
    money: {
      action_types: moneyActions,
      action_evidence: evidence(
        { kind: "fixture", ref: "test/fixtures/wave4/action-fixtures.json" },
        { kind: "test", ref: "test/action-rail.test.mjs", locator: "open solicitations compile a searchable handoff" },
      ),
      action_path_adapter: false,
      continuation_evidence: evidence(
        { kind: "source", ref: "site/app/feed-actions.mjs", locator: "no exactMoneyActionPath" },
        { kind: "test", ref: "test/action-rail.test.mjs" },
      ),
      procurement_id_supported: LENSES.money.includes("procurement_id"),
      grounding_evidence: evidence(
        { kind: "source", ref: "worker/src/lib/filter.mjs", locator: "LENSES.money procurement_id" },
        { kind: "source", ref: "worker/src/lib/compile.mjs", locator: "procurementId branch" },
      ),
      exact_replay: false,
      replay_evidence: evidence(
        { kind: "source", ref: "worker/src/lib/continuation_replay.mjs", locator: EXACT_REPLAY_FAMILY },
        { kind: "test", ref: "worker/test/continuation_replay.test.mjs" },
      ),
      card_evidence: evidence(
        { kind: "source", ref: "worker/src/lib/compile.mjs", locator: "procurement_id compile support is not an Action Path continuation family" },
      ),
    },
    staffing: {
      action_types: examActions,
      action_evidence: evidence(
        { kind: "test", ref: "test/action-rail.test.mjs", locator: "exam apply prefers a non-landing official_application_url" },
        { kind: "fixture", ref: "test/fixtures/exam_process_spine/field_cases.json" },
      ),
      action_path_adapter: false,
      continuation_evidence: evidence(
        { kind: "source", ref: "site/app/feed-actions.mjs", locator: "no exactExamActionPath" },
        { kind: "test", ref: "test/exam_process_spine.test.mjs" },
      ),
      exam_number: "7016",
      grounding_evidence: evidence(
        { kind: "test", ref: "test/action-rail.test.mjs", locator: "exam 7016" },
        { kind: "source", ref: "site/exam_process_spine.mjs" },
      ),
      exact_replay: false,
      replay_evidence: evidence(
        { kind: "source", ref: "worker/src/lib/filter.mjs", locator: `LENSES.people examNumber` },
        { kind: "source", ref: "worker/src/lib/continuation_replay.mjs", locator: EXACT_REPLAY_FAMILY },
      ),
      card_evidence: evidence(
        { kind: "test", ref: "test/exam_process_spine.test.mjs" },
      ),
    },
    community_boards: {
      path_kinds: [...COMMUNITY_BOARD_PARTICIPATION_PATH_KINDS],
      follow_board: boardPaths.some((row) => row.kind === "follow_board"),
      follow_committee: boardPaths.some((row) => row.kind === "follow_committee"),
      board_watch: true,
      board_watch_ref: "community-board:manhattan-cb-06",
      committee_replay: false,
      cross_board_inference: false,
      action_evidence: evidence(
        { kind: "test", ref: "test/community_board_participation.test.mjs" },
        { kind: "receipt", ref: "docs/evidence/civic-action-paths/after/ways-to-participate-capture.json" },
      ),
      continuation_evidence: evidence(
        { kind: "source", ref: "site/community_board_participation.mjs", locator: "boardWatch + follow_committee omitted" },
        { kind: "test", ref: "test/community_board_participation.test.mjs" },
      ),
      grounding_evidence: evidence(
        { kind: "fixture", ref: "site/data/community_board_bylaws.json", locator: "manhattan-cb-06 / manhattan-cb-02" },
        { kind: "test", ref: "test/community_board_participation.test.mjs", locator: "cross_board_inference remains false" },
      ),
      replay_evidence: evidence(
        { kind: "source", ref: "site/community_board_participation.mjs", locator: committeeOmitted ? "Follow committee remains omitted" : "committee follow" },
        { kind: "source", ref: "worker/src/lib/continuation_replay.mjs", locator: EXACT_REPLAY_FAMILY },
      ),
      card_evidence: evidence(
        { kind: "receipt", ref: "docs/evidence/civic-action-paths/after/ways-to-participate-capture.json" },
        { kind: "test", ref: "test/community_board_constellation.test.mjs" },
      ),
    },
    property: {
      action_types: propertyActions,
      action_evidence: evidence(
        { kind: "source", ref: "docs/evidence/civic-action-paths/before/characterization-receipt.md", locator: "property disposition rail" },
        { kind: "test", ref: "test/property_commercial.test.mjs" },
      ),
      action_path_adapter: false,
      continuation_evidence: evidence(
        { kind: "source", ref: "site/app/feed-actions.mjs", locator: "no exactPropertyActionPath" },
        { kind: "test", ref: "test/property_disposition_spine.test.mjs" },
      ),
      disposition_join: "exact BBL or borough + block/lot",
      disposition_stages: [...DISPOSITION_STAGES],
      grounding_evidence: evidence(
        { kind: "fixture", ref: "test/fixtures/property_disposition/multi_notice_bbl.json" },
        { kind: "test", ref: "test/property_disposition_spine.test.mjs" },
      ),
      exact_replay: false,
      replay_evidence: evidence(
        { kind: "source", ref: "worker/src/lib/filter.mjs", locator: `LENSES.property=${JSON.stringify(LENSES.property)}` },
        { kind: "source", ref: "worker/src/lib/continuation_replay.mjs", locator: EXACT_REPLAY_FAMILY },
      ),
      card_evidence: evidence(
        { kind: "test", ref: "test/property_disposition_spine.test.mjs" },
      ),
    },
  };
}

export function buildActionPathGeneralizationAuditFromRepo(root = ROOT) {
  const audit = assembleActionPathGeneralizationAudit(collectActionPathGeneralizationProbes(root));
  assertActionPathGeneralizationContract(audit);
  return audit;
}

export function writeActionPathGeneralizationAudit({ check = false, root = ROOT } = {}) {
  const audit = buildActionPathGeneralizationAuditFromRepo(root);
  const jsonText = stableStringify(audit);
  const mdText = renderActionPathGeneralizationMarkdown(audit);
  const jsonPath = path.join(root, AUDIT_JSON);
  const mdPath = path.join(root, AUDIT_MD);
  if (check) {
    const committedJson = readFileSync(jsonPath, "utf8");
    const committedMd = readFileSync(mdPath, "utf8");
    if (committedJson !== jsonText) throw new Error(`${AUDIT_JSON} drifted; rerun without --check`);
    if (committedMd !== mdText) throw new Error(`${AUDIT_MD} drifted; rerun without --check`);
    return audit;
  }
  writeFileSync(jsonPath, jsonText);
  writeFileSync(mdPath, mdText);
  return audit;
}

function main(argv = process.argv) {
  const args = parseArgs(argv);
  const audit = writeActionPathGeneralizationAudit(args);
  process.stdout.write(`${args.check ? "checked" : "wrote"} ${AUDIT_JSON} domains=${audit.domains.length}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.stack || error);
    process.exitCode = 1;
  }
}
