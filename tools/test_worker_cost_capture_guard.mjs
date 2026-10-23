/**
 * Worker cost capture-guard ownership + privacy tests.
 * Synthetic events follow the capture SCHEMA (key paths only).
 * Never load quarantined files or embed real visitor/probe values.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTROLLED_MARKER_UNKNOWN,
  FORBIDDEN_PERSIST_HEADER_KEYS,
  OWNED_PROBE_METHOD,
  OWNED_PROBE_URL,
  OWNED_ROUTE_CLASS,
  assertPersistedCapturePrivacy,
  bindOwnedProbeMarkerTuple,
  ingestForPersistence,
  isOwnedProbeEvent,
  normalizeControlledMarkerRegistry,
  persistOwnedCaptures,
  projectOwnedControlledMarkers,
  toPredicateOnlyCapture,
} from "./lib/worker_cost_capture_guard.mjs";

const OWNED_MARKER = "cost-synthetic-probe-0";
const FOREIGN_MARKER = "cost-foreign-run-probe-9";
const OWNED_VERSION = "SYNTHETIC_VERSION_ID";
const OWNED_ARM = "synthetic-series";
const OWNED_CONTEXT = Object.freeze({
  ownedMarkers: new Set([OWNED_MARKER]),
  allowedVersionIds: new Set([OWNED_VERSION]),
  allowedCohorts: new Set(["health"]),
  allowedArms: new Set([OWNED_ARM]),
});

/** Schema-shaped synthetic owned probe. Values are placeholders, not from capture. */
function syntheticOwnedRaw(overrides = {}) {
  const { headers: headerOverrides, event: eventOverride, ...topOverrides } = overrides;
  const headers = {
    accept: "*/*",
    "accept-encoding": "gzip",
    authorization: "[redacted]",
    "cf-ray": "SYNTHETIC_CF_RAY",
    "cf-visitor": "{\"scheme\":\"https\"}",
    connection: "Keep-Alive",
    "content-length": "12",
    "content-type": "application/json",
    host: "api.cityscroll.org",
    "user-agent": "SYNTHETIC_UA",
    "x-forwarded-proto": "https",
    "cloudflare-workers-version-overrides": "cityscroll-worker=\"SYNTHETIC_VERSION\"",
    "x-cityscroll-cost-probe": OWNED_MARKER,
    "x-cityscroll-cost-cohort": "health",
    "x-cityscroll-cost-series": "synthetic-series",
    "x-cityscroll-cost-workload": "0".repeat(64),
    ...(headerOverrides || {}),
  };
  const event = eventOverride || {
    request: {
      method: OWNED_PROBE_METHOD,
      url: OWNED_PROBE_URL,
      headers,
      cf: {
        httpProtocol: "HTTP/2",
        requestHeaderNames: [":method", ":path"],
      },
    },
    response: { status: 200 },
  };
  return {
    cpuTime: 1,
    wallTime: 2,
    outcome: "ok",
    scriptName: "cityscroll-worker",
    executionModel: "stateless",
    truncated: false,
    eventTimestamp: 1_000_000,
    scriptVersion: { id: OWNED_VERSION },
    event,
    logs: [
      {
        message: [`{"schema":"cityscroll.worker_cost_probe.v1","tag":"${OWNED_MARKER}"}`],
        level: "log",
        timestamp: 1_000_001,
      },
    ],
    exceptions: [],
    ...topOverrides,
  };
}

function syntheticVisitorRaw(extraHeaders = {}) {
  return {
    cpuTime: 0,
    wallTime: 1,
    outcome: "ok",
    scriptName: "cityscroll-worker",
    executionModel: "stateless",
    truncated: false,
    eventTimestamp: 1_000_100,
    scriptVersion: { id: OWNED_VERSION },
    event: {
      request: {
        method: "GET",
        url: "https://api.cityscroll.org/health",
        headers: {
          accept: "*/*",
          "cf-ray": "SYNTHETIC_VISITOR_RAY",
          "user-agent": "SYNTHETIC_BROWSER",
          referer: "https://example.invalid/page",
          origin: "https://example.invalid",
          from: "[redacted-from]",
          host: "api.cityscroll.org",
          ...extraHeaders,
        },
        cf: { httpProtocol: "HTTP/2", requestHeaderNames: [":method"] },
      },
      response: { status: 200 },
    },
    logs: [],
    exceptions: [],
  };
}

