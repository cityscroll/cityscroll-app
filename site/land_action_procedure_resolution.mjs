/**
 * Per-action land procedure resolution (uniform | mixed | unknown).
 *
 * Project-level `ulurp_non` and semicolon-delimited `actions` stay compatibility
 * fields. This projector adds `land_actions[]` without minting public action
 * routes or copying one action's profile onto siblings.
 */

import { LAND_USE_ACTION_CODE_FAMILY } from "./land_use_action_type.mjs";
import {
  LAND_PROCEDURE_PROFILE_REGISTRY,
  LAND_PROCEDURE_PROFILE_REGISTRY_VERSION,
} from "./land_procedure_profiles.mjs";
import { isPlausibleUlurpKey } from "./ulurp_tokens.mjs";

export const LAND_ACTION_PROCEDURE_SCHEMA = "cityscroll.land_action_procedure_resolution.v1";
export const LAND_ACTION_PROCEDURE_RESOLUTIONS = Object.freeze(["uniform", "mixed", "unknown"]);

const ACTION_CODES = Object.freeze(
  Object.keys(LAND_USE_ACTION_CODE_FAMILY).sort((left, right) => right.length - left.length),
);
const ACTION_CODE_SET = new Set(ACTION_CODES);
const CEQR_RE = /^\d{2}[A-Z]{3}\d{3}[A-Z]$/;
const PROFILE_BY_ID = new Map(
  (LAND_PROCEDURE_PROFILE_REGISTRY.profiles || []).map((profile) => [profile.procedure_id, profile]),
);

function clean(value) {
  if (value == null) return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  return text || null;
}

function clone(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function isRichActionArray(value) {
  return Array.isArray(value) && value.length > 0
    && value.every((item) => item && typeof item === "object" && !Array.isArray(item));
}

function firstRichActions(...candidates) {
  for (const candidate of candidates) {
    if (isRichActionArray(candidate)) return candidate;
  }
  return null;
}

function firstDefined(...candidates) {
  for (const candidate of candidates) {
    if (candidate != null && candidate !== "") return candidate;
  }
  return null;
}

/**
 * Merge project/action evidence from every shape callers pass in: a plain
 * warehouse/worker-shaped row, a live zap-outcomes record (top-level ZAP API
 * fields plus `.open_data`), or an authority/affected-body input bag
 * (`.project` / `.source` / `.outcomes`). Open Data's scalar `actions` stays
 * the canonical action-type list; a richer array-of-objects `actions` (the
 * ZAP API's exact per-action identifiers) is preserved separately as
 * `zap_actions` instead of being silently overwritten by that scalar. See
 * the ldp-29 evidence precedence: exact ZAP API action object, then exact
 * Open Data action/application pair, then publisher `ulurp_non`, then
 * identifier prefix as secondary/conflict evidence only.
 */
export function mergeLandActionEvidence(input = {}) {
  if (!input || typeof input !== "object") return {};
  const openData = input.open_data && typeof input.open_data === "object" ? input.open_data : null;
  const source = input.source && typeof input.source === "object" ? input.source : null;
  const project = input.project && typeof input.project === "object" ? input.project : null;
  const outcomes = input.outcomes && typeof input.outcomes === "object" ? input.outcomes : null;
  const base = openData || source || project || input;

  const zapActions = firstRichActions(
    input.zap_actions,
    input.actions,
    outcomes?.actions,
    project?.actions,
    openData?.zap_actions,
    source?.actions,
  );

  const merged = { ...input, ...base };
  merged.actions = firstDefined(
    !isRichActionArray(base.actions) ? base.actions : null,
    !isRichActionArray(input.actions) ? input.actions : null,
    !isRichActionArray(project?.actions) ? project?.actions : null,
  );
  if (zapActions) {
    merged.zap_actions = zapActions;
    if (merged.actions == null) {
      merged.actions = zapActions
        .map((item) => clean(item?.action || item?.action_code || item?.code))
        .filter(Boolean);
    }
  }
  return merged;
}

function splitList(value) {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (typeof item === "string") return [clean(item)].filter(Boolean);
      if (item && typeof item === "object") {
        return [clean(item.action || item.code || item.action_code || item.ulurp_number || item.application_id)].filter(Boolean);
      }
      return [];
    });
  }
  if (typeof value !== "string") return [];
  return value.split(/[;,]/).map(clean).filter(Boolean);
}

