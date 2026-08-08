/**
 * Ontology-delta view (Living Civic Graph · first praxis wave).
 *
 * Surfaces structural growth in the civic graph: new entity kinds, edge types,
 * object kinds, domains, agencies, constellation categories, and mandate
 * deliverable types present in the current materialization but absent from a
 * frozen prior inventory baseline.
 *
 * Scope (v1): inventory diff over daily-materialized read models (entity
 * intelligence, agency constellation, statutory mandates). Full type-version
 * history and incremental MV maintenance are a later seam — theory pointer for
 * implementers: Gupta-Mumick materialized-view maintenance (incremental
 * maintenance of derived inventory); not shown in product copy.
 *
 * Copy doctrine: show standable deltas plainly. Uncertain or low-confidence
 * items stay off the page (do not wrap in disclaimers).
 */

import {
  gateNodePageRender,
  renderCivicDocumentAssets,
  renderCivicDocumentMast,
  renderNodeBack,
  renderNodeFooter,
  renderNodeProvenance,
} from "./civic_document_chrome.mjs";

export const ONTOLOGY_DELTA_SCHEMA = "cityscroll.ontology_delta.v1";
export const ONTOLOGY_INVENTORY_SCHEMA = "cityscroll.ontology_inventory.v1";
export const ONTOLOGY_DELTA_METHOD = "ontology_inventory_diff_v1";
export const ONTOLOGY_DELTA_ITERATION = "v1";
export const ONTOLOGY_DELTA_SHARE_PATH = "/graph/ontology-delta/";

/** Reader-facing labels for inventory dimensions (standable only). */
export const DIMENSION_LABELS = Object.freeze({
  root_kinds: "Entity kinds",
  domains: "Graph domains",
  object_kinds: "Object kinds",
  edge_types: "Relationship types",
  agencies: "Agencies in the graph",
  constellation_categories: "Agency page categories",
  deliverable_types: "Mandate deliverable types",
});

/** Human labels for known edge types (fallback: prettified id). */
export const EDGE_TYPE_LABELS = Object.freeze({
  published_by_agency: "Published by agency",
  named_vendor: "Names a vendor",
  named_owner: "Names an owner or grantee",
  sits_on_parcel: "Sits on a parcel",
  parcel_links_project: "Parcel links a land project",
  applicant_agency: "Applicant is an agency",
  applicant_vendor: "Applicant is a vendor",
  hosts_meeting: "Hosts a meeting",
  issued_rule: "Issued a rule",
  votes_as_official: "Votes as an official",
  sited_on_parcel: "Sited on a tax lot",
  decides_land_project: "Decides a land project",
  shares_authority_key: "Shares a PIN or EPIN",
  references_contract: "References a contract",
  paid_to_vendor: "Paid to a vendor",
  payment_on_contract: "Payment on a contract",
  contract_published_by_agency: "Contract published by agency",
  corroborates_contract: "Corroborates a contract",
  named_franchisee: "Names a franchisee",
  reviews_franchise: "Reviews a franchise or concession",
});

export const OBJECT_KIND_LABELS = Object.freeze({
  award: "Award",
  contract: "Contract",
  payment: "Payment",
  solicitation: "Solicitation",
  intent_to_award: "Intent to award",
  project: "Land project",
  disposition: "Property disposition",
  hearing: "Hearing",
  public_hearing: "Public hearing",
  committee_meeting: "Committee meeting",
  rule: "Rule",
  vote: "Vote",
});

export const DOMAIN_LABELS = Object.freeze({
  money: "Money",
  land: "Land",
  property: "Property",
  rules: "Rules",
  meetings: "Meetings",
  people: "People",
  franchise: "Franchise",
});

export const ROOT_KIND_LABELS = Object.freeze({
  agency: "Agency",
  vendor: "Vendor",
  official: "Official",
});

export const DELIVERABLE_TYPE_LABELS = Object.freeze({
  rulemaking: "Rulemaking",
  report: "Report",
  program: "Program",
  "data publication": "Data publication",
  other: "Other duty",
  hearing: "Hearing",
});

