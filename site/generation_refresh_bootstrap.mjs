/**
 * Shared hermetic bootstrap for generation-publishing refresh families.
 *
 * CI and time-travel checkouts commit ACTIVE generation pointers but gitignore
 * refresh receipts. Without a prior receipt, hash/fingerprint planning treats
 * `missing_previous_hashes` as rebuild-required and rewrites tracked ACTIVE
 * (and convenience index) bytes — under `CITYSCROLL_TEST_TIME_SHIFT_DAYS` the
 * rebuilt `built_at` follows the shifted clock even when semantic inputs match.
 *
 * Every generation-publishing refresh must call this helper before planning so
 * a cold checkout seeds an unchanged receipt and leaves committed generation
 * bytes alone when the active generation already matches current inputs.
 */

export const BOOTSTRAP_COMMITTED_REASON = "bootstrap_committed_inputs";
export const BOOTSTRAP_IDLE_NO_ACTIVE_REASON = "bootstrap_idle_no_active_generation";
export const BOOTSTRAP_UNCHANGED_MESSAGE =
  "seeded refresh receipt from committed inputs; generation bytes unchanged";
export const BOOTSTRAP_IDLE_MESSAGE =
  "no activated meeting-geography generation yet; idle under committed-inputs mode";

/**
 * Decide whether a cold checkout should seed a receipt instead of rebuilding.
 *
 * @param {object} input
 * @param {object|null} [input.prior] previous refresh receipt
 * @param {string|null} [input.activeBefore] currently active generation id
 * @param {boolean} [input.force]
 * @param {unknown} [input.injectFailure] test-only failure injection
 * @param {boolean} [input.injectMixedGeneration] test-only mixed-generation injection
 * @param {boolean} [input.bootstrapCommitted] materialization/CI mode (default true)
 * @param {boolean|null} [input.activeMatches]
 *   When `true`/`false`, require an active generation and that match flag.
 *   When `null`, bootstrap even with no active generation (idle cold start).
 */
export function shouldBootstrapCommittedRefresh({
  prior = null,
  activeBefore = null,
  force = false,
  injectFailure = null,
  injectMixedGeneration = false,
  bootstrapCommitted = true,
  activeMatches = true,
} = {}) {
  if (prior || force || injectFailure || injectMixedGeneration || !bootstrapCommitted) {
    return false;
  }
  if (activeMatches === null) {
    return true;
  }
  return Boolean(activeBefore) && Boolean(activeMatches);
}

/**
 * Build the unchanged plan + receipt payload used by every bootstrap path.
 *
 * @param {object} input
 * @param {string} input.receiptSchema
 * @param {string} input.planSchema
 * @param {string} input.now ISO timestamp
 * @param {string|null} [input.activeBefore]
 * @param {string|null} [input.activatedAt]
 * @param {string[]} [input.reasons]
 * @param {object} [input.planFields] extra frozen plan fields (e.g. changed_inputs)
 * @param {object} [input.receiptFields] extra receipt fields (hashes, vintages, …)
 * @param {string|null} [input.message]
 */
export function buildBootstrapUnchangedReceipt({
  receiptSchema,
  planSchema,
  now,
  activeBefore = null,
  activatedAt = null,
  reasons = null,
  planFields = {},
  receiptFields = {},
  message = null,
} = {}) {
  if (!receiptSchema) throw new Error("buildBootstrapUnchangedReceipt requires receiptSchema");
  if (!planSchema) throw new Error("buildBootstrapUnchangedReceipt requires planSchema");
  if (!now) throw new Error("buildBootstrapUnchangedReceipt requires now");

  const resolvedReasons = Object.freeze(
    Array.isArray(reasons) && reasons.length
      ? [...reasons]
      : activeBefore
        ? [BOOTSTRAP_COMMITTED_REASON]
        : [BOOTSTRAP_IDLE_NO_ACTIVE_REASON],
  );
  const resolvedMessage = message
    || (activeBefore ? BOOTSTRAP_UNCHANGED_MESSAGE : BOOTSTRAP_IDLE_MESSAGE);

  const plan = Object.freeze({
    schema: planSchema,
    work_required: false,
    reasons: resolvedReasons,
    ...planFields,
  });

  return {
    schema: receiptSchema,
    started_at: now,
    completed_at: now,
    activated_at: activatedAt,
    status: "unchanged",
    plan,
    active_generation: activeBefore,
    previous_active_generation: activeBefore,
    message: resolvedMessage,
    ...receiptFields,
  };
}

/**
 * When bootstrap applies, optionally persist the receipt and return the shared
 * unchanged run result. Callers merge family-specific fields (index, shards).
 *
 * @returns {null|object} null when bootstrap does not apply
 */
export function tryBootstrapCommittedRefresh({
  prior = null,
  activeBefore = null,
  force = false,
  injectFailure = null,
  injectMixedGeneration = false,
  bootstrapCommitted = true,
  activeMatches = true,
  saveReceipt = null,
  receiptSchema,
  planSchema,
  now,
  activatedAt = null,
  reasons = null,
  planFields = {},
  receiptFields = {},
  message = null,
  resultFields = {},
} = {}) {
  if (!shouldBootstrapCommittedRefresh({
    prior,
    activeBefore,
    force,
    injectFailure,
    injectMixedGeneration,
    bootstrapCommitted,
    activeMatches,
  })) {
    return null;
  }

  const receipt = buildBootstrapUnchangedReceipt({
    receiptSchema,
    planSchema,
    now,
    activeBefore,
    activatedAt,
    reasons,
    planFields,
    receiptFields,
    message,
  });
  if (typeof saveReceipt === "function") saveReceipt(receipt);
  return {
    ok: true,
    status: "unchanged",
    plan: receipt.plan,
    receipt,
    active_generation: activeBefore,
    ...resultFields,
  };
}
