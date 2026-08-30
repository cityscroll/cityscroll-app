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

function sourceBag(input = {}) {
  const source = input.source && typeof input.source === "object" ? input.source : input;
  return {
    ...source,
    ...(input.open_data && typeof input.open_data === "object" ? input.open_data : {}),
  };
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
  const row = sourceBag(input);
  const vintage = sourceVintage(row, opts);
  const projectId = clean(row.project_id);
  const actionTypes = splitList(row.actions);
  const ulurpIdentifiers = splitList(row.ulurp_numbers).map(parseUlurpIdentifier).filter(Boolean);
  const ceqr = parseCeqrIdentifier(row.ceqr_number);
  const easIdentifiers = ceqr ? [ceqr] : [];
  const projectProcedure = projectProcedureAdmissible(ulurpIdentifiers, row.ulurp_non);
  const sourceRecordId = projectId ? `zap-projects:${projectId}` : null;

  const landPairs = pairByActionCode(
    actionTypes.map((token) => token.toUpperCase()),
    ulurpIdentifiers,
  );
  const easPairs = pairByActionCode(
    actionTypes.map((token) => token.toUpperCase()),
    easIdentifiers,
  );

  const land_actions = actionTypes.map((actionType, index) => {
    const normalized = actionType.toUpperCase();
    const pair = landPairs[index];
    const easPair = easPairs[index];
    const identifier = pair?.identifier || (normalized === "EAS" ? easPair?.identifier : null);
    const applicationId = identifier?.raw || null;
    const sourceFields = ["actions"];
    if (identifier?.source_field) sourceFields.push(identifier.source_field);
    const evidence = {
      source_system: "zap-projects",
      source_record_id: sourceRecordId,
      action_source_field: "actions",
      action_token: actionType,
      identifier_source_field: identifier?.source_field || null,
      identifier_raw: applicationId,
      identifier_type: identifier?.type || null,
      identifier_kind: identifier?.kind || null,
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

    if (!identifier) {
      return unresolvedAction({
        actionType,
        applicationId: null,
        reason: pair?.unmatched_reason || "missing_application_id",
        sourceFields,
        vintage,
        evidence,
      });
    }

    if (identifier.action_code && identifier.action_code !== normalized) {
      return unresolvedAction({
        actionType,
        applicationId: null,
        reason: "identifier_action_mismatch",
        sourceFields: ["actions"],
        vintage,
        evidence: { ...evidence, identifier_raw: null, identifier_source_field: null },
      });
    }

    const fromType = procedureFromTypeLetter(identifier.type);
    if (fromType) {
      return resolvedAction({
        actionType,
        applicationId,
        procedureId: fromType,
        sourceFields,
        vintage,
        evidence,
        method: "ulurp_type_letter_exact",
      });
    }
    if (identifier.type) {
      return unresolvedAction({
        actionType,
        applicationId,
        reason: "unsupported_procedure_prefix",
        sourceFields,
        vintage,
        evidence,
      });
    }
    if (!projectProcedure) {
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
    return resolvedAction({
      actionType,
      applicationId,
      procedureId: projectProcedure,
      sourceFields,
      vintage,
      evidence,
      method: "publisher_ulurp_non_with_matching_identifier",
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
