/**
 * Restartable meeting-geography backfill over the pinned shared meeting corpus.
 *
 * Walks every canonical meeting once, classifies a bounded outcome from retained
 * source evidence, resolves admitted venue/subject addresses through the exact
 * PAD cache, and projects parcel memberships through the record-location join.
 * Results are staged and activated atomically so a mid-run failure leaves the
 * previous public generation untouched. Resident and get_meeting reads consume
 * the stamped precomputed fields — never live geocoding or full-corpus work.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { civicGeographyKey } from "./civic_geography_registry.mjs";
import { communityDistrictIdFromBoardOntology } from "./community_board_geography.mjs";
import {
  ATTENDANCE_MEANING,
  LOCATION_ROLES,
  LOCATION_VALIDITY,
  buildMeetingLocationAssertions,
  isAdmittedPhysicalVenue,
  isAdmittedSubjectProperty,
  isDateShapedVenueText,
} from "./meeting_location_assertions.mjs";
import {
  linkAssertionToResolution,
} from "./record_address_resolution_cache.mjs";
import {
  RECORD_LOCATION_EDGE_METHOD,
  RECORD_LOCATION_HOST_METHOD,
  createRecordLocationMembershipProjection,
} from "./record_location_memberships.mjs";

export const MEETING_GEOGRAPHY_BACKFILL_SCHEMA = "cityscroll.meeting_geography_backfill.v1";
export const MEETING_GEOGRAPHY_BACKFILL_OUTCOME_SCHEMA =
  "cityscroll.meeting_geography_backfill_outcome.v1";
export const MEETING_GEOGRAPHY_BACKFILL_CHECKPOINT_SCHEMA =
  "cityscroll.meeting_geography_backfill_checkpoint.v1";
export const MEETING_GEOGRAPHY_BACKFILL_MANIFEST_SCHEMA =
  "cityscroll.meeting_geography_backfill_manifest.v1";

export const BACKFILL_OUTCOME = Object.freeze({
  PHYSICAL_VENUE: "physical_venue",
  SUBJECT: "subject",
  BROAD_JURISDICTION: "broad_jurisdiction",
  VIRTUAL: "virtual",
  NO_SOURCE_ADDRESS: "no_source_address",
  UNRESOLVED_EVIDENCE: "unresolved_evidence",
});

const STAGING_DIRNAME = ".staging";
const ACTIVE_POINTER = "ACTIVE";

function cleanText(value, max = 500) {
  const text = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
  return text || null;
}

function fnv1aHex(value) {
  let hash = 0x811c9dc5;
  const text = String(value ?? "");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function sha256Hex(value) {
  return createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

function stableStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function atomicWriteFile(filePath, contents) {
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tempPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  writeFileSync(tempPath, contents);
  renameSync(tempPath, filePath);
}

function readJsonIfExists(filePath) {
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, "utf8"));
}

/**
 * Raw address-bearing candidate strings before validity / physical admission.
 * Counts measure candidate input, never a geocode success quota.
 */
export function collectAddressCandidates(row = {}) {
  const candidates = [];
  const seen = new Set();
  const push = (source, value) => {
    const text = cleanText(value, 500);
    if (!text) return;
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ source, value: text });
  };

  const venue = row?.venue && typeof row.venue === "object" ? row.venue : null;
  push("venue.address", venue?.address);
  push("venue.building", venue?.building);
  push("row.address", row?.address);
  const components = row?.location_components || venue?.components || null;
  push("components.street_address", components?.street_address);
  for (const address of row?.affected_area?.addresses || []) {
    push("affected_area.addresses", address);
  }
  return candidates;
}

/**
 * Content hash of the geography-relevant input for one meeting. Unchanged hashes
 * reuse the prior checkpoint outcome without re-resolving.
 */
