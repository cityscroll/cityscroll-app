import { vendorStem } from "./vendor_stem.mjs";
import { isKnownProcurementProcessState } from "./procurement_process_state_vocabulary.mjs";
import {
  DEFAULT_LAND_FAMILY,
  landActionEvidenceByProject,
  landActionsMatchFutureFilter,
  landFutureActionsByProject,
  landRowMatchesFamily,
  landRowMatchesStage,
  landRowWithActionEvidence,
  landUseFamilies,
  normalizeLandFamily,
  normalizeLandFutureAction,
  normalizeLandStage,
} from "./land_status_facets.mjs";
import {
  DEFAULT_LAND_PROCEDURE,
  landObservedDates,
  landRowMatchesProcedure,
  normalizeLandProcedure,
  resolveLandProcedure,
} from "./land_procedure_facet.mjs";
import {
  landRegulatoryEffectForRow,
  landRowMatchesRegulatoryEffect,
  normalizeLandRegulatoryEffect,
} from "./land_regulatory_effect.mjs";

const residentSnapshotClean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const residentSnapshotLower = (value) => residentSnapshotClean(value).toLowerCase();

function residentSnapshotRowText(row) {
  return Object.values(row || {})
    .filter((value) => typeof value === "string" || typeof value === "number")
    .map(residentSnapshotClean)
    .join(" ")
    .toLowerCase();
}

function residentSnapshotNumeric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function contractIdentityFromFacetValues(values = {}) {
  const identity = values?.contract_identity;
  const objectRef = residentSnapshotClean(identity?.object_ref);
  const sourceObservationRef = residentSnapshotClean(identity?.source_observation_ref);
  if (
    !/^procurement:[^\s\u0000-\u001f]{4,300}$/.test(objectRef)
    || !/^(?:notice|ocp_award|city_record|passport_public_contracts|passport_public_rfx|checkbook_contracts|checkbook_spending):[^\u0000-\u001f]{1,220}$/.test(sourceObservationRef)
  ) return null;
  return Object.freeze({ object_ref: objectRef, source_observation_ref: sourceObservationRef });
}

export function moneySnapshotRows(payload) {
  return Array.isArray(payload?.rows) ? payload.rows : [];
}

/**
 * The publisher's notice timestamps carry no offset (e.g. "2026-09-02T16:00:00.000")
 * and are observed City Record local time, i.e. America/New_York. Convert one to the
 * real instant it names, using the wall-clock-at-the-guessed-instant technique: format
 * a UTC-labeled reading of the naive fields in the target zone, then correct by the
 * implied offset. This is exact except inside the zone's own DST transition hour,
 * which no procurement deadline in this product depends on.
 */
export function nyNaiveTimestampToInstantMs(naiveTimestamp) {
  const match = String(naiveTimestamp ?? "").trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!match) return null;
  const [, year, month, day, hour = "0", minute = "0", second = "0"] = match;
  const utcGuess = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  if (!Number.isFinite(utcGuess)) return null;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(utcGuess)).map((part) => [part.type, part.value]));
  const nyWallAsUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second),
  );
  return (2 * utcGuess) - nyWallAsUtc;
}

