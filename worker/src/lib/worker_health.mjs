// Public Worker liveness payload. Existing probes match the `crol-worker ok`
// marker as text; commit and wrangler environment are additive identity fields
// injected at deploy time (`GIT_COMMIT_SHA`, `WRANGLER_ENV`).

export const HEALTH_OK_MARKER = "crol-worker ok";

const COMMIT_RE = /^[0-9a-f]{7,64}$/i;
const ENV_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

function readVar(env, key) {
  const value = env?.[key];
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeHealthCommit(value) {
  const text = String(value || "").trim();
  return COMMIT_RE.test(text) ? text.toLowerCase() : null;
}

export function normalizeHealthEnvironment(value) {
  const text = String(value || "").trim();
  return ENV_RE.test(text) ? text : null;
}

/** Pure projector over Worker env vars. Missing or malformed identity stays null. */
export function workerHealthPayload(env = {}) {
  return {
    status: HEALTH_OK_MARKER,
    commit: normalizeHealthCommit(readVar(env, "GIT_COMMIT_SHA")),
    environment: normalizeHealthEnvironment(readVar(env, "WRANGLER_ENV")),
  };
}

export function handleWorkerHealth(env = {}) {
  return new Response(JSON.stringify(workerHealthPayload(env)), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
