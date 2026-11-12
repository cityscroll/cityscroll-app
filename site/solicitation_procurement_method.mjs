// Pure extraction of solicitation procurement-method markers from City Record
// notice prose (and publisher selection_method when present).
//
// Targets:
//   - Admin Code §6-129 M/WBE participation-goal citations (+ optional goal %)
//   - M/WBE Noncompetitive Small Purchase (PPB §3-08)
//   - Accelerated procurement timing markers (PPB §3-07)
//   - Response floor selected from the procurement legal register (days, unit,
//     section and review status come from site/procurement_legal_projection.mjs):
//       competitive sealed proposals   9 RCNY 3-03(c)(1)    20 / 27 (§6-129) days
//       competitive sealed bids        9 RCNY 3-02(c), (e)  15 / 22 (§6-129) days
//       accelerated procurement        9 RCNY 3-07(h)(1)(i) 3 business days
//     Any other published method (small purchases, PQL variants, RFP labels,
//     no label) selects no floor. The §6-129 floors apply only while the
//     register does not rule the participation requirement out.
//   - M/WBE requirement state (site/mwbe_requirement_state.mjs): published goal
//     facts stay as extracted; the register's answer and the reader state sit
//     beside them.
//
// Label-bound: only explicit citations and method names become structured
// fields. Response floor is derived, never invented from calendar math on
// start/due dates. UI chips / list badges consume this payload (site/mwbe_goal_surface.mjs).

import { plainText } from "./text_clean.mjs";
import { isoDate, responseFloorRule } from "./procurement_legal_category.mjs";
import { mwbeRequirementState } from "./mwbe_requirement_state.mjs";

export const SOLICITATION_PROCUREMENT_METHOD_SCHEMA =
  "cityscroll.solicitation_procurement_method.v2";
export const SOLICITATION_PROCUREMENT_METHOD_SCHEMA_V1 =
  "cityscroll.solicitation_procurement_method.v1";

/** Stable kind keys for the derived response floor (= projection floor kinds). */
export const RESPONSE_FLOOR_KIND = Object.freeze({
  COMPETITIVE_SEALED_PROPOSAL: "competitive_sealed_proposal",
  COMPETITIVE_SEALED_PROPOSAL_SECTION_6_129: "competitive_sealed_proposal_section_6_129",
  COMPETITIVE_SEALED_BID: "competitive_sealed_bid",
  COMPETITIVE_SEALED_BID_SECTION_6_129: "competitive_sealed_bid_section_6_129",
  ACCELERATED: "accelerated",
});

/** Floors that every ordinary solicitation of the method has (detail-only, no list chip). */
export const DEFAULT_RESPONSE_FLOOR_KINDS = Object.freeze([
  RESPONSE_FLOOR_KIND.COMPETITIVE_SEALED_PROPOSAL,
  RESPONSE_FLOOR_KIND.COMPETITIVE_SEALED_BID,
]);

/** Exact City Record selection_method_description labels (app.solicitation_method.selection_method_label_mapping). */
const EXACT_COMPETITIVE_METHOD = Object.freeze({
  "competitive sealed proposals": "competitive_sealed_proposal",
  "competitive sealed bids": "competitive_sealed_bid",
});

export function competitiveMethodFromLabel(value) {
  const label = String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  return EXACT_COMPETITIVE_METHOD[label] || null;
}

function evidence(value) {
  return plainText(value).replace(/\s+/g, " ").trim().slice(0, 280);
}

function noticeBody(row) {
  return plainText(
    [
      row.additional_description_1,
      row.additional_description_2,
      row.additional_description_3,
      row.other_info_1,
      row.other_info_2,
      row.other_info_3,
      row.printout_1,
      row.printout_2,
      row.printout_3,
      row.description,
      row.other_info,
      row.printout,
    ]
      .filter(Boolean)
      .join(" ")
  );
}

function isProcurementSolicitation(row = {}) {
  const section = String(
    row.section_name || row.section || ""
  ).toLowerCase();
  const type = String(
    row.type_of_notice_description || row.type_of_notice || ""
  ).toLowerCase();
  if (!section.includes("procurement")) return false;
  // Solicitations only — awards, intent-to-award, vendor lists are wrong universe.
  return type === "solicitation" || type.includes("solicitation");
}

function selectionMethodText(row = {}) {
  return plainText(
    row.selection_method_description ||
      row.selection_method ||
      row.special_case_reason_description ||
      ""
  );
}

/**
 * §6-129 goal / subject-to citation in body.
 * Returns null when the statute is not cited.
 */
