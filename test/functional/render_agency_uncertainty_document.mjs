#!/usr/bin/env node
/**
 * Render one agency uncertainty stop document to stdout.
 *
 * The collision and unresolved routes are served by the edge worker rather
 * than a static file, so visual capture writes this render into the served
 * tree at the same route the reader would open.
 *
 * Usage: node test/functional/render_agency_uncertainty_document.mjs <route-id>
 */
import edgeWorker from "../../site/pages_edge.mjs";

const routeId = process.argv[2];
if (!routeId) {
  console.error("usage: render_agency_uncertainty_document.mjs <route-id>");
  process.exit(2);
}

const env = {
  ASSETS: {
    fetch: async () => new Response(
      "<title>CityScroll</title><div id=\"entityview\">Agency profile</div>",
      { headers: { "Content-Type": "text/html" } },
    ),
  },
};

const response = await edgeWorker.fetch(
  new Request(`https://cityscroll.org/agencies/${routeId}/`),
  env,
);
if (response.status !== 200) {
  console.error(`unexpected status ${response.status} for ${routeId}`);
  process.exit(1);
}
process.stdout.write(await response.text());
