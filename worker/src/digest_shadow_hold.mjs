// Digest-shadow delivery lease. The 06:00 rehearsal remains delivery-free; this module
// turns only its named affected_digest_ids into short-lived 09:00 delivery holds.

export const DIGEST_SHADOW_HOLD_CONTRACT = "digest-shadow-hold.v1";
export const DIGEST_SHADOW_HOLD_CUTOFF_UTC = "12:45:00.000Z";
export const DIGEST_SHADOW_DELIVERY_BOUNDARY_UTC = "13:00:00.000Z";
export const DIGEST_SHADOW_HOLD_EXPIRES_UTC = "14:00:00.000Z";

export class DigestShadowHoldInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "DigestShadowHoldInputError";
  }
}

function iso(value) {
  return new Date(value == null ? Date.now() : value).toISOString();
}

function uniqueIds(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim())
    .filter((value) => value && value !== "run"))].sort();
}

function boundary(day, time) {
  return `${day}T${time}`;
}

function openState({ now, sourceStatus, observation }) {
  const evaluatedAt = iso(now);
  const day = evaluatedAt.slice(0, 10);
  return {
    contract: DIGEST_SHADOW_HOLD_CONTRACT,
    run_day: day,
    evaluated_at: evaluatedAt,
    cutoff_at: boundary(day, DIGEST_SHADOW_HOLD_CUTOFF_UTC),
    delivery_boundary_at: boundary(day, DIGEST_SHADOW_DELIVERY_BOUNDARY_UTC),
    expires_at: boundary(day, DIGEST_SHADOW_HOLD_EXPIRES_UTC),
    source_status: sourceStatus,
    delivery_policy: "ALL_DIGESTS_ELIGIBLE",
    fail_policy: sourceStatus === "READY" ? "not_applicable" : "fail_open_without_digest_scope",
    affected_digest_ids: [],
    overridden_digest_ids: [],
    active_digest_ids: [],
    observation: observation || null,
  };
}

/** Pure policy builder. Times match the configured 13:00 UTC production delivery cron. */
export function buildDigestShadowHoldState({
  summary = null,
  overriddenDigestIds = [],
  now = new Date(),
  sourceError = null,
} = {}) {
  if (sourceError) {
    return openState({
      now,
      sourceStatus: "HOLD_STORE_UNAVAILABLE",
      observation: String(sourceError?.message || sourceError),
    });
  }

  const evaluatedAt = iso(now);
  const day = evaluatedAt.slice(0, 10);
  if (!summary || summary.run_day !== day) {
    return openState({
      now,
      sourceStatus: "MISSING_RUN",
      observation: summary?.run_day ? `latest run is ${summary.run_day}` : "no run for delivery day",
    });
  }

  const base = {
    contract: DIGEST_SHADOW_HOLD_CONTRACT,
    run_day: day,
    evaluated_at: evaluatedAt,
    cutoff_at: boundary(day, DIGEST_SHADOW_HOLD_CUTOFF_UTC),
    delivery_boundary_at: boundary(day, DIGEST_SHADOW_DELIVERY_BOUNDARY_UTC),
    expires_at: boundary(day, DIGEST_SHADOW_HOLD_EXPIRES_UTC),
  };
  const affected = uniqueIds(summary.affected_digest_ids);
  const overridden = uniqueIds(overriddenDigestIds).filter((id) => affected.includes(id));

  if (summary.status === "READY" && summary.ok !== false) {
    return {
      ...base,
      source_status: "READY",
      delivery_policy: "ALL_DIGESTS_ELIGIBLE",
      fail_policy: "not_applicable",
      affected_digest_ids: [],
      overridden_digest_ids: [],
      active_digest_ids: [],
      observation: "authenticated successful reruns release the scoped hold state",
    };
  }

  if (evaluatedAt < base.cutoff_at) {
    return {
      ...base,
      source_status: "REDLINES_REPAIR_WINDOW",
      delivery_policy: "ALL_DIGESTS_ELIGIBLE",
      fail_policy: "repair_window_open",
      affected_digest_ids: affected,
      overridden_digest_ids: overridden,
      active_digest_ids: [],
      observation: "redlined digests become held only if still affected at the 12:45 UTC cutoff",
    };
  }

  if (evaluatedAt >= base.expires_at) {
    return {
      ...base,
      source_status: "REDLINES_HOLD_EXPIRED",
      delivery_policy: "ALL_DIGESTS_ELIGIBLE",
      fail_policy: "fail_open_after_expiry",
      affected_digest_ids: affected,
      overridden_digest_ids: overridden,
      active_digest_ids: [],
      observation: "holds never survive beyond the bounded delivery window",
    };
  }

  if (affected.length === 0) {
    return {
      ...base,
      source_status: "REDLINES_WITHOUT_DIGEST_SCOPE",
      delivery_policy: "ALL_DIGESTS_ELIGIBLE",
      fail_policy: "fail_open_without_digest_scope",
      affected_digest_ids: [],
      overridden_digest_ids: [],
      active_digest_ids: [],
      observation: "run-level redlines cannot become a global delivery hold",
    };
  }

  const active = affected.filter((id) => !overridden.includes(id));
  return {
    ...base,
    source_status: "REDLINES_AT_CUTOFF",
    delivery_policy: active.length ? "AFFECTED_DIGESTS_HELD" : "ALL_DIGESTS_ELIGIBLE",
    fail_policy: "fail_closed_for_named_digests",
    affected_digest_ids: affected,
    overridden_digest_ids: overridden,
    active_digest_ids: active,
    observation: active.length
      ? `${active.length} named digest(s) held; unrelated digests remain eligible`
      : "every named digest has an authenticated operator override",
  };
}