export function extractSection6129(text) {
  if (!text) return null;
  // Require an explicit 6-129 token so generic "M/WBE goals" (e.g. State 15-A)
  // do not false-positive into the city Admin Code program.
  const cite =
    /\b(?:Admin(?:istrative)?\.?\s+Code\s+)?(?:Section|§)\s*6-129\b/i.exec(text) ||
    /\b6-129\s+of\s+the\s+New\s+York(?:\s+City)?\s+Administrative\s+Code\b/i.exec(
      text
    );
  if (!cite) return null;

  const start = Math.max(0, cite.index - 80);
  const end = Math.min(text.length, cite.index + cite[0].length + 120);
  const window = text.slice(start, end);

  let goal_percent = null;
  const goalMatch =
    /\bM\/?WBE\s+goal(?:s)?\s+(?:for\s+this\s+project\s+)?(?:is|are|:)\s*(\d{1,2}(?:\.\d+)?)\s*%/i.exec(
      text
    ) ||
    /\bparticipation\s+goal(?:s)?\s+(?:of\s+)?(\d{1,2}(?:\.\d+)?)\s*%/i.exec(
      window
    ) ||
    /\bgoal(?:s)?\s+(?:of\s+)?(\d{1,2}(?:\.\d+)?)\s*%\s*(?:for\s+)?M\/?WBE/i.exec(
      text
    );
  if (goalMatch) {
    const n = Number(goalMatch[1]);
    if (Number.isFinite(n) && n > 0 && n <= 100) goal_percent = n;
  }

  const participation =
    /\bsubject\s+to\s+participation\s+goals\b/i.test(text) ||
    /\bparticipation\s+goals?\s+for\s+(?:MBEs?|WBEs?|M\/?WBEs?|EBEs?)\b/i.test(
      text
    );

  return {
    present: true,
    statute: "admin_code_6_129",
    participation_goals: participation || goal_percent != null,
    goal_percent,
    source: "notice_body",
    evidence: evidence(window),
  };
}

/**
 * M/WBE Noncompetitive Small Purchase (PPB §3-08).
 * Body phrases and publisher selection_method both qualify.
 */
export function extractMwbeNoncompetitiveSmallPurchase(text, row = {}) {
  const selection = selectionMethodText(row);
  const bodyHit =
    /\bM\/?WBE\s+Noncompetitive\s+Small\s+Purchase(?:\s+Method)?\b/i.exec(
      text || ""
    ) ||
    /\bNoncompetitive\s+Small\s+Purchase\s+Method\b/i.exec(text || "");
  const selectionHit =
    /\bM\/?WBE\s+Noncompetitive\s+Small\s+Purchase\b/i.test(selection) ||
    /\bNoncompetitive\s+Small\s+Purchase\b/i.test(selection);

  if (!bodyHit && !selectionHit) return null;

  let ev;
  let source;
  if (bodyHit) {
    const start = Math.max(0, bodyHit.index - 20);
    const end = Math.min(
      text.length,
      bodyHit.index + bodyHit[0].length + 100
    );
    ev = evidence(text.slice(start, end));
    source = "notice_body";
  } else {
    ev = evidence(selection);
    source = "selection_method";
  }

  const ppb =
    /\b(?:Section|§)\s*3-08\b/i.test(text || "") ||
    /\bPPB\b/i.test(text || "")
      ? "3-08"
      : selectionHit
        ? "3-08"
        : null;

  return {
    present: true,
    method: "mwbe_noncompetitive_small_purchase",
    ppb_section: ppb,
    source,
    evidence: ev,
  };
}

/**
 * Accelerated procurement timing (PPB §3-07).
 * Requires an explicit accelerated-procurement method cue — not project-schedule
 * "accelerated schedule" language alone.
 */
export function extractAcceleratedProcurement(text, row = {}) {
  const selection = selectionMethodText(row);
  const patterns = [
    /\bAccelerated\s+Procurement\b/i,
    /\bpursuant\s+to\s+(?:the\s+)?Accelerated\s+(?:Procurement\s+)?Method\b/i,
    /\b(?:PPB\s+)?(?:Rules?\s+)?(?:Section|§)\s*3-07\b/i,
    /\baccelerated\s+method\s+of\s+procurement\b/i,
    /\busing\s+(?:the\s+)?accelerated\s+procurement\s+method\b/i,
  ];

  let bodyHit = null;
  for (const pattern of patterns) {
    const match = pattern.exec(text || "");
    if (match) {
      bodyHit = match;
      break;
    }
  }
  const selectionHit = /\bAccelerated\b/i.test(selection);

  if (!bodyHit && !selectionHit) return null;

  let ev;
  let source;
  if (bodyHit) {
    const start = Math.max(0, bodyHit.index - 30);
    const end = Math.min(
      (text || "").length,
      bodyHit.index + bodyHit[0].length + 80
    );
    ev = evidence((text || "").slice(start, end));
    source = "notice_body";
  } else {
    ev = evidence(selection);
    source = "selection_method";
  }

  return {
    present: true,
    method: "accelerated_procurement",
    ppb_section: "3-07",
    source,
    evidence: ev,
  };
}

