/**
 * Land / ZAP project timeline — ULURP phase projection.
 *
 * Pure view model over record.spine events: group by canonical ULURP phases,
 * aggregate verbatim-repeated milestone titles, derive current status + next.
 * Does not fetch, invent events, or drop members (aggregates keep full member lists).
 *
 * Presentation (HTML) lives in site/index.html landSpineHTML.
 */

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

  if (/community board/.test(t)) return "community_board";
  if (/borough president|borough board/.test(t)) return "borough_president";
  if (/city council/.test(t)) return "city_council";
  if (/appeals board|request for appeals|\bmayor\b/.test(t)) return "mayoral_appeals";

  // CPC review session used as the certification gate on many ZAP projects.
  if (/application reviewed at city planning commission review session/.test(t)) {
    return "certification";
  }

  if (
    /city planning commission|review session - pre-hearing|post hearing follow-up|post-hearing/.test(t)
  ) {
    return "cpc";
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
  const currentMilestoneLabel =
    clean(openData?.current_milestone) || clean(inProgress?.title) || null;
  const currentMilestoneDate =
    isoDate(inProgress?.time?.value) || isoDate(openData?.current_milestone_date) || null;

  function lastPhaseWithActuals() {
    for (let i = LAND_ULURP_PHASES.length - 1; i >= 0; i--) {
      const id = LAND_ULURP_PHASES[i];
      if ((byPhase[id] || []).some(eventIsActualProgress)) return id;
    }
    return null;
  }

  const statusLower = (publicStatus || "").toLowerCase();
  const completedLike =
    /completed|approved/.test(statusLower) ||
    /project completed|project withdrawn|project terminated/.test(
      normalizeTitle(currentMilestoneLabel || ""),
    );

  let currentPhaseId = null;
  if (inProgress) {
    currentPhaseId = mapMilestoneToPhase(inProgress.title, { kind: inProgress.kind });
  } else if (completedLike) {
    // Prefer the latest phase that actually ran (Council / CPC / …), not a CRM
    // "HA - Project Completed" label that would otherwise mis-map.
    currentPhaseId = lastPhaseWithActuals();
  } else if (currentMilestoneLabel) {
    currentPhaseId = mapMilestoneToPhase(currentMilestoneLabel);
    // Guard: generic labels that map to filing while later phases already have actuals.
    if (
      currentPhaseId === "pre_application" &&
      lastPhaseWithActuals() &&
      lastPhaseWithActuals() !== "pre_application"
    ) {
      currentPhaseId = lastPhaseWithActuals();
    }
  } else {
    currentPhaseId = lastPhaseWithActuals();
  }
  if (!currentPhaseId) currentPhaseId = "pre_application";

  /**
   * Phase state:
   * - current: derived current phase
   * - passed: has actual progress OR (pre_certification && Noticed) OR strictly before current with actuals
   * - future: otherwise (including planned-only public-review stages)
   *
   * Note: CEQR and pre-cert can overlap (Noticed while EAS still in progress). Both may be
   * non-future; only one is `current`.
   */
  function phaseState(id) {
    if (id === currentPhaseId) return "current";
    const actuals = (byPhase[id] || []).some(eventIsActualProgress);
    if (id === "pre_certification" && noticed) return "passed";
    if (actuals) {
      const idx = LAND_ULURP_PHASES.indexOf(id);
      const cur = LAND_ULURP_PHASES.indexOf(currentPhaseId);
      // Actuals at or before current → passed; actuals only as planned-labeled rarely after
      if (idx <= cur) return "passed";
      // Actual activity after current (data quirk) still counts as material → passed
      return "passed";
    }
    return "future";
  }

  const phases = LAND_ULURP_PHASES.map((id) => {
    const state = phaseState(id);
    const all = byPhase[id] || [];
    let display;
    if (state === "future") {
      const planned = all.filter(eventIsPlanned);
      display = planned.length ? planned : all;
    } else {
      // History / current: hide pure planned Not Started rows (they live under future phases).
      display = all.filter((e) => !eventIsPlanned(e) || eventIsInProgress(e) || e._synthetic);
      if (!display.length) display = all;
    }

    const dates = display
      .map((e) => isoDate(e.time?.value))
      .filter(Boolean)
      .sort();

    return {
      id,
      short: LAND_PHASE_META[id].short,
      label_key: LAND_PHASE_META[id].label_key,
      state,
      event_count: display.length,
      total_count: all.length,
      first: dates[0] || null,
      last: dates[dates.length - 1] || null,
      aggregates: aggregatePhaseEvents(display),
      events: display,
      all_events: all,
    };
  });

  // Next = first future phase after current; if current is CEQR and notice already passed, skip notice.
  const curIdx = LAND_ULURP_PHASES.indexOf(currentPhaseId);
  let nextPhase = null;
  for (let i = curIdx + 1; i < phases.length; i++) {
    if (phases[i].state === "future") {
      nextPhase = phases[i];
      break;
    }
    // Skip phases already passed (e.g. notice while still in CEQR)
  }
  if (!nextPhase) {
    nextPhase = phases.find((p) => p.state === "future") || null;
  }

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
      in_public_review: publicStatus
        ? /public review|completed|approved/i.test(publicStatus)
        : false,
    },
    next: nextPhase
      ? {
          phase_id: nextPhase.id,
          label_key: nextPhase.label_key,
          short: nextPhase.short,
        }
      : null,
    phases,
    chronological: events,
    event_count: events.length,
    portal_row_link_candidates: countDuplicatePortalLinks({ events }, portalUrl),
    lag: spine?.lag || null,
    gaps: Array.isArray(spine?.gaps) ? spine.gaps : [],
  };
}

/**
 * Count how many portal-identical source URLs would render if every event linked.
 */
export function countDuplicatePortalLinks(spine, portalUrl) {
  const events = Array.isArray(spine?.events) ? spine.events : [];
  return events.filter((e) => isProjectPortalUrl(e.source?.url, portalUrl)).length;
}
