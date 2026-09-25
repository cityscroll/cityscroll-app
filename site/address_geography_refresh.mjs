/**
 * Incremental address-geography refresh: PAD → coordinates → boundaries →
 * record joins → resident meeting outputs, within one publication generation.
 *
 * Invalidation:
 *   - PAD content change → re-resolve addresses
 *   - coordinate generation change → recompute affected BBL memberships
 *   - boundary layer digest change → recompute that membership layer only
 *   - source venue / assertion change → replace that record's assertions
 *
 * Unchanged input hashes are reused. A failed or partial run leaves the last
 * activated public generation in place and records the failure on the operator
 * receipt. Build/ingestion path only — never the resident request path.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  meetingGeographyInputHash,
} from "./meeting_geography_backfill.mjs";
import { padContentIdentity } from "./record_address_resolution_cache.mjs";

export const ADDRESS_GEOGRAPHY_REFRESH_SCHEMA = "cityscroll.address_geography_refresh.v1";
export const ADDRESS_GEOGRAPHY_REFRESH_RECEIPT_SCHEMA =
  "cityscroll.address_geography_refresh_receipt.v1";
export const ADDRESS_GEOGRAPHY_REFRESH_PLAN_SCHEMA =
  "cityscroll.address_geography_refresh_plan.v1";

export const REFRESH_STAGES = Object.freeze([
  "pad",
  "coordinates",
  "boundaries",
  "memberships",
  "record_joins",
  "resident_outputs",
]);

export const WEEKLY_FORCE_VERIFICATION_MS = 7 * 24 * 60 * 60 * 1000;

function sha256Hex(value) {
  return createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

function stableStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function cleanText(value, max = 500) {
  const text = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
  return text || null;
}

/**
 * Fingerprint the geography inputs that drive invalidation.
 * @param {object} input
 * @param {object|null} [input.padManifest]
 * @param {string|null} [input.padMetadataEqualityKey] publisher metadata equality token
 * @param {object|null} [input.coordinateManifest]
 * @param {string|null} [input.coordinateMetadataEqualityKey]
 * @param {Record<string, string>} [input.boundaryDigests] layer type → content digest
 * @param {object[]} [input.meetingRows]
 * @returns {object}
 */
export function computeAddressGeographyFingerprints({
  padManifest = null,
  padMetadataEqualityKey = null,
  coordinateManifest = null,
  coordinateMetadataEqualityKey = null,
  boundaryDigests = {},
  meetingRows = [],
} = {}) {
  const padIdentity = padContentIdentity(padManifest);
  const coordinateIdentity = [
    coordinateManifest?.coordinate_vintage || "",
    coordinateManifest?.source?.sha256 || coordinateManifest?.content_sha256 || "",
    coordinateManifest?.coverage?.retained_parcels ?? "",
  ].join("|");

  const boundaries = {};
  for (const type of Object.keys(boundaryDigests || {}).sort()) {
    boundaries[type] = String(boundaryDigests[type] || "");
  }

  const meetings = {};
  for (const row of meetingRows || []) {
    const id = cleanText(row?.meeting_id, 500);
    if (!id) continue;
    meetings[id] = meetingGeographyInputHash(row);
  }

  return {
    schema: ADDRESS_GEOGRAPHY_REFRESH_SCHEMA,
    pad_content_identity: padIdentity,
    pad_metadata_equality_key: padMetadataEqualityKey || null,
    coordinate_identity: coordinateIdentity,
    coordinate_metadata_equality_key: coordinateMetadataEqualityKey || null,
    boundary_digests: boundaries,
    meeting_input_hashes: meetings,
    aggregate_hash: sha256Hex(stableStringify({
      padIdentity,
      coordinateIdentity,
      boundaries,
      meetings,
    })),
  };
}

function metadataCanEstablishEquality(key) {
  return Boolean(key && String(key).trim() && String(key).trim() !== "unknown");
}

/**
 * Decide which stages must run given prior fingerprints and publisher metadata.
 *
 * Daily: reacquire when publisher metadata shows change.
 * Weekly forced verification when metadata cannot establish equality.
 */
