// GET /source-health — strict public source-health projection only.

import publicProjection from "../../site/data/source_health_public.json" with { type: "json" };
import {
  PUBLIC_SOURCE_HEALTH_SCHEMA,
  validatePublicSourceHealthProjection,
} from "../../site/source_health_public_projection.mjs";

export function unavailablePublicSourceHealth() {
  return {
    schema: PUBLIC_SOURCE_HEALTH_SCHEMA,
    generated_at: null,
    available: false,
    source_count: null,
    sources: null,
  };
}

function responseBody(projection) {
  if (!projection || validatePublicSourceHealthProjection(projection).length) {
    return unavailablePublicSourceHealth();
  }
  return projection;
}

export async function handleSourceHealth(request, options = {}) {
  if (request.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }
  const projection = Object.hasOwn(options, "projection")
    ? options.projection
    : publicProjection;
  return new Response(JSON.stringify(responseBody(projection), null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=900",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