function actionCodeFromUlurpSuffix(suffix) {
  const text = String(suffix || "").toUpperCase();
  for (const code of ACTION_CODES) {
    if (text.startsWith(code) && (text.length === code.length || text.length === code.length + 1)) {
      return code;
    }
  }
  return null;
}

function parseUlurpIdentifier(raw) {
  const original = clean(raw);
  if (!original) return null;
  const compact = original.toUpperCase().replace(/\s+/g, "");
  if (!isPlausibleUlurpKey(compact)) return null;
  const match = compact.match(/^([A-Z])?(\d{6})([A-Z]{2,4})$/);
  if (!match) return null;
  return {
    raw: original,
    compact,
    type: match[1] || null,
    body: match[2],
    suffix: match[3],
    action_code: actionCodeFromUlurpSuffix(match[3]),
    kind: "ulurp_application",
    source_field: "ulurp_numbers",
  };
}

function parseCeqrIdentifier(raw) {
  const original = clean(raw);
  if (!original) return null;
  const compact = original.toUpperCase().replace(/\s+/g, "");
  if (!CEQR_RE.test(compact)) return null;
  return {
    raw: original,
    compact,
    type: null,
    action_code: "EAS",
    kind: "ceqr",
    source_field: "ceqr_number",
  };
}

function publisherProcedureId(value) {
  const normalized = clean(value)?.toUpperCase().replace(/[\s_]+/g, "-");
  if (normalized === "ULURP") return "ulurp_197c";
  if (normalized === "ELURP") return "elurp_197e";
  if (normalized === "NON-ULURP" || normalized === "NONULURP") return "non_ulurp";
  return null;
}

function procedureFromTypeLetter(type) {
  if (type === "C") return "ulurp_197c";
  if (type === "N") return "non_ulurp";
  return null;
}

function projectProcedureAdmissible(identifiers, ulurpNon) {
  const mapped = publisherProcedureId(ulurpNon);
  if (!mapped) return null;
  const types = new Set(identifiers.map((item) => item.type).filter(Boolean));
  if (types.has("C") && types.has("N")) return null;
  if (types.has("C") && mapped !== "ulurp_197c") return null;
  if (types.has("N") && mapped !== "non_ulurp") return null;
  return mapped;
}

function pairByActionCode(tokens, identifiers) {
  const byCode = new Map();
  for (const identifier of identifiers) {
    if (!identifier.action_code) continue;
    if (!byCode.has(identifier.action_code)) byCode.set(identifier.action_code, []);
    byCode.get(identifier.action_code).push(identifier);
  }
  const counts = new Map();
  for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);

  return tokens.map((token, index) => {
    const pool = byCode.get(token) || [];
    const expected = counts.get(token) || 0;
    if (!pool.length) {
      return { token, identifier: null, unmatched_reason: "missing_application_id" };
    }
    if (expected !== pool.length) {
      return { token, identifier: null, unmatched_reason: "identifier_count_mismatch" };
    }
    const offset = tokens.slice(0, index).filter((item) => item === token).length;
    return { token, identifier: pool[offset] || null, unmatched_reason: pool[offset] ? null : "missing_application_id" };
  });
}

function normalizeIdentifierForCompare(raw) {
  return String(raw || "").toUpperCase().replace(/\s+/g, "");
}

/** ZAP API's own per-action objects already label `action` explicitly — no suffix guessing needed. */
function normalizeZapActionEntries(rawActions) {
  if (!Array.isArray(rawActions)) return [];
  return rawActions.map((item) => {
    if (!item || typeof item !== "object") return null;
    const actionType = clean(item.action || item.action_code || item.code)?.toUpperCase();
    if (!actionType) return null;
    const identifierRaw = clean(item.ulurp_number || item.application_id);
    return { action_type: actionType, identifier_raw: identifierRaw, status_raw: clean(item.status) };
  }).filter(Boolean);
}

