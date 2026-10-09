// Bounded, authenticated production cost measurement. This module never persists
// observations: the operator correlates its sanitized log record with the same
// invocation's provider-native cpuTime sample from a short-lived tail session.

const PROBE_HEADER = "x-cityscroll-cost-probe";
const COHORT_HEADER = "x-cityscroll-cost-cohort";
const WORKLOAD_HEADER = "x-cityscroll-cost-workload";
const SERIES_HEADER = "x-cityscroll-cost-series";
const PROBE_TAG = /^[a-z0-9][a-z0-9-]{7,95}$/;
const WORKLOAD_HASH = /^[a-f0-9]{64}$/;
const NATIVE_PROBE_SCHEMA = "cityscroll.worker_native_cost_probe.v1";
const MAX_NATIVE_PROBE_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_NATIVE_SCHEDULED_WINDOW_MS = 30 * 60 * 1000;
const statementTargets = new WeakMap();
const statementSql = new WeakMap();

function constantTimeEqual(left, right) {
  const a = new TextEncoder().encode(String(left || ""));
  const b = new TextEncoder().encode(String(right || ""));
  if (a.byteLength !== b.byteLength || a.byteLength === 0) return false;
  let difference = 0;
  for (let index = 0; index < a.byteLength; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

function authorizationToken(request) {
  const value = request.headers.get("authorization") || "";
  return value.startsWith("Bearer ") ? value.slice(7) : "";
}

export function canonicalCostProbeWorkload(value) {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalCostProbeWorkload).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalCostProbeWorkload(value[key])}`
    )).join(",")}}`;
  }
  throw new TypeError("unsupported cost probe workload value");
}

function exactObjectKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function workloadShape(value, depth = 0) {
  if (depth > 8) throw new TypeError("queue workload structure is too deep");
  if (value === null) return "null";
  if (Array.isArray(value)) return { array: value.map((item) => workloadShape(item, depth + 1)) };
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return "bytes";
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError("unsupported queue workload structure");
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, workloadShape(value[key], depth + 1)]));
  }
  if (["boolean", "number", "string", "undefined", "bigint"].includes(typeof value)) return typeof value;
  throw new TypeError("unsupported queue workload structure");
}

export async function queueBatchFingerprint(batch) {
  if (!batch || typeof batch.queue !== "string" || !batch.queue || !Array.isArray(batch.messages) || !batch.messages.length) return null;
  const identities = [];
  for (const message of batch.messages) {
    if (typeof message?.id !== "string" || !message.id || message.id.length > 256) return null;
    const timestamp = message.timestamp instanceof Date ? message.timestamp.getTime() : Date.parse(message.timestamp);
    if (!Number.isFinite(timestamp) || !Number.isInteger(message.attempts) || message.attempts < 1) return null;
    let shape;
    try { shape = workloadShape(message.body); }
    catch { return null; }
    identities.push({ id: message.id, timestamp, attempts: message.attempts, shape });
  }
  identities.sort((left, right) => left.id.localeCompare(right.id));
  if (identities.some((message, index) => index > 0 && message.id === identities[index - 1].id)) return null;
  return sha256(canonicalJson({ queue: batch.queue, messages: identities }));
}

