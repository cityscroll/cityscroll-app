// Pure extraction of solicitation procurement-method markers from City Record
// notice prose (and publisher selection_method when present).
//
// Targets:
//   - Admin Code §6-129 M/WBE participation-goal citations (+ optional goal %)
//   - M/WBE Noncompetitive Small Purchase (PPB §3-08)
//   - Accelerated procurement timing markers (PPB §3-07)
//   - Derived response floor with rule source:
//       20 calendar days  — default competitive advertising minimum
//       27 calendar days  — when §6-129 goals apply
//       3 business days   — accelerated procurement
//
// Label-bound: only explicit citations and method names become structured
// fields. Response floor is derived, never invented from calendar math on
// start/due dates. UI chips / list badges consume this payload (site/mwbe_goal_surface.mjs).

import { plainText } from "./text_clean.mjs";

export const SOLICITATION_PROCUREMENT_METHOD_SCHEMA =
  "cityscroll.solicitation_procurement_method.v1";

/** Stable kind keys for the derived advertising / response floor. */
export const RESPONSE_FLOOR_KIND = Object.freeze({
  DEFAULT_COMPETITIVE: "default_competitive_20_calendar_days",
  SECTION_6_129: "section_6_129_27_calendar_days",
  ACCELERATED: "accelerated_3_business_days",
});

const RULE_SOURCE = Object.freeze({
  DEFAULT_COMPETITIVE: {
    id: "ppb_competitive_default_20_calendar_days",
    cite:
      "NYC Procurement Policy Board Rules — competitive sealed bid/proposal advertising minimum (20 calendar days)",
  },
  SECTION_6_129: {
    id: "admin_code_6_129_extended_27_calendar_days",
    cite:
      "NYC Admin. Code §6-129 participation goals — PPB competitive advertising minimum (27 calendar days)",
  },
  ACCELERATED: {
    id: "ppb_3_07_accelerated_3_business_days",
    cite:
      "NYC Procurement Policy Board Rules §3-07 Accelerated Procurement (3 business days)",
  },
});

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

/**
 * Derive the applicable response floor.
 * Priority: accelerated (3 business days) > §6-129 (27 calendar) > default 20
 * calendar for Procurement solicitations. Null outside that universe.
 */
export function deriveResponseFloor({
  section_6_129 = null,
  accelerated = null,
  is_solicitation = false,
} = {}) {
  if (accelerated?.present) {
    const rule = RULE_SOURCE.ACCELERATED;
    return {
      kind: RESPONSE_FLOOR_KIND.ACCELERATED,
      days: 3,
      day_unit: "business_days",
      rule_source: rule.id,
      rule_cite: rule.cite,
      source: "derived",
      evidence: accelerated.evidence || null,
    };
  }
  if (section_6_129?.present) {
    const rule = RULE_SOURCE.SECTION_6_129;
    return {
      kind: RESPONSE_FLOOR_KIND.SECTION_6_129,
      days: 27,
      day_unit: "calendar_days",
      rule_source: rule.id,
      rule_cite: rule.cite,
      source: "derived",
      evidence: section_6_129.evidence || null,
    };
  }
  if (is_solicitation) {
    const rule = RULE_SOURCE.DEFAULT_COMPETITIVE;
    return {
      kind: RESPONSE_FLOOR_KIND.DEFAULT_COMPETITIVE,
      days: 20,
      day_unit: "calendar_days",
      rule_source: rule.id,
      rule_cite: rule.cite,
      source: "derived",
      evidence: null,
    };
  }
  return null;
}

/**
 * Full solicitation procurement-method payload for one notice row.
 * Empty markers are omitted (null) so consumers can treat presence as signal.
 */
export function extractSolicitationProcurementMethod(row = {}) {
  const text = noticeBody(row);
  const is_solicitation = isProcurementSolicitation(row);
  const section_6_129 = extractSection6129(text);
  const mwbe_noncompetitive_small_purchase =
    extractMwbeNoncompetitiveSmallPurchase(text, row);
  const accelerated = extractAcceleratedProcurement(text, row);
  const response_floor = deriveResponseFloor({
    section_6_129,
    accelerated,
    is_solicitation,
  });

  return {
    schema: SOLICITATION_PROCUREMENT_METHOD_SCHEMA,
    section_6_129,
    mwbe_noncompetitive_small_purchase,
    accelerated,
    response_floor,
  };
}