export function planAddressGeographyRefresh({
  previousFingerprints = null,
  currentFingerprints,
  previousReceipt = null,
  now = new Date().toISOString(),
  weeklyForceMs = WEEKLY_FORCE_VERIFICATION_MS,
  force = false,
} = {}) {
  if (!currentFingerprints || typeof currentFingerprints !== "object") {
    throw new Error("planAddressGeographyRefresh requires currentFingerprints");
  }

  const reasons = [];
  const stages = Object.fromEntries(REFRESH_STAGES.map((stage) => [stage, "skip"]));
  const prior = previousFingerprints || previousReceipt?.fingerprints || null;
  const nowMs = Date.parse(now);
  const lastSuccessMs = Date.parse(previousReceipt?.activated_at || previousReceipt?.completed_at || "");
  const weeklyDue = Number.isFinite(nowMs)
    && (!Number.isFinite(lastSuccessMs) || (nowMs - lastSuccessMs) >= weeklyForceMs);

  const padMetaOk = metadataCanEstablishEquality(currentFingerprints.pad_metadata_equality_key);
  const coordMetaOk = metadataCanEstablishEquality(
    currentFingerprints.coordinate_metadata_equality_key,
  );

  const padChanged = !prior
    || prior.pad_content_identity !== currentFingerprints.pad_content_identity
    || (
      padMetaOk
      && prior.pad_metadata_equality_key
      && prior.pad_metadata_equality_key !== currentFingerprints.pad_metadata_equality_key
    );
  const padForceVerify = !padMetaOk && weeklyDue;

  const coordinateChanged = !prior
    || prior.coordinate_identity !== currentFingerprints.coordinate_identity
    || (
      coordMetaOk
      && prior.coordinate_metadata_equality_key
      && prior.coordinate_metadata_equality_key !== currentFingerprints.coordinate_metadata_equality_key
    );
  const coordinateForceVerify = !coordMetaOk && weeklyDue;

  const priorBoundaries = prior?.boundary_digests || {};
  const currentBoundaries = currentFingerprints.boundary_digests || {};
  const changedLayers = [];
  for (const type of new Set([...Object.keys(priorBoundaries), ...Object.keys(currentBoundaries)])) {
    if ((priorBoundaries[type] || "") !== (currentBoundaries[type] || "")) {
      changedLayers.push(type);
    }
  }

  const priorMeetings = prior?.meeting_input_hashes || {};
  const currentMeetings = currentFingerprints.meeting_input_hashes || {};
  const changedMeetingIds = [];
  for (const id of new Set([...Object.keys(priorMeetings), ...Object.keys(currentMeetings)])) {
    if ((priorMeetings[id] || "") !== (currentMeetings[id] || "")) {
      changedMeetingIds.push(id);
    }
  }

  if (force || padChanged || padForceVerify) {
    stages.pad = padForceVerify && !padChanged ? "force_verify" : "run";
    stages.record_joins = "run";
    stages.resident_outputs = "run";
    reasons.push(padChanged ? "pad_content_or_metadata_changed" : "pad_weekly_forced_verification");
  }

  if (force || coordinateChanged || coordinateForceVerify) {
    stages.coordinates = coordinateForceVerify && !coordinateChanged ? "force_verify" : "run";
    stages.memberships = "run";
    stages.record_joins = "run";
    stages.resident_outputs = "run";
    reasons.push(coordinateChanged
      ? "coordinate_content_or_metadata_changed"
      : "coordinate_weekly_forced_verification");
  }

  if (force || changedLayers.length) {
    stages.boundaries = "run";
    stages.memberships = "run";
    stages.record_joins = "run";
    stages.resident_outputs = "run";
    reasons.push(changedLayers.length
      ? `boundary_layers_changed:${changedLayers.sort().join(",")}`
      : "boundaries_forced");
  }

  if (force || changedMeetingIds.length) {
    stages.record_joins = "run";
    stages.resident_outputs = "run";
    reasons.push(changedMeetingIds.length
      ? `venue_or_assertion_changed:${changedMeetingIds.length}`
      : "meetings_forced");
  }

  if (force) {
    for (const stage of REFRESH_STAGES) stages[stage] = stages[stage] === "skip" ? "run" : stages[stage];
    reasons.push("force");
  }

  const anyWork = REFRESH_STAGES.some((stage) => stages[stage] !== "skip");
  return {
    schema: ADDRESS_GEOGRAPHY_REFRESH_PLAN_SCHEMA,
    stages,
    reasons,
    changed_layers: changedLayers.sort(),
    changed_meeting_ids: changedMeetingIds.sort(),
    pad_metadata_equality_established: padMetaOk,
    coordinate_metadata_equality_established: coordMetaOk,
    weekly_force_due: weeklyDue,
    work_required: anyWork,
  };
}

