/**
 * Fail-closed Civic Action Path generalization audit.
 *
 * The matrix is a stopping rule: it records whether an action exists, whether a
 * natural continuation is grounded, whether that continuation is exactly
 * replayable, and whether any follow-on card is warranted. It does not rebuild
 * domains and does not treat button density as coverage.
 */

export const ACTION_PATH_GENERALIZATION_SCHEMA = "cityscroll.action_path_generalization_audit.v1";
export const ACTION_PATH_GENERALIZATION_METHOD = "action_path_generalization_audit_v1";
export const ACTION_PATH_GENERALIZATION_VERSION = 1;
export const NOT_ESTABLISHED = "not-established";
export const ESTABLISHED = "established";
export const EXACT_REPLAY_FAMILY = "rules.request_ids";

export const ACTION_PATH_GENERALIZATION_DOMAINS = Object.freeze([
  "meetings",
  "rules",
  "land",
  "money",
  "staffing",
  "community_boards",
  "property",
]);

export const ACTION_PATH_GENERALIZATION_COLUMNS = Object.freeze([
  "action",
  "continuation",
  "grounding",
  "replay",
  "card_decision",
]);

const EVIDENCE_KINDS = new Set(["fixture", "source", "receipt", "test"]);
const CARD_ADDITIONAL = new Set(["none", "follow-on", "low-risk-adapter"]);
const FORBIDDEN_INFERENCE = /button density|button_count|all DOT rules|all DOT hearings|rebuild every domain|inferred completeness/i;

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function freezeDeep(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    value.forEach(freezeDeep);
    return Object.freeze(value);
  }
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function text(value, max = 2_000) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function evidenceList(value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  const rows = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    const kind = text(entry.kind, 40);
    const ref = text(entry.ref, 400);
    if (!EVIDENCE_KINDS.has(kind) || !ref) return null;
    rows.push({ kind, ref, locator: text(entry.locator, 240) || null });
  }
  return rows;
}

function finding(message) {
  return { message };
}

function cell({ domain, column, status, claim, evidence, notes = null }) {
  return {
    domain,
    column,
    status,
    claim: text(claim, 1_200),
    evidence: evidenceList(evidence) || [],
    notes: text(notes, 1_200) || null,
  };
}

function cardDecision({
  domain,
  shipped_cards = [],
  additional = "none",
  follow_on_work = null,
  cost = "none",
  rebuild_domain = false,
  low_risk_adapter = false,
  claim,
  evidence,
}) {
  return {
    domain,
    column: "card_decision",
    status: additional === "none" && shipped_cards.length ? ESTABLISHED : additional === "none" ? NOT_ESTABLISHED : ESTABLISHED,
    shipped_cards: [...shipped_cards],
    additional,
    follow_on_work: text(follow_on_work, 400) || null,
    cost,
    rebuild_domain: rebuild_domain === true,
    low_risk_adapter: low_risk_adapter === true,
    claim: text(claim, 1_200),
    evidence: evidenceList(evidence) || [],
  };
}

/**
 * Measure the required DOT City-Owned Bicycle Racks canary from retained
 * T1/T2/T3 Action Path snapshots plus optional exact-replay probes.
 * A missing continuation or CTA is a valid measured outcome.
 */
export function measureDotBicycleRacksCanary(snapshots = {}, replayBySnapshot = {}) {
  const required = ["t1_before_hearing", "t2_after_adoption", "t3_after_effective_date"];
  const rows = [];
  for (const key of required) {
    const snapshot = snapshots[key];
    const path = snapshot?.path || null;
    const replay = replayBySnapshot[key] ?? snapshot?.replay ?? null;
    const commentAction = path?.action?.type === "comment" && path?.availability?.state === "available";
    rows.push({
      snapshot: key,
      as_of: snapshot?.as_of || snapshot?.snapshot?.as_of || null,
      rulemaking_state: snapshot?.rulemaking_state || snapshot?.snapshot?.rulemaking_state || path?.availability?.state || null,
      next_event: snapshot?.next_event || snapshot?.snapshot?.next_event || null,
      subject_ref: path?.subject_ref || null,
      target_ref: path?.target_ref || null,
      process_ref: path?.process_ref || null,
      action_type: path?.action?.type || null,
      action_available: path?.availability?.state === "available",
      comment_cta: Boolean(commentAction),
      continuation_ref: path?.continuation?.subject_ref || null,
      continuation_cta: path?.continuation_cta === true,
      continuation_present: Boolean(path?.continuation?.subject_ref),
      exact_replay: Boolean(replay?.subject_ref && replay?.scope?.facets?.values?.request_ids),
      replay_subject_ref: replay?.subject_ref || null,
      request_ids: replay?.scope?.facets?.values?.request_ids || replay?.watch?.filter?.request_ids || null,
    });
  }
  const processRefs = [...new Set(rows.map((row) => row.process_ref).filter(Boolean))];
  const serialized = JSON.stringify(rows);
  return freezeDeep({
    rulemaking_subject: processRefs.length === 1 ? processRefs[0] : null,
    same_rulemaking: processRefs.length === 1 && rows.every((row) => row.process_ref === processRefs[0]),
    broad_fallback: FORBIDDEN_INFERENCE.test(serialized) && /all DOT/i.test(serialized),
    snapshots: rows,
  });
}