function resolveEvaluationClockMs(clock) {
  if (clock instanceof Date) return Number.isFinite(clock.getTime()) ? clock.getTime() : null;
  if (typeof clock === "number") return Number.isFinite(clock) ? clock : null;
  if (typeof clock === "string") {
    const parsed = Date.parse(clock);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function residentSnapshotInstant(value) {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

export const OPEN_CONTRACTS_FRESHNESS_STATES = Object.freeze({
  FRESH: "fresh",
  STALE: "stale",
  UNAVAILABLE: "unavailable",
  FRESH_EMPTY: "fresh_empty",
});

// Matches community_board_money.mjs's MONEY_SOURCE_MAX_AGE_MS — the same
// resident-facing staleness threshold for a money snapshot, defined locally
// rather than imported so this module does not pull an unrelated read model
// into every page that reads open-contract rows.
export const OPEN_CONTRACTS_MAX_SNAPSHOT_AGE_MS = 36 * 60 * 60 * 1000;

/**
 * The single open-contracts read model behind both the build-rendered
 * `/browse/contracts/` document and its client hydration (money-list.mjs).
 *
 * Pure: it takes the evaluation instant from the caller rather than reading a
 * clock, so a stale committed snapshot cannot be mistaken for a genuinely
 * empty population — the caller always learns which one it got.
 */
export function openContractSnapshotProjection(payload, {
  clock,
  limit = Infinity,
  maxAgeMs = OPEN_CONTRACTS_MAX_SNAPSHOT_AGE_MS,
} = {}) {
  const nowMs = resolveEvaluationClockMs(clock);
  const sourceVintage = payload?.open_as_of || payload?.generated_at || null;
  const vintageMs = residentSnapshotInstant(payload?.generated_at) ?? residentSnapshotInstant(payload?.open_as_of);
  const allRows = Array.isArray(payload?.notices) ? payload.notices : null;
  if (nowMs == null || allRows == null || vintageMs == null) {
    return {
      rows: [],
      sourceVintage,
      freshnessState: OPEN_CONTRACTS_FRESHNESS_STATES.UNAVAILABLE,
      emptyStateEligible: false,
    };
  }
  const rows = allRows.filter((row) => {
    const dueMs = nyNaiveTimestampToInstantMs(row?.due_date);
    return dueMs != null && dueMs > nowMs;
  }).slice(0, Number.isFinite(limit) ? Math.max(0, limit) : allRows.length);
  const stale = (nowMs - vintageMs) > maxAgeMs;
  const freshnessState = stale
    ? OPEN_CONTRACTS_FRESHNESS_STATES.STALE
    : rows.length
      ? OPEN_CONTRACTS_FRESHNESS_STATES.FRESH
      : OPEN_CONTRACTS_FRESHNESS_STATES.FRESH_EMPTY;
  return {
    rows,
    sourceVintage,
    freshnessState,
    emptyStateEligible: !stale,
  };
}

export function vendorStemsFromEntityRefs(entityRefs = []) {
  return [...new Set((Array.isArray(entityRefs) ? entityRefs : [])
    .map((ref) => String(ref || "").trim().match(/^vendor:stem:(.+)$/)?.[1] || "")
    .map((stem) => {
      try { return decodeURIComponent(stem); } catch { return stem; }
    })
    .map(vendorStem)
    .filter(Boolean))];
}

export function filterMoneySnapshot(rows, {
  mode = "open",
  agency = "",
  keyword = "",
  method = "",
  closingWeek = false,
  minAmount = null,
  maxAmount = null,
  category = "",
  months = null,
  excludeSpecial = false,
  entityRefs = [],
  contractObjectRef = "",
  stages = [],
  processStates = [],
  sort = "deadline",
  today,
  weekEnd,
  monthEnd,
  limit = 40,
} = {}) {
  const floor = String(today || "").slice(0, 10);
  const query = residentSnapshotLower(keyword);
  const requiredPin = residentSnapshotClean(contractObjectRef).replace(/^procurement:/, "");
  const requiredStages = new Set((Array.isArray(stages) ? stages : [stages])
    .map((stage) => residentSnapshotLower(stage)).filter(Boolean));
  // Only exact known publisher-observed states are predicates. An unknown or
  // unobserved value narrows to nothing rather than widening the collection.
  const requestedProcessStates = (Array.isArray(processStates) ? processStates : [processStates])
    .map((state) => residentSnapshotLower(state)).filter(Boolean);
  const requiredProcessStates = new Set(requestedProcessStates.filter(isKnownProcurementProcessState));
  const processStateFilterActive = requestedProcessStates.length > 0;
  const requiredVendorStems = vendorStemsFromEntityRefs(entityRefs);
  const selected = (Array.isArray(rows) ? rows : []).filter((row) => {
    const type = residentSnapshotClean(row?.type_of_notice_description);
    const typedStages = procurementStagesForRow(row);
    const isAward = typedStages.length
      ? typedStages.some((stage) => ["award", "pending", "registered", "payment", "contract"].includes(stage))
      : type === "Award";
    const isSolicitation = typedStages.length ? typedStages.includes("solicitation") : type === "Solicitation";
    if (mode === "award" && !isAward) return false;
    if (mode === "archive" && !isAward && !isSolicitation) return false;
    if ((mode === "open" || mode === "allrfp") && !isSolicitation) return false;
    if (requiredStages.size && !typedStages.some((stage) => requiredStages.has(stage))) return false;
    if (processStateFilterActive) {
      if (!requiredProcessStates.size) return false;
      if (!procurementProcessStatesForRow(row).some((state) => requiredProcessStates.has(state))) return false;
    }
    const due = String(row?.due_date || "").slice(0, 10);
    if (mode === "open" && (!due || (floor && due <= floor))) return false;
    if (mode === "open" && closingWeek && weekEnd && due > String(weekEnd).slice(0, 10)) return false;
    if (agency && residentSnapshotClean(row?.agency_name) !== residentSnapshotClean(agency)) return false;
    if (requiredVendorStems.length
      && !requiredVendorStems.every((stem) => vendorStem(row?.vendor_name) === stem)) return false;
    if (contractObjectRef && row?.procurement_id) {
      if (residentSnapshotClean(row.procurement_id) !== residentSnapshotClean(contractObjectRef)) return false;
    } else if (requiredPin && residentSnapshotClean(row?.pin) !== requiredPin) return false;
    // A row projected from a scoped SearchDocument was matched by the capability
    // for this same query, so the local text predicate does not get to overrule
    // it. Local matching still decides every row that came from the snapshot.
    if (!requiredPin && query && !row?.search_document
      && !residentSnapshotRowText(row).includes(query)) return false;
    const amount = residentSnapshotNumeric(row?.contract_amount);
    if (mode === "award" && minAmount != null && (amount == null || amount < Number(minAmount))) return false;
    if (mode === "award" && maxAmount != null && (amount == null || amount > Number(maxAmount))) return false;
    if (category && residentSnapshotClean(row?.category_description) !== residentSnapshotClean(category)) return false;
    if (mode === "open" && months && monthEnd && due > String(monthEnd).slice(0, 10)) return false;
    if (excludeSpecial && /special/i.test(residentSnapshotClean(row?.selection_method_description))) return false;
    if (method && residentSnapshotClean(row?.selection_method_description) !== residentSnapshotClean(method)) return false;
    return true;
  });
  selected.sort((left, right) => {
    if (sort === "amount") return (residentSnapshotNumeric(right?.contract_amount) || 0) - (residentSnapshotNumeric(left?.contract_amount) || 0);
    if (sort === "newest" || mode === "award" || mode === "archive") {
      return String(right?.start_date || "").localeCompare(String(left?.start_date || ""));
    }
    if (mode === "allrfp") return String(right?.due_date || "").localeCompare(String(left?.due_date || ""));
    return String(left?.due_date || "").localeCompare(String(right?.due_date || ""));
  });
  return selected.slice(0, limit);
}

/** Known source-backed process states already materialized on one Browse row. */
export function procurementProcessStatesForRow(row) {
  const states = Array.isArray(row?.process_states) ? row.process_states : [];
  return [...new Set(states.map(residentSnapshotLower).filter(isKnownProcurementProcessState))];
}

export function procurementStagesForRow(row) {
  const stages = Array.isArray(row?.procurement_stages)
    ? row.procurement_stages
    : row?.primary_stage ? [row.primary_stage] : [];
  return [...new Set(stages.map((stage) => residentSnapshotLower(stage)).filter(Boolean))];
}

export function moneyMethodFacet(rows, limit = 7) {
  const counts = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const method = residentSnapshotClean(row?.selection_method_description);
    if (method) counts.set(method, (counts.get(method) || 0) + 1);
  }
  return [...counts].map(([selection_method_description, n]) => ({ selection_method_description, n }))
    .sort((left, right) => right.n - left.n || left.selection_method_description.localeCompare(right.selection_method_description))
    .slice(0, limit);
}

export function moneyLineageRows(rows, target) {
  const pin = residentSnapshotClean(target?.pin);
  const agency = residentSnapshotClean(target?.agency_name);
  if (!pin || !agency) return target ? [target] : [];
  const base = pin.replace(/R0\d+$/, "");
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    if (residentSnapshotClean(row?.agency_name) !== agency) return false;
    const candidate = residentSnapshotClean(row?.pin);
    return base !== pin ? candidate.startsWith(base) : candidate === pin;
  }).sort((left, right) => String(left?.start_date || "").localeCompare(String(right?.start_date || "")));
}