function nativeProbeConfig(env, now) {
  if (!env?.WORKER_COST_NATIVE_PROBE) return null;
  let config;
  try { config = JSON.parse(env.WORKER_COST_NATIVE_PROBE); }
  catch { return null; }
  if (!exactObjectKeys(config, [
    "schema", "enabled", "starts_at", "expires_at", "run_marker_sha256", "workload_digest",
    "scheduled_windows", "queue", "queue_batch_fingerprints", "max_queue_batch",
  ])) return null;
  const startsAt = Date.parse(config.starts_at);
  const expiresAt = Date.parse(config.expires_at);
  if (
    config.schema !== NATIVE_PROBE_SCHEMA
    || config.enabled !== true
    || !Number.isFinite(startsAt)
    || !Number.isFinite(expiresAt)
    || expiresAt <= startsAt
    || expiresAt - startsAt > MAX_NATIVE_PROBE_WINDOW_MS
    || now < startsAt
    || now > expiresAt
    || !WORKLOAD_HASH.test(config.run_marker_sha256)
    || !WORKLOAD_HASH.test(config.workload_digest)
    || !Array.isArray(config.scheduled_windows)
    || config.scheduled_windows.length < 1
    || config.scheduled_windows.length > 3
    || config.scheduled_windows.some((window) => {
      if (!exactObjectKeys(window, ["trigger", "scheduled_time", "starts_at", "expires_at"])) return true;
      const windowStartsAt = Date.parse(window.starts_at);
      const windowExpiresAt = Date.parse(window.expires_at);
      return typeof window.trigger !== "string"
        || !window.trigger
        || window.trigger.length > 64
        || !Number.isInteger(window.scheduled_time)
        || !Number.isFinite(windowStartsAt)
        || !Number.isFinite(windowExpiresAt)
        || windowExpiresAt <= windowStartsAt
        || windowExpiresAt - windowStartsAt > MAX_NATIVE_SCHEDULED_WINDOW_MS
        || windowStartsAt < startsAt
        || windowExpiresAt > expiresAt;
    })
    || typeof config.queue !== "string"
    || !config.queue
    || config.queue.length > 128
    || !Array.isArray(config.queue_batch_fingerprints)
    || config.queue_batch_fingerprints.length < 1
    || config.queue_batch_fingerprints.length > 100
    || config.queue_batch_fingerprints.some((fingerprint) => !WORKLOAD_HASH.test(fingerprint))
    || !Number.isInteger(config.max_queue_batch)
    || config.max_queue_batch < 1
    || config.max_queue_batch > 100
  ) return null;
  return config;
}

export function createNativeCostControlProbeRecord(env, invocation, now = Date.now()) {
  const config = nativeProbeConfig(env, now);
  if (!config || !invocation || typeof invocation !== "object") return null;
  const operations = invocation.operations;
  if (!operations || invocation.operationMeterComplete !== true) return null;
  const shared = {
    schema: NATIVE_PROBE_SCHEMA,
    kind: invocation.kind,
    run_marker_sha256: config.run_marker_sha256,
    workload_digest: config.workload_digest,
    instrumentation_log_count: 1,
    operations,
  };
  if (invocation.kind === "scheduled") {
    const window = config.scheduled_windows.find((candidate) => (
      candidate.trigger === invocation.trigger
      && candidate.scheduled_time === invocation.scheduledTime
      && now >= Date.parse(candidate.starts_at)
      && now <= Date.parse(candidate.expires_at)
    ));
    if (!window) return null;
    return { ...shared, trigger: invocation.trigger, scheduled_time: invocation.scheduledTime };
  }
  if (invocation.kind === "queue") {
    if (
      invocation.queue !== config.queue
      || !Number.isInteger(invocation.batchSize)
      || invocation.batchSize < 1
      || invocation.batchSize > config.max_queue_batch
      || !WORKLOAD_HASH.test(invocation.batchFingerprint)
      || !config.queue_batch_fingerprints.includes(invocation.batchFingerprint)
    ) return null;
    return {
      ...shared,
      queue: invocation.queue,
      batch_size: invocation.batchSize,
      batch_fingerprint_sha256: invocation.batchFingerprint,
    };
  }
  return null;
}

function resultMeta(result, counters) {
  const meta = result?.meta || {};
  const rowsRead = Number(meta.rows_read);
  const rowsWritten = Number(meta.rows_written ?? meta.changes);
  if (Number.isFinite(rowsRead) && rowsRead > 0) {
    counters.attempted.d1_rows_read += rowsRead;
    counters.d1_rows_read += rowsRead;
  }
  if (Number.isFinite(rowsWritten) && rowsWritten > 0) {
    counters.attempted.d1_rows_written += rowsWritten;
    counters.d1_rows_written += rowsWritten;
  }
  return result;
}

