/**
 * Worker cost capture-guard ownership + privacy tests.
 * Synthetic events follow the capture SCHEMA (key paths only).
 * Never load quarantined files or embed real visitor/probe values.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  FORBIDDEN_PERSIST_HEADER_KEYS,
  OWNED_PROBE_METHOD,
  OWNED_PROBE_URL,
  OWNED_ROUTE_CLASS,
  assertPersistedCapturePrivacy,
  ingestForPersistence,
  isOwnedProbeEvent,
  persistOwnedCaptures,
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