function emptyCounters() {
  return {
    address_resolutions: 0,
    polygon_computations: 0,
    membership_layers_recomputed: [],
    records_reprojected: 0,
    pad_acquired: false,
    coordinates_acquired: false,
  };
}

function readJsonIfExists(filePath) {
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, "utf8"));
}

/**
 * Persist / load the refresh receipt used for hash reuse and operator failure
 * reporting. Lives beside the meeting-geography public generation.
 */
export function refreshReceiptPath(publicDir) {
  return path.join(publicDir, "address-geography-refresh-receipt.json");
}

export function loadAddressGeographyRefreshReceipt(publicDir) {
  return readJsonIfExists(refreshReceiptPath(publicDir));
}

export function writeAddressGeographyRefreshReceipt(publicDir, receipt) {
  mkdirSync(publicDir, { recursive: true });
  const filePath = refreshReceiptPath(publicDir);
  const temporary = `${filePath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`);
  renameSync(temporary, filePath);
  return filePath;
}

/**
 * Create the injectable refresh runner. Production adapters wrap the existing
 * PAD, parcel-point, membership, meeting-geography, and resident-output
 * harnesses; tests supply fixture adapters.
 *
 * @param {object} adapters
 */
export function createAddressGeographyRefresh(adapters = {}) {
  const {
    loadFingerprints,
    acquirePad = null,
    acquireCoordinates = null,
    rebuildMemberships = null,
    reprojectRecordJoins = null,
    rebuildResidentOutputs = null,
    loadPreviousReceipt = null,
    saveReceipt = null,
    loadActiveGeneration = null,
  } = adapters;

  if (typeof loadFingerprints !== "function") {
    throw new Error("createAddressGeographyRefresh requires loadFingerprints()");
  }

  /**
   * Run one scheduled refresh against the current inputs.
   * @param {object} [options]
   * @param {boolean} [options.force]
   * @param {string} [options.now]
   * @param {object|null} [options.previousReceipt]
   * @param {"timeout"|"partial_coordinates"|"incomplete_boundaries"|Error|null} [options.injectFailure]
   */
  async function run({
    force = false,
    now = new Date().toISOString(),
    previousReceipt = null,
    injectFailure = null,
    weeklyForceMs = WEEKLY_FORCE_VERIFICATION_MS,
  } = {}) {
    const prior = previousReceipt
      || (typeof loadPreviousReceipt === "function" ? loadPreviousReceipt() : null)
      || null;
    const activeBefore = typeof loadActiveGeneration === "function"
      ? loadActiveGeneration()
      : (prior?.active_generation || null);

    const fingerprintBundle = await loadFingerprints({ previousReceipt: prior });
    const currentFingerprints = fingerprintBundle.fingerprints
      || computeAddressGeographyFingerprints(fingerprintBundle);
    const plan = planAddressGeographyRefresh({
      previousFingerprints: prior?.fingerprints || null,
      currentFingerprints,
      previousReceipt: prior,
      now,
      weeklyForceMs,
      force,
    });

    const counters = emptyCounters();
    const receiptBase = {
      schema: ADDRESS_GEOGRAPHY_REFRESH_RECEIPT_SCHEMA,
      started_at: now,
      plan,
      fingerprints: currentFingerprints,
      counters,
      status: "running",
      active_generation: activeBefore,
      previous_active_generation: activeBefore,
    };

    if (!plan.work_required) {
      const receipt = {
        ...receiptBase,
        status: "unchanged",
        completed_at: now,
        activated_at: prior?.activated_at || null,
        message: "all geography input hashes reused; no stage ran",
      };
      if (typeof saveReceipt === "function") saveReceipt(receipt);
      return {
        ok: true,
        status: "unchanged",
        plan,
        counters,
        receipt,
        active_generation: activeBefore,
      };
    }

    try {
      if (injectFailure === "timeout") {
        throw Object.assign(new Error("source timeout during geography refresh"), {
          failure_kind: "source_timeout",
        });
      }

      if (plan.stages.pad !== "skip") {
        if (typeof acquirePad !== "function") {
          throw new Error("pad stage requires acquirePad adapter");
        }
        const padResult = await acquirePad({
          mode: plan.stages.pad,
          fingerprints: currentFingerprints,
        });
        counters.pad_acquired = Boolean(padResult?.acquired);
        if (padResult?.fingerprints) {
          Object.assign(currentFingerprints, padResult.fingerprints);
        }
      }

      if (plan.stages.coordinates !== "skip") {
        if (typeof acquireCoordinates !== "function") {
          throw new Error("coordinates stage requires acquireCoordinates adapter");
        }
        const coordResult = await acquireCoordinates({
          mode: plan.stages.coordinates,
          fingerprints: currentFingerprints,
        });
        counters.coordinates_acquired = Boolean(coordResult?.acquired);
        if (injectFailure === "partial_coordinates") {
          throw Object.assign(new Error("partial coordinate acquisition"), {
            failure_kind: "partial_coordinates",
          });
        }
        if (coordResult?.fingerprints) {
          Object.assign(currentFingerprints, coordResult.fingerprints);
        }
      }

      if (plan.stages.boundaries !== "skip" || plan.stages.memberships !== "skip") {
        if (injectFailure === "incomplete_boundaries") {
          throw Object.assign(new Error("incomplete boundary generation"), {
            failure_kind: "incomplete_boundaries",
          });
        }
        if (typeof rebuildMemberships === "function") {
          const membershipResult = await rebuildMemberships({
            changedLayers: plan.changed_layers,
            padChanged: plan.stages.pad !== "skip",
            coordinatesChanged: plan.stages.coordinates !== "skip",
            fingerprints: currentFingerprints,
          });
          counters.polygon_computations += Number(membershipResult?.polygon_computations || 0);
          if (Array.isArray(membershipResult?.layers_recomputed)) {
            counters.membership_layers_recomputed = membershipResult.layers_recomputed.slice().sort();
          }
          if (membershipResult?.fingerprints) {
            Object.assign(currentFingerprints, membershipResult.fingerprints);
          }
        }
      }

      let joinResult = null;
      if (plan.stages.record_joins !== "skip") {
        if (typeof reprojectRecordJoins !== "function") {
          throw new Error("record_joins stage requires reprojectRecordJoins adapter");
        }
        joinResult = await reprojectRecordJoins({
          plan,
          fingerprints: currentFingerprints,
          padChanged: plan.stages.pad !== "skip",
          membershipsChanged: plan.stages.memberships !== "skip",
          changedMeetingIds: plan.changed_meeting_ids,
          counters,
        });
        counters.address_resolutions += Number(joinResult?.address_resolutions || 0);
        counters.records_reprojected += Number(joinResult?.records_reprojected || 0);
      }

      let outputResult = null;
      if (plan.stages.resident_outputs !== "skip") {
        if (typeof rebuildResidentOutputs !== "function") {
          throw new Error("resident_outputs stage requires rebuildResidentOutputs adapter");
        }
        outputResult = await rebuildResidentOutputs({
          plan,
          joinResult,
          fingerprints: currentFingerprints,
          now,
        });
      }

      const activeAfter = outputResult?.active_generation
        || joinResult?.active_generation
        || activeBefore;
      const receipt = {
        ...receiptBase,
        status: "activated",
        completed_at: now,
        activated_at: now,
        counters,
        fingerprints: currentFingerprints,
        active_generation: activeAfter,
        previous_active_generation: activeBefore,
        outputs: {
          meeting_geography_generation: activeAfter,
          reverse_index_updated: Boolean(joinResult?.reverse_index_updated ?? true),
          resident_outputs: outputResult?.outputs || null,
        },
        message: "geography refresh activated",
      };
      if (typeof saveReceipt === "function") saveReceipt(receipt);
      return {
        ok: true,
        status: "activated",
        plan,
        counters,
        receipt,
        active_generation: activeAfter,
        joinResult,
        outputResult,
      };
    } catch (error) {
      const failureKind = error?.failure_kind
        || (error?.name === "TimeoutError" ? "source_timeout" : "refresh_failed");
      const receipt = {
        ...receiptBase,
        status: "failed",
        completed_at: now,
        activated_at: prior?.activated_at || null,
        counters,
        fingerprints: currentFingerprints,
        active_generation: activeBefore,
        previous_active_generation: activeBefore,
        failure: {
          kind: failureKind,
          message: String(error?.message || error),
        },
        message: "geography refresh failed; retained last activated generation",
      };
      if (typeof saveReceipt === "function") saveReceipt(receipt);
      return {
        ok: false,
        status: "failed",
        plan,
        counters,
        receipt,
        active_generation: activeBefore,
        error,
      };
    }
  }

  return {
    run,
    planAddressGeographyRefresh,
    computeAddressGeographyFingerprints,
  };
}

export {
  padContentIdentity,
  meetingGeographyInputHash,
};