export function mergeLandProjects(...payloads) {
  const byId = new Map();
  for (const payload of payloads) {
    const rows = Array.isArray(payload) ? payload : payload?.projects || payload?.rows || [];
    for (const row of rows) {
      const id = residentSnapshotClean(row?.project_id);
      if (!id) continue;
      byId.set(id, { ...(byId.get(id) || {}), ...row });
    }
  }
  return [...byId.values()];
}

export function projectIdsForBlock(bblRows, block) {
  const prefix = String(block || "").replace(/\D/g, "").slice(0, 6);
  if (prefix.length !== 6) return [];
  return (Array.isArray(bblRows) ? bblRows : [])
    .filter((row) => (row?.bbls || []).some((bbl) => String(bbl).padStart(10, "0").startsWith(prefix)))
    .map((row) => row.project_id)
    .filter(Boolean);
}

export function bblsForProject(bblRows, projectId) {
  const row = (Array.isArray(bblRows) ? bblRows : []).find((item) => item?.project_id === projectId);
  return Array.isArray(row?.bbls) ? row.bbls.map(String) : [];
}

export function filterLandSnapshot(rows, {
  status = "active",
  stage = null,
  futureAction = "any",
  procedure = DEFAULT_LAND_PROCEDURE,
  family = DEFAULT_LAND_FAMILY,
  regulatoryEffect = "any",
  actionRows = [],
  today,
  borough = "",
  keyword = "",
  communityDistrict = "",
  councilDistrict = "",
  projectIds = null,
  limit = 40,
} = {}) {
  const query = residentSnapshotLower(keyword);
  const ids = projectIds ? new Set(projectIds) : null;
  const statusMatch = String(status || "active").match(/^(project|public):(.*)$/);
  const selectedStage = stage == null
    ? (status === "active" ? "active" : "any")
    : normalizeLandStage(stage, "any");
  const selectedFutureAction = status === "hearings"
    ? "hearing"
    : normalizeLandFutureAction(futureAction);
  const selectedProcedure = normalizeLandProcedure(procedure);
  const selectedFamily = normalizeLandFamily(family);
  const selectedRegulatoryEffect = normalizeLandRegulatoryEffect(regulatoryEffect);
  const actionsByProject = landFutureActionsByProject(actionRows, { today });
  const evidenceByProject = landActionEvidenceByProject(actionRows);
  const selected = (Array.isArray(rows) ? rows : []).filter((row) => {
    if (!landRowMatchesProcedure(row, selectedProcedure)) return false;
    if (!landRowMatchesFamily(row, selectedFamily)) return false;
    if (!landRowMatchesRegulatoryEffect(row, selectedRegulatoryEffect)) return false;
    if (status === "active" && residentSnapshotClean(row?.project_status) !== "Active") return false;
    if (statusMatch) {
      const field = statusMatch[1] === "project" ? "project_status" : "public_status";
      if (residentSnapshotClean(row?.[field]) !== residentSnapshotClean(statusMatch[2])) return false;
    }
    const actions = actionsByProject.get(residentSnapshotClean(row?.project_id)) || [];
    const evidence = evidenceByProject.get(residentSnapshotClean(row?.project_id)) || [];
    if (!landRowMatchesStage(landRowWithActionEvidence(row, evidence, { today }), selectedStage)) return false;
    if (!landActionsMatchFutureFilter(actions, selectedFutureAction)) return false;
    if (borough && residentSnapshotClean(row?.borough) !== residentSnapshotClean(borough)) return false;
    if (communityDistrict && !residentSnapshotClean(row?.community_district).includes(residentSnapshotClean(communityDistrict))) return false;
    if (councilDistrict) {
      const padded = String(councilDistrict).padStart(2, "0");
      const districts = residentSnapshotClean(row?.cc_district);
      if (!districts || (!districts.includes(padded) && districts !== String(councilDistrict))) return false;
    }
    if (ids && !ids.has(row?.project_id)) return false;
    if (query && !residentSnapshotRowText(row).includes(query)) return false;
    return true;
  }).map((row) => {
    const actions = actionsByProject.get(residentSnapshotClean(row?.project_id)) || [];
    const evidence = evidenceByProject.get(residentSnapshotClean(row?.project_id)) || [];
    const matchingActions = selectedFutureAction === "hearing"
      ? actions.filter((action) => action.action_kind === "hearing")
      : selectedFutureAction === "other"
        ? actions.filter((action) => action.action_kind !== "hearing")
        : selectedFutureAction === "none" ? [] : actions;
    const effective = landRowWithActionEvidence(row, evidence, { today });
    return {
      ...effective,
      _procedure: resolveLandProcedure(effective),
      _families: landUseFamilies(effective),
      _regulatory_effect: landRegulatoryEffectForRow(effective),
      _observed_dates: landObservedDates(effective, evidence),
      _future_actions: actions,
      _next_action: matchingActions[0] || null,
    };
  });
  selected.sort((left, right) => {
    if (selectedFutureAction !== "any") {
      return String(left?._next_action?.action_date || "9999-12-31")
        .localeCompare(String(right?._next_action?.action_date || "9999-12-31"))
        || String(right?.current_milestone_date || "").localeCompare(String(left?.current_milestone_date || ""));
    }
    return String(right?.current_milestone_date || "").localeCompare(String(left?.current_milestone_date || ""));
  });
  return selected.slice(0, limit);
}

