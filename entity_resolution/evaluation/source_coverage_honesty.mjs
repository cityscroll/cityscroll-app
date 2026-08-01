// Source-observation coverage honesty.
//
// Adapter readiness (dual-write flag + fixture + schema) is not production
// coverage. Live completeness is derived from source_records row counts and
// recency. A stream with zero rows must never report "complete".

export const LIVE_OBSERVATION_STATUSES = Object.freeze([
  "complete",
  "partial",
  "stale",
  "empty-declared-live",
  "gap",
]);

/** Statuses that mean the dual-write path is declared ready (code/flag exist). */
export const ADAPTER_READY_STATUSES = Object.freeze([
  "complete",
  "partial",
  "stale",
  "empty-declared-live",
]);

/** Only complete counts toward the named source_coverage covered metric. */
export const COVERED_STATUSES = Object.freeze(["complete"]);

/** Any non-zero live observations (complete + partial + stale). */
export const POPULATED_STATUSES = Object.freeze(["complete", "partial", "stale"]);

export const DEFAULT_STALE_AFTER_DAYS = 2;

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

/**
 * Classify live observation health from measured production data.
 *
 * @param {object} input
 * @param {boolean} input.adapterReady — dual-write path declared (flag/fixture/schema)
 * @param {number|null|undefined} input.rowCount — source_records COUNT for this system
 * @param {string|null|undefined} input.latestIngestedAt — max(ingested_at) ISO
 * @param {string|Date|number} [input.now]
 * @param {number} [input.staleAfterDays]
 * @param {"complete"|"partial"|null} [input.thinness] — explicit partial override
 * @returns {"complete"|"partial"|"stale"|"empty-declared-live"|"gap"}
 */
export function classifyLiveObservation({
  adapterReady,
  rowCount,
  latestIngestedAt = null,
  now = new Date(),
  staleAfterDays = DEFAULT_STALE_AFTER_DAYS,
  thinness = null,
} = {}) {
  if (!adapterReady) return "gap";
  const n = Number(rowCount);
  const count = Number.isFinite(n) ? n : 0;
  if (count <= 0) return "empty-declared-live";

  const ageDays = observationAgeDays(latestIngestedAt, now);
  if (ageDays != null && ageDays > staleAfterDays) return "stale";

  if (thinness === "partial") return "partial";
  return "complete";
}

/**
 * Days since latest_ingested_at, or null when timestamp is missing/invalid.
 * Missing timestamps with row_count > 0 are treated as non-stale by classify
 * (callers should stamp measured recency when known).
 */
export function observationAgeDays(latestIngestedAt, now = new Date()) {
  const ms = Date.parse(String(latestIngestedAt || ""));
  if (!Number.isFinite(ms)) return null;
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  if (!Number.isFinite(nowMs)) return null;
  return (nowMs - ms) / (24 * 60 * 60 * 1000);
}

export function isAdapterReadyFromRow(row) {
  const dw = row?.dual_write || {};
  if (dw.adapter === "ready") return true;
  if (dw.adapter === "gap") return false;
  // Infer: a dual-write flag plus schema/fixture means the path is declared.
  return Boolean(dw.flag && row?.observation_schema && row?.fixture);
}

/**
 * Build / validate the live_observation object for one inventory row.
 * When live_observation.status is present it must match classify(); when
 * omitted, status is derived from row counts.
 */
export function resolveLiveObservation(row, {
  now = new Date(),
  staleAfterDays = DEFAULT_STALE_AFTER_DAYS,
} = {}) {
  const live = row?.live_observation && typeof row.live_observation === "object"
    ? { ...row.live_observation }
    : {};
  const rowCount = live.row_count != null ? Number(live.row_count) : null;
  const adapterReady = isAdapterReadyFromRow(row);
  const thinness = live.thinness === "partial" || row?.dual_write?.after === "partial"
    ? "partial"
    : null;
  const derived = classifyLiveObservation({
    adapterReady,
    rowCount: rowCount ?? 0,
    latestIngestedAt: live.latest_ingested_at,
    now,
    staleAfterDays,
    thinness,
  });
  return {
    status: live.status || derived,
    derived_status: derived,
    row_count: Number.isFinite(rowCount) ? rowCount : 0,
    latest_ingested_at: live.latest_ingested_at ?? null,
    measured_at: live.measured_at ?? null,
    thinness: thinness || null,
    note: live.note ?? null,
  };
}

/**
 * Summarize live coverage for the matrix. Covered = complete only.
 */