test("owned probe is recognized only with exact active-run marker membership", () => {
  assert.equal(isOwnedProbeEvent(syntheticOwnedRaw(), OWNED_CONTEXT), true);
  assert.equal(isOwnedProbeEvent(syntheticVisitorRaw(), OWNED_CONTEXT), false);
  // Presence alone without context is never enough.
  assert.equal(isOwnedProbeEvent(syntheticOwnedRaw()), false);
  assert.equal(isOwnedProbeEvent(syntheticOwnedRaw(), null), false);
  assert.equal(isOwnedProbeEvent(syntheticOwnedRaw(), { ownedMarkers: new Set() }), false);
});

test("non-owned events are dropped before persistence", () => {
  const lines = [];
  const summary = persistOwnedCaptures(
    [syntheticVisitorRaw(), syntheticOwnedRaw(), syntheticVisitorRaw()],
    (line) => lines.push(line),
    OWNED_CONTEXT,
  );
  assert.equal(summary.owned, 1);
  assert.equal(summary.dropped, 2);
  assert.equal(lines.length, 1);
  const persisted = JSON.parse(lines[0]);
  assert.equal(persisted.route_class, OWNED_ROUTE_CLASS);
  assert.equal(persisted.probe, "owned");
  assert.equal(persisted.method, "POST");
  assert.equal(persisted.scriptVersion.id, OWNED_VERSION);
  assert.equal(persisted.cpuTime, 1);
  assert.equal(persisted.wallTime, 2);
  assert.equal(persisted.eventTimestamp, 1_000_000);
  assert.equal(persisted.outcome, "ok");
  // Raw attacker-controllable probe header value must never be persisted.
  assert.equal(JSON.stringify(persisted).includes(OWNED_MARKER), false);
});

test("predicate-only projection drops headers, logs, url, cf, exceptions", () => {
  const projected = toPredicateOnlyCapture(syntheticOwnedRaw(), OWNED_CONTEXT);
  assert.equal(projected.logs, undefined);
  assert.equal(projected.exceptions, undefined);
  assert.equal(projected.event, undefined);
  assert.equal(projected.url, undefined);
  assert.equal(projected.headers, undefined);
  assert.equal(projected.cf, undefined);
  assert.equal(projected.scriptName, undefined);
  assert.equal(projected.probe, "owned");
  assertPersistedCapturePrivacy(projected);
});

test("negative: same endpoint+POST with wrong-run marker is dropped", () => {
  const foreign = syntheticOwnedRaw({
    headers: { "x-cityscroll-cost-probe": FOREIGN_MARKER },
  });
  assert.equal(isOwnedProbeEvent(foreign, OWNED_CONTEXT), false);
  assert.deepEqual(
    ingestForPersistence(foreign, OWNED_CONTEXT),
    { owned: false, persist: null },
  );
});

test("negative: wrong marker / wrong cohort / wrong version / wrong arm are dropped", () => {
  assert.equal(
    isOwnedProbeEvent(
      syntheticOwnedRaw({ headers: { "x-cityscroll-cost-probe": "cost-wrong-marker" } }),
      OWNED_CONTEXT,
    ),
    false,
  );
  assert.equal(
    isOwnedProbeEvent(
      syntheticOwnedRaw({ headers: { "x-cityscroll-cost-cohort": "browse" } }),
      OWNED_CONTEXT,
    ),
    false,
  );
  assert.equal(
    isOwnedProbeEvent(
      syntheticOwnedRaw({ scriptVersion: { id: "OTHER_VERSION" } }),
      OWNED_CONTEXT,
    ),
    false,
  );
  assert.equal(
    isOwnedProbeEvent(
      syntheticOwnedRaw({ headers: { "x-cityscroll-cost-series": "foreign-arm" } }),
      OWNED_CONTEXT,
    ),
    false,
  );
});

test("negative: missing run context drops everything (fail closed)", () => {
  const lines = [];
  const summary = persistOwnedCaptures(
    [syntheticOwnedRaw()],
    (line) => lines.push(line),
    null,
  );
  assert.equal(summary.owned, 0);
  assert.equal(summary.dropped, 1);
  assert.equal(lines.length, 0);
  const ingest = ingestForPersistence(syntheticOwnedRaw(), undefined);
  assert.equal(ingest.owned, false);
  assert.equal(ingest.persist, null);
  assert.equal(ingest.reason, "missing_run_context");
});

test("negative: cf-ray must not survive on persisted record", () => {
  const bad = {
    ...toPredicateOnlyCapture(syntheticOwnedRaw(), OWNED_CONTEXT),
    headers: { "cf-ray": "SYNTHETIC_CF_RAY" },
  };
  assert.throws(
    () => assertPersistedCapturePrivacy(bad),
    /forbidden fields/,
  );
});

