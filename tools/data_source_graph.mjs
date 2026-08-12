#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const DEFAULT_OUTPUT_DIR = "docs";
export const JSON_OUTPUT = "data-source-graph.json";
export const HTML_OUTPUT = "data-source-graph.html";

const CORE_INPUTS = [
  "docs/data-sources.md",
  "site/data/source_contracts.json",
  "site/data/gap_taxonomy.json",
  "warehouse/datasets.v0.json",
  "worker/wrangler.toml",
  "worker/src/worker.mjs",
  "worker/src/external_award.mjs",
];

const WORKER_JOBS = {
  "city-record": "ingestNotices",
  "nycida-build-nyc-projects": "prewarmSubsidyLifecycle",
  "checkbook-contracts": "prewarmContractLifecycle",
  "checkbook-spending": "prewarmContractLifecycle",
  "ocp-recent-contract-awards": "prewarmContractLifecycle",
  "ocp-current-solicitations": "prewarmContractLifecycle",
  "nyc-rules-rss": "refreshRules",
  "nyc-council-legistar": "refreshMeetingOutcomes",
  "passport-public-contracts": "ingestPassportPublic",
  "passport-public-rfx": "ingestPassportPublic",
  "doing-business-entities": "refreshVendorProfiles",
  "zap-api-outcomes": "refreshZapOutcomes",
};

const SURFACE_RULES = [
  ["Notices & search", /notice|core|feed|attachment|aggregate/i],
  ["Alerts", /alert|subscription|watch/i],
  ["Money", /procurement|contract|award|solicitation|payment|vendor|rfp|subsidy|follow-the-dollars|follow the dollars/i],
  ["Land", /land|zoning|zap|rezoning|ulurp|tax-lot|mappluto|community.?district|council.?district|district boundar/i],
  ["Property", /property|parcel|bbl|demolition|tax-lien/i],
  ["Rules", /rule|comment|adoption|effective date/i],
  ["Meetings", /meeting|agenda|vote|hearing|legistar|roll-?call/i],
  // Officials is distinct from Meetings: person hub, influence edges, and person-level votes.
  ["Officials", /official|person hub|person.?id|lobby|campaign finance|influence|votes_on|council member/i],
  ["Staffing", /staff|payroll|civil-service|exam|title and pay|hiring/i],
  ["Agency profiles", /agency|governance|leadership|budget|successor|former.?name/i],
];

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function readJson(path) {
  return JSON.parse(readFileSync(join(ROOT, path), "utf8"));
}

function walkJsonFiles(dir) {
  const absolute = join(ROOT, dir);
  if (!existsSync(absolute)) return [];
  const out = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const child = join(absolute, entry.name);
    if (entry.isDirectory()) out.push(...walkJsonFiles(relative(ROOT, child)));
    else if (entry.isFile() && entry.name.endsWith(".json")) out.push(relative(ROOT, child));
  }
  return out;
}

export function declaredInputPaths() {
  const receipts = [
    ...walkJsonFiles("warehouse/receipts/proof"),
    ...walkJsonFiles("site/data").filter((path) => path.includes("/verification_receipts/")),
  ];
  return [...new Set([...CORE_INPUTS, ...receipts])].sort();
}

export function inputManifest(paths = declaredInputPaths()) {
  return paths.map((path) => {
    const text = readFileSync(join(ROOT, path), "utf8");
    return { path, sha256: sha256(text) };
  });
}

function cronSettings(wranglerText) {
  const match = wranglerText.match(/crons\s*=\s*\[([^\]]+)\]/);
  const expressions = match ? [...match[1].matchAll(/["']([^"']+)["']/g)].map((m) => m[1]) : [];
  // The 10:00 UTC trigger is a delivery-free digest rehearsal. Source refreshes
  // that feed product read models remain on the production 13:00 UTC trigger.
  const primary = expressions.includes("0 13 * * *") ? "0 13 * * *" : expressions[0] || "not configured";
  return {
    expressions,
    daily_label: primary === "0 13 * * *"
      ? "Daily at 13:00 UTC (0 13 * * *)"
      : `Scheduled by Worker cron (${primary})`,
  };
}

function weeklyGate(externalAwardText) {
  const match = externalAwardText.match(/ABO_REFRESH_DAYS\s*=\s*(\d+)/);
  return match ? Number(match[1]) : null;
}

function dateCandidates(value, out = []) {
  if (Array.isArray(value)) {
    for (const item of value) dateCandidates(item, out);
    return out;
  }
  if (!value || typeof value !== "object") return out;
  const keys = [
    "finished_at", "observed_at", "observed_at_utc", "generated_at", "verified_at_utc",
    "verified_at", "measured_at", "captured_at", "started_at", "observed_on", "snapshot_date",
  ];
  for (const key of keys) {
    const raw = value[key];
    if (typeof raw === "string" && Number.isFinite(Date.parse(raw))) out.push(raw);
  }
  for (const child of Object.values(value)) dateCandidates(child, out);
  return out;
}

