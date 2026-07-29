// Frontend-origin contract shared by browser-facing Worker routes.
//
// Review origins are accepted only by the beta environment. Production keeps
// its existing stable, mirror, legacy, and local-development origin set.

const STABLE_ORIGINS = new Set([
  "https://crol-list.org",
  "https://www.crol-list.org",
  "https://cityscroll.org",
  "https://www.cityscroll.org",
  "https://crol-list.jimdc.com",
  "https://jimdc.github.io",
  "http://localhost:8000",
  "http://localhost:8787",
  "http://localhost:8888",
]);

function isReviewOrigin(origin) {
  if (origin === "https://beta.crol-list.org") return true;
  try {
    const url = new URL(origin);
    return (
      url.protocol === "https:"
      && (
        url.hostname === "crol-list-beta.pages.dev"
        || url.hostname.endsWith(".crol-list-beta.pages.dev")
      )
      && url.port === ""
    );
  } catch {
    return false;
  }
}

export function isAllowedRequestOrigin(origin, env = {}) {
  if (!origin) return true;
  if (STABLE_ORIGINS.has(origin)) return true;
  return env?.DEPLOYMENT_CHANNEL === "beta" && isReviewOrigin(origin);
}

export function corsHeaders(
  origin,
  env = {},
  {
    methods = "POST, OPTIONS",
    headers = "Content-Type",
    maxAge,
    cacheControl,
  } = {},
) {
  const result = {
    "Access-Control-Allow-Origin": isAllowedRequestOrigin(origin, env)
      ? (origin || "https://crol-list.org")
      : "https://crol-list.org",
    "Access-Control-Allow-Methods": methods,
    "Access-Control-Allow-Headers": headers,
    "Vary": "Origin",
  };
  if (maxAge) result["Access-Control-Max-Age"] = maxAge;
  if (cacheControl) result["Cache-Control"] = cacheControl;
  return result;
}
