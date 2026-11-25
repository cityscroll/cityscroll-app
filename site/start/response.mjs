const previewAssets = '<link rel="stylesheet" href="/start/preview.css"><script type="module" src="/start/preview.mjs"></script>';

export function usesStartPreview(request) {
  return (request.headers.get("cookie") || "").split(";").some(value => value.trim() === "cityscroll_start_preview=1");
}

export function startPreviewRequest(request) {
  const headers = new Headers(request.headers);
  headers.delete("If-None-Match");
  headers.delete("If-Modified-Since");
  return new Request(request, { headers });
}

export function startPreviewResponse(response, Rewriter = globalThis.HTMLRewriter) {
  if (!response.ok || !response.body || !response.headers.get("content-type")?.startsWith("text/html") || !Rewriter) return response;
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store");
  headers.delete("Content-Length");
  headers.delete("ETag");
  headers.delete("Last-Modified");
  return new Rewriter().on("head", {
    element(head) { head.append(previewAssets, { html: true }); },
  }).transform(new Response(response.body, { status: response.status, statusText: response.statusText, headers }));
}
