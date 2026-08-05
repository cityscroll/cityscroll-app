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
import vendorFootprintCoverage from "./data/vendor_footprint_coverage.json" with { type: "json" };
import {
  CROSS_DOMAIN_OBJECT_LINK_VERSION,
  lookupEntityIntelligence,
  resolveRootQuery,
} from "../../entity_resolution/cross_domain/index.mjs";
import { vendorCoverageKey } from "../../entity_resolution/cross_domain/vendor_coverage_key.mjs";

const CACHE = "public, max-age=300";

function json(body, status = 200, cache) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    // Public read model — same open CORS posture as entity-dossier.
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
  if (cache) headers["Cache-Control"] = cache;
  else if (status !== 200) headers["Cache-Control"] = "no-store";
  return new Response(JSON.stringify(body), { status, headers });
}

export function attachVendorFootprint(
  view,
  root,
  source = materialization,
  coverageIndex = vendorFootprintCoverage,
) {
  if (root?.kind !== "vendor") return view;
  const footprint = source?.vendor_footprint;
  if (!footprint) return view;
  const coverageKey = vendorCoverageKey(root.ref);
  const packed = (coverageIndex?.rows || []).find((row) =>
    String(row).startsWith(`${coverageKey}|`));
  const [, linkedRaw, eligibleRaw, rateRaw] = packed ? String(packed).split("|") : [];
  const linked = Number(linkedRaw);
  const eligible = Number(eligibleRaw);
  const rate = rateRaw === "" || rateRaw == null ? null : Number(rateRaw);
  const pct = Number.isFinite(rate)
    ? (() => {
        const value = Math.round(rate * 1_000) / 10;
        return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}%`;
      })()
    : null;
  const awardCoverage = packed ? {
    linked,
    eligible,
    rate,
    label: `showing ${linked} of ${eligible} known awards linked so far (${pct})`,
  } : {
    linked: 0,
    eligible: 0,
    rate: null,
    label: "coverage not measured for awards",
  };
  return {
    ...view,
    vendor_footprint: {
      schema_version: footprint.schema_version,
      status: footprint.status,
      qualifier_required: footprint.qualifier_required,
      sections: footprint.sections,
      excluded_confidence: footprint.excluded_confidence,
      award_coverage: awardCoverage,
      promotion: footprint.promotion,
      provenance: footprint.provenance,
    },
  };
}

export async function handleEntityIntelligence(req, env, ctx) {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }
  if (req.method !== "GET") return json({ ok: false, reason: "method" }, 405);

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
      CACHE,
    );
  }

  if (demo) {
    const ref = materialization.verified_demo?.ref || materialization.demo_refs?.[0];
    if (!ref) {
      return json(
        { ok: false, reason: "no_demo", version: CROSS_DOMAIN_OBJECT_LINK_VERSION },
        404,
      );
    }
    const view = lookupEntityIntelligence(materialization, { ref });
    return json(
      { ...view, demo: true, materialization_meta: materialization.verified_demo },
      200,
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
    );
  }

  const resolvedRoot = resolveRootQuery(query);
  const view = lookupEntityIntelligence(materialization, query);
  return json(attachVendorFootprint(view, resolvedRoot), 200, CACHE);
}

export function getEntityIntelligenceMaterialization() {
  return materialization;
}