function isWriteSql(sql) {
  return /^\s*(?:insert|update|delete|replace|create|drop|alter|vacuum|reindex|pragma\s+[^=]+\s*=)/i.test(String(sql));
}

function suppressedD1Result() {
  return { success: true, meta: { rows_read: 0, rows_written: 0, changes: 0 }, results: [] };
}

function wrapStatement(statement, sql, counters, suppressWrites) {
  let current = statement;
  const proxy = new Proxy(statement, {
    get(_target, property) {
      if (property === "bind") {
        return (...args) => {
          current = current.bind(...args);
          return wrapStatement(current, sql, counters, suppressWrites);
        };
      }
      if (property === "first") {
        return async (columnName) => {
          if (isWriteSql(sql)) {
            counters.attempted.d1_writes += 1;
            if (suppressWrites) return null;
          }
          const result = resultMeta(await current.all(), counters);
          const row = result?.results?.[0] ?? null;
          return columnName && row ? row[columnName] : row;
        };
      }
      if (["all", "raw", "run"].includes(property)) {
        return async (...args) => {
          if (isWriteSql(sql)) {
            counters.attempted.d1_writes += 1;
            if (suppressWrites) return suppressedD1Result();
          }
          return resultMeta(await current[property](...args), counters);
        };
      }
      const value = current[property];
      return typeof value === "function" ? value.bind(current) : value;
    },
  });
  statementTargets.set(proxy, current);
  statementSql.set(proxy, sql);
  return proxy;
}