function requireEvidence(cellRow, findings, label) {
  if (!Array.isArray(cellRow.evidence) || cellRow.evidence.length === 0) {
    findings.push(finding(`${label} has no fixture, source, receipt, or test citation`));
    return;
  }
  for (const entry of cellRow.evidence) {
    if (!EVIDENCE_KINDS.has(entry.kind) || !entry.ref) {
      findings.push(finding(`${label} evidence is not a fixture, source, receipt, or test citation`));
    }
    if (FORBIDDEN_INFERENCE.test(`${entry.kind} ${entry.ref} ${entry.locator || ""}`)) {
      findings.push(finding(`${label} evidence infers completeness from a forbidden proxy`));
    }
  }
}

/**
 * Assemble the seven-domain matrix from measured probes. Missing probes stay
 * `not-established`; the assembler never infers a shipped capability.
 */
export function assembleActionPathGeneralizationAudit(probes = {}) {
  const dot = probes.dotCanary || measureDotBicycleRacksCanary();
  const t1 = dot.snapshots?.find((row) => row.snapshot === "t1_before_hearing") || {};
  const commentOpen = t1.comment_cta === true;
  const continuationAlways = (dot.snapshots || []).every((row) => row.continuation_present === true);
  const replayAlways = (dot.snapshots || []).every((row) => row.exact_replay === true);

  const meetings = probes.meetings || {};
  const land = probes.land || {};
  const money = probes.money || {};
  const staffing = probes.staffing || {};
  const boards = probes.community_boards || probes.communityBoards || {};
  const property = probes.property || {};
  const exactFamily = text(probes.exact_replay_family, 80) || EXACT_REPLAY_FAMILY;

  const domains = {
    meetings: {
      action: cell({
        domain: "meetings",
        column: "action",
        status: meetings.action_types?.length ? ESTABLISHED : NOT_ESTABLISHED,
        claim: meetings.action_types?.length
          ? `Existing meeting actions include ${meetings.action_types.join(", ")}.`
          : "No retained meeting action measurement.",
        evidence: meetings.action_evidence,
      }),
      continuation: cell({
        domain: "meetings",
        column: "continuation",
        status: meetings.single_continuation === true ? ESTABLISHED : NOT_ESTABLISHED,
        claim: meetings.single_continuation === true
          ? `One exact Council matter continuation is published; multiple matters remain a choice and unmatched hearings omit a CTA (single=${meetings.single_subject_ref || "none"}, multiple_cta=${meetings.multiple_cta === true}, unmatched_cta=${meetings.unmatched_cta === true}).`
          : "Council hearing continuation is not established from retained fixtures.",
        evidence: meetings.continuation_evidence,
        notes: "Continuation availability is not inferred from unmatched or multi-matter rows.",
      }),
      grounding: cell({
        domain: "meetings",
        column: "grounding",
        status: meetings.join_method === "exact_date_body_tokens" ? ESTABLISHED : NOT_ESTABLISHED,
        claim: meetings.join_method === "exact_date_body_tokens"
          ? `Matter joins are grounded only by ${meetings.join_method} on retained Council fixtures ${ (meetings.canaries || []).join(", ") }.`
          : "No exact Council join method is retained for this audit.",
        evidence: meetings.grounding_evidence,
      }),
      replay: cell({
        domain: "meetings",
        column: "replay",
        status: meetings.exact_replay === true ? ESTABLISHED : NOT_ESTABLISHED,
        claim: meetings.exact_replay === true
          ? "Matter continuation replays through the exact continuation capability."
          : `Exact matter replay is ${NOT_ESTABLISHED}; the current exact family remains ${exactFamily}, and a matter probe returns no continuation.`,
        evidence: meetings.replay_evidence,
      }),
      card_decision: cardDecision({
        domain: "meetings",
        shipped_cards: ["cityscroll-civic-action-paths/cap-3", "cityscroll-civic-action-paths/cap-4"],
        additional: "follow-on",
        follow_on_work: "Exact compiler family for matter:{legistar_id} continuation replay",
        cost: "substantial-ingestion-or-compiler",
        claim: "CAP-3/CAP-4 cover hearing→matter display and post-event outcomes; exact matter replay remains ranked follow-on work.",
        evidence: meetings.card_evidence,
      }),
    },
    rules: {
      action: cell({
        domain: "rules",
        column: "action",
        status: commentOpen || t1.action_available ? ESTABLISHED : NOT_ESTABLISHED,
        claim: commentOpen
          ? "T1 retains an available comment action on the DOT City-Owned Bicycle Racks proposal; later snapshots do not keep that comment CTA."
          : "DOT T1 does not retain an available comment action.",
        evidence: probes.rules?.action_evidence,
        notes: "Action availability is snapshot-specific. T2/T3 may have no comment CTA.",
      }),
      continuation: cell({
        domain: "rules",
        column: "continuation",
        status: continuationAlways && dot.same_rulemaking ? ESTABLISHED : (dot.snapshots || []).some((row) => row.continuation_present) ? ESTABLISHED : NOT_ESTABLISHED,
        claim: continuationAlways && dot.same_rulemaking
          ? `T1/T2/T3 remain on ${dot.rulemaking_subject}. Continuation CTAs are ${ (dot.snapshots || []).map((row) => `${row.snapshot}:${row.continuation_cta}`).join("; ") }.`
          : "DOT rulemaking continuation is not established across the retained snapshots.",
        evidence: probes.rules?.continuation_evidence,
        notes: "A snapshot may omit a continuation CTA without inventing a broader DOT follow.",
      }),
      grounding: cell({
        domain: "rules",
        column: "grounding",
        status: dot.same_rulemaking ? ESTABLISHED : NOT_ESTABLISHED,
        claim: dot.same_rulemaking
          ? `Grounded rulemaking subject ${dot.rulemaking_subject} is retained from proposal notice 20260317026 and adoption notice 20260706041.`
          : "DOT rulemaking subject identity is not established.",
        evidence: probes.rules?.grounding_evidence,
      }),
      replay: cell({
        domain: "rules",
        column: "replay",
        status: replayAlways && exactFamily === EXACT_REPLAY_FAMILY ? ESTABLISHED : NOT_ESTABLISHED,
        claim: replayAlways
          ? `Exact replay is proven for ${exactFamily} membership of the two retained DOT notices.`
          : `Exact DOT replay is ${NOT_ESTABLISHED} on one or more snapshots.`,
        evidence: probes.rules?.replay_evidence,
      }),
      card_decision: cardDecision({
        domain: "rules",
        shipped_cards: [
          "cityscroll-civic-action-paths/cap-1",
          "cityscroll-civic-action-paths/cap-2",
          "cityscroll-civic-action-paths/cap-4",
        ],
        additional: "none",
        cost: "none",
        claim: "Rules generalization is proven by the DOT canary; no domain rebuild and no extra adapter in this card.",
        evidence: probes.rules?.card_evidence,
      }),
    },
    land: {
      action: cell({
        domain: "land",
        column: "action",
        status: land.action_types?.length ? ESTABLISHED : NOT_ESTABLISHED,
        claim: land.action_types?.length
          ? `Existing land actions include ${land.action_types.join(", ")}.`
          : "No retained land action measurement.",
        evidence: land.action_evidence,
      }),
      continuation: cell({
        domain: "land",
        column: "continuation",
        status: land.document_continuation === true ? ESTABLISHED : NOT_ESTABLISHED,
        claim: land.document_continuation === true
          ? "A notice-to-ZAP adapter can name a project subject, but the published destination is a land document route rather than an exact Following continuation."
          : "No retained land continuation adapter.",
        evidence: land.continuation_evidence,
        notes: land.href_kind === "hash_document"
          ? "A #land/{projectId} document link is not exact replay."
          : null,
      }),
      grounding: cell({
        domain: "land",
        column: "grounding",
        status: land.grounded_project_id ? ESTABLISHED : NOT_ESTABLISHED,
        claim: land.grounded_project_id
          ? `Strict notice-land join grounds project ${land.grounded_project_id} from notice ${land.grounded_notice_id}.`
          : "No retained exact land project join is cited.",
        evidence: land.grounding_evidence,
      }),
      replay: cell({
        domain: "land",
        column: "replay",
        status: land.exact_replay === true ? ESTABLISHED : NOT_ESTABLISHED,
        claim: land.exact_replay === true
          ? "Land project continuation replays through the exact continuation capability."
          : `Exact land project replay is ${NOT_ESTABLISHED}; the land lens has no project identifier family, and ${exactFamily} is the only proven exact family.`,
        evidence: land.replay_evidence,
      }),
      card_decision: cardDecision({
        domain: "land",
        additional: "follow-on",
        follow_on_work: "Exact land-project continuation family and compiler support",
        cost: "substantial-ingestion-or-compiler",
        claim: "Do not rebuild Land in this card. Rank exact project-scope replay as follow-on work.",
        evidence: land.card_evidence,
      }),
    },
    money: {
      action: cell({
        domain: "money",
        column: "action",
        status: money.action_types?.length ? ESTABLISHED : NOT_ESTABLISHED,
        claim: money.action_types?.length
          ? `Existing procurement actions include ${money.action_types.join(", ")}.`
          : "No retained money action measurement.",
        evidence: money.action_evidence,
      }),
      continuation: cell({
        domain: "money",
        column: "continuation",
        status: money.action_path_adapter === true ? ESTABLISHED : NOT_ESTABLISHED,
        claim: money.action_path_adapter === true
          ? "An Action Path adapter publishes an exact procurement continuation."
          : `Natural continuation is a procurement object, but an Action Path continuation adapter is ${NOT_ESTABLISHED}.`,
        evidence: money.continuation_evidence,
      }),
      grounding: cell({
        domain: "money",
        column: "grounding",
        status: money.procurement_id_supported === true ? ESTABLISHED : NOT_ESTABLISHED,
        claim: money.procurement_id_supported === true
          ? "Money watches can name a procurement_id in the compiler, which is identity evidence, not a shipped Action Path continuation."
          : "No retained procurement identity field is cited.",
        evidence: money.grounding_evidence,
      }),
      replay: cell({
        domain: "money",
        column: "replay",
        status: money.exact_replay === true ? ESTABLISHED : NOT_ESTABLISHED,
        claim: money.exact_replay === true
          ? "Procurement continuation replays through the exact continuation capability."
          : `Exact procurement Action Path replay is ${NOT_ESTABLISHED}; compiler support for procurement_id is not the CAP-2 relation family.`,
        evidence: money.replay_evidence,
      }),
      card_decision: cardDecision({
        domain: "money",
        additional: "follow-on",
        follow_on_work: "Action Path procurement continuation plus an exact relation family",
        cost: "substantial-ingestion-or-compiler",
        claim: "Do not rebuild Money in this card. Rank a new exact continuation family as follow-on work.",
        evidence: money.card_evidence,
      }),
    },
    staffing: {
      action: cell({
        domain: "staffing",
        column: "action",
        status: staffing.action_types?.length ? ESTABLISHED : NOT_ESTABLISHED,
        claim: staffing.action_types?.length
          ? `Existing exam actions include ${staffing.action_types.join(", ")}.`
          : "No retained staffing action measurement.",
        evidence: staffing.action_evidence,
      }),
      continuation: cell({
        domain: "staffing",
        column: "continuation",
        status: staffing.action_path_adapter === true ? ESTABLISHED : NOT_ESTABLISHED,
        claim: staffing.action_path_adapter === true
          ? "An Action Path adapter publishes an exact exam continuation."
          : `Natural continuation is an exam or eligible list, but an Action Path continuation adapter is ${NOT_ESTABLISHED}.`,
        evidence: staffing.continuation_evidence,
      }),
      grounding: cell({
        domain: "staffing",
        column: "grounding",
        status: staffing.exam_number ? ESTABLISHED : NOT_ESTABLISHED,
        claim: staffing.exam_number
          ? `Exam ${staffing.exam_number} is a retained identity for apply-window actions and the exam process spine.`
          : "No retained exam identity is cited.",
        evidence: staffing.grounding_evidence,
      }),
      replay: cell({
        domain: "staffing",
        column: "replay",
        status: staffing.exact_replay === true ? ESTABLISHED : NOT_ESTABLISHED,
        claim: staffing.exact_replay === true
          ? "Exam continuation replays through the exact continuation capability."
          : `Exact exam Action Path replay is ${NOT_ESTABLISHED}; people-lens examNumber filtering is not the CAP-2 relation family.`,
        evidence: staffing.replay_evidence,
      }),
      card_decision: cardDecision({
        domain: "staffing",
        additional: "follow-on",
        follow_on_work: "Action Path exam continuation plus an exact exam-number relation family",
        cost: "substantial-ingestion-or-compiler",
        claim: "Do not rebuild Staffing in this card. Rank exact exam-scope replay as follow-on work.",
        evidence: staffing.card_evidence,
      }),
    },
    community_boards: {
      action: cell({
        domain: "community_boards",
        column: "action",
        status: boards.path_kinds?.length ? ESTABLISHED : NOT_ESTABLISHED,
        claim: boards.path_kinds?.length
          ? `Source-qualified Ways to participate paths include ${boards.path_kinds.join(", ")}.`
          : "No retained Community Board participation path measurement.",
        evidence: boards.action_evidence,
      }),
      continuation: cell({
        domain: "community_boards",
        column: "continuation",
        status: boards.follow_board === true ? ESTABLISHED : NOT_ESTABLISHED,
        claim: boards.follow_board === true
          ? `Board follow uses exact board identity ${boards.board_watch_ref || "community-board:{id}"}. Committee follow remains omitted.`
          : "Board continuation is not established.",
        evidence: boards.continuation_evidence,
        notes: boards.follow_committee === true ? null : "Follow committee is withheld until meetings watches can replay a committee without falling back to the whole board.",
      }),
      grounding: cell({
        domain: "community_boards",
        column: "grounding",
        status: boards.cross_board_inference === false ? ESTABLISHED : NOT_ESTABLISHED,
        claim: boards.cross_board_inference === false
          ? "Participation remains board-local; cross-board inference is false and unknown boards omit unsupported apply/speak paths."
          : "Board-local grounding is not established.",
        evidence: boards.grounding_evidence,
      }),
      replay: cell({
        domain: "community_boards",
        column: "replay",
        status: boards.committee_replay === true ? ESTABLISHED : NOT_ESTABLISHED,
        claim: boards.board_watch === true && boards.committee_replay !== true
          ? `Board-scoped meetings watches exist, but committee identity replay is ${NOT_ESTABLISHED} and is not the CAP-2 ${exactFamily} family.`
          : `Community Board continuation replay is ${NOT_ESTABLISHED}.`,
        evidence: boards.replay_evidence,
      }),
      card_decision: cardDecision({
        domain: "community_boards",
        shipped_cards: ["cityscroll-civic-action-paths/cap-5", "cityscroll-civic-action-paths/cap-6"],
        additional: "follow-on",
        follow_on_work: "Exact committee-identity replay without board fallback",
        cost: "substantial-ingestion-or-compiler",
        claim: "CAP-5/CAP-6 already compose source-qualified participation. Committee replay is ranked follow-on work and is not inherited across boards.",
        evidence: boards.card_evidence,
      }),
    },
    property: {
      action: cell({
        domain: "property",
        column: "action",
        status: property.action_types?.length ? ESTABLISHED : NOT_ESTABLISHED,
        claim: property.action_types?.length
          ? `Existing property actions vary by stage and include ${property.action_types.join(", ")}.`
          : "No retained property action measurement.",
        evidence: property.action_evidence,
      }),
      continuation: cell({
        domain: "property",
        column: "continuation",
        status: property.action_path_adapter === true ? ESTABLISHED : NOT_ESTABLISHED,
        claim: property.action_path_adapter === true
          ? "An Action Path adapter publishes an exact disposition continuation."
          : `Natural continuation is a disposition process, but an Action Path continuation adapter is ${NOT_ESTABLISHED}.`,
        evidence: property.continuation_evidence,
      }),
      grounding: cell({
        domain: "property",
        column: "grounding",
        status: property.disposition_join ? ESTABLISHED : NOT_ESTABLISHED,
        claim: property.disposition_join
          ? `Disposition spines join on ${property.disposition_join}; stages are ${ (property.disposition_stages || []).join(" → ") }.`
          : "No retained disposition join is cited.",
        evidence: property.grounding_evidence,
      }),
      replay: cell({
        domain: "property",
        column: "replay",
        status: property.exact_replay === true ? ESTABLISHED : NOT_ESTABLISHED,
        claim: property.exact_replay === true
          ? "Disposition continuation replays through the exact continuation capability."
          : `Exact disposition-subject replay is ${NOT_ESTABLISHED}; the property lens has process/stage filters but no disposition subject family.`,
        evidence: property.replay_evidence,
      }),
      card_decision: cardDecision({
        domain: "property",
        additional: "follow-on",
        follow_on_work: "Action Path disposition continuation plus an exact process-subject family",
        cost: "substantial-ingestion-or-compiler",
        claim: "Do not rebuild Property in this card. Rank exact disposition-scope replay as follow-on work.",
        evidence: property.card_evidence,
      }),
    },
  };

  const matrix = ACTION_PATH_GENERALIZATION_DOMAINS.map((domain) => ({
    domain,
    action: domains[domain].action,
    continuation: domains[domain].continuation,
    grounding: domains[domain].grounding,
    replay: domains[domain].replay,
    card_decision: domains[domain].card_decision,
  }));

  return freezeDeep({
    schema: ACTION_PATH_GENERALIZATION_SCHEMA,
    method: ACTION_PATH_GENERALIZATION_METHOD,
    version: ACTION_PATH_GENERALIZATION_VERSION,
    stopping_rule: true,
    rebuild_every_domain: false,
    exact_replay_family: exactFamily,
    dot_bicycle_racks: dot,
    domains: matrix,
    low_risk_adapters: Object.freeze([]),
    follow_on_cards: matrix
      .filter((row) => row.card_decision.additional === "follow-on")
      .map((row) => ({
        domain: row.domain,
        work: row.card_decision.follow_on_work,
        cost: row.card_decision.cost,
      })),
  });
}

