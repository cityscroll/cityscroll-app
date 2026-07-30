// /mirror — serves the canonical cityscroll.org and www.cityscroll.org hosts by
// reverse-proxying the static site from crol-list.org, its GitHub Pages origin.
// Origin redirects are handled manually so a redirect back to this Worker cannot
// become a recursive subrequest loop. If the direct-visitor redirect catches the
// subrequest, the public repository source is the independent failover seam.
//
// GitHub Pages virtual-hosts by the Host header, so the request to the origin must NOT
// carry the incoming Host (cityscroll.org) — that would 404 on a domain GitHub doesn't
// know about. Only a small, safe header allowlist is forwarded; everything else is dropped.

const ORIGIN = "https://crol-list.org";
const FALLBACK_ORIGIN = "https://cityscroll.github.io/crol-list/";
const FORWARD_REQUEST_HEADERS = ["accept", "accept-language", "if-none-match", "if-modified-since", "user-agent"];
const MIRROR_HOSTS = new Set([
  "cityscroll.org",
  "www.cityscroll.org",
  "crol-list.org",
]);
const FALLBACK_CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "application/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "application/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".webm", "video/webm"],
  [".webmanifest", "application/manifest+json"],
  [".xml", "application/xml; charset=utf-8"],
]);

function redirectedToMirror(response) {
  if (response.status < 300 || response.status >= 400) return null;
  const location = response.headers.get("location");
  if (!location) return null;
  try {
    const target = new URL(location, ORIGIN);
    return MIRROR_HOSTS.has(target.hostname) ? target : null;
  } catch {
    return null;
  }
}

function fallbackUrl(target) {
  let pathname = target.pathname;
  if (pathname.endsWith("/")) pathname += "index.html";
  const url = new URL(pathname.replace(/^\/+/, ""), FALLBACK_ORIGIN);
  url.search = target.search;
  return url;
}

function fallbackContentType(pathname) {
  const dot = pathname.lastIndexOf(".");
  return dot === -1 ? null : FALLBACK_CONTENT_TYPES.get(pathname.slice(dot).toLowerCase()) || null;
}

function relay(response, fallbackPathname = null) {
  if (fallbackPathname === null) return new Response(response.body, response);

  const headers = new Headers(response.headers);
  const contentType = fallbackContentType(fallbackPathname);
  if (contentType) headers.set("Content-Type", contentType);
  if (contentType?.startsWith("text/html")) {
    // raw.githubusercontent.com marks source files as sandboxed plain text.
    headers.delete("Content-Security-Policy");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function handleMirror(request) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: { "Content-Type": "text/plain", "Allow": "GET, HEAD" } });
  }

  const incoming = new URL(request.url);
  const originUrl = new URL(incoming.pathname + incoming.search, ORIGIN);

  const headers = new Headers();
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }

  const fetchOptions = { method: request.method, headers, redirect: "manual" };
  const originResponse = await fetch(originUrl.toString(), fetchOptions);
  const mirrorRedirect = redirectedToMirror(originResponse);
  if (!mirrorRedirect) return relay(originResponse);

  const fallback = fallbackUrl(mirrorRedirect);
  const fallbackResponse = await fetch(fallback.toString(), fetchOptions);
  return relay(fallbackResponse, fallback.pathname);
}