test("negative: user-agent must not survive on persisted record", () => {
  const bad = {
    ...toPredicateOnlyCapture(syntheticOwnedRaw(), OWNED_CONTEXT),
    "user-agent": "SYNTHETIC_UA",
  };
  assert.throws(
    () => assertPersistedCapturePrivacy(bad),
    /forbidden fields/,
  );
});

test("negative: logs must not survive on persisted record", () => {
  const bad = {
    ...toPredicateOnlyCapture(syntheticOwnedRaw(), OWNED_CONTEXT),
    logs: [{ message: ["SYNTHETIC_LOG"], level: "log", timestamp: 1 }],
  };
  assert.throws(
    () => assertPersistedCapturePrivacy(bad),
    /forbidden fields/,
  );
});

test("negative: referer / origin / from must not survive on persisted record", () => {
  for (const key of ["referer", "origin", "from"]) {
    const bad = {
      ...toPredicateOnlyCapture(syntheticOwnedRaw(), OWNED_CONTEXT),
      [key]: "SYNTHETIC_VALUE",
    };
    assert.throws(
      () => assertPersistedCapturePrivacy(bad),
      /forbidden fields/,
      key,
    );
  }
});

test("negative: non-owned event cannot be projected for persistence", () => {
  assert.throws(
    () => toPredicateOnlyCapture(syntheticVisitorRaw(), OWNED_CONTEXT),
    /refuses non-owned/,
  );
});

test("fail-closed: checker error aborts ingest with CAPTURE_GUARD_FAIL_CLOSED", () => {
  const raw = syntheticOwnedRaw();
  // Corrupt after ownership would pass (marker+version still match): remove outcome
  // so projection throws. Deleting scriptVersion alone would fail ownership first
  // under allowedVersionIds and only drop, not throw.
  delete raw.outcome;
  assert.throws(
    () => ingestForPersistence(raw, OWNED_CONTEXT),
    (error) => error?.code === "CAPTURE_GUARD_FAIL_CLOSED",
  );
});

test("ingest drops visitor and returns predicate-only for owned", () => {
  const dropped = ingestForPersistence(syntheticVisitorRaw(), OWNED_CONTEXT);
  assert.deepEqual(dropped, { owned: false, persist: null });
  const kept = ingestForPersistence(syntheticOwnedRaw(), OWNED_CONTEXT);
  assert.equal(kept.owned, true);
  assert.equal(kept.persist.probe, "owned");
  assertPersistedCapturePrivacy(kept.persist);
});

test("missing numeric telemetry stays absent (UNKNOWN); never substitutes zero", () => {
  const raw = syntheticOwnedRaw();
  delete raw.cpuTime;
  delete raw.wallTime;
  delete raw.eventTimestamp;
  const kept = ingestForPersistence(raw, OWNED_CONTEXT);
  assert.equal(kept.owned, true);
  assert.equal("cpuTime" in kept.persist, false);
  assert.equal("wallTime" in kept.persist, false);
  assert.equal("eventTimestamp" in kept.persist, false);
  assertPersistedCapturePrivacy(kept.persist);
});

test("forbidden header allowlist covers steer-named leaks", () => {
  for (const key of ["cf-ray", "user-agent", "referer", "origin", "from"]) {
    assert.ok(
      FORBIDDEN_PERSIST_HEADER_KEYS.includes(key),
      `${key} must be in FORBIDDEN_PERSIST_HEADER_KEYS`,
    );
  }
});

/**
 * Counterexample: owned emissions for distinct inner routes all collapse to
 * route_class=admin-cost-control-probe when cohort/workload_hash/arm are never
 * projected. Synthetic owned emissions only; prove the registry restores the
 * allowlisted cohort join without persisting raw markers or series ids.
 */