export function meetingGeographyInputHash(row = {}) {
  const venue = row?.venue && typeof row.venue === "object" ? row.venue : null;
  const payload = {
    meeting_id: row?.meeting_id || null,
    source_system: row?.source_system || null,
    meeting_origin: row?.meeting_origin || null,
    board_id: row?.board_id || null,
    venue: venue
      ? {
        name: venue.name || null,
        address: venue.address || null,
        building: venue.building || null,
        mode: venue.mode || null,
        components: venue.components || null,
      }
      : null,
    address: row?.address || null,
    attendance_mode: row?.attendance_mode || null,
    location_components: row?.location_components || null,
    affected_area_addresses: row?.affected_area?.addresses || [],
    description: cleanText(row?.description, 2_000),
  };
  return sha256Hex(stableStringify(payload));
}

function isOathLocationFree(row = {}) {
  const source = String(row?.source_system || "").toLowerCase();
  const origin = String(row?.meeting_origin || "").toLowerCase();
  const family = String(row?.meeting_family || "").toLowerCase();
  return source === "oath_trial_calendar"
    || origin.includes("oath_trial")
    || family.includes("oath");
}

function isVirtualOnlyRow(row = {}, assertions = []) {
  const mode = String(row?.venue?.mode || row?.attendance_mode || "").trim().toLowerCase();
  if (["remote", "virtual", "online", "zoom", "video"].includes(mode)) {
    const hasPhysical = assertions.some(isAdmittedPhysicalVenue);
    return !hasPhysical;
  }
  const venueAssertion = assertions.find((rowAssertion) => rowAssertion?.role === LOCATION_ROLES.VENUE);
  if (venueAssertion?.attendance_meaning === ATTENDANCE_MEANING.REMOTE
    && !isAdmittedPhysicalVenue(venueAssertion)) {
    return true;
  }
  return false;
}

function hostGeographyForRow(row, communityBoardGeography) {
  const boardId = cleanText(row?.board_id, 80);
  if (!boardId || !communityBoardGeography) return null;
  const districtId = communityDistrictIdFromBoardOntology(boardId, communityBoardGeography);
  if (!districtId) return null;
  return {
    geography_type: "community_district",
    geography_id: districtId,
    geography_key: civicGeographyKey("community_district", districtId),
    geography_label: null,
  };
}

/**
 * Compact memberships for one record from projection edges, enriching with the
 * parcel point when the membership bundle supplied lat/lon.
 */
export function compactMembershipsFromEdges(edges = [], {
  recordId = null,
  pointsByAssertion = null,
} = {}) {
  const list = Array.isArray(edges) ? edges : [];
  const filtered = recordId
    ? list.filter((edge) => !edge?.record_id || edge.record_id === recordId)
    : list;
  const byRole = new Map();
  for (const edge of filtered) {
    if (!edge || typeof edge !== "object") continue;
    const role = String(edge.role || "").trim() || "venue";
    const assertionId = edge.assertion_id || `${edge.record_id || ""}#${role}`;
    const key = `${edge.record_id || ""}|${assertionId}|${role}`;
    if (!byRole.has(key)) {
      const point = pointsByAssertion?.get?.(assertionId) || edge.point || null;
      let sourceMethod = edge.provenance?.method || edge.method || "admitted_record_location_membership";
      if (role === LOCATION_ROLES.VENUE && sourceMethod === RECORD_LOCATION_EDGE_METHOD) {
        sourceMethod = "admitted_venue_membership";
      } else if (role === LOCATION_ROLES.SUBJECT_PROPERTY && sourceMethod === RECORD_LOCATION_EDGE_METHOD) {
        sourceMethod = "admitted_subject_membership";
      } else if (role === LOCATION_ROLES.HOST_JURISDICTION || sourceMethod === RECORD_LOCATION_HOST_METHOD) {
        sourceMethod = "board_covers_district";
      }
      byRole.set(key, {
        record_id: edge.record_id || recordId || null,
        assertion_id: assertionId,
        role,
        bbl: edge.bbl || null,
        memberships: {},
        point: point && Number.isFinite(Number(point.lat)) && Number.isFinite(Number(point.lon))
          ? { lat: Number(point.lat), lon: Number(point.lon) }
          : null,
        confidence: edge.confidence ?? 1,
        confidence_tier: edge.confidence_tier || "strong",
        provenance: {
          source_method: sourceMethod,
          ...(edge.source_path ? { source_path: edge.source_path } : {}),
          ...(edge.bbl ? { parcel_bbl: edge.bbl } : {}),
        },
      });
    }
    const membership = byRole.get(key);
    const type = String(edge.geography_type || "").trim();
    const geographyId = edge.geography_id != null ? String(edge.geography_id) : null;
    if (type && geographyId) membership.memberships[type] = geographyId;
    if (!membership.point && edge.point) membership.point = edge.point;
    if (!membership.bbl && edge.bbl) membership.bbl = edge.bbl;
  }
  return [...byRole.values()];
}

