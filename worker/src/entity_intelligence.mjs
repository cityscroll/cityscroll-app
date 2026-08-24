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

import vendorFootprintCoverage from "./data/vendor_footprint_coverage.json" with { type: "json" };
import passportGraph from "./data/passport_ei_graph.json" with { type: "json" };
import {
  CROSS_DOMAIN_OBJECT_LINK_VERSION,
  lookupEntityIntelligence,
  resolveRootQuery,
} from "../../entity_resolution/cross_domain/index.mjs";
import { vendorCoverageKey } from "../../entity_resolution/cross_domain/vendor_coverage_key.mjs";
import {
  loadEntityIntelligenceMeta,
  lookupEntityIntelligenceFromD1,
} from "./lib/entity_intelligence_read_model.mjs";

const CACHE = "public, max-age=300";
const VENDOR_SECTION_SPECS = Object.freeze([
  { id: "awards", domain: "money", kind: "award" },
  // PASSPort Public + Checkbook Contracts corroboration (VI-02 procurement spine):
  // a distinct evidence kind from the award notice itself, never conflated with it.
  { id: "contracts", domain: "money", kind: "contract" },
  { id: "payments", domain: "money", kind: "payment" },
  { id: "land", domain: "land" },
  { id: "property", domain: "property" },
  { id: "rules", domain: "rules" },
  { id: "meetings", domain: "meetings" },
  { id: "franchise", domain: "franchise" },
]);
const DEFAULT_VENDOR_COVERAGE = new Map(
  (vendorFootprintCoverage?.rows || []).map((row) => {
    const value = String(row);
    return [value.split("|", 1)[0], value];
  }),
);

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
  source = null,
  coverageIndex = vendorFootprintCoverage,
) {
  if (root?.kind !== "vendor") return view;
  const footprint = source?.vendor_footprint;
  if (!footprint) return view;
  const coverageKey = vendorCoverageKey(root.ref);
  const packed = coverageIndex === vendorFootprintCoverage
    ? DEFAULT_VENDOR_COVERAGE.get(coverageKey)
    : (coverageIndex?.rows || []).find((row) => String(row).startsWith(`${coverageKey}|`));
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
  const sectionCounts = Object.fromEntries(VENDOR_SECTION_SPECS.map((section) => {
    const objects = (view?.domains?.[section.domain]?.objects || [])
      .filter((object) => !section.kind || object?.object_kind === section.kind);
    const uniqueCount = (rows) => new Set(rows.map((object) =>
      String(object?.request_id || object?.subject_ref || object?.href || object?.label || ""),
    ).filter(Boolean)).size;
    let confirmedCount = uniqueCount(objects.filter((object) => object?.confidence === "strong"));
    let mentionCount = uniqueCount(objects.filter((object) =>
      object?.confidence === "strong" || object?.confidence === "tentative"));
    if (section.id === "awards") {
      confirmedCount = Number.isFinite(awardCoverage.linked) ? awardCoverage.linked : confirmedCount;
      mentionCount = Number.isFinite(awardCoverage.eligible) ? awardCoverage.eligible : mentionCount;
    }
    if (section.id === "contracts") {
      const stem = String(root?.stem || "").trim()
        || String(root?.ref || "").replace(/^vendor:stem:/, "");
      const decodedStem = (() => {
        try {
          return decodeURIComponent(stem);
        } catch {
          return stem;
        }
      })();
      const graphRow = passportGraph?.by_vendor?.[decodedStem]
        || passportGraph?.by_vendor?.[stem]
        || null;
      const graphCount = Number(graphRow?.selected_rows);
      if (Number.isInteger(graphCount) && graphCount > 0) {
        confirmedCount = graphCount;
        mentionCount = Math.max(mentionCount, graphCount);
      }
    }
    return [section.id, {
      confirmed_count: confirmedCount,
      mention_count: Math.max(confirmedCount, mentionCount),
      scope_count: Math.max(confirmedCount, mentionCount),
    }];
  }));
  return {
    ...view,
    vendor_footprint: {
      schema_version: footprint.schema_version,
      status: footprint.status,
      qualifier_required: footprint.qualifier_required,
      sections: footprint.sections,
      excluded_confidence: footprint.excluded_confidence,
      award_coverage: awardCoverage,
      section_counts: sectionCounts,
      census: footprint.census,
      promotion: footprint.promotion,
      provenance: footprint.provenance,
    },
  };
}

/** Daily vendor-profile read model assembled from keyed D1 lookups. */
export async function precomputedVendorFootprint(stem, displayName = stem, db = null) {
  const value = String(stem || "").trim();
  if (!value) return null;
  const ref = `vendor:stem:${encodeURIComponent(value)}`;
  const query = { ref, name: displayName };
  const view = db
    ? await lookupEntityIntelligenceFromD1(db, query)
    : lookupEntityIntelligence({ by_ref: {} }, query);
  const meta = db ? await loadEntityIntelligenceMeta(db) : null;
  return attachVendorFootprint(view, view.root, meta);
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
  const db = env?.DB || null;
  const meta = await loadEntityIntelligenceMeta(db);

  if (list) {
    if (!meta) {
      return json(
        {
          ok: true,
          version: CROSS_DOMAIN_OBJECT_LINK_VERSION,
          serve: "unavailable",
          entity_count: null,
          multi_domain_count: null,
          domains: [],
          demo_refs: [],
          verified_demo: null,
          entities: [],
          provenance: null,
        },
        200,
        "no-store",
      );
    }
    return json(
      {
        ok: true,
        version: CROSS_DOMAIN_OBJECT_LINK_VERSION,
        serve: "materialization",
        entity_count: meta.entity_count,
        multi_domain_count: meta.multi_domain_count,
        domains: meta.domains,
        demo_refs: meta.demo_refs,
        verified_demo: meta.verified_demo,
        entities: meta.entity_index || [],
        provenance: meta.provenance,
      },
      200,
      CACHE,
    );
  }

  if (demo) {
    const ref = meta?.verified_demo?.ref || meta?.demo_refs?.[0];
    if (!ref) {
      return json(
        { ok: false, reason: "no_demo", version: CROSS_DOMAIN_OBJECT_LINK_VERSION },
        404,
      );
    }
    const view = await lookupEntityIntelligenceFromD1(db, { ref });
    return json(
      { ...view, demo: true, materialization_meta: meta?.verified_demo || view.materialization_meta },
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
  const view = await lookupEntityIntelligenceFromD1(db, query);
  return json(attachVendorFootprint(view, resolvedRoot, meta), 200, CACHE);
}