test("counterexample: without controlled-marker registry inner cohorts collapse to route_class", () => {
  // Ownership context WITHOUT allowedCohorts filter (live Path-B shape) and
  // WITHOUT controlledMarkerRegistry — installed projection before the fix.
  const noRegistry = {
    ownedMarkers: new Set([OWNED_MARKER]),
    allowedVersionIds: new Set([OWNED_VERSION]),
  };
  const zapHash = "a".repeat(64);
  const healthHash = "b".repeat(64);
  const zap = toPredicateOnlyCapture(
    syntheticOwnedRaw({
      headers: {
        "x-cityscroll-cost-cohort": "zap-bbl",
        "x-cityscroll-cost-workload": zapHash,
        "x-cityscroll-cost-series": "fixed-warehouse-synth",
      },
    }),
    noRegistry,
  );
  const health = toPredicateOnlyCapture(
    syntheticOwnedRaw({
      headers: {
        "x-cityscroll-cost-cohort": "health",
        "x-cityscroll-cost-workload": healthHash,
        "x-cityscroll-cost-series": "fixed-warehouse-synth",
      },
    }),
    noRegistry,
  );
  assert.equal(zap.route_class, OWNED_ROUTE_CLASS);
  assert.equal(health.route_class, OWNED_ROUTE_CLASS);
  assert.equal(zap.cohort, undefined);
  assert.equal(health.cohort, undefined);
  assert.equal(zap.workload_hash, undefined);
  assert.equal(projectOwnedControlledMarkers(syntheticOwnedRaw(), noRegistry), null);
  // Allowlisted join key collapses: both look like the outer admin probe class.
  assert.equal(zap.route_class, health.route_class);
});

test("fix: exact markerTuples + armByVersionId project cohort/workload_hash/arm; mismatch → UNKNOWN", () => {
  const zapHash = "a".repeat(64);
  const healthHash = "b".repeat(64);
  const zapMarker = "cost-synthetic-zap-0";
  const healthMarker = "cost-synthetic-health-0";
  const rollbackVersion = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const candidateVersion = "ffffffff-1111-2222-3333-444444444444";
  const registryContext = {
    ownedMarkers: new Set([zapMarker, healthMarker, OWNED_MARKER]),
    allowedVersionIds: new Set([rollbackVersion, candidateVersion, OWNED_VERSION]),
    controlledMarkerRegistry: {
      markerTuples: new Map([
        [zapMarker, { cohort: "zap-bbl", workloadHash: zapHash }],
        [healthMarker, { cohort: "health", workloadHash: healthHash }],
        [OWNED_MARKER, { cohort: "health", workloadHash: "0".repeat(64) }],
      ]),
      armByVersionId: new Map([
        [rollbackVersion, "rollback"],
        [candidateVersion, "candidate"],
        [OWNED_VERSION, "rollback"],
      ]),
    },
  };
  const zap = toPredicateOnlyCapture(
    syntheticOwnedRaw({
      scriptVersion: { id: rollbackVersion },
      headers: {
        "x-cityscroll-cost-probe": zapMarker,
        "x-cityscroll-cost-cohort": "zap-bbl",
        "x-cityscroll-cost-workload": zapHash,
        "x-cityscroll-cost-series": "must-not-become-arm",
      },
    }),
    registryContext,
  );
  const health = toPredicateOnlyCapture(
    syntheticOwnedRaw({
      scriptVersion: { id: candidateVersion },
      headers: {
        "x-cityscroll-cost-probe": healthMarker,
        "x-cityscroll-cost-cohort": "health",
        "x-cityscroll-cost-workload": healthHash,
        "x-cityscroll-cost-series": "must-not-become-arm",
      },
    }),
    registryContext,
  );
  assert.equal(zap.route_class, OWNED_ROUTE_CLASS);
  assert.equal(zap.cohort, "zap-bbl");
  assert.equal(zap.workload_hash, zapHash);
  assert.equal(zap.arm, "rollback");
  assert.equal(health.cohort, "health");
  assert.equal(health.workload_hash, healthHash);
  assert.equal(health.arm, "candidate");
  // Series must never be retained as arm.
  assert.equal(zap.arm === "must-not-become-arm", false);
  assert.equal(JSON.stringify(zap).includes("must-not-become-arm"), false);
  assertPersistedCapturePrivacy(zap);
  assertPersistedCapturePrivacy(health);
  assert.equal(JSON.stringify(zap).includes(zapMarker), false);
});