export function staffingRolesFromExamples(examples, keyword, limit = 40) {
  const query = residentSnapshotLower(keyword);
  const rows = new Map();
  for (const example of Array.isArray(examples) ? examples : []) {
    const candidates = [
      {
        title_description: example.official_title,
        n: Number(example.headcount) || 0,
        mn: residentSnapshotNumeric(example.base_min),
        mx: residentSnapshotNumeric(example.base_max),
        avg: residentSnapshotNumeric(example.base_median),
        competitive: Boolean(example.competitive),
      },
      ...(example.ladder || []).map((item) => ({
        title_description: item.title,
        n: item.title === example.official_title ? Number(example.headcount) || 0 : 0,
        mn: residentSnapshotNumeric(item.avg),
        mx: residentSnapshotNumeric(item.avg),
        avg: residentSnapshotNumeric(item.avg),
        competitive: item.title === example.official_title && Boolean(example.competitive),
      })),
    ];
    for (const row of candidates) {
      const title = residentSnapshotClean(row.title_description);
      if (!title || (query && !residentSnapshotLower(title).includes(query))) continue;
      const prior = rows.get(title);
      rows.set(title, prior ? {
        ...prior,
        n: Math.max(prior.n, row.n),
        competitive: prior.competitive || row.competitive,
      } : row);
    }
  }
  return [...rows.values()].sort((left, right) => (right.avg || 0) - (left.avg || 0)).slice(0, limit);
}

export function staffingPeopleFromAppointments(notices, keyword) {
  const query = residentSnapshotLower(keyword);
  const people = new Map();
  for (const row of Array.isArray(notices) ? notices : []) {
    if (query && !residentSnapshotRowText(row).includes(query)) continue;
    const text = residentSnapshotClean(row?.additional_description_1);
    const name = text.match(/Employee Name:\s*([^.]+?)\s*\.?\s*$/i)?.[1]?.trim();
    if (!name) continue;
    const key = `${name.toUpperCase()}|${residentSnapshotClean(row?.agency_name)}`;
    if (!people.has(key)) people.set(key, { name, agency: row.agency_name, rows: [] });
    people.get(key).rows.push(row);
  }
  return [...people.values()].sort((left, right) => right.rows.length - left.rows.length);
}

export function domainRows(payload, key = "rows") {
  return Array.isArray(payload?.[key]) ? payload[key] : [];
}