/** Pair each canonical action-type token with the next unconsumed ZAP entry of that type. */
function pairZapEntriesByActionType(tokens, entries) {
  const byType = new Map();
  for (const entry of entries) {
    if (!byType.has(entry.action_type)) byType.set(entry.action_type, []);
    byType.get(entry.action_type).push(entry);
  }
  const offsets = new Map();
  return tokens.map((token) => {
    const pool = byType.get(token) || [];
    const offset = offsets.get(token) || 0;
    offsets.set(token, offset + 1);
    return { token, entry: pool[offset] || null };
  });
}

function sourceVintage(row, opts = {}) {
  return clean(
    opts.sourceVintage
      || opts.asOf
      || row.environmental_projection?.as_of
      || row.environmental_projection?.cutoff
      || row.materialized_at
      || null,
  );
}

function profileFor(procedureId) {
  return PROFILE_BY_ID.get(procedureId) || null;
}

function unresolvedAction({
  actionType,
  applicationId = null,
  reason,
  sourceFields,
  vintage,
  evidence,
}) {
  return {
    application_id: applicationId,
    action_type: actionType,
    procedure_id: null,
    status: "unresolved",
    source_fields: sourceFields,
    source_vintage: vintage,
    profile_version: null,
    unresolved_reason: reason,
    aliases: [],
    evidence,
    href: null,
  };
}

function resolvedAction({
  actionType,
  applicationId,
  procedureId,
  sourceFields,
  vintage,
  evidence,
  method,
  aliases = [],
}) {
  const profile = profileFor(procedureId);
  return {
    application_id: applicationId,
    action_type: actionType,
    procedure_id: procedureId,
    status: "resolved",
    source_fields: sourceFields,
    source_vintage: vintage,
    profile_version: profile ? LAND_PROCEDURE_PROFILE_REGISTRY_VERSION : null,
    unresolved_reason: null,
    aliases,
    evidence: {
      ...evidence,
      selection_method: method,
      profile_id: profile?.procedure_id || null,
      profile_label: profile?.label || null,
    },
    href: null,
  };
}

function projectResolution(actions) {
  const landUse = actions.filter((action) => ACTION_CODE_SET.has(String(action.action_type || "").toUpperCase()));
  const resolvedIds = [...new Set(
    landUse
      .filter((action) => action.status === "resolved" && action.procedure_id)
      .map((action) => action.procedure_id),
  )];
  if (!resolvedIds.length) return "unknown";
  if (resolvedIds.length > 1) return "mixed";
  if (landUse.some((action) => action.status !== "resolved" || action.procedure_id !== resolvedIds[0])) {
    return "mixed";
  }
  return "uniform";
}

/**
 * Resolve each source action independently from supported action/application
 * facts. Title, address, applicant, milestone, and action-count never select
 * a procedure.
 */
