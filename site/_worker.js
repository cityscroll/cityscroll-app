import pages from "./pages_edge.mjs";
import { startPreviewRequest, startPreviewResponse, usesStartPreview } from "./start/response.mjs";

export default {
  async fetch(request, env, context) {
    const { hostname, pathname } = new URL(request.url);
    if (hostname !== "cityscroll.org" || request.method !== "GET" ||
        !/^\/browse(?:\/|$)/.test(pathname) || !usesStartPreview(request)) {
      return pages.fetch(request, env, context);
    }
    const response = await pages.fetch(startPreviewRequest(request), env, context);
    return startPreviewResponse(response);
  },
};
