/**
 * GET /entity-intelligence — cross-domain entity intelligence surface.
 *
 * Serves the prebuilt materialization (warehouse fixtures + domain seeds) for
 * agencies and vendors: linked objects across money / land / rules / meetings /
 * people with provenance on every edge. Additive, read-only.
 *
 * Query:
 *   ?kind=agency&name=Department%20of%20Parks%20and%20Recreation
 *   ?kind=agency&id=parks-and-recreation
 *   ?kind=vendor&name=Make%20it%20Zesty%20LLC
 *   ?ref=agency:id:parks-and-recreation
 *   ?list=1  — compact multi-domain index
 *   ?demo=1  — verified multi-domain demo entity
 */

import materialization from "./data/entity_intelligence_lookup.json" with { type: "json" };
import {
  CROSS_DOMAIN_OBJECT_LINK_VERSION,
  lookupEntityIntelligence,
  resolveRootQuery,
} from "../../entity_resolution/cross_domain/index.mjs";

const CACHE = "public, max-age=300";

const ALLOW = new Set([
  "https://cityscroll.org",
  "https://www.cityscroll.org",
  "https://crol-list.org",
  "https://www.crol-list.org",
  "https://cityscroll.pages.dev",
  "https://crol-list.jimdc.com",
  "https://jimdc.github.io",
  "http://localhost:8000",
  "http://localhost:8787",
]);

function corsHeaders(origin) {
  const o = ALLOW.has(origin) ? origin : "https://cityscroll.org";
  return {
    "Access-Control-Allow-Origin": o,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

function json(body, status, cors, cache) {
  const headers = { ...cors, "Content-Type": "application/json; charset=utf-8" };
  if (cache) headers["Cache-Control"] = cache;
  return new Response(JSON.stringify(body), { status, headers });
}

export async function handleEntityIntelligence(req, env, ctx) {
  const cors = corsHeaders(req.headers.get("origin") || "");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "GET") return json({ ok: false, reason: "method" }, 405, cors);

  const url = new URL(req.url);
  const list = url.searchParams.get("list") === "1";
  const demo = url.searchParams.get("demo") === "1";

  if (list) {
    return json(
      {
        ok: true,
        version: CROSS_DOMAIN_OBJECT_LINK_VERSION,
        serve: "materialization",
        entity_count: materialization.entity_count,
        multi_domain_count: materialization.multi_domain_count,
        domains: materialization.domains,
        demo_refs: materialization.demo_refs,
        verified_demo: materialization.verified_demo,
        entities: materialization.entity_index || [],
        provenance: materialization.provenance,
      },
      200,
      cors,
      CACHE,
    );
  }

  if (demo) {
    const ref = materialization.verified_demo?.ref || materialization.demo_refs?.[0];
    if (!ref) {
      return json(
        { ok: false, reason: "no_demo", version: CROSS_DOMAIN_OBJECT_LINK_VERSION },
        404,
        cors,
      );
    }
    const view = lookupEntityIntelligence(materialization, { ref });
    return json(
      { ...view, demo: true, materialization_meta: materialization.verified_demo },
      200,
      cors,
      CACHE,
    );
  }

  const kind = url.searchParams.get("kind") || "";
  const name = url.searchParams.get("name") || "";
  const id = url.searchParams.get("id") || "";
  const ref = url.searchParams.get("ref") || "";

  if (!ref && !kind && !name && !id) {
    return json(
      {
        ok: false,
        reason: "missing-query",
        hint: "Pass kind+name, kind+id, ref=, list=1, or demo=1",
        version: CROSS_DOMAIN_OBJECT_LINK_VERSION,
      },
      400,
      cors,
    );
  }

  const query = ref ? { ref } : { kind, name: name || undefined, id: id || undefined };
  // Validate root resolves before lookup (clearer 400 vs empty miss)
  if (!resolveRootQuery(query)) {
    return json(
      {
        ok: false,
        reason: "unresolved_root",
        version: CROSS_DOMAIN_OBJECT_LINK_VERSION,
      },
      400,
      cors,
    );
  }

  const view = lookupEntityIntelligence(materialization, query);
  return json(view, 200, cors, CACHE);
}

export function getEntityIntelligenceMaterialization() {
  return materialization;
}
