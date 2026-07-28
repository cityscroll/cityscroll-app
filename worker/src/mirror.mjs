// /mirror — serves cityscroll.org and www.cityscroll.org by reverse-proxying the static
// site from crol-list.org (the GitHub Pages origin). crol-list.org stays canonical: this
// worker only fronts a second domain for the same content, byte-for-byte, so the two
// domains can never drift out of sync and every page's own <link rel="canonical"> (which
// always points at crol-list.org) rides along unchanged.
//
// GitHub Pages virtual-hosts by the Host header, so the request to the origin must NOT
// carry the incoming Host (cityscroll.org) — that would 404 on a domain GitHub doesn't
// know about. Only a small, safe header allowlist is forwarded; everything else is dropped.

const ORIGIN = "https://crol-list.org";
const FORWARD_REQUEST_HEADERS = ["accept", "accept-language", "if-none-match", "if-modified-since", "user-agent"];

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

  const originResponse = await fetch(originUrl.toString(), { method: request.method, headers });
  return new Response(originResponse.body, originResponse);
}