function compactMembershipsLocal(edges, options) {
  return compactMembershipsFromEdges(edges, options);
}

/**
 * Choose the single classified processing outcome for one meeting.
 */
export function classifyMeetingGeographyOutcome({
  row = null,
  assertions = [],
  memberships = [],
  addressCandidates = null,
} = {}) {
  const candidates = addressCandidates || collectAddressCandidates(row || {});
  if (isOathLocationFree(row) && candidates.length === 0) {
    return BACKFILL_OUTCOME.NO_SOURCE_ADDRESS;
  }
  if (isVirtualOnlyRow(row, assertions)) {
    return BACKFILL_OUTCOME.VIRTUAL;
  }

  const venueAssertion = assertions.find((assertion) => assertion?.role === LOCATION_ROLES.VENUE) || null;
  if (venueAssertion?.validity === LOCATION_VALIDITY.REJECTED_DATE_SHAPED
    || (venueAssertion?.original_address && isDateShapedVenueText(venueAssertion.original_address))) {
    return BACKFILL_OUTCOME.UNRESOLVED_EVIDENCE;
  }
  if (venueAssertion?.validity === LOCATION_VALIDITY.UNRESOLVED_ATTENDANCE) {
    return BACKFILL_OUTCOME.UNRESOLVED_EVIDENCE;
  }

  const hasVenueMembership = memberships.some((membership) => membership?.role === LOCATION_ROLES.VENUE
    && (
      (membership?.memberships && Object.keys(membership.memberships).length > 0)
      || membership?.bbl
    ));
  if (hasVenueMembership) return BACKFILL_OUTCOME.PHYSICAL_VENUE;

  const hasSubjectMembership = memberships.some((membership) => (
    membership?.role === LOCATION_ROLES.SUBJECT_PROPERTY
    && (
      (membership?.memberships && Object.keys(membership.memberships).length > 0)
      || membership?.bbl
    )
  ));
  if (hasSubjectMembership) return BACKFILL_OUTCOME.SUBJECT;

  const hasHost = memberships.some((membership) => membership?.role === LOCATION_ROLES.HOST_JURISDICTION);
  if (hasHost) return BACKFILL_OUTCOME.BROAD_JURISDICTION;

  if (candidates.length === 0) return BACKFILL_OUTCOME.NO_SOURCE_ADDRESS;
  return BACKFILL_OUTCOME.UNRESOLVED_EVIDENCE;
}

function emptyCheckpoint({ generation, sourceGenerationHash = null } = {}) {
  return {
    schema: MEETING_GEOGRAPHY_BACKFILL_CHECKPOINT_SCHEMA,
    generation: generation || null,
    source_generation_hash: sourceGenerationHash,
    updated_at: null,
    processed: {},
    completed: false,
  };
}

/**
 * Create the restartable meeting-geography backfill runner.
 *
 * @param {object} options
 * @param {object} options.addressCache - createRecordAddressResolutionCache API
 * @param {object} options.membershipProjection - createRecordLocationMembershipProjection API
 * @param {object|null} [options.communityBoardGeography]
 * @param {object|null} [options.lookupParcelPoint] - optional (bbl) => {lat,lon}
 * @param {() => string} [options.now]
 */