function receiptEvidence(contracts, receiptPaths) {
  const result = new Map(contracts.map((contract) => [contract.id, []]));
  for (const path of receiptPaths) {
    let payload;
    try { payload = readJson(path); } catch { continue; }
    const dates = dateCandidates(payload).sort((a, b) => Date.parse(b) - Date.parse(a));
    if (!dates.length) continue;
    for (const contract of contracts) {
      const identifiers = new Set([contract.id, contract.dataset_id].filter(Boolean).map((value) => String(value).toLowerCase()));
      const declared = [
        payload.source_contract_id,
        payload.dataset_id,
        payload.socrata_dataset_id,
        payload.source_id,
        ...(Array.isArray(payload.source_contracts) ? payload.source_contracts : []),
      ].filter(Boolean).map((value) => String(value).toLowerCase());
      const filename = path.split("/").at(-1).toLowerCase();
      const explicit = declared.some((value) => identifiers.has(value));
      const namedReceipt = [...identifiers].some((value) => filename.includes(value.replaceAll("-", "_")) || filename.includes(value));
      if (explicit || namedReceipt) {
        result.get(contract.id).push({
          at: dates[0],
          path,
          kind: path.startsWith("warehouse/receipts/proof/") && explicit ? "successful-pull" : "source-evidence",
        });
      }
    }
  }
  for (const values of result.values()) values.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return result;
}