function wrapD1(database, counters, suppressWrites) {
  return new Proxy(database, {
    get(target, property) {
      if (property === "prepare") {
        return (sql) => wrapStatement(target.prepare(sql), sql, counters, suppressWrites);
      }
      if (property === "exec") {
        return async (sql) => {
          if (isWriteSql(sql)) {
            counters.attempted.d1_writes += 1;
            if (suppressWrites) return suppressedD1Result();
          }
          return resultMeta(await target.exec(sql), counters);
        };
      }
      if (property === "batch") {
        return async (statements) => {
          if (suppressWrites) {
            const results = [];
            for (const statement of statements) {
              if (isWriteSql(statementSql.get(statement))) {
                counters.attempted.d1_writes += 1;
                results.push(suppressedD1Result());
              } else {
                results.push(await statement.all());
              }
            }
            return results;
          }
          for (const statement of statements) {
            if (isWriteSql(statementSql.get(statement))) counters.attempted.d1_writes += 1;
          }
          const results = await target.batch(statements.map((statement) => statementTargets.get(statement) || statement));
          for (const result of results || []) resultMeta(result, counters);
          return results;
        };
      }
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function wrapKv(namespace, counters, suppressWrites) {
  return new Proxy(namespace, {
    get(target, property) {
      if (["get", "getWithMetadata", "list"].includes(property)) {
        return async (...args) => {
          counters.attempted.kv_reads += 1;
          const result = await target[property](...args);
          counters.kv_reads += 1;
          return result;
        };
      }
      if (["put", "delete"].includes(property)) {
        return async (...args) => {
          counters.attempted.kv_writes += 1;
          if (suppressWrites) return undefined;
          const bytes = property === "put" ? storageByteLength(args[1]) : 0;
          if (bytes === null) counters.operation_meter_complete = false;
          else counters.attempted.storage_bytes += bytes;
          const result = await target[property](...args);
          counters.kv_writes += 1;
          if (bytes !== null) counters.storage_bytes += bytes;
          return result;
        };
      }
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function storageByteLength(value) {
  if (typeof value === "string") return new TextEncoder().encode(value).byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (value instanceof Blob) return value.size;
  return null;
}

function wrapR2(bucket, counters, suppressWrites) {
  return new Proxy(bucket, {
    get(target, property) {
      if (property === "put") {
        return async (...args) => {
          const bytes = storageByteLength(args[1]);
          if (bytes === null) counters.operation_meter_complete = false;
          else counters.attempted.storage_bytes += bytes;
          if (suppressWrites) return null;
          const result = await target.put(...args);
          if (bytes !== null) counters.storage_bytes += bytes;
          return result;
        };
      }
      if (["createMultipartUpload", "resumeMultipartUpload"].includes(property)) {
        return (...args) => {
          counters.operation_meter_complete = false;
          return target[property](...args);
        };
      }
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function wrapQueue(queue, counters, suppressWrites) {
  return new Proxy(queue, {
    get(target, property) {
      if (property === "send" || property === "sendBatch") {
        return async (...args) => {
          const count = property === "sendBatch" ? (args[0]?.length || 0) : 1;
          counters.attempted.queue_writes += count;
          if (suppressWrites) return undefined;
          const result = await target[property](...args);
          counters.queue_writes += count;
          return result;
        };
      }
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function bindingKind(value) {
  if (!value || typeof value !== "object") return null;
  if (typeof value.prepare === "function" && typeof value.batch === "function") return "d1";
  if (typeof value.writeDataPoint === "function") return "analytics";
  if (typeof value.createMultipartUpload === "function" || typeof value.head === "function") return "r2";
  if (typeof value.get === "function" && typeof value.put === "function" && typeof value.list === "function") return "kv";
  if (typeof value.send === "function" || typeof value.sendBatch === "function") return "queue";
  return null;
}

function instrumentEnvironment(env, counters, suppressWrites) {
  const measured = Object.create(Object.getPrototypeOf(env) || null);
  for (const [name, value] of Object.entries(env)) {
    const kind = bindingKind(value);
    measured[name] = kind === "d1"
      ? wrapD1(value, counters, suppressWrites)
      : kind === "kv"
        ? wrapKv(value, counters, suppressWrites)
        : kind === "analytics"
          ? new Proxy(value, {
            get(target, property) {
              if (property === "writeDataPoint") return (...args) => {
                counters.attempted.analytics_points += 1;
                if (suppressWrites) return undefined;
                const result = target.writeDataPoint(...args);
                counters.analytics_points += 1;
                return result;
              };
              const child = target[property];
              return typeof child === "function" ? child.bind(target) : child;
            },
          })
        : kind === "queue"
          ? wrapQueue(value, counters, suppressWrites)
          : kind === "r2"
            ? wrapR2(value, counters, suppressWrites)
          : value;
  }
  if (suppressWrites) {
    measured.ALERTS_LIVE = "false";
    measured.QUEUE_DIGESTS = "false";
    measured.RESEND_API_KEY = "";
  }
  return measured;
}

function costCounters() {
  return {
    kv_reads: 0,
    kv_writes: 0,
    d1_rows_read: 0,
    d1_rows_written: 0,
    storage_bytes: 0,
    queue_writes: 0,
    analytics_points: 0,
    operation_meter_complete: true,
    attempted: {
      kv_reads: 0,
      kv_writes: 0,
      d1_rows_read: 0,
      d1_rows_written: 0,
      storage_bytes: 0,
      d1_writes: 0,
      queue_writes: 0,
      analytics_points: 0,
    },
  };
}

function nativeOperationSnapshot(counters) {
  return Object.fromEntries([
    ["kv_reads", [counters.attempted.kv_reads, counters.kv_reads]],
    ["kv_writes", [counters.attempted.kv_writes, counters.kv_writes]],
    ["d1_rows_read", [counters.attempted.d1_rows_read, counters.d1_rows_read]],
    ["d1_rows_written", [counters.attempted.d1_rows_written, counters.d1_rows_written]],
    ["storage_bytes", [counters.attempted.storage_bytes, counters.storage_bytes]],
  ].map(([meter, [attempted, confirmed]]) => [meter, { attempted, confirmed }]));
}

function measuredContext(ctx, pending) {
  if (!ctx || typeof ctx.waitUntil !== "function") return ctx;
  return new Proxy(ctx, {
    get(target, property) {
      if (property === "waitUntil") return (promise) => {
        const tracked = Promise.resolve(promise);
        pending.push(tracked);
        return target.waitUntil(tracked);
      };
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export async function runNativeCostControlProbe(env, ctx, invocation, handler, now = Date.now()) {
  if (!nativeProbeConfig(env, now)) return handler(env, ctx);
  const batchFingerprint = invocation.kind === "queue"
    ? await queueBatchFingerprint({ queue: invocation.queue, messages: invocation.messages })
    : undefined;
  const counters = costCounters();
  const candidate = {
    ...invocation,
    batchFingerprint,
    operations: nativeOperationSnapshot(counters),
    operationMeterComplete: counters.operation_meter_complete,
  };
  if (!createNativeCostControlProbeRecord(env, candidate, now)) return handler(env, ctx);
  const pending = [];
  const measuredEnv = instrumentEnvironment(env, counters, false);
  const context = measuredContext(ctx, pending);
  try {
    return await handler(measuredEnv, context);
  } finally {
    await Promise.allSettled(pending);
    const record = createNativeCostControlProbeRecord(env, {
      ...candidate,
      operations: nativeOperationSnapshot(counters),
      operationMeterComplete: counters.operation_meter_complete,
    }, now);
    if (record) console.log(record);
  }
}

export function beginCostControlProbe(request, env, { suppressWrites = false, workloadHash: expectedWorkloadHash = "" } = {}) {
  const tag = request.headers.get(PROBE_HEADER) || "";
  if (!tag) return null;
  const cohort = request.headers.get(COHORT_HEADER) || "";
  const workloadHash = request.headers.get(WORKLOAD_HEADER) || "";
  const series = request.headers.get(SERIES_HEADER) || "";
  if (
    !PROBE_TAG.test(tag)
    || !cohort
    || cohort.length > 80
    || !WORKLOAD_HASH.test(workloadHash)
    || !WORKLOAD_HASH.test(expectedWorkloadHash)
    || !constantTimeEqual(workloadHash, expectedWorkloadHash)
    || !PROBE_TAG.test(series)
    || !constantTimeEqual(authorizationToken(request), env.ADMIN_KEY)
  ) {
    return { denied: new Response("Not found", { status: 404 }) };
  }

  let accepted = false;
  const counters = costCounters();
  const startedAt = Date.now();
  const mode = suppressWrites ? "production-read-only-rehearsal" : "production-request";
  return {
    accept() {
      accepted = true;
    },
    get accepted() { return accepted; },
    cohort,
    counters,
    denied: null,
    env: instrumentEnvironment(env, counters, suppressWrites),
    mode,
    snapshot(extra = {}) {
      return {
        schema: "cityscroll.worker_cost_probe.v1",
        tag,
        series,
        cohort,
        workload_hash: expectedWorkloadHash,
        execution_mode: mode,
        elapsed_ms: Math.max(0, Date.now() - startedAt),
        operations: {
          kv_reads: counters.kv_reads,
          kv_writes: counters.kv_writes,
          d1_rows_read: counters.d1_rows_read,
          d1_rows_written: counters.d1_rows_written,
          queue_writes: counters.queue_writes,
          analytics_points: counters.analytics_points,
        },
        attempted_writes: {
          kv_writes: counters.attempted.kv_writes,
          d1_writes: counters.attempted.d1_writes,
          queue_writes: counters.attempted.queue_writes,
          analytics_points: counters.attempted.analytics_points,
        },
        ...extra,
      };
    },
  };
}

export function logCostControlProbe(probe, extra = {}) {
  if (!probe || probe.denied || !probe.accepted) return;
  console.log(JSON.stringify(probe.snapshot(extra)));
}