function floorPayload(kind, occurredOn, evidenceText) {
  const rule = responseFloorRule(kind, occurredOn);
  if (!rule) return null;
  const isRule = rule.claim === "rule";
  return {
    kind,
    days: rule.days,
    day_unit: rule.day_unit,
    rule_source: rule.rule_id,
    rule_record_version: rule.record_version,
    rule_section: rule.section,
    rule_review_status: rule.review_status,
    rule_temporal: rule.temporal,
    claim: rule.claim,
    // A citation is shown to readers only for a checked rule in force on the notice date.
    rule_cite: isRule ? `NYC Procurement Policy Board Rules, ${rule.section}` : null,
    source: "derived",
    evidence: evidenceText || null,
  };
}

/**
 * Select the response floor from the register.
 * Priority: accelerated (3 business days) > published competitive method
 * (sealed proposals 20, or 27 with §6-129; sealed bids 15, or 22 with §6-129).
 * The §6-129 variant needs a notice citation AND a participation requirement the
 * register does not rule out. Null outside Procurement solicitations and for any
 * other or missing published method.
 */
export function deriveResponseFloor({
  section_6_129 = null,
  accelerated = null,
  is_solicitation = false,
  method = null,
  participation_not_ruled_out = true,
  occurred_on = null,
} = {}) {
  if (accelerated?.present) {
    return floorPayload(RESPONSE_FLOOR_KIND.ACCELERATED, occurred_on, accelerated.evidence);
  }
  if (!is_solicitation || !method) return null;
  const withGoals = Boolean(section_6_129?.present) && participation_not_ruled_out;
  const kind = method === "competitive_sealed_proposal"
    ? (withGoals ? RESPONSE_FLOOR_KIND.COMPETITIVE_SEALED_PROPOSAL_SECTION_6_129 : RESPONSE_FLOOR_KIND.COMPETITIVE_SEALED_PROPOSAL)
    : method === "competitive_sealed_bid"
      ? (withGoals ? RESPONSE_FLOOR_KIND.COMPETITIVE_SEALED_BID_SECTION_6_129 : RESPONSE_FLOOR_KIND.COMPETITIVE_SEALED_BID)
      : null;
  if (!kind) return null;
  return floorPayload(kind, occurred_on, withGoals ? section_6_129.evidence : null);
}

/**
 * Full solicitation procurement-method payload for one notice row.
 * Empty markers are omitted (null) so consumers can treat presence as signal.
 */
export function extractSolicitationProcurementMethod(row = {}) {
  const text = noticeBody(row);
  return withRegisterFacts({
    section_6_129: extractSection6129(text),
    mwbe_noncompetitive_small_purchase: extractMwbeNoncompetitiveSmallPurchase(text, row),
    accelerated: extractAcceleratedProcurement(text, row),
  }, row);
}

/**
 * Add the register-derived fields (M/WBE requirement state, response floor) to
 * already-extracted notice markers. Used for fresh extraction and to upgrade a
 * stored v1 payload without re-reading or changing its published markers.
 */
export function withRegisterFacts(markers = {}, row = {}) {
  const section_6_129 = markers.section_6_129 || null;
  const mwbe_noncompetitive_small_purchase = markers.mwbe_noncompetitive_small_purchase || null;
  const accelerated = markers.accelerated || null;
  const is_solicitation = isProcurementSolicitation(row);
  const occurred_on = isoDate(row.start_date || row.occurred_on);
  const mwbe_requirement = is_solicitation
    ? mwbeRequirementState({ section_6_129, row, occurred_on })
    : null;
  const method = competitiveMethodFromLabel(row.selection_method_description || row.selection_method);
  const response_floor = deriveResponseFloor({
    section_6_129,
    accelerated,
    is_solicitation,
    method,
    participation_not_ruled_out: mwbe_requirement ? mwbe_requirement.participation_not_ruled_out : true,
    occurred_on,
  });

  return {
    schema: SOLICITATION_PROCUREMENT_METHOD_SCHEMA,
    section_6_129,
    mwbe_noncompetitive_small_purchase,
    accelerated,
    competitive_method: method,
    mwbe_requirement,
    response_floor,
  };
}