export function actionPathGeneralizationFindings(audit) {
  const findings = [];
  if (!isRecord(audit) || audit.schema !== ACTION_PATH_GENERALIZATION_SCHEMA) {
    return [finding("audit is missing the generalization schema")];
  }
  if (audit.rebuild_every_domain === true) findings.push(finding("audit must not rebuild every domain"));
  if (audit.stopping_rule !== true) findings.push(finding("audit must remain a stopping rule"));
  if (audit.exact_replay_family !== EXACT_REPLAY_FAMILY) {
    findings.push(finding("audit must not invent an exact-replay family beyond rules.request_ids"));
  }
  if (!Array.isArray(audit.low_risk_adapters) || audit.low_risk_adapters.length !== 0) {
    findings.push(finding("this card may only propose bounded low-risk adapters when they are already proven; none are"));
  }

  const byDomain = new Map((audit.domains || []).map((row) => [row.domain, row]));
  for (const domain of ACTION_PATH_GENERALIZATION_DOMAINS) {
    const row = byDomain.get(domain);
    if (!row) {
      findings.push(finding(`missing domain ${domain}`));
      continue;
    }
    for (const column of ACTION_PATH_GENERALIZATION_COLUMNS) {
      const cellRow = row[column];
      if (!isRecord(cellRow)) {
        findings.push(finding(`${domain}.${column} is missing`));
        continue;
      }
      requireEvidence(cellRow, findings, `${domain}.${column}`);
      const blob = `${cellRow.claim || ""} ${cellRow.notes || ""}`;
      if (FORBIDDEN_INFERENCE.test(blob)) {
        findings.push(finding(`${domain}.${column} infers citywide policy, button density, or completeness`));
      }
      if (column !== "card_decision" && ![ESTABLISHED, NOT_ESTABLISHED].includes(cellRow.status)) {
        findings.push(finding(`${domain}.${column} must be established or ${NOT_ESTABLISHED}`));
      }
      if (column === "replay" && cellRow.status === ESTABLISHED && domain !== "rules") {
        findings.push(finding(`${domain}.replay must not claim exact replay outside the proven Rules family without a new compiler card`));
      }
      if (column === "card_decision") {
        if (cellRow.rebuild_domain === true) {
          findings.push(finding(`${domain} card decision rebuilds the domain`));
        }
        if (!CARD_ADDITIONAL.has(cellRow.additional)) {
          findings.push(finding(`${domain} card decision additional is not ranked`));
        }
        if (cellRow.additional === "follow-on" && cellRow.cost !== "substantial-ingestion-or-compiler") {
          findings.push(finding(`${domain} follow-on work must be ranked as substantial ingestion or compiler work`));
        }
        if (cellRow.low_risk_adapter === true) {
          findings.push(finding(`${domain} must not slip a low-risk adapter past the empty adapter list`));
        }
      }
    }
  }

  const dot = audit.dot_bicycle_racks;
  if (!dot?.same_rulemaking || dot.rulemaking_subject !== "rulemaking:dot:bicycle-owned-racks") {
    findings.push(finding("DOT canary must keep one City-Owned Bicycle Racks rulemaking subject"));
  }
  const snapshots = dot?.snapshots || [];
  if (snapshots.length !== 3) findings.push(finding("DOT canary must measure T1, T2, and T3"));
  const t1 = snapshots.find((row) => row.snapshot === "t1_before_hearing");
  if (!t1?.comment_cta) findings.push(finding("DOT T1 must measure the retained comment/hearing-open action"));
  const laterComment = snapshots.filter((row) => row.snapshot !== "t1_before_hearing" && row.comment_cta === true);
  if (laterComment.length) {
    findings.push(finding("DOT T2/T3 must not invent a comment CTA after the hearing/comment-open snapshot"));
  }
  if (dot.broad_fallback === true) findings.push(finding("DOT canary broadened to all DOT rules or hearings"));
  return findings;
}

