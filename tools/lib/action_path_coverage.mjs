/**
 * Collect Action Path coverage samples from retained Council, DOT, and
 * Community Board evidence. Classification and ratios live in
 * ontology/action_path_coverage.mjs.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ACTION_PATH_COVERAGE_SCHEMA,
  actionPathCoverageFindings,
  assertActionPathCoverageContract,
  measureActionPathCoverage,
  renderActionPathCoverageMarkdown,
  stableStringify,
} from "../../ontology/action_path_coverage.mjs";
import { buildActionPath } from "../../site/action_path_v0.mjs";
import { buildCouncilHearingActionPath } from "../../site/council_hearing_action_path.mjs";
import {
  COMMUNITY_BOARD_APPLICATION_MAX_AGE_DAYS,
  communityBoardApplicationAvailability,
  communityBoardParticipationPaths,
  projectCommunityBoardParticipation,
} from "../../site/community_board_participation.mjs";
import { continuationReplayForSubject } from "../../worker/src/lib/continuation_replay.mjs";
import { EXACT_REPLAY_FAMILY } from "./action_path_generalization_audit.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const COVERAGE_JSON = "docs/evidence/civic-action-paths/action-path-coverage.json";
export const COVERAGE_MD = "docs/evidence/civic-action-paths/action-path-coverage.md";
export const SAMPLE_FIXTURE = "ontology/fixtures/dimensions/action_path_coverage.json";

const DOT_SUBJECT = "rulemaking:dot:bicycle-owned-racks";
const DOT_NOTICE_IDS = ["20260317026", "20260706041"];

function readJson(root, rel) {
  return JSON.parse(readFileSync(path.join(root, rel), "utf8"));
}

function nested(source, key) {
  return String(key || "").split(".").reduce((value, part) => value?.[part], source);
}

function ageDays(observedAt, asOf) {
  const observed = observedAt ? new Date(observedAt).getTime() : NaN;
  const now = asOf ? new Date(asOf).getTime() : NaN;
  if (Number.isNaN(observed) || Number.isNaN(now)) return null;
  return Math.max(0, (now - observed) / 86_400_000);
}

function deadlinePassed(deadline, asOf) {
  if (!deadline || !asOf) return false;
  const due = new Date(deadline).getTime();
  const now = new Date(asOf).getTime();
  return Number.isFinite(due) && Number.isFinite(now) && now > due;
}

function evidence(...rows) {
  return rows.filter(Boolean);
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

function matterReplay(originRef, continuationRef) {
  return continuationReplayForSubject(originRef, {
    kind: "subject",
    subject_ref: continuationRef,
    replayable: true,
    subject_exists: true,
    relation: {
      status: "accepted",
      method: "strict",
      from: originRef,
      to: continuationRef,
    },
    scope: {
      schema: "cityscroll.scope",
      version: 0,
      facets: { domains: ["meetings"] },
    },
    replay_proof: {
      following: { subject_ref: continuationRef },
      delivery: { soda_subject_refs: [continuationRef], d1_subject_refs: [continuationRef] },
    },
  });
}

function replayFor(kind, originRef, continuationRef) {
  if (kind === "dot") return continuationReplayForSubject(originRef, dotCandidate(originRef));
  if (kind === "matter") return matterReplay(originRef, continuationRef);
  return null;
}

function continuationFields(input, path, replay) {
  const proposed = Boolean(input?.continuation || input?.continuation_candidates);
  if (!proposed) {
    return {
      continuation_proposed: false,
      continuation_status: "none",
      continuation_ref: null,
      continuation_replayable: false,
      exact_replay: false,
    };
  }
  if (path?.continuation_state === "unknown" && !path?.continuation) {
    return {
      continuation_proposed: true,
      continuation_status: "not_replayable",
      continuation_ref: null,
      continuation_replayable: false,
      exact_replay: false,
    };
  }
  if (path?.continuation_state === "ambiguous") {
    return {
      continuation_proposed: true,
      continuation_status: "unknown",
      continuation_ref: null,
      continuation_replayable: false,
      exact_replay: false,
    };
  }
  const ref = path?.continuation?.subject_ref || path?.process_ref || null;
  const exact = Boolean(replay?.subject_ref && replay?.scope?.facets?.values?.request_ids);
  if (ref && exact) {
    return {
      continuation_proposed: true,
      continuation_status: "grounded",
      continuation_ref: ref,
      continuation_replayable: true,
      exact_replay: true,
    };
  }
  if (ref && !exact) {
    return {
      continuation_proposed: true,
      continuation_status: "not_replayable",
      continuation_ref: ref,
      continuation_replayable: false,
      exact_replay: false,
    };
  }
  return {
    continuation_proposed: true,
    continuation_status: "unknown",
    continuation_ref: null,
    continuation_replayable: false,
    exact_replay: false,
  };
}

function fromActionPath({
  id,
  family,
  input,
  replayKind = null,
  asOf = null,
  opportunityClaimedCurrent = false,
  evidenceRows = [],
}) {
  const path = buildActionPath(input);
  const origin = path.subject_ref;
  const replay = replayKind ? replayFor(replayKind, origin, path.continuation?.subject_ref) : null;
  const snapshotAsOf = asOf || input.snapshot?.as_of || path.availability?.deadline || null;
  const available = path.availability?.state === "available";
  const stale = deadlinePassed(path.availability?.deadline || input.action?.deadline, snapshotAsOf);
  return {
    id,
    family,
    entity_ref: path.process_ref || path.subject_ref,
    as_of: snapshotAsOf,
    action_present: true,
    action_available: available,
    action_type: path.action?.type || null,
    target_status: path.target_ref ? "grounded" : "unknown",
    target_ref: path.target_ref,
    ...continuationFields(input, path, replay),
    opportunity_stale: stale,
    opportunity_claimed_current: opportunityClaimedCurrent || (available && !stale),
    application_cta: false,
    application_source_current: null,
    cross_board_inference: false,
    broad_fallback: /all DOT rules|all DOT hearings/i.test(JSON.stringify(path)),
    synthetic_action: false,
    exact_replay_family: EXACT_REPLAY_FAMILY,
    evidence: evidence(
      { kind: "fixture", ref: "test/fixtures/action_path_v0.json", locator: id },
      ...evidenceRows,
    ),
  };
}

function fromCouncilHearing({ id, record, outcome }) {
  const path = buildCouncilHearingActionPath(record, outcome);
  const proposed = Boolean(record && outcome);
  return {
    id,
    family: "council",
    entity_ref: path?.subject_ref || record?.meeting_id,
    as_of: record?.event_date || null,
    action_present: Boolean(path?.action),
    action_available: path?.availability?.state === "available",
    action_type: path?.action?.type || null,
    target_status: path?.target_ref ? "grounded" : "unknown",
    target_ref: path?.target_ref || null,
    continuation_proposed: Boolean(path?.continuation || (proposed && path?.continuation_state !== "none")),
    continuation_status: path?.continuation
      ? "not_replayable"
      : path?.continuation_state === "unknown"
        ? "unknown"
        : "none",
    continuation_ref: path?.continuation?.subject_ref || null,
    continuation_replayable: false,
    exact_replay: false,
    opportunity_stale: false,
    opportunity_claimed_current: path?.availability?.state === "available",
    application_cta: false,
    application_source_current: null,
    cross_board_inference: false,
    broad_fallback: false,
    synthetic_action: false,
    evidence: evidence(
      { kind: "fixture", ref: "site/data/meeting_outcomes_snapshot.json", locator: record?.request_id },
      { kind: "source", ref: "site/council_hearing_action_path.mjs" },
    ),
  };
}

function fromBoardPath({
  id,
  boardId,
  pathKind,
  bylaws,
  sources,
  asOf,
}) {
  const participation = projectCommunityBoardParticipation({
    board_id: boardId,
    bylaws,
    application_sources: sources,
    as_of: asOf,
  });
  const paths = communityBoardParticipationPaths({
    board_id: boardId,
    participation,
    as_of: asOf,
  });
  const match = paths.find((row) => row.kind === pathKind) || null;
  const apply = pathKind.startsWith("apply_");
  const availability = apply
    ? (participation.applications || []).find((row) => row.participation_kind === (
      pathKind === "apply_full_board_membership" ? "full_board_membership" : "public_committee_membership"
    ))?.availability
    : null;
  const sourceCurrent = availability
    ? availability.reason !== "application_source_stale" && availability.age_days != null
      && availability.age_days <= COMMUNITY_BOARD_APPLICATION_MAX_AGE_DAYS
    : null;
  return {
    id,
    family: "community_board",
    entity_ref: `community-board:${boardId}`,
    as_of: asOf,
    action_present: Boolean(match),
    action_available: Boolean(match?.cta || (match?.state === "supported" && match?.href)),
    action_type: pathKind,
    target_status: "grounded",
    target_ref: `community-board:${boardId}`,
    continuation_proposed: false,
    continuation_status: "none",
    continuation_ref: null,
    continuation_replayable: false,
    exact_replay: false,
    opportunity_stale: availability?.reason === "application_source_stale",
    opportunity_claimed_current: Boolean(match?.cta),
    application_cta: Boolean(match?.cta && apply),
    application_source_current: sourceCurrent,
    cross_board_inference: Boolean(
      match?.cross_board_inference || participation.cross_board_inference,
    ),
    broad_fallback: false,
    synthetic_action: false,
    evidence: evidence(
      { kind: "fixture", ref: "site/data/community_board_bylaws.json", locator: boardId },
      { kind: "test", ref: "test/community_board_participation.test.mjs" },
    ),
  };
}

function fromApplicationSource({
  id,
  boardId,
  source,
  asOf,
  opportunityClaimedCurrent = false,
}) {
  const availability = communityBoardApplicationAvailability(source, { asOf });
  const age = ageDays(source.observed_at, asOf);
  const sourceCurrent = availability.reason !== "application_source_stale"
    && age != null
    && age <= COMMUNITY_BOARD_APPLICATION_MAX_AGE_DAYS
    && source.receipt?.status === "ok";
  const stale = availability.reason === "application_source_stale";
  const scoped = Array.isArray(source.applies_to_board_ids)
    && source.applies_to_board_ids.includes(boardId);
  return {
    id,
    family: "community_board",
    entity_ref: `community-board:${boardId}`,
    as_of: asOf,
    action_present: Boolean(scoped && source.application_destination),
    action_available: Boolean(availability.cta && scoped),
    action_type: "apply_public_committee_membership",
    target_status: "grounded",
    target_ref: `community-board:${boardId}`,
    continuation_proposed: false,
    continuation_status: "none",
    continuation_ref: null,
    continuation_replayable: false,
    exact_replay: false,
    opportunity_stale: stale,
    opportunity_claimed_current: opportunityClaimedCurrent || availability.cta === true,
    application_cta: Boolean(availability.cta && scoped),
    application_source_current: sourceCurrent,
    cross_board_inference: !scoped,
    broad_fallback: false,
    synthetic_action: false,
    evidence: evidence(
      { kind: "fixture", ref: SAMPLE_FIXTURE, locator: id },
    ),
  };
}

function fromExplicit(sample, asOf) {
  return {
    id: sample.id,
    family: sample.family || "negative",
    entity_ref: sample.entity_ref,
    as_of: sample.as_of || asOf,
    action_present: sample.action_present === true,
    action_available: sample.action_available === true,
    action_type: sample.action_type || null,
    target_status: sample.target_status || "missing",
    target_ref: sample.target_ref || null,
    continuation_proposed: sample.continuation_proposed === true,
    continuation_status: sample.continuation_status || "none",
    continuation_ref: sample.continuation_ref || null,
    continuation_replayable: sample.continuation_replayable === true,
    exact_replay: sample.exact_replay === true,
    opportunity_stale: sample.opportunity_stale === true,
    opportunity_claimed_current: sample.opportunity_claimed_current === true,
    application_cta: sample.application_cta === true,
    application_source_current: sample.application_source_current ?? null,
    cross_board_inference: sample.cross_board_inference === true,
    broad_fallback: sample.broad_fallback === true,
    synthetic_action: sample.synthetic_action === true,
    evidence: sample.evidence || [],
  };
}

export function collectActionPathCoverageRows(root = ROOT, sample = null) {
  const fixture = sample || readJson(root, SAMPLE_FIXTURE);
  const actionPathFixtures = readJson(root, "test/fixtures/action_path_v0.json");
  const snapshot = readJson(root, "site/data/meeting_outcomes_snapshot.json");
  const bylaws = readJson(root, "site/data/community_board_bylaws.json");
  const participationSources = readJson(root, "site/data/community_board_participation_sources.json");
  const asOf = fixture.as_of || "2026-08-27T00:00:00.000Z";
  const rows = [];

  for (const sampleCase of fixture.cases || []) {
    if (sampleCase.from === "action_path_v0") {
      rows.push(fromActionPath({
        id: sampleCase.id,
        family: sampleCase.family,
        input: nested(actionPathFixtures, sampleCase.key),
        replayKind: sampleCase.replay || null,
        asOf: sampleCase.as_of || null,
        opportunityClaimedCurrent: sampleCase.opportunity_claimed_current === true,
      }));
      continue;
    }
    if (sampleCase.from === "council_hearing") {
      const requestId = sampleCase.request_id;
      rows.push(fromCouncilHearing({
        id: sampleCase.id,
        record: {
          source_system: "city_record",
          meeting_id: `meeting:city_record:${requestId}`,
          request_id: requestId,
          event_date: snapshot.by_notice?.[requestId]?.event_date || null,
          meeting_outcome: snapshot.by_notice?.[requestId],
        },
        outcome: snapshot.by_notice?.[requestId],
      }));
      continue;
    }
    if (sampleCase.from === "community_board_path") {
      rows.push(fromBoardPath({
        id: sampleCase.id,
        boardId: sampleCase.board_id,
        pathKind: sampleCase.path_kind,
        bylaws,
        sources: participationSources.sources,
        asOf: sampleCase.as_of || asOf,
      }));
      continue;
    }
    if (sampleCase.from === "application_source") {
      rows.push(fromApplicationSource({
        id: sampleCase.id,
        boardId: sampleCase.board_id,
        source: sampleCase.application_source,
        asOf: sampleCase.as_of || asOf,
        opportunityClaimedCurrent: sampleCase.opportunity_claimed_current === true,
      }));
      continue;
    }
    if (sampleCase.from === "explicit") {
      rows.push(fromExplicit(sampleCase, asOf));
    }
  }
  return rows;
}

export function assembleActionPathCoverageReceipt(root = ROOT, sample = null) {
  const rows = collectActionPathCoverageRows(root, sample);
  const measured = measureActionPathCoverage(rows);
  const processRefs = [...new Set(
    rows
      .filter((row) => row.family === "rules")
      .map((row) => row.continuation_ref || row.entity_ref)
      .filter((ref) => String(ref).startsWith("rulemaking:")),
  )];
  return {
    ...measured,
    generated_from: SAMPLE_FIXTURE,
    exact_replay_family: EXACT_REPLAY_FAMILY,
    dot_bicycle_racks: {
      rulemaking_subject: processRefs.length === 1 ? processRefs[0] : null,
      same_rulemaking: processRefs.length === 1 && processRefs[0] === DOT_SUBJECT,
    },
  };
}

export function actionPathCoverageReceiptFindings(receipt) {
  const findings = actionPathCoverageFindings(receipt);
  if (receipt?.dot_bicycle_racks?.same_rulemaking !== true
    || receipt?.dot_bicycle_racks?.rulemaking_subject !== DOT_SUBJECT) {
    findings.push({ message: "DOT T1/T2/T3 must remain one City-Owned Bicycle Racks rulemaking subject" });
  }
  if (receipt?.exact_replay_family !== EXACT_REPLAY_FAMILY) {
    findings.push({ message: "coverage must not invent an exact-replay family beyond rules.request_ids" });
  }
  return findings;
}

export function assertActionPathCoverageReceipt(receipt) {
  const findings = actionPathCoverageReceiptFindings(receipt);
  if (findings.length) {
    const error = new Error(findings.map((row) => row.message).join("; "));
    error.findings = findings;
    throw error;
  }
  assertActionPathCoverageContract(receipt);
  return receipt;
}

export {
  ACTION_PATH_COVERAGE_SCHEMA,
  measureActionPathCoverage,
  renderActionPathCoverageMarkdown,
  stableStringify,
};
