/**
 * Land / ZAP project timeline — ULURP phase grouping.
 *
 * Pure view model over record.spine events: group by canonical ULURP phases,
 * aggregate verbatim-repeated milestone titles, derive current status + next.
 * Does not fetch, invent events, or drop members (aggregates keep full member lists).
 *
 * Presentation (HTML) lives in site/index.html landSpineHTML.
 */

import {
  mergeLandActionEvidence,
  resolveLandActionProcedures,
} from "./land_action_procedure_resolution.mjs";
import { projectAffectedReviewBodies } from "./land_affected_review_body.mjs";
import {
  LAND_PROCEDURE_PROFILE_REGISTRY,
  buildLandProcedureProfileView,
} from "./land_procedure_profiles.mjs";

export const LAND_PHASE_SPINE_SCHEMA_VERSION = 1;

/** Ordered ULURP-oriented phases (pre-public-review first, then statutory clock). */
export const LAND_ULURP_PHASES = Object.freeze([
  "pre_application",
  "environmental",
  "pre_certification",
  "certification",
  "community_board",
  "borough_president",
  "cpc",
  "city_council",
  "mayoral_appeals",
]);

export const LAND_PHASE_META = Object.freeze({
  pre_application: {
    id: "pre_application",
    short: "Filing",
    label_key: "land_phase_pre_application",
  },
  environmental: {
    id: "environmental",
    short: "CEQR",
    label_key: "land_phase_environmental",
  },
  pre_certification: {
    id: "pre_certification",
    short: "Notice",
    label_key: "land_phase_pre_certification",
  },
  certification: {
    id: "certification",
    short: "Certify",
    label_key: "land_phase_certification",
  },
  community_board: {
    id: "community_board",
    short: "CB",
    label_key: "land_phase_community_board",
  },
  borough_president: {
    id: "borough_president",
    short: "BP",
    label_key: "land_phase_borough_president",
  },
  cpc: {
    id: "cpc",
    short: "CPC",
    label_key: "land_phase_cpc",
  },
  city_council: {
    id: "city_council",
    short: "Council",
    label_key: "land_phase_city_council",
  },
  mayoral_appeals: {
    id: "mayoral_appeals",
    short: "Mayor",
    label_key: "land_phase_mayoral_appeals",
  },
});

function clean(value) {
  if (value == null) return null;
  const s = String(value).replace(/\s+/g, " ").trim();
  return s || null;
}

