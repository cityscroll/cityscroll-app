const DEFAULT_API_ORIGIN = "https://api.cityscroll.org";
const DEV_HEADER = "X-CROL-Analytics-Dev";

function performanceEndpoint(endpoint, runtime) {
  if (endpoint) return endpoint;
  const configured = runtime?.CROL_API_ORIGIN || runtime?.window?.CROL_API_ORIGIN;
  const origin = typeof configured === "string" && /^https:\/\//.test(configured)
    ? configured.replace(/\/+$/, "")
    : DEFAULT_API_ORIGIN;
  return `${origin}/performance-events`;
}

/**
 * Best-effort browser transport for an already-bounded RUM batch.
 *
 * Collection remains disabled by the caller/manifest. Every API and network failure is reduced
 * to a local state value so telemetry can never become a page, navigation, or interaction error.
 */
export async function deliverRumBatch(batch, {
  enabled = false,
  endpoint,
  developerToken = "",
  runtime = globalThis,
} = {}) {
  if (enabled !== true) return { state: "disabled" };
  const target = performanceEndpoint(endpoint, runtime);

  let body;
  try {
    body = JSON.stringify(batch);
  } catch {
    return { state: "unavailable" };
  }

  if (!developerToken && typeof runtime?.navigator?.sendBeacon === "function") {
    try {
      // A string keeps Beacon on the CORS-safelisted text/plain content type; an
      // application/json Blob would require an unload-time preflight.
      if (runtime.navigator.sendBeacon(target, body)) {
        return { state: "queued", transport: "beacon" };
      }
    } catch {
      // Fall through to the equally best-effort keepalive request.
    }
  }

  if (typeof runtime?.fetch !== "function") return { state: "unavailable" };
  try {
    const headers = { "Content-Type": "application/json" };
    if (developerToken) headers[DEV_HEADER] = developerToken;
    await runtime.fetch(target, {
      method: "POST",
      headers,
      body,
      keepalive: true,
    });
    return { state: "queued", transport: "fetch" };
  } catch {
    return { state: "unavailable" };
  }
}
