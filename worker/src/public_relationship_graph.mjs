// Public, read-only procurement relationship graph over linked source records.
// Every connection has an allowlisted type, public evidence, and a disclosed
// confidence state. The route does not expose matcher internals or desk data.

import {
  PUBLIC_GRAPH_DEFAULT_DEPTH,
  PUBLIC_GRAPH_DEFAULT_FAN_OUT,
  PUBLIC_GRAPH_EDGE_TYPES,
  PUBLIC_GRAPH_MAX_DEPTH,
  PUBLIC_GRAPH_MAX_FAN_OUT,
  PUBLIC_GRAPH_NODE_TYPES,
  PUBLIC_RELATIONSHIP_GRAPH_VERSION,
  serializePublicRelationshipGraph,
} from "../../entity_resolution/publication/relationship_graph.mjs";
import crosswalk from "./data/agency_crosswalk.json" with { type: "json" };
import { enrichAgency } from "./lib/agency_identity.mjs";

const GRAPH_CACHE = "public, max-age=300";
export const GRAPH_RECORD_LIMIT = 250;

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  }[char]));
}

/** Public-facing status when no canonical entity graph is published for this id. */
export const GRAPH_NOT_YET_PUBLIC = {
  error: "not-found",
  public_status: "not_yet_public",
  message:
    "No public relationship graph is available for this id. Subject-registry links on notice lifecycles are live; this graph surface only returns typed edges for canonical entity ids published from the resolution store. Do not treat name-shaped or contract ids as live graph keys until a resolved entity returns linked records.",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": status === 200 ? GRAPH_CACHE : "no-store",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function notYetPublicResponse(request) {
  const url = new URL(request.url);
  const wantsJson = url.searchParams.get("format") === "json"
    || (request.headers.get("accept") || "").includes("application/json");
  if (wantsJson || !request.headers.get("accept")?.includes("text/html")) {
    return json(GRAPH_NOT_YET_PUBLIC, 404);
  }
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Relationship graph not yet public · CityScroll</title>
    <style>body{margin:0;background:#f7f2e8;color:#17202a;font:16px/1.5 system-ui,sans-serif}main{width:min(720px,calc(100% - 32px));margin:48px auto}h1{font:700 2rem Georgia,serif}.note{color:#5e6a73;max-width:60ch}</style>
    </head><body><main>
      <p style="text-transform:uppercase;letter-spacing:.1em;font-size:.72rem;font-weight:800;color:#9c3f32">CityScroll · not yet public</p>
      <h1>Relationship graph not yet public</h1>
      <p class="note">${escapeHtml(GRAPH_NOT_YET_PUBLIC.message)}</p>
      <p class="note">Subject-registry fields on contract lifecycles remain the live cross-spine identifiers.</p>
    </main></body></html>`;
  return new Response(html, {
    status: 404,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function positiveInteger(value, fallback) {
  if (value === null || value === "") return fallback;
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function requestedTypes(url, parameter, allowlist) {
  const requested = url.searchParams.getAll(parameter).map(clean).filter(Boolean);
  const unsupported = requested.find((value) => !allowlist.includes(value));
  return { requested, unsupported };
}

function humanType(value) {
  return clean(value).replace(/_/g, " ").replace(/^./, (letter) => letter.toUpperCase());
}

function observedTime(value) {
  const text = clean(value);
  const date = new Date(text);
  if (!text || Number.isNaN(date.valueOf())) return text;
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date) + " UTC";
}

function sourceLink(provenance = {}) {
  const source = provenance.source || {};
  const label = `${clean(source.system)} · ${clean(source.id)}`;
  return source.url
    ? `<a href="${escapeHtml(source.url)}" rel="noopener">${escapeHtml(label)}</a>`
    : escapeHtml(label);
}

export function renderPublicRelationshipGraphPage(graph) {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const paths = graph.edges.map((edge) => {
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    return `<article class="path" data-edge-type="${escapeHtml(edge.type)}">
      <div class="node"><span>${escapeHtml(humanType(from?.type))}</span><strong>${escapeHtml(from?.name || edge.from)}</strong></div>
      <div class="connection"><span aria-hidden="true">→</span><strong>${escapeHtml(edge.label)}</strong><small>${escapeHtml(humanType(edge.confidence.status))}</small></div>
      <div class="node"><span>${escapeHtml(humanType(to?.type))}</span><strong>${escapeHtml(to?.name || edge.to)}</strong></div>
      <p class="evidence">Evidence: ${sourceLink(edge.provenance)} · fields ${edge.provenance.source_fields.map(escapeHtml).join(", ")} · observed <time datetime="${escapeHtml(edge.provenance.observed_at)}">${escapeHtml(observedTime(edge.provenance.observed_at))}</time></p>
    </article>`;
  }).join("");

  const rows = graph.edges.map((edge) => {
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    return `<tr>
      <td><span class="kind">${escapeHtml(humanType(from?.type))}</span>${escapeHtml(from?.name || edge.from)}</td>
      <td><strong>${escapeHtml(edge.label)}</strong><code>${escapeHtml(edge.type)}</code></td>
      <td><span class="kind">${escapeHtml(humanType(to?.type))}</span>${escapeHtml(to?.name || edge.to)}</td>
      <td>${sourceLink(edge.provenance)}<small>${escapeHtml(observedTime(edge.provenance.observed_at))}</small></td>
      <td>${escapeHtml(humanType(edge.confidence.status))}<small>${escapeHtml(humanType(edge.confidence.basis))}</small></td>
    </tr>`;
  }).join("");
  const boundary = graph.bounds.truncated
    ? `<p class="boundary"><strong>Boundary reached:</strong> ${escapeHtml(graph.bounds.boundary_reached.join(", "))}. ${escapeHtml(graph.bounds.note)}</p>`
    : `<p class="boundary calm">${escapeHtml(graph.bounds.note)}</p>`;
  const dossierUrl = `/entity-dossier?id=${encodeURIComponent(graph.root.id)}`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(graph.root.name)} · Relationship graph · CityScroll</title>
    <style>
      :root{--paper:#f7f2e8;--card:#ffffff;--ink:#17202a;--muted:#5e6a73;--line:#d7cdbd;--accent:#9c3f32;--blue:#295d76;--blue-soft:#e7f0f2;--warn:#8a4b11;--warn-soft:#fff1df}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}a{color:var(--blue);overflow-wrap:anywhere}main{width:min(1180px,calc(100% - 32px));margin:0 auto;padding:48px 0 72px}.eyebrow,.kind{text-transform:uppercase;letter-spacing:.1em;font-size:.7rem;font-weight:800;color:var(--accent)}h1{font:700 clamp(2rem,5vw,4.5rem)/.98 Georgia,serif;max-width:16ch;margin:.25rem 0 1rem}.lede{max-width:72ch;color:var(--muted);font-size:1.05rem}.meta{display:flex;gap:10px;flex-wrap:wrap;margin:22px 0}.meta span{background:var(--card);border:1px solid var(--line);border-radius:999px;padding:7px 11px;font-size:.82rem}.boundary{border:1px solid #d39355;background:var(--warn-soft);color:var(--warn);border-radius:12px;padding:12px 14px}.boundary.calm{border-color:var(--line);background:var(--card);color:var(--muted)}h2{font:700 1.55rem Georgia,serif;margin:36px 0 6px}.section-intro{color:var(--muted);max-width:74ch}.paths{display:grid;gap:12px;margin-top:18px}.path{display:grid;grid-template-columns:minmax(0,1fr) minmax(150px,.55fr) minmax(0,1fr);align-items:center;gap:12px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;min-width:0}.node{min-width:0;border:1px solid var(--line);border-radius:10px;padding:11px;background:#fff}.node span{display:block;color:var(--accent);font-size:.68rem;text-transform:uppercase;letter-spacing:.09em;font-weight:800}.node strong{display:block;overflow-wrap:anywhere}.connection{text-align:center;color:var(--blue);min-width:0}.connection span,.connection strong,.connection small{display:block}.connection span{font-size:1.5rem;line-height:1}.connection strong{overflow-wrap:anywhere}.connection small{color:var(--muted)}.evidence{grid-column:1/-1;border-top:1px solid var(--line);margin:2px 0 0;padding-top:10px;color:var(--muted);font-size:.82rem;overflow-wrap:anywhere}.table-wrap{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:14px;margin-top:16px}table{border-collapse:collapse;width:100%;min-width:850px;text-align:left}th,td{padding:12px;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:.72rem;text-transform:uppercase;letter-spacing:.07em;color:var(--muted)}td .kind,td code,td small{display:block}td code{font-size:.72rem;color:var(--muted);overflow-wrap:anywhere}td small{color:var(--muted);margin-top:3px}footer{margin-top:28px;color:var(--muted);font-size:.86rem}
      @media(max-width:760px){main{padding-top:28px}.path{grid-template-columns:1fr}.connection{text-align:left;display:grid;grid-template-columns:auto 1fr;gap:0 8px}.connection span{grid-row:1/3}.evidence{grid-column:1}.table-wrap{border-radius:10px}}
    </style></head><body><main>
      <header><p class="eyebrow">CityScroll · bounded public relationship graph</p><h1>${escapeHtml(graph.root.name)}</h1><p class="lede">Every connection below is typed, limited to published procurement records, and paired with source evidence. Position on this page does not imply any relationship beyond the displayed label.</p><div class="meta"><span>${graph.nodes.length} typed nodes</span><span>${graph.edges.length} evidence-bearing edges</span><span>Depth ${graph.bounds.applied_depth} of ${graph.bounds.max_depth}</span><span>Fan-out ${graph.bounds.applied_fan_out} of ${graph.bounds.max_fan_out}</span></div>${boundary}<p><a href="${escapeHtml(dossierUrl)}">View the source assertion dossier</a></p></header>
      <section aria-labelledby="paths-title"><h2 id="paths-title">Typed paths</h2><p class="section-intro">Arrows are always accompanied by the relationship name. Confidence is disclosed without publishing internal matcher scores.</p><div class="paths">${paths || "<p>No allowlisted relationships were observed in the linked records.</p>"}</div></section>
      <section aria-labelledby="evidence-title"><h2 id="evidence-title">Relationship evidence</h2><p class="section-intro">Accessible table view of the same graph. Source fields identify which publisher columns support each relationship.</p><div class="table-wrap"><table><thead><tr><th scope="col">From</th><th scope="col">Relationship type</th><th scope="col">To</th><th scope="col">Public evidence</th><th scope="col">Confidence</th></tr></thead><tbody>${rows || '<tr><td colspan="5">No allowlisted relationships observed.</td></tr>'}</tbody></table></div></section>
      <footer>Graph contract ${escapeHtml(graph.version)} · ${escapeHtml(graph.bounds.note)}</footer>
    </main></body></html>`;
}

export async function readPublicRelationshipGraph(db, canonicalEntityId, opts = {}) {
  if (!db) return null;
  const entityId = clean(canonicalEntityId);
  if (!entityId || entityId.length > 300) return null;
  const result = await db.prepare(
    `SELECT entity.id AS entity_id, entity.entity_type, entity.display_name,
            record.source_system, record.source_system_id,
            record.raw_snapshot, record.ingested_at
       FROM canonical_entity AS entity
       LEFT JOIN (
         SELECT DISTINCT canonical_entity_id, source_record_id
           FROM entity_link
          WHERE decision = 'auto_link'
       ) AS link
         ON link.canonical_entity_id = entity.id
       LEFT JOIN source_records AS record
         ON link.source_record_id = (
           record.source_system || ':' || record.source_system_id || ':' || record.content_hash
         )
      WHERE entity.id = ?
      ORDER BY record.ingested_at DESC, record.source_system ASC, record.source_system_id ASC
      LIMIT ?`,
  ).bind(entityId, GRAPH_RECORD_LIMIT).all();
  const crossSpineEdges = [];
  const rows = (result?.results || []).map((row) => {
    const raw = (() => {
      try { return JSON.parse(row.raw_snapshot || "{}"); } catch { return {}; }
    })();
    const identity = enrichAgency(crosswalk.entries, raw.agency_name || raw.agency || "");
    const enriched = identity?.head_name
      ? { ...raw, agency_head_name: identity.head_name, agency_head_title: identity.head_title }
      : raw;
    if (Array.isArray(enriched.cross_spine_edges)) crossSpineEdges.push(...enriched.cross_spine_edges);
    return { ...row, raw_snapshot: JSON.stringify(enriched) };
  });
  return serializePublicRelationshipGraph(rows, { ...opts, crossSpineEdges });
}

export async function handlePublicRelationshipGraph(request, env) {
  if (request.method !== "GET") return json({ error: "method-not-allowed" }, 405);
  if (!env?.DB) return json({ error: "no-store" }, 503);
  const url = new URL(request.url);
  const entityId = clean(url.searchParams.get("id"));
  if (!entityId || entityId.length > 300) return json({ error: "id-required" }, 400);

  const depth = positiveInteger(url.searchParams.get("depth"), PUBLIC_GRAPH_DEFAULT_DEPTH);
  const fanOut = positiveInteger(url.searchParams.get("fan_out"), PUBLIC_GRAPH_DEFAULT_FAN_OUT);
  if (depth === null) return json({ error: "invalid-depth", max: PUBLIC_GRAPH_MAX_DEPTH }, 400);
  if (fanOut === null) return json({ error: "invalid-fan-out", max: PUBLIC_GRAPH_MAX_FAN_OUT }, 400);
  const nodeTypes = requestedTypes(url, "node_type", PUBLIC_GRAPH_NODE_TYPES);
  if (nodeTypes.unsupported) {
    return json({
      error: "unsupported-node-type",
      requested: nodeTypes.unsupported,
      allowed: PUBLIC_GRAPH_NODE_TYPES,
    }, 400);
  }
  const edgeTypes = requestedTypes(url, "edge_type", PUBLIC_GRAPH_EDGE_TYPES);
  if (edgeTypes.unsupported) {
    return json({
      error: "unsupported-edge-type",
      requested: edgeTypes.unsupported,
      allowed: PUBLIC_GRAPH_EDGE_TYPES,
    }, 400);
  }

  let graph;
  try {
    graph = await readPublicRelationshipGraph(env.DB, entityId, {
      depth,
      fanOut,
      nodeTypes: nodeTypes.requested,
      edgeTypes: edgeTypes.requested,
    });
  } catch {
    return json({ error: "relationship-graph-unavailable" }, 503);
  }
  if (!graph) return notYetPublicResponse(request);
  if (url.searchParams.get("format") === "json"
      || (request.headers.get("accept") || "").includes("application/json")) {
    return json(graph);
  }
  return new Response(renderPublicRelationshipGraphPage(graph), {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": GRAPH_CACHE,
    },
  });
}

export {
  PUBLIC_GRAPH_EDGE_TYPES,
  PUBLIC_GRAPH_MAX_DEPTH,
  PUBLIC_GRAPH_MAX_FAN_OUT,
  PUBLIC_GRAPH_NODE_TYPES,
  PUBLIC_RELATIONSHIP_GRAPH_VERSION,
};