export function measureLiveCoverage(sources, opts = {}) {
  const rows = Array.isArray(sources) ? sources : [];
  const byStatus = Object.fromEntries(LIVE_OBSERVATION_STATUSES.map((s) => [s, 0]));
  const resolved = [];
  for (const row of rows) {
    const live = resolveLiveObservation(row, opts);
    // Prefer the declared dual_write.after when it is a live status — inventory
    // is the committed claim; classify is the honesty cross-check.
    const status = LIVE_OBSERVATION_STATUSES.includes(row?.dual_write?.after)
      ? row.dual_write.after
      : live.derived_status;
    byStatus[status] = (byStatus[status] || 0) + 1;
    resolved.push({ id: row.id, source_system: row.source_system, status, live });
  }
  const total = rows.length;
  const covered = COVERED_STATUSES.reduce((n, s) => n + (byStatus[s] || 0), 0);
  const populated = POPULATED_STATUSES.reduce((n, s) => n + (byStatus[s] || 0), 0);
  const adapterReady = ADAPTER_READY_STATUSES.reduce((n, s) => n + (byStatus[s] || 0), 0);
  return {
    total,
    covered,
    populated,
    adapter_ready: adapterReady,
    rate: total > 0 ? Number((covered / total).toFixed(4)) : 0,
    populated_rate: total > 0 ? Number((populated / total).toFixed(4)) : 0,
    by_status: byStatus,
    streams: resolved,
  };
}

/**
 * Honesty violations that must fail the coverage gate.
 * Primary rule: dual_write.after === "complete" with row_count === 0.
 */
export function findCoverageHonestyViolations(sources, opts = {}) {
  const violations = [];
  for (const row of Array.isArray(sources) ? sources : []) {
    const after = row?.dual_write?.after;
    const live = resolveLiveObservation(row, opts);
    const count = live.row_count;

    if (after === "complete" && !(count > 0)) {
      violations.push({
        id: row.id,
        kind: "complete-with-zero-rows",
        message: `${row.id}: dual_write.after is "complete" but live_observation.row_count is ${count}`,
        after,
        row_count: count,
      });
    }
    if (after === "empty-declared-live" && count > 0) {
      violations.push({
        id: row.id,
        kind: "empty-declared-with-rows",
        message: `${row.id}: dual_write.after is "empty-declared-live" but row_count is ${count}`,
        after,
        row_count: count,
      });
    }
    if ((after === "partial" || after === "stale") && !(count > 0)) {
      violations.push({
        id: row.id,
        kind: `${after}-with-zero-rows`,
        message: `${row.id}: dual_write.after is "${after}" but live_observation.row_count is ${count}`,
        after,
        row_count: count,
      });
    }
    if (after === "gap" && count > 0) {
      // Soft: gap with rows is unexpected but not a false-green; flag as note.
      violations.push({
        id: row.id,
        kind: "gap-with-rows",
        message: `${row.id}: dual_write.after is "gap" but live_observation.row_count is ${count}`,
        after,
        row_count: count,
        severity: "warn",
      });
    }
    // Declared status must match classify when row_count is present.
    if (live.status && live.derived_status && live.status !== live.derived_status) {
      // Allow partial when classify says complete (thinness is editorial).
      const allowed =
        (live.status === "partial" && live.derived_status === "complete")
        || (live.status === "stale" && (live.derived_status === "complete" || live.derived_status === "partial"));
      if (!allowed) {
        violations.push({
          id: row.id,
          kind: "status-mismatch",
          message: `${row.id}: live_observation.status "${live.status}" disagrees with derived "${live.derived_status}"`,
          after,
          row_count: count,
        });
      }
    }
  }
  return violations.filter((v) => v.severity !== "warn");
}

/**
 * Emit improvement cards for dishonest or empty dual-write streams.
 * Shape matches multi-flywheel cards so the coverage dimension can re-use them.
 *
 * @param {object} matrix — source_coverage.json
 * @param {object} [opts]
 * @param {(card: object) => object} [opts.wrapCard] — optional transform
 */