export function isDigestHeld(state, digestId) {
  return !!digestId && new Set(state?.active_digest_ids || []).has(digestId);
}

export async function digestShadowId(kind, value) {
  const input = new TextEncoder().encode(String(value || ""));
  const digest = await crypto.subtle.digest("SHA-256", input);
  const hex = Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${kind}:${hex.slice(0, 24)}`;
}

export async function digestIdForJob(job = {}) {
  if (job.type === "rollup") {
    return digestShadowId("digest", (job.keys || []).map(String).sort().join("|"));
  }
  return digestShadowId("digest", job.key || "");
}

export async function partitionDigestJobsByHold(jobs = [], state = null) {
  const eligible = [];
  const held = [];
  for (const job of jobs) {
    const digestId = await digestIdForJob(job);
    if (isDigestHeld(state, digestId)) held.push({ job, digest_id: digestId });
    else eligible.push(job);
  }
  return { eligible, held };
}

async function readSummary(db, day) {
  const row = await db.prepare(
    "SELECT summary_json FROM digest_shadow_runs WHERE run_day = ?",
  ).bind(day).first();
  return row?.summary_json ? JSON.parse(row.summary_json) : null;
}

async function readOverrides(db, day) {
  const out = await db.prepare(
    "SELECT digest_id FROM digest_shadow_hold_overrides WHERE run_day = ? ORDER BY digest_id",
  ).bind(day).all();
  return uniqueIds((out?.results || []).map((row) => row.digest_id));
}

async function persistState(db, state) {
  await db.prepare(`INSERT INTO digest_shadow_hold_states
    (run_day, contract, evaluated_at, source_status, delivery_policy, cutoff_at,
      delivery_boundary_at, expires_at, state_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_day) DO UPDATE SET
      contract = excluded.contract,
      evaluated_at = excluded.evaluated_at,
      source_status = excluded.source_status,
      delivery_policy = excluded.delivery_policy,
      cutoff_at = excluded.cutoff_at,
      delivery_boundary_at = excluded.delivery_boundary_at,
      expires_at = excluded.expires_at,
      state_json = excluded.state_json`)
    .bind(
      state.run_day,
      state.contract,
      state.evaluated_at,
      state.source_status,
      state.delivery_policy,
      state.cutoff_at,
      state.delivery_boundary_at,
      state.expires_at,
      JSON.stringify(state),
    ).run();
}

/** Delivery-path read. Missing/unavailable state is intentionally fail-open and explicit. */
export async function resolveDigestShadowHold(db, { now = new Date(), persist = false } = {}) {
  if (!db) {
    return buildDigestShadowHoldState({ now, sourceError: new Error("DB binding unavailable") });
  }
  const day = iso(now).slice(0, 10);
  let state;
  try {
    const [summary, overriddenDigestIds] = await Promise.all([
      readSummary(db, day),
      readOverrides(db, day),
    ]);
    state = buildDigestShadowHoldState({ summary, overriddenDigestIds, now });
  } catch (error) {
    return buildDigestShadowHoldState({ now, sourceError: error });
  }
  if (persist) {
    try {
      await persistState(db, state);
    } catch (error) {
      state = { ...state, observation: `${state.observation}; audit persistence failed: ${String(error?.message || error)}` };
    }
  }
  return state;
}

/** Shadow-run write. A READY rerun replaces any active state with an eligible receipt. */
export async function recordDigestShadowHoldState(db, summary, { now = new Date() } = {}) {
  const day = summary?.run_day || iso(now).slice(0, 10);
  let overriddenDigestIds = [];
  if (summary?.status === "READY" && summary?.ok !== false) {
    await db.prepare("DELETE FROM digest_shadow_hold_overrides WHERE run_day = ?").bind(day).run();
  } else {
    overriddenDigestIds = await readOverrides(db, day);
  }
  const state = buildDigestShadowHoldState({ summary, overriddenDigestIds, now });
  await persistState(db, state);
  return state;
}

export async function overrideDigestShadowHold(db, {
  day,
  digestIds,
  reason,
  now = new Date(),
} = {}) {
  const runDay = day || iso(now).slice(0, 10);
  const summary = await readSummary(db, runDay);
  if (!summary) throw new DigestShadowHoldInputError("no digest shadow run exists for the requested day");
  const affected = uniqueIds(summary.affected_digest_ids);
  const requested = uniqueIds(digestIds);
  const invalid = requested.filter((id) => !affected.includes(id));
  if (!requested.length) throw new DigestShadowHoldInputError("digest_ids must name at least one affected digest");
  if (requested.length > 100) throw new DigestShadowHoldInputError("digest_ids exceeds the 100-item override limit");
  if (invalid.length) throw new DigestShadowHoldInputError(`digest_ids are not affected by this run: ${invalid.join(", ")}`);
  const note = String(reason || "").trim();
  if (!note) throw new DigestShadowHoldInputError("reason is required for an operator override");
  if (note.length > 500) throw new DigestShadowHoldInputError("reason exceeds 500 characters");
  const createdAt = iso(now);
  const existing = await readOverrides(db, runDay);
  await db.batch(requested.map((digestId) => db.prepare(`INSERT INTO digest_shadow_hold_overrides
    (run_day, digest_id, created_at, reason)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(run_day, digest_id) DO UPDATE SET
      created_at = excluded.created_at,
      reason = excluded.reason`)
    .bind(runDay, digestId, createdAt, note)));
  const state = buildDigestShadowHoldState({
    summary,
    overriddenDigestIds: uniqueIds([...existing, ...requested]),
    now,
  });
  await persistState(db, state);
  return state;
}