export function resolveLandActionProcedures(input = {}, opts = {}) {
  const row = mergeLandActionEvidence(input);
  const vintage = sourceVintage(row, opts);
  const projectId = clean(row.project_id);
  const actionTypes = splitList(row.actions).map((token) => token.toUpperCase());
  const ulurpIdentifiers = splitList(row.ulurp_numbers).map(parseUlurpIdentifier).filter(Boolean);
  const ceqr = parseCeqrIdentifier(row.ceqr_number);
  const easIdentifiers = ceqr ? [ceqr] : [];
  const zapEntries = normalizeZapActionEntries(row.zap_actions);
  const publisherId = publisherProcedureId(row.ulurp_non);
  // An explicit publisher ELURP declaration is never vetoed by a C/N identifier
  // prefix conflict — that admissibility check exists for ULURP/Non-ULURP only.
  const explicitElurp = publisherId === "elurp_197e";
  const projectProcedure = explicitElurp ? null : projectProcedureAdmissible(ulurpIdentifiers, row.ulurp_non);
  const openDataRecordId = projectId ? `zap-projects-open-data:${projectId}` : null;
  const zapRecordId = projectId ? `zap-api-outcomes:${projectId}` : null;
  const zapVintage = clean(opts.zapVintage || row.generated_at || vintage);

  const openDataPairs = pairByActionCode(actionTypes, ulurpIdentifiers);
  const easPairs = pairByActionCode(actionTypes, easIdentifiers);
  const zapPairs = pairZapEntriesByActionType(actionTypes, zapEntries);

  const land_actions = actionTypes.map((actionType, index) => {
    const normalized = actionType;
    const openPair = openDataPairs[index];
    const easPair = easPairs[index];
    const openIdentifier = openPair?.identifier || null;
    const easIdentifier = normalized === "EAS" ? easPair?.identifier : null;
    const zapIdentifierRaw = zapPairs[index]?.entry?.identifier_raw || null;

    // Evidence precedence #1/#2: the exact ZAP API action object wins for
    // action type and application identifier; the exact Open Data pair is
    // the fallback when ZAP API has no entry for this action.
    const applicationId = zapIdentifierRaw || openIdentifier?.raw || easIdentifier?.raw || null;
    const identifierParsed = zapIdentifierRaw
      ? parseUlurpIdentifier(zapIdentifierRaw)
      : (openIdentifier || easIdentifier || null);
    const identifierSourceField = zapIdentifierRaw
      ? "zap_api.actions[].ulurp_number"
      : (openIdentifier?.source_field || easIdentifier?.source_field || null);
    const identifierSourceSystem = zapIdentifierRaw
      ? "zap-api-outcomes"
      : (applicationId ? "zap-projects-open-data" : null);
    const identifierSourceRecordId = identifierSourceSystem === "zap-api-outcomes" ? zapRecordId : openDataRecordId;
    const identifierVintage = identifierSourceSystem === "zap-api-outcomes" ? zapVintage : vintage;

    const aliases = [];
    if (
      zapIdentifierRaw
      && openIdentifier?.raw
      && normalizeIdentifierForCompare(openIdentifier.raw) !== normalizeIdentifierForCompare(zapIdentifierRaw)
    ) {
      aliases.push({
        application_id: openIdentifier.raw,
        source_system: "zap-projects-open-data",
        source_field: "ulurp_numbers",
        source_record_id: openDataRecordId,
        source_vintage: vintage,
        reason: "narrower_open_data_identifier_retained_as_alias",
      });
    }

    const sourceFields = ["actions"];
    if (identifierSourceField === "zap_api.actions[].ulurp_number") sourceFields.push("zap_actions");
    else if (identifierSourceField) sourceFields.push(identifierSourceField);

    const evidence = {
      source_system: identifierSourceSystem || "zap-projects-open-data",
      source_record_id: identifierSourceRecordId,
      source_vintage: identifierVintage,
      action_source_field: "actions",
      action_token: actionType,
      identifier_source_field: identifierSourceField,
      identifier_raw: applicationId,
      identifier_type: identifierParsed?.type || null,
      identifier_kind: identifierParsed?.kind || null,
    };

    if (!ACTION_CODE_SET.has(normalized)) {
      if (normalized === "EAS" && applicationId) sourceFields.push("ceqr_number");
      return unresolvedAction({
        actionType,
        applicationId,
        reason: "unsupported_action_token",
        sourceFields,
        vintage,
        evidence,
      });
    }

    if (!applicationId) {
      return unresolvedAction({
        actionType,
        applicationId: null,
        reason: openPair?.unmatched_reason || "missing_application_id",
        sourceFields,
        vintage,
        evidence,
      });
    }

    // ZAP API already labels its own action explicitly; the cross-check
    // against a derived-from-suffix action code only applies to identifiers
    // sourced from Open Data's separate action/application lists.
    if (!zapIdentifierRaw && identifierParsed?.action_code && identifierParsed.action_code !== normalized) {
      return unresolvedAction({
        actionType,
        applicationId: null,
        reason: "identifier_action_mismatch",
        sourceFields: ["actions"],
        vintage,
        evidence: { ...evidence, identifier_raw: null, identifier_source_field: null },
      });
    }

    const typeLetter = identifierParsed?.type || null;
    // Negative rule: identifier prefix is secondary/conflict evidence only —
    // it must never override an explicit publisher ELURP declaration.
    if (!explicitElurp && typeLetter) {
      const fromType = procedureFromTypeLetter(typeLetter);
      if (fromType) {
        return resolvedAction({
          actionType,
          applicationId,
          procedureId: fromType,
          sourceFields,
          vintage,
          evidence,
          method: "ulurp_type_letter_exact",
          aliases,
        });
      }
      return unresolvedAction({
        actionType,
        applicationId,
        reason: "unsupported_procedure_prefix",
        sourceFields,
        vintage,
        evidence,
      });
    }

    if (!publisherId) {
      return unresolvedAction({
        actionType,
        applicationId,
        reason: "missing_procedure_evidence",
        sourceFields,
        vintage,
        evidence,
      });
    }

    const procedureId = explicitElurp ? publisherId : projectProcedure;
    if (!procedureId) {
      return unresolvedAction({
        actionType,
        applicationId,
        reason: "missing_procedure_evidence",
        sourceFields,
        vintage,
        evidence,
      });
    }

    sourceFields.push("ulurp_non");
    const rejected = explicitElurp && typeLetter
      ? [{
          fact: "procedure_id",
          value: procedureFromTypeLetter(typeLetter),
          source_system: "identifier_prefix",
          source_field: identifierSourceField,
          source_record_id: identifierSourceRecordId,
          source_vintage: identifierVintage,
          reason: "identifier_prefix_cannot_override_explicit_elurp",
        }]
      : [];
    return resolvedAction({
      actionType,
      applicationId,
      procedureId,
      sourceFields,
      vintage,
      evidence: { ...evidence, rejected },
      method: explicitElurp ? "publisher_ulurp_non_explicit_elurp" : "publisher_ulurp_non_with_matching_identifier",
      aliases,
    });
  });

  return {
    schema: LAND_ACTION_PROCEDURE_SCHEMA,
    project_id: projectId,
    procedure_resolution: projectResolution(land_actions),
    land_actions,
    raw: {
      actions: row.actions ?? null,
      ulurp_numbers: row.ulurp_numbers ?? null,
      ulurp_non: row.ulurp_non ?? null,
    },
  };
}