function isoDate(value) {
  if (!value) return null;
  const s = String(value);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

function normalizeTitle(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Map a ZAP / spine event title (and optional kind) to a ULURP phase id.
 * @param {string|null|undefined} title
 * @param {{ kind?: string, representing?: string, detail?: string } | null} [hint]
 * @returns {string} phase id (never null — unknown → pre_application)
 */
export function mapMilestoneToPhase(title, hint = null) {
  const kind = clean(hint?.kind) || "";
  const representing = clean(hint?.representing) || clean(hint?.detail) || "";
  const t = normalizeTitle(title);
  const rep = normalizeTitle(representing);

  if (kind === "city_record_notice_published" || kind === "city_record_hearing") {
    if (/community board|\bcb\b/.test(rep) || /community board|\bcb\b/.test(t)) return "community_board";
    if (/borough president|borough board/.test(rep) || /borough president|borough board/.test(t)) {
      return "borough_president";
    }
    if (/city planning|\bcpc\b/.test(rep) || /city planning|\bcpc\b/.test(t)) return "cpc";
    if (/city council|council/.test(rep) || /city council/.test(t)) return "city_council";
    return "pre_certification";
  }

  if (kind === "zap_disposition" || /disposition/.test(kind)) {
    if (/community board/.test(rep) || /community board/.test(t)) return "community_board";
    if (/borough president|borough board/.test(rep) || /borough president|borough board/.test(t)) {
      return "borough_president";
    }
    if (/city planning|commission/.test(rep) || /city planning/.test(t)) return "cpc";
    if (/city council|council/.test(rep) || /city council/.test(t)) return "city_council";
    if (/mayor|appeals/.test(rep) || /mayor|appeals/.test(t)) return "mayoral_appeals";
  }

  if (!t) return "pre_application";

  if (
    /land use application filed|land use fee paid|prepare filed land use|prepare land use application/.test(t)
  ) {
    return "pre_application";
  }

  // Open Data prefixes institutional referrals with an action code (for
  // example "EAS - Community Board Referral"). The institutional phase is
  // authoritative; the action-code prefix must not pull it back into CEQR.
  if (/community board/.test(t)) return "community_board";
  if (/borough president|borough board/.test(t)) return "borough_president";
  if (/city council/.test(t)) return "city_council";
  if (/appeals board|request for appeals|\bmayor\b/.test(t)) return "mayoral_appeals";

  // This exact review-session milestone is the certification gate, not CPC review.
  if (/application reviewed at city planning commission review session/.test(t)) {
    return "certification";
  }
  if (/city planning commission|\bcpc\b|review session - pre-hearing|post hearing follow-up|post-hearing/.test(t)) {
    return "cpc";
  }

  if (
    /environmental assessment|environmental impact|\beas\b|\beis\b|ceqr fee|\bceqr\b|negative declaration|positive declaration|draft scope|final scope|project readiness|notice of completion/.test(
      t,
    )
  ) {
    return "environmental";
  }

  if (/pre-?certif|pre certif|notice of certif|precertif/.test(t)) {
    return "pre_certification";
  }

  if (/\bcertif(y|ied|ication)\b/.test(t) || t === "certified" || /certified \/ referred/.test(t)) {
    return "certification";
  }

  // Terminal CRM milestones (e.g. "HA - Project Completed") — not pre-filing.
  if (/project completed|project withdrawn|project terminated|\bwithdrawn\b|\bterminated\b/.test(t)) {
    return "mayoral_appeals";
  }

  return "pre_application";
}

function eventIsPlanned(event) {
  if (event?.time?.certainty === "planned") return true;
  const status = String(event?.status || event?.detail || "").toLowerCase();
  return status.includes("not started");
}

function eventIsInProgress(event) {
  const status = String(event?.status || event?.detail || "").toLowerCase();
  return status.includes("in progress");
}

function eventIsActualProgress(event) {
  if (event?._synthetic && event.kind === "open_data_status") return true;
  if (eventIsPlanned(event)) return false;
  const status = String(event?.status || event?.detail || "").toLowerCase();
  if (status.includes("not started")) return false;
  return true;
}

/**
 * True when the event is a finished disposition/milestone from a source row
 * (not planned, not in-progress, not a synthetic open-data status stamp).
 * Synthetic "Noticed" must not count as later-stage completion — CEQR and
 * pre-cert notice legitimately overlap.
 */
function eventIsTerminalComplete(event) {
  if (event?._synthetic) return false;
  if (!eventIsActualProgress(event)) return false;
  if (eventIsInProgress(event)) return false;
  return true;
}

/**
 * Phase has non-synthetic finished rows and none still "In Progress".
 * Used to advance the pipeline pointer past a finished stage into the next one.
 * Synthetic-only phases (pre-cert Noticed stamp) are not terminal for advance.
 */
function phaseIsFullyTerminal(byPhase, phaseId) {
  const all = byPhase[phaseId] || [];
  const material = all.filter((e) => eventIsActualProgress(e) && !e._synthetic);
  if (!material.length) return false;
  if (material.some(eventIsInProgress)) return false;
  return material.some(eventIsTerminalComplete);
}

/**
 * Whether any later pipeline phase already has a terminal completion row.
 * A missing CB outcome must not strand the pointer when BP/CPC already ran.
 * Pre-cert "Noticed" alone does not strand an in-progress CEQR phase.
 */
function laterPhaseHasTerminalCompletes(byPhase, phaseId) {
  const idx = LAND_ULURP_PHASES.indexOf(phaseId);
  if (idx < 0) return false;
  for (let i = idx + 1; i < LAND_ULURP_PHASES.length; i++) {
    const id = LAND_ULURP_PHASES[i];
    if ((byPhase[id] || []).some(eventIsTerminalComplete)) return true;
  }
  return false;
}

/**
 * Derive the pipeline current phase.
 *
 * Semantics (owner feedback on stranded stages): when a later stage already has
 * actual events, advance past earlier stages even if they lack a completion row.
 * Prefer a live "In Progress" only when nothing later has moved; if the latest
 * actual phase is fully terminal and the next phase has any events (including
 * planned Not Started), the process has arrived at that next phase.
 *
 * @param {object} args
 * @param {object} args.byPhase
 * @param {object[]} args.events
 * @param {string|null} args.currentMilestoneLabel
 * @param {boolean} args.completedLike
 * @returns {{ phase_id: string, reason: string }}
 */
export function deriveLandCurrentPhaseId({
  byPhase,
  events = undefined,
  currentMilestoneLabel = null,
  completedLike = false,
} = {}) {
  // events default: empty list (accumulator shape; not a measured table).
  if (!Array.isArray(events)) events = Array();
  function lastPhaseWithActuals() {
    for (let i = LAND_ULURP_PHASES.length - 1; i >= 0; i--) {
      const id = LAND_ULURP_PHASES[i];
      if ((byPhase[id] || []).some(eventIsActualProgress)) return id;
    }
    return null;
  }

  const latestActual = lastPhaseWithActuals();
  const latestIdx = latestActual ? LAND_ULURP_PHASES.indexOf(latestActual) : -1;

  if (completedLike) {
    return {
      phase_id: latestActual || "pre_application",
      reason: "completed_like",
    };
  }

  // In-progress rows that are not stranded behind later terminal completions.
  const liveInProgress = (events || [])
    .filter(eventIsInProgress)
    .map((e) =>
      mapMilestoneToPhase(e.title, {
        kind: e.kind,
        representing: e.detail,
        detail: e.detail,
      }),
    )
    .filter((id) => id && !laterPhaseHasTerminalCompletes(byPhase, id));

  if (liveInProgress.length) {
    // Prefer the latest live in-progress phase (not the first stranded one).
    let best = liveInProgress[0];
    let bestIdx = LAND_ULURP_PHASES.indexOf(best);
    for (const id of liveInProgress) {
      const i = LAND_ULURP_PHASES.indexOf(id);
      if (i > bestIdx) {
        best = id;
        bestIdx = i;
      }
    }
    return { phase_id: best, reason: "in_progress" };
  }

  // Latest actual phase finished → process has moved into the next published stage
  // when that stage already has portal events (including planned Not Started).
  if (latestActual && phaseIsFullyTerminal(byPhase, latestActual)) {
    const nextId = LAND_ULURP_PHASES[latestIdx + 1];
    if (nextId && (byPhase[nextId] || []).length > 0) {
      return { phase_id: nextId, reason: "advanced_past_terminal" };
    }
  }

  // Prefer the latest phase with a real (non-synthetic) terminal or in-progress row
  // when open-data / synthetic stamps would otherwise pull the pointer forward.
  function lastPhaseWithMaterialActuals() {
    for (let i = LAND_ULURP_PHASES.length - 1; i >= 0; i--) {
      const id = LAND_ULURP_PHASES[i];
      if ((byPhase[id] || []).some((e) => eventIsActualProgress(e) && !e._synthetic)) {
        return id;
      }
    }
    return null;
  }
  const latestMaterial = lastPhaseWithMaterialActuals();
  const latestMaterialIdx = latestMaterial ? LAND_ULURP_PHASES.indexOf(latestMaterial) : -1;

  if (currentMilestoneLabel) {
    let mapped = mapMilestoneToPhase(currentMilestoneLabel);
    // Guard: generic filing labels while later phases already have actuals.
    if (
      mapped === "pre_application" &&
      latestMaterial &&
      latestMaterial !== "pre_application"
    ) {
      mapped = latestMaterial;
    }
    // Guard: open-data current_milestone can lag (e.g. still "Community Board
    // Referral" after CPC vote). Never point current behind later terminal work.
    const mappedIdx = LAND_ULURP_PHASES.indexOf(mapped);
    if (
      mappedIdx >= 0 &&
      latestMaterialIdx >= 0 &&
      mappedIdx < latestMaterialIdx &&
      laterPhaseHasTerminalCompletes(byPhase, mapped)
    ) {
      // Fall through to latest-material / advance path below.
    } else {
      return { phase_id: mapped, reason: "open_data_milestone" };
    }
  }

  if (latestMaterial && phaseIsFullyTerminal(byPhase, latestMaterial)) {
    const nextId = LAND_ULURP_PHASES[latestMaterialIdx + 1];
    if (nextId && (byPhase[nextId] || []).length > 0) {
      // Only auto-advance into public-review stages when material work finished;
      // do not hop from CEQR → certification on planned portal stubs alone when
      // open-data still reports an earlier active milestone (handled above).
      return { phase_id: nextId, reason: "advanced_past_terminal" };
    }
  }

  return {
    phase_id: latestMaterial || latestActual || "pre_application",
    reason: latestMaterial || latestActual ? "last_actual" : "default_pre_application",
  };
}

/**
 * Phases the pipeline advanced past without a terminal completion row.
 * Callers may surface these as "no recorded outcome" rather than inventing one.
 */
export function phasesMissingRecordedOutcome(byPhase, currentPhaseId) {
  const curIdx = LAND_ULURP_PHASES.indexOf(currentPhaseId);
  if (curIdx < 0) return Array();
  // Accumulator (not a measured table).
  const missing = Array();
  for (let i = 0; i < curIdx; i++) {
    const id = LAND_ULURP_PHASES[i];
    const all = byPhase[id] || [];
    const actuals = all.filter(eventIsActualProgress);
    if (!actuals.length) continue;
    if (actuals.some(eventIsTerminalComplete)) continue;
    // Only non-terminal actuals (e.g. stranded In Progress) → no recorded outcome.
    missing.push(id);
  }
  return missing;
}

/**
 * Collapse verbatim-identical titles within one phase into aggregates.
 * @param {object[]} events
 */
export function aggregatePhaseEvents(events) {
  const map = new Map();
  for (const event of events || []) {
    const key = normalizeTitle(event.title) || `__empty_${map.size}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(event);
  }
  const out = [];
  for (const group of map.values()) {
    const dates = group
      .map((e) => isoDate(e.time?.value) || null)
      .filter(Boolean)
      .sort();
    const statuses = [
      ...new Set(
        group.map((e) => clean(e.detail) || clean(e.status) || clean(e.outcome) || "—").filter(Boolean),
      ),
    ];
    out.push({
      title: clean(group[0].title) || "—",
      count: group.length,
      first: dates[0] || null,
      last: dates[dates.length - 1] || null,
      statuses,
      members: group,
    });
  }
  out.sort((a, b) => String(a.first || "9999").localeCompare(String(b.first || "9999")));
  return out;
}

/**
 * Whether a source URL is the project portal (should not repeat per row).
 */
export function isProjectPortalUrl(url, portalUrl) {
  const a = String(url || "").trim().replace(/\/+$/, "").toLowerCase();
  const b = String(portalUrl || "").trim().replace(/\/+$/, "").toLowerCase();
  if (!a || !b) return false;
  return a === b;
}

/** The always-eligible-as-future statutory public-review phase ids. */
const STATUTORY_FUTURE_PHASE_IDS = new Set([
  "community_board",
  "borough_president",
  "cpc",
  "city_council",
  "mayoral_appeals",
]);

/**
 * Registry lookup for a resolved procedure profile's own stage vocabulary
 * (the raw registry entry, not the current-stage-anchored view). Returns
 * null when there is no registry entry for the resolved profile id.
 */
function landProcedureRegistryProfile(profileId) {
  if (!profileId) return null;
  return LAND_PROCEDURE_PROFILE_REGISTRY.profiles.find((p) => p.procedure_id === profileId) || null;
}

/**
 * Which future (not-yet-reached, no observed events) statutory phase ids are
 * legitimate for the resolved procedure. Returns null when the procedure did
 * not resolve to the ELURP family — callers must treat null as "no
 * restriction", i.e. the fixed ordinary-ULURP rail keeps applying as the
 * compatibility fallback for verified ordinary ULURP and honest unresolved
 * legacy records. A phase with actual observed events is never gated by
 * this — observed-event topology always wins over the normative vocabulary.
 */
function landElurpAllowedFutureIds(procedureProfile) {
  const profileId = procedureProfile?.profile_id;
  const broadId = procedureProfile?.broad_profile_id || profileId;
  if (broadId !== "elurp_197e") return null;
  const registryProfile = landProcedureRegistryProfile(profileId);
  if (!registryProfile) return new Set(["community_board", "borough_president", "cpc"]);
  return new Set(
    registryProfile.stages.map((stage) => stage.spine_phase_id).filter((id) => STATUTORY_FUTURE_PHASE_IDS.has(id)),
  );
}

/**
 * Map phase id -> sibling phase ids that the resolved procedure reviews
 * concurrently (a shared parallel_group transition), for renderer copy that
 * must say "at the same time as", never imply a first-then-second order.
 * Returns null when the resolved profile has no parallel review group.
 */
function landProcedureConcurrentPhaseMap(procedureProfile) {
  const registryProfile = landProcedureRegistryProfile(procedureProfile?.profile_id);
  const transitions = registryProfile?.transitions;
  if (!Array.isArray(transitions) || !transitions.length) return null;
  const map = {};
  for (const transition of transitions) {
    if (transition.kind !== "parallel_group") continue;
    const memberPhaseIds = [
      ...new Set(
        (transition.stage_ids || [])
          .map((stageId) => registryProfile.stages.find((s) => s.stage_id === stageId)?.spine_phase_id)
          .filter(Boolean),
      ),
    ];
    for (const phaseId of memberPhaseIds) {
      map[phaseId] = memberPhaseIds.filter((id) => id !== phaseId);
    }
  }
  return Object.keys(map).length ? map : null;
}

/**
 * Build phase-grouped land timeline view model.
 *
 * @param {object|null|undefined} spine - record.spine
 * @param {object} [opts]
 */
export function buildLandPhaseView(spine, opts = {}) {
  const events = Array.isArray(spine?.events) ? spine.events.slice() : [];
  const openData = opts.open_data || spine?.open_data || null;
  const portalUrl = clean(opts.portal_url) || clean(spine?.portal_url) || null;
  const publicStatus =
    clean(opts.public_status) ||
    clean(openData?.public_status) ||
    null;
  const projectId =
    clean(opts.project_id) || clean(spine?.project_id) || clean(openData?.project_id) || null;

  const byPhase = Object.fromEntries(LAND_ULURP_PHASES.map((id) => [id, []]));

  for (const event of events) {
    const phaseId = mapMilestoneToPhase(event.title, {
      kind: event.kind,
      representing: event.detail,
      detail: event.detail,
    });
    (byPhase[phaseId] || byPhase.pre_application).push(event);
  }

  const noticed = publicStatus ? /^noticed$/i.test(publicStatus) : false;
  const noticedDate = isoDate(openData?.noticed_date);
  if (noticed) {
    const already = byPhase.pre_certification.some((e) =>
      /noticed|pre-?certif/i.test(String(e.title || "")),
    );
    if (!already) {
      byPhase.pre_certification.push({
        id: `open-data:${projectId || "project"}:noticed`,
        kind: "open_data_status",
        title: "Pre-certification notice (public status: Noticed)",
        detail: "Noticed",
        status: "Noticed",
        outcome: null,
        time: noticedDate
          ? { value: noticedDate, precision: "day", basis: "public_status", certainty: "actual" }
          : null,
        source: { id: "nyc-open-data-zap", label: "NYC Open Data" },
        _synthetic: true,
      });
    }
  }

  const inProgress = events.find((e) => eventIsInProgress(e));
  const openDataMilestoneLabel = clean(openData?.current_milestone) || null;
  const statusLower = (publicStatus || "").toLowerCase();
  const completedLike =
    /completed|approved/.test(statusLower) ||
    /project completed|project withdrawn|project terminated/.test(
      normalizeTitle(openDataMilestoneLabel || clean(inProgress?.title) || ""),
    );

  const derived = deriveLandCurrentPhaseId({
    byPhase,
    events,
    currentMilestoneLabel: openDataMilestoneLabel,
    completedLike,
  });
  let currentPhaseId = derived.phase_id || "pre_application";
  const missingOutcomes = new Set(phasesMissingRecordedOutcome(byPhase, currentPhaseId));

  // Display label: prefer a milestone that belongs to the derived current phase.
  // Open Data current_milestone often lags (stranded CB referral after CPC vote).
  let currentMilestoneLabel = openDataMilestoneLabel || clean(inProgress?.title) || null;
  let currentMilestoneDate =
    isoDate(inProgress?.time?.value) || isoDate(openData?.current_milestone_date) || null;
  const openDataPhase = openDataMilestoneLabel
    ? mapMilestoneToPhase(openDataMilestoneLabel)
    : null;
  const openDataPhaseIdx = openDataPhase ? LAND_ULURP_PHASES.indexOf(openDataPhase) : -1;
  const curIdxForLabel = LAND_ULURP_PHASES.indexOf(currentPhaseId);
  if (
    openDataPhaseIdx >= 0 &&
    curIdxForLabel >= 0 &&
    openDataPhaseIdx < curIdxForLabel
  ) {
    const curEvents = (byPhase[currentPhaseId] || []).slice().sort((a, b) =>
      String(isoDate(a.time?.value) || "").localeCompare(String(isoDate(b.time?.value) || "")),
    );
    const preferred =
      curEvents.find(eventIsInProgress) ||
      [...curEvents].reverse().find(eventIsActualProgress) ||
      curEvents[curEvents.length - 1] ||
      null;
    if (preferred) {
      currentMilestoneLabel = clean(preferred.title) || currentMilestoneLabel;
      currentMilestoneDate = isoDate(preferred.time?.value) || currentMilestoneDate;
    }
  }

  /**
   * Phase state:
   * - current: derived current phase
   * - passed: completed work at or before current
   * - overlap: permitted concurrent work that sits AFTER current in the template
   *   (CEQR ↔ pre-cert notice) — never labeled plain "Done" without explanation
   * - future: otherwise (including planned-only public-review stages)
   *
   * Note: CEQR and pre-cert can overlap (Noticed while filing/EAS still in progress).
   * Field case 2026K0123: Noticed while current=Filing and next=CEQR must not paint
   * Notice as completed after CEQR in the stepper.
   */
  function phaseState(id) {
    if (id === currentPhaseId) return "current";
    const idx = LAND_ULURP_PHASES.indexOf(id);
    const cur = LAND_ULURP_PHASES.indexOf(currentPhaseId);
    const actuals = (byPhase[id] || []).some(eventIsActualProgress);

    // Public "Noticed" while the pointer is still in filing/CEQR: notice is concurrent,
    // not a later completed stage.
    if (id === "pre_certification" && noticed && cur >= 0 && idx > cur) {
      return "overlap";
    }

    if (actuals) {
      if (idx <= cur) return "passed";
      // Material rows after current without a permitted overlap story stay passed only
      // when the process already advanced (later terminal work). Synthetic Noticed alone
      // never takes this path.
      const material = (byPhase[id] || []).some((e) => eventIsActualProgress(e) && !e._synthetic);
      if (material) return "passed";
      return "future";
    }
    return "future";
  }

  // Normative procedure interpretation is an additive sibling of the observed
  // spine. The profile consumer receives source facts and the derived phase;
  // it never receives, mutates, or manufactures an event.
  // The exact ZAP API per-action array (when the caller has it, e.g. from a
  // live zap-outcomes record) must reach the resolver alongside Open Data —
  // never flattened into a plain `{...openData}` spread that would lose it.
  // `opts.procedure_facts` stays the highest-priority override, as before.
  // Resolved ahead of the phase rail below: phase selection is driven by the
  // resolved procedure plus observed-event topology, not a fixed template.
  const procedureFacts = {
    ...mergeLandActionEvidence({
      open_data: openData && typeof openData === "object" ? openData : null,
      actions: opts.actions || spine?.actions || null,
    }),
    ...(opts.procedure_facts && typeof opts.procedure_facts === "object" ? opts.procedure_facts : {}),
  };
  const affectedReviewBodies = procedureFacts.affected_review_body_for?.schema
    ? procedureFacts.affected_review_body_for
    : projectAffectedReviewBodies(procedureFacts, { geography: opts.geography });
  if (!Object.hasOwn(procedureFacts, "affected_review_bodies") && affectedReviewBodies?.facts) {
    procedureFacts.affected_review_bodies = affectedReviewBodies.facts;
  }
  const procedureProfile = buildLandProcedureProfileView({
    source: procedureFacts,
    current_phase_id: currentPhaseId,
    current_stage_id: opts.current_stage_id || null,
  });
  const actionProcedure = resolveLandActionProcedures(procedureFacts);
  // Compatibility fallback: null for anything other than a resolved ELURP
  // family profile — verified ordinary ULURP and honest unresolved legacy
  // records keep the full fixed rail below, unchanged.
  const elurpAllowedFutureIds = landElurpAllowedFutureIds(procedureProfile);
  const concurrentPhaseMap = landProcedureConcurrentPhaseMap(procedureProfile);

  const phases = LAND_ULURP_PHASES.map((id) => {
    const state = phaseState(id);
    const all = byPhase[id] || [];
    let display;
    if (state === "future") {
      const planned = all.filter(eventIsPlanned);
      display = planned.length ? planned : all;
    } else if (state === "current" && !(byPhase[id] || []).some(eventIsActualProgress)) {
      // Arrived at next phase with only planned Not Started rows — show them as current work.
      display = all;
    } else if (state === "overlap") {
      display = all.filter((e) => !eventIsPlanned(e) || eventIsInProgress(e) || e._synthetic);
      if (!display.length) display = all;
    } else {
      // History / current: hide pure planned Not Started rows (they live under future phases).
      display = all.filter((e) => !eventIsPlanned(e) || eventIsInProgress(e) || e._synthetic);
      if (!display.length) display = all;
    }

    const dates = display
      .map((e) => isoDate(e.time?.value))
      .filter(Boolean)
      .sort();

    const overlapExplained =
      state === "overlap" && id === "pre_certification" && noticed
        ? {
            reason: "noticed_during_filing_or_ceqr",
            label_key: "land_spine_phase_overlap_notice",
            permitted: true,
          }
        : null;

    return {
      id,
      short: LAND_PHASE_META[id].short,
      label_key: LAND_PHASE_META[id].label_key,
      state,
      // "no_recorded_outcome" when the pipeline advanced past this stage without a
      // terminal completion row (stranded In Progress / missing disposition).
      outcome_status: missingOutcomes.has(id) ? "no_recorded_outcome" : null,
      overlap: overlapExplained,
      // Sibling phase ids the resolved procedure reviews at the same time
      // (e.g. Community Board / Borough President under § 197-e) — never a
      // first-then-second order. Null when the resolved profile has none.
      concurrent_with: concurrentPhaseMap?.[id] || null,
      event_count: display.length,
      total_count: all.length,
      first: dates[0] || null,
      last: dates[dates.length - 1] || null,
      aggregates: aggregatePhaseEvents(display),
      events: display,
      all_events: all,
    };
  });

  // Next = first future phase AFTER current only. Never fall back to an earlier
  // incomplete template slot (that produced "What's next: Pre-certification"
  // while current was Mayoral on completed projects).
  const curIdx = LAND_ULURP_PHASES.indexOf(currentPhaseId);
  let nextPhase = null;
  if (!completedLike) {
    for (let i = curIdx + 1; i < phases.length; i++) {
      if (phases[i].state === "future") {
        nextPhase = phases[i];
        break;
      }
      // Skip passed/overlap (e.g. concurrent notice while still in filing/CEQR)
    }
  }

  // Applicable phases: omit empty pre-public-review slots the project never
  // entered once review has moved past them (acquisition apps often skip CEQR /
  // pre-cert notice). Always keep the current phase and any phase with events.
  const applicablePhases = phases.filter((p) => {
    if (p.state === "current" || p.state === "passed" || p.state === "overlap") return true;
    if ((p.total_count || p.event_count || 0) > 0) return true;
    const idx = LAND_ULURP_PHASES.indexOf(p.id);
    // Future statutory public-review stages after current remain visible —
    // but only when they belong to the resolved procedure's own rail. A
    // resolved ELURP-family record never speculates an ordinary-ULURP-only
    // stage (Council, Mayor) it has no observed events for; every other
    // procedure keeps the full fixed rail (unchanged) as the compatibility
    // fallback for verified ordinary ULURP and honest unresolved legacy
    // records. Pre-certification / certification are documentary steps every
    // certified-application procedure shares (the registry models them as
    // one coarse stage) — they preview alongside the resolved rail, never
    // instead of it.
    const futureCandidateIds = elurpAllowedFutureIds
      ? new Set([...elurpAllowedFutureIds, "pre_certification", "certification"])
      : STATUTORY_FUTURE_PHASE_IDS;
    if (idx > curIdx && futureCandidateIds.has(p.id)) return true;
    // Empty future pre-review stages behind or with no justification → omit.
    return false;
  });

  return {
    schema_version: LAND_PHASE_SPINE_SCHEMA_VERSION,
    project_id: projectId,
    portal_url: portalUrl,
    current: {
      phase_id: currentPhaseId,
      label_key: LAND_PHASE_META[currentPhaseId]?.label_key || "land_phase_pre_application",
      milestone_label: currentMilestoneLabel,
      since: currentMilestoneDate,
      public_status: publicStatus,
      noticed,
      // True only when Open Data already labels full public review / completion paths.
      // Completed/approved are terminal — not "in public review" for action rails.
      in_public_review: publicStatus
        ? /public review/i.test(publicStatus) && !/completed|approved|disapproved|withdrawn|terminated/i.test(publicStatus)
        : false,
      // Machine-readable derivation reason (stranded-stage advance, in_progress, …).
      derivation: derived.reason || null,
      // Renderer i18n key for the "Noticed" status line — the resolved ELURP
      // family gets its own copy instead of the ordinary-ULURP phrase.
      noticed_status_key: elurpAllowedFutureIds ? "land_spine_status_noticed_elurp_html" : "land_spine_status_noticed_html",
    },
    next: nextPhase
      ? {
          phase_id: nextPhase.id,
          label_key: nextPhase.label_key,
          short: nextPhase.short,
        }
      : null,
    phases: applicablePhases,
    all_phases: phases,
    chronological: events,
    event_count: events.length,
    portal_row_link_candidates: countDuplicatePortalLinks({ events }, portalUrl),
    lag: spine?.lag || null,
    gaps: Array.isArray(spine?.gaps) ? spine.gaps : [],
    // Layer B (normative) remains structurally distinct from chronological,
    // phase, and aggregate Layer C observation fields above.
    procedure_profile: procedureProfile,
    land_actions: actionProcedure.land_actions,
    procedure_resolution: actionProcedure.procedure_resolution,
    affected_review_body_for: affectedReviewBodies,
    affected_review_bodies: affectedReviewBodies?.facts || procedureFacts.affected_review_bodies || null,
  };
}

/**
 * Count how many portal-identical source URLs would render if every event linked.
 */
export function countDuplicatePortalLinks(spine, portalUrl) {
  const events = Array.isArray(spine?.events) ? spine.events : [];
  return events.filter((e) => isProjectPortalUrl(e.source?.url, portalUrl)).length;
}