test("negative: cross-paired known cohort/hash fails closed to UNKNOWN", () => {
  const zapHash = "a".repeat(64);
  const healthHash = "b".repeat(64);
  const marker = OWNED_MARKER;
  const ctx = {
    ownedMarkers: new Set([marker]),
    allowedVersionIds: new Set([OWNED_VERSION]),
    controlledMarkerRegistry: {
      markerTuples: new Map([
        [marker, { cohort: "zap-bbl", workloadHash: zapHash }],
      ]),
      armByVersionId: new Map([[OWNED_VERSION, "rollback"]]),
    },
  };
  // Cross-pair: known health cohort with the zap marker's expected hash.
  const cross = toPredicateOnlyCapture(
    syntheticOwnedRaw({
      headers: {
        "x-cityscroll-cost-cohort": "health",
        "x-cityscroll-cost-workload": zapHash,
      },
    }),
    ctx,
  );
  assert.equal(cross.cohort, CONTROLLED_MARKER_UNKNOWN);
  assert.equal(cross.workload_hash, CONTROLLED_MARKER_UNKNOWN);
  assert.equal(cross.arm, "rollback");
  assertPersistedCapturePrivacy(cross);

  // Wrong hash for the bound marker.
  const wrongHash = toPredicateOnlyCapture(
    syntheticOwnedRaw({
      headers: {
        "x-cityscroll-cost-cohort": "zap-bbl",
        "x-cityscroll-cost-workload": healthHash,
      },
    }),
    ctx,
  );
  assert.equal(wrongHash.cohort, CONTROLLED_MARKER_UNKNOWN);
  assert.equal(wrongHash.workload_hash, CONTROLLED_MARKER_UNKNOWN);
});

test("negative: independent Sets registry shape is rejected; malformed config fails closed", () => {
  assert.throws(
    () => normalizeControlledMarkerRegistry({
      cohorts: new Set(["zap-bbl"]),
      workloadHashes: new Set(["a".repeat(64)]),
      arms: new Set(["fixed-warehouse-synth"]),
    }),
    /markerTuples|independent/,
  );
  assert.throws(
    () => normalizeControlledMarkerRegistry({
      markerTuples: new Map([
        [OWNED_MARKER, { cohort: "not-a-canonical-cohort", workloadHash: "a".repeat(64) }],
      ]),
    }),
    /closed canonical enum/,
  );
  assert.throws(
    () => normalizeControlledMarkerRegistry({
      markerTuples: new Map([
        [OWNED_MARKER, { cohort: "zap-bbl", workloadHash: "not-hex" }],
      ]),
    }),
    /64-hex/,
  );
  assert.throws(
    () => normalizeControlledMarkerRegistry({
      markerTuples: new Map([
        [OWNED_MARKER, { cohort: "https://evil.example/path?q=1", workloadHash: "a".repeat(64) }],
      ]),
    }),
    /closed canonical enum|privacy value/,
  );
  assert.throws(
    () => normalizeControlledMarkerRegistry({
      armByVersionId: new Map([[OWNED_VERSION, "fixed-warehouse-synth"]]),
    }),
    /rollback or candidate/,
  );
});

test("negative: projector enforces ownership; foreign version arm → UNKNOWN", () => {
  const hash = "a".repeat(64);
  const ctx = {
    ownedMarkers: new Set([OWNED_MARKER]),
    allowedVersionIds: new Set([OWNED_VERSION]),
    controlledMarkerRegistry: {
      markerTuples: new Map([
        [OWNED_MARKER, { cohort: "health", workloadHash: hash }],
      ]),
      armByVersionId: new Map([[OWNED_VERSION, "rollback"]]),
    },
  };
  assert.throws(
    () => projectOwnedControlledMarkers(
      syntheticOwnedRaw({ headers: { "x-cityscroll-cost-probe": FOREIGN_MARKER } }),
      ctx,
    ),
    /refuses non-owned/,
  );
  const foreignVersion = toPredicateOnlyCapture(
    syntheticOwnedRaw({
      scriptVersion: { id: "00000000-0000-0000-0000-000000000099" },
      headers: {
        "x-cityscroll-cost-cohort": "health",
        "x-cityscroll-cost-workload": hash,
      },
    }),
    {
      ownedMarkers: new Set([OWNED_MARKER]),
      allowedVersionIds: new Set([OWNED_VERSION, "00000000-0000-0000-0000-000000000099"]),
      controlledMarkerRegistry: ctx.controlledMarkerRegistry,
    },
  );
  assert.equal(foreignVersion.arm, CONTROLLED_MARKER_UNKNOWN);
  assert.equal(foreignVersion.cohort, "health");
  assertPersistedCapturePrivacy(foreignVersion);

  const reg = { markerTuples: new Map() };
  bindOwnedProbeMarkerTuple(reg, OWNED_MARKER, { cohort: "browse", workloadHash: "c".repeat(64) });
  assert.equal(reg.markerTuples.get(OWNED_MARKER).cohort, "browse");
  assert.throws(
    () => bindOwnedProbeMarkerTuple(reg, OWNED_MARKER, {
      cohort: "browse",
      workloadHash: "https://example.com/?id=1",
    }),
    /64-hex|privacy value/,
  );
});