export function createMeetingGeographyBackfill({
  addressCache,
  membershipProjection,
  communityBoardGeography = null,
  lookupParcelPoint = null,
  now = () => new Date().toISOString(),
} = {}) {
  if (!addressCache || typeof addressCache.resolveAddress !== "function") {
    throw new Error("meeting geography backfill requires addressCache.resolveAddress");
  }
  if (!membershipProjection || typeof membershipProjection.replaceRecordAssertions !== "function") {
    throw new Error("meeting geography backfill requires membershipProjection.replaceRecordAssertions");
  }

  function processMeetingRow(row, {
    observedAt = null,
  } = {}) {
    if (!row?.meeting_id) {
      return {
        schema: MEETING_GEOGRAPHY_BACKFILL_OUTCOME_SCHEMA,
        meeting_id: null,
        input_hash: null,
        outcome: BACKFILL_OUTCOME.UNRESOLVED_EVIDENCE,
        address_candidate_count: 0,
        address_candidates: [],
        assertions: [],
        memberships: [],
        skipped: "missing_meeting_id",
      };
    }

    const stamp = observedAt || now();
    const inputHash = meetingGeographyInputHash(row);
    const addressCandidates = collectAddressCandidates(row);
    const assertions = Array.isArray(row.location_assertions) && row.location_assertions.length
      ? [...row.location_assertions]
      : buildMeetingLocationAssertions(row);

    const hostGeography = hostGeographyForRow(row, communityBoardGeography);
    const projectionInputs = [];
    const pointsByAssertion = new Map();

    for (const assertion of assertions) {
      if (assertion?.role === LOCATION_ROLES.HOST_JURISDICTION) {
        projectionInputs.push({ assertion, host_geography: hostGeography });
        continue;
      }

      if (isAdmittedPhysicalVenue(assertion) || isAdmittedSubjectProperty(assertion)) {
        const entry = addressCache.resolveAddress(null, { assertion });
        const resolution = linkAssertionToResolution(assertion, entry);
        if (entry?.status === "matched" && entry?.bbl && typeof lookupParcelPoint === "function") {
          const point = lookupParcelPoint(entry.bbl);
          if (point) pointsByAssertion.set(assertion.assertion_id, point);
        }
        projectionInputs.push({ assertion, resolution });
        continue;
      }

      // Retain non-parcel assertions in the active set without inventing edges.
      projectionInputs.push({ assertion, resolution: null });
    }

    if (hostGeography && !assertions.some((assertion) => assertion?.role === LOCATION_ROLES.HOST_JURISDICTION)) {
      const hostAssertion = {
        schema: "cityscroll.meeting_location_assertion.v1",
        assertion_id: `location_assertion:${row.meeting_id}::host_jurisdiction::board_id::1`,
        meeting_id: row.meeting_id,
        record_id: row.meeting_id,
        role: LOCATION_ROLES.HOST_JURISDICTION,
        validity: LOCATION_VALIDITY.UNLOCATED,
        attendance_meaning: ATTENDANCE_MEANING.NOT_STATED,
        original_address: null,
        venue_name: null,
        components: null,
        wrapper: null,
        source_field: "board_id",
        source_passage: null,
        passage_locator: null,
        passage_text_sha256: null,
        source_receipt: null,
      };
      projectionInputs.push({ assertion: hostAssertion, host_geography: hostGeography });
      assertions.push(hostAssertion);
    }

    const document = membershipProjection.replaceRecordAssertions(
      row.meeting_id,
      projectionInputs,
      { observedAt: stamp },
    );
    const edges = document.edges.filter((edge) => edge.record_id === row.meeting_id);
    const memberships = compactMembershipsLocal(edges, {
      recordId: row.meeting_id,
      pointsByAssertion,
    });

    // Host-only compact membership when the host edge is present.
    if (hostGeography && !memberships.some((membership) => membership.role === LOCATION_ROLES.HOST_JURISDICTION)) {
      const hostEdge = edges.find((edge) => edge.role === LOCATION_ROLES.HOST_JURISDICTION);
      if (hostEdge) {
        memberships.push({
          record_id: row.meeting_id,
          assertion_id: hostEdge.assertion_id,
          role: LOCATION_ROLES.HOST_JURISDICTION,
          bbl: null,
          memberships: {
            [hostGeography.geography_type]: hostGeography.geography_id,
          },
          point: null,
          confidence: 1,
          confidence_tier: "strong",
          provenance: { source_method: "board_covers_district" },
        });
      }
    }

    const outcome = classifyMeetingGeographyOutcome({
      row,
      assertions,
      memberships,
      addressCandidates,
    });

    return {
      schema: MEETING_GEOGRAPHY_BACKFILL_OUTCOME_SCHEMA,
      meeting_id: row.meeting_id,
      input_hash: inputHash,
      outcome,
      address_candidate_count: addressCandidates.length,
      address_candidates: addressCandidates.map((candidate) => candidate.value),
      assertion_ids: assertions.map((assertion) => assertion.assertion_id).filter(Boolean),
      assertions,
      memberships,
      edge_count: edges.length,
      processed_at: stamp,
      skipped: null,
    };
  }

  /**
   * Process the full input list with checkpoint resume.
   *
   * @param {object} args
   * @param {object[]} args.rows
   * @param {object|null} [args.checkpoint]
   * @param {string} [args.generation]
   * @param {string|null} [args.sourceGenerationHash]
   * @param {number|null} [args.interruptAfter] - test hook: throw after N new processes
   * @param {(state: object) => void} [args.onCheckpoint]
   */
  function run({
    rows = [],
    checkpoint = null,
    generation = null,
    sourceGenerationHash = null,
    interruptAfter = null,
    onCheckpoint = null,
    observedAt = null,
  } = {}) {
    const list = Array.isArray(rows) ? rows : [];
    const gen = generation || `meeting-geography-backfill:${fnv1aHex(String(list.length))}:${Date.now()}`;
    const sourceHash = sourceGenerationHash
      || sha256Hex(list.map((row) => row?.meeting_id || "").join("\n"));
    let state = checkpoint
      && checkpoint.schema === MEETING_GEOGRAPHY_BACKFILL_CHECKPOINT_SCHEMA
      && checkpoint.generation === gen
      ? structuredClone(checkpoint)
      : emptyCheckpoint({ generation: gen, sourceGenerationHash: sourceHash });
    if (!state.source_generation_hash) state.source_generation_hash = sourceHash;

    const outcomes = new Map();
    for (const [meetingId, prior] of Object.entries(state.processed || {})) {
      outcomes.set(meetingId, prior);
    }

    let newlyProcessed = 0;
    const candidateStats = {
      address_bearing_rows: 0,
      distinct_address_strings: new Set(),
    };

    for (const row of list) {
      const meetingId = row?.meeting_id;
      if (!meetingId) continue;

      const addressCandidates = collectAddressCandidates(row);
      if (addressCandidates.length) {
        candidateStats.address_bearing_rows += 1;
        for (const candidate of addressCandidates) {
          candidateStats.distinct_address_strings.add(candidate.value);
        }
      }

      const inputHash = meetingGeographyInputHash(row);
      const prior = outcomes.get(meetingId);
      if (
        prior?.input_hash === inputHash
        && prior?.outcome
        && Array.isArray(prior.memberships)
        && Array.isArray(prior.assertions)
      ) {
        // Re-attach retained membership edges into this run's projection so a
        // resumed activation still publishes a complete reverse index.
        if (prior.assertions.length || prior.memberships.length) {
          const hostGeography = hostGeographyForRow(row, communityBoardGeography);
          const projectionInputs = prior.assertions.map((assertion) => {
            if (assertion?.role === LOCATION_ROLES.HOST_JURISDICTION) {
              return { assertion, host_geography: hostGeography };
            }
            const membership = (prior.memberships || []).find((entry) => (
              entry.assertion_id === assertion.assertion_id
            ));
            const resolution = membership?.bbl
              ? {
                assertion_id: assertion.assertion_id,
                meeting_id: meetingId,
                record_id: meetingId,
                role: assertion.role,
                published_address: assertion.original_address || null,
                cache_key: null,
                bbl: membership.bbl,
                status: "matched",
                reason: null,
              }
              : null;
            return { assertion, resolution };
          });
          membershipProjection.replaceRecordAssertions(meetingId, projectionInputs, {
            observedAt: prior.processed_at || observedAt || now(),
          });
        }
        continue;
      }

      const result = processMeetingRow(row, { observedAt });
      // Checkpoint retains assertions so resume can restamp the shared model and
      // rebuild the membership projection without re-resolving unchanged inputs.
      const stored = {
        schema: result.schema,
        meeting_id: result.meeting_id,
        input_hash: result.input_hash,
        outcome: result.outcome,
        address_candidate_count: result.address_candidate_count,
        address_candidates: result.address_candidates,
        assertion_ids: result.assertion_ids,
        assertions: result.assertions,
        memberships: result.memberships,
        edge_count: result.edge_count,
        processed_at: result.processed_at,
      };
      outcomes.set(meetingId, stored);
      state.processed[meetingId] = stored;
      state.updated_at = result.processed_at;
      newlyProcessed += 1;

      if (typeof onCheckpoint === "function") {
        onCheckpoint(state);
      }

      if (Number.isInteger(interruptAfter) && newlyProcessed >= interruptAfter) {
        const error = new Error(`meeting geography backfill interrupted after ${newlyProcessed}`);
        error.code = "MEETING_GEOGRAPHY_BACKFILL_INTERRUPTED";
        error.checkpoint = state;
        error.outcomes = outcomes;
        throw error;
      }
    }

    state.completed = true;
    state.updated_at = observedAt || now();
    if (typeof onCheckpoint === "function") onCheckpoint(state);

    const outcomeList = [...outcomes.values()].sort((left, right) =>
      String(left.meeting_id).localeCompare(String(right.meeting_id)));
    const counts = {
      input_rows: list.length,
      processed_rows: outcomeList.length,
      newly_processed: newlyProcessed,
      resumed_unchanged: outcomeList.length - newlyProcessed,
      address_bearing_rows: candidateStats.address_bearing_rows,
      distinct_address_strings: candidateStats.distinct_address_strings.size,
      by_outcome: {},
    };
    for (const key of Object.values(BACKFILL_OUTCOME)) counts.by_outcome[key] = 0;
    for (const outcome of outcomeList) {
      counts.by_outcome[outcome.outcome] = (counts.by_outcome[outcome.outcome] || 0) + 1;
    }

    return {
      schema: MEETING_GEOGRAPHY_BACKFILL_SCHEMA,
      generation: gen,
      source_generation_hash: sourceHash,
      checkpoint: state,
      outcomes: outcomeList,
      counts,
      projection: membershipProjection.snapshot(),
    };
  }

  return {
    processMeetingRow,
    run,
    projection: membershipProjection,
    addressCache,
  };
}