function endpointFor(contract) {
  const target = contract.endpoint || contract.landing_page || contract.domain || "";
  const identity = contract.dataset_id
    ? `${contract.dataset_id} · ${contract.kind || "dataset"}`
    : contract.endpoint
      ? contract.endpoint.replace(/^https?:\/\//, "")
      : contract.kind || "published endpoint";
  return { identity, url: target };
}

function surfacesFor(contract) {
  const text = `${contract.name} ${contract.used_for || ""}`;
  const matches = SURFACE_RULES.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
  return matches.length ? matches : [contract.status === "disabled" ? "Gap register" : "Source register"];
}

function coverageFor(contract) {
  const measurement = contract.join_measurement;
  if (measurement && typeof measurement === "object") {
    if (measurement.realized?.verdict) return measurement.realized.verdict;
    if (typeof measurement.verdict === "string" && measurement.verdict.trim()) {
      return measurement.verdict.trim();
    }
  }
  if (contract.gap) return contract.gap;
  const required = Array.isArray(contract.required_fields) ? contract.required_fields.length : 0;
  return required
    ? `Contract verifier checks ${required} required field${required === 1 ? "" : "s"}.`
    : "No separate join-coverage measurement is recorded.";
}

function deriveIngest(contract, context) {
  const warehouse = context.warehouse.datasets?.[contract.id];
  if (contract.status === "disabled") {
    return {
      job: "No ingest — source contract retained for gap tracking",
      cadence: "Disabled; no scheduled product pull",
      transform: "Measurement and source-shape verification only",
      evidence: ["site/data/source_contracts.json"],
    };
  }
  if (contract.id.startsWith("abo-")) {
    const days = context.weeklyDays || 7;
    return {
      job: "refreshAboAwards",
      cadence: `Every ${days} days, gated inside ${context.cron.daily_label}`,
      transform: "Normalize recent authority awards → KV source cache",
      evidence: ["worker/src/external_award.mjs", "worker/wrangler.toml"],
    };
  }
  const workerJob = WORKER_JOBS[contract.id];
  if (workerJob) {
    const found = context.workerText.includes(workerJob);
    return {
      job: workerJob,
      cadence: context.cron.daily_label + (contract.id.includes("checkbook") || contract.id.includes("ocp-") || contract.id.includes("nycida") ? " + on-demand fallback" : ""),
      transform: contract.delivery_tier === "edge-materialized"
        ? "Normalize and join → D1/KV read model"
        : "Refresh source mirror and derived read models",
      evidence: ["worker/src/worker.mjs", "worker/wrangler.toml", ...(found ? [] : ["job reference unresolved"])],
    };
  }
  if (warehouse) {
    return {
      job: `warehouse/scripts/ingest.py --dataset ${warehouse.id}`,
      cadence: "Operator-run warehouse snapshot; no automated cron declared",
      transform: `Socrata rows → parquet + DuckDB ${warehouse.table_name}`,
      evidence: ["warehouse/datasets.v0.json"],
    };
  }
  if (contract.status === "manual") {
    return {
      job: "Operator-reviewed source snapshot",
      cadence: "Manual review; no automated cron declared",
      transform: "Reviewed source → committed build artifact",
      evidence: ["site/data/source_contracts.json"],
    };
  }
  if (contract.scope === "build-time" || contract.status === "build-time") {
    return {
      job: "Source-specific build tool",
      cadence: "Operator build; no automated cron declared",
      transform: "Published dataset → committed JSON snapshot",
      evidence: (contract.code_references || []).map((ref) => ref.path),
    };
  }
  if (contract.delivery_tier === "live-only") {
    return {
      job: "Browser or Worker source adapter",
      cadence: "On demand; no scheduled ingest",
      transform: "Live query with bounded cache or request-time join",
      evidence: (contract.code_references || []).map((ref) => ref.path),
    };
  }
  return {
    job: "Source-specific edge adapter",
    cadence: context.cron.daily_label,
    transform: "Normalize → edge materialization",
    evidence: ["worker/src/worker.mjs", "worker/wrangler.toml"],
  };
}

function graphEdges(sources) {
  const edges = [];
  for (const source of sources) {
    const blocked = source.node_class === "blocked-source";
    edges.push({ from: `body:${source.body_id}`, to: `source:${source.id}`, kind: blocked ? "holds" : "publishes", visual_class: source.visual_class });
    edges.push({ from: `source:${source.id}`, to: `ingest:${source.id}`, kind: blocked ? "requires-access" : "pulls", visual_class: source.visual_class });
    for (const surface of source.surfaces) edges.push({ from: `ingest:${source.id}`, to: `surface:${surface}`, kind: blocked ? "would-serve" : "serves", visual_class: source.visual_class });
  }
  return edges;
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

const BLOCKED_SOURCE_STATUSES = new Set(["blocked", "application-possible", "declined"]);

function deriveBlockedSources(gapTaxonomy) {
  return (gapTaxonomy.partnership_blocked_sources || []).map((source) => {
    const requiredStrings = ["id", "wishlist_gap_id", "name", "data_offered", "collecting_body", "platform", "status", "status_note"];
    for (const field of requiredStrings) {
      if (typeof source[field] !== "string" || !source[field].trim()) throw new Error(`blocked source ${source.id || "<unknown>"} missing ${field}`);
    }
    if (!BLOCKED_SOURCE_STATUSES.has(source.status)) throw new Error(`blocked source ${source.id} has invalid status ${source.status}`);
    if (!Array.isArray(source.access_mechanisms) || !source.access_mechanisms.length) throw new Error(`blocked source ${source.id} has no access mechanisms`);
    if (source.access_mechanisms.filter((mechanism) => mechanism.preferred === true).length !== 1) {
      throw new Error(`blocked source ${source.id} must have exactly one preferred access mechanism`);
    }
    if (!Array.isArray(source.policy_citations) || !source.policy_citations.length) throw new Error(`blocked source ${source.id} has no policy citations`);
    const citationIds = new Set(source.policy_citations.map((citation) => citation.id));
    for (const mechanism of source.access_mechanisms) {
      if (!mechanism.id || !mechanism.type || !mechanism.label || !mechanism.requirement || typeof mechanism.preferred !== "boolean") {
        throw new Error(`blocked source ${source.id} has an incomplete access mechanism`);
      }
      for (const citationId of mechanism.citation_ids || []) {
        if (!citationIds.has(citationId)) throw new Error(`blocked source ${source.id} access mechanism ${mechanism.id} references missing citation ${citationId}`);
      }
    }
    for (const citation of source.policy_citations) {
      if (!citation.id || !citation.title || !citation.url || !citation.section || !/^\d{4}-\d{2}-\d{2}$/.test(citation.date || "")) {
        throw new Error(`blocked source ${source.id} has an incomplete dated policy citation`);
      }
    }
    if (!Array.isArray(source.surfaces) || !source.surfaces.length) throw new Error(`blocked source ${source.id} has no target surfaces`);
    const preferred = source.access_mechanisms.find((mechanism) => mechanism.preferred);
    return {
      id: source.id,
      name: source.name,
      node_class: "blocked-source",
      visual_class: "blocked",
      body: source.collecting_body,
      body_id: slug(source.collecting_body),
      status: source.status,
      delivery_tier: "access-gated",
      endpoint: { identity: source.platform, url: source.platform_url || "" },
      publisher_cadence: "Unknown until access is granted or publication begins",
      ingest: {
        job: `Access gate · ${preferred.label}`,
        cadence: "No ingest scheduled",
        transform: "If acquired: normalize authorized records into the named surfaces",
        evidence: ["site/data/gap_taxonomy.json"],
      },
      surfaces: [...source.surfaces],
      approach: source.status_note,
      coverage: source.data_offered,
      known_gap: source.status_note,
      wishlist: {
        label: `${source.wishlist_gap_id} in the lifecycle data wishlist`,
        href: "data-frontiers-2026-08.md",
      },
      last_successful_pull: null,
      latest_evidence: null,
      code_references: [],
      data_offered: source.data_offered,
      access_mechanisms: source.access_mechanisms,
      policy_citations: source.policy_citations,
    };
  });
}

export function buildDataSourceGraph({
  registry,
  gapTaxonomy = { sources: [] },
  warehouse = { datasets: {} },
  wranglerText = "",
  workerText = "",
  externalAwardText = "",
  receipts = new Map(),
  inputs = [],
} = {}) {
  const contracts = registry?.contracts || [];
  const cron = cronSettings(wranglerText);
  const gapSources = new Set((gapTaxonomy.sources || []).map((source) => source.source_contract_id).filter(Boolean));
  const context = { warehouse: warehouse.datasets ? warehouse : { datasets: warehouse }, cron, workerText, weeklyDays: weeklyGate(externalAwardText) };
  const liveSources = contracts.map((contract) => {
    const evidence = receipts.get(contract.id) || [];
    const endpoint = endpointFor(contract);
    const hasWishlist = Boolean(contract.gap || gapSources.has(contract.id));
    return {
      id: contract.id,
      name: contract.name,
      node_class: "source-contract",
      visual_class: "available",
      body: contract.owner,
      body_id: slug(contract.owner),
      status: contract.status,
      delivery_tier: contract.delivery_tier || "unspecified",
      endpoint,
      publisher_cadence: contract.publisher_cadence || "Not published",
      ingest: deriveIngest(contract, context),
      surfaces: surfacesFor(contract),
      approach: contract.product_freshness || "No product-freshness note is recorded.",
      coverage: coverageFor(contract),
      known_gap: contract.gap || null,
      wishlist: hasWishlist ? {
        label: `${contract.id} in the lifecycle data wishlist`,
        href: "gap-taxonomy.md#join-graph-sources",
      } : null,
      last_successful_pull: contract.status === "disabled" ? null : evidence.find((item) => item.kind === "successful-pull") || null,
      latest_evidence: evidence[0] || null,
      code_references: (contract.code_references || []).map((ref) => ref.path),
    };
  });
  const blockedSources = deriveBlockedSources(gapTaxonomy);
  const sources = [...liveSources, ...blockedSources].sort((a, b) => compareText(a.body, b.body) || compareText(a.name, b.name));
  const bodies = [...new Map(sources.map((source) => [source.body_id, { id: source.body_id, name: source.body }])).values()];
  const surfaces = [...new Set(sources.flatMap((source) => source.surfaces))].sort();
  const sourcesHash = sha256(inputs.map((input) => `${input.path}:${input.sha256}`).join("\n"));
  return {
    schema_version: 2,
    title: "CityScroll data-source topology",
    description: "Generated collecting-body → dataset → ingest → surface architecture for the authenticated desk.",
    sources_hash: sourcesHash,
    declared_inputs: inputs,
    cron: { expressions: cron.expressions },
    counts: { bodies: bodies.length, sources: sources.length, source_contracts: liveSources.length, blocked_sources: blockedSources.length, surfaces: surfaces.length },
    bodies,
    sources,
    surfaces,
    edges: graphEdges(sources),
  };
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function tableRows(graph) {
  return graph.sources.map((source) => `<tr data-source-row="${esc(source.id)}" data-search="${esc(`${source.name} ${source.body} ${source.endpoint.identity} ${(source.access_mechanisms || []).map((mechanism) => mechanism.label).join(" ")}`.toLowerCase())}" data-status="${esc(source.status)}" data-node-class="${esc(source.node_class)}">
    <td><button class="table-source" type="button" data-source="${esc(source.id)}">${esc(source.name)}</button><small>${esc(source.endpoint.identity)}</small></td>
    <td>${esc(source.body)}</td><td><span class="status status-${esc(source.status)}">${esc(source.status)}</span></td>
    <td>${esc(source.ingest.cadence)}</td><td>${esc(source.ingest.transform)}</td><td>${source.surfaces.map(esc).join(", ")}</td>
  </tr>`).join("\n");
}

export function renderGraphHtml(graph) {
  const payload = JSON.stringify(graph).replace(/<\/script/gi, "<\\/script");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CityScroll data-source topology</title>
<style>
:root{--ink:#18241d;--muted:#5d6d63;--paper:#f5f1e8;--panel:#fffdf8;--line:#ccd4cc;--green:#1f6a45;--mint:#dcecdf;--amber:#9d5b13;--red:#9f3a35;--blue:#315f78;--ghost:#775b85;--ghost-paper:#f7f1f8;--shadow:0 12px 32px rgba(24,36,29,.09)}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.45 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}button,input,select{font:inherit}button{cursor:pointer}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}.shell{max-width:1720px;margin:auto;padding:28px}.eyebrow{text-transform:uppercase;letter-spacing:.13em;font-size:11px;font-weight:800;color:var(--green)}h1{font:700 clamp(30px,4vw,52px)/1.03 Georgia,serif;margin:6px 0 10px;max-width:850px}.lede{color:var(--muted);max-width:820px;margin:0}.meta,.legend{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}.legend{margin-top:9px;color:var(--muted);font-size:12px}.legend span{display:inline-flex;gap:6px;align-items:center}.legend i{display:inline-block;width:22px;border-top:2px solid var(--green)}.legend .ghost-key{border-top:2px dashed var(--ghost)}.pill,.status{border:1px solid var(--line);border-radius:999px;padding:4px 9px;background:var(--panel);font-size:12px}.controls{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:24px 0 14px}.controls input{min-width:280px;flex:1}.controls input,.controls select,.toggle button{border:1px solid var(--line);background:var(--panel);border-radius:8px;padding:9px 11px;color:var(--ink)}.toggle{display:flex}.toggle button{border-radius:0}.toggle button:first-child{border-radius:8px 0 0 8px}.toggle button:last-child{border-radius:0 8px 8px 0}.toggle button[aria-pressed=true]{background:var(--ink);color:white}.workspace{display:grid;grid-template-columns:minmax(0,1fr) minmax(300px,370px);gap:16px;align-items:start}.canvas,.details,.table-wrap{background:var(--panel);border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow)}.canvas{overflow:auto;min-height:700px}.column-heads{display:grid;grid-template-columns:170px 245px 230px 170px;gap:35px;padding:14px 20px;border-bottom:1px solid var(--line);min-width:960px;position:sticky;top:0;background:rgba(255,253,248,.96);z-index:2}.column-heads b{font-size:11px;letter-spacing:.1em;text-transform:uppercase}.column-heads span{display:block;color:var(--muted);font-size:11px;margin-top:2px}svg{display:block;min-width:960px}.details{position:sticky;top:16px;padding:22px;min-height:430px}.details h2{font:700 26px/1.12 Georgia,serif;margin:6px 0 8px}.details h3{font-size:11px;text-transform:uppercase;letter-spacing:.09em;color:var(--green);margin:20px 0 5px}.details p{margin:0;color:#35443b}.details a{color:var(--blue);font-weight:650}.details .endpoint{overflow-wrap:anywhere}.details ol{padding-left:20px;margin:5px 0}.details li+li{margin-top:10px}.route-preferred{color:var(--ghost);font-weight:800}.empty-detail{color:var(--muted);padding-top:30px}.status-live{color:var(--green);border-color:#9bc0a5}.status-build-time,.status-manual{color:var(--amber);border-color:#d9b989}.status-disabled{color:var(--red);border-color:#daa5a1}.status-application-possible,.status-blocked,.status-declined{color:var(--ghost);border-color:#baa7c2;background:var(--ghost-paper)}tr[data-node-class="blocked-source"]{background:var(--ghost-paper)}.table-wrap{overflow:auto}.table-wrap[hidden],.graph-view[hidden]{display:none}table{width:100%;border-collapse:collapse;min-width:1100px}th,td{text-align:left;vertical-align:top;padding:11px 13px;border-bottom:1px solid #e2e5df}th{font-size:11px;text-transform:uppercase;letter-spacing:.08em;background:#f6f3eb;position:sticky;top:0}td small{display:block;color:var(--muted);margin-top:3px}.table-source{border:0;background:none;padding:0;color:var(--blue);font-weight:700;text-align:left}.foot{color:var(--muted);font-size:12px;margin-top:15px}.source-node:focus rect,.source-node:hover rect{stroke:var(--green);stroke-width:2.5}.source-node{cursor:pointer}.source-node.blocked-node rect{stroke-dasharray:7 5}.edge{stroke:#9daca2;stroke-width:1;opacity:.18;fill:none}.edge.blocked-edge{stroke:var(--ghost);stroke-dasharray:6 5;opacity:.36}.edge.active{stroke:var(--green);stroke-width:2.4;opacity:.72}.node-muted{opacity:.28}@media(max-width:1000px){.shell{padding:18px}.workspace{grid-template-columns:1fr}.details{position:static}.controls input{min-width:220px}}
</style></head><body><main class="shell">
<div class="eyebrow">Maintainer architecture</div><h1>Where CityScroll’s data comes from</h1>
<p class="lede">Trace each collecting body through its concrete endpoint, the job and measured cadence that ingest it, and the product surfaces that consume it. Dashed ghost paths show access-gated sources in the position where they would connect if acquired.</p>
<div class="meta"><span class="pill">${graph.counts.bodies} collecting bodies</span><span class="pill">${graph.counts.source_contracts} source contracts</span><span class="pill">${graph.counts.blocked_sources} access-gated sources</span><span class="pill">${graph.counts.surfaces} surfaces</span><span class="pill">sources hash ${esc(graph.sources_hash.slice(0, 12))}</span></div>
<div class="legend" aria-label="Graph visual classes"><span><i></i> Available source path</span><span><i class="ghost-key"></i> Access-gated source path</span></div>
<div class="controls"><label class="sr-only" for="search">Filter sources</label><input id="search" type="search" placeholder="Filter by source, endpoint, institution, or access route…"><select id="status"><option value="">All statuses</option><option value="live">Live</option><option value="build-time">Build-time</option><option value="manual">Manual</option><option value="disabled">Disabled</option><option value="application-possible">Application possible</option><option value="blocked">Blocked</option><option value="declined">Declined</option></select><div class="toggle" aria-label="View"><button id="graphToggle" type="button" aria-pressed="true">Graph view</button><button id="tableToggle" type="button" aria-pressed="false">Table view</button></div></div>
<section class="graph-view" id="graphView"><div class="workspace"><div class="canvas"><div class="column-heads"><div><b>1 · Collecting bodies</b><span>Institutions that originate data</span></div><div><b>2 · Datasets / endpoints</b><span>Concrete source identity</span></div><div><b>3 · Our ingest</b><span>Job, cadence, transform</span></div><div><b>4 · Surfaces</b><span>Features that consume it</span></div></div><svg id="sourceGraph" role="img" aria-label="Data source topology graph"></svg></div><aside class="details" id="details" aria-live="polite"><div class="empty-detail"><div class="eyebrow">Source detail</div><h2>Select a dataset</h2><p>The selected path will highlight across all four layers.</p></div></aside></div></section>
<section class="table-wrap" id="tableView" hidden><table><thead><tr><th>Source</th><th>Collecting body</th><th>Status</th><th>Ingest cadence</th><th>Transform</th><th>Surfaces</th></tr></thead><tbody>${tableRows(graph)}</tbody></table></section>
<p class="foot">Generated from the source-contract ledger, lifecycle gap inventory, warehouse registry and receipts, and Worker cron implementation. Rebuild with <code>node tools/data_source_graph.mjs</code>; verify staleness with <code>--check</code>. The authenticated desk may embed this artifact without changing its access gate.</p>
</main><script>
const graph=${payload};
const svg=document.getElementById("sourceGraph"),details=document.getElementById("details"),search=document.getElementById("search"),statusFilter=document.getElementById("status");
const NS="http://www.w3.org/2000/svg";let selected=null;
const escapeHtml=(v)=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const short=(v,n)=>String(v).length>n?String(v).slice(0,n-1)+"…":String(v);
function el(name,attrs={},text=""){const node=document.createElementNS(NS,name);for(const [k,v] of Object.entries(attrs))node.setAttribute(k,v);if(text)node.textContent=text;return node}
function lineText(parent,x,y,primary,secondary,color="#18241d"){parent.append(el("text",{x,y,"font-size":"12","font-weight":"700",fill:color},short(primary,30)));if(secondary)parent.append(el("text",{x,y:y+18,"font-size":"9.5",fill:"#65756b"},short(secondary,35)))}
function visibleSources(){const q=search.value.trim().toLowerCase(),st=statusFilter.value;return graph.sources.filter(s=>(!st||s.status===st)&&(!q||([s.name,s.body,s.endpoint.identity,s.surfaces.join(" "),...(s.access_mechanisms||[]).map(m=>m.label+" "+m.requirement)].join(" ").toLowerCase().includes(q))));}
function render(){const sources=visibleSources(),row=78,top=34,height=Math.max(700,top*2+sources.length*row);svg.setAttribute("viewBox","0 0 960 "+height);svg.setAttribute("height",height);svg.replaceChildren();const ownerGroups=new Map();sources.forEach((s,i)=>{if(!ownerGroups.has(s.body))ownerGroups.set(s.body,[]);ownerGroups.get(s.body).push(i)});const surfaceNames=[...new Set(sources.flatMap(s=>s.surfaces))].sort(),surfaceY=new Map(surfaceNames.map((name,i)=>[name,top+(i+.5)*(Math.max(1,sources.length)*row/surfaceNames.length)]));
  const paths=el("g");sources.forEach((s,i)=>{const y=top+i*row+30,bodyRows=ownerGroups.get(s.body),by=top+((bodyRows[0]+bodyRows.at(-1))/2)*row+30,edgeClass="edge edge-"+s.id+(s.node_class==="blocked-source"?" blocked-edge":"");paths.append(el("path",{class:edgeClass,d:"M 190 "+by+" C 205 "+by+",205 "+y+",220 "+y}));paths.append(el("path",{class:edgeClass,d:"M 465 "+y+" C 483 "+y+",483 "+y+",500 "+y}));s.surfaces.forEach(name=>paths.append(el("path",{class:edgeClass,d:"M 730 "+y+" C 745 "+y+",745 "+surfaceY.get(name)+",760 "+surfaceY.get(name)})))});svg.append(paths);
  for(const [owner,rows] of ownerGroups){const y=top+((rows[0]+rows.at(-1))/2)*row+30,g=el("g");g.append(el("rect",{x:20,y:y-25,width:170,height:50,rx:9,fill:"#edf2eb",stroke:"#c8d2c9"}));lineText(g,32,y-3,owner,rows.length+" source"+(rows.length===1?"":"s"));svg.append(g)}
  sources.forEach((s,i)=>{const y=top+i*row+30,blocked=s.node_class==="blocked-source",g=el("g",{class:"source-node"+(blocked?" blocked-node":""),tabindex:"0",role:"button","aria-label":"Open "+s.name,"data-source":s.id});g.append(el("rect",{x:220,y:y-29,width:245,height:58,rx:9,fill:blocked?"#f7f1f8":"#fffdf8",stroke:s.id===selected?"#1f6a45":blocked?"#775b85":"#bdc8bf"}));g.append(el("circle",{cx:236,cy:y-8,r:4.5,fill:blocked?"#775b85":s.status==="disabled"?"#9f3a35":s.status==="live"?"#1f6a45":"#9d5b13"}));lineText(g,248,y-4,s.name,s.endpoint.identity,blocked?"#654b70":"#18241d");g.addEventListener("click",()=>selectSource(s.id));g.addEventListener("keydown",e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();selectSource(s.id)}});svg.append(g);const job=el("g",{class:blocked?"source-node blocked-node":""});job.append(el("rect",{x:500,y:y-29,width:230,height:58,rx:9,fill:blocked?"#f7f1f8":"#f8f0df",stroke:blocked?"#9d82aa":"#d6c59f"}));lineText(job,512,y-4,s.ingest.job,s.ingest.cadence,blocked?"#654b70":"#684419");svg.append(job)});
  surfaceNames.forEach(name=>{const y=surfaceY.get(name),g=el("g");g.append(el("rect",{x:760,y:y-21,width:175,height:42,rx:21,fill:"#e6eef1",stroke:"#b5c8d0"}));g.append(el("text",{x:775,y:y+5,"font-size":"12","font-weight":"700",fill:"#315f78"},name));svg.append(g)});if(selected)highlight(selected);filterTable()}
function selectSource(id){selected=id;const s=graph.sources.find(x=>x.id===id);if(!s)return;const endpoint=s.endpoint.url?'<a href="'+escapeHtml(s.endpoint.url)+'" target="_blank" rel="noopener noreferrer">'+escapeHtml(s.endpoint.identity)+'</a>':escapeHtml(s.endpoint.identity),wishlist=s.wishlist?'<h3>Wishlist</h3><p>'+escapeHtml(s.wishlist.label)+'</p>':'';if(s.node_class==="blocked-source"){const citations=new Map((s.policy_citations||[]).map(c=>[c.id,c])),routes=(s.access_mechanisms||[]).map(m=>{const refs=(m.citation_ids||[]).map(cid=>citations.get(cid)).filter(Boolean).map(c=>'<a href="'+escapeHtml(c.url)+'" target="_blank" rel="noopener noreferrer">'+escapeHtml(c.title)+'</a>').join(' · ');return '<li><strong>'+escapeHtml(m.label)+'</strong>'+(m.preferred?'<br><span class="route-preferred">Preferred route</span>':'')+'<br>'+escapeHtml(m.requirement)+(refs?'<br><small>'+refs+'</small>':'')+'</li>'}).join(''),policies=(s.policy_citations||[]).map(c=>'<li><a href="'+escapeHtml(c.url)+'" target="_blank" rel="noopener noreferrer">'+escapeHtml(c.title)+'</a><br>'+escapeHtml(c.section)+' · '+escapeHtml(c.date)+(c.date_basis?'<br><small>'+escapeHtml(c.date_basis.replaceAll('_',' '))+'</small>':'')+'</li>').join('');details.innerHTML='<div class="eyebrow">Blocked source · '+escapeHtml(s.endpoint.identity)+'</div><h2>'+escapeHtml(s.name)+'</h2><p><span class="status status-'+escapeHtml(s.status)+'">'+escapeHtml(s.status)+'</span> · access-gated</p><h3>What it offers</h3><p>'+escapeHtml(s.data_offered)+'</p><h3>Collecting body / platform</h3><p>'+escapeHtml(s.body)+'<br><span class="endpoint">'+endpoint+'</span></p><h3>Access mechanisms</h3><ol>'+routes+'</ol><h3>Policy citations</h3><ol>'+policies+'</ol><h3>Would light up</h3><p>'+s.surfaces.map(escapeHtml).join(' · ')+'</p>'+wishlist;render();return}const freshness=s.last_successful_pull?'<br><strong>Latest recorded pull:</strong> '+escapeHtml(s.last_successful_pull.at)+' <small>('+escapeHtml(s.last_successful_pull.path)+')</small>':s.latest_evidence?'<br><strong>Latest recorded evidence:</strong> '+escapeHtml(s.latest_evidence.at):'',gap=s.known_gap?'<h3>Known gap</h3><p>'+escapeHtml(s.known_gap)+'</p>':'';details.innerHTML='<div class="eyebrow">'+escapeHtml(s.endpoint.identity)+'</div><h2>'+escapeHtml(s.name)+'</h2><p><span class="status status-'+escapeHtml(s.status)+'">'+escapeHtml(s.status)+'</span> · '+escapeHtml(s.delivery_tier)+'</p><h3>Collecting body</h3><p>'+escapeHtml(s.body)+'</p><h3>Endpoint</h3><p class="endpoint">'+endpoint+'</p><h3>Our ingest</h3><p><strong>'+escapeHtml(s.ingest.job)+'</strong><br>'+escapeHtml(s.ingest.cadence)+'<br>'+escapeHtml(s.ingest.transform)+'</p><h3>Freshness</h3><p><strong>Publisher cadence:</strong> '+escapeHtml(s.publisher_cadence)+'<br>'+escapeHtml(s.approach)+freshness+'</p><h3>Coverage</h3><p>'+escapeHtml(s.coverage)+'</p>'+gap+wishlist+'<h3>Surfaces</h3><p>'+s.surfaces.map(escapeHtml).join(' · ')+'</p>';render()}
function highlight(id){svg.querySelectorAll(".edge").forEach(node=>node.classList.toggle("active",node.classList.contains("edge-"+CSS.escape(id))))}
function filterTable(){const q=search.value.trim().toLowerCase(),st=statusFilter.value;document.querySelectorAll("[data-source-row]").forEach(row=>row.hidden=Boolean((st&&row.dataset.status!==st)||(q&&!row.dataset.search.includes(q))))}
search.addEventListener("input",render);statusFilter.addEventListener("change",render);document.querySelectorAll(".table-source").forEach(button=>button.addEventListener("click",()=>{selectSource(button.dataset.source);setView("graph")}));
function setView(view){const isGraph=view==="graph";document.getElementById("graphView").hidden=!isGraph;document.getElementById("tableView").hidden=isGraph;document.getElementById("graphToggle").setAttribute("aria-pressed",String(isGraph));document.getElementById("tableToggle").setAttribute("aria-pressed",String(!isGraph))}document.getElementById("graphToggle").onclick=()=>setView("graph");document.getElementById("tableToggle").onclick=()=>setView("table");render();
</script></body></html>\n`;
}

export function generatedGraphFiles({ inputs = inputManifest() } = {}) {
  const registry = readJson("site/data/source_contracts.json");
  const receiptPaths = inputs.map((input) => input.path).filter((path) => path.includes("receipts/") || path.includes("verification_receipts/"));
  const graph = buildDataSourceGraph({
    registry,
    gapTaxonomy: readJson("site/data/gap_taxonomy.json"),
    warehouse: readJson("warehouse/datasets.v0.json"),
    wranglerText: readFileSync(join(ROOT, "worker/wrangler.toml"), "utf8"),
    workerText: readFileSync(join(ROOT, "worker/src/worker.mjs"), "utf8"),
    externalAwardText: readFileSync(join(ROOT, "worker/src/external_award.mjs"), "utf8"),
    receipts: receiptEvidence(registry.contracts, receiptPaths),
    inputs,
  });
  return {
    [JSON_OUTPUT]: JSON.stringify(graph, null, 2) + "\n",
    [HTML_OUTPUT]: renderGraphHtml(graph),
  };
}

function outputDirectory(path = DEFAULT_OUTPUT_DIR) {
  return isAbsolute(path) ? path : join(ROOT, path);
}

export function writeGeneratedGraphFiles({ outputDir = DEFAULT_OUTPUT_DIR, inputs } = {}) {
  const directory = outputDirectory(outputDir);
  const files = generatedGraphFiles({ inputs });
  mkdirSync(directory, { recursive: true });
  for (const [filename, contents] of Object.entries(files)) {
    writeFileSync(join(directory, filename), contents);
  }
  return files;
}

export function checkGraphBuild({ outputDir = DEFAULT_OUTPUT_DIR, inputs } = {}) {
  const directory = outputDirectory(outputDir);
  const files = generatedGraphFiles({ inputs });
  return Object.entries(files).filter(([filename, expected]) => {
    try { return readFileSync(join(directory, filename), "utf8") !== expected; } catch { return true; }
  }).map(([filename]) => filename);
}

function parseArgs(argv) {
  const args = { check: false, outputDir: DEFAULT_OUTPUT_DIR };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--check") args.check = true;
    else if (argv[index] === "--output-dir") {
      if (!argv[index + 1]) throw new Error("--output-dir requires a path");
      args.outputDir = argv[index + 1];
      index += 1;
    } else throw new Error(`unknown argument: ${argv[index]}`);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const files = generatedGraphFiles();
  const directory = outputDirectory(args.outputDir);
  if (args.check) {
    const mismatches = checkGraphBuild({ outputDir: args.outputDir });
    if (mismatches.length) {
      for (const filename of mismatches) console.error(`out of date: ${join(directory, filename)}`);
      process.exitCode = 1;
    } else console.log(`data-source graph current (${Object.keys(files).length} files in ${relative(ROOT, directory)})`);
    return;
  }
  writeGeneratedGraphFiles({ outputDir: args.outputDir });
  console.log(`generated ${Object.keys(files).length} data-source graph files in ${relative(ROOT, directory)}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