export function emitCoverageHonestyCards(matrix, opts = {}) {
  const sources = Array.isArray(matrix?.sources) ? matrix.sources : [];
  const cards = [];
  for (const row of sources) {
    const after = row?.dual_write?.after;
    const live = resolveLiveObservation(row, opts);
    if (after === "empty-declared-live" || (after === "complete" && !(live.row_count > 0))) {
      cards.push(wrapHonestyCard({
        slug: `empty-declared-live-${row.id}`,
        title: `Empty dual-write observations: ${row.id}`,
        rank_score: 95,
        evidence: {
          source_id: row.id,
          source_system: row.source_system,
          dual_write_after: after,
          row_count: live.row_count,
          kind: "empty-declared-live",
          flag: row.dual_write?.flag || null,
        },
        verify: `node tools/check_er_source_coverage.mjs --matrix entity_resolution/source_coverage.json # ${row.id} not empty-declared-live`,
        demo_win: `Source ${row.id} retains non-zero immutable source_records and no longer reports a false complete.`,
        context: [
          "entity_resolution/source_coverage.json",
          row.importer || null,
          row.fixture || null,
        ].filter(Boolean),
        lesson_class: "empty-declared-live-coverage",
      }, opts.wrapCard));
    } else if (after === "stale") {
      cards.push(wrapHonestyCard({
        slug: `stale-observations-${row.id}`,
        title: `Stale dual-write observations: ${row.id}`,
        rank_score: 80,
        evidence: {
          source_id: row.id,
          source_system: row.source_system,
          dual_write_after: after,
          row_count: live.row_count,
          latest_ingested_at: live.latest_ingested_at,
          kind: "stale-observations",
        },
        verify: `node tools/check_er_source_coverage.mjs --matrix entity_resolution/source_coverage.json # ${row.id} not stale`,
        demo_win: `Source ${row.id} dual-write is fresh within the stale window.`,
        context: ["entity_resolution/source_coverage.json", row.importer || null].filter(Boolean),
        lesson_class: "stale-source-observations",
      }, opts.wrapCard));
    } else if (after === "partial") {
      cards.push(wrapHonestyCard({
        slug: `partial-observations-${row.id}`,
        title: `Partial observation coverage: ${row.id}`,
        rank_score: 60,
        evidence: {
          source_id: row.id,
          source_system: row.source_system,
          dual_write_after: after,
          row_count: live.row_count,
          kind: "partial-observations",
          note: live.note || null,
        },
        verify: `node tools/check_er_source_coverage.mjs --matrix entity_resolution/source_coverage.json # ${row.id} complete`,
        demo_win: `Source ${row.id} observation coverage is complete, not partial.`,
        context: ["entity_resolution/source_coverage.json", row.importer || null].filter(Boolean),
        lesson_class: "partial-source-observations",
      }, opts.wrapCard));
    }
  }
  return cards;
}

function wrapHonestyCard(card, wrapCard) {
  const base = {
    schema: "cityscroll.multi_flywheel_card.v0",
    id: `crol-list/mf-coverage-${clean(card.slug).toLowerCase().replace(/[^a-z0-9._-]+/g, "-")}`,
    dimension: "coverage",
    title: card.title,
    status: "proposed",
    rank_score: card.rank_score,
    rank: null,
    emitted_by: "source_coverage_honesty",
    evidence: card.evidence,
    context: card.context,
    verify: card.verify,
    demo_win: card.demo_win,
    lesson_class: card.lesson_class,
  };
  return typeof wrapCard === "function" ? wrapCard(base) : base;
}

/**
 * Recompute measurement.after (live covered) and by_status from sources.
 * before stays historical (adapter-era complete counts) unless recomputed.
 */
export function recomputeMeasurement(matrix, opts = {}) {
  const sources = Array.isArray(matrix?.sources) ? matrix.sources : [];
  const live = measureLiveCoverage(sources, opts);
  const adapterBefore = sources.filter((r) => r?.dual_write?.before === "complete").length;
  const adapterAfter = sources.filter((r) => ADAPTER_READY_STATUSES.includes(r?.dual_write?.after)).length;
  const total = sources.length;
  return {
    unit: matrix?.measurement?.unit || "identity-bearing importer streams",
    observed_at: matrix?.measurement?.observed_at || null,
    stale_after_days: matrix?.measurement?.stale_after_days ?? DEFAULT_STALE_AFTER_DAYS,
    before: {
      covered: adapterBefore,
      total,
      rate: total > 0 ? Number((adapterBefore / total).toFixed(4)) : 0,
      basis: "historical adapter-ready (dual_write.before === complete)",
    },
    after: {
      covered: live.covered,
      total: live.total,
      rate: live.rate,
      basis: "live source_records: dual_write.after === complete requires row_count > 0",
    },
    by_status: live.by_status,
    populated: { covered: live.populated, total: live.total, rate: live.populated_rate },
    adapter_ready: {
      before: adapterBefore,
      after: adapterAfter,
      total,
      rate_after: total > 0 ? Number((adapterAfter / total).toFixed(4)) : 0,
    },
    basis: matrix?.measurement?.basis || null,
  };
}

/**
 * Reference "now" for staleness: prefer explicit opts.now, then matrix
 * measurement.observed_at, then wall clock. Keeps CI deterministic against a
 * committed measurement window.
 */