/**
 * Apply backfill outcomes onto shared meeting rows without changing identities.
 */
export function stampMeetingRowsWithGeography(rows = [], outcomes = []) {
  const byId = new Map((Array.isArray(outcomes) ? outcomes : []).map((outcome) => [outcome.meeting_id, outcome]));
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const outcome = byId.get(row?.meeting_id);
    if (!outcome) return row;
    return {
      ...row,
      location_assertions: outcome.assertions || row.location_assertions || [],
      location_memberships: outcome.memberships || [],
      geography_backfill: {
        outcome: outcome.outcome,
        input_hash: outcome.input_hash,
        processed_at: outcome.processed_at || null,
      },
    };
  });
}

/**
 * Stage backfill artifacts, then activate by renaming into the public directory.
 * On any failure before activation completes, staging is discarded and the
 * previously active public generation remains unchanged.
 */
export function activateMeetingGeographyBackfill({
  publicDir,
  generation,
  manifest,
  outcomesDocument,
  projectionDocument = null,
  stampedSharedMeetingModel = null,
  sharedMeetingReadModelPath = null,
  failBeforeActivate = false,
} = {}) {
  if (!publicDir) throw new Error("activateMeetingGeographyBackfill requires publicDir");
  if (!generation) throw new Error("activateMeetingGeographyBackfill requires generation");

  mkdirSync(publicDir, { recursive: true });
  const stagingDir = path.join(publicDir, STAGING_DIRNAME);
  const generationDir = path.join(publicDir, generation);
  const previousActive = readJsonIfExists(path.join(publicDir, ACTIVE_POINTER));

  try {
    rmSync(stagingDir, { recursive: true, force: true });
    mkdirSync(stagingDir, { recursive: true });

    atomicWriteFile(
      path.join(stagingDir, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    atomicWriteFile(
      path.join(stagingDir, "per-id-outcomes.json"),
      `${JSON.stringify(outcomesDocument, null, 2)}\n`,
    );
    if (projectionDocument) {
      atomicWriteFile(
        path.join(stagingDir, "projection.json"),
        `${JSON.stringify(projectionDocument)}\n`,
      );
    }
    // The shared meeting read model is activated at its public path below.
    // Keep generation staging free of a second full copy of that corpus.

    if (failBeforeActivate) {
      throw new Error("meeting geography backfill forced failure before activation");
    }

    rmSync(generationDir, { recursive: true, force: true });
    renameSync(stagingDir, generationDir);

    const pointer = {
      schema: MEETING_GEOGRAPHY_BACKFILL_MANIFEST_SCHEMA,
      active_generation: generation,
      activated_at: manifest?.built_at || new Date().toISOString(),
      previous_generation: previousActive?.active_generation || null,
    };
    atomicWriteFile(
      path.join(publicDir, ACTIVE_POINTER),
      `${JSON.stringify(pointer, null, 2)}\n`,
    );

    // Publish the exact per-id outcome file beside the generation for delivery.
    atomicWriteFile(
      path.join(publicDir, "per-id-outcomes.json"),
      `${JSON.stringify(outcomesDocument, null, 2)}\n`,
    );
    atomicWriteFile(
      path.join(publicDir, "manifest.json"),
      `${JSON.stringify({ ...manifest, active_generation: generation }, null, 2)}\n`,
    );

    if (stampedSharedMeetingModel && sharedMeetingReadModelPath) {
      atomicWriteFile(
        sharedMeetingReadModelPath,
        `${JSON.stringify(stampedSharedMeetingModel, null, 2)}\n`,
      );
    }

    return {
      activated: true,
      generation,
      previous_generation: previousActive?.active_generation || null,
      public_dir: publicDir,
      generation_dir: generationDir,
    };
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true });
    // Never leave a half-renamed generation as active.
    const stillActive = readJsonIfExists(path.join(publicDir, ACTIVE_POINTER));
    error.activation = {
      activated: false,
      active_generation: stillActive?.active_generation || previousActive?.active_generation || null,
      previous_generation: previousActive?.active_generation || null,
    };
    throw error;
  }
}

export function loadActiveMeetingGeographyBackfill(publicDir) {
  const pointer = readJsonIfExists(path.join(publicDir, ACTIVE_POINTER));
  if (!pointer?.active_generation) return null;
  const generationDir = path.join(publicDir, pointer.active_generation);
  return {
    pointer,
    manifest: readJsonIfExists(path.join(generationDir, "manifest.json"))
      || readJsonIfExists(path.join(publicDir, "manifest.json")),
    outcomes: readJsonIfExists(path.join(publicDir, "per-id-outcomes.json"))
      || readJsonIfExists(path.join(generationDir, "per-id-outcomes.json")),
    projection: readJsonIfExists(path.join(generationDir, "projection.json")),
  };
}

export {
  STAGING_DIRNAME as MEETING_GEOGRAPHY_BACKFILL_STAGING_DIRNAME,
  ACTIVE_POINTER as MEETING_GEOGRAPHY_BACKFILL_ACTIVE_POINTER,
  createRecordLocationMembershipProjection,
};