export function assertActionPathGeneralizationContract(audit) {
  const findings = actionPathGeneralizationFindings(audit);
  if (findings.length) {
    const error = new Error(findings.map((row) => row.message).join("; "));
    error.findings = findings;
    throw error;
  }
  return audit;
}

export function renderActionPathGeneralizationMarkdown(audit) {
  const lines = [
    "# Action Path generalization audit",
    "",
    "This matrix is a stopping rule. It compares existing actions, natural continuations, grounded targets, exact replay, and card decisions across seven domains. It does not rebuild those domains and it does not treat button density as coverage.",
    "",
    `Exact replay family in force: \`${audit.exact_replay_family}\`.`,
    "",
    "| Domain | Existing action | Natural continuation | Grounded now? | Exactly replayable? | Card needed? |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of audit.domains || []) {
    const decision = row.card_decision;
    const card = [
      ...(decision.shipped_cards || []).map((id) => id.replace("cityscroll-civic-action-paths/", "").toUpperCase()),
      decision.additional === "follow-on" ? `follow-on: ${decision.follow_on_work}` : null,
      decision.additional === "none" && !(decision.shipped_cards || []).length ? NOT_ESTABLISHED : null,
    ].filter(Boolean).join("; ");
    lines.push(`| ${row.domain} | ${row.action.status}: ${row.action.claim} | ${row.continuation.status}: ${row.continuation.claim} | ${row.grounding.status}: ${row.grounding.claim} | ${row.replay.status}: ${row.replay.claim} | ${card} |`);
  }
  lines.push("", "## DOT City-Owned Bicycle Racks canary", "");
  for (const snapshot of audit.dot_bicycle_racks?.snapshots || []) {
    lines.push(`- ${snapshot.snapshot}: action=${snapshot.action_type || "none"} available=${snapshot.action_available} comment_cta=${snapshot.comment_cta} continuation=${snapshot.continuation_ref || "none"} continuation_cta=${snapshot.continuation_cta} exact_replay=${snapshot.exact_replay}`);
  }
  lines.push("", "## Ranked follow-on work", "");
  for (const item of audit.follow_on_cards || []) {
    lines.push(`- ${item.domain}: ${item.work} (${item.cost})`);
  }
  lines.push("");
  return lines.join("\n");
}

export function stableStringify(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}
