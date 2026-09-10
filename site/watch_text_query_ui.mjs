/**
 * Procurement reader controls for a precise watch (`text_query` v1).
 *
 * The form is a small refinement, not a query workbench: a keyword field stays
 * the default, and labelled any/all, phrase, and exclusion controls open on
 * demand. This module is the only place those controls become an admitted
 * expression, so Following, prefs, confirmation, and tests cannot drift.
 *
 * Never expose JSON, predicate versions, or planner names in copy or labels.
 */

import {
  TEXT_QUERY_LIMITS,
  canonicalTextQuery,
  textQueryAdmissionSupported,
  textQueryEvaluationSupported,
  textQueryTokens,
  validateTextQuery,
} from "./watch_text_query.mjs";

export const TEXT_QUERY_UI = Object.freeze({
  schema: "cityscroll.watch_text_query_ui.v1",
  includeSlots: 4,
  requireSlots: 2,
  excludeSlots: 4,
  debounceMs: 400,
  previewLimit: 5,
  excludedLimit: 8,
});

const INCLUDE_MODE_ANY = "any";
const INCLUDE_MODE_ALL = "all";

function esc(value) {
  return String(value ?? "").replace(/[<>&"']/g, (char) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

function emptySlot() {
  return { value: "", phrase: false };
}

function normalizeSlot(raw) {
  if (!raw || typeof raw !== "object") return emptySlot();
  return {
    value: String(raw.value || "").trim(),
    phrase: raw.phrase === true || raw.phrase === "1" || raw.phrase === "on",
  };
}

export function emptyTextQueryControls() {
  return {
    includeMode: INCLUDE_MODE_ANY,
    include: Array.from({ length: TEXT_QUERY_UI.includeSlots }, emptySlot),
    requireOpen: false,
    requireMode: INCLUDE_MODE_ANY,
    require: Array.from({ length: TEXT_QUERY_UI.requireSlots }, emptySlot),
    exclude: Array.from({ length: TEXT_QUERY_UI.excludeSlots }, emptySlot),
  };
}

/** One typed field → a v1 atom. Multi-word values become phrases even without the checkbox. */
export function atomFromInput(value, asPhrase = false) {
  const tokens = textQueryTokens(value);
  if (!tokens.length) return null;
  if (asPhrase || tokens.length > 1) {
    return { kind: "phrase", value: tokens.join(" ") };
  }
  return { kind: "term", value: tokens[0] };
}

function atomsFromSlots(slots) {
  return (Array.isArray(slots) ? slots : [])
    .map((slot) => atomFromInput(slot?.value, slot?.phrase))
    .filter(Boolean)
    .slice(0, TEXT_QUERY_LIMITS.maxAlternativesPerGroup);
}

function groupsFromMode(slots, mode) {
  const atoms = atomsFromSlots(slots);
  if (!atoms.length) return [];
  if (mode === INCLUDE_MODE_ALL) {
    return atoms.map((atom) => [atom]).slice(0, TEXT_QUERY_LIMITS.maxPositiveGroups);
  }
  return [atoms];
}

/**
 * Build an admitted expression from labelled controls. Returns null when the
 * controls carry no constraint (caller then keeps the simple keyword field).
 */
export function textQueryFromControls(controls = {}, { structuredScope = false } = {}) {
  const state = {
    ...emptyTextQueryControls(),
    ...(controls && typeof controls === "object" ? controls : {}),
  };
  const requireActive = state.requireOpen || slotsHaveValue(state.require);
  const all = [
    ...groupsFromMode(state.include, state.includeMode),
    ...(requireActive ? groupsFromMode(state.require, state.requireMode) : []),
  ].slice(0, TEXT_QUERY_LIMITS.maxPositiveGroups);
  const none = atomsFromSlots(state.exclude).slice(0, TEXT_QUERY_LIMITS.maxExclusions);
  if (!all.length && !none.length) return { ok: true, canonical: null, present: false };
  const validated = validateTextQuery({ version: 1, all, none }, { structuredScope });
  if (!validated.ok) return { ...validated, present: true };
  return { ok: true, canonical: validated.canonical, present: Boolean(validated.canonical) };
}

function slotFromAtom(atom) {
  if (!atom || !atom.value) return emptySlot();
  return { value: atom.value, phrase: atom.kind === "phrase" };
}

function padSlots(slots, count) {
  const next = (Array.isArray(slots) ? slots : []).map(normalizeSlot);
  while (next.length < count) next.push(emptySlot());
  return next.slice(0, count);
}

/** Reverse a canonical expression into labelled control state. */
export function controlsFromTextQuery(expression) {
  const controls = emptyTextQueryControls();
  const canonical = canonicalTextQuery(expression, { structuredScope: true });
  if (!canonical) return controls;
  const groups = Array.isArray(canonical.all) ? canonical.all : [];
  if (groups.length === 1) {
    controls.includeMode = groups[0].length > 1 ? INCLUDE_MODE_ANY : INCLUDE_MODE_ANY;
    controls.include = padSlots(groups[0].map(slotFromAtom), TEXT_QUERY_UI.includeSlots);
  } else if (groups.length > 1 && groups.every((group) => group.length === 1)) {
    controls.includeMode = INCLUDE_MODE_ALL;
    controls.include = padSlots(groups.map((group) => slotFromAtom(group[0])), TEXT_QUERY_UI.includeSlots);
  } else if (groups.length) {
    controls.includeMode = groups[0].length > 1 ? INCLUDE_MODE_ANY : INCLUDE_MODE_ANY;
    controls.include = padSlots(groups[0].map(slotFromAtom), TEXT_QUERY_UI.includeSlots);
    if (groups.length > 1) {
      controls.requireOpen = true;
      const rest = groups.slice(1);
      if (rest.every((group) => group.length === 1)) {
        controls.requireMode = INCLUDE_MODE_ALL;
        controls.require = padSlots(rest.map((group) => slotFromAtom(group[0])), TEXT_QUERY_UI.requireSlots);
      } else {
        controls.requireMode = INCLUDE_MODE_ANY;
        controls.require = padSlots((rest[0] || []).map(slotFromAtom), TEXT_QUERY_UI.requireSlots);
      }
    }
  }
  controls.exclude = padSlots((canonical.none || []).map(slotFromAtom), TEXT_QUERY_UI.excludeSlots);
  return controls;
}

function quoteAtom(atom) {
  const text = String(atom?.value || "").trim();
  if (!text) return "";
  const quoted = `'${text.replace(/'/g, "’")}'`;
  return atom.kind === "phrase" && text.includes(" ")
    ? `the exact phrase ${quoted}`
    : quoted;
}

function joinOr(atoms) {
  const parts = atoms.map(quoteAtom).filter(Boolean);
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} or ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, or ${parts.at(-1)}`;
}

function joinAnd(parts) {
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
}

/**
 * Plain-language clauses for a canonical expression. Used by the Following
 * sentence, confirmation email, prefs, and digest labels.
 */
export function describeTextQuery(expression) {
  const canonical = canonicalTextQuery(expression, { structuredScope: true });
  if (!canonical) return null;
  const groupParts = (canonical.all || []).map((group) => joinOr(group)).filter(Boolean);
  const includeClause = groupParts.length ? `mentioning ${joinAnd(groupParts)}` : "";
  const excludeParts = (canonical.none || []).map(quoteAtom).filter(Boolean);
  const excludeClause = excludeParts.length ? `excluding ${joinAnd(excludeParts)}` : "";
  const summary = [includeClause, excludeClause].filter(Boolean).join(", ");
  return {
    includeClause,
    excludeClause,
    summary,
    groups: canonical.all || [],
    none: canonical.none || [],
  };
}

export function describeTextQuerySummary(expression) {
  return describeTextQuery(expression)?.summary || "";
}

function paramValue(params, name) {
  if (!params) return "";
  if (typeof params.get === "function") return String(params.get(name) || "");
  const value = params[name];
  if (Array.isArray(value)) return String(value[0] || "");
  return String(value || "");
}

function paramChecked(params, name) {
  const value = paramValue(params, name);
  return value === "1" || value === "on" || value === "true";
}

function readSlots(params, prefix, count) {
  const slots = [];
  for (let index = 0; index < count; index += 1) {
    slots.push({
      value: paramValue(params, `${prefix}${index}`),
      phrase: paramChecked(params, `${prefix}${index}p`),
    });
  }
  return slots;
}

/** Parse GET/form fields (`tq_*`) into control state. */
export function parseTextQueryControlParams(params) {
  const controls = emptyTextQueryControls();
  if (!params) return controls;
  const mode = paramValue(params, "tq_mode");
  controls.includeMode = mode === INCLUDE_MODE_ALL ? INCLUDE_MODE_ALL : INCLUDE_MODE_ANY;
  controls.include = padSlots(readSlots(params, "tq_i", TEXT_QUERY_UI.includeSlots), TEXT_QUERY_UI.includeSlots);
  controls.requireOpen = paramChecked(params, "tq_g2");
  const requireMode = paramValue(params, "tq_g2_mode");
  controls.requireMode = requireMode === INCLUDE_MODE_ALL ? INCLUDE_MODE_ALL : INCLUDE_MODE_ANY;
  controls.require = padSlots(readSlots(params, "tq_g2_", TEXT_QUERY_UI.requireSlots), TEXT_QUERY_UI.requireSlots);
  controls.exclude = padSlots(readSlots(params, "tq_x", TEXT_QUERY_UI.excludeSlots), TEXT_QUERY_UI.excludeSlots);
  return controls;
}

function slotsHaveValue(slots) {
  return (slots || []).some((slot) => String(slot?.value || "").trim());
}

export function textQueryControlsAreActive(controls) {
  if (!controls) return false;
  if (controls.includeMode === INCLUDE_MODE_ALL && slotsHaveValue(controls.include)) return true;
  if ((controls.include || []).filter((slot) => String(slot?.value || "").trim()).length > 1) return true;
  if ((controls.include || []).some((slot) => slot?.phrase && String(slot.value || "").trim())) return true;
  if (controls.requireOpen && slotsHaveValue(controls.require)) return true;
  if (slotsHaveValue(controls.exclude)) return true;
  return false;
}

/**
 * Combine the simple keyword field with labelled precise controls.
 * Keyword-only stays a legacy keyword watch. Any exclusion, extra alternative,
 * phrase, all-mode, or second group upgrades to `text_query` and drops keywords.
 */
export function watchFilterFromTextQueryControls({
  lens,
  filter = {},
  keyword = "",
  controls,
  structuredScope = false,
} = {}) {
  const next = { ...(filter && typeof filter === "object" ? filter : {}) };
  const active = textQueryControlsAreActive(controls);
  const seeded = controls ? { ...emptyTextQueryControls(), ...controls } : emptyTextQueryControls();
  if (!active && !String(keyword || "").trim() && !next.text_query) {
    delete next.keywords;
    delete next.text_query;
    return { filter: next, textQuery: null, usedTextQuery: false };
  }
  if (!active) {
    const trimmed = String(keyword || "").trim();
    if (trimmed) next.keywords = [trimmed];
    else delete next.keywords;
    delete next.text_query;
    return { filter: next, textQuery: null, usedTextQuery: false };
  }
  if (!seeded.include.some((slot) => String(slot.value || "").trim()) && String(keyword || "").trim()) {
    seeded.include = padSlots([{ value: keyword, phrase: false }, ...seeded.include], TEXT_QUERY_UI.includeSlots);
  }
  const hasStructuredScope = structuredScope || Boolean(
    next.agency || next.category || next.minAmount || next.maxAmount || next.noticeType
    || (Array.isArray(next.geographies) && next.geographies.length)
    || next.borough || next.boro || next.procurement_id
    || next.communityBoard || next.dateWindow || next.when || next.locationScope
    || next.communityDistrict || next.councilDistrict,
  );
  const built = textQueryFromControls(seeded, { structuredScope: hasStructuredScope });
  delete next.keywords;
  if (!built.ok) {
    return { filter: next, textQuery: null, usedTextQuery: true, error: built };
  }
  if (built.canonical) next.text_query = built.canonical;
  else delete next.text_query;
  return { filter: next, textQuery: built.canonical, usedTextQuery: Boolean(built.canonical) };
}

export function textQueryUiSupported(lens) {
  return textQueryAdmissionSupported(lens) && textQueryEvaluationSupported(lens);
}

function fieldId(name) {
  return `following-precise-${String(name).replace(/_/g, "-")}`;
}

function slotInput(name, slot, { phraseLabel, termLabel }) {
  const value = esc(slot?.value || "");
  const checked = slot?.phrase ? " checked" : "";
  const id = fieldId(name);
  const phraseId = fieldId(`${name}p`);
  return `<div class="following-precise-entry">
    <label class="following-precise-term" for="${id}"><span data-i18n="following_term_label">${esc(termLabel)}</span>
    <input id="${id}" name="${esc(name)}" value="${value}" autocomplete="off" data-following-precise-input></label>
    <label class="following-precise-phrase" for="${phraseId}"><input id="${phraseId}" type="checkbox" name="${esc(name)}p" value="1"${checked} data-following-precise-phrase> <span data-i18n="following_treat_phrase">${esc(phraseLabel)}</span></label>
  </div>`;
}

function modeSelect(name, mode, { anyLabel, allLabel }) {
  const anyOn = mode !== INCLUDE_MODE_ALL;
  const id = fieldId(name);
  return `<select id="${id}" name="${esc(name)}" data-following-precise-mode aria-label="${esc(anyLabel)}">
    <option value="any"${anyOn ? " selected" : ""} data-i18n="following_include_any">${esc(anyLabel)}</option>
    <option value="all"${anyOn ? "" : " selected"} data-i18n="following_include_all">${esc(allLabel)}</option>
  </select>`;
}

/** Named disclosure control. The span is the visible name; aria-label stays when CSS uses flex. */
function disclosureSummary(i18nKey, label) {
  const text = esc(label);
  return `<summary data-i18n-aria="${esc(i18nKey)}" aria-label="${text}"><span data-i18n="${esc(i18nKey)}">${text}</span></summary>`;
}

/**
 * Progressive matching controls for a supported procurement watch. Hidden for
 * other lenses. Second required group and extra slots stay behind disclosure.
 */
export function textQueryControlsHtml({
  lens,
  filter = {},
  controls,
  open = false,
} = {}) {
  if (!textQueryUiSupported(lens)) return "";
  if (filter?.matter_ref || filter?.provision_id) return "";
  const state = controls || controlsFromTextQuery(filter?.text_query);
  const active = textQueryControlsAreActive(state) || Boolean(filter?.text_query);
  const detailsOpen = open || active ? " open" : "";
  const requireOpen = state.requireOpen || (state.require || []).some((slot) => slot.value) ? " open" : "";
  const termSlot = (name, slot) => slotInput(name, slot, {
    phraseLabel: "Treat this as an exact phrase",
    termLabel: "Word or phrase",
  });
  const includeFields = state.include.slice(0, 2).map((slot, index) => termSlot(`tq_i${index}`, slot)).join("");
  const extraInclude = state.include.slice(2).map((slot, index) => termSlot(`tq_i${index + 2}`, slot)).join("");
  const requireFields = state.require.map((slot, index) => termSlot(`tq_g2_${index}`, slot)).join("");
  const excludeFields = state.exclude.slice(0, 2).map((slot, index) => termSlot(`tq_x${index}`, slot)).join("");
  const extraExclude = state.exclude.slice(2).map((slot, index) => termSlot(`tq_x${index + 2}`, slot)).join("");
  return `<details class="following-precise"${detailsOpen} data-following-precise>
    ${disclosureSummary("following_match_precisely", "Match more precisely")}
    <div class="following-precise-body">
      <fieldset class="following-precise-include">
        <legend data-i18n="following_include_legend">Include</legend>
        <div class="following-precise-mode-row">
          <span data-i18n="following_include_of">of these</span>
          ${modeSelect("tq_mode", state.includeMode, {
            anyLabel: "any of these",
            allLabel: "all of these",
          })}
        </div>
        ${includeFields}
        <details class="following-precise-more"${state.include.slice(2).some((slot) => slot.value) ? " open" : ""}>
          ${disclosureSummary("following_more_alternatives", "More alternatives")}
          ${extraInclude}
        </details>
      </fieldset>
      <details class="following-precise-require"${requireOpen}>
        ${disclosureSummary("following_also_require", "Also require")}
        <input type="hidden" name="tq_g2" value="${requireOpen ? "1" : "0"}" data-following-precise-require-flag>
        <div class="following-precise-mode-row">
          ${modeSelect("tq_g2_mode", state.requireMode, {
            anyLabel: "any of these",
            allLabel: "all of these",
          })}
        </div>
        ${requireFields}
      </details>
      <fieldset class="following-precise-exclude">
        <legend data-i18n="following_exclude_label">Exclude these words or phrases</legend>
        ${excludeFields}
        <details class="following-precise-more"${state.exclude.slice(2).some((slot) => slot.value) ? " open" : ""}>
          ${disclosureSummary("following_more_exclusions", "More exclusions")}
          ${extraExclude}
        </details>
      </fieldset>
    </div>
  </details>`;
}

export function previewGenerationMatches(currentSeq, responseSeq) {
  const current = Number(currentSeq);
  const response = Number(responseSeq);
  if (!Number.isInteger(current) || current < 1) return true;
  if (!Number.isInteger(response) || response < 1) return false;
  return current === response;
}

export function previewQueryRevision(filter) {
  const canonical = canonicalTextQuery(filter?.text_query, { structuredScope: true });
  if (!canonical) return null;
  return `qr:v1:${JSON.stringify(canonical)}`;
}

export function previewExhaustiveZeroForbidden(status) {
  return status === "incomplete" || status === "unavailable";
}

export { INCLUDE_MODE_ANY, INCLUDE_MODE_ALL };
