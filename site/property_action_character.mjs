/** Deterministic, receipt-backed action character for Property records. */

import { cleanNoticeText } from "./text_clean.mjs";
import { classifyPropertyPattern, propertyPatternText } from "./property_notice_patterns.mjs";

export const PROPERTY_ACTION_CHARACTER_SCHEMA_VERSION = 1;
export const PROPERTY_ACTION_CHARACTERS = Object.freeze([
  "marketplace", "participation", "relief", "historical_result",
]);

const PATTERN_CHARACTER = Object.freeze({
  pending_destruction: "relief",
  unclaimed_property: "relief",
  forest_timber_sale: "marketplace",
  lease_or_real_property_rfp: "marketplace",
  surplus_auction: "marketplace",
  direct_property_sale: "marketplace",
  udaap: "participation",
  acquisition_or_easement: "participation",
  disposition: "participation",
});
const RESULT_SIGNAL = /\b(?:winning bidders?|auction results?|apparent highest bidders?|award(?:ed|ees?)|convey(?:ance|ed|s|ing)|result(?:s)? of the auction)\b/i;

function sourceFields(row) {
  return ["short_title", "additional_description_1", "additional_description_2", "additional_description_3", "other_info_1", "other_info_2", "other_info_3", "printout_1", "printout_2", "printout_3"]
    .map((field) => ({ field, text: cleanNoticeText(row?.[field]) })).filter((entry) => entry.text);
}

function resultReceipt(row) {
  for (const source of sourceFields(row)) {
    const match = RESULT_SIGNAL.exec(source.text);
    if (match) return { field: source.field, start: match.index, end: match.index + match[0].length, text: match[0], normalization: "clean_notice_text" };
  }
  return null;
}

export function classifyPropertyActionCharacter(row = {}) {
  const pattern = classifyPropertyPattern(row);
  const result = resultReceipt(row);
  const patternCharacter = PATTERN_CHARACTER[pattern] || null;
  const outcomeStage = row?.disposition_stage === "award_or_conveyance";
  const character = result || outcomeStage ? "historical_result" : patternCharacter;
  return {
    action_character: character,
    action_character_receipt: character ? {
      schema_version: PROPERTY_ACTION_CHARACTER_SCHEMA_VERSION,
      basis: result ? "explicit_result_phrase" : outcomeStage ? "structured_award_or_conveyance_stage" : "mutually_exclusive_property_pattern",
      pattern,
      source: result || { field: "pattern", text: propertyPatternText(row) },
    } : null,
    action_character_pattern: pattern,
  };
}

function rowsForEntry(entry) {
  if (!entry || typeof entry !== "object") return [];
  if (entry.kind === "cluster") return (entry.members || []).flatMap(rowsForEntry);
  if (Array.isArray(entry.members) && entry.members.length) return entry.members.filter(Boolean);
  return entry.primary ? [entry.primary] : (entry.request_id || entry.short_title || entry.section_name ? [entry] : []);
}

export function stampPropertyActionCharacters(entries = [], options = {}) {
  const stamped = (Array.isArray(entries) ? entries : []).map((entry) => {
    const rows = rowsForEntry(entry).length ? rowsForEntry(entry) : [entry];
    rows.forEach((row) => Object.assign(row, classifyPropertyActionCharacter(row)));
    const chars = rows.map((row) => row.action_character).filter(Boolean);
    const character = chars[0] && chars.every((value) => value === chars[0]) ? chars[0] : null;
    return { ...entry, ...(character ? { action_character: character, action_character_receipt: rows[0].action_character_receipt } : {}) };
  });
  const rawRows = stamped.flatMap(rowsForEntry);
  const distribution = Object.fromEntries(PROPERTY_ACTION_CHARACTERS.map((character) => [character, 0]));
  rawRows.forEach((row) => { if (row.action_character) distribution[row.action_character] += 1; });
  const stampedCount = rawRows.filter((row) => row.action_character).length;
  return { entries: stamped, coverage: {
    schema_version: PROPERTY_ACTION_CHARACTER_SCHEMA_VERSION,
    total: rawRows.length, stamped: stampedCount, unstamped: rawRows.length - stampedCount,
    distribution, basis: options.basis || "property_record_pattern_projection",
  } };
}

export function propertyActionCharacterLead(entry, row, helpers = {}) {
  const character = entry?.action_character || row?.action_character;
  if (!character) return "";
  const lifecycle = row?.property_reader_actions?.lifecycle || {};
  const clock = character === "historical_result"
    ? (lifecycle.closed_at || entry?.close_date || null)
    : (lifecycle.action_by || lifecycle.program_valid_through || entry?.close_date || null);
  const labels = { marketplace: "property_action_character_marketplace", participation: "property_action_character_participation", relief: "property_action_character_relief", historical_result: "property_action_character_historical_result" };
  const esc = helpers.escape || ((value) => String(value || ""));
  const label = helpers.translate ? helpers.translate(labels[character] || "") : labels[character] || "";
  const clockText = clock ? ` · ${(helpers.formatDate || String)(clock, { dateOnly: true })}` : "";
  return `<p class="property-action-character-lead" data-action-character="${esc(character)}"><strong>${esc(label)}</strong>${esc(clockText)}</p>`;
}