export const CONSTELLATION_CATEGORY_LABELS = Object.freeze({
  contracts: "Contracts",
  meetings: "Meetings and hearings",
  rules: "Rules",
  obligations: "Mandates",
  staffing: "Staffing exams",
});

/** Product lead copy — framing only, no hedging. */
export const ONTOLOGY_DELTA_COPY = Object.freeze({
  kicker: "Living civic graph",
  title: "What's new in the graph",
  lead:
    "New kinds of things and connections that appear in the civic graph since the baseline inventory — agencies, relationship types, object kinds, and mandate categories.",
  empty:
    "No new entity kinds, relationship types, agencies, or categories appear since the baseline inventory.",
  watch_hint:
    "Follow an agency from its constellation page to get email when that agency's linked records change.",
});

const clean = (value, max = 500) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

const esc = (value) => String(value ?? "").replace(/[<>&"']/g, (char) => ({
  "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
}[char]));

function prettifyId(id) {
  return clean(id, 120)
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function labelFor(dimension, id, extra = {}) {
  const key = clean(id, 120);
  if (!key) return "";
  if (extra.display_name) return clean(extra.display_name, 200);
  const maps = {
    edge_types: EDGE_TYPE_LABELS,
    object_kinds: OBJECT_KIND_LABELS,
    domains: DOMAIN_LABELS,
    root_kinds: ROOT_KIND_LABELS,
    deliverable_types: DELIVERABLE_TYPE_LABELS,
    constellation_categories: CONSTELLATION_CATEGORY_LABELS,
  };
  const map = maps[dimension];
  if (map && map[key]) return map[key];
  return prettifyId(key);
}

/**
 * Extract a typed inventory from current materializations.
 * Only dimensions that are actually present in the read models are filled.
 *
 * @param {object} sources
 * @param {object} [sources.entityIntelligence]
 * @param {object} [sources.constellation]
 * @param {object} [sources.obligations]
 * @param {string} [sources.generatedAt]
 */
export function extractGraphInventory(sources = {}) {
  const ei = sources.entityIntelligence || null;
  const constellation = sources.constellation || null;
  const obligations = sources.obligations || null;

  const root_kinds = new Set();
  const domains = new Set();
  const object_kinds = new Set();
  const edge_types = new Set();
  const agencies = new Map();
  let vendor_count = 0;

  for (const [ref, view] of Object.entries(ei?.by_ref || {})) {
    if (!view || typeof view !== "object") continue;
    const root = view.root || {};
    const kind = clean(root.kind, 40).toLowerCase();
    if (kind) root_kinds.add(kind);
    if (kind === "agency") {
      const id = clean(root.canonical_id || String(root.id || "").replace(/^id:/, ""), 120);
      if (id) {
        agencies.set(id, {
          id,
          display_name: clean(root.display_name || root.canonical_name || id, 200),
          subject_ref: clean(root.ref || ref, 200),
        });
      }
    }
    if (kind === "vendor") vendor_count += 1;

    for (const link of view.links || []) {
      const t = clean(link?.type, 80);
      if (t) edge_types.add(t);
    }
    for (const [dom, block] of Object.entries(view.domains || {})) {
      const d = clean(dom, 40).toLowerCase();
      if (d) domains.add(d);
      for (const obj of block?.objects || []) {
        const ok = clean(obj?.object_kind, 80);
        if (ok) object_kinds.add(ok);
        for (const lt of obj?.link_types || []) {
          const t = clean(lt, 80);
          if (t) edge_types.add(t);
        }
        if (obj?.link_type) {
          const t = clean(obj.link_type, 80);
          if (t) edge_types.add(t);
        }
      }
    }
  }

  // Top-level domain list from materialization envelope.
  for (const d of ei?.domains || []) {
    const dom = clean(d, 40).toLowerCase();
    if (dom) domains.add(dom);
  }

  const constellation_categories = new Set();
  if (constellation?.by_id) {
    for (const [id, row] of Object.entries(constellation.by_id)) {
      const cid = clean(id, 120);
      if (cid && !agencies.has(cid)) {
        agencies.set(cid, {
          id: cid,
          display_name: clean(row?.display_name || cid, 200),
          subject_ref: clean(row?.subject_ref || `agency:id:${cid}`, 200),
        });
      }
      for (const [cat, block] of Object.entries(row?.categories || {})) {
        const status = clean(block?.status, 40);
        // Only count categories that are actually populated for someone.
        if (status === "matched" || (Number(block?.count) || 0) > 0) {
          constellation_categories.add(clean(cat, 80));
        }
      }
    }
    // Also include category ids declared on any row (structure present).
    for (const row of Object.values(constellation.by_id)) {
      for (const cat of Object.keys(row?.categories || {})) {
        constellation_categories.add(clean(cat, 80));
      }
    }
  }

  const deliverable_types = new Set();
  if (obligations?.by_agency) {
    for (const [id, row] of Object.entries(obligations.by_agency)) {
      const cid = clean(id, 120);
      if (cid && !agencies.has(cid)) {
        agencies.set(cid, {
          id: cid,
          display_name: clean(row?.agency_name || cid, 200),
          subject_ref: `agency:id:${cid}`,
        });
      }
      for (const item of row?.obligations || []) {
        const dt = clean(item?.deliverable_type, 80);
        if (dt) deliverable_types.add(dt);
      }
    }
  }

  const agencyList = [...agencies.values()].sort((a, b) => a.id.localeCompare(b.id));

  return {
    schema: ONTOLOGY_INVENTORY_SCHEMA,
    role: "current",
    method: ONTOLOGY_DELTA_METHOD,
    generated_at: clean(sources.generatedAt || ei?.generated_at || constellation?.generated_at || new Date().toISOString(), 80),
    source: {
      entity_intelligence_generated_at: ei?.generated_at || null,
      entity_intelligence_version: ei?.version || null,
      entity_count: ei?.entity_count ?? Object.keys(ei?.by_ref || {}).length,
      constellation_generated_at: constellation?.generated_at || null,
      constellation_agency_count: constellation?.agency_count ?? Object.keys(constellation?.by_id || {}).length,
      obligations_generated_at: obligations?.generated_at || null,
      obligations_agency_count: obligations?.summary?.agency_count
        ?? Object.keys(obligations?.by_agency || {}).length,
    },
    root_kinds: [...root_kinds].sort(),
    domains: [...domains].sort(),
    object_kinds: [...object_kinds].sort(),
    edge_types: [...edge_types].sort(),
    agency_ids: agencyList.map((a) => a.id),
    agencies: agencyList,
    vendor_count,
    constellation_categories: [...constellation_categories].filter(Boolean).sort(),
    deliverable_types: [...deliverable_types].filter(Boolean).sort(),
  };
}

/**
 * Normalize a baseline inventory payload (committed or fixture).
 */
export function normalizeInventory(raw = {}) {
  const agencyIds = Array.isArray(raw.agency_ids)
    ? raw.agency_ids.map((id) => clean(id, 120)).filter(Boolean)
    : (raw.agencies || []).map((a) => clean(a?.id || a, 120)).filter(Boolean);
  const agencies = Array.isArray(raw.agencies)
    ? raw.agencies.map((a) => ({
      id: clean(a?.id, 120),
      display_name: clean(a?.display_name || a?.id, 200),
      subject_ref: clean(a?.subject_ref || (a?.id ? `agency:id:${a.id}` : ""), 200),
    })).filter((a) => a.id)
    : agencyIds.map((id) => ({ id, display_name: prettifyId(id), subject_ref: `agency:id:${id}` }));

  return {
    schema: ONTOLOGY_INVENTORY_SCHEMA,
    role: clean(raw.role, 40) || "baseline",
    label: clean(raw.label, 120) || null,
    as_of: clean(raw.as_of, 80) || null,
    source: raw.source && typeof raw.source === "object" ? raw.source : {},
    root_kinds: [...new Set((raw.root_kinds || []).map((x) => clean(x, 40)).filter(Boolean))].sort(),
    domains: [...new Set((raw.domains || []).map((x) => clean(x, 40)).filter(Boolean))].sort(),
    object_kinds: [...new Set((raw.object_kinds || []).map((x) => clean(x, 80)).filter(Boolean))].sort(),
    edge_types: [...new Set((raw.edge_types || []).map((x) => clean(x, 80)).filter(Boolean))].sort(),
    agency_ids: [...new Set(agencyIds)].sort(),
    agencies: agencies.sort((a, b) => a.id.localeCompare(b.id)),
    vendor_count: Number(raw.vendor_count) || 0,
    constellation_categories: [...new Set((raw.constellation_categories || []).map((x) => clean(x, 80)).filter(Boolean))].sort(),
    deliverable_types: [...new Set((raw.deliverable_types || []).map((x) => clean(x, 80)).filter(Boolean))].sort(),
  };
}

function setDiff(priorList, currentList) {
  const prior = new Set((priorList || []).map((x) => clean(x, 120)).filter(Boolean));
  return (currentList || [])
    .map((x) => clean(x, 120))
    .filter((x) => x && !prior.has(x));
}

/**
 * Diff current inventory against a prior baseline.
 * v1 reports additions only (structural growth).
 */
export function diffInventories(priorRaw, currentRaw) {
  const prior = normalizeInventory(priorRaw);
  const current = normalizeInventory({ ...currentRaw, role: "current" });

  const addedAgencyIds = setDiff(prior.agency_ids, current.agency_ids);
  const agencyById = new Map((current.agencies || []).map((a) => [a.id, a]));

  const added = {
    root_kinds: setDiff(prior.root_kinds, current.root_kinds).map((id) => ({
      id,
      label: labelFor("root_kinds", id),
    })),
    domains: setDiff(prior.domains, current.domains).map((id) => ({
      id,
      label: labelFor("domains", id),
    })),
    object_kinds: setDiff(prior.object_kinds, current.object_kinds).map((id) => ({
      id,
      label: labelFor("object_kinds", id),
    })),
    edge_types: setDiff(prior.edge_types, current.edge_types).map((id) => ({
      id,
      label: labelFor("edge_types", id),
    })),
    agencies: addedAgencyIds.map((id) => {
      const row = agencyById.get(id) || { id, display_name: prettifyId(id), subject_ref: `agency:id:${id}` };
      return {
        id,
        label: row.display_name || labelFor("agencies", id, row),
        display_name: row.display_name,
        subject_ref: row.subject_ref,
        href: `/agencies/${encodeURIComponent(id)}/`,
      };
    }),
    constellation_categories: setDiff(prior.constellation_categories, current.constellation_categories).map((id) => ({
      id,
      label: labelFor("constellation_categories", id),
    })),
    deliverable_types: setDiff(prior.deliverable_types, current.deliverable_types).map((id) => ({
      id,
      label: labelFor("deliverable_types", id),
    })),
  };

  const counts = Object.fromEntries(
    Object.entries(added).map(([key, items]) => [key, items.length]),
  );
  const total_added = Object.values(counts).reduce((sum, n) => sum + n, 0);

  return {
    schema: ONTOLOGY_DELTA_SCHEMA,
    method: ONTOLOGY_DELTA_METHOD,
    iteration: ONTOLOGY_DELTA_ITERATION,
    share_path: ONTOLOGY_DELTA_SHARE_PATH,
    copy: ONTOLOGY_DELTA_COPY,
    baseline: {
      role: prior.role,
      label: prior.label,
      as_of: prior.as_of,
      source: prior.source,
      counts: {
        root_kinds: prior.root_kinds.length,
        domains: prior.domains.length,
        object_kinds: prior.object_kinds.length,
        edge_types: prior.edge_types.length,
        agencies: prior.agency_ids.length,
        constellation_categories: prior.constellation_categories.length,
        deliverable_types: prior.deliverable_types.length,
      },
    },
    current: {
      generated_at: current.generated_at || currentRaw.generated_at || null,
      source: current.source || currentRaw.source || {},
      counts: {
        root_kinds: current.root_kinds.length,
        domains: current.domains.length,
        object_kinds: current.object_kinds.length,
        edge_types: current.edge_types.length,
        agencies: current.agency_ids.length,
        constellation_categories: current.constellation_categories.length,
        deliverable_types: current.deliverable_types.length,
        vendor_count: current.vendor_count,
      },
    },
    added,
    counts,
    total_added,
    has_deltas: total_added > 0,
    // Full current inventory for operators / next baseline promote (not rendered as raw keys).
    inventory: current,
  };
}

/**
 * Build the public lookup payload from sources + baseline.
 */
export function buildOntologyDeltaLookup({
  baseline,
  entityIntelligence,
  constellation,
  obligations,
  generatedAt,
} = {}) {
  const inventory = extractGraphInventory({
    entityIntelligence,
    constellation,
    obligations,
    generatedAt,
  });
  const delta = diffInventories(baseline || {}, inventory);
  return {
    ...delta,
    generated_at: inventory.generated_at,
    provenance: {
      method: ONTOLOGY_DELTA_METHOD,
      iteration: ONTOLOGY_DELTA_ITERATION,
      baseline_label: delta.baseline.label,
      baseline_as_of: delta.baseline.as_of,
      dimensions: Object.keys(DIMENSION_LABELS),
    },
  };
}

function renderDimensionSection(dimension, items, { limit = 80 } = {}) {
  if (!items?.length) return "";
  const title = DIMENSION_LABELS[dimension] || prettifyId(dimension);
  const shown = items.slice(0, limit);
  const list = shown.map((item) => {
    const label = item.label || item.display_name || item.id;
    const href = item.href
      || (dimension === "agencies" && item.id ? `/agencies/${encodeURIComponent(item.id)}/` : null);
    const main = href
      ? `<a href="${esc(href)}">${esc(label)}</a>`
      : esc(label);
    // Machine id only on data-attrs — never as reader-facing cruft for agencies with names.
    const meta = dimension === "agencies"
      ? ""
      : (item.id && item.id !== label ? ` <span class="muted node-muted">(${esc(item.id)})</span>` : "");
    return `<li class="node-record ontology-delta-item" data-dimension="${esc(dimension)}" data-delta-id="${esc(item.id || label)}">
      <div class="node-record-main">${main}${meta}</div>
    </li>`;
  }).join("");
  const more = items.length > shown.length
    ? `<p class="node-muted muted">${esc(String(items.length - shown.length))} more in this materialization.</p>`
    : "";
  return `<section class="node-section node-card civic-object-section ontology-delta-dimension" data-dimension="${esc(dimension)}" aria-labelledby="od-${esc(dimension)}">
    <h2 id="od-${esc(dimension)}">${esc(title)} <span class="muted node-muted">(${esc(String(items.length))} new)</span></h2>
    <ul class="node-record-list ontology-delta-list">${list}</ul>
    ${more}
  </section>`;
}

/**
 * Render the shareable ontology-delta document (static HTML).
 */
export function renderOntologyDeltaDocument(lookup, { assetPrefix = "/" } = {}) {
  const copy = lookup?.copy || ONTOLOGY_DELTA_COPY;
  const added = lookup?.added || {};
  const total = Number(lookup?.total_added) || 0;
  const baselineAsOf = lookup?.baseline?.as_of
    ? String(lookup.baseline.as_of).slice(0, 10)
    : null;
  const currentAt = lookup?.current?.generated_at || lookup?.generated_at || null;
  const currentDay = currentAt ? String(currentAt).slice(0, 10) : null;

  const summaryBits = [
    total ? `${total} new type${total === 1 ? "" : "s"} or agencies` : null,
    baselineAsOf ? `baseline ${baselineAsOf}` : null,
    currentDay ? `inventory ${currentDay}` : null,
  ].filter(Boolean);

  const sections = [
    "edge_types",
    "object_kinds",
    "domains",
    "root_kinds",
    "constellation_categories",
    "deliverable_types",
    "agencies",
  ].map((dim) => renderDimensionSection(dim, added[dim] || [])).join("");

  const body = total > 0
    ? sections
    : `<section class="node-section node-card civic-object-section" id="ontology-delta-empty">
        <h2>Inventory unchanged</h2>
        <p class="node-muted">${esc(copy.empty || ONTOLOGY_DELTA_COPY.empty)}</p>
      </section>`;

  const watch = `<section class="node-section node-card civic-object-section" id="ontology-delta-watch">
    <h2>Watch linked records</h2>
    <p class="node-muted">${esc(copy.watch_hint || ONTOLOGY_DELTA_COPY.watch_hint)}</p>
    <p class="node-inline-actions civic-object-inline-actions">
      <a class="node-action civic-object-action" href="/agencies/">Browse agencies</a>
      <a class="node-action civic-object-action" href="/following/">Following</a>
    </p>
  </section>`;

  const counts = lookup?.counts || {};
  const chipLine = [
    counts.edge_types ? `${counts.edge_types} relationship types` : null,
    counts.object_kinds ? `${counts.object_kinds} object kinds` : null,
    counts.agencies ? `${counts.agencies} agencies` : null,
    counts.constellation_categories ? `${counts.constellation_categories} categories` : null,
    counts.deliverable_types ? `${counts.deliverable_types} deliverable types` : null,
    counts.domains ? `${counts.domains} domains` : null,
  ].filter(Boolean).join(" · ");

  const provenance = renderNodeProvenance({
    note: "Compares the live graph inventory to a frozen prior inventory of the same materializations.",
    sourceItems: [
      baselineAsOf ? `Baseline inventory as of ${baselineAsOf}` : "Baseline inventory",
      currentDay ? `Current graph inventory as of ${currentDay}` : "Current graph inventory",
      "Entity intelligence, agency constellation, and statutory mandates",
    ].filter(Boolean),
  });

  return gateNodePageRender(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(copy.title)} · CityScroll</title>
<meta name="description" content="${esc(copy.lead)}">
<link rel="canonical" href="${esc(ONTOLOGY_DELTA_SHARE_PATH)}">
${renderCivicDocumentAssets(assetPrefix)}
<style>
.ontology-delta-summary-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin: 0.75rem 0 0;
  padding: 0;
  list-style: none;
}
.ontology-delta-summary-chips li {
  display: inline-block;
  padding: 0.15rem 0.55rem;
  border-radius: 999px;
  border: 1px solid var(--color-border, #c8c8c8);
  font: 600 0.8rem/1.35 var(--font-body, system-ui, sans-serif);
  background: color-mix(in srgb, var(--color-action, #0b57d0) 8%, transparent);
}
.ontology-delta-list .node-record-main { line-height: 1.45; }
#ontology-delta[data-has-deltas="0"] .ontology-delta-summary-chips { display: none; }
</style>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
${renderCivicDocumentMast({ current: "browse" })}
<main id="main" class="node-document civic-object-document" data-node-document="1" data-ontology-delta="v1">
${renderNodeBack({ href: "/agencies/", label: "Back to agencies" })}
<article id="ontology-delta" class="ontology-delta" data-has-deltas="${total > 0 ? "1" : "0"}" data-total-added="${esc(String(total))}" data-method="${esc(lookup?.method || ONTOLOGY_DELTA_METHOD)}">
<header class="node-hero civic-object-hero">
  <p class="node-kicker civic-object-kicker">${esc(copy.kicker || ONTOLOGY_DELTA_COPY.kicker)}</p>
  <h1>${esc(copy.title || ONTOLOGY_DELTA_COPY.title)}</h1>
  <p class="node-lede">${esc(copy.lead || ONTOLOGY_DELTA_COPY.lead)}</p>
  ${summaryBits.length ? `<p class="node-muted muted">${esc(summaryBits.join(" · "))}</p>` : ""}
  ${chipLine ? `<ul class="ontology-delta-summary-chips" aria-label="New inventory counts">${chipLine.split(" · ").map((c) => `<li>${esc(c)}</li>`).join("")}</ul>` : ""}
</header>
${body}
${watch}
${provenance}
</article>
</main>
${renderNodeFooter({ aboutHref: "/about.html" })}
</body>
</html>`);
}

export function ontologyDeltaSharePath() {
  return ONTOLOGY_DELTA_SHARE_PATH;
}