export function stampLandActionProcedureResolution(row, opts = {}) {
  if (!row || typeof row !== "object") return row;
  const resolution = resolveLandActionProcedures(row, opts);
  row.land_actions = clone(resolution.land_actions);
  row.procedure_resolution = resolution.procedure_resolution;
  return row;
}

export function landActionProcedureLabelKey(action = {}) {
  if (action.status !== "resolved") return "land_action_procedure_unresolved";
  if (action.procedure_id === "ulurp_197c") return "land_action_procedure_ulurp";
  if (action.procedure_id === "elurp_197e") return "land_action_procedure_elurp";
  if (action.procedure_id === "non_ulurp") return "land_action_procedure_non_ulurp";
  return "land_action_procedure_unresolved";
}

export function landActionHasProfileSummary(action = {}) {
  return action.status === "resolved" && Boolean(profileFor(action.procedure_id));
}

export function landActionProcedurePanelHTML(row, { t, escape } = {}) {
  const translate = typeof t === "function" ? t : (key) => key;
  const esc = typeof escape === "function" ? escape : (value) => String(value ?? "");
  const resolution = resolveLandActionProcedures(row);
  if (!resolution.land_actions.length) return "";
  const heading = resolution.procedure_resolution === "mixed"
    ? translate("land_multiple_review_tracks")
    : translate("land_action_tracks_label");
  const items = resolution.land_actions.map((action) => {
    const bits = [action.action_type];
    if (action.application_id) bits.push(action.application_id);
    bits.push(translate(landActionProcedureLabelKey(action)));
    const summary = landActionHasProfileSummary(action)
      ? ` data-profile-version="${esc(action.profile_version || "")}"`
      : "";
    return `<li data-action-type="${esc(action.action_type)}" data-application-id="${esc(action.application_id || "")}" data-procedure-id="${esc(action.procedure_id || "")}" data-status="${esc(action.status)}"${summary}>${esc(bits.join(" · "))}</li>`;
  }).join("");
  return `<div class="land-action-tracks" data-procedure-resolution="${esc(resolution.procedure_resolution)}" data-land-action-tracks="1"><p class="land-action-tracks-heading">${esc(heading)}</p><ul class="land-action-track-list">${items}</ul></div>`;
}

export function landMultipleReviewTracksHTML(row, { t, escape } = {}) {
  const resolution = resolveLandActionProcedures(row);
  if (resolution.procedure_resolution !== "mixed") return "";
  const translate = typeof t === "function" ? t : (key) => key;
  const esc = typeof escape === "function" ? escape : (value) => String(value ?? "");
  return `<span class="tag land-multiple-review-tracks" data-procedure-resolution="mixed">${esc(translate("land_multiple_review_tracks"))}</span>`;
}
