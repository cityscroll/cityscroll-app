/* Fixed cost budgets and typed failure classification for the Land Map (LM-12).
 *
 * LM-05 made the browse Map route-lazy and LM-08/LM-09/LM-11 gave it filter parity,
 * boundary context, and a complete keyboard/screen-reader path. None of that work fixed a
 * cost ceiling or gave a resident's browser a way to tell "the data does not exist" apart
 * from "the network is slow right now" apart from "the response could not be trusted." This
 * module is that ceiling and that taxonomy, in one place so both the runtime and the evidence
 * receipts that measure it read the same numbers.
 *
 * Every budget below is fixed before measurement, the same way `docs/evidence/
 * land-map-route-lazy-shell.json#module_size_gate` fixed a byte ceiling ahead of the split it
 * gated: a receipt that exceeds one of these numbers fails the gate it is checked against
 * rather than being used to redefine the number to fit what was measured.
 */

export const LAND_MAP_PERFORMANCE_SCHEMA = "cityscroll.land_map_performance_budget.v1";

/**
 * The five ways a Map dependency can fail, distinguished because they call for different
 * responses: `projection` and `invalid-data` are permanent -- retrying reads the same absent
 * or untrustworthy artifact again -- while `dependency` and `timeout` are transient and get
 * a bounded retry. `tile` is measured, not thrown here: it names a detail-map tile-provider
 * failure (Leaflet/Carto), which LM-05 and LM-11 both left unmigrated and this card does not
 * change either; the capture harness records it as a fact about the unchanged detail map, and
 * the constant exists so that evidence has one stable name to record it under.
 */
export const LAND_MAP_FAILURE_KINDS = Object.freeze({
  PROJECTION: "projection",
  DEPENDENCY: "dependency",
  TILE: "tile",
  TIMEOUT: "timeout",
  INVALID_DATA: "invalid-data",
  UNKNOWN: "unknown",
});

/* Measured baselines this card found, with headroom, not the tightest number that happens to
 * pass today: site/data/land_project_map_points.json was 22,849 bytes; site/data/
 * land_default_ulurp.json was 249,323 bytes; the three boundary layers (borough,
 * community_district, council_district) totalled 330,791 bytes; browse Map activation issues
 * exactly those 1 + 3 = 4 deferred requests. */
export const LAND_MAP_BUDGETS = Object.freeze({
  list_snapshot_bytes_max: 400_000,
  list_first_paint_ms_max: 3_000,
  map_activation_requests_max: 4,
  map_activation_bytes_max: 500_000,
  map_activation_ms_max: 3_000,
  map_projection_bytes_max: 40_000,
  map_request_timeout_ms: 4_000,
  map_transient_retry_max: 2,
  map_transient_retry_delay_ms: 150,
});

/** A typed Map failure. `transient` marks the two kinds `fetchLandMapArtifact` retries; every
 * other kind reaches the caller on the first attempt. */
export class LandMapFailure extends Error {
  constructor(kind, message, { transient = false, cause } = {}) {
    super(message);
    this.name = "LandMapFailure";
    this.landMapFailureKind = kind;
    this.transient = transient;
    if (cause !== undefined) this.cause = cause;
  }
}

const defaultWait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * One request, bounded to `timeoutMs` no matter what the underlying `fetchImpl` does with an
 * abort signal. A `Promise.race` against a plain timer -- rather than trusting the fetch
 * implementation to honor `AbortSignal` -- is what actually protects a caller from a hang: a
 * same-origin boundary-layer request that never settles previously left `Promise.all` in
 * `mountLandBrowseMap` waiting forever, holding the whole Map (markers included) in "loading"
 * even though a missing boundary layer is supposed to be a soft, non-blocking degradation.
 */
export function fetchWithBudget(fetchImpl, url, { timeoutMs = LAND_MAP_BUDGETS.map_request_timeout_ms, init = {} } = {}) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      controller?.abort();
      const error = new Error(`${url}: exceeded ${timeoutMs}ms`);
      error.name = "LandMapTimeoutSignal";
      reject(error);
    }, timeoutMs);
  });
  const attempt = Promise.resolve(fetchImpl(url, controller ? { ...init, signal: controller.signal } : init));
  // Once the timeout has won the race, a late settlement of `attempt` must not become an
  // unhandled rejection -- it is no longer anyone's result.
  attempt.catch(() => {});
  return Promise.race([attempt, timeout])
    .catch((error) => {
      if (error?.name === "LandMapTimeoutSignal") {
        throw new LandMapFailure(LAND_MAP_FAILURE_KINDS.TIMEOUT, error.message, { transient: true, cause: error });
      }
      throw new LandMapFailure(LAND_MAP_FAILURE_KINDS.DEPENDENCY, `${url}: ${error?.message || "request failed"}`, { transient: true, cause: error });
    })
    .finally(() => clearTimeout(timer));
}

/**
 * Fetch one committed, versioned, same-origin artifact with a fixed time budget, bounded
 * transient retry, and typed failure classification.
 *
 * A permanent failure is never retried: a real HTTP status (the artifact is genuinely not
 * there, or the server said so) and a response that fails `validate` (the artifact is there
 * but not trustworthy) both read the same on a second attempt, so retrying would only delay
 * an honest failure. Retry exists for the two kinds where a second attempt can plausibly read
 * a different answer -- the request never produced a response at all, or it exceeded budget.
 */
export async function fetchLandMapArtifact(url, {
  fetchImpl = globalThis.fetch,
  timeoutMs = LAND_MAP_BUDGETS.map_request_timeout_ms,
  retries = LAND_MAP_BUDGETS.map_transient_retry_max,
  retryDelayMs = LAND_MAP_BUDGETS.map_transient_retry_delay_ms,
  init = { cache: "force-cache", credentials: "omit" },
  validate,
  wait = defaultWait,
} = {}) {
  let attempt = 0;
  for (;;) {
    let response;
    try {
      response = await fetchWithBudget(fetchImpl, url, { timeoutMs, init });
    } catch (error) {
      const transient = error instanceof LandMapFailure ? error.transient : true;
      if (transient && attempt < retries) {
        attempt += 1;
        await wait(retryDelayMs);
        continue;
      }
      throw error instanceof LandMapFailure ? error
        : new LandMapFailure(LAND_MAP_FAILURE_KINDS.DEPENDENCY, `${url}: ${error?.message || "request failed"}`, { transient: false, cause: error });
    }
    if (!response?.ok) {
      throw new LandMapFailure(LAND_MAP_FAILURE_KINDS.PROJECTION, `${url}: http-${response?.status}`, { transient: false });
    }
    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      throw new LandMapFailure(LAND_MAP_FAILURE_KINDS.INVALID_DATA, `${url}: unparseable response`, { transient: false, cause: error });
    }
    if (typeof validate === "function" && !validate(payload)) {
      throw new LandMapFailure(LAND_MAP_FAILURE_KINDS.INVALID_DATA, `${url}: schema violation`, { transient: false });
    }
    return { payload, attempts: attempt };
  }
}

/** The typed kind a caller should record for an error this module did not necessarily throw
 * itself -- `buildLandMapModel` and other non-network failures included -- so a receipt or a
 * dataset attribute always carries one of the five names above rather than nothing. */
export function landMapFailureKindOf(error) {
  return error instanceof LandMapFailure ? error.landMapFailureKind : LAND_MAP_FAILURE_KINDS.UNKNOWN;
}