export function measurementNow(matrix, opts = {}) {
  if (opts.now != null) return opts.now;
  const observed = matrix?.measurement?.observed_at;
  if (observed) {
    // Date-only stamps mean end of that UTC day for recency checks.
    const raw = String(observed);
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${raw}T23:59:59.000Z`;
    return raw;
  }
  return new Date();
}

/**
 * Validate matrix structure + honesty. Returns { ok, errors, warnings, measurement }.
 */
export function validateSourceCoverageMatrix(matrix, opts = {}) {
  const errors = [];
  const warnings = [];
  const sources = Array.isArray(matrix?.sources) ? matrix.sources : [];
  if (!sources.length) errors.push("sources must be a non-empty array");

  const staleAfterDays = Number(
    opts.staleAfterDays ?? matrix?.measurement?.stale_after_days ?? DEFAULT_STALE_AFTER_DAYS,
  );
  const checkOpts = {
    ...opts,
    now: measurementNow(matrix, opts),
    staleAfterDays,
  };

  const ids = new Set();
  for (const row of sources) {
    if (!row?.id || ids.has(row.id)) {
      errors.push(`source id is missing or duplicated: ${row?.id || "<blank>"}`);
      continue;
    }
    ids.add(row.id);
    for (const field of ["source_system", "importer", "stable_source_key"]) {
      if (!row[field]) errors.push(`${row.id}: ${field} is required`);
    }
    if (!Array.isArray(row.identity_entities) || !row.identity_entities.length) {
      errors.push(`${row.id}: identity_entities must be non-empty`);
    }
    const before = row.dual_write?.before;
    const after = row.dual_write?.after;
    if (!["complete", "gap"].includes(before)) {
      errors.push(`${row.id}: invalid dual_write.before (historical complete|gap only)`);
    }
    if (!LIVE_OBSERVATION_STATUSES.includes(after)) {
      errors.push(`${row.id}: invalid dual_write.after (expected one of ${LIVE_OBSERVATION_STATUSES.join(", ")})`);
    }

    const live = resolveLiveObservation(row, checkOpts);
    if (row.live_observation == null || row.live_observation.row_count == null) {
      errors.push(`${row.id}: live_observation.row_count is required (honest coverage needs measured counts)`);
    }

    if (after === "complete") {
      if (!row.dual_write?.flag || row.dual_write.default !== "off" || row.dual_write.fail_soft !== true) {
        errors.push(`${row.id}: complete rows require an off-by-default, fail-soft flag`);
      }
      if (!row.observation_schema || !row.fixture || !row.replay_test) {
        errors.push(`${row.id}: complete rows require schema, fixture, and replay_test`);
      }
      if (row.known_gap !== null) errors.push(`${row.id}: complete rows must clear known_gap`);
      if (!(live.row_count > 0)) {
        errors.push(`${row.id}: complete requires live_observation.row_count > 0 (got ${live.row_count})`);
      }
    } else if (after === "partial" || after === "stale") {
      if (!row.dual_write?.flag) errors.push(`${row.id}: ${after} rows require a dual-write flag`);
      if (!(live.row_count > 0)) {
        errors.push(`${row.id}: ${after} requires live_observation.row_count > 0`);
      }
      if (!row.known_gap && !live.note) {
        errors.push(`${row.id}: ${after} rows must name known_gap or live_observation.note`);
      }
    } else if (after === "empty-declared-live") {
      if (!row.dual_write?.flag || row.dual_write.default !== "off" || row.dual_write.fail_soft !== true) {
        errors.push(`${row.id}: empty-declared-live requires an off-by-default, fail-soft flag`);
      }
      if (!row.observation_schema || !row.fixture || !row.replay_test) {
        errors.push(`${row.id}: empty-declared-live requires schema, fixture, and replay_test (adapter exists)`);
      }
      if (live.row_count !== 0) {
        errors.push(`${row.id}: empty-declared-live requires row_count === 0 (got ${live.row_count})`);
      }
      if (!row.known_gap && !live.note) {
        errors.push(`${row.id}: empty-declared-live must explain the empty state (known_gap or note)`);
      }
    } else if (after === "gap") {
      if (!row.known_gap) errors.push(`${row.id}: gap rows must name the known gap`);
    }
  }

  for (const v of findCoverageHonestyViolations(sources, checkOpts)) {
    if (!errors.some((e) => e.includes(v.id) && e.includes("row_count"))) {
      errors.push(v.message);
    }
  }

  const measurement = recomputeMeasurement(matrix, checkOpts);
  const claimed = matrix?.measurement?.after;
  if (claimed) {
    if (claimed.covered !== measurement.after.covered
      || claimed.total !== measurement.after.total
      || claimed.rate !== measurement.after.rate) {
      errors.push(
        `after measurement drift: matrix claims ${claimed.covered}/${claimed.total} (${claimed.rate}) `
        + `but live complete count is ${measurement.after.covered}/${measurement.after.total} (${measurement.after.rate})`,
      );
    }
  }
  const claimedBefore = matrix?.measurement?.before;
  if (claimedBefore) {
    if (claimedBefore.covered !== measurement.before.covered
      || claimedBefore.total !== measurement.before.total
      || claimedBefore.rate !== measurement.before.rate) {
      errors.push(
        `before measurement drift: expected ${measurement.before.covered}/${measurement.before.total} (${measurement.before.rate})`,
      );
    }
  }

  return { ok: errors.length === 0, errors, warnings, measurement };
}
