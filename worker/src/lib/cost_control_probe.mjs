// Bounded, authenticated production cost measurement. This module never persists
// observations: the operator correlates its sanitized log record with the same
// invocation's provider-native cpuTime sample from a short-lived tail session.

const PROBE_HEADER = "x-cityscroll-cost-probe";
const COHORT_HEADER = "x-cityscroll-cost-cohort";
const WORKLOAD_HEADER = "x-cityscroll-cost-workload";
const SERIES_HEADER = "x-cityscroll-cost-series";
const PROBE_TAG = /^[a-z0-9][a-z0-9-]{7,95}$/;
const WORKLOAD_HASH = /^[a-f0-9]{64}$/;
const MAX_ISOLATE_MARKERS = 256;
const isolateMarkers = new Set();
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

function resultMeta(result, counters) {
  const meta = result?.meta || {};
  const rowsRead = Number(meta.rows_read);
  const rowsWritten = Number(meta.rows_written ?? meta.changes);
  if (Number.isFinite(rowsRead) && rowsRead > 0) counters.d1_rows_read += rowsRead;
  if (Number.isFinite(rowsWritten) && rowsWritten > 0) counters.d1_rows_written += rowsWritten;
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
          if (suppressWrites && isWriteSql(sql)) return null;
          const result = resultMeta(await current.all(), counters);
          const row = result?.results?.[0] ?? null;
          return columnName && row ? row[columnName] : row;
        };
      }
      if (["all", "raw", "run"].includes(property)) {
        return async (...args) => {
          if (suppressWrites && isWriteSql(sql)) return suppressedD1Result();
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
          if (suppressWrites && isWriteSql(sql)) return suppressedD1Result();
          return resultMeta(await target.exec(sql), counters);
        };
      }
      if (property === "batch") {
        return async (statements) => {
          if (suppressWrites) {
            const results = [];
            for (const statement of statements) {
              results.push(isWriteSql(statementSql.get(statement))
                ? suppressedD1Result()
                : await statement.all());
            }
            return results;
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
          counters.kv_reads += 1;
          return target[property](...args);
        };
      }
      if (["put", "delete"].includes(property)) {
        return async (...args) => {
          counters.kv_writes += 1;
          if (suppressWrites) return undefined;
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
          counters.queue_writes += property === "sendBatch" ? (args[0]?.length || 0) : 1;
          if (suppressWrites) return undefined;
          return target[property](...args);
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
                counters.analytics_points += 1;
                return target.writeDataPoint(...args);
              };
              const child = target[property];
              return typeof child === "function" ? child.bind(target) : child;
            },
          })
        : kind === "queue"
          ? wrapQueue(value, counters, suppressWrites)
          : value;
  }
  if (suppressWrites) {
    measured.ALERTS_LIVE = "false";
    measured.QUEUE_DIGESTS = "false";
    measured.RESEND_API_KEY = "";
  }
  return measured;
}

export function beginCostControlProbe(request, env, { suppressWrites = false } = {}) {
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
    || !PROBE_TAG.test(series)
    || !constantTimeEqual(authorizationToken(request), env.ADMIN_KEY)
  ) {
    return { denied: new Response("Not found", { status: 404 }) };
  }

  const route = cohort.replace(/:(?:cold|warm)$/, "");
  const marker = `${route}:${series}`;
  const isolateCondition = isolateMarkers.has(marker) ? "warm" : "cold";
  if (!isolateMarkers.has(marker)) {
    if (isolateMarkers.size >= MAX_ISOLATE_MARKERS) isolateMarkers.delete(isolateMarkers.values().next().value);
    isolateMarkers.add(marker);
  }
  const counters = {
    kv_reads: 0,
    kv_writes: 0,
    d1_rows_read: 0,
    d1_rows_written: 0,
    queue_writes: 0,
    analytics_points: 0,
  };
  const startedAt = Date.now();
  const mode = suppressWrites ? "production-read-only-rehearsal" : "production-request";
  const claimedCondition = cohort.match(/:(cold|warm)$/)?.[1] || null;
  if (claimedCondition && claimedCondition !== isolateCondition) {
    return { denied: Response.json({ error: "isolate-condition-mismatch", observed: isolateCondition }, { status: 409 }) };
  }
  return {
    cohort,
    counters,
    denied: null,
    env: instrumentEnvironment(env, counters, suppressWrites),
    isolateCondition,
    mode,
    snapshot(extra = {}) {
      return {
        schema: "cityscroll.worker_cost_probe.v1",
        tag,
        series,
        cohort,
        workload_hash: workloadHash,
        isolate_condition: isolateCondition,
        execution_mode: mode,
        elapsed_ms: Math.max(0, Date.now() - startedAt),
        operations: { ...counters },
        ...extra,
      };
    },
  };
}

export function logCostControlProbe(probe, extra = {}) {
  if (!probe || probe.denied) return;
  console.log(JSON.stringify(probe.snapshot(extra)));
}